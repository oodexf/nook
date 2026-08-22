use std::sync::{Arc, Mutex};

use axum::{
    Json,
    extract::{Extension, Path, State, rejection::JsonRejection},
    http::{HeaderValue, StatusCode, header},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
};
use chat_core::{
    conversation::{Message, MessageRole, MessageStatus},
    generation::{Generation, GenerationResult, GenerationStatus},
    provider::{
        ChatProvider, ChatProviderError, ChatRequest, ChatStreamEvent, ContextLimits, TokenUsage,
        select_bounded_context,
    },
    repository::{
        ConversationRepository, GenerationFinalization, GenerationRepository, GenerationSetup,
        NewConversation, NewMessageGeneration, RepositoryError, RepositoryErrorKind,
        RetryGeneration,
    },
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};
use ulid::Ulid;

use crate::{
    AppState,
    generation_registry::RegisterError,
    request_context::{RequestId, public_error_response},
};

const MESSAGE_BODY_LIMIT: usize = 128 * 1024;
const MAX_CLIENT_MESSAGE_ID_CHARS: usize = 200;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateMessageRequest {
    client_message_id: String,
    content: String,
    model: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum PublicStreamEvent {
    Meta {
        conversation_id: String,
        user_message_id: Option<String>,
        assistant_message_id: String,
        generation_id: String,
        model: String,
    },
    Delta {
        text: String,
    },
    ReasoningDelta {
        text: String,
    },
    Done {
        finish_reason: String,
        usage: Option<PublicUsage>,
    },
    Stopped {
        reason: &'static str,
    },
    Error {
        code: &'static str,
        message: &'static str,
        request_id: String,
    },
}

#[derive(Serialize)]
struct PublicUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

pub async fn new_message(
    State(state): State<AppState>,
    Extension(request_id): Extension<RequestId>,
    request: Result<Json<CreateMessageRequest>, JsonRejection>,
) -> Response {
    let request = match decode_request(request, &request_id) {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let Some(model) = request.model.clone() else {
        return StreamApiError::InvalidRequest.into_response(&request_id);
    };
    if let Err(error) = state.models.validate_available(&model).await {
        return map_catalog_error(error).into_response(&request_id);
    }
    let conversation_id = Ulid::new().to_string();
    let setup = build_message_setup(
        &request,
        conversation_id.clone(),
        model,
        true,
        unix_milliseconds(),
    );
    create_and_stream(state, request_id, setup).await
}

pub async fn existing_message(
    State(state): State<AppState>,
    Extension(request_id): Extension<RequestId>,
    Path(conversation_id): Path<String>,
    request: Result<Json<CreateMessageRequest>, JsonRejection>,
) -> Response {
    if !valid_id(&conversation_id) {
        return StreamApiError::InvalidRequest.into_response(&request_id);
    }
    let request = match decode_request(request, &request_id) {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let replay_detail = match state
        .storage
        .find_by_client_message_id(request.client_message_id.clone())
        .await
    {
        Ok(Some(detail)) if detail.conversation.id == conversation_id => Some(detail),
        Ok(_) => None,
        Err(error) => return StreamApiError::from(error).into_response(&request_id),
    };
    let detail = if let Some(detail) = replay_detail.as_ref() {
        detail.clone()
    } else {
        match state.storage.get(conversation_id.clone()).await {
            Ok(detail) => detail,
            Err(error) => return StreamApiError::from(error).into_response(&request_id),
        }
    };
    // A duplicate idempotency key must resolve to its original logical result
    // even if the conversation's current model changed after that request.
    // New requests still cannot use this field as an implicit model switch.
    if replay_detail.is_none() {
        if request
            .model
            .as_ref()
            .is_some_and(|model| model != &detail.conversation.model)
        {
            return StreamApiError::ModelMismatch.into_response(&request_id);
        }
        if let Err(error) = state
            .models
            .validate_available(&detail.conversation.model)
            .await
        {
            return map_catalog_error(error).into_response(&request_id);
        }
    }
    let created_at = detail
        .messages
        .last()
        .map_or_else(unix_milliseconds, |message| {
            unix_milliseconds().max(message.created_at.saturating_add(1))
        });
    let setup = build_message_setup(
        &request,
        conversation_id,
        detail.conversation.model,
        false,
        created_at,
    );
    create_and_stream(state, request_id, setup).await
}

pub async fn retry(
    State(state): State<AppState>,
    Extension(request_id): Extension<RequestId>,
    Path(assistant_message_id): Path<String>,
) -> Response {
    if !valid_id(&assistant_message_id) {
        return StreamApiError::InvalidRequest.into_response(&request_id);
    }
    let existing = match state
        .storage
        .find_assistant_message(assistant_message_id.clone())
        .await
    {
        Ok(value) => value,
        Err(error) => return StreamApiError::from(error).into_response(&request_id),
    };
    if let Err(error) = state
        .models
        .validate_available(&existing.conversation.model)
        .await
    {
        return map_catalog_error(error).into_response(&request_id);
    }
    let now = existing
        .messages
        .last()
        .map_or_else(unix_milliseconds, |message| {
            unix_milliseconds().max(message.created_at.saturating_add(1))
        });
    let assistant = Message {
        id: Ulid::new().to_string(),
        conversation_id: existing.conversation.id.clone(),
        client_message_id: None,
        role: MessageRole::Assistant,
        content: String::new(),
        reasoning: None,
        status: MessageStatus::Streaming,
        model: Some(existing.conversation.model.clone()),
        error_code: None,
        created_at: now,
        finished_at: None,
    };
    let generation = generation_for(&assistant, now);
    let result = match state
        .storage
        .create_retry_generation(RetryGeneration {
            conversation_id: existing.conversation.id,
            source_assistant_message_id: assistant_message_id,
            assistant_message: assistant,
            generation,
        })
        .await
    {
        Ok(result) => result,
        Err(error) => return StreamApiError::from(error).into_response(&request_id),
    };
    stream_existing_generation(state, request_id, result).await
}

pub async fn cancel(
    State(state): State<AppState>,
    Extension(request_id): Extension<RequestId>,
    Path(generation_id): Path<String>,
) -> Response {
    if !valid_id(&generation_id) {
        return StreamApiError::InvalidRequest.into_response(&request_id);
    }
    if state.generations.cancel(&generation_id).await {
        return StatusCode::NO_CONTENT.into_response();
    }
    match state.storage.get_generation(generation_id).await {
        Ok(result) if result.generation.status.is_terminal() => {
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(error) if error.kind() == RepositoryErrorKind::NotFound => {
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error) => StreamApiError::from(error).into_response(&request_id),
    }
}

fn decode_request(
    request: Result<Json<CreateMessageRequest>, JsonRejection>,
    request_id: &RequestId,
) -> Result<CreateMessageRequest, Box<Response>> {
    let request = match request {
        Ok(Json(request)) => request,
        Err(error) if error.status() == StatusCode::PAYLOAD_TOO_LARGE => {
            return Err(Box::new(
                StreamApiError::PayloadTooLarge.into_response(request_id),
            ));
        }
        Err(_) => {
            return Err(Box::new(
                StreamApiError::InvalidRequest.into_response(request_id),
            ));
        }
    };
    if request.content.is_empty() || !valid_client_message_id(&request.client_message_id) {
        return Err(Box::new(
            StreamApiError::InvalidRequest.into_response(request_id),
        ));
    }
    Ok(request)
}

fn build_message_setup(
    request: &CreateMessageRequest,
    conversation_id: String,
    model: String,
    create_conversation: bool,
    now: i64,
) -> NewMessageGeneration {
    let assistant_created_at = now.saturating_add(1);
    let user = Message {
        id: Ulid::new().to_string(),
        conversation_id: conversation_id.clone(),
        client_message_id: Some(request.client_message_id.clone()),
        role: MessageRole::User,
        content: request.content.clone(),
        reasoning: None,
        status: MessageStatus::Completed,
        model: None,
        error_code: None,
        created_at: now,
        finished_at: Some(now),
    };
    let assistant = Message {
        id: Ulid::new().to_string(),
        conversation_id: conversation_id.clone(),
        client_message_id: None,
        role: MessageRole::Assistant,
        content: String::new(),
        reasoning: None,
        status: MessageStatus::Streaming,
        model: Some(model.clone()),
        error_code: None,
        created_at: assistant_created_at,
        finished_at: None,
    };
    let generation = generation_for(&assistant, assistant_created_at);
    NewMessageGeneration {
        conversation: create_conversation.then(|| NewConversation {
            id: conversation_id.clone(),
            title: default_title(&request.content),
            model,
            created_at: now,
        }),
        conversation_id,
        user_message: user,
        assistant_message: assistant,
        generation,
    }
}

fn generation_for(assistant: &Message, now: i64) -> Generation {
    Generation {
        id: Ulid::new().to_string(),
        conversation_id: assistant.conversation_id.clone(),
        assistant_message_id: assistant.id.clone(),
        provider: "openai-compatible".to_owned(),
        model: assistant.model.clone().unwrap_or_default(),
        status: GenerationStatus::Streaming,
        input_tokens: None,
        output_tokens: None,
        started_at: now,
        finished_at: None,
    }
}

async fn create_and_stream(
    state: AppState,
    request_id: RequestId,
    setup: NewMessageGeneration,
) -> Response {
    if setup.user_message.content.chars().count() > state.config.max_message_chars {
        return StreamApiError::MessageTooLarge.into_response(&request_id);
    }
    let result = match state.storage.create_message_generation(setup).await {
        Ok(GenerationSetup::Created(result)) => result,
        Ok(GenerationSetup::Existing(result)) => {
            if result.generation.status.is_terminal() {
                return replay_terminal(&state, &request_id, result).await;
            }
            match wait_for_terminal_result(&state, &result.generation.id).await {
                Ok(terminal) => return replay_terminal(&state, &request_id, terminal).await,
                Err(error) => return error.into_response(&request_id),
            }
        }
        Err(error) => return StreamApiError::from(error).into_response(&request_id),
    };
    stream_existing_generation(state, request_id, result).await
}

async fn wait_for_terminal_result(
    state: &AppState,
    generation_id: &str,
) -> Result<GenerationResult, StreamApiError> {
    let deadline = tokio::time::Instant::now() + state.config.ai_request_timeout;
    loop {
        let result = state
            .storage
            .get_generation(generation_id.to_owned())
            .await
            .map_err(StreamApiError::from)?;
        if result.generation.status.is_terminal() {
            return Ok(result);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(StreamApiError::GenerationInProgress);
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

#[allow(
    clippy::too_many_lines,
    reason = "stream lifecycle is intentionally auditable in one owner"
)]
async fn stream_existing_generation(
    state: AppState,
    request_id: RequestId,
    result: GenerationResult,
) -> Response {
    let registration = match state
        .generations
        .register(
            result.generation.id.clone(),
            result.generation.conversation_id.clone(),
        )
        .await
    {
        Ok(registration) => registration,
        Err(RegisterError::Capacity) => return StreamApiError::Capacity.into_response(&request_id),
        Err(RegisterError::ConversationActive) => {
            return StreamApiError::GenerationInProgress.into_response(&request_id);
        }
    };
    let detail = match state
        .storage
        .get(result.generation.conversation_id.clone())
        .await
    {
        Ok(detail) => detail,
        Err(error) => {
            registration.finish().await;
            return StreamApiError::from(error).into_response(&request_id);
        }
    };
    let context_messages = messages_before_assistant(
        &detail.messages,
        &result.generation.assistant_message_id,
        result.user_message_id.is_none(),
    );
    let Ok(context) = select_bounded_context(
        &context_messages,
        ContextLimits {
            max_messages: state.config.max_context_messages,
            max_chars: state.config.max_context_chars,
        },
    ) else {
        registration.finish().await;
        return StreamApiError::MessageTooLarge.into_response(&request_id);
    };
    let provider_stream = match state
        .provider
        .chat(ChatRequest {
            model: result.generation.model.clone(),
            messages: context,
        })
        .await
    {
        Ok(stream) => stream,
        Err(error) => {
            let _ = finalize(
                &state,
                &result.generation,
                String::new(),
                String::new(),
                Terminal::Error(error),
                TokenUsage::default(),
            )
            .await;
            registration.finish().await;
            return StreamApiError::Provider(error).into_response(&request_id);
        }
    };

    let meta = PublicStreamEvent::Meta {
        conversation_id: result.generation.conversation_id.clone(),
        user_message_id: result.user_message_id.clone(),
        assistant_message_id: result.generation.assistant_message_id.clone(),
        generation_id: result.generation.id.clone(),
        model: result.generation.model.clone(),
    };
    let request_id_text = request_id.as_str().to_owned();
    let generation = result.generation;
    let stream_state = state.clone();
    let accumulated = Arc::new(Mutex::new(String::new()));
    let accumulated_reasoning = Arc::new(Mutex::new(String::new()));
    let drop_finalizer = Arc::new(Mutex::new(Some(DropFinalizer {
        state: state.clone(),
        generation: generation.clone(),
        accumulated: Arc::clone(&accumulated),
        accumulated_reasoning: Arc::clone(&accumulated_reasoning),
        armed: true,
    })));
    let stream = async_stream::stream! {
        yield Ok(encode_event(&meta));
        let mut upstream = provider_stream;
        let terminal;
        let mut usage = TokenUsage::default();
        loop {
            tokio::select! {
                () = registration.token.cancelled() => {
                    terminal = Terminal::Stopped;
                    break;
                }
                next = upstream.next() => match next {
                    Some(Ok(ChatStreamEvent::Delta(text))) => {
                        accumulated.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push_str(&text);
                        yield Ok(encode_event(&PublicStreamEvent::Delta { text }));
                    }
                    Some(Ok(ChatStreamEvent::ReasoningDelta(text))) => {
                        accumulated_reasoning.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push_str(&text);
                        yield Ok(encode_event(&PublicStreamEvent::ReasoningDelta { text }));
                    }
                    Some(Ok(ChatStreamEvent::Done { finish_reason, usage: final_usage })) => {
                        usage = final_usage;
                        terminal = Terminal::Done(finish_reason);
                        break;
                    }
                    Some(Err(ChatProviderError::Cancelled)) => {
                        terminal = Terminal::Stopped;
                        break;
                    }
                    Some(Err(error)) => {
                        terminal = Terminal::Error(error);
                        break;
                    }
                    None => {
                        terminal = Terminal::Error(ChatProviderError::StreamInterrupted);
                        break;
                    }
                }
            }
        }
        drop(upstream);
        let final_content = accumulated
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let final_reasoning = accumulated_reasoning
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let terminal_event = match finalize(&stream_state, &generation, final_content, final_reasoning, terminal, usage).await {
            Ok(event) => with_request_id(event, &request_id_text),
            Err(_) => PublicStreamEvent::Error {
                code: "storage_unavailable",
                message: "The generated response could not be saved.",
                request_id: request_id_text,
            },
        };
        if let Some(finalizer) = drop_finalizer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_mut()
        {
            finalizer.armed = false;
        }
        yield Ok(encode_event(&terminal_event));
        registration.finish().await;
    };
    sse_response(stream)
}

async fn replay_terminal(
    state: &AppState,
    request_id: &RequestId,
    result: GenerationResult,
) -> Response {
    let detail = match state
        .storage
        .get(result.generation.conversation_id.clone())
        .await
    {
        Ok(detail) => detail,
        Err(error) => return StreamApiError::from(error).into_response(request_id),
    };
    let Some(message) = detail
        .messages
        .iter()
        .find(|message| message.id == result.generation.assistant_message_id)
    else {
        return StreamApiError::Internal.into_response(request_id);
    };
    let mut events = vec![PublicStreamEvent::Meta {
        conversation_id: result.generation.conversation_id,
        user_message_id: result.user_message_id,
        assistant_message_id: result.generation.assistant_message_id,
        generation_id: result.generation.id,
        model: result.generation.model,
    }];
    if let Some(reasoning) = message
        .reasoning
        .as_ref()
        .filter(|reasoning| !reasoning.is_empty())
    {
        events.push(PublicStreamEvent::ReasoningDelta {
            text: reasoning.clone(),
        });
    }
    events.push(PublicStreamEvent::Delta {
        text: message.content.clone(),
    });
    events.push(terminal_from_persisted(
        message.status,
        message.error_code.as_deref(),
        request_id,
    ));
    sse_response(futures_util::stream::iter(
        events.into_iter().map(|event| Ok(encode_event(&event))),
    ))
}

fn messages_before_assistant(
    messages: &[Message],
    assistant_id: &str,
    retry: bool,
) -> Vec<Message> {
    let mut context: Vec<Message> = messages
        .iter()
        .take_while(|message| message.id != assistant_id)
        .filter(|message| message.status != MessageStatus::Streaming)
        .cloned()
        .collect();
    if retry {
        while context
            .last()
            .is_some_and(|message| message.role == MessageRole::Assistant)
        {
            context.pop();
        }
    }
    context
}

struct DropFinalizer {
    state: AppState,
    generation: Generation,
    accumulated: Arc<Mutex<String>>,
    accumulated_reasoning: Arc<Mutex<String>>,
    armed: bool,
}

impl Drop for DropFinalizer {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let state = self.state.clone();
        let generation = self.generation.clone();
        let content = self
            .accumulated
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let reasoning = self
            .accumulated_reasoning
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        tokio::spawn(async move {
            let _ = finalize(
                &state,
                &generation,
                content,
                reasoning,
                Terminal::Stopped,
                TokenUsage::default(),
            )
            .await;
        });
    }
}

#[derive(Clone)]
enum Terminal {
    Done(String),
    Stopped,
    Error(ChatProviderError),
}

async fn finalize(
    state: &AppState,
    generation: &Generation,
    content: String,
    reasoning: String,
    terminal: Terminal,
    usage: TokenUsage,
) -> Result<PublicStreamEvent, RepositoryError> {
    let (generation_status, message_status, error_code) = match &terminal {
        Terminal::Done(_) => (GenerationStatus::Completed, MessageStatus::Completed, None),
        Terminal::Stopped => (GenerationStatus::Stopped, MessageStatus::Stopped, None),
        Terminal::Error(error) => (
            GenerationStatus::Error,
            MessageStatus::Error,
            Some(error.code().to_owned()),
        ),
    };
    let input_tokens = usage
        .input_tokens
        .and_then(|value| i64::try_from(value).ok());
    let output_tokens = usage
        .output_tokens
        .and_then(|value| i64::try_from(value).ok());
    state
        .storage
        .finalize_generation(GenerationFinalization {
            generation_id: generation.id.clone(),
            assistant_message_id: generation.assistant_message_id.clone(),
            generation_status,
            message_status,
            content,
            reasoning: (!reasoning.is_empty()).then_some(reasoning),
            error_code: error_code.clone(),
            input_tokens,
            output_tokens,
            finished_at: unix_milliseconds(),
        })
        .await?;
    if let Some(error_code) = error_code.as_deref() {
        warn!(
            generation_id = generation.id,
            conversation_id = generation.conversation_id,
            provider = generation.provider,
            model = generation.model,
            error_code,
            input_tokens,
            output_tokens,
            "generation finalized with error"
        );
    } else {
        info!(
            generation_id = generation.id,
            conversation_id = generation.conversation_id,
            provider = generation.provider,
            model = generation.model,
            status = generation_status.as_str(),
            input_tokens,
            output_tokens,
            "generation finalized"
        );
    }
    Ok(match terminal {
        Terminal::Done(finish_reason) => PublicStreamEvent::Done {
            finish_reason,
            usage: (usage != TokenUsage::default()).then_some(PublicUsage {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
            }),
        },
        Terminal::Stopped => PublicStreamEvent::Stopped {
            reason: "user_cancelled",
        },
        Terminal::Error(error) => PublicStreamEvent::Error {
            code: error.code(),
            message: error.safe_message(),
            request_id: String::new(),
        },
    })
}

fn with_request_id(event: PublicStreamEvent, request_id: &str) -> PublicStreamEvent {
    match event {
        PublicStreamEvent::Error { code, message, .. } => PublicStreamEvent::Error {
            code,
            message,
            request_id: request_id.to_owned(),
        },
        other => other,
    }
}

fn terminal_from_persisted(
    status: MessageStatus,
    _code: Option<&str>,
    request_id: &RequestId,
) -> PublicStreamEvent {
    match status {
        MessageStatus::Completed => PublicStreamEvent::Done {
            finish_reason: "stop".to_owned(),
            usage: None,
        },
        MessageStatus::Stopped => PublicStreamEvent::Stopped {
            reason: "user_cancelled",
        },
        MessageStatus::Error | MessageStatus::Interrupted | MessageStatus::Streaming => {
            PublicStreamEvent::Error {
                code: "generation_failed",
                message: "The model response did not complete.",
                request_id: request_id.as_str().to_owned(),
            }
        }
    }
}

fn encode_event(event: &PublicStreamEvent) -> Event {
    let name = match event {
        PublicStreamEvent::Meta { .. } => "meta",
        PublicStreamEvent::Delta { .. } => "delta",
        PublicStreamEvent::ReasoningDelta { .. } => "reasoning_delta",
        PublicStreamEvent::Done { .. } => "done",
        PublicStreamEvent::Stopped { .. } => "stopped",
        PublicStreamEvent::Error { .. } => "error",
    };
    let data = serde_json::to_string(event).unwrap_or_else(|_| "{\"event\":\"error\",\"code\":\"internal_error\",\"message\":\"The stream could not be encoded.\",\"request_id\":\"\"}".to_owned());
    Event::default().event(name).data(data)
}

fn sse_response<S>(stream: S) -> Response
where
    S: futures_util::Stream<Item = Result<Event, std::convert::Infallible>> + Send + 'static,
{
    let mut response = Sse::new(stream)
        .keep_alive(
            KeepAlive::new()
                .interval(std::time::Duration::from_secs(15))
                .text("keepalive"),
        )
        .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert("x-accel-buffering", HeaderValue::from_static("no"));
    response
}

fn valid_client_message_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= MAX_CLIENT_MESSAGE_ID_CHARS
        && !id.chars().any(char::is_control)
}

fn valid_id(id: &str) -> bool {
    Ulid::from_string(id).is_ok()
}
fn unix_milliseconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}
fn default_title(content: &str) -> String {
    let title: String = content.trim().chars().take(80).collect();
    if title.is_empty() {
        "New conversation".to_owned()
    } else {
        title
    }
}

fn map_catalog_error(error: chat_core::model::ModelCatalogError) -> StreamApiError {
    match error {
        chat_core::model::ModelCatalogError::SelectedModelUnavailable => {
            StreamApiError::ModelUnavailable
        }
        other => StreamApiError::ModelCatalog(other),
    }
}

#[derive(Debug)]
enum StreamApiError {
    InvalidRequest,
    PayloadTooLarge,
    MessageTooLarge,
    NotFound,
    ModelMismatch,
    ModelUnavailable,
    ModelCatalog(chat_core::model::ModelCatalogError),
    GenerationInProgress,
    Conflict,
    Capacity,
    Provider(ChatProviderError),
    Storage,
    Internal,
}

impl From<RepositoryError> for StreamApiError {
    fn from(error: RepositoryError) -> Self {
        match error.kind() {
            RepositoryErrorKind::NotFound => Self::NotFound,
            RepositoryErrorKind::Conflict => Self::Conflict,
            RepositoryErrorKind::GenerationInProgress => Self::GenerationInProgress,
            RepositoryErrorKind::Unavailable => Self::Storage,
            RepositoryErrorKind::CorruptData => Self::Internal,
        }
    }
}

impl StreamApiError {
    fn into_response(self, request_id: &RequestId) -> Response {
        let (status, code, message) = match self {
            Self::InvalidRequest => (
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "The message request is invalid.",
            ),
            Self::PayloadTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "The request body is too large.",
            ),
            Self::MessageTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "message_too_large",
                "The message exceeds the configured limit.",
            ),
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                "conversation_not_found",
                "The conversation or response was not found.",
            ),
            Self::ModelMismatch => (
                StatusCode::CONFLICT,
                "model_mismatch",
                "The selected model does not match the conversation's current model.",
            ),
            Self::ModelUnavailable => (
                StatusCode::CONFLICT,
                "model_unavailable",
                "The selected model is no longer available.",
            ),
            Self::ModelCatalog(error) => {
                let status = match error {
                    chat_core::model::ModelCatalogError::RateLimited => {
                        StatusCode::TOO_MANY_REQUESTS
                    }
                    chat_core::model::ModelCatalogError::Timeout => StatusCode::GATEWAY_TIMEOUT,
                    chat_core::model::ModelCatalogError::Unavailable => {
                        StatusCode::SERVICE_UNAVAILABLE
                    }
                    chat_core::model::ModelCatalogError::Unauthorized => StatusCode::BAD_GATEWAY,
                    chat_core::model::ModelCatalogError::InvalidResponse
                    | chat_core::model::ModelCatalogError::EmptyCatalog
                    | chat_core::model::ModelCatalogError::DefaultModelMissing => {
                        StatusCode::UNPROCESSABLE_ENTITY
                    }
                    chat_core::model::ModelCatalogError::SelectedModelUnavailable => {
                        StatusCode::CONFLICT
                    }
                };
                (status, error.code(), error.safe_message())
            }
            Self::GenerationInProgress => (
                StatusCode::CONFLICT,
                "generation_in_progress",
                "This conversation already has an active response.",
            ),
            Self::Conflict => (
                StatusCode::CONFLICT,
                "conflict",
                "The request conflicts with existing data.",
            ),
            Self::Capacity => (
                StatusCode::SERVICE_UNAVAILABLE,
                "generation_capacity",
                "The server is currently at its generation limit.",
            ),
            Self::Provider(error) => {
                let status = match error {
                    ChatProviderError::RateLimited => StatusCode::TOO_MANY_REQUESTS,
                    ChatProviderError::Timeout => StatusCode::GATEWAY_TIMEOUT,
                    ChatProviderError::Unauthorized | ChatProviderError::InvalidResponse => {
                        StatusCode::BAD_GATEWAY
                    }
                    ChatProviderError::Unavailable
                    | ChatProviderError::StreamInterrupted
                    | ChatProviderError::Cancelled => StatusCode::SERVICE_UNAVAILABLE,
                };
                (status, error.code(), error.safe_message())
            }
            Self::Storage => (
                StatusCode::SERVICE_UNAVAILABLE,
                "storage_unavailable",
                "Conversation storage is temporarily unavailable.",
            ),
            Self::Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "The request could not be completed.",
            ),
        };
        public_error_response(request_id, status, code, message)
    }
}

pub const fn body_limit() -> usize {
    MESSAGE_BODY_LIMIT
}

#[cfg(test)]
mod tests {
    use super::{
        PublicStreamEvent, encode_event, messages_before_assistant, terminal_from_persisted,
        valid_client_message_id,
    };
    use crate::request_context::RequestId;
    use chat_core::conversation::{MessageRole, MessageStatus};
    use chat_core::provider::{ContextLimits, select_bounded_context};

    fn fixture_message(
        id: &str,
        role: chat_core::conversation::MessageRole,
    ) -> chat_core::conversation::Message {
        chat_core::conversation::Message {
            id: id.to_owned(),
            conversation_id: "c".to_owned(),
            client_message_id: (role == chat_core::conversation::MessageRole::User)
                .then(|| format!("client-{id}")),
            role,
            content: id.to_owned(),
            reasoning: None,
            status: MessageStatus::Completed,
            model: (role == chat_core::conversation::MessageRole::Assistant)
                .then(|| "model".to_owned()),
            error_code: None,
            created_at: 1,
            finished_at: Some(1),
        }
    }

    #[test]
    fn retry_context_excludes_prior_assistant_attempts() {
        use chat_core::conversation::MessageRole;
        let messages = vec![
            fixture_message("user", MessageRole::User),
            fixture_message("failed-assistant", MessageRole::Assistant),
            fixture_message("retry-placeholder", MessageRole::Assistant),
        ];
        let context = messages_before_assistant(&messages, "retry-placeholder", true);
        assert_eq!(context.len(), 1);
        assert_eq!(context[0].id, "user");
    }

    #[test]
    fn cross_model_history_is_kept_in_bounded_context() {
        let mut first_user = fixture_message("first-user", MessageRole::User);
        first_user.content = "question for model A".to_owned();
        let mut first_assistant = fixture_message("first-assistant", MessageRole::Assistant);
        first_assistant.model = Some("model-a".to_owned());
        first_assistant.content = "answer from model A".to_owned();
        let mut second_user = fixture_message("second-user", MessageRole::User);
        second_user.content = "continue with model B".to_owned();
        let placeholder = fixture_message("model-b-placeholder", MessageRole::Assistant);
        let messages = vec![first_user, first_assistant, second_user, placeholder];

        let candidates = messages_before_assistant(&messages, "model-b-placeholder", false);
        let context = select_bounded_context(
            &candidates,
            ContextLimits {
                max_messages: 10,
                max_chars: 1_000,
            },
        )
        .expect("cross-model context should remain valid");
        assert_eq!(
            context
                .iter()
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>(),
            [
                "question for model A",
                "answer from model A",
                "continue with model B"
            ]
        );
    }

    #[test]
    fn public_events_encode_as_single_line_json() {
        let event = PublicStreamEvent::Delta {
            text: "hello\n😀".to_owned(),
        };
        let encoded = encode_event(&event);
        let debug = format!("{encoded:?}");
        assert!(!debug.contains("hello\n😀"));
        assert!(debug.contains("delta"));
    }

    #[test]
    fn reasoning_delta_encodes_with_reasoning_delta_event_name() {
        let event = PublicStreamEvent::ReasoningDelta {
            text: "thinking".to_owned(),
        };
        let encoded = encode_event(&event);
        let debug = format!("{encoded:?}");
        assert!(debug.contains("reasoning_delta"));
        assert!(debug.contains("thinking"));
    }

    #[test]
    fn id_validation_rejects_empty_controls_and_oversized_values() {
        assert!(valid_client_message_id("client-1"));
        assert!(!valid_client_message_id(""));
        assert!(!valid_client_message_id("bad\nid"));
        assert!(!valid_client_message_id(&"x".repeat(201)));
    }

    #[test]
    fn persisted_state_maps_to_exactly_one_terminal_variant() {
        let request_id = RequestId::test("01TESTREQUESTID");
        assert!(matches!(
            terminal_from_persisted(MessageStatus::Completed, None, &request_id),
            PublicStreamEvent::Done { .. }
        ));
        assert!(matches!(
            terminal_from_persisted(MessageStatus::Stopped, None, &request_id),
            PublicStreamEvent::Stopped { .. }
        ));
        assert!(matches!(
            terminal_from_persisted(MessageStatus::Error, Some("provider_timeout"), &request_id),
            PublicStreamEvent::Error { .. }
        ));
    }
}

use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    Json,
    extract::{
        Extension, Path, Query, State,
        rejection::{JsonRejection, QueryRejection},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chat_core::{
    conversation::{Conversation, ConversationDetail, Message},
    repository::{
        ConversationCursor, ConversationRepository, DEFAULT_CONVERSATION_PAGE_SIZE,
        MAX_CONVERSATION_PAGE_SIZE, RepositoryError, RepositoryErrorKind,
    },
};
use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::{
    AppState,
    request_context::{RequestId, public_error_response},
};

const MAX_TITLE_CHARS: usize = 200;
const MAX_CURSOR_LENGTH: usize = 128;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListQuery {
    cursor: Option<String>,
    limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenameConversationRequest {
    title: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateConversationModelRequest {
    model: String,
}

#[derive(Serialize)]
pub struct ConversationPageResponse {
    conversations: Vec<ConversationResponse>,
    next_cursor: Option<String>,
}

#[derive(Serialize)]
pub struct ConversationDetailResponse {
    conversation: ConversationResponse,
    messages: Vec<MessageResponse>,
}

#[derive(Serialize)]
pub struct ConversationResponse {
    id: String,
    title: String,
    model: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize)]
pub struct MessageResponse {
    id: String,
    conversation_id: String,
    client_message_id: Option<String>,
    role: &'static str,
    content: String,
    reasoning: Option<String>,
    status: &'static str,
    model: Option<String>,
    error_code: Option<String>,
    created_at: i64,
    finished_at: Option<i64>,
}

pub async fn list(
    State(state): State<AppState>,
    Extension(request_id): Extension<RequestId>,
    query: Result<Query<ListQuery>, QueryRejection>,
) -> Response {
    let Ok(Query(query)) = query else {
        return ApiError::InvalidInput.into_response(&request_id);
    };
    match validate_list_query(query) {
        Ok((cursor, limit)) => match state.storage.list(cursor, limit).await {
            Ok(page) => Json(ConversationPageResponse {
                conversations: page
                    .conversations
                    .into_iter()
                    .map(ConversationResponse::from)
                    .collect(),
                next_cursor: page.next_cursor.as_ref().map(encode_cursor),
            })
            .into_response(),
            Err(error) => ApiError::from(error).into_response(&request_id),
        },
        Err(error) => error.into_response(&request_id),
    }
}

pub async fn get(
    State(state): State<AppState>,
    Extension(request_id): Extension<RequestId>,
    Path(id): Path<String>,
) -> Response {
    if !valid_id(&id) {
        return ApiError::InvalidInput.into_response(&request_id);
    }
    match state.storage.get(id).await {
        Ok(detail) => Json(ConversationDetailResponse::from(detail)).into_response(),
        Err(error) => ApiError::from(error).into_response(&request_id),
    }
}

pub async fn rename(
    State(state): State<AppState>,
    Extension(request_id): Extension<RequestId>,
    Path(id): Path<String>,
    request: Result<Json<RenameConversationRequest>, JsonRejection>,
) -> Response {
    let request = match request {
        Ok(Json(request)) => request,
        Err(error) if error.status() == StatusCode::PAYLOAD_TOO_LARGE => {
            return ApiError::PayloadTooLarge.into_response(&request_id);
        }
        Err(_) => return ApiError::InvalidInput.into_response(&request_id),
    };
    let title = request.title.trim();
    if !valid_id(&id)
        || title.is_empty()
        || title.chars().count() > MAX_TITLE_CHARS
        || title.chars().any(char::is_control)
    {
        return ApiError::InvalidInput.into_response(&request_id);
    }
    let updated_at = match unix_milliseconds() {
        Ok(value) => value,
        Err(error) => return error.into_response(&request_id),
    };
    match state.storage.rename(id, title.to_owned(), updated_at).await {
        Ok(conversation) => Json(ConversationResponse::from(conversation)).into_response(),
        Err(error) => ApiError::from(error).into_response(&request_id),
    }
}

pub async fn update_model(
    State(state): State<AppState>,
    Extension(request_id): Extension<RequestId>,
    Path(id): Path<String>,
    request: Result<Json<UpdateConversationModelRequest>, JsonRejection>,
) -> Response {
    let request = match request {
        Ok(Json(request)) => request,
        Err(error) if error.status() == StatusCode::PAYLOAD_TOO_LARGE => {
            return ApiError::PayloadTooLarge.into_response(&request_id);
        }
        Err(_) => return ApiError::InvalidInput.into_response(&request_id),
    };
    if !valid_id(&id) || !chat_core::model::valid_exact_model_id(&request.model) {
        return ApiError::InvalidInput.into_response(&request_id);
    }
    if let Err(error) = state.models.validate_available(&request.model).await {
        return crate::models::error_response(error, &request_id);
    }
    let updated_at = match unix_milliseconds() {
        Ok(value) => value,
        Err(error) => return error.into_response(&request_id),
    };
    match state
        .storage
        .update_model(id, request.model, updated_at)
        .await
    {
        Ok(conversation) => Json(ConversationResponse::from(conversation)).into_response(),
        Err(error) => ApiError::from(error).into_response(&request_id),
    }
}

pub async fn delete(
    State(state): State<AppState>,
    Extension(request_id): Extension<RequestId>,
    Path(id): Path<String>,
) -> Response {
    if !valid_id(&id) {
        return ApiError::InvalidInput.into_response(&request_id);
    }
    match state.storage.delete(id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) if error.kind() == RepositoryErrorKind::NotFound => {
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error) => ApiError::from(error).into_response(&request_id),
    }
}

fn validate_list_query(query: ListQuery) -> Result<(Option<ConversationCursor>, u32), ApiError> {
    let limit = query.limit.unwrap_or(DEFAULT_CONVERSATION_PAGE_SIZE);
    if limit == 0 || limit > MAX_CONVERSATION_PAGE_SIZE {
        return Err(ApiError::InvalidInput);
    }
    let cursor = query
        .cursor
        .map(|value| decode_cursor(&value))
        .transpose()?;
    Ok((cursor, limit))
}

fn encode_cursor(cursor: &ConversationCursor) -> String {
    format!("{}.{}", cursor.updated_at, cursor.id)
}

fn decode_cursor(value: &str) -> Result<ConversationCursor, ApiError> {
    if value.len() > MAX_CURSOR_LENGTH {
        return Err(ApiError::InvalidCursor);
    }
    let (updated_at, id) = value.split_once('.').ok_or(ApiError::InvalidCursor)?;
    let updated_at = updated_at
        .parse::<i64>()
        .map_err(|_| ApiError::InvalidCursor)?;
    if updated_at < 0 || !valid_id(id) {
        return Err(ApiError::InvalidCursor);
    }
    Ok(ConversationCursor {
        updated_at,
        id: id.to_owned(),
    })
}

fn valid_id(id: &str) -> bool {
    Ulid::from_string(id).is_ok()
}

fn unix_milliseconds() -> Result<i64, ApiError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ApiError::Internal)?;
    i64::try_from(duration.as_millis()).map_err(|_| ApiError::Internal)
}

impl From<Conversation> for ConversationResponse {
    fn from(value: Conversation) -> Self {
        Self {
            id: value.id,
            title: value.title,
            model: value.model,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

impl From<Message> for MessageResponse {
    fn from(value: Message) -> Self {
        Self {
            id: value.id,
            conversation_id: value.conversation_id,
            client_message_id: value.client_message_id,
            role: value.role.as_str(),
            content: value.content,
            reasoning: value.reasoning,
            status: value.status.as_str(),
            model: value.model,
            error_code: value.error_code,
            created_at: value.created_at,
            finished_at: value.finished_at,
        }
    }
}

impl From<ConversationDetail> for ConversationDetailResponse {
    fn from(value: ConversationDetail) -> Self {
        Self {
            conversation: value.conversation.into(),
            messages: value
                .messages
                .into_iter()
                .map(MessageResponse::from)
                .collect(),
        }
    }
}

#[derive(Debug)]
enum ApiError {
    InvalidInput,
    InvalidCursor,
    PayloadTooLarge,
    NotFound,
    GenerationInProgress,
    Conflict,
    StorageUnavailable,
    Internal,
}

impl From<RepositoryError> for ApiError {
    fn from(error: RepositoryError) -> Self {
        match error.kind() {
            RepositoryErrorKind::NotFound => Self::NotFound,
            RepositoryErrorKind::Conflict => Self::Conflict,
            RepositoryErrorKind::GenerationInProgress => Self::GenerationInProgress,
            RepositoryErrorKind::Unavailable => Self::StorageUnavailable,
            RepositoryErrorKind::CorruptData => Self::Internal,
        }
    }
}

impl ApiError {
    fn into_response(self, request_id: &RequestId) -> Response {
        let (status, code, message) = match self {
            Self::InvalidInput => (
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "The request contains an invalid field.",
            ),
            Self::InvalidCursor => (
                StatusCode::BAD_REQUEST,
                "invalid_cursor",
                "The conversation cursor is invalid.",
            ),
            Self::PayloadTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "The request body is too large.",
            ),
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                "conversation_not_found",
                "The conversation was not found.",
            ),
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
            Self::StorageUnavailable => (
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

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode, header},
        response::Response,
    };
    use chat_core::{
        conversation::{Message, MessageRole, MessageStatus},
        generation::{Generation, GenerationStatus},
        repository::{
            ConversationCursor, ConversationRepository, GenerationFinalization, NewConversation,
            NewMessageGeneration,
        },
    };
    use serde_json::Value;
    use tower::ServiceExt;
    use ulid::Ulid;

    use super::{decode_cursor, encode_cursor};
    use crate::{
        AppState, build_router,
        model_catalog::ModelCatalogService,
        provider::{OpenAiProvider, ProviderBaseUrl},
        test_provider::{FakeProviderServer, FakeResponse},
    };

    fn configure_models(
        mut state: AppState,
        fake: &FakeProviderServer,
        default_model: &str,
    ) -> AppState {
        let base = ProviderBaseUrl::parse(fake.base_url()).expect("local base should normalize");
        let provider = OpenAiProvider::new(
            &base,
            "provider-key-sentinel".to_owned(),
            Duration::from_millis(50),
        )
        .expect("provider should build");
        state.models = ModelCatalogService::new(
            Arc::new(provider),
            default_model.to_owned(),
            Duration::from_mins(1),
        );
        state
    }

    async fn response_error_code(response: Response) -> (StatusCode, String) {
        let status = response.status();
        let body = to_bytes(response.into_body(), 4096)
            .await
            .expect("error body should read");
        let value: Value = serde_json::from_slice(&body).expect("error should be JSON");
        (
            status,
            value["error"]["code"]
                .as_str()
                .expect("error code should be text")
                .to_owned(),
        )
    }

    async fn authenticated_context(state: &AppState) -> (String, String) {
        let router = build_router(state.clone());
        let token = state.config.access_token.clone();
        let login = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/session")
                    .header(header::ORIGIN, &state.config.app_origin)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(format!(
                        r#"{{"token":"{token}","remember_me":false}}"#
                    )))
                    .expect("login request should build"),
            )
            .await
            .expect("login should respond");
        let cookie = login
            .headers()
            .get(header::SET_COOKIE)
            .expect("login should set cookie")
            .to_str()
            .expect("cookie should be text")
            .split(';')
            .next()
            .expect("cookie should have value")
            .to_owned();
        let session = router
            .oneshot(
                Request::builder()
                    .uri("/api/v1/session")
                    .header(header::COOKIE, &cookie)
                    .body(Body::empty())
                    .expect("session request should build"),
            )
            .await
            .expect("session should respond");
        let body = to_bytes(session.into_body(), 4096)
            .await
            .expect("session body should read");
        let value: Value = serde_json::from_slice(&body).expect("session should be JSON");
        let csrf = value["csrf_token"]
            .as_str()
            .expect("session should include CSRF")
            .to_owned();
        (cookie, csrf)
    }

    #[tokio::test]
    async fn conversation_model_update_preserves_provider_error_taxonomy() {
        let state = crate::tests::test_state().await;
        let id = Ulid::new().to_string();
        state
            .storage
            .create(NewConversation {
                id: id.clone(),
                title: "Original".to_owned(),
                model: "test-model".to_owned(),
                created_at: 100,
            })
            .await
            .expect("fixture should create");
        let router = build_router(state.clone());
        let (cookie, csrf) = authenticated_context(&state).await;

        let response = router
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/api/v1/conversations/{id}/model"))
                    .header(header::COOKIE, cookie)
                    .header(header::ORIGIN, &state.config.app_origin)
                    .header("X-CSRF-Token", csrf)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"model":"test-model"}"#))
                    .expect("request should build"),
            )
            .await
            .expect("request should respond");
        let (status, code) = response_error_code(response).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(code, "model_provider_unavailable");
        assert_eq!(
            state
                .storage
                .get(id)
                .await
                .expect("conversation should remain")
                .conversation
                .model,
            "test-model"
        );
    }

    #[tokio::test]
    async fn conversation_model_update_rejects_malformed_and_removed_models() {
        let fake = FakeProviderServer::start(vec![FakeResponse::json(
            200,
            r#"{"data":[{"id":"model-a"}]}"#,
        )])
        .await;
        let state = configure_models(crate::tests::test_state().await, &fake, "model-a");
        let id = Ulid::new().to_string();
        state
            .storage
            .create(NewConversation {
                id: id.clone(),
                title: "Original".to_owned(),
                model: "model-a".to_owned(),
                created_at: 100,
            })
            .await
            .expect("fixture should create");
        let (cookie, csrf) = authenticated_context(&state).await;
        let router = build_router(state.clone());

        let malformed = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/api/v1/conversations/{id}/model"))
                    .header(header::COOKIE, &cookie)
                    .header(header::ORIGIN, &state.config.app_origin)
                    .header("X-CSRF-Token", &csrf)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"model":" model-a "}"#))
                    .expect("request should build"),
            )
            .await
            .expect("request should respond");
        assert_eq!(
            response_error_code(malformed).await,
            (StatusCode::BAD_REQUEST, "invalid_request".to_owned())
        );
        assert!(
            fake.requests().is_empty(),
            "malformed input must not call provider"
        );

        let removed = router
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/api/v1/conversations/{id}/model"))
                    .header(header::COOKIE, cookie)
                    .header(header::ORIGIN, &state.config.app_origin)
                    .header("X-CSRF-Token", csrf)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"model":"removed-model"}"#))
                    .expect("request should build"),
            )
            .await
            .expect("request should respond");
        assert_eq!(
            response_error_code(removed).await,
            (StatusCode::CONFLICT, "model_unavailable".to_owned())
        );
    }

    #[tokio::test]
    async fn conversation_model_update_reports_generation_in_progress() {
        let fake = FakeProviderServer::start(vec![FakeResponse::json(
            200,
            r#"{"data":[{"id":"model-a"},{"id":"model-b"}]}"#,
        )])
        .await;
        let state = configure_models(crate::tests::test_state().await, &fake, "model-a");
        let id = Ulid::new().to_string();
        state
            .storage
            .create(NewConversation {
                id: id.clone(),
                title: "Original".to_owned(),
                model: "model-a".to_owned(),
                created_at: 100,
            })
            .await
            .expect("fixture should create");
        let assistant_id = Ulid::new().to_string();
        state
            .storage
            .create_generation(
                Message {
                    id: assistant_id.clone(),
                    conversation_id: id.clone(),
                    client_message_id: None,
                    role: MessageRole::Assistant,
                    content: String::new(),
                    reasoning: None,
                    status: MessageStatus::Streaming,
                    model: Some("model-a".to_owned()),
                    error_code: None,
                    created_at: 101,
                    finished_at: None,
                },
                Generation {
                    id: Ulid::new().to_string(),
                    conversation_id: id.clone(),
                    assistant_message_id: assistant_id,
                    provider: "provider".to_owned(),
                    model: "model-a".to_owned(),
                    status: GenerationStatus::Streaming,
                    input_tokens: None,
                    output_tokens: None,
                    started_at: 101,
                    finished_at: None,
                },
            )
            .await
            .expect("active generation fixture should create");
        let (cookie, csrf) = authenticated_context(&state).await;
        let response = build_router(state.clone())
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/api/v1/conversations/{id}/model"))
                    .header(header::COOKIE, cookie)
                    .header(header::ORIGIN, &state.config.app_origin)
                    .header("X-CSRF-Token", csrf)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"model":"model-b"}"#))
                    .expect("request should build"),
            )
            .await
            .expect("request should respond");
        assert_eq!(
            response_error_code(response).await,
            (StatusCode::CONFLICT, "generation_in_progress".to_owned())
        );
    }

    #[allow(
        clippy::too_many_lines,
        reason = "the idempotency regression fixture spans the complete persisted turn"
    )]
    #[tokio::test]
    async fn idempotent_replay_wins_after_current_model_changes() {
        let state = crate::tests::test_state().await;
        let conversation_id = Ulid::new().to_string();
        let user_id = Ulid::new().to_string();
        let assistant_id = Ulid::new().to_string();
        let generation_id = Ulid::new().to_string();
        let client_message_id = "client-idempotent-replay".to_owned();
        state
            .storage
            .create_message_generation(NewMessageGeneration {
                conversation: Some(NewConversation {
                    id: conversation_id.clone(),
                    title: "Original".to_owned(),
                    model: "model-a".to_owned(),
                    created_at: 100,
                }),
                conversation_id: conversation_id.clone(),
                user_message: Message {
                    id: user_id,
                    conversation_id: conversation_id.clone(),
                    client_message_id: Some(client_message_id.clone()),
                    role: MessageRole::User,
                    content: "same prompt".to_owned(),
                    reasoning: None,
                    status: MessageStatus::Completed,
                    model: None,
                    error_code: None,
                    created_at: 100,
                    finished_at: Some(100),
                },
                assistant_message: Message {
                    id: assistant_id.clone(),
                    conversation_id: conversation_id.clone(),
                    client_message_id: None,
                    role: MessageRole::Assistant,
                    content: String::new(),
                    reasoning: None,
                    status: MessageStatus::Streaming,
                    model: Some("model-a".to_owned()),
                    error_code: None,
                    created_at: 101,
                    finished_at: None,
                },
                generation: Generation {
                    id: generation_id.clone(),
                    conversation_id: conversation_id.clone(),
                    assistant_message_id: assistant_id.clone(),
                    provider: "provider".to_owned(),
                    model: "model-a".to_owned(),
                    status: GenerationStatus::Streaming,
                    input_tokens: None,
                    output_tokens: None,
                    started_at: 101,
                    finished_at: None,
                },
            })
            .await
            .expect("original generation should create");
        state
            .storage
            .finalize_generation(GenerationFinalization {
                generation_id,
                assistant_message_id: assistant_id,
                generation_status: GenerationStatus::Completed,
                message_status: MessageStatus::Completed,
                content: "original answer".to_owned(),
                reasoning: None,
                error_code: None,
                input_tokens: None,
                output_tokens: None,
                finished_at: 102,
            })
            .await
            .expect("original generation should finalize");
        state
            .storage
            .update_model(conversation_id.clone(), "model-b".to_owned(), 103)
            .await
            .expect("current model should change after completion");

        let (cookie, csrf) = authenticated_context(&state).await;
        let response = build_router(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/api/v1/conversations/{conversation_id}/messages"
                    ))
                    .header(header::COOKIE, cookie)
                    .header(header::ORIGIN, &state.config.app_origin)
                    .header("X-CSRF-Token", csrf)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(format!(
                        r#"{{"client_message_id":"{client_message_id}","content":"same prompt","model":"model-a"}}"#
                    )))
                    .expect("request should build"),
            )
            .await
            .expect("replay should respond");
        assert_eq!(response.status(), StatusCode::OK);
        let detail = state
            .storage
            .get(conversation_id)
            .await
            .expect("conversation should remain readable");
        assert_eq!(detail.conversation.model, "model-b");
        assert_eq!(
            detail.messages.len(),
            2,
            "replay must not duplicate messages"
        );
    }

    #[tokio::test]
    async fn crud_routes_require_authentication_and_mutation_protection() {
        let state = crate::tests::test_state().await;
        let id = Ulid::new().to_string();
        state
            .storage
            .create(NewConversation {
                id: id.clone(),
                title: "Original".to_owned(),
                model: "test-model".to_owned(),
                created_at: 100,
            })
            .await
            .expect("fixture should create");
        let router = build_router(state.clone());

        let unauthorized = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/conversations")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let (cookie, csrf) = authenticated_context(&state).await;
        let list = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/conversations?limit=1")
                    .header(header::COOKIE, &cookie)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(list.status(), StatusCode::OK);

        let missing_csrf = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/v1/conversations/{id}"))
                    .header(header::COOKIE, &cookie)
                    .header(header::ORIGIN, &state.config.app_origin)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"title":"Renamed"}"#))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(missing_csrf.status(), StatusCode::FORBIDDEN);

        let renamed = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/v1/conversations/{id}"))
                    .header(header::COOKIE, &cookie)
                    .header(header::ORIGIN, &state.config.app_origin)
                    .header("x-csrf-token", &csrf)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"title":"Renamed"}"#))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(renamed.status(), StatusCode::OK);

        let deleted = router
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/v1/conversations/{id}"))
                    .header(header::COOKIE, cookie)
                    .header(header::ORIGIN, &state.config.app_origin)
                    .header("x-csrf-token", csrf)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn rename_rejects_oversized_body_with_stable_safe_error() {
        let state = crate::tests::test_state().await;
        let id = Ulid::new().to_string();
        state
            .storage
            .create(NewConversation {
                id: id.clone(),
                title: "Original".to_owned(),
                model: "test-model".to_owned(),
                created_at: 100,
            })
            .await
            .expect("fixture should create");
        let (cookie, csrf) = authenticated_context(&state).await;
        let response = build_router(state.clone())
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/v1/conversations/{id}"))
                    .header(header::COOKIE, cookie)
                    .header(header::ORIGIN, &state.config.app_origin)
                    .header("x-csrf-token", csrf)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(format!(r#"{{"title":"{}"}}"#, "x".repeat(5000))))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let header_request_id = response
            .headers()
            .get(crate::request_context::REQUEST_ID_HEADER)
            .expect("error response should include request ID")
            .to_str()
            .expect("request ID should be text")
            .to_owned();
        let body = to_bytes(response.into_body(), 4096)
            .await
            .expect("error body should read");
        let value: Value = serde_json::from_slice(&body).expect("error should be JSON");
        assert_eq!(value["error"]["code"], "payload_too_large");
        assert_eq!(value["error"]["request_id"], header_request_id);
        assert!(Ulid::from_string(&header_request_id).is_ok());
        assert!(!String::from_utf8_lossy(&body).contains(&"x".repeat(100)));
    }

    #[test]
    fn cursor_round_trip_is_stable() {
        let cursor = ConversationCursor {
            updated_at: 123,
            id: Ulid::new().to_string(),
        };
        assert_eq!(
            decode_cursor(&encode_cursor(&cursor)).expect("cursor should decode"),
            cursor
        );
    }

    #[test]
    fn malformed_cursor_is_rejected() {
        assert!(decode_cursor("not-a-cursor").is_err());
        assert!(decode_cursor("1.illegal-id").is_err());
        assert!(decode_cursor(&format!("-1.{}", Ulid::new())).is_err());
    }
}

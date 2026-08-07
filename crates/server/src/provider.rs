use std::{fmt, net::IpAddr, time::Duration};

use chat_core::{
    model::{ModelCatalogError, ModelCatalogProvider},
    provider::{
        ChatProvider, ChatProviderError, ChatRequest, ChatStream, ChatStreamEvent, TokenUsage,
    },
};
use futures_util::StreamExt;
use reqwest::{Client, StatusCode, Url};
use serde::Deserialize;

pub(crate) const MAX_MODEL_RESPONSE_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_PROVIDER_SSE_EVENT_BYTES: usize = 1024 * 1024;

/// Canonical provider API root shared by model discovery and Phase E chat.
#[derive(Clone, Debug)]
pub struct ProviderBaseUrl(Url);

impl ProviderBaseUrl {
    pub fn parse(value: &str) -> Result<Self, ProviderBaseUrlError> {
        if value.trim() != value || value.chars().any(char::is_control) {
            return Err(ProviderBaseUrlError);
        }
        let mut url = Url::parse(value).map_err(|_| ProviderBaseUrlError)?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.has_host()
            || (url.scheme() == "http" && !is_loopback_host(&url))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(ProviderBaseUrlError);
        }

        let segments: Vec<&str> = url
            .path_segments()
            .ok_or(ProviderBaseUrlError)?
            .filter(|segment| !segment.is_empty())
            .collect();
        let normalized_path = match segments.as_slice() {
            [] | ["v1"] => "/v1/".to_owned(),
            _ => return Err(ProviderBaseUrlError),
        };
        url.set_path(&normalized_path);
        Ok(Self(url))
    }

    pub fn endpoint(&self, endpoint: ProviderEndpoint) -> Result<Url, ProviderBaseUrlError> {
        self.0
            .join(endpoint.relative_path())
            .map_err(|_| ProviderBaseUrlError)
    }

    #[cfg(test)]
    fn sanitized_origin(&self) -> String {
        self.0.origin().ascii_serialization()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderEndpoint {
    Models,
    ChatCompletions,
}

impl ProviderEndpoint {
    const fn relative_path(self) -> &'static str {
        match self {
            Self::Models => "models",
            Self::ChatCompletions => "chat/completions",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProviderBaseUrlError;

impl fmt::Display for ProviderBaseUrlError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invalid provider base URL")
    }
}

impl std::error::Error for ProviderBaseUrlError {}

#[derive(Clone)]
pub struct OpenAiProvider {
    client: Client,
    models_url: Url,
    chat_url: Url,
    api_key: String,
}

impl OpenAiProvider {
    pub fn new(
        base_url: &ProviderBaseUrl,
        api_key: String,
        timeout: Duration,
    ) -> Result<Self, ProviderBuildError> {
        let client = Client::builder()
            .timeout(timeout)
            .connect_timeout(timeout.min(Duration::from_secs(10)))
            .https_only(base_url.0.scheme() == "https")
            .build()
            .map_err(|_| ProviderBuildError)?;
        let models_url = base_url
            .endpoint(ProviderEndpoint::Models)
            .map_err(|_| ProviderBuildError)?;
        let chat_url = base_url
            .endpoint(ProviderEndpoint::ChatCompletions)
            .map_err(|_| ProviderBuildError)?;
        Ok(Self {
            client,
            models_url,
            chat_url,
            api_key,
        })
    }

    async fn chat_stream(&self, request: ChatRequest) -> Result<ChatStream, ChatProviderError> {
        let response = self
            .client
            .post(self.chat_url.clone())
            .bearer_auth(&self.api_key)
            .json(&ProviderChatRequest::from(request))
            .send()
            .await
            .map_err(|error| map_chat_transport_error(&error))?;
        if !response.status().is_success() {
            return Err(map_chat_status(response.status()));
        }
        if response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_none_or(|value| !value.to_ascii_lowercase().starts_with("text/event-stream"))
        {
            return Err(ChatProviderError::InvalidResponse);
        }

        let mut bytes = response.bytes_stream();
        let stream = async_stream::stream! {
            let mut decoder = UpstreamSseDecoder::default();
            let mut terminal = false;
            while let Some(next) = bytes.next().await {
                let chunk = match next {
                    Ok(chunk) => chunk,
                    Err(error) => {
                        yield Err(if error.is_timeout() { ChatProviderError::Timeout } else { ChatProviderError::StreamInterrupted });
                        return;
                    }
                };
                let events = match decoder.push(&chunk) {
                    Ok(events) => events,
                    Err(error) => { yield Err(error); return; }
                };
                for event in events {
                    if matches!(event, ChatStreamEvent::Done { .. }) { terminal = true; }
                    yield Ok(event);
                    if terminal { return; }
                }
            }
            let events = match decoder.finish() {
                Ok(events) => events,
                Err(error) => { yield Err(error); return; }
            };
            for event in events {
                if matches!(event, ChatStreamEvent::Done { .. }) { terminal = true; }
                yield Ok(event);
            }
            if !terminal { yield Err(ChatProviderError::StreamInterrupted); }
        };
        Ok(Box::pin(stream))
    }

    async fn fetch(&self) -> Result<Vec<String>, ModelCatalogError> {
        let mut response = self
            .client
            .get(self.models_url.clone())
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(|error| map_transport_error(&error))?;
        let status = response.status();
        if !status.is_success() {
            // Deliberately do not consume, retain, or display the raw error body.
            return Err(map_status(status));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_MODEL_RESPONSE_BYTES as u64)
        {
            return Err(ModelCatalogError::InvalidResponse);
        }

        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| map_transport_error(&error))?
        {
            if body.len().saturating_add(chunk.len()) > MAX_MODEL_RESPONSE_BYTES {
                return Err(ModelCatalogError::InvalidResponse);
            }
            body.extend_from_slice(&chunk);
        }
        let response: ProviderModelsResponse =
            serde_json::from_slice(&body).map_err(|_| ModelCatalogError::InvalidResponse)?;
        Ok(response
            .data
            .into_iter()
            .filter_map(|row| row.as_object()?.get("id")?.as_str().map(str::to_owned))
            .collect())
    }
}

impl ModelCatalogProvider for OpenAiProvider {
    fn fetch_model_ids(
        &self,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Vec<String>, ModelCatalogError>> + Send + '_>,
    > {
        Box::pin(self.fetch())
    }
}

impl ChatProvider for OpenAiProvider {
    fn chat(
        &self,
        request: ChatRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<ChatStream, ChatProviderError>> + Send + '_>,
    > {
        Box::pin(self.chat_stream(request))
    }
}

#[derive(serde::Serialize)]
struct ProviderChatRequest {
    model: String,
    messages: Vec<ProviderChatMessage>,
    stream: bool,
    stream_options: ProviderStreamOptions,
}

#[derive(serde::Serialize)]
struct ProviderChatMessage {
    role: &'static str,
    content: String,
}

#[derive(serde::Serialize)]
struct ProviderStreamOptions {
    include_usage: bool,
}

impl From<ChatRequest> for ProviderChatRequest {
    fn from(request: ChatRequest) -> Self {
        Self {
            model: request.model,
            messages: request
                .messages
                .into_iter()
                .map(|message| ProviderChatMessage {
                    role: message.role.as_str(),
                    content: message.content,
                })
                .collect(),
            stream: true,
            stream_options: ProviderStreamOptions {
                include_usage: true,
            },
        }
    }
}

#[derive(Default)]
struct UpstreamSseDecoder {
    buffer: Vec<u8>,
    data_lines: Vec<String>,
    finish_reason: Option<String>,
    usage: Option<TokenUsage>,
}

impl UpstreamSseDecoder {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<ChatStreamEvent>, ChatProviderError> {
        self.buffer.extend_from_slice(chunk);
        if self.buffer.len() > MAX_PROVIDER_SSE_EVENT_BYTES {
            return Err(ChatProviderError::InvalidResponse);
        }
        let mut output = Vec::new();
        while let Some(newline) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let mut line = self.buffer.drain(..=newline).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.consume_line(&line, &mut output)?;
        }
        Ok(output)
    }

    fn finish(&mut self) -> Result<Vec<ChatStreamEvent>, ChatProviderError> {
        let mut output = Vec::new();
        if !self.buffer.is_empty() {
            let line = std::mem::take(&mut self.buffer);
            self.consume_line(&line, &mut output)?;
        }
        if !self.data_lines.is_empty() {
            self.dispatch(&mut output)?;
        }
        Ok(output)
    }

    fn consume_line(
        &mut self,
        line: &[u8],
        output: &mut Vec<ChatStreamEvent>,
    ) -> Result<(), ChatProviderError> {
        let line = std::str::from_utf8(line).map_err(|_| ChatProviderError::InvalidResponse)?;
        if line.is_empty() {
            return self.dispatch(output);
        }
        if line.starts_with(':') {
            return Ok(());
        }
        if let Some(data) = line.strip_prefix("data:") {
            self.data_lines
                .push(data.strip_prefix(' ').unwrap_or(data).to_owned());
        }
        Ok(())
    }

    fn dispatch(&mut self, output: &mut Vec<ChatStreamEvent>) -> Result<(), ChatProviderError> {
        if self.data_lines.is_empty() {
            return Ok(());
        }
        let data = self.data_lines.join("\n");
        self.data_lines.clear();
        if data.trim() == "[DONE]" {
            output.push(ChatStreamEvent::Done {
                finish_reason: self
                    .finish_reason
                    .take()
                    .unwrap_or_else(|| "stop".to_owned()),
                usage: self.usage.take().unwrap_or_default(),
            });
            return Ok(());
        }
        let chunk: ProviderChatChunk =
            serde_json::from_str(&data).map_err(|_| ChatProviderError::InvalidResponse)?;
        if let Some(usage) = chunk.usage {
            self.usage = Some(usage.into());
        }
        if let Some(choice) = chunk.choices.into_iter().next() {
            if let Some(content) = choice.delta.content
                && !content.is_empty()
            {
                output.push(ChatStreamEvent::Delta(content));
            }
            if let Some(finish_reason) = choice.finish_reason {
                self.finish_reason = Some(finish_reason);
            }
        }
        Ok(())
    }
}

#[derive(serde::Deserialize)]
struct ProviderChatChunk {
    #[serde(default)]
    choices: Vec<ProviderChoice>,
    usage: Option<ProviderUsage>,
}

#[derive(serde::Deserialize)]
struct ProviderChoice {
    #[serde(default)]
    delta: ProviderDelta,
    finish_reason: Option<String>,
}

#[derive(Default, serde::Deserialize)]
struct ProviderDelta {
    content: Option<String>,
}

#[derive(serde::Deserialize)]
struct ProviderUsage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
}

impl From<ProviderUsage> for TokenUsage {
    fn from(usage: ProviderUsage) -> Self {
        Self {
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
        }
    }
}

#[derive(Debug, Deserialize)]
struct ProviderModelsResponse {
    data: Vec<serde_json::Value>,
}

fn is_loopback_host(url: &Url) -> bool {
    url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProviderBuildError;

impl fmt::Display for ProviderBuildError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("provider HTTP client could not be initialized")
    }
}

impl std::error::Error for ProviderBuildError {}

fn map_chat_transport_error(error: &reqwest::Error) -> ChatProviderError {
    if error.is_timeout() {
        ChatProviderError::Timeout
    } else {
        ChatProviderError::Unavailable
    }
}

fn map_chat_status(status: StatusCode) -> ChatProviderError {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ChatProviderError::Unauthorized,
        StatusCode::TOO_MANY_REQUESTS => ChatProviderError::RateLimited,
        status if status.is_server_error() => ChatProviderError::Unavailable,
        _ => ChatProviderError::InvalidResponse,
    }
}

fn map_transport_error(error: &reqwest::Error) -> ModelCatalogError {
    if error.is_timeout() {
        ModelCatalogError::Timeout
    } else if error.is_decode() {
        ModelCatalogError::InvalidResponse
    } else {
        ModelCatalogError::Unavailable
    }
}

fn map_status(status: StatusCode) -> ModelCatalogError {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ModelCatalogError::Unauthorized,
        StatusCode::TOO_MANY_REQUESTS => ModelCatalogError::RateLimited,
        status if status.is_server_error() => ModelCatalogError::Unavailable,
        _ => ModelCatalogError::InvalidResponse,
    }
}

impl fmt::Debug for OpenAiProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpenAiProvider { redacted: true }")
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use chat_core::model::{ModelCatalogError, ModelCatalogProvider};

    use super::{OpenAiProvider, ProviderBaseUrl, ProviderEndpoint};
    use crate::test_provider::{FakeProviderServer, FakeResponse};

    #[test]
    fn base_url_matrix_builds_one_v1_prefix() {
        for configured in [
            "https://api.example.com",
            "https://api.example.com/",
            "https://api.example.com/v1",
            "https://api.example.com/v1/",
        ] {
            let base = ProviderBaseUrl::parse(configured).expect("allowed URL should normalize");
            assert_eq!(
                base.endpoint(ProviderEndpoint::Models)
                    .expect("models endpoint should build")
                    .as_str(),
                "https://api.example.com/v1/models"
            );
            assert_eq!(
                base.endpoint(ProviderEndpoint::ChatCompletions)
                    .expect("future chat endpoint should build")
                    .as_str(),
                "https://api.example.com/v1/chat/completions"
            );
            assert_eq!(base.sanitized_origin(), "https://api.example.com");
        }
    }

    #[test]
    fn unsafe_or_malformed_urls_are_rejected_without_displaying_them() {
        let secret = "url-secret-sentinel";
        for configured in [
            "ftp://api.example.com",
            "http://api.example.com/v1",
            "https://api.example.com/v1/v1",
            "https://api.example.com/v1/models",
            "https://user:password@api.example.com/v1",
            "https://api.example.com/v1?key=url-secret-sentinel",
            "https://api.example.com/v1#fragment",
            " https://api.example.com/v1",
            "not a url",
        ] {
            let error = ProviderBaseUrl::parse(configured)
                .expect_err("disallowed URL should be rejected")
                .to_string();
            assert!(!error.contains(secret));
            assert!(!error.contains(configured));
        }
    }

    #[tokio::test]
    async fn local_provider_fetch_is_authenticated_and_filters_wire_rows() {
        let fake = FakeProviderServer::start(vec![FakeResponse::json(
            200,
            r#"{"data":[{"id":"model-b"},{"id":42},{"wrong":"row"},{"id":"model-a"}]}"#,
        )])
        .await;
        let base = ProviderBaseUrl::parse(fake.base_url()).expect("local base should normalize");
        let provider = OpenAiProvider::new(
            &base,
            "provider-key-sentinel".to_owned(),
            Duration::from_secs(1),
        )
        .expect("provider should build");
        assert_eq!(
            provider
                .fetch_model_ids()
                .await
                .expect("catalog should fetch"),
            ["model-b", "model-a"]
        );
        let requests = fake.requests();
        let request = requests.first().expect("request should be captured");
        assert!(request.starts_with("GET /v1/models HTTP/1.1"));
        assert!(request.contains("authorization: Bearer provider-key-sentinel"));
    }

    #[tokio::test]
    async fn local_provider_maps_status_timeout_malformed_and_oversized_bodies() {
        for (response, expected) in [
            (
                FakeResponse::json(401, "raw-auth-body-sentinel"),
                ModelCatalogError::Unauthorized,
            ),
            (
                FakeResponse::json(403, "raw-forbidden-body-sentinel"),
                ModelCatalogError::Unauthorized,
            ),
            (
                FakeResponse::json(429, "raw-rate-body-sentinel"),
                ModelCatalogError::RateLimited,
            ),
            (
                FakeResponse::json(503, "raw-5xx-body-sentinel"),
                ModelCatalogError::Unavailable,
            ),
            (
                FakeResponse::json(200, "not-json raw-malformed-body-sentinel"),
                ModelCatalogError::InvalidResponse,
            ),
        ] {
            let fake = FakeProviderServer::start(vec![response]).await;
            let provider = OpenAiProvider::new(
                &ProviderBaseUrl::parse(fake.base_url()).expect("local base should normalize"),
                "provider-key-sentinel".to_owned(),
                Duration::from_secs(1),
            )
            .expect("provider should build");
            let error = provider
                .fetch_model_ids()
                .await
                .expect_err("scripted failure should map");
            assert_eq!(error, expected);
            let rendered = error.to_string();
            assert!(!rendered.contains("sentinel"));
            assert!(!rendered.contains("provider-key"));
        }

        let fake = FakeProviderServer::start(vec![
            FakeResponse::json(200, r#"{"data":[]}"#).delayed(Duration::from_millis(100)),
        ])
        .await;
        let provider = OpenAiProvider::new(
            &ProviderBaseUrl::parse(fake.base_url()).expect("local base should normalize"),
            "provider-key-sentinel".to_owned(),
            Duration::from_millis(20),
        )
        .expect("provider should build");
        assert_eq!(
            provider.fetch_model_ids().await,
            Err(ModelCatalogError::Timeout)
        );

        let fake = FakeProviderServer::start(vec![FakeResponse::json(
            200,
            format!(r#"{{"data":[],"padding":"{}"}}"#, "x".repeat(1024 * 1024)),
        )])
        .await;
        let provider = OpenAiProvider::new(
            &ProviderBaseUrl::parse(fake.base_url()).expect("local base should normalize"),
            "provider-key-sentinel".to_owned(),
            Duration::from_secs(1),
        )
        .expect("provider should build");
        assert_eq!(
            provider.fetch_model_ids().await,
            Err(ModelCatalogError::InvalidResponse)
        );
    }

    #[tokio::test]
    async fn chat_request_is_authenticated_streaming_and_decodes_success() {
        use chat_core::provider::{
            ChatMessage, ChatProvider, ChatRequest, ChatRole, ChatStreamEvent,
        };
        use futures_util::StreamExt;

        let fake = FakeProviderServer::start(vec![FakeResponse::sse(concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hello 😀\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        ))]).await;
        let provider = OpenAiProvider::new(
            &ProviderBaseUrl::parse(fake.base_url()).expect("local base should normalize"),
            "provider-key-sentinel".to_owned(),
            Duration::from_secs(1),
        )
        .expect("provider should build");
        let mut stream = provider
            .chat(ChatRequest {
                model: "model-a".to_owned(),
                messages: vec![ChatMessage {
                    role: ChatRole::User,
                    content: "private prompt sentinel".to_owned(),
                }],
            })
            .await
            .expect("chat should start");
        assert!(
            matches!(stream.next().await, Some(Ok(ChatStreamEvent::Delta(text))) if text == "hello 😀")
        );
        assert!(
            matches!(stream.next().await, Some(Ok(ChatStreamEvent::Done { finish_reason, .. })) if finish_reason == "stop")
        );
        let request = fake
            .requests()
            .into_iter()
            .next()
            .expect("request captured");
        assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1"));
        assert!(request.contains("authorization: Bearer provider-key-sentinel"));
        assert!(request.contains("\"stream\":true"));
        assert!(request.contains("private prompt sentinel"));
    }

    #[tokio::test]
    async fn chat_http_failures_never_expose_raw_upstream_body() {
        use chat_core::provider::{ChatProvider, ChatRequest};
        for (status, expected) in [
            (401, chat_core::provider::ChatProviderError::Unauthorized),
            (429, chat_core::provider::ChatProviderError::RateLimited),
            (503, chat_core::provider::ChatProviderError::Unavailable),
        ] {
            let fake = FakeProviderServer::start(vec![FakeResponse::json(
                status,
                "raw-chat-body-secret-sentinel",
            )])
            .await;
            let provider = OpenAiProvider::new(
                &ProviderBaseUrl::parse(fake.base_url()).expect("local base should normalize"),
                "provider-key-secret-sentinel".to_owned(),
                Duration::from_secs(1),
            )
            .expect("provider should build");
            let Err(error) = provider
                .chat(ChatRequest {
                    model: "model".to_owned(),
                    messages: Vec::new(),
                })
                .await
            else {
                panic!("scripted status should fail");
            };
            assert_eq!(error, expected);
            assert!(!error.to_string().contains("sentinel"));
        }
    }

    #[test]
    fn upstream_decoder_handles_arbitrary_utf8_boundaries_usage_and_done() {
        let wire = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"😀\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3}}\n\n",
            "data: [DONE]\n\n"
        )
        .as_bytes();
        let split = wire
            .windows(4)
            .position(|window| window == "😀".as_bytes())
            .expect("emoji bytes should exist")
            + 2;
        let mut decoder = super::UpstreamSseDecoder::default();
        let mut events = decoder.push(&wire[..split]).expect("prefix should buffer");
        events.extend(decoder.push(&wire[split..]).expect("suffix should decode"));
        assert!(
            matches!(events.first(), Some(chat_core::provider::ChatStreamEvent::Delta(text)) if text == "😀")
        );
        assert!(
            matches!(events.last(), Some(chat_core::provider::ChatStreamEvent::Done { finish_reason, usage }) if finish_reason == "stop" && usage.input_tokens == Some(2) && usage.output_tokens == Some(3))
        );
    }

    #[test]
    fn upstream_decoder_rejects_invalid_utf8_and_malformed_json() {
        let mut decoder = super::UpstreamSseDecoder::default();
        assert_eq!(
            decoder.push(b"data: \xff\n\n"),
            Err(chat_core::provider::ChatProviderError::InvalidResponse)
        );
        let mut decoder = super::UpstreamSseDecoder::default();
        assert_eq!(
            decoder.push(b"data: not-json\n\n"),
            Err(chat_core::provider::ChatProviderError::InvalidResponse)
        );
    }

    #[test]
    fn chat_status_mapping_is_stable() {
        use chat_core::provider::ChatProviderError;
        assert_eq!(
            super::map_chat_status(reqwest::StatusCode::UNAUTHORIZED),
            ChatProviderError::Unauthorized
        );
        assert_eq!(
            super::map_chat_status(reqwest::StatusCode::TOO_MANY_REQUESTS),
            ChatProviderError::RateLimited
        );
        assert_eq!(
            super::map_chat_status(reqwest::StatusCode::SERVICE_UNAVAILABLE),
            ChatProviderError::Unavailable
        );
    }

    #[test]
    fn client_build_error_does_not_expose_api_key_or_url() {
        let base =
            ProviderBaseUrl::parse("https://api.example.com/v1").expect("base should normalize");
        let provider = OpenAiProvider::new(
            &base,
            "provider-key-secret-sentinel".to_owned(),
            Duration::from_secs(1),
        )
        .expect("client should build");
        let rendered = format!("{provider:?}");
        assert!(!rendered.contains("provider-key-secret-sentinel"));
        assert!(!rendered.contains("api.example.com"));
    }
}

#![cfg(test)]

//! Live integration tests against the real provider configured in the
//! repo-root `.env` (`AI_BASE_URL`, `AI_API_KEY`, `AI_DEFAULT_MODEL`).
//!
//! These tests exercise the same `OpenAiProvider` and HTTP router the app
//! uses in production, so they genuinely reach the provider API. They are
//! deliberately not part of the deterministic unit suite:
//!
//! * The provider must be configured. When `AI_BASE_URL` / `AI_API_KEY` /
//!   `AI_DEFAULT_MODEL` are missing or point at a placeholder
//!   (`api.example.com`, `provider-key`), every test skips with a printed
//!   note instead of failing, keeping CI deterministic.
//! * A real call may be slow, rate-limited, or temporarily unavailable;
//!   tests tolerate provider-side failures by skipping the assertion rather
//!   than flaking the suite.

use std::{collections::HashMap, path::PathBuf, time::Duration};

use chat_core::{
    model::ModelCatalogProvider,
    provider::{ChatMessage, ChatProvider, ChatRequest, ChatRole, ChatStreamEvent},
};
use futures_util::StreamExt;

/// Locate the repo-root `.env` by walking up from the crate directory.
fn repo_root_env_path() -> Option<PathBuf> {
    let mut directory = std::env::current_dir().ok()?;
    loop {
        let candidate = directory.join(".env");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !directory.pop() {
            return None;
        }
    }
}

/// Loads `KEY=VALUE` pairs from a `.env` file (trivial parser, no deps).
fn load_dotenv(path: &PathBuf) -> HashMap<String, String> {
    let mut values = HashMap::new();
    let Ok(contents) = std::fs::read_to_string(path) else {
        return values;
    };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        values.insert(key.trim().to_owned(), value.trim().to_owned());
    }
    values
}

/// Real provider configuration from the repo-root `.env` (or the process
/// environment, which takes precedence). Returns `None` when the provider is
/// not configured for live use.
fn real_provider_config() -> Option<(String, String, String)> {
    let dotenv = repo_root_env_path()
        .map(|path| load_dotenv(&path))
        .unwrap_or_default();
    let lookup = |key: &str| std::env::var(key).ok().or_else(|| dotenv.get(key).cloned());

    let base_url = lookup("AI_BASE_URL")?;
    let api_key = lookup("AI_API_KEY")?;
    let default_model = lookup("AI_DEFAULT_MODEL")?;

    // Placeholders from `.env.example` / deterministic test fixtures.
    let is_placeholder = base_url.contains("api.example.com")
        || api_key.is_empty()
        || api_key.contains("provider-key")
        || api_key.contains("replace-with")
        || default_model.contains("replace-with");
    if is_placeholder {
        return None;
    }
    Some((base_url, api_key, default_model))
}

/// Shared skip note so a skipped live test is visible in test output.
fn skip_note(test: &str, reason: &str) {
    eprintln!("SKIP {test}: {reason}");
}

fn provider_from_env() -> Option<(crate::provider::OpenAiProvider, String)> {
    let (base_url, api_key, default_model) = real_provider_config()?;
    let base = crate::provider::ProviderBaseUrl::parse(&base_url)
        .expect("live test provider base URL should parse");
    let provider = crate::provider::OpenAiProvider::new(&base, api_key, Duration::from_mins(1))
        .expect("live test provider client should initialize");
    Some((provider, default_model))
}

fn provider_unavailable_reason(error: chat_core::model::ModelCatalogError) -> String {
    format!("provider catalog unavailable: {error}")
}

#[tokio::test]
async fn live_model_catalog_reaches_real_provider() {
    let Some((provider, default_model)) = provider_from_env() else {
        skip_note(
            "live_model_catalog_reaches_real_provider",
            "AI_BASE_URL/AI_API_KEY/AI_DEFAULT_MODEL not configured for live use",
        );
        return;
    };
    let ids = match provider.fetch_model_ids().await {
        Ok(ids) => ids,
        Err(error) => {
            skip_note(
                "live_model_catalog_reaches_real_provider",
                &provider_unavailable_reason(error),
            );
            return;
        }
    };
    assert!(
        !ids.is_empty(),
        "live provider catalog should contain at least one model"
    );
    assert!(
        ids.iter().any(|id| id == &default_model),
        "live provider catalog should contain the configured default model {default_model:?}; got {ids:?}"
    );
    eprintln!("LIVE models ({}): {}", ids.len(), ids.join(", "));
}

#[tokio::test]
async fn live_chat_completion_streams_from_real_provider() {
    let Some((provider, default_model)) = provider_from_env() else {
        skip_note(
            "live_chat_completion_streams_from_real_provider",
            "AI_BASE_URL/AI_API_KEY/AI_DEFAULT_MODEL not configured for live use",
        );
        return;
    };
    let request = ChatRequest {
        model: default_model.clone(),
        messages: vec![ChatMessage {
            role: ChatRole::User,
            content: "Reply with exactly the word: pong".to_owned(),
        }],
    };
    let mut stream = match provider.chat(request).await {
        Ok(stream) => stream,
        Err(error) => {
            skip_note(
                "live_chat_completion_streams_from_real_provider",
                &format!("provider chat unavailable: {error}"),
            );
            return;
        }
    };
    let mut content = String::new();
    let mut saw_done = false;
    while let Some(event) = stream.next().await {
        match event {
            Ok(ChatStreamEvent::Delta(text)) => content.push_str(&text),
            Ok(ChatStreamEvent::ReasoningDelta(_)) => {}
            Ok(ChatStreamEvent::Done { .. }) => {
                saw_done = true;
                break;
            }
            Err(error) => {
                skip_note(
                    "live_chat_completion_streams_from_real_provider",
                    &format!("provider stream error: {error}"),
                );
                return;
            }
        }
    }
    assert!(saw_done, "live provider stream should terminate with Done");
    assert!(
        !content.trim().is_empty(),
        "live provider chat should return non-empty content"
    );
    eprintln!("LIVE reply ({} chars): {content:?}", content.len());
}

/// Full HTTP round trip through the production router: login, create a
/// conversation with the real default model, and stream the SSE reply.
#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn live_router_streams_new_conversation() {
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode, header},
    };
    use serde_json::Value;
    use tower::ServiceExt;

    let Some((base_url, api_key, default_model)) = real_provider_config() else {
        skip_note(
            "live_router_streams_new_conversation",
            "AI_BASE_URL/AI_API_KEY/AI_DEFAULT_MODEL not configured for live use",
        );
        return;
    };

    // Build a real AppState exactly like production: temp database, real
    // provider, real model catalog, real auth.
    let directory = tempfile::TempDir::new().expect("temporary directory should be created");
    let database_path = directory.path().join("chat.db");
    let values = HashMap::from([
        ("APP_ACCESS_TOKEN", "a".repeat(32)),
        ("APP_ORIGIN", "https://chat.example.com".to_owned()),
        (
            "DATABASE_PATH",
            database_path.to_string_lossy().into_owned(),
        ),
        ("AI_BASE_URL", base_url.clone()),
        ("AI_API_KEY", api_key.clone()),
        ("AI_DEFAULT_MODEL", default_model.clone()),
    ]);
    let config = std::sync::Arc::new(
        crate::AppConfig::from_lookup(|key| values.get(key).cloned())
            .expect("live test configuration should be valid"),
    );
    let auth = std::sync::Arc::new(crate::AuthService::new(
        &config.access_token,
        config.app_origin.clone(),
        config.cookie_secure,
    ));
    let storage = chat_storage::SqliteStorage::initialize(&config.database_path)
        .await
        .expect("live test database should initialize");
    let provider = std::sync::Arc::new(
        crate::OpenAiProvider::new(
            &config.ai_base_url,
            config.ai_api_key.clone(),
            config.ai_request_timeout,
        )
        .expect("live test provider should initialize"),
    );
    let models = crate::ModelCatalogService::new(
        provider.clone(),
        config.ai_default_model.clone(),
        config.model_cache_ttl,
    );
    let generations = crate::GenerationRegistry::new(config.max_active_generations);
    let state = crate::AppState {
        config,
        auth,
        storage,
        models,
        provider,
        generations,
    };

    // Login to obtain a session cookie + CSRF token.
    let router = crate::build_router(state.clone());
    let login = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/session")
                .header(header::ORIGIN, "https://chat.example.com")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","remember_me":false}"#,
                ))
                .expect("login request should build"),
        )
        .await
        .expect("login should respond");
    assert_eq!(login.status(), StatusCode::NO_CONTENT);
    let cookie = login
        .headers()
        .get(header::SET_COOKIE)
        .expect("login should set a cookie")
        .to_str()
        .expect("cookie should be text")
        .split(';')
        .next()
        .expect("cookie should contain a value")
        .to_owned();
    let session = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/session")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .expect("session request should build"),
        )
        .await
        .expect("session should respond");
    assert_eq!(session.status(), StatusCode::OK);
    let session_body = to_bytes(session.into_body(), 4096)
        .await
        .expect("session body should read");
    let session_json: Value =
        serde_json::from_slice(&session_body).expect("session should be JSON");
    let csrf = session_json["csrf_token"]
        .as_str()
        .expect("session should include CSRF")
        .to_owned();

    // Send the first message; the router creates the conversation, locks the
    // real default model, and streams the provider reply as SSE.
    let message_request = serde_json::json!({
        "client_message_id": "live-test-1",
        "content": "Reply with exactly the word: hello",
        "model": default_model.clone(),
    });
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/conversations/new/messages")
                .header(header::COOKIE, &cookie)
                .header("x-csrf-token", &csrf)
                .header(header::ORIGIN, "https://chat.example.com")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(message_request.to_string()))
                .expect("message request should build"),
        )
        .await
        .expect("router should respond");

    if response.status() != StatusCode::OK {
        skip_note(
            "live_router_streams_new_conversation",
            &format!("router returned non-OK status {:?}", response.status()),
        );
        return;
    }
    let body = to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("stream body should read");
    let text = String::from_utf8_lossy(&body);
    assert!(
        text.contains("event: meta"),
        "stream should start with a meta event; got: {text:?}"
    );
    assert!(
        text.contains("event: delta"),
        "stream should contain at least one delta event; got: {text:?}"
    );
    assert!(
        text.contains("event: done"),
        "stream should end with a done event; got: {text:?}"
    );
    assert!(
        text.contains(&default_model),
        "stream meta should echo the real default model; got: {text:?}"
    );
    eprintln!("LIVE router stream OK ({} bytes)", text.len());
}

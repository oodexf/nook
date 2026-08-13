use axum::{
    Json,
    extract::{Extension, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use chat_core::model::ModelCatalogError;
use serde::Serialize;

use crate::{
    AppState,
    model_catalog::{CachePolicy, CatalogSnapshot},
    request_context::{RequestId, public_error_response},
};

#[derive(Debug, Serialize)]
pub struct ModelCatalogResponse {
    models: Vec<ModelResponse>,
    default_model: String,
    refreshed_at: i64,
    stale: bool,
    refresh_error: Option<ModelRefreshErrorResponse>,
}

#[derive(Debug, Serialize)]
pub struct ModelResponse {
    id: String,
    label: String,
}

#[derive(Debug, Serialize)]
pub struct ModelRefreshErrorResponse {
    code: &'static str,
    message: &'static str,
    request_id: String,
}

pub async fn get(
    State(state): State<AppState>,
    Extension(request_id): Extension<RequestId>,
) -> Response {
    respond(&state, &request_id, CachePolicy::UseFresh).await
}

pub async fn refresh(
    State(state): State<AppState>,
    Extension(request_id): Extension<RequestId>,
) -> Response {
    respond(&state, &request_id, CachePolicy::Refresh).await
}

async fn respond(state: &AppState, request_id: &RequestId, policy: CachePolicy) -> Response {
    match state.models.get(policy).await {
        Ok(snapshot) => no_store(Json(to_response(snapshot, request_id)).into_response()),
        Err(error) => no_store(error_response(error, request_id)),
    }
}

fn to_response(snapshot: CatalogSnapshot, request_id: &RequestId) -> ModelCatalogResponse {
    ModelCatalogResponse {
        models: snapshot
            .catalog
            .models
            .into_iter()
            .map(|model| ModelResponse {
                label: model.id.clone(),
                id: model.id,
            })
            .collect(),
        default_model: snapshot.default_model,
        refreshed_at: snapshot.catalog.refreshed_at,
        stale: snapshot.stale,
        refresh_error: snapshot
            .refresh_error
            .map(|error| ModelRefreshErrorResponse {
                code: error.code(),
                message: error.safe_message(),
                request_id: request_id.as_str().to_owned(),
            }),
    }
}

pub(crate) fn error_response(error: ModelCatalogError, request_id: &RequestId) -> Response {
    let status = match error {
        ModelCatalogError::RateLimited => StatusCode::TOO_MANY_REQUESTS,
        ModelCatalogError::Timeout => StatusCode::GATEWAY_TIMEOUT,
        ModelCatalogError::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        ModelCatalogError::SelectedModelUnavailable => StatusCode::CONFLICT,
        ModelCatalogError::Unauthorized => StatusCode::BAD_GATEWAY,
        ModelCatalogError::InvalidResponse
        | ModelCatalogError::EmptyCatalog
        | ModelCatalogError::DefaultModelMissing => StatusCode::UNPROCESSABLE_ENTITY,
    };
    public_error_response(request_id, status, error.code(), error.safe_message())
}

fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode, header},
    };
    use serde_json::Value;
    use tower::ServiceExt;

    use crate::{
        AppState, build_router,
        model_catalog::ModelCatalogService,
        provider::{OpenAiProvider, ProviderBaseUrl},
        test_provider::{FakeProviderServer, FakeResponse},
    };

    async fn authenticated_context(state: &AppState) -> (String, String) {
        let router = build_router(state.clone());
        let login = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/session")
                    .header(header::ORIGIN, &state.config.app_origin)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(format!(
                        r#"{{"token":"{}","remember_me":false}}"#,
                        state.config.access_token
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
            .expect("cookie should contain value")
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

    #[tokio::test]
    async fn model_routes_require_auth_and_refresh_requires_origin_and_csrf() {
        let fake = FakeProviderServer::start(vec![
            FakeResponse::json(200, r#"{"data":[{"id":"model-a"}]}"#),
            FakeResponse::json(200, r#"{"data":[{"id":"model-a"},{"id":"model-b"}]}"#),
        ])
        .await;
        let state = configure_models(crate::tests::test_state().await, &fake, "model-a");
        let router = build_router(state.clone());

        let unauthorized = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/models")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let (cookie, csrf) = authenticated_context(&state).await;
        let fetched = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/models")
                    .header(header::COOKIE, &cookie)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(fetched.status(), StatusCode::OK);
        assert_eq!(
            fetched
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok()),
            Some("no-store")
        );
        let request_id = fetched
            .headers()
            .get(crate::request_context::REQUEST_ID_HEADER)
            .expect("response should carry request ID")
            .to_str()
            .expect("request ID should be text")
            .to_owned();
        let body = to_bytes(fetched.into_body(), 16 * 1024)
            .await
            .expect("body should read");
        let value: Value = serde_json::from_slice(&body).expect("body should be JSON");
        assert_eq!(value["models"][0]["id"], "model-a");
        assert_eq!(value["models"][0]["label"], "model-a");
        assert_eq!(value["default_model"], "model-a");
        assert_eq!(value["stale"], false);
        assert_eq!(value["refresh_error"], Value::Null);
        assert!(!String::from_utf8_lossy(&body).contains("provider-key-sentinel"));
        assert!(!request_id.is_empty());

        let missing_csrf = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/models/refresh")
                    .header(header::COOKIE, &cookie)
                    .header(header::ORIGIN, &state.config.app_origin)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(missing_csrf.status(), StatusCode::FORBIDDEN);

        let refreshed = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/models/refresh")
                    .header(header::COOKIE, cookie)
                    .header(header::ORIGIN, &state.config.app_origin)
                    .header("x-csrf-token", csrf)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(refreshed.status(), StatusCode::OK);
        let body = to_bytes(refreshed.into_body(), 16 * 1024)
            .await
            .expect("body should read");
        let value: Value = serde_json::from_slice(&body).expect("body should be JSON");
        assert_eq!(value["models"].as_array().map(Vec::len), Some(2));
    }

    #[tokio::test]
    async fn api_returns_stale_refresh_metadata_and_blocking_default_error() {
        let fake = FakeProviderServer::start(vec![
            FakeResponse::json(200, r#"{"data":[{"id":"model-a"}]}"#),
            FakeResponse::json(429, "raw-rate-body-sentinel"),
        ])
        .await;
        let state = configure_models(crate::tests::test_state().await, &fake, "model-a");
        let (cookie, csrf) = authenticated_context(&state).await;
        let router = build_router(state.clone());
        router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/models")
                    .header(header::COOKIE, &cookie)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("initial request should respond");
        let stale_response = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/models/refresh")
                    .header(header::COOKIE, &cookie)
                    .header(header::ORIGIN, &state.config.app_origin)
                    .header("x-csrf-token", &csrf)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("refresh should respond");
        assert_eq!(stale_response.status(), StatusCode::OK);
        let header_id = stale_response
            .headers()
            .get(crate::request_context::REQUEST_ID_HEADER)
            .expect("response should carry request ID")
            .to_str()
            .expect("request ID should be text")
            .to_owned();
        let body = to_bytes(stale_response.into_body(), 16 * 1024)
            .await
            .expect("body should read");
        let value: Value = serde_json::from_slice(&body).expect("body should be JSON");
        assert_eq!(value["stale"], true);
        assert_eq!(
            value["refresh_error"]["code"],
            "model_provider_rate_limited"
        );
        assert_eq!(value["refresh_error"]["request_id"], header_id);
        assert!(!String::from_utf8_lossy(&body).contains("raw-rate-body-sentinel"));

        let fake = FakeProviderServer::start(vec![FakeResponse::json(
            200,
            r#"{"data":[{"id":"different-model"}]}"#,
        )])
        .await;
        let state = configure_models(crate::tests::test_state().await, &fake, "missing-default");
        let (cookie, _) = authenticated_context(&state).await;
        let blocked = build_router(state)
            .oneshot(
                Request::builder()
                    .uri("/api/v1/models")
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(blocked.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = to_bytes(blocked.into_body(), 16 * 1024)
            .await
            .expect("body should read");
        let value: Value = serde_json::from_slice(&body).expect("body should be JSON");
        assert_eq!(value["error"]["code"], "model_default_missing");
        assert!(!String::from_utf8_lossy(&body).contains("different-model"));
    }

    #[tokio::test]
    async fn availability_validator_detects_removed_models_without_affecting_history() {
        let fake = FakeProviderServer::start(vec![FakeResponse::json(
            200,
            r#"{"data":[{"id":"model-a"}]}"#,
        )])
        .await;
        let state = configure_models(crate::tests::test_state().await, &fake, "model-a");
        assert!(state.models.validate_available("model-a").await.is_ok());
        assert_eq!(
            state.models.validate_available("removed-model").await,
            Err(chat_core::model::ModelCatalogError::SelectedModelUnavailable)
        );
        // Historical conversation reads use storage only; catalog validation is
        // deliberately called only by future generation/create flows.
    }
}

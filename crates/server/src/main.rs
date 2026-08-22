mod auth;
mod chat;
mod config;
mod conversations;
mod generation_registry;
#[cfg(test)]
mod live_tests;
mod model_catalog;
mod models;
mod provider;
mod request_context;
mod static_assets;
#[cfg(test)]
mod test_provider;

use std::{
    io::{Read, Write},
    net::TcpStream,
    sync::Arc,
    time::Duration,
};

use auth::AuthService;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    middleware,
    routing::{delete, get, patch, post, put},
};
use chat_core::{APP_NAME, repository::StorageHealth};
use chat_storage::SqliteStorage;
use config::AppConfig;
use generation_registry::GenerationRegistry;
use model_catalog::ModelCatalogService;
use provider::OpenAiProvider;
use serde::Serialize;
use tokio::net::TcpListener;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

#[derive(Clone)]
pub(crate) struct AppState {
    config: Arc<AppConfig>,
    auth: Arc<AuthService>,
    storage: SqliteStorage,
    models: ModelCatalogService,
    provider: Arc<OpenAiProvider>,
    generations: GenerationRegistry,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        std::process::exit(run_healthcheck());
    }
    if std::env::args().nth(1).as_deref() == Some("backup") {
        init_tracing();
        std::process::exit(run_backup().await);
    }

    init_tracing();

    let config = match AppConfig::from_env() {
        Ok(config) => Arc::new(config),
        Err(error) => {
            error!(error = %error, "configuration validation failed");
            std::process::exit(2);
        }
    };

    let bind = config.bind;
    let storage = match SqliteStorage::initialize(&config.database_path).await {
        Ok(storage) => storage,
        Err(error) => {
            error!(error = %error, "database initialization failed");
            std::process::exit(2);
        }
    };
    let auth = Arc::new(AuthService::new(
        &config.access_token,
        config.app_origin.clone(),
        config.cookie_secure,
    ));
    let provider = match OpenAiProvider::new(
        &config.ai_base_url,
        config.ai_api_key.clone(),
        config.ai_request_timeout,
    ) {
        Ok(provider) => Arc::new(provider),
        Err(error) => {
            error!(error = %error, "provider client initialization failed");
            std::process::exit(2);
        }
    };
    let models = ModelCatalogService::new(
        provider.clone(),
        config.ai_default_model.clone(),
        config.model_cache_ttl,
    );
    let generations = GenerationRegistry::new(config.max_active_generations);
    let shutdown_generations = generations.clone();
    let app = build_router(AppState {
        config,
        auth,
        storage,
        models,
        provider,
        generations,
    });
    let listener = match TcpListener::bind(bind).await {
        Ok(listener) => listener,
        Err(error) => {
            error!(%error, %bind, "failed to bind HTTP listener");
            std::process::exit(2);
        }
    };

    info!(app = APP_NAME, %bind, "server started");

    if let Err(error) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(shutdown_generations))
        .await
    {
        error!(%error, "server stopped unexpectedly");
        std::process::exit(1);
    }
}

fn conversation_routes(state: &AppState) -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/conversations",
            get(conversations::list).route_layer(middleware::from_fn_with_state(
                state.clone(),
                auth::require_session,
            )),
        )
        .route(
            "/api/v1/conversations/{id}",
            get(conversations::get).route_layer(middleware::from_fn_with_state(
                state.clone(),
                auth::require_session,
            )),
        )
        .route(
            "/api/v1/conversations/{id}",
            patch(conversations::rename)
                .delete(conversations::delete)
                .layer(DefaultBodyLimit::max(4 * 1024))
                .route_layer(middleware::from_fn_with_state(
                    state.clone(),
                    auth::require_mutation,
                )),
        )
        .route(
            "/api/v1/conversations/{id}/model",
            put(conversations::update_model)
                .layer(DefaultBodyLimit::max(4 * 1024))
                .route_layer(middleware::from_fn_with_state(
                    state.clone(),
                    auth::require_mutation,
                )),
        )
}

fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/health/live", get(live))
        .route("/api/v1/health/ready", get(ready))
        .route(
            "/api/v1/session",
            post(auth::login).layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .route(
            "/api/v1/session",
            get(auth::get_session).route_layer(middleware::from_fn_with_state(
                state.clone(),
                auth::require_session,
            )),
        )
        .route(
            "/api/v1/session",
            delete(auth::logout).route_layer(middleware::from_fn_with_state(
                state.clone(),
                auth::require_mutation,
            )),
        )
        .route(
            "/api/v1/models",
            get(models::get).route_layer(middleware::from_fn_with_state(
                state.clone(),
                auth::require_session,
            )),
        )
        .route(
            "/api/v1/models/refresh",
            post(models::refresh).route_layer(middleware::from_fn_with_state(
                state.clone(),
                auth::require_mutation,
            )),
        )
        .merge(conversation_routes(&state))
        .route(
            "/api/v1/conversations/new/messages",
            post(chat::new_message)
                .layer(DefaultBodyLimit::max(chat::body_limit()))
                .route_layer(middleware::from_fn_with_state(
                    state.clone(),
                    auth::require_mutation,
                )),
        )
        .route(
            "/api/v1/conversations/{id}/messages",
            post(chat::existing_message)
                .layer(DefaultBodyLimit::max(chat::body_limit()))
                .route_layer(middleware::from_fn_with_state(
                    state.clone(),
                    auth::require_mutation,
                )),
        )
        .route(
            "/api/v1/messages/{assistant_message_id}/retry",
            post(chat::retry).route_layer(middleware::from_fn_with_state(
                state.clone(),
                auth::require_mutation,
            )),
        )
        .route(
            "/api/v1/generations/{generation_id}/cancel",
            post(chat::cancel).route_layer(middleware::from_fn_with_state(
                state.clone(),
                auth::require_mutation,
            )),
        )
        .fallback(static_assets::serve)
        .layer(middleware::from_fn(security_headers))
        .layer(middleware::from_fn(request_context::complete_request))
        .with_state(state)
}

async fn security_headers(
    request: axum::extract::Request,
    next: middleware::Next,
) -> axum::response::Response {
    use axum::http::{HeaderName, HeaderValue, header};

    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
        ),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    headers.insert(
        HeaderName::from_static("cross-origin-opener-policy"),
        HeaderValue::from_static("same-origin"),
    );
    response
}

async fn live() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn ready(State(state): State<AppState>) -> (StatusCode, Json<HealthResponse>) {
    if state.config.is_ready() && state.storage.check().await.is_ok() {
        (StatusCode::OK, Json(HealthResponse { status: "ready" }))
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(HealthResponse {
                status: "not_ready",
            }),
        )
    }
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .json()
        .with_current_span(false)
        .with_span_list(false)
        .init();
}

async fn shutdown_signal(generations: GenerationRegistry) {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            error!(%error, "failed to install Ctrl+C handler");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => error!(%error, "failed to install SIGTERM handler"),
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }

    let active_generations = generations.active_count().await;
    info!(active_generations, "shutdown signal received");
    generations.cancel_all().await;
}

async fn run_backup() -> i32 {
    let destination = match std::env::args().nth(2) {
        Some(path) if !path.trim().is_empty() => path,
        _ => {
            eprintln!("usage: chat-server backup <destination.db>");
            return 2;
        }
    };
    let config = match AppConfig::from_env() {
        Ok(config) => config,
        Err(error) => {
            error!(error = %error, "backup configuration validation failed");
            return 2;
        }
    };
    let storage = match SqliteStorage::initialize(&config.database_path).await {
        Ok(storage) => storage,
        Err(error) => {
            error!(error = %error, "backup database initialization failed");
            return 1;
        }
    };
    match storage.backup(&destination).await {
        Ok(()) => {
            info!(destination = %destination, "database backup completed");
            0
        }
        Err(error) => {
            error!(error = %error, "database backup failed");
            1
        }
    }
}

fn run_healthcheck() -> i32 {
    match healthcheck_request() {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("healthcheck failed: {error}");
            1
        }
    }
}

fn healthcheck_request() -> Result<(), String> {
    let bind = std::env::var("APP_BIND").unwrap_or_else(|_| "0.0.0.0:8080".to_owned());
    let configured_address = bind
        .parse::<std::net::SocketAddr>()
        .map_err(|error| error.to_string())?;
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], configured_address.port()));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3))
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(
            b"GET /api/v1/health/live HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        )
        .map_err(|error| error.to_string())?;

    let mut response = [0_u8; 64];
    let read = stream
        .read(&mut response)
        .map_err(|error| error.to_string())?;
    let status_line = std::str::from_utf8(&response[..read]).map_err(|error| error.to_string())?;

    if status_line.starts_with("HTTP/1.1 200") {
        Ok(())
    } else {
        Err("liveness endpoint did not return HTTP 200".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    use super::{
        AppConfig, AppState, AuthService, GenerationRegistry, ModelCatalogService, OpenAiProvider,
        SqliteStorage, build_router,
    };

    pub(crate) async fn test_state() -> AppState {
        let directory = tempfile::TempDir::new().expect("temporary directory should be created");
        let database_path = directory.path().join("chat.db");
        let persistent_directory = directory.keep();
        let values = HashMap::from([
            ("APP_ACCESS_TOKEN", "a".repeat(32)),
            ("APP_ORIGIN", "https://chat.example.com".to_owned()),
            (
                "DATABASE_PATH",
                database_path.to_string_lossy().into_owned(),
            ),
            ("AI_BASE_URL", "https://api.example.com/v1".to_owned()),
            ("AI_API_KEY", "provider-key".to_owned()),
            ("AI_DEFAULT_MODEL", "gpt-5.6-luna".to_owned()),
        ]);
        let config = AppConfig::from_lookup(|key| values.get(key).cloned())
            .expect("test configuration should be valid");

        let config = std::sync::Arc::new(config);
        let auth = std::sync::Arc::new(AuthService::new(
            &config.access_token,
            config.app_origin.clone(),
            config.cookie_secure,
        ));
        let storage = SqliteStorage::initialize(&config.database_path)
            .await
            .expect("test database should initialize");
        let provider = std::sync::Arc::new(
            OpenAiProvider::new(
                &config.ai_base_url,
                config.ai_api_key.clone(),
                config.ai_request_timeout,
            )
            .expect("test provider client should initialize"),
        );
        let models = ModelCatalogService::new(
            provider.clone(),
            config.ai_default_model.clone(),
            config.model_cache_ttl,
        );
        debug_assert!(persistent_directory.exists());
        let generations = GenerationRegistry::new(config.max_active_generations);
        AppState {
            config,
            auth,
            storage,
            models,
            provider,
            generations,
        }
    }

    #[tokio::test]
    async fn liveness_is_public_and_minimal() {
        let response = build_router(test_state().await)
            .oneshot(
                Request::builder()
                    .uri("/api/v1/health/live")
                    .header("cookie", "chat_session=secret-cookie-sentinel")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::OK);
        let request_id = response
            .headers()
            .get(crate::request_context::REQUEST_ID_HEADER)
            .expect("health response should include a request ID")
            .to_str()
            .expect("request ID should be text");
        assert!(ulid::Ulid::from_string(request_id).is_ok());
        assert!(!request_id.contains("secret-cookie-sentinel"));
        let body = to_bytes(response.into_body(), 1024)
            .await
            .expect("health body should be readable");
        assert_eq!(&body[..], br#"{"status":"ok"}"#);
    }

    #[tokio::test]
    async fn liveness_includes_security_headers() {
        let response = build_router(test_state().await)
            .oneshot(
                Request::builder()
                    .uri("/api/v1/health/live")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("x-content-type-options")
                .and_then(|value| value.to_str().ok()),
            Some("nosniff")
        );
        assert_eq!(
            response
                .headers()
                .get("referrer-policy")
                .and_then(|value| value.to_str().ok()),
            Some("no-referrer")
        );
        assert!(response.headers().contains_key("content-security-policy"));
        assert!(response.headers().contains_key("permissions-policy"));
    }

    #[tokio::test]
    async fn readiness_confirms_validated_configuration() {
        let response = build_router(test_state().await)
            .oneshot(
                Request::builder()
                    .uri("/api/v1/health/ready")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn unknown_api_route_does_not_fall_back_to_spa() {
        let response = build_router(test_state().await)
            .oneshot(
                Request::builder()
                    .uri("/api/v1/unknown")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_ne!(
            response.headers().get("content-type"),
            Some(&axum::http::HeaderValue::from_static("text/html"))
        );
    }

    #[tokio::test]
    async fn login_session_and_logout_round_trip() {
        let router = build_router(test_state().await);
        let login = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/session")
                    .header("origin", "https://chat.example.com")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","remember_me":false}"#,
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(login.status(), StatusCode::NO_CONTENT);
        let session_cookie = login
            .headers()
            .get("set-cookie")
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
                    .header("cookie", &session_cookie)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(session.status(), StatusCode::OK);
        let session_body = to_bytes(session.into_body(), 4096)
            .await
            .expect("session body should be readable");
        let session_json: serde_json::Value =
            serde_json::from_slice(&session_body).expect("session body should be JSON");
        let csrf = session_json["csrf_token"]
            .as_str()
            .expect("session should include CSRF");

        let cross_origin_logout = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/v1/session")
                    .header("origin", "https://attacker.example")
                    .header("cookie", &session_cookie)
                    .header("x-csrf-token", csrf)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(cross_origin_logout.status(), StatusCode::FORBIDDEN);

        let missing_csrf_logout = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/v1/session")
                    .header("origin", "https://chat.example.com")
                    .header("cookie", &session_cookie)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(missing_csrf_logout.status(), StatusCode::FORBIDDEN);

        let logout = router
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/v1/session")
                    .header("origin", "https://chat.example.com")
                    .header("cookie", session_cookie)
                    .header("x-csrf-token", csrf)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(logout.status(), StatusCode::NO_CONTENT);
        assert!(
            logout
                .headers()
                .get("set-cookie")
                .expect("logout should clear cookie")
                .to_str()
                .expect("cookie should be text")
                .contains("Max-Age=0")
        );
    }
}

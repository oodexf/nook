mod config;
mod static_assets;

use std::{
    io::{Read, Write},
    net::TcpStream,
    sync::Arc,
    time::Duration,
};

use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
use chat_core::APP_NAME;
use config::AppConfig;
use serde::Serialize;
use tokio::net::TcpListener;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

#[derive(Clone)]
struct AppState {
    config: Arc<AppConfig>,
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

    init_tracing();

    let config = match AppConfig::from_env() {
        Ok(config) => Arc::new(config),
        Err(error) => {
            error!(error = %error, "configuration validation failed");
            std::process::exit(2);
        }
    };

    let bind = config.bind;
    let app = build_router(AppState { config });
    let listener = match TcpListener::bind(bind).await {
        Ok(listener) => listener,
        Err(error) => {
            error!(%error, %bind, "failed to bind HTTP listener");
            std::process::exit(2);
        }
    };

    info!(app = APP_NAME, %bind, "server started");

    if let Err(error) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        error!(%error, "server stopped unexpectedly");
        std::process::exit(1);
    }
}

fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/health/live", get(live))
        .route("/api/v1/health/ready", get(ready))
        .fallback(static_assets::serve)
        .with_state(state)
}

async fn live() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn ready(State(state): State<AppState>) -> (StatusCode, Json<HealthResponse>) {
    if state.config.is_ready() {
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

async fn shutdown_signal() {
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

    info!("shutdown signal received");
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

    use super::{AppConfig, AppState, build_router};

    fn test_state() -> AppState {
        let values = HashMap::from([
            ("APP_ACCESS_TOKEN", "a".repeat(32)),
            ("AI_BASE_URL", "https://api.example.com/v1".to_owned()),
            ("AI_API_KEY", "provider-key".to_owned()),
            ("AI_DEFAULT_MODEL", "test-model".to_owned()),
        ]);
        let config = AppConfig::from_lookup(|key| values.get(key).cloned())
            .expect("test configuration should be valid");

        AppState {
            config: std::sync::Arc::new(config),
        }
    }

    #[tokio::test]
    async fn liveness_is_public_and_minimal() {
        let response = build_router(test_state())
            .oneshot(
                Request::builder()
                    .uri("/api/v1/health/live")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 1024)
            .await
            .expect("health body should be readable");
        assert_eq!(&body[..], br#"{"status":"ok"}"#);
    }

    #[tokio::test]
    async fn readiness_confirms_validated_configuration() {
        let response = build_router(test_state())
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
        let response = build_router(test_state())
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
}

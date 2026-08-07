use std::time::Instant;

use axum::{
    Json,
    extract::{MatchedPath, Request},
    http::{HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use tracing::{Level, warn};
use ulid::Ulid;

pub(crate) const REQUEST_ID_HEADER: &str = "x-request-id";

#[derive(Clone, Debug)]
pub(crate) struct RequestId(String);

impl RequestId {
    fn generate() -> Self {
        Self(Ulid::new().to_string())
    }

    #[cfg(test)]
    pub(crate) fn test(value: &str) -> Self {
        Self(value.to_owned())
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: PublicError,
}

#[derive(Debug, Serialize)]
struct PublicError {
    code: &'static str,
    message: &'static str,
    request_id: String,
}

fn record_completion(request_id: &str, method: &str, route: &str, status: u16, duration_ms: u64) {
    tracing::event!(
        target: "http_request",
        Level::INFO,
        request_id,
        method,
        route,
        status,
        duration_ms,
        "request completed"
    );
}

pub(crate) async fn complete_request(mut request: Request, next: Next) -> Response {
    let request_id = RequestId::generate();
    let method = request.method().clone();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map_or("<unmatched>", MatchedPath::as_str)
        .to_owned();
    request.extensions_mut().insert(request_id.clone());

    let started = Instant::now();
    let response = next.run(request).await;
    let response = finish_request(response, &request_id, &method, &route, started);
    if status_is_server_error(response.status()) {
        warn!(
            request_id = request_id.as_str(),
            method = method.as_str(),
            route,
            status = response.status().as_u16(),
            error_code = "request_failed",
            "request completed with server error"
        );
    }
    response
}

fn status_is_server_error(status: StatusCode) -> bool {
    status.is_server_error()
}

fn finish_request(
    mut response: Response,
    request_id: &RequestId,
    method: &axum::http::Method,
    route: &str,
    started: Instant,
) -> Response {
    let status = response.status();
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    response.headers_mut().insert(
        REQUEST_ID_HEADER,
        HeaderValue::from_str(request_id.as_str())
            .expect("application-generated ULIDs are valid HTTP header values"),
    );

    record_completion(
        request_id.as_str(),
        method.as_str(),
        route,
        status.as_u16(),
        duration_ms,
    );
    response
}

pub(crate) fn public_error_response(
    request_id: &RequestId,
    status: StatusCode,
    code: &'static str,
    message: &'static str,
) -> Response {
    (
        status,
        Json(ErrorBody {
            error: PublicError {
                code,
                message,
                request_id: request_id.as_str().to_owned(),
            },
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        sync::{Arc, Mutex},
    };

    use tracing::{
        Dispatch, Event, Metadata, Subscriber,
        field::{Field, Visit},
        span::{Attributes, Id, Record},
    };

    use super::record_completion;

    #[derive(Clone, Default)]
    struct CapturingSubscriber {
        events: Arc<Mutex<Vec<BTreeMap<String, String>>>>,
    }

    impl Subscriber for CapturingSubscriber {
        fn enabled(&self, _metadata: &Metadata<'_>) -> bool {
            true
        }

        fn max_level_hint(&self) -> Option<tracing::metadata::LevelFilter> {
            Some(tracing::metadata::LevelFilter::TRACE)
        }

        fn new_span(&self, _span: &Attributes<'_>) -> Id {
            Id::from_u64(1)
        }

        fn record(&self, _span: &Id, _values: &Record<'_>) {}

        fn record_follows_from(&self, _span: &Id, _follows: &Id) {}

        fn event(&self, event: &Event<'_>) {
            let mut fields = BTreeMap::new();
            event.record(&mut FieldVisitor(&mut fields));
            self.events
                .lock()
                .expect("captured log mutex should not be poisoned")
                .push(fields);
        }

        fn enter(&self, _span: &Id) {}

        fn exit(&self, _span: &Id) {}
    }

    struct FieldVisitor<'a>(&'a mut BTreeMap<String, String>);

    impl Visit for FieldVisitor<'_> {
        fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
            self.0.insert(field.name().to_owned(), format!("{value:?}"));
        }

        fn record_str(&mut self, field: &Field, value: &str) {
            self.0.insert(field.name().to_owned(), value.to_owned());
        }

        fn record_u64(&mut self, field: &Field, value: u64) {
            self.0.insert(field.name().to_owned(), value.to_string());
        }
    }

    #[test]
    fn completion_log_uses_safe_route_template_and_response_request_id() {
        let subscriber = CapturingSubscriber::default();
        let events = Arc::clone(&subscriber.events);
        let dispatch = Dispatch::new(subscriber);
        tracing::dispatcher::with_default(&dispatch, || {
            record_completion("01SAFEULID", "GET", "/api/v1/conversations/{id}", 401, 7);
        });

        let events = events
            .lock()
            .expect("captured log mutex should not be poisoned");
        let completion = events
            .iter()
            .find(|event| event.get("request_id").map(String::as_str) == Some("01SAFEULID"))
            .expect("request completion should be logged");
        assert_eq!(
            completion.get("request_id").map(String::as_str),
            Some("01SAFEULID")
        );
        assert_eq!(completion.get("method").map(String::as_str), Some("GET"));
        assert_eq!(
            completion.get("route").map(String::as_str),
            Some("/api/v1/conversations/{id}")
        );
        assert_eq!(completion.get("status").map(String::as_str), Some("401"));
        assert!(completion.contains_key("duration_ms"));
        let rendered = format!("{completion:?}");
        assert!(!rendered.contains("secret-sentinel"));
    }
}

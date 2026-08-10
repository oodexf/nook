use std::{
    collections::VecDeque,
    fmt::Write as _,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json,
    extract::{Extension, Request, State, rejection::JsonRejection},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;

use crate::{
    AppState,
    request_context::{RequestId, public_error_response},
};

const COOKIE_NAME: &str = "chat_session";
// These byte strings are cryptographic protocol identifiers, not display
// branding. Keep them stable across product renames so upgrades do not
// invalidate every existing session and CSRF token.
const SESSION_CONTEXT: &[u8] = b"minimal-ai-chat/session/v1";
const CSRF_CONTEXT: &[u8] = b"minimal-ai-chat/csrf/v1:";
const BROWSER_SESSION_SECONDS: u64 = 24 * 60 * 60;
const REMEMBERED_SESSION_SECONDS: u64 = 30 * 24 * 60 * 60;
const FAILURE_WINDOW: Duration = Duration::from_mins(1);
const MAX_FAILURES_PER_WINDOW: usize = 5;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub struct AuthService {
    signing_key: [u8; 32],
    expected_token_hash: [u8; 32],
    origin: String,
    cookie_secure: bool,
    failures: Arc<Mutex<VecDeque<Instant>>>,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    token: String,
    #[serde(default)]
    remember_me: bool,
}

#[derive(Serialize)]
pub struct SessionResponse {
    authenticated: bool,
    csrf_token: String,
}

#[derive(Clone)]
pub struct SessionIdentity {
    nonce: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct SessionClaims {
    version: u8,
    issued_at: u64,
    expires_at: u64,
    nonce: String,
}

impl AuthService {
    #[must_use]
    pub fn new(access_token: &str, origin: String, cookie_secure: bool) -> Self {
        let expected_token_hash = Sha256::digest(access_token.as_bytes()).into();
        let mut key_hasher = Sha256::new();
        key_hasher.update(SESSION_CONTEXT);
        key_hasher.update(access_token.as_bytes());
        let signing_key = key_hasher.finalize().into();

        Self {
            signing_key,
            expected_token_hash,
            origin,
            cookie_secure,
            failures: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    async fn login_allowed(&self) -> bool {
        let mut failures = self.failures.lock().await;
        let now = Instant::now();
        let cutoff = now.checked_sub(FAILURE_WINDOW).unwrap_or(now);
        while failures.front().is_some_and(|failure| *failure < cutoff) {
            failures.pop_front();
        }
        failures.len() < MAX_FAILURES_PER_WINDOW
    }

    async fn record_failure(&self) {
        self.failures.lock().await.push_back(Instant::now());
    }

    fn token_matches(&self, candidate: &str) -> bool {
        let candidate_hash: [u8; 32] = Sha256::digest(candidate.as_bytes()).into();
        bool::from(candidate_hash.ct_eq(&self.expected_token_hash))
    }

    fn issue_session(&self, remember_me: bool) -> Result<(String, String), AuthError> {
        let issued_at = unix_seconds()?;
        let lifetime = if remember_me {
            REMEMBERED_SESSION_SECONDS
        } else {
            BROWSER_SESSION_SECONDS
        };
        let nonce = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 16]>());
        let claims = SessionClaims {
            version: 1,
            issued_at,
            expires_at: issued_at + lifetime,
            nonce,
        };
        let payload = URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&claims).map_err(|_| AuthError::InvalidSession)?);
        let signature = self.sign(payload.as_bytes())?;
        let session = format!("{payload}.{signature}");
        let csrf = self.csrf_token(&claims.nonce)?;
        Ok((session, csrf))
    }

    fn verify_session(&self, value: &str) -> Result<SessionClaims, AuthError> {
        let (payload, signature) = value.split_once('.').ok_or(AuthError::InvalidSession)?;
        let signature = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| AuthError::InvalidSession)?;
        let mut mac =
            HmacSha256::new_from_slice(&self.signing_key).map_err(|_| AuthError::InvalidSession)?;
        mac.update(payload.as_bytes());
        mac.verify_slice(&signature)
            .map_err(|_| AuthError::InvalidSession)?;

        let claims: SessionClaims = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(payload)
                .map_err(|_| AuthError::InvalidSession)?,
        )
        .map_err(|_| AuthError::InvalidSession)?;
        if claims.version != 1 || claims.expires_at <= unix_seconds()? {
            return Err(AuthError::InvalidSession);
        }
        Ok(claims)
    }

    fn csrf_token(&self, nonce: &str) -> Result<String, AuthError> {
        let mut message = Vec::with_capacity(CSRF_CONTEXT.len() + nonce.len());
        message.extend_from_slice(CSRF_CONTEXT);
        message.extend_from_slice(nonce.as_bytes());
        self.sign(&message)
    }

    fn sign(&self, message: &[u8]) -> Result<String, AuthError> {
        let mut mac =
            HmacSha256::new_from_slice(&self.signing_key).map_err(|_| AuthError::InvalidSession)?;
        mac.update(message);
        Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
    }

    fn validate_origin(&self, headers: &HeaderMap) -> Result<(), AuthError> {
        let origin = headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
            .ok_or(AuthError::CsrfRejected)?;
        if origin == self.origin {
            Ok(())
        } else {
            Err(AuthError::CsrfRejected)
        }
    }

    fn session_from_headers(&self, headers: &HeaderMap) -> Result<SessionClaims, AuthError> {
        let cookie = headers
            .get(header::COOKIE)
            .and_then(|value| value.to_str().ok())
            .and_then(|cookies| {
                cookies.split(';').find_map(|cookie| {
                    let (name, value) = cookie.trim().split_once('=')?;
                    (name == COOKIE_NAME).then_some(value)
                })
            })
            .ok_or(AuthError::Unauthorized)?;
        self.verify_session(cookie)
            .map_err(|_| AuthError::Unauthorized)
    }

    fn set_cookie(&self, value: &str, remember_me: bool) -> Result<HeaderValue, AuthError> {
        let mut cookie = format!("{COOKIE_NAME}={value}; Path=/; HttpOnly; SameSite=Strict");
        if self.cookie_secure {
            cookie.push_str("; Secure");
        }
        if remember_me {
            write!(cookie, "; Max-Age={REMEMBERED_SESSION_SECONDS}")
                .map_err(|_| AuthError::InvalidSession)?;
        }
        HeaderValue::from_str(&cookie).map_err(|_| AuthError::InvalidSession)
    }

    fn clear_cookie(&self) -> Result<HeaderValue, AuthError> {
        let mut cookie = format!("{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
        if self.cookie_secure {
            cookie.push_str("; Secure");
        }
        HeaderValue::from_str(&cookie).map_err(|_| AuthError::InvalidSession)
    }
}

pub async fn login(
    State(state): State<AppState>,
    Extension(request_id): Extension<RequestId>,
    headers: HeaderMap,
    request: Result<Json<LoginRequest>, JsonRejection>,
) -> Response {
    let request = match request {
        Ok(Json(request)) => request,
        Err(error) if error.status() == StatusCode::PAYLOAD_TOO_LARGE => {
            return public_error_response(
                &request_id,
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "The request body is too large.",
            );
        }
        Err(_) => {
            return public_error_response(
                &request_id,
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "The request contains an invalid field.",
            );
        }
    };
    if state.auth.validate_origin(&headers).is_err() {
        return AuthError::CsrfRejected.into_response(&request_id);
    }
    if !state.auth.login_allowed().await {
        return AuthError::RateLimited.into_response(&request_id);
    }
    if !state.auth.token_matches(&request.token) {
        state.auth.record_failure().await;
        return AuthError::InvalidCredentials.into_response(&request_id);
    }

    match state.auth.issue_session(request.remember_me) {
        Ok((session, _csrf)) => match state.auth.set_cookie(&session, request.remember_me) {
            Ok(cookie) => (StatusCode::NO_CONTENT, [(header::SET_COOKIE, cookie)]).into_response(),
            Err(error) => error.into_response(&request_id),
        },
        Err(error) => error.into_response(&request_id),
    }
}

pub async fn require_session(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    match state.auth.session_from_headers(request.headers()) {
        Ok(claims) => {
            request.extensions_mut().insert(SessionIdentity {
                nonce: claims.nonce,
            });
            next.run(request).await
        }
        Err(error) => {
            let request_id = request
                .extensions()
                .get::<RequestId>()
                .expect("request context middleware must install a request ID");
            error.into_response(request_id)
        }
    }
}

pub async fn require_mutation(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let result = (|| {
        state.auth.validate_origin(request.headers())?;
        let claims = state.auth.session_from_headers(request.headers())?;
        let supplied_csrf = request
            .headers()
            .get("x-csrf-token")
            .and_then(|value| value.to_str().ok())
            .ok_or(AuthError::CsrfRejected)?;
        let expected_csrf = state.auth.csrf_token(&claims.nonce)?;
        if !bool::from(supplied_csrf.as_bytes().ct_eq(expected_csrf.as_bytes())) {
            return Err(AuthError::CsrfRejected);
        }
        Ok(SessionIdentity {
            nonce: claims.nonce,
        })
    })();

    match result {
        Ok(identity) => {
            request.extensions_mut().insert(identity);
            next.run(request).await
        }
        Err(error) => {
            let request_id = request
                .extensions()
                .get::<RequestId>()
                .expect("request context middleware must install a request ID");
            error.into_response(request_id)
        }
    }
}

pub async fn get_session(
    State(state): State<AppState>,
    Extension(identity): Extension<SessionIdentity>,
    Extension(request_id): Extension<RequestId>,
) -> Response {
    match state.auth.csrf_token(&identity.nonce) {
        Ok(csrf_token) => Json(SessionResponse {
            authenticated: true,
            csrf_token,
        })
        .into_response(),
        Err(error) => error.into_response(&request_id),
    }
}

pub async fn logout(
    State(state): State<AppState>,
    Extension(request_id): Extension<RequestId>,
) -> Response {
    match state.auth.clear_cookie() {
        Ok(cookie) => (StatusCode::NO_CONTENT, [(header::SET_COOKIE, cookie)]).into_response(),
        Err(error) => error.into_response(&request_id),
    }
}

#[derive(Debug)]
enum AuthError {
    Unauthorized,
    InvalidCredentials,
    RateLimited,
    CsrfRejected,
    InvalidSession,
    Clock,
}

impl AuthError {
    fn into_response(self, request_id: &RequestId) -> Response {
        let (status, code, message) = match self {
            Self::Unauthorized | Self::InvalidSession => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Authentication is required.",
            ),
            Self::InvalidCredentials => (
                StatusCode::UNAUTHORIZED,
                "invalid_credentials",
                "The access token is invalid.",
            ),
            Self::RateLimited => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "Too many authentication attempts. Try again shortly.",
            ),
            Self::CsrfRejected => (
                StatusCode::FORBIDDEN,
                "csrf_rejected",
                "The request origin could not be verified.",
            ),
            Self::Clock => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "The request could not be completed.",
            ),
        };
        public_error_response(request_id, status, code, message)
    }
}

fn unix_seconds() -> Result<u64, AuthError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| AuthError::Clock)
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue, header};
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

    use super::{AuthService, SessionClaims};

    fn service(token: &str) -> AuthService {
        AuthService::new(token, "https://chat.example.com".to_owned(), true)
    }

    #[test]
    fn token_comparison_accepts_only_the_configured_value() {
        let auth = service("01234567890123456789012345678901");

        assert!(auth.token_matches("01234567890123456789012345678901"));
        assert!(!auth.token_matches("01234567890123456789012345678900"));
        assert!(!auth.token_matches(""));
    }

    #[test]
    fn rotating_access_token_invalidates_existing_session() {
        let original = service("01234567890123456789012345678901");
        let rotated = service("abcdefghijklmnopqrstuvwxyzABCDEF");
        let (session, _) = original
            .issue_session(false)
            .expect("session should be issued");

        assert!(original.verify_session(&session).is_ok());
        assert!(rotated.verify_session(&session).is_err());
    }

    #[test]
    fn expired_session_is_rejected() {
        let auth = service("01234567890123456789012345678901");
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&SessionClaims {
                version: 1,
                issued_at: 0,
                expires_at: 1,
                nonce: "expired".to_owned(),
            })
            .expect("claims should serialize"),
        );
        let signature = auth
            .sign(payload.as_bytes())
            .expect("claims should be signed");

        assert!(
            auth.verify_session(&format!("{payload}.{signature}"))
                .is_err()
        );
    }

    #[test]
    fn remembered_cookie_has_required_security_attributes() {
        let auth = service("01234567890123456789012345678901");
        let (session, _) = auth.issue_session(true).expect("session should be issued");
        let cookie = auth
            .set_cookie(&session, true)
            .expect("cookie should be valid")
            .to_str()
            .expect("cookie should be text")
            .to_owned();

        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Strict"));
        assert!(cookie.contains("Secure"));
        assert!(cookie.contains("Max-Age=2592000"));
    }

    #[test]
    fn browser_session_cookie_omits_max_age() {
        let auth = service("01234567890123456789012345678901");
        let (session, _) = auth.issue_session(false).expect("session should be issued");
        let cookie = auth
            .set_cookie(&session, false)
            .expect("cookie should be valid")
            .to_str()
            .expect("cookie should be text")
            .to_owned();

        assert!(!cookie.contains("Max-Age"));
    }

    #[test]
    fn origin_validation_requires_exact_configured_origin() {
        let auth = service("01234567890123456789012345678901");
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://chat.example.com"),
        );
        assert!(auth.validate_origin(&headers).is_ok());

        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://attacker.example"),
        );
        assert!(auth.validate_origin(&headers).is_err());
    }

    #[tokio::test]
    async fn repeated_failures_are_rate_limited() {
        let auth = service("01234567890123456789012345678901");
        for _ in 0..5 {
            assert!(auth.login_allowed().await);
            auth.record_failure().await;
        }
        assert!(!auth.login_allowed().await);
    }
}

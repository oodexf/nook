use std::{env, fmt, net::SocketAddr, str::FromStr, time::Duration};

use crate::provider::ProviderBaseUrl;

const DEFAULT_BIND: &str = "0.0.0.0:8080";
const DEFAULT_AI_REQUEST_TIMEOUT_SECS: u64 = 30;
const DEFAULT_MAX_MESSAGE_CHARS: usize = 32_000;
const DEFAULT_MAX_CONTEXT_MESSAGES: usize = 100;
const DEFAULT_MAX_CONTEXT_CHARS: usize = 200_000;
const DEFAULT_MAX_ACTIVE_GENERATIONS: usize = 4;
const DEFAULT_MODEL_CACHE_TTL_SECS: u64 = 60;
const MIN_ACCESS_TOKEN_BYTES: usize = 32;
const INSECURE_TEST_TOKEN_FLAG: &str = "APP_ALLOW_INSECURE_TEST_TOKEN";
const INSECURE_TEST_TOKEN: &str = "test";

#[derive(Clone)]
pub struct AppConfig {
    pub bind: SocketAddr,
    pub app_origin: String,
    pub cookie_secure: bool,
    pub access_token: String,
    pub database_path: String,
    pub ai_base_url: ProviderBaseUrl,
    pub ai_api_key: String,
    pub ai_default_model: String,
    pub ai_request_timeout: Duration,
    pub model_cache_ttl: Duration,
    pub max_message_chars: usize,
    pub max_context_messages: usize,
    pub max_context_chars: usize,
    pub max_active_generations: usize,
}

impl AppConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|key| env::var(key).ok())
    }

    pub(crate) fn from_lookup(
        mut lookup: impl FnMut(&str) -> Option<String>,
    ) -> Result<Self, ConfigError> {
        let bind_value = lookup("APP_BIND").unwrap_or_else(|| DEFAULT_BIND.to_owned());
        let bind = SocketAddr::from_str(&bind_value)
            .map_err(|_| ConfigError::InvalidBind(bind_value.clone()))?;
        let allow_insecure_test_token =
            optional_bool(&mut lookup, INSECURE_TEST_TOKEN_FLAG, false)?;
        let access_token = required(&mut lookup, "APP_ACCESS_TOKEN")?;
        let is_explicit_test_token =
            allow_insecure_test_token && access_token == INSECURE_TEST_TOKEN;
        if access_token.len() < MIN_ACCESS_TOKEN_BYTES && !is_explicit_test_token {
            return Err(ConfigError::WeakAccessToken);
        }

        let database_path = match lookup("DATABASE_PATH") {
            Some(value) => {
                let value = value.trim();
                if value.is_empty() || value == ":memory:" {
                    return Err(ConfigError::InvalidDatabasePath);
                }
                value.to_owned()
            }
            None => "/data/chat.db".to_owned(),
        };

        Ok(Self {
            bind,
            app_origin: required(&mut lookup, "APP_ORIGIN")?
                .trim_end_matches('/')
                .to_owned(),
            cookie_secure: optional_bool(&mut lookup, "APP_COOKIE_SECURE", true)?,
            access_token,
            database_path,
            ai_base_url: ProviderBaseUrl::parse(&required(&mut lookup, "AI_BASE_URL")?)
                .map_err(|_| ConfigError::InvalidAiBaseUrl)?,
            ai_api_key: required(&mut lookup, "AI_API_KEY")?,
            ai_default_model: required(&mut lookup, "AI_DEFAULT_MODEL")?,
            ai_request_timeout: Duration::from_secs(optional_positive_u64(
                &mut lookup,
                "AI_REQUEST_TIMEOUT_SECS",
                DEFAULT_AI_REQUEST_TIMEOUT_SECS,
            )?),
            model_cache_ttl: Duration::from_secs(optional_positive_u64(
                &mut lookup,
                "MODEL_CACHE_TTL_SECS",
                DEFAULT_MODEL_CACHE_TTL_SECS,
            )?),
            max_message_chars: optional_positive_usize(
                &mut lookup,
                "MAX_MESSAGE_CHARS",
                DEFAULT_MAX_MESSAGE_CHARS,
            )?,
            max_context_messages: optional_positive_usize(
                &mut lookup,
                "MAX_CONTEXT_MESSAGES",
                DEFAULT_MAX_CONTEXT_MESSAGES,
            )?,
            max_context_chars: optional_positive_usize(
                &mut lookup,
                "MAX_CONTEXT_CHARS",
                DEFAULT_MAX_CONTEXT_CHARS,
            )?,
            max_active_generations: optional_positive_usize(
                &mut lookup,
                "MAX_ACTIVE_GENERATIONS",
                DEFAULT_MAX_ACTIVE_GENERATIONS,
            )?,
        })
    }

    #[must_use]
    pub fn is_ready(&self) -> bool {
        !self.access_token.is_empty()
            && !self.ai_api_key.is_empty()
            && !self.ai_default_model.is_empty()
    }
}

fn optional_positive_usize(
    lookup: &mut impl FnMut(&str) -> Option<String>,
    key: &'static str,
    default: usize,
) -> Result<usize, ConfigError> {
    match lookup(key) {
        None => Ok(default),
        Some(value) => value
            .parse::<usize>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or(ConfigError::InvalidPositiveInteger(key)),
    }
}

fn optional_positive_u64(
    lookup: &mut impl FnMut(&str) -> Option<String>,
    key: &'static str,
    default: u64,
) -> Result<u64, ConfigError> {
    match lookup(key) {
        None => Ok(default),
        Some(value) => value
            .parse::<u64>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or(ConfigError::InvalidPositiveInteger(key)),
    }
}

fn optional_bool(
    lookup: &mut impl FnMut(&str) -> Option<String>,
    key: &'static str,
    default: bool,
) -> Result<bool, ConfigError> {
    match lookup(key).as_deref() {
        None => Ok(default),
        Some("true") => Ok(true),
        Some("false") => Ok(false),
        Some(_) => Err(ConfigError::InvalidBoolean(key)),
    }
}

fn required(
    lookup: &mut impl FnMut(&str) -> Option<String>,
    key: &'static str,
) -> Result<String, ConfigError> {
    lookup(key)
        .filter(|value| !value.trim().is_empty())
        .ok_or(ConfigError::Missing(key))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    Missing(&'static str),
    InvalidBind(String),
    InvalidBoolean(&'static str),
    InvalidPositiveInteger(&'static str),
    InvalidAiBaseUrl,
    InvalidDatabasePath,
    WeakAccessToken,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing(key) => {
                write!(formatter, "required environment variable {key} is missing")
            }
            Self::InvalidBind(value) => {
                write!(formatter, "APP_BIND is not a valid socket address: {value}")
            }
            Self::InvalidBoolean(key) => write!(formatter, "{key} must be true or false"),
            Self::InvalidPositiveInteger(key) => {
                write!(formatter, "{key} must be a positive integer")
            }
            Self::InvalidAiBaseUrl => formatter.write_str(
                "AI_BASE_URL must be HTTPS (or loopback HTTP), contain no credentials/query/fragment, and use an optional single /v1 suffix",
            ),
            Self::InvalidDatabasePath => {
                formatter.write_str("DATABASE_PATH must be a non-empty persistent filesystem path")
            }
            Self::WeakAccessToken => write!(
                formatter,
                "APP_ACCESS_TOKEN must contain at least {MIN_ACCESS_TOKEN_BYTES} bytes (except for the exact local test token when {INSECURE_TEST_TOKEN_FLAG}=true)"
            ),
        }
    }
}

impl std::error::Error for ConfigError {}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{AppConfig, ConfigError};

    fn valid_values() -> HashMap<&'static str, String> {
        HashMap::from([
            ("APP_ACCESS_TOKEN", "a".repeat(32)),
            ("APP_ORIGIN", "https://chat.example.com".to_owned()),
            ("AI_BASE_URL", "https://api.example.com/v1".to_owned()),
            ("AI_API_KEY", "test-provider-key".to_owned()),
            ("AI_DEFAULT_MODEL", "test-model".to_owned()),
        ])
    }

    #[test]
    fn applies_default_bind_and_accepts_valid_configuration() {
        let values = valid_values();
        let config = AppConfig::from_lookup(|key| values.get(key).cloned())
            .expect("valid configuration should parse");

        assert_eq!(config.bind.to_string(), "0.0.0.0:8080");
        assert_eq!(config.database_path, "/data/chat.db");
        assert_eq!(
            config.ai_request_timeout,
            std::time::Duration::from_secs(30)
        );
        assert_eq!(config.model_cache_ttl, std::time::Duration::from_mins(1));
        assert!(config.is_ready());
    }

    #[test]
    fn rejects_unsafe_provider_urls_and_invalid_positive_durations() {
        for invalid_url in [
            "ftp://api.example.com/v1",
            "http://api.example.com/v1",
            "https://user:secret@api.example.com/v1",
            "https://api.example.com/v1/models",
            "https://api.example.com/v1/v1",
            "https://api.example.com/v1?secret=value",
            "https://api.example.com/#fragment",
        ] {
            let mut values = valid_values();
            values.insert("AI_BASE_URL", invalid_url.to_owned());
            let Err(error) = AppConfig::from_lookup(|key| values.get(key).cloned()) else {
                panic!("unsafe provider URL should fail");
            };
            assert_eq!(error, ConfigError::InvalidAiBaseUrl);
        }

        for (key, value) in [
            ("AI_REQUEST_TIMEOUT_SECS", "0"),
            ("MODEL_CACHE_TTL_SECS", "not-a-number"),
        ] {
            let mut values = valid_values();
            values.insert(key, value.to_owned());
            let Err(error) = AppConfig::from_lookup(|name| values.get(name).cloned()) else {
                panic!("invalid duration should fail");
            };
            assert_eq!(error, ConfigError::InvalidPositiveInteger(key));
        }
    }

    #[test]
    fn rejects_blank_database_path_and_trims_supplied_path() {
        let mut blank_values = valid_values();
        blank_values.insert("DATABASE_PATH", "  \t ".to_owned());

        let Err(error) = AppConfig::from_lookup(|key| blank_values.get(key).cloned()) else {
            panic!("blank database path should fail");
        };
        assert_eq!(error, ConfigError::InvalidDatabasePath);

        let mut memory_values = valid_values();
        memory_values.insert("DATABASE_PATH", ":memory:".to_owned());
        let Err(error) = AppConfig::from_lookup(|key| memory_values.get(key).cloned()) else {
            panic!("in-memory database path should fail");
        };
        assert_eq!(error, ConfigError::InvalidDatabasePath);

        let mut path_values = valid_values();
        path_values.insert("DATABASE_PATH", "  ./var/chat.db  ".to_owned());
        let config = AppConfig::from_lookup(|key| path_values.get(key).cloned())
            .expect("relative local database path should parse");
        assert_eq!(config.database_path, "./var/chat.db");
    }

    #[test]
    fn rejects_missing_secret_without_exposing_values() {
        let mut values = valid_values();
        values.remove("AI_API_KEY");

        let Err(error) = AppConfig::from_lookup(|key| values.get(key).cloned()) else {
            panic!("missing provider key should fail");
        };

        assert_eq!(error, ConfigError::Missing("AI_API_KEY"));
        assert_eq!(
            error.to_string(),
            "required environment variable AI_API_KEY is missing"
        );
    }

    #[test]
    fn rejects_short_access_token() {
        let mut values = valid_values();
        values.insert("APP_ACCESS_TOKEN", "too-short".to_owned());

        let Err(error) = AppConfig::from_lookup(|key| values.get(key).cloned()) else {
            panic!("short access token should fail");
        };

        assert_eq!(error, ConfigError::WeakAccessToken);
    }

    #[test]
    fn allows_exact_short_test_token_only_with_explicit_test_flag() {
        let mut values = valid_values();
        values.insert("APP_ACCESS_TOKEN", "test".to_owned());
        values.insert("APP_ALLOW_INSECURE_TEST_TOKEN", "true".to_owned());

        let config = AppConfig::from_lookup(|key| values.get(key).cloned())
            .expect("explicit local test override should allow the shared test token");

        assert_eq!(config.access_token, "test");
    }

    #[test]
    fn rejects_other_short_tokens_with_test_flag() {
        let mut values = valid_values();
        values.insert("APP_ACCESS_TOKEN", "still-too-short".to_owned());
        values.insert("APP_ALLOW_INSECURE_TEST_TOKEN", "true".to_owned());

        let Err(error) = AppConfig::from_lookup(|key| values.get(key).cloned()) else {
            panic!("test override must not disable validation for arbitrary tokens");
        };

        assert_eq!(error, ConfigError::WeakAccessToken);
    }

    #[test]
    fn rejects_invalid_bind_address() {
        let mut values = valid_values();
        values.insert("APP_BIND", "localhost:not-a-port".to_owned());

        let Err(error) = AppConfig::from_lookup(|key| values.get(key).cloned()) else {
            panic!("invalid bind should fail");
        };

        assert_eq!(
            error,
            ConfigError::InvalidBind("localhost:not-a-port".to_owned())
        );
    }
}

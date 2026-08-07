use std::{env, fmt, net::SocketAddr, str::FromStr};

const DEFAULT_BIND: &str = "0.0.0.0:8080";
const MIN_ACCESS_TOKEN_BYTES: usize = 32;

#[derive(Clone)]
pub struct AppConfig {
    pub bind: SocketAddr,
    pub access_token: String,
    pub ai_base_url: String,
    pub ai_api_key: String,
    pub ai_default_model: String,
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
        let access_token = required(&mut lookup, "APP_ACCESS_TOKEN")?;
        if access_token.len() < MIN_ACCESS_TOKEN_BYTES {
            return Err(ConfigError::WeakAccessToken);
        }

        Ok(Self {
            bind,
            access_token,
            ai_base_url: required(&mut lookup, "AI_BASE_URL")?,
            ai_api_key: required(&mut lookup, "AI_API_KEY")?,
            ai_default_model: required(&mut lookup, "AI_DEFAULT_MODEL")?,
        })
    }

    #[must_use]
    pub fn is_ready(&self) -> bool {
        !self.access_token.is_empty()
            && !self.ai_base_url.is_empty()
            && !self.ai_api_key.is_empty()
            && !self.ai_default_model.is_empty()
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
            Self::WeakAccessToken => write!(
                formatter,
                "APP_ACCESS_TOKEN must contain at least {MIN_ACCESS_TOKEN_BYTES} bytes"
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
        assert!(config.is_ready());
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

//! Normalized provider model catalog contracts.

use std::{fmt, future::Future, pin::Pin};

/// Maximum number of Unicode scalar values accepted in an opaque provider model ID.
pub const MAX_MODEL_ID_CHARS: usize = 200;
/// Maximum number of upstream rows processed from one bounded response.
pub const MAX_MODEL_CATALOG_ROWS: usize = 10_000;

/// One normalized, provider-owned model identifier.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelCatalogEntry {
    pub id: String,
}

/// A deterministic model catalog fetched at a point in time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelCatalog {
    pub models: Vec<ModelCatalogEntry>,
    pub refreshed_at: i64,
}

impl ModelCatalog {
    /// Filters malformed IDs, trims surrounding whitespace, removes exact
    /// duplicates, and sorts the remaining IDs.
    ///
    /// # Errors
    ///
    /// Returns [`ModelCatalogError::EmptyCatalog`] when no usable ID remains.
    pub fn normalize(
        provider_ids: impl IntoIterator<Item = String>,
        refreshed_at: i64,
    ) -> Result<Self, ModelCatalogError> {
        let mut ids: Vec<String> = provider_ids
            .into_iter()
            .take(MAX_MODEL_CATALOG_ROWS)
            .filter_map(|id| normalize_model_id(&id))
            .collect();
        ids.sort();
        ids.dedup();
        if ids.is_empty() {
            return Err(ModelCatalogError::EmptyCatalog);
        }

        Ok(Self {
            models: ids.into_iter().map(|id| ModelCatalogEntry { id }).collect(),
            refreshed_at,
        })
    }

    #[must_use]
    pub fn contains_exact(&self, model_id: &str) -> bool {
        self.models
            .binary_search_by(|model| model.id.as_str().cmp(model_id))
            .is_ok()
    }
}

/// Validates an operator or client selected model without normalization or
/// fallback. This is reusable by the Phase E generation service.
///
/// # Errors
///
/// Returns [`ModelAvailabilityError::Unavailable`] unless the ID is already
/// valid and exactly present in the normalized catalog.
pub fn validate_model_available(
    catalog: &ModelCatalog,
    model_id: &str,
) -> Result<(), ModelAvailabilityError> {
    if valid_exact_model_id(model_id) && catalog.contains_exact(model_id) {
        Ok(())
    } else {
        Err(ModelAvailabilityError::Unavailable)
    }
}

#[must_use]
pub fn valid_exact_model_id(model_id: &str) -> bool {
    normalize_model_id(model_id).is_some_and(|normalized| normalized == model_id)
}

fn normalize_model_id(model_id: &str) -> Option<String> {
    if model_id.chars().any(char::is_control) {
        return None;
    }
    let trimmed = model_id.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_MODEL_ID_CHARS {
        return None;
    }
    Some(trimmed.to_owned())
}

/// Safe, stable model-provider failure categories. Raw provider bodies,
/// headers, URLs, and transport errors are intentionally not retained.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelCatalogError {
    Unauthorized,
    RateLimited,
    Timeout,
    Unavailable,
    InvalidResponse,
    EmptyCatalog,
    DefaultModelMissing,
}

impl ModelCatalogError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Unauthorized => "model_provider_unauthorized",
            Self::RateLimited => "model_provider_rate_limited",
            Self::Timeout => "model_provider_timeout",
            Self::Unavailable => "model_provider_unavailable",
            Self::InvalidResponse => "model_provider_invalid_response",
            Self::EmptyCatalog => "model_catalog_empty",
            Self::DefaultModelMissing => "model_default_missing",
        }
    }

    #[must_use]
    pub const fn safe_message(self) -> &'static str {
        match self {
            Self::Unauthorized => "The model provider rejected its configured credentials.",
            Self::RateLimited => "The model provider is rate limiting model discovery.",
            Self::Timeout => "Model discovery timed out.",
            Self::Unavailable => "The model provider is temporarily unavailable.",
            Self::InvalidResponse => "The model provider returned an invalid model catalog.",
            Self::EmptyCatalog => "The model provider returned no usable models.",
            Self::DefaultModelMissing => {
                "The configured default model is not available from the provider."
            }
        }
    }
}

impl fmt::Display for ModelCatalogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.safe_message())
    }
}

impl std::error::Error for ModelCatalogError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelAvailabilityError {
    Unavailable,
}

impl fmt::Display for ModelAvailabilityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("the selected model is unavailable")
    }
}

impl std::error::Error for ModelAvailabilityError {}

/// Provider-facing catalog boundary. Provider wire DTOs stay in the adapter.
pub trait ModelCatalogProvider: Send + Sync {
    fn fetch_model_ids(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>, ModelCatalogError>> + Send + '_>>;
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_MODEL_ID_CHARS, ModelAvailabilityError, ModelCatalog, ModelCatalogError,
        valid_exact_model_id, validate_model_available,
    };

    #[test]
    fn normalization_filters_trims_deduplicates_and_sorts() {
        let catalog = ModelCatalog::normalize(
            [
                " z-model ".to_owned(),
                "a-model".to_owned(),
                "a-model".to_owned(),
                "contains\ncontrol".to_owned(),
                " ".to_owned(),
                "x".repeat(MAX_MODEL_ID_CHARS + 1),
            ],
            42,
        )
        .expect("at least one model is valid");

        let ids: Vec<&str> = catalog
            .models
            .iter()
            .map(|model| model.id.as_str())
            .collect();
        assert_eq!(ids, ["a-model", "z-model"]);
        assert_eq!(catalog.refreshed_at, 42);
    }

    #[test]
    fn fully_malformed_or_empty_catalog_is_an_error() {
        assert_eq!(
            ModelCatalog::normalize(Vec::<String>::new(), 0),
            Err(ModelCatalogError::EmptyCatalog)
        );
        assert_eq!(
            ModelCatalog::normalize(["\n".to_owned(), "x".repeat(201)], 0),
            Err(ModelCatalogError::EmptyCatalog)
        );
    }

    #[test]
    fn model_availability_is_exact_and_never_substitutes() {
        let catalog =
            ModelCatalog::normalize(["model-a".to_owned()], 0).expect("catalog should normalize");
        assert_eq!(validate_model_available(&catalog, "model-a"), Ok(()));
        assert_eq!(
            validate_model_available(&catalog, " model-a "),
            Err(ModelAvailabilityError::Unavailable)
        );
        assert_eq!(
            validate_model_available(&catalog, "removed-model"),
            Err(ModelAvailabilityError::Unavailable)
        );
        assert!(valid_exact_model_id("model-a"));
        assert!(!valid_exact_model_id(" model-a "));
    }

    #[test]
    fn provider_error_text_is_stable_and_safe() {
        assert_eq!(
            ModelCatalogError::Unauthorized.to_string(),
            "The model provider rejected its configured credentials."
        );
        assert!(
            !ModelCatalogError::InvalidResponse
                .to_string()
                .contains("raw-body-sentinel")
        );
    }
}

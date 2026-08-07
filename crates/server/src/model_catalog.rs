use std::{sync::Arc, time::Duration};

use chat_core::model::{
    ModelCatalog, ModelCatalogError, ModelCatalogProvider, validate_model_available,
};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct ModelCatalogService {
    provider: Arc<dyn ModelCatalogProvider>,
    default_model: String,
    ttl: Duration,
    state: Arc<Mutex<CacheState>>,
}

#[derive(Default)]
struct CacheState {
    cached: Option<CachedCatalog>,
}

#[derive(Clone)]
struct CachedCatalog {
    catalog: ModelCatalog,
    loaded_at: tokio::time::Instant,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogSnapshot {
    pub catalog: ModelCatalog,
    pub default_model: String,
    pub stale: bool,
    pub refresh_error: Option<ModelCatalogError>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CachePolicy {
    UseFresh,
    Refresh,
}

impl ModelCatalogService {
    #[must_use]
    pub fn new(
        provider: Arc<dyn ModelCatalogProvider>,
        default_model: String,
        ttl: Duration,
    ) -> Self {
        Self {
            provider,
            default_model,
            ttl,
            state: Arc::new(Mutex::new(CacheState::default())),
        }
    }

    /// Retrieves a normalized catalog. The mutex intentionally spans provider
    /// I/O so concurrent misses collapse into one request. No database lock or
    /// transaction is held.
    pub async fn get(&self, policy: CachePolicy) -> Result<CatalogSnapshot, ModelCatalogError> {
        let mut state = self.state.lock().await;
        if policy == CachePolicy::UseFresh
            && let Some(cached) = state.cached.as_ref()
            && cached.loaded_at.elapsed() < self.ttl
        {
            return self.snapshot(cached.catalog.clone(), false, None);
        }

        let refresh_result = self.refresh_provider().await;
        match refresh_result {
            Ok(catalog) => match self.snapshot(catalog.clone(), false, None) {
                Ok(snapshot) => {
                    state.cached = Some(CachedCatalog {
                        catalog,
                        loaded_at: tokio::time::Instant::now(),
                    });
                    Ok(snapshot)
                }
                Err(error) => state.cached.as_ref().map_or(Err(error), |cached| {
                    self.snapshot(cached.catalog.clone(), true, Some(error))
                }),
            },
            Err(error) => state.cached.as_ref().map_or(Err(error), |cached| {
                self.snapshot(cached.catalog.clone(), true, Some(error))
            }),
        }
    }

    /// Reusable Phase E boundary: validates a selected or locked model against
    /// the current catalog without changing historical conversation reads.
    pub async fn validate_available(&self, model_id: &str) -> Result<(), ModelCatalogError> {
        let snapshot = self.get(CachePolicy::UseFresh).await?;
        validate_model_available(&snapshot.catalog, model_id)
            .map_err(|_| ModelCatalogError::Unavailable)
    }

    async fn refresh_provider(&self) -> Result<ModelCatalog, ModelCatalogError> {
        let provider_ids = self.provider.fetch_model_ids().await?;
        ModelCatalog::normalize(provider_ids, unix_milliseconds()?)
    }

    fn snapshot(
        &self,
        catalog: ModelCatalog,
        stale: bool,
        refresh_error: Option<ModelCatalogError>,
    ) -> Result<CatalogSnapshot, ModelCatalogError> {
        validate_model_available(&catalog, &self.default_model)
            .map_err(|_| ModelCatalogError::DefaultModelMissing)?;
        Ok(CatalogSnapshot {
            catalog,
            default_model: self.default_model.clone(),
            stale,
            refresh_error,
        })
    }
}

fn unix_milliseconds() -> Result<i64, ModelCatalogError> {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| ModelCatalogError::Unavailable)?;
    i64::try_from(elapsed.as_millis()).map_err(|_| ModelCatalogError::Unavailable)
}

#[cfg(test)]
mod tests {
    use std::{
        future::Future,
        pin::Pin,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use chat_core::model::{ModelCatalogError, ModelCatalogProvider};
    use tokio::sync::Mutex;

    use super::{CachePolicy, ModelCatalogService};

    type ScriptResults = Arc<Mutex<Vec<Result<Vec<String>, ModelCatalogError>>>>;

    #[derive(Clone)]
    struct ScriptedProvider {
        calls: Arc<AtomicUsize>,
        results: ScriptResults,
        delay: Duration,
    }

    impl ModelCatalogProvider for ScriptedProvider {
        fn fetch_model_ids(
            &self,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<String>, ModelCatalogError>> + Send + '_>>
        {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(self.delay).await;
                self.results.lock().await.remove(0)
            })
        }
    }

    fn service(
        results: Vec<Result<Vec<String>, ModelCatalogError>>,
        ttl: Duration,
    ) -> (ModelCatalogService, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let provider = ScriptedProvider {
            calls: Arc::clone(&calls),
            results: Arc::new(Mutex::new(results)),
            delay: Duration::from_millis(20),
        };
        (
            ModelCatalogService::new(Arc::new(provider), "model-a".to_owned(), ttl),
            calls,
        )
    }

    #[tokio::test]
    async fn fresh_cache_collapses_concurrent_requests() {
        let (service, calls) =
            service(vec![Ok(vec!["model-a".to_owned()])], Duration::from_mins(1));
        let (left, right) = tokio::join!(
            service.get(CachePolicy::UseFresh),
            service.get(CachePolicy::UseFresh)
        );
        assert!(!left.expect("first fetch should succeed").stale);
        assert!(!right.expect("second fetch should use cache").stale);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn explicit_refresh_bypasses_fresh_cache() {
        let (service, calls) = service(
            vec![
                Ok(vec!["model-a".to_owned()]),
                Ok(vec!["model-a".to_owned(), "model-b".to_owned()]),
            ],
            Duration::from_mins(1),
        );
        service
            .get(CachePolicy::UseFresh)
            .await
            .expect("initial fetch should succeed");
        let refreshed = service
            .get(CachePolicy::Refresh)
            .await
            .expect("refresh should succeed");
        assert_eq!(refreshed.catalog.models.len(), 2);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn failed_refresh_returns_stale_catalog_and_safe_metadata() {
        let (service, _) = service(
            vec![
                Ok(vec!["model-a".to_owned()]),
                Err(ModelCatalogError::RateLimited),
            ],
            Duration::from_mins(1),
        );
        service
            .get(CachePolicy::UseFresh)
            .await
            .expect("initial fetch should succeed");
        let stale = service
            .get(CachePolicy::Refresh)
            .await
            .expect("stale catalog should be returned");
        assert!(stale.stale);
        assert_eq!(stale.refresh_error, Some(ModelCatalogError::RateLimited));
        assert_eq!(stale.catalog.models[0].id, "model-a");
    }

    #[tokio::test]
    async fn missing_default_is_a_blocking_error_without_substitution() {
        let (service, _) = service(
            vec![Ok(vec!["different-model".to_owned()])],
            Duration::from_mins(1),
        );
        assert_eq!(
            service.get(CachePolicy::UseFresh).await,
            Err(ModelCatalogError::DefaultModelMissing)
        );
    }

    #[tokio::test]
    async fn missing_default_after_refresh_preserves_stale_valid_catalog() {
        let (service, _) = service(
            vec![
                Ok(vec!["model-a".to_owned()]),
                Ok(vec!["different-model".to_owned()]),
            ],
            Duration::from_mins(1),
        );
        service
            .get(CachePolicy::UseFresh)
            .await
            .expect("initial valid default should load");
        let stale = service
            .get(CachePolicy::Refresh)
            .await
            .expect("valid cached catalog should remain available");
        assert!(stale.stale);
        assert_eq!(
            stale.refresh_error,
            Some(ModelCatalogError::DefaultModelMissing)
        );
        assert_eq!(stale.catalog.models[0].id, "model-a");
    }

    #[tokio::test]
    async fn expired_cache_refreshes_and_falls_back_stale() {
        let (service, calls) = service(
            vec![
                Ok(vec!["model-a".to_owned()]),
                Err(ModelCatalogError::Unavailable),
            ],
            Duration::from_millis(1),
        );
        service
            .get(CachePolicy::UseFresh)
            .await
            .expect("initial fetch should succeed");
        tokio::time::sleep(Duration::from_millis(5)).await;
        let stale = service
            .get(CachePolicy::UseFresh)
            .await
            .expect("stale fallback should succeed");
        assert!(stale.stale);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}

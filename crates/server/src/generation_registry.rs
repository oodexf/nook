use std::{collections::HashMap, sync::Arc};

use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct GenerationRegistry {
    entries: Arc<Mutex<HashMap<String, Entry>>>,
    capacity: Arc<Semaphore>,
}

struct Entry {
    conversation_id: String,
    token: CancellationToken,
    _permit: OwnedSemaphorePermit,
}

pub struct Registration {
    registry: GenerationRegistry,
    generation_id: String,
    pub token: CancellationToken,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegisterError {
    Capacity,
    ConversationActive,
}

impl GenerationRegistry {
    #[must_use]
    pub fn new(max_active: usize) -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            capacity: Arc::new(Semaphore::new(max_active)),
        }
    }

    pub async fn register(
        &self,
        generation_id: String,
        conversation_id: String,
    ) -> Result<Registration, RegisterError> {
        let permit = Arc::clone(&self.capacity)
            .try_acquire_owned()
            .map_err(|_| RegisterError::Capacity)?;
        let mut entries = self.entries.lock().await;
        if entries
            .values()
            .any(|entry| entry.conversation_id == conversation_id)
        {
            return Err(RegisterError::ConversationActive);
        }
        let token = CancellationToken::new();
        entries.insert(
            generation_id.clone(),
            Entry {
                conversation_id,
                token: token.clone(),
                _permit: permit,
            },
        );
        Ok(Registration {
            registry: self.clone(),
            generation_id,
            token,
        })
    }

    pub async fn cancel(&self, generation_id: &str) -> bool {
        let entries = self.entries.lock().await;
        entries.get(generation_id).is_some_and(|entry| {
            entry.token.cancel();
            true
        })
    }

    pub async fn cancel_all(&self) {
        let entries = self.entries.lock().await;
        for entry in entries.values() {
            entry.token.cancel();
        }
    }

    pub async fn active_count(&self) -> usize {
        self.entries.lock().await.len()
    }

    async fn remove(&self, generation_id: &str) {
        self.entries.lock().await.remove(generation_id);
    }
}

impl Registration {
    pub async fn finish(mut self) {
        self.registry.remove(&self.generation_id).await;
        self.generation_id.clear();
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        if !self.generation_id.is_empty() {
            self.token.cancel();
            let registry = self.registry.clone();
            let generation_id = self.generation_id.clone();
            tokio::spawn(async move {
                registry.remove(&generation_id).await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{GenerationRegistry, RegisterError};

    #[tokio::test]
    async fn enforces_capacity_conversation_exclusivity_and_cancel_idempotency() {
        let registry = GenerationRegistry::new(2);
        let first = registry
            .register("g1".to_owned(), "c1".to_owned())
            .await
            .expect("first should register");
        assert!(matches!(
            registry.register("g2".to_owned(), "c1".to_owned()).await,
            Err(RegisterError::ConversationActive)
        ));
        let second = registry
            .register("g2".to_owned(), "c2".to_owned())
            .await
            .expect("second should register");
        assert!(matches!(
            registry.register("g3".to_owned(), "c3".to_owned()).await,
            Err(RegisterError::Capacity)
        ));
        assert!(registry.cancel("g1").await);
        assert!(registry.cancel("g1").await);
        assert!(first.token.is_cancelled());
        assert_eq!(registry.active_count().await, 2);
        registry.cancel_all().await;
        assert!(second.token.is_cancelled());
        first.finish().await;
        second.finish().await;
        assert_eq!(registry.active_count().await, 0);
    }
}

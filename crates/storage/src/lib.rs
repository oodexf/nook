//! SQLite-backed repositories for `NooK` (栖语).

mod connection;
mod conversation_repository;
mod generation_repository;
mod migration;

use std::{
    fmt,
    path::{Path, PathBuf},
    sync::Arc,
};

use chat_core::conversation::{Conversation, ConversationDetail};
use chat_core::generation::GenerationResult;
use chat_core::repository::{
    ConversationCursor, ConversationPage, ConversationRepository, GenerationFinalization,
    GenerationRepository, GenerationSetup, NewConversation, NewMessageGeneration, RepositoryError,
    RepositoryErrorKind, RetryGeneration, StorageHealth,
};

#[derive(Clone)]
pub struct SqliteStorage {
    path: Arc<PathBuf>,
}

impl SqliteStorage {
    /// Opens the database, applies all pending migrations, and repairs unfinished work.
    ///
    /// # Errors
    /// Returns a typed storage error when the directory, connection, migration,
    /// or recovery operation fails.
    pub async fn initialize(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let path = path.as_ref().to_path_buf();
        let parent = path.parent().map(Path::to_path_buf);
        let migration_path = path.clone();
        run_blocking(move || {
            if migration_path.as_os_str() != ":memory:"
                && let Some(parent) = parent
            {
                std::fs::create_dir_all(parent)?;
            }
            let mut connection = connection::open(&migration_path)?;
            migration::apply(&mut connection)?;
            recover_unfinished(&mut connection)?;
            Ok(())
        })
        .await?;
        Ok(Self {
            path: Arc::new(path),
        })
    }

    /// Resolves an idempotency key to its existing logical conversation result.
    ///
    /// # Errors
    /// Returns a categorized repository error when storage cannot be queried or
    /// contains data that cannot be mapped to the domain.
    pub async fn find_by_client_message_id(
        &self,
        client_message_id: String,
    ) -> Result<Option<ConversationDetail>, RepositoryError> {
        self.with_connection(move |connection| {
            conversation_repository::find_by_client_message_id(connection, &client_message_id)
        })
        .await
    }

    /// Compatibility seam used by storage constraint tests: atomically inserts
    /// an assistant placeholder and generation for an existing conversation.
    ///
    /// # Errors
    /// Returns a categorized repository error on constraint or storage failure.
    pub async fn create_generation(
        &self,
        message: chat_core::conversation::Message,
        generation: chat_core::generation::Generation,
    ) -> Result<(), RepositoryError> {
        let path = Arc::clone(&self.path);
        run_blocking(move || {
            let mut connection = connection::open(&path)?;
            let transaction = connection.transaction()?;
            conversation_repository::insert_message_for_test(&transaction, &message)?;
            generation_repository::insert_generation_for_test(&transaction, &generation)?;
            transaction.commit()?;
            Ok(())
        })
        .await
        .map_err(RepositoryError::from)
    }

    /// Atomically creates or reconciles the logical result of a user message.
    ///
    /// # Errors
    /// Returns a categorized repository error on invalid state or storage failure.
    pub async fn create_message_generation(
        &self,
        setup: NewMessageGeneration,
    ) -> Result<GenerationSetup, RepositoryError> {
        let path = Arc::clone(&self.path);
        run_blocking(move || {
            let mut connection = connection::open(&path)?;
            generation_repository::create_message_generation(&mut connection, &setup)
        })
        .await
        .map_err(RepositoryError::from)
    }

    /// Atomically validates and creates a retry generation.
    ///
    /// # Errors
    /// Returns a categorized repository error when the source is ineligible.
    pub async fn create_retry_generation(
        &self,
        setup: RetryGeneration,
    ) -> Result<GenerationResult, RepositoryError> {
        let path = Arc::clone(&self.path);
        run_blocking(move || {
            let mut connection = connection::open(&path)?;
            generation_repository::create_retry_generation(&mut connection, &setup)
        })
        .await
        .map_err(RepositoryError::from)
    }

    /// Persists final/partial assistant content once when the generation is active.
    ///
    /// # Errors
    /// Returns a categorized repository error on storage failure.
    pub async fn finalize_generation(
        &self,
        finalization: GenerationFinalization,
    ) -> Result<bool, RepositoryError> {
        let path = Arc::clone(&self.path);
        run_blocking(move || {
            let mut connection = connection::open(&path)?;
            generation_repository::finalize_generation(&mut connection, &finalization)
        })
        .await
        .map_err(RepositoryError::from)
    }

    /// Creates a consistent `SQLite` backup using its online backup API.
    ///
    /// # Errors
    /// Returns a typed storage error when the destination cannot be prepared or
    /// `SQLite` cannot complete the backup. The destination must differ from the
    /// live database path and is replaced only after a complete backup succeeds.
    pub async fn backup(&self, destination: impl AsRef<Path>) -> Result<(), StorageError> {
        let source_path = self.path.as_ref().clone();
        let destination = destination.as_ref().to_path_buf();
        run_blocking(move || backup_database(&source_path, &destination)).await
    }

    async fn with_connection<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&rusqlite::Connection) -> Result<T, StorageError> + Send + 'static,
    ) -> Result<T, RepositoryError> {
        let path = Arc::clone(&self.path);
        run_blocking(move || {
            let connection = connection::open(&path)?;
            operation(&connection)
        })
        .await
        .map_err(RepositoryError::from)
    }
}

impl ConversationRepository for SqliteStorage {
    async fn list(
        &self,
        cursor: Option<ConversationCursor>,
        limit: u32,
    ) -> Result<ConversationPage, RepositoryError> {
        self.with_connection(move |connection| {
            conversation_repository::list(connection, cursor.as_ref(), limit)
        })
        .await
    }

    async fn get(&self, id: String) -> Result<ConversationDetail, RepositoryError> {
        self.with_connection(move |connection| conversation_repository::get(connection, &id))
            .await
    }

    async fn find_by_client_message_id(
        &self,
        client_message_id: String,
    ) -> Result<Option<ConversationDetail>, RepositoryError> {
        SqliteStorage::find_by_client_message_id(self, client_message_id).await
    }

    async fn find_assistant_message(
        &self,
        assistant_message_id: String,
    ) -> Result<ConversationDetail, RepositoryError> {
        self.with_connection(move |connection| {
            conversation_repository::find_assistant_message(connection, &assistant_message_id)
        })
        .await
    }

    async fn create(&self, conversation: NewConversation) -> Result<Conversation, RepositoryError> {
        self.with_connection(move |connection| {
            conversation_repository::create(connection, &conversation)
        })
        .await
    }

    async fn rename(
        &self,
        id: String,
        title: String,
        updated_at: i64,
    ) -> Result<Conversation, RepositoryError> {
        self.with_connection(move |connection| {
            conversation_repository::rename(connection, &id, &title, updated_at)
        })
        .await
    }

    async fn delete(&self, id: String) -> Result<(), RepositoryError> {
        self.with_connection(move |connection| conversation_repository::delete(connection, &id))
            .await
    }
}

impl GenerationRepository for SqliteStorage {
    async fn create_message_generation(
        &self,
        setup: NewMessageGeneration,
    ) -> Result<GenerationSetup, RepositoryError> {
        SqliteStorage::create_message_generation(self, setup).await
    }

    async fn create_retry_generation(
        &self,
        setup: RetryGeneration,
    ) -> Result<GenerationResult, RepositoryError> {
        SqliteStorage::create_retry_generation(self, setup).await
    }

    async fn get_generation(
        &self,
        generation_id: String,
    ) -> Result<GenerationResult, RepositoryError> {
        self.with_connection(move |connection| {
            generation_repository::get_generation(connection, &generation_id)
        })
        .await
    }

    async fn finalize_generation(
        &self,
        finalization: GenerationFinalization,
    ) -> Result<bool, RepositoryError> {
        SqliteStorage::finalize_generation(self, finalization).await
    }
}

impl StorageHealth for SqliteStorage {
    async fn check(&self) -> Result<(), RepositoryError> {
        self.with_connection(|connection| {
            connection.query_row("SELECT 1", [], |_| Ok(()))?;
            Ok(())
        })
        .await
    }
}

fn backup_database(source_path: &Path, destination: &Path) -> Result<(), StorageError> {
    if source_path == destination {
        return Err(StorageError::InvalidInput);
    }
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let temporary = destination.with_extension(format!("{}.tmp", backup_temp_suffix()));
    let result = (|| {
        let source = connection::open(source_path)?;
        let mut target = rusqlite::Connection::open(&temporary)?;
        {
            let backup = rusqlite::backup::Backup::new(&source, &mut target)?;
            backup.run_to_completion(128, std::time::Duration::from_millis(10), None)?;
        }
        target.close().map_err(|(_, error)| error)?;
        std::fs::rename(&temporary, destination)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn backup_temp_suffix() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        unix_milliseconds().unwrap_or_default()
    )
}

fn recover_unfinished(connection: &mut rusqlite::Connection) -> Result<(), StorageError> {
    let transaction = connection.transaction()?;
    let recovered_at = unix_milliseconds()?;
    transaction.execute(
        "UPDATE generations
         SET status = 'interrupted', finished_at = COALESCE(finished_at, ?1)
         WHERE status IN ('pending', 'streaming', 'cancelling')",
        [recovered_at],
    )?;
    transaction.execute(
        "UPDATE messages
         SET status = 'interrupted', error_code = 'generation_interrupted',
             finished_at = COALESCE(finished_at, ?1)
         WHERE role = 'assistant' AND status = 'streaming'",
        [recovered_at],
    )?;
    transaction.commit()?;
    Ok(())
}

fn unix_milliseconds() -> Result<i64, StorageError> {
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| StorageError::Clock)?;
    i64::try_from(duration.as_millis()).map_err(|_| StorageError::Clock)
}

async fn run_blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, StorageError> + Send + 'static,
) -> Result<T, StorageError> {
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(StorageError::Worker)?
}

#[derive(Debug)]
pub enum StorageError {
    Sqlite(rusqlite::Error),
    Io(std::io::Error),
    Worker(tokio::task::JoinError),
    UnsupportedSchema(i64),
    MigrationMismatch(i64),
    NotFound,
    ModelLocked,
    RetryIneligible,
    IdempotencyMismatch,
    InvalidInput,
    CorruptData,
    Clock,
}

impl fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(_) => formatter.write_str("SQLite operation failed"),
            Self::Io(_) => formatter.write_str("database directory could not be prepared"),
            Self::Worker(_) => formatter.write_str("database worker failed"),
            Self::UnsupportedSchema(version) => write!(
                formatter,
                "database schema version {version} is newer than this application"
            ),
            Self::MigrationMismatch(version) => write!(
                formatter,
                "database migration metadata does not match version {version}"
            ),
            Self::NotFound => formatter.write_str("record was not found"),
            Self::ModelLocked => formatter.write_str("conversation model is locked"),
            Self::RetryIneligible => formatter.write_str("assistant response is not retryable"),
            Self::IdempotencyMismatch => formatter.write_str("idempotency key payload mismatch"),
            Self::InvalidInput => formatter.write_str("invalid repository input"),
            Self::CorruptData => formatter.write_str("database contains inconsistent data"),
            Self::Clock => formatter.write_str("system clock is invalid"),
        }
    }
}

impl std::error::Error for StorageError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Sqlite(error) => Some(error),
            Self::Io(error) => Some(error),
            Self::Worker(error) => Some(error),
            Self::UnsupportedSchema(_)
            | Self::MigrationMismatch(_)
            | Self::NotFound
            | Self::ModelLocked
            | Self::RetryIneligible
            | Self::IdempotencyMismatch
            | Self::InvalidInput
            | Self::CorruptData
            | Self::Clock => None,
        }
    }
}

impl From<rusqlite::Error> for StorageError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

impl From<std::io::Error> for StorageError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<StorageError> for RepositoryError {
    fn from(error: StorageError) -> Self {
        let kind = match &error {
            StorageError::NotFound => RepositoryErrorKind::NotFound,
            StorageError::ModelLocked
            | StorageError::RetryIneligible
            | StorageError::IdempotencyMismatch => RepositoryErrorKind::Conflict,
            StorageError::InvalidInput | StorageError::CorruptData => {
                RepositoryErrorKind::CorruptData
            }
            StorageError::Sqlite(rusqlite::Error::SqliteFailure(code, _))
                if code.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                RepositoryErrorKind::Conflict
            }
            StorageError::Sqlite(
                rusqlite::Error::FromSqlConversionFailure(_, _, _)
                | rusqlite::Error::IntegralValueOutOfRange(_, _)
                | rusqlite::Error::InvalidColumnType(_, _, _),
            )
            | StorageError::UnsupportedSchema(_)
            | StorageError::MigrationMismatch(_) => RepositoryErrorKind::CorruptData,
            StorageError::Sqlite(_)
            | StorageError::Io(_)
            | StorageError::Worker(_)
            | StorageError::Clock => RepositoryErrorKind::Unavailable,
        };
        RepositoryError::with_source(kind, error)
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod backup_tests {
    use chat_core::repository::{ConversationRepository, NewConversation};
    use tempfile::TempDir;

    use super::SqliteStorage;

    #[tokio::test]
    async fn online_backup_restores_into_fresh_storage() {
        let directory = TempDir::new().expect("temporary directory should be created");
        let source_path = directory.path().join("source.db");
        let backup_path = directory.path().join("backups/chat.db");
        let source = SqliteStorage::initialize(&source_path)
            .await
            .expect("source database should initialize");
        source
            .create(NewConversation {
                id: "01JBACKUPTEST00000000000000".to_owned(),
                title: "Backup fixture".to_owned(),
                model: "test-model".to_owned(),
                created_at: 1_786_000_000_000,
            })
            .await
            .expect("fixture conversation should be created");

        source
            .backup(&backup_path)
            .await
            .expect("online backup should complete");
        let restored = SqliteStorage::initialize(&backup_path)
            .await
            .expect("backup should open as fresh storage");
        let detail = restored
            .get("01JBACKUPTEST00000000000000".to_owned())
            .await
            .expect("restored conversation should be readable");
        assert_eq!(detail.conversation.title, "Backup fixture");
    }
}

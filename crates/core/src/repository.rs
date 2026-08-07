use std::{error::Error, fmt, future::Future};

use crate::{
    conversation::{Conversation, ConversationDetail, Message, MessageStatus},
    generation::{Generation, GenerationResult, GenerationStatus},
};

pub const DEFAULT_CONVERSATION_PAGE_SIZE: u32 = 30;
pub const MAX_CONVERSATION_PAGE_SIZE: u32 = 100;

/// Opaque ordering position for conversation pagination.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConversationCursor {
    pub updated_at: i64,
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConversationPage {
    pub conversations: Vec<Conversation>,
    pub next_cursor: Option<ConversationCursor>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewConversation {
    pub id: String,
    pub title: String,
    pub model: String,
    pub created_at: i64,
}

/// Atomic setup for a normal user-message generation. `conversation` is set
/// only for the first message of a new conversation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewMessageGeneration {
    pub conversation: Option<NewConversation>,
    pub conversation_id: String,
    pub user_message: Message,
    pub assistant_message: Message,
    pub generation: Generation,
}

/// Atomic setup for retrying an eligible latest assistant message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetryGeneration {
    pub conversation_id: String,
    pub source_assistant_message_id: String,
    pub assistant_message: Message,
    pub generation: Generation,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GenerationFinalization {
    pub generation_id: String,
    pub assistant_message_id: String,
    pub generation_status: GenerationStatus,
    pub message_status: MessageStatus,
    pub content: String,
    pub error_code: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub finished_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GenerationSetup {
    Created(GenerationResult),
    Existing(GenerationResult),
}

/// Storage failures are categorized without exposing adapter-specific details.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RepositoryErrorKind {
    NotFound,
    Conflict,
    Unavailable,
    CorruptData,
}

#[derive(Debug)]
pub struct RepositoryError {
    kind: RepositoryErrorKind,
    source: Option<Box<dyn Error + Send + Sync>>,
}

impl RepositoryError {
    #[must_use]
    pub const fn new(kind: RepositoryErrorKind) -> Self {
        Self { kind, source: None }
    }

    #[must_use]
    pub fn with_source(
        kind: RepositoryErrorKind,
        source: impl Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            kind,
            source: Some(Box::new(source)),
        }
    }

    #[must_use]
    pub const fn kind(&self) -> RepositoryErrorKind {
        self.kind
    }
}

impl fmt::Display for RepositoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "repository {:?} error", self.kind)
    }
}

impl Error for RepositoryError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source
            .as_deref()
            .map(|source| source as &(dyn Error + 'static))
    }
}

/// Application-facing conversation persistence contract.
///
/// Returned futures allow storage implementations to move synchronous database
/// work onto a dedicated blocking pool without making core depend on Tokio.
pub trait ConversationRepository: Send + Sync {
    fn list(
        &self,
        cursor: Option<ConversationCursor>,
        limit: u32,
    ) -> impl Future<Output = Result<ConversationPage, RepositoryError>> + Send;

    fn get(
        &self,
        id: String,
    ) -> impl Future<Output = Result<ConversationDetail, RepositoryError>> + Send;

    fn find_by_client_message_id(
        &self,
        client_message_id: String,
    ) -> impl Future<Output = Result<Option<ConversationDetail>, RepositoryError>> + Send;

    fn find_assistant_message(
        &self,
        assistant_message_id: String,
    ) -> impl Future<Output = Result<ConversationDetail, RepositoryError>> + Send;

    fn create(
        &self,
        conversation: NewConversation,
    ) -> impl Future<Output = Result<Conversation, RepositoryError>> + Send;

    fn rename(
        &self,
        id: String,
        title: String,
        updated_at: i64,
    ) -> impl Future<Output = Result<Conversation, RepositoryError>> + Send;

    fn delete(&self, id: String) -> impl Future<Output = Result<(), RepositoryError>> + Send;
}

/// Persistence contract for atomic generation setup and one-shot finalization.
pub trait GenerationRepository: Send + Sync {
    fn create_message_generation(
        &self,
        setup: NewMessageGeneration,
    ) -> impl Future<Output = Result<GenerationSetup, RepositoryError>> + Send;

    fn create_retry_generation(
        &self,
        setup: RetryGeneration,
    ) -> impl Future<Output = Result<GenerationResult, RepositoryError>> + Send;

    fn get_generation(
        &self,
        generation_id: String,
    ) -> impl Future<Output = Result<GenerationResult, RepositoryError>> + Send;

    fn finalize_generation(
        &self,
        finalization: GenerationFinalization,
    ) -> impl Future<Output = Result<bool, RepositoryError>> + Send;
}

pub trait StorageHealth: Send + Sync {
    fn check(&self) -> impl Future<Output = Result<(), RepositoryError>> + Send;
}

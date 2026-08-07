use std::fmt;

/// A persisted conversation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub model: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A conversation and its complete ordered message history.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConversationDetail {
    pub conversation: Conversation,
    pub messages: Vec<Message>,
}

/// A persisted chat message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub client_message_id: Option<String>,
    pub role: MessageRole,
    pub content: String,
    pub status: MessageStatus,
    pub model: Option<String>,
    pub error_code: Option<String>,
    pub created_at: i64,
    pub finished_at: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageRole {
    User,
    Assistant,
}

impl MessageRole {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }

    /// Parses the database representation.
    ///
    /// # Errors
    /// Returns an error when the value is not a defined message role.
    pub fn parse(value: &str) -> Result<Self, DomainValueError> {
        match value {
            "user" => Ok(Self::User),
            "assistant" => Ok(Self::Assistant),
            _ => Err(DomainValueError::new("message role", value)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageStatus {
    Completed,
    Streaming,
    Stopped,
    Error,
    Interrupted,
}

impl MessageStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Streaming => "streaming",
            Self::Stopped => "stopped",
            Self::Error => "error",
            Self::Interrupted => "interrupted",
        }
    }

    /// Parses the database representation.
    ///
    /// # Errors
    /// Returns an error when the value is not a defined message status.
    pub fn parse(value: &str) -> Result<Self, DomainValueError> {
        match value {
            "completed" => Ok(Self::Completed),
            "streaming" => Ok(Self::Streaming),
            "stopped" => Ok(Self::Stopped),
            "error" => Ok(Self::Error),
            "interrupted" => Ok(Self::Interrupted),
            _ => Err(DomainValueError::new("message status", value)),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DomainValueError {
    pub kind: &'static str,
    pub value: String,
}

impl DomainValueError {
    fn new(kind: &'static str, value: &str) -> Self {
        Self {
            kind,
            value: value.to_owned(),
        }
    }
}

impl fmt::Display for DomainValueError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid {} value", self.kind)
    }
}

impl std::error::Error for DomainValueError {}

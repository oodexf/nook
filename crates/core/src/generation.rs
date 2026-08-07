/// Metadata for one provider generation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Generation {
    pub id: String,
    pub conversation_id: String,
    pub assistant_message_id: String,
    pub provider: String,
    pub model: String,
    pub status: GenerationStatus,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

/// Generation joined to the user input that caused it, when one exists.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GenerationResult {
    pub generation: Generation,
    pub user_message_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GenerationStatus {
    Pending,
    Streaming,
    Cancelling,
    Completed,
    Stopped,
    Error,
    Interrupted,
}

impl GenerationStatus {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Stopped | Self::Error | Self::Interrupted
        )
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Streaming => "streaming",
            Self::Cancelling => "cancelling",
            Self::Completed => "completed",
            Self::Stopped => "stopped",
            Self::Error => "error",
            Self::Interrupted => "interrupted",
        }
    }

    /// Parses the database representation.
    ///
    /// # Errors
    /// Returns an error when the value is not a defined generation status.
    pub fn parse(value: &str) -> Result<Self, GenerationValueError> {
        match value {
            "pending" => Ok(Self::Pending),
            "streaming" => Ok(Self::Streaming),
            "cancelling" => Ok(Self::Cancelling),
            "completed" => Ok(Self::Completed),
            "stopped" => Ok(Self::Stopped),
            "error" => Ok(Self::Error),
            "interrupted" => Ok(Self::Interrupted),
            _ => Err(GenerationValueError(value.to_owned())),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GenerationValueError(pub String);

impl std::fmt::Display for GenerationValueError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("invalid generation status")
    }
}

impl std::error::Error for GenerationValueError {}

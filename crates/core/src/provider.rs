//! Provider-independent chat generation contracts and bounded context selection.

use std::{fmt, future::Future, pin::Pin};

use futures_core::Stream;

use crate::conversation::{Message, MessageRole};

/// One message sent to the configured chat provider.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatRole {
    User,
    Assistant,
}

impl ChatRole {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TokenUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChatStreamEvent {
    Delta(String),
    /// Reasoning (thinking-chain) content streamed before the answer.
    ReasoningDelta(String),
    Done {
        finish_reason: String,
        usage: TokenUsage,
    },
}

pub type ChatStream =
    Pin<Box<dyn Stream<Item = Result<ChatStreamEvent, ChatProviderError>> + Send + 'static>>;

/// Stable generation-provider failures. This type intentionally contains no
/// raw response body, URL, header, API key, or transport error text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatProviderError {
    Unauthorized,
    RateLimited,
    Timeout,
    Unavailable,
    InvalidResponse,
    StreamInterrupted,
    Cancelled,
}

impl ChatProviderError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Unauthorized => "provider_unauthorized",
            Self::RateLimited => "provider_rate_limited",
            Self::Timeout => "provider_timeout",
            Self::Unavailable => "provider_unavailable",
            Self::InvalidResponse => "provider_invalid_stream",
            Self::StreamInterrupted => "provider_stream_interrupted",
            Self::Cancelled => "generation_cancelled",
        }
    }

    #[must_use]
    pub const fn safe_message(self) -> &'static str {
        match self {
            Self::Unauthorized => "The model provider rejected its configured credentials.",
            Self::RateLimited => "The model provider is rate limiting this request.",
            Self::Timeout => "The model response timed out.",
            Self::Unavailable => "The model provider is temporarily unavailable.",
            Self::InvalidResponse => "The model provider returned an invalid response stream.",
            Self::StreamInterrupted => "The model response was interrupted.",
            Self::Cancelled => "The model response was stopped.",
        }
    }
}

impl fmt::Display for ChatProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.safe_message())
    }
}

impl std::error::Error for ChatProviderError {}

/// Provider boundary. Wire DTOs and HTTP behavior remain in the adapter.
pub trait ChatProvider: Send + Sync {
    fn chat(
        &self,
        request: ChatRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ChatStream, ChatProviderError>> + Send + '_>>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContextLimits {
    pub max_messages: usize,
    pub max_chars: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContextError {
    CurrentMessageTooLarge,
    InvalidLimits,
}

impl fmt::Display for ContextError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CurrentMessageTooLarge => formatter.write_str("the current message is too large"),
            Self::InvalidLimits => formatter.write_str("conversation context limits are invalid"),
        }
    }
}

impl std::error::Error for ContextError {}

/// Selects a newest suffix under both limits, then restores chronological
/// order. The current user message must be the newest supplied message and is
/// never truncated or silently omitted.
///
/// # Errors
/// Returns an error if limits cannot include the current message.
pub fn select_bounded_context(
    messages: &[Message],
    limits: ContextLimits,
) -> Result<Vec<ChatMessage>, ContextError> {
    if limits.max_messages == 0 || limits.max_chars == 0 {
        return Err(ContextError::InvalidLimits);
    }

    let Some(current) = messages.last() else {
        return Err(ContextError::CurrentMessageTooLarge);
    };
    if current.role != MessageRole::User || current.content.chars().count() > limits.max_chars {
        return Err(ContextError::CurrentMessageTooLarge);
    }

    let mut selected = Vec::new();
    let mut chars = 0_usize;
    for message in messages.iter().rev() {
        if selected.len() == limits.max_messages {
            break;
        }
        let message_chars = message.content.chars().count();
        if chars.saturating_add(message_chars) > limits.max_chars {
            break;
        }
        let role = match message.role {
            MessageRole::User => ChatRole::User,
            MessageRole::Assistant => ChatRole::Assistant,
        };
        selected.push(ChatMessage {
            role,
            content: message.content.clone(),
        });
        chars += message_chars;
    }
    selected.reverse();
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use crate::conversation::{Message, MessageRole, MessageStatus};

    use super::{ContextError, ContextLimits, select_bounded_context};

    fn message(id: &str, role: MessageRole, content: &str) -> Message {
        Message {
            id: id.to_owned(),
            conversation_id: "conversation".to_owned(),
            client_message_id: (role == MessageRole::User).then(|| format!("client-{id}")),
            role,
            content: content.to_owned(),
            reasoning: None,
            status: MessageStatus::Completed,
            model: (role == MessageRole::Assistant).then(|| "model".to_owned()),
            error_code: None,
            created_at: 0,
            finished_at: Some(0),
        }
    }

    #[test]
    fn context_selects_newest_then_sends_chronologically() {
        let messages = [
            message("u1", MessageRole::User, "old-user"),
            message("a1", MessageRole::Assistant, "old-assistant"),
            message("u2", MessageRole::User, "new-user"),
        ];
        let selected = select_bounded_context(
            &messages,
            ContextLimits {
                max_messages: 2,
                max_chars: 100,
            },
        )
        .expect("context should fit");
        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].content, "old-assistant");
        assert_eq!(selected[1].content, "new-user");
    }

    #[test]
    fn context_stops_at_character_boundary_without_skipping_newer_messages() {
        let messages = [
            message("u1", MessageRole::User, "12345"),
            message("a1", MessageRole::Assistant, "12345"),
            message("u2", MessageRole::User, "😀😀"),
        ];
        let selected = select_bounded_context(
            &messages,
            ContextLimits {
                max_messages: 10,
                max_chars: 7,
            },
        )
        .expect("newest suffix should fit");
        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].content, "12345");
        assert_eq!(selected[1].content, "😀😀");
    }

    #[test]
    fn oversized_current_message_is_rejected() {
        let messages = [message("u1", MessageRole::User, "too large")];
        assert_eq!(
            select_bounded_context(
                &messages,
                ContextLimits {
                    max_messages: 1,
                    max_chars: 3,
                },
            ),
            Err(ContextError::CurrentMessageTooLarge)
        );
    }
}

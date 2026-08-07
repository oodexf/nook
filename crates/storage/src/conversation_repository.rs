use rusqlite::{Connection, OptionalExtension, params};

use chat_core::{
    conversation::{
        Conversation, ConversationDetail, DomainValueError, Message, MessageRole, MessageStatus,
    },
    repository::{ConversationCursor, ConversationPage, NewConversation},
};

use crate::StorageError;

pub(crate) fn list(
    connection: &Connection,
    cursor: Option<&ConversationCursor>,
    limit: u32,
) -> Result<ConversationPage, StorageError> {
    let fetch_limit = i64::from(limit) + 1;
    let mut conversations = if let Some(cursor) = cursor {
        let mut statement = connection.prepare(
            "SELECT id, title, model, created_at, updated_at
             FROM conversations
             WHERE updated_at < ?1 OR (updated_at = ?1 AND id < ?2)
             ORDER BY updated_at DESC, id DESC
             LIMIT ?3",
        )?;
        statement
            .query_map(
                params![cursor.updated_at, cursor.id, fetch_limit],
                map_conversation,
            )?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        let mut statement = connection.prepare(
            "SELECT id, title, model, created_at, updated_at
             FROM conversations
             ORDER BY updated_at DESC, id DESC
             LIMIT ?1",
        )?;
        statement
            .query_map(params![fetch_limit], map_conversation)?
            .collect::<Result<Vec<_>, _>>()?
    };

    let has_more = conversations.len() > limit as usize;
    conversations.truncate(limit as usize);
    let next_cursor = if has_more {
        conversations.last().map(|last| ConversationCursor {
            updated_at: last.updated_at,
            id: last.id.clone(),
        })
    } else {
        None
    };
    Ok(ConversationPage {
        conversations,
        next_cursor,
    })
}

pub(crate) fn get(connection: &Connection, id: &str) -> Result<ConversationDetail, StorageError> {
    let conversation = connection
        .query_row(
            "SELECT id, title, model, created_at, updated_at
             FROM conversations WHERE id = ?1",
            [id],
            map_conversation,
        )
        .optional()?
        .ok_or(StorageError::NotFound)?;
    let messages = messages_for_conversation(connection, id)?;
    Ok(ConversationDetail {
        conversation,
        messages,
    })
}

pub(crate) fn find_by_client_message_id(
    connection: &Connection,
    client_message_id: &str,
) -> Result<Option<ConversationDetail>, StorageError> {
    let conversation_id = connection
        .query_row(
            "SELECT conversation_id FROM messages WHERE client_message_id = ?1",
            [client_message_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    conversation_id
        .as_deref()
        .map(|id| get(connection, id))
        .transpose()
}

pub(crate) fn find_assistant_message(
    connection: &Connection,
    assistant_message_id: &str,
) -> Result<ConversationDetail, StorageError> {
    let conversation_id = connection
        .query_row(
            "SELECT conversation_id FROM messages WHERE id = ?1 AND role = 'assistant'",
            [assistant_message_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or(StorageError::NotFound)?;
    get(connection, &conversation_id)
}

fn messages_for_conversation(
    connection: &Connection,
    id: &str,
) -> Result<Vec<Message>, StorageError> {
    let mut statement = connection.prepare(
        "SELECT id, conversation_id, client_message_id, role, content, status,
                model, error_code, created_at, finished_at
         FROM messages WHERE conversation_id = ?1
         ORDER BY created_at ASC, id ASC",
    )?;
    let messages = statement
        .query_map([id], map_message)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(messages)
}

pub(crate) fn insert_message_for_test(
    transaction: &rusqlite::Transaction<'_>,
    message: &Message,
) -> Result<(), StorageError> {
    transaction.execute(
        "INSERT INTO messages
         (id, conversation_id, client_message_id, role, content, status, model,
          error_code, created_at, finished_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            message.id,
            message.conversation_id,
            message.client_message_id,
            message.role.as_str(),
            message.content,
            message.status.as_str(),
            message.model,
            message.error_code,
            message.created_at,
            message.finished_at
        ],
    )?;
    Ok(())
}

pub(crate) fn create(
    connection: &Connection,
    conversation: &NewConversation,
) -> Result<Conversation, StorageError> {
    connection.execute(
        "INSERT INTO conversations(id, title, model, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![
            conversation.id,
            conversation.title,
            conversation.model,
            conversation.created_at
        ],
    )?;
    get(connection, &conversation.id).map(|detail| detail.conversation)
}

pub(crate) fn rename(
    connection: &Connection,
    id: &str,
    title: &str,
    updated_at: i64,
) -> Result<Conversation, StorageError> {
    let changed = connection.execute(
        "UPDATE conversations SET title = ?1, updated_at = ?2 WHERE id = ?3",
        params![title, updated_at, id],
    )?;
    if changed == 0 {
        return Err(StorageError::NotFound);
    }
    get(connection, id).map(|detail| detail.conversation)
}

pub(crate) fn delete(connection: &Connection, id: &str) -> Result<(), StorageError> {
    let changed = connection.execute("DELETE FROM conversations WHERE id = ?1", [id])?;
    if changed == 0 {
        return Err(StorageError::NotFound);
    }
    Ok(())
}

fn map_conversation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: row.get(0)?,
        title: row.get(1)?,
        model: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn map_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<Message> {
    let role: String = row.get(3)?;
    let status: String = row.get(5)?;
    Ok(Message {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        client_message_id: row.get(2)?,
        role: MessageRole::parse(&role).map_err(domain_mapping_error)?,
        content: row.get(4)?,
        status: MessageStatus::parse(&status).map_err(domain_mapping_error)?,
        model: row.get(6)?,
        error_code: row.get(7)?,
        created_at: row.get(8)?,
        finished_at: row.get(9)?,
    })
}

fn domain_mapping_error(error: DomainValueError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

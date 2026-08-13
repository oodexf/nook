use rusqlite::{Connection, OptionalExtension, Transaction, params};

use chat_core::{
    conversation::Message,
    generation::{Generation, GenerationResult, GenerationStatus, GenerationValueError},
    repository::{GenerationFinalization, GenerationSetup, NewMessageGeneration, RetryGeneration},
};

use crate::StorageError;

pub(crate) fn create_message_generation(
    connection: &mut Connection,
    setup: &NewMessageGeneration,
) -> Result<GenerationSetup, StorageError> {
    let transaction = connection.transaction()?;

    if let Some(existing) = find_by_client_message_id(
        &transaction,
        &setup
            .user_message
            .client_message_id
            .clone()
            .ok_or(StorageError::InvalidInput)?,
    )? {
        let persisted: (String, String) = transaction.query_row(
            "SELECT content, conversation_id FROM messages WHERE client_message_id = ?1",
            [setup
                .user_message
                .client_message_id
                .as_deref()
                .unwrap_or_default()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if persisted.0 != setup.user_message.content || persisted.1 != setup.conversation_id {
            return Err(StorageError::IdempotencyMismatch);
        }
        transaction.commit()?;
        return Ok(GenerationSetup::Existing(existing));
    }

    if let Some(conversation) = &setup.conversation {
        transaction.execute(
            "INSERT INTO conversations(id, title, model, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![
                conversation.id,
                conversation.title,
                conversation.model,
                conversation.created_at
            ],
        )?;
    } else {
        let stored_model = transaction
            .query_row(
                "SELECT model FROM conversations WHERE id = ?1",
                [&setup.conversation_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or(StorageError::NotFound)?;
        if stored_model != setup.generation.model {
            return Err(StorageError::ModelMismatch);
        }
    }

    insert_message(&transaction, &setup.user_message)?;
    insert_message(&transaction, &setup.assistant_message)?;
    insert_generation(&transaction, &setup.generation)?;
    transaction.execute(
        "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
        params![setup.user_message.created_at, setup.conversation_id],
    )?;
    transaction.commit()?;
    Ok(GenerationSetup::Created(GenerationResult {
        generation: setup.generation.clone(),
        user_message_id: Some(setup.user_message.id.clone()),
    }))
}

pub(crate) fn create_retry_generation(
    connection: &mut Connection,
    setup: &RetryGeneration,
) -> Result<GenerationResult, StorageError> {
    let transaction = connection.transaction()?;
    let (role, status, latest, generation_count): (String, String, bool, i64) = transaction
        .query_row(
            "SELECT m.role, m.status,
                    m.id = (SELECT id FROM messages WHERE conversation_id = m.conversation_id AND role = 'assistant' ORDER BY created_at DESC, id DESC LIMIT 1),
                    (SELECT COUNT(*) FROM generations WHERE assistant_message_id = m.id)
             FROM messages m WHERE m.id = ?1 AND m.conversation_id = ?2",
            params![setup.source_assistant_message_id, setup.conversation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?
        .ok_or(StorageError::NotFound)?;
    if role != "assistant"
        || !latest
        || generation_count == 0
        || !matches!(
            status.as_str(),
            "completed" | "stopped" | "error" | "interrupted"
        )
    {
        return Err(StorageError::RetryIneligible);
    }

    let stored_model: String = transaction.query_row(
        "SELECT model FROM conversations WHERE id = ?1",
        [&setup.conversation_id],
        |row| row.get(0),
    )?;
    if stored_model != setup.generation.model {
        return Err(StorageError::ModelMismatch);
    }
    insert_message(&transaction, &setup.assistant_message)?;
    insert_generation(&transaction, &setup.generation)?;
    transaction.execute(
        "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
        params![setup.assistant_message.created_at, setup.conversation_id],
    )?;
    transaction.commit()?;
    Ok(GenerationResult {
        generation: setup.generation.clone(),
        user_message_id: None,
    })
}

pub(crate) fn get_generation(
    connection: &Connection,
    generation_id: &str,
) -> Result<GenerationResult, StorageError> {
    connection
        .query_row(
            "SELECT g.id, g.conversation_id, g.assistant_message_id, g.provider, g.model,
                    g.status, g.input_tokens, g.output_tokens, g.started_at, g.finished_at,
                    (SELECT id FROM messages u
                     WHERE u.conversation_id = g.conversation_id AND u.role = 'user'
                       AND (u.created_at < m.created_at OR (u.created_at = m.created_at AND u.id < m.id))
                     ORDER BY u.created_at DESC, u.id DESC LIMIT 1)
             FROM generations g
             JOIN messages m ON m.id = g.assistant_message_id
             WHERE g.id = ?1",
            [generation_id],
            map_generation_result,
        )
        .optional()?
        .ok_or(StorageError::NotFound)
}

pub(crate) fn finalize_generation(
    connection: &mut Connection,
    finalization: &GenerationFinalization,
) -> Result<bool, StorageError> {
    let transaction = connection.transaction()?;
    let changed = transaction.execute(
        "UPDATE generations
         SET status = ?1, input_tokens = ?2, output_tokens = ?3, finished_at = ?4
         WHERE id = ?5 AND assistant_message_id = ?6
           AND status IN ('pending', 'streaming', 'cancelling')",
        params![
            finalization.generation_status.as_str(),
            finalization.input_tokens,
            finalization.output_tokens,
            finalization.finished_at,
            finalization.generation_id,
            finalization.assistant_message_id,
        ],
    )?;
    if changed == 0 {
        transaction.rollback()?;
        return Ok(false);
    }
    let message_changed = transaction.execute(
        "UPDATE messages
         SET content = ?1, status = ?2, error_code = ?3, finished_at = ?4, reasoning = ?5
         WHERE id = ?6 AND status = 'streaming'",
        params![
            finalization.content,
            finalization.message_status.as_str(),
            finalization.error_code,
            finalization.finished_at,
            finalization.reasoning,
            finalization.assistant_message_id,
        ],
    )?;
    if message_changed != 1 {
        return Err(StorageError::CorruptData);
    }
    transaction.execute(
        "UPDATE conversations SET updated_at = ?1 WHERE id =
         (SELECT conversation_id FROM generations WHERE id = ?2)",
        params![finalization.finished_at, finalization.generation_id],
    )?;
    transaction.commit()?;
    Ok(true)
}

fn find_by_client_message_id(
    transaction: &Transaction<'_>,
    client_message_id: &str,
) -> Result<Option<GenerationResult>, StorageError> {
    transaction
        .query_row(
            "SELECT g.id, g.conversation_id, g.assistant_message_id, g.provider, g.model,
                    g.status, g.input_tokens, g.output_tokens, g.started_at, g.finished_at,
                    u.id
             FROM messages u
             JOIN messages a ON a.conversation_id = u.conversation_id AND a.role = 'assistant'
                 AND (a.created_at > u.created_at OR (a.created_at = u.created_at AND a.id != u.id))
             JOIN generations g ON g.assistant_message_id = a.id
             WHERE u.client_message_id = ?1
             ORDER BY a.created_at ASC, a.id ASC LIMIT 1",
            [client_message_id],
            map_generation_result,
        )
        .optional()
        .map_err(StorageError::from)
}

fn insert_message(transaction: &Transaction<'_>, message: &Message) -> Result<(), StorageError> {
    transaction.execute(
        "INSERT INTO messages
         (id, conversation_id, client_message_id, role, content, status, model,
          error_code, created_at, finished_at, reasoning)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
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
            message.finished_at,
            message.reasoning,
        ],
    )?;
    Ok(())
}

pub(crate) fn insert_generation_for_test(
    transaction: &Transaction<'_>,
    generation: &Generation,
) -> Result<(), StorageError> {
    insert_generation(transaction, generation)
}

fn insert_generation(
    transaction: &Transaction<'_>,
    generation: &Generation,
) -> Result<(), StorageError> {
    transaction.execute(
        "INSERT INTO generations
         (id, conversation_id, assistant_message_id, provider, model, status,
          input_tokens, output_tokens, started_at, finished_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            generation.id,
            generation.conversation_id,
            generation.assistant_message_id,
            generation.provider,
            generation.model,
            generation.status.as_str(),
            generation.input_tokens,
            generation.output_tokens,
            generation.started_at,
            generation.finished_at,
        ],
    )?;
    Ok(())
}

fn map_generation_result(row: &rusqlite::Row<'_>) -> rusqlite::Result<GenerationResult> {
    let status: String = row.get(5)?;
    Ok(GenerationResult {
        generation: Generation {
            id: row.get(0)?,
            conversation_id: row.get(1)?,
            assistant_message_id: row.get(2)?,
            provider: row.get(3)?,
            model: row.get(4)?,
            status: GenerationStatus::parse(&status).map_err(generation_mapping_error)?,
            input_tokens: row.get(6)?,
            output_tokens: row.get(7)?,
            started_at: row.get(8)?,
            finished_at: row.get(9)?,
        },
        user_message_id: row.get(10)?,
    })
}

fn generation_mapping_error(error: GenerationValueError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(error))
}

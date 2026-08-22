use chat_core::{
    conversation::{Message, MessageRole, MessageStatus},
    generation::{Generation, GenerationStatus},
    repository::{
        ConversationCursor, ConversationRepository, GenerationFinalization, GenerationRepository,
        NewConversation, NewMessageGeneration, RepositoryErrorKind, RetryGeneration,
    },
};
use rusqlite::{Connection, params};
use tempfile::TempDir;

use crate::{SqliteStorage, connection};

async fn database() -> (TempDir, SqliteStorage) {
    let directory = TempDir::new().expect("temporary directory should be created");
    let storage = SqliteStorage::initialize(directory.path().join("chat.db"))
        .await
        .expect("database should initialize");
    (directory, storage)
}

fn user_message(
    id: &str,
    conversation_id: &str,
    client_message_id: &str,
    content: &str,
) -> Message {
    Message {
        id: id.to_owned(),
        conversation_id: conversation_id.to_owned(),
        client_message_id: Some(client_message_id.to_owned()),
        role: MessageRole::User,
        content: content.to_owned(),
        reasoning: None,
        status: MessageStatus::Completed,
        model: None,
        error_code: None,
        created_at: 100,
        finished_at: Some(100),
    }
}

fn assistant_placeholder(id: &str, conversation_id: &str) -> Message {
    Message {
        id: id.to_owned(),
        conversation_id: conversation_id.to_owned(),
        client_message_id: None,
        role: MessageRole::Assistant,
        content: String::new(),
        reasoning: None,
        status: MessageStatus::Streaming,
        model: Some("test-model".to_owned()),
        error_code: None,
        created_at: 100,
        finished_at: None,
    }
}

fn streaming_generation(id: &str, conversation_id: &str, assistant_message_id: &str) -> Generation {
    Generation {
        id: id.to_owned(),
        conversation_id: conversation_id.to_owned(),
        assistant_message_id: assistant_message_id.to_owned(),
        provider: "provider".to_owned(),
        model: "test-model".to_owned(),
        status: GenerationStatus::Streaming,
        input_tokens: None,
        output_tokens: None,
        started_at: 100,
        finished_at: None,
    }
}

fn raw(directory: &TempDir) -> Connection {
    connection::open(&directory.path().join("chat.db")).expect("database should open")
}

fn seed_v2_database(path: &std::path::Path) {
    let mut connection = connection::open(path).expect("v2 database should open");
    let transaction = connection
        .transaction()
        .expect("v2 migration transaction should start");
    transaction
        .execute_batch(include_str!("../migrations/0001_initial.sql"))
        .expect("v1 schema should apply");
    transaction
        .execute_batch(include_str!("../migrations/0002_message_reasoning.sql"))
        .expect("v2 schema should apply");
    transaction
        .execute_batch(
            "CREATE TABLE schema_migrations (
                 version INTEGER PRIMARY KEY,
                 name TEXT NOT NULL,
                 applied_at INTEGER NOT NULL
             ) STRICT;
             INSERT INTO schema_migrations(version, name, applied_at)
             VALUES (1, 'initial', 1), (2, 'message_reasoning', 2);
             INSERT INTO conversations(id, title, model, created_at, updated_at)
             VALUES ('c-v2', 'Legacy', 'model-a', 10, 10);
             INSERT INTO messages
             (id, conversation_id, client_message_id, role, content, status, model,
              error_code, created_at, finished_at, reasoning)
             VALUES
             ('u-v2', 'c-v2', 'client-v2', 'user', 'legacy prompt', 'completed',
              NULL, NULL, 11, 11, NULL),
             ('a-v2', 'c-v2', NULL, 'assistant', 'legacy answer', 'completed',
              'model-a', NULL, 12, 12, 'legacy reasoning');
             INSERT INTO generations
             (id, conversation_id, assistant_message_id, provider, model, status,
              input_tokens, output_tokens, started_at, finished_at)
             VALUES ('g-v2', 'c-v2', 'a-v2', 'provider', 'model-a', 'completed',
                     4, 5, 12, 12);",
        )
        .expect("v2 fixture rows should insert");
    transaction.commit().expect("v2 fixture should commit");
}

fn migrated_model_b_message_setup() -> NewMessageGeneration {
    NewMessageGeneration {
        conversation: None,
        conversation_id: "c-v2".to_owned(),
        user_message: Message {
            created_at: 21,
            finished_at: Some(21),
            ..user_message("u-v3", "c-v2", "client-v3", "new prompt")
        },
        assistant_message: Message {
            id: "a-v3".to_owned(),
            conversation_id: "c-v2".to_owned(),
            client_message_id: None,
            role: MessageRole::Assistant,
            content: String::new(),
            reasoning: None,
            status: MessageStatus::Streaming,
            model: Some("model-b".to_owned()),
            error_code: None,
            created_at: 22,
            finished_at: None,
        },
        generation: Generation {
            id: "g-v3".to_owned(),
            conversation_id: "c-v2".to_owned(),
            assistant_message_id: "a-v3".to_owned(),
            provider: "provider".to_owned(),
            model: "model-b".to_owned(),
            status: GenerationStatus::Streaming,
            input_tokens: None,
            output_tokens: None,
            started_at: 22,
            finished_at: None,
        },
    }
}

fn migrated_model_b_retry_setup() -> RetryGeneration {
    RetryGeneration {
        conversation_id: "c-v2".to_owned(),
        source_assistant_message_id: "a-v3".to_owned(),
        assistant_message: Message {
            id: "a-v3-retry".to_owned(),
            conversation_id: "c-v2".to_owned(),
            client_message_id: None,
            role: MessageRole::Assistant,
            content: String::new(),
            reasoning: None,
            status: MessageStatus::Streaming,
            model: Some("model-b".to_owned()),
            error_code: None,
            created_at: 24,
            finished_at: None,
        },
        generation: Generation {
            id: "g-v3-retry".to_owned(),
            conversation_id: "c-v2".to_owned(),
            assistant_message_id: "a-v3-retry".to_owned(),
            provider: "provider".to_owned(),
            model: "model-b".to_owned(),
            status: GenerationStatus::Streaming,
            input_tokens: None,
            output_tokens: None,
            started_at: 24,
            finished_at: None,
        },
    }
}

async fn exercise_migrated_current_model(storage: &SqliteStorage) {
    storage
        .create_message_generation(migrated_model_b_message_setup())
        .await
        .expect("migrated conversation should accept a send on its current model");
    assert_eq!(
        storage
            .get_generation("g-v3".to_owned())
            .await
            .expect("new generation should be readable")
            .generation
            .model,
        "model-b"
    );
    assert!(
        storage
            .finalize_generation(GenerationFinalization {
                generation_id: "g-v3".to_owned(),
                assistant_message_id: "a-v3".to_owned(),
                generation_status: GenerationStatus::Completed,
                message_status: MessageStatus::Completed,
                content: "new answer".to_owned(),
                reasoning: None,
                error_code: None,
                input_tokens: Some(6),
                output_tokens: Some(7),
                finished_at: 23,
            })
            .await
            .expect("new generation should finalize")
    );
    storage
        .create_retry_generation(migrated_model_b_retry_setup())
        .await
        .expect("migrated conversation should retry on its current model");
    assert_eq!(
        storage
            .get_generation("g-v3-retry".to_owned())
            .await
            .expect("retry generation should be readable")
            .generation
            .model,
        "model-b"
    );
}

fn conversation(id: &str, updated_at: i64) -> NewConversation {
    NewConversation {
        id: id.to_owned(),
        title: format!("Conversation {id}"),
        model: "test-model".to_owned(),
        created_at: updated_at,
    }
}

#[tokio::test]
async fn fresh_and_repeated_migrations_are_safe() {
    let (directory, _) = database().await;
    SqliteStorage::initialize(directory.path().join("chat.db"))
        .await
        .expect("second initialization should succeed");

    let connection = raw(&directory);
    let migration_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .expect("migration count should be available");
    assert_eq!(migration_count, 3);
}

#[tokio::test]
async fn v2_to_v3_migration_preserves_models_messages_and_reasoning() {
    let directory = TempDir::new().expect("temporary directory should be created");
    let path = directory.path().join("chat.db");
    seed_v2_database(&path);

    let storage = SqliteStorage::initialize(&path)
        .await
        .expect("v2 database should migrate to v3");
    let detail = storage
        .get("c-v2".to_owned())
        .await
        .expect("legacy conversation should remain readable");
    assert_eq!(detail.conversation.model, "model-a");
    assert_eq!(detail.messages.len(), 2);
    assert_eq!(detail.messages[1].model.as_deref(), Some("model-a"));
    assert_eq!(
        detail.messages[1].reasoning.as_deref(),
        Some("legacy reasoning")
    );
    let legacy_generation = storage
        .get_generation("g-v2".to_owned())
        .await
        .expect("legacy generation should remain readable");
    assert_eq!(legacy_generation.generation.model, "model-a");
    assert_eq!(
        legacy_generation.generation.status,
        GenerationStatus::Completed
    );

    let updated = storage
        .update_model("c-v2".to_owned(), "model-b".to_owned(), 20)
        .await
        .expect("v3 should remove the legacy model lock trigger");
    assert_eq!(updated.model, "model-b");
    let persisted = storage
        .get("c-v2".to_owned())
        .await
        .expect("migrated conversation should remain readable");
    assert_eq!(persisted.messages[1].model.as_deref(), Some("model-a"));

    exercise_migrated_current_model(&storage).await;

    let legacy_generation_after_writes = storage
        .get_generation("g-v2".to_owned())
        .await
        .expect("legacy generation should remain readable after v3 writes");
    assert_eq!(legacy_generation_after_writes.generation.model, "model-a");

    let connection = connection::open(&path).expect("migrated database should open");
    let versions: Vec<i64> = connection
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .expect("migration query should prepare")
        .query_map([], |row| row.get(0))
        .expect("migration query should run")
        .collect::<Result<_, _>>()
        .expect("migration versions should decode");
    assert_eq!(versions, [1, 2, 3]);
}

#[tokio::test]
async fn conversation_crud_and_message_mapping_round_trip() {
    let (directory, storage) = database().await;
    let created = storage
        .create(conversation("c1", 100))
        .await
        .expect("conversation should be created");
    assert_eq!(created.title, "Conversation c1");

    raw(&directory)
        .execute(
            "INSERT INTO messages
             (id, conversation_id, client_message_id, role, content, status, model, error_code, created_at, finished_at)
             VALUES ('m1', 'c1', 'client-1', 'user', 'private body', 'completed', NULL, NULL, 101, 101)",
            [],
        )
        .expect("message should insert");
    let detail = storage
        .get("c1".to_owned())
        .await
        .expect("conversation should open");
    assert_eq!(detail.messages.len(), 1);
    assert_eq!(detail.messages[0].content, "private body");

    let renamed = storage
        .rename("c1".to_owned(), "Renamed".to_owned(), 200)
        .await
        .expect("conversation should rename");
    assert_eq!(renamed.title, "Renamed");
    assert_eq!(renamed.updated_at, 200);

    storage
        .delete("c1".to_owned())
        .await
        .expect("conversation should delete");
    let error = storage
        .get("c1".to_owned())
        .await
        .expect_err("deleted conversation should be absent");
    assert_eq!(error.kind(), RepositoryErrorKind::NotFound);
}

#[tokio::test]
async fn invalid_persisted_domain_value_is_corrupt_data() {
    let (directory, storage) = database().await;
    storage
        .create(conversation("c1", 100))
        .await
        .expect("conversation should create");
    let connection = raw(&directory);
    connection
        .pragma_update(None, "ignore_check_constraints", true)
        .expect("test should disable check constraints");
    connection
        .execute(
            "INSERT INTO messages
             (id, conversation_id, client_message_id, role, content, status, model, created_at, finished_at)
             VALUES ('m1', 'c1', 'client-1', 'invalid-role', 'body', 'completed', NULL, 101, 101)",
            [],
        )
        .expect("corrupt fixture should insert");
    drop(connection);

    let error = storage
        .get("c1".to_owned())
        .await
        .expect_err("invalid persisted role should fail mapping");
    assert_eq!(error.kind(), RepositoryErrorKind::CorruptData);
}

#[tokio::test]
async fn deleting_conversation_cascades_messages_and_generations() {
    let (directory, storage) = database().await;
    storage
        .create(conversation("c1", 100))
        .await
        .expect("conversation should create");
    let connection = raw(&directory);
    connection
        .execute(
            "INSERT INTO messages
             (id, conversation_id, role, content, status, model, created_at)
             VALUES ('a1', 'c1', 'assistant', '', 'streaming', 'test-model', 101)",
            [],
        )
        .expect("assistant should insert");
    connection
        .execute(
            "INSERT INTO generations
             (id, conversation_id, assistant_message_id, provider, model, status, started_at)
             VALUES ('g1', 'c1', 'a1', 'openai-compatible', 'test-model', 'streaming', 101)",
            [],
        )
        .expect("generation should insert");
    drop(connection);

    storage
        .delete("c1".to_owned())
        .await
        .expect("conversation should delete");
    let connection = raw(&directory);
    for table in ["messages", "generations"] {
        let count: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("count should be available");
        assert_eq!(count, 0);
    }
}

#[tokio::test]
async fn cursor_pagination_is_stable_with_timestamp_ties() {
    let (_directory, storage) = database().await;
    for item in [
        conversation("a", 100),
        conversation("b", 200),
        conversation("c", 200),
        conversation("d", 300),
    ] {
        storage
            .create(item)
            .await
            .expect("conversation should create");
    }

    let first = storage.list(None, 2).await.expect("first page should load");
    assert_eq!(
        first
            .conversations
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["d", "c"]
    );
    let second = storage
        .list(first.next_cursor, 2)
        .await
        .expect("second page should load");
    assert_eq!(
        second
            .conversations
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["b", "a"]
    );
    assert_eq!(second.next_cursor, None);

    let after_tie = storage
        .list(
            Some(ConversationCursor {
                updated_at: 200,
                id: "c".to_owned(),
            }),
            10,
        )
        .await
        .expect("cursor should load");
    assert_eq!(after_tie.conversations[0].id, "b");
}

#[tokio::test]
async fn model_update_preserves_history_and_rejects_active_generation() {
    let (_directory, storage) = database().await;
    storage
        .create(conversation("c1", 100))
        .await
        .expect("conversation should create");
    let changed = storage
        .update_model("c1".to_owned(), "model-b".to_owned(), 110)
        .await
        .expect("idle conversation model should update");
    assert_eq!(changed.model, "model-b");

    let setup = NewMessageGeneration {
        conversation: None,
        conversation_id: "c1".to_owned(),
        user_message: user_message("u1", "c1", "client-switch", "prompt"),
        assistant_message: Message {
            model: Some("model-b".to_owned()),
            ..assistant_placeholder("a1", "c1")
        },
        generation: Generation {
            model: "model-b".to_owned(),
            ..streaming_generation("g1", "c1", "a1")
        },
    };
    storage
        .create_message_generation(setup)
        .await
        .expect("new generation should snapshot current model");
    let error = storage
        .update_model("c1".to_owned(), "model-c".to_owned(), 120)
        .await
        .expect_err("active generation should block model update");
    assert_eq!(error.kind(), RepositoryErrorKind::GenerationInProgress);
    let detail = storage
        .get("c1".to_owned())
        .await
        .expect("conversation should load");
    assert_eq!(detail.conversation.model, "model-b");
    assert_eq!(
        detail
            .messages
            .iter()
            .find(|message| message.role == MessageRole::Assistant)
            .and_then(|message| message.model.as_deref()),
        Some("model-b")
    );
}

#[tokio::test]
async fn atomic_first_message_is_idempotent_and_finalizes_once() {
    use chat_core::repository::{GenerationFinalization, GenerationSetup, NewMessageGeneration};

    let (directory, storage) = database().await;
    let conversation_id = "c1".to_owned();
    let setup = NewMessageGeneration {
        conversation: Some(conversation(&conversation_id, 100)),
        conversation_id,
        user_message: user_message("u1", "c1", "global-client-id", "private input"),
        assistant_message: assistant_placeholder("a1", "c1"),
        generation: streaming_generation("g1", "c1", "a1"),
    };
    assert!(matches!(
        storage
            .create_message_generation(setup.clone())
            .await
            .expect("first setup should create"),
        GenerationSetup::Created(_)
    ));
    assert!(matches!(
        storage
            .create_message_generation(setup)
            .await
            .expect("duplicate should reconcile"),
        GenerationSetup::Existing(_)
    ));

    let finalization = GenerationFinalization {
        generation_id: "g1".to_owned(),
        assistant_message_id: "a1".to_owned(),
        generation_status: GenerationStatus::Stopped,
        message_status: MessageStatus::Stopped,
        content: "partial output".to_owned(),
        reasoning: None,
        error_code: None,
        input_tokens: Some(2),
        output_tokens: Some(1),
        finished_at: 200,
    };
    assert!(
        storage
            .finalize_generation(finalization.clone())
            .await
            .expect("first finalize should write")
    );
    assert!(
        !storage
            .finalize_generation(finalization)
            .await
            .expect("second finalize should no-op")
    );
    let detail = storage
        .get("c1".to_owned())
        .await
        .expect("conversation should load");
    assert_eq!(detail.messages.len(), 2);
    let persisted_assistant = detail
        .messages
        .iter()
        .find(|message| message.role == MessageRole::Assistant)
        .expect("assistant should be present");
    assert_eq!(persisted_assistant.content, "partial output");
    assert_eq!(persisted_assistant.status, MessageStatus::Stopped);
    let connection = raw(&directory);
    let generation_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM generations", [], |row| row.get(0))
        .expect("count should load");
    assert_eq!(generation_count, 1);
}

#[tokio::test]
async fn assistant_reasoning_persists_through_finalize_and_read() {
    use chat_core::repository::{GenerationFinalization, GenerationSetup, NewMessageGeneration};

    let (directory, storage) = database().await;
    let conversation_id = "c1".to_owned();
    assert!(matches!(
        storage
            .create_message_generation(NewMessageGeneration {
                conversation: Some(conversation(&conversation_id, 100)),
                conversation_id,
                user_message: user_message("u1", "c1", "client-reasoning", "prompt"),
                assistant_message: assistant_placeholder("a1", "c1"),
                generation: streaming_generation("g1", "c1", "a1"),
            })
            .await
            .expect("setup should create"),
        GenerationSetup::Created(_)
    ));
    assert!(
        storage
            .finalize_generation(GenerationFinalization {
                generation_id: "g1".to_owned(),
                assistant_message_id: "a1".to_owned(),
                generation_status: GenerationStatus::Completed,
                message_status: MessageStatus::Completed,
                content: "answer".to_owned(),
                reasoning: Some("full thinking chain".to_owned()),
                error_code: None,
                input_tokens: None,
                output_tokens: None,
                finished_at: 200,
            })
            .await
            .expect("finalize should write")
    );
    let detail = storage
        .get("c1".to_owned())
        .await
        .expect("conversation should load");
    let persisted_assistant = detail
        .messages
        .iter()
        .find(|message| message.role == MessageRole::Assistant)
        .expect("assistant should be present");
    assert_eq!(
        persisted_assistant.reasoning.as_deref(),
        Some("full thinking chain")
    );
    let persisted_user = detail
        .messages
        .iter()
        .find(|message| message.role == MessageRole::User)
        .expect("user should be present");
    assert_eq!(persisted_user.reasoning, None);

    // The column CHECK keeps reasoning assistant-only at the SQL level.
    raw(&directory)
        .execute(
            "INSERT INTO messages
             (id, conversation_id, client_message_id, role, content, status, model, error_code, created_at, finished_at, reasoning)
             VALUES ('m9', 'c1', 'client-9', 'user', 'x', 'completed', NULL, NULL, 300, 300, 'not allowed')",
            [],
        )
        .expect_err("user reasoning should violate the CHECK constraint");
}

#[tokio::test]
async fn duplicate_client_message_id_is_rejected_across_conversations() {
    let (directory, storage) = database().await;
    for id in ["c1", "c2"] {
        storage
            .create(conversation(id, 100))
            .await
            .expect("conversation should create");
    }
    let connection = raw(&directory);
    connection
        .execute(
            "INSERT INTO messages
             (id, conversation_id, client_message_id, role, content, status, model, created_at, finished_at)
             VALUES ('m1', 'c1', 'same-client-id', 'user', 'one', 'completed', NULL, 101, 101)",
            [],
        )
        .expect("first message should insert");
    let duplicate = connection.execute(
        "INSERT INTO messages
         (id, conversation_id, client_message_id, role, content, status, model, created_at, finished_at)
         VALUES ('m2', 'c2', 'same-client-id', 'user', 'two', 'completed', NULL, 102, 102)",
        [],
    );
    assert!(duplicate.is_err());
    drop(connection);
    let existing = storage
        .find_by_client_message_id("same-client-id".to_owned())
        .await
        .expect("idempotency lookup should succeed")
        .expect("existing logical result should be returned");
    assert_eq!(existing.conversation.id, "c1");
    assert_eq!(existing.messages.len(), 1);

    let connection = raw(&directory);
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
        .expect("message count should be available");
    assert_eq!(count, 1);
}

#[tokio::test]
async fn active_generation_conflict_rolls_back_assistant_placeholder() {
    let (directory, storage) = database().await;
    storage
        .create(conversation("c1", 100))
        .await
        .expect("conversation should create");

    let message = |id: &str, created_at| Message {
        id: id.to_owned(),
        conversation_id: "c1".to_owned(),
        client_message_id: None,
        role: MessageRole::Assistant,
        content: String::new(),
        reasoning: None,
        status: MessageStatus::Streaming,
        model: Some("test-model".to_owned()),
        error_code: None,
        created_at,
        finished_at: None,
    };
    let generation = |id: &str, assistant_message_id: &str, started_at| Generation {
        id: id.to_owned(),
        conversation_id: "c1".to_owned(),
        assistant_message_id: assistant_message_id.to_owned(),
        provider: "provider".to_owned(),
        model: "test-model".to_owned(),
        status: GenerationStatus::Streaming,
        input_tokens: None,
        output_tokens: None,
        started_at,
        finished_at: None,
    };

    storage
        .create_generation(message("a1", 101), generation("g1", "a1", 101))
        .await
        .expect("first generation should create");
    let conflict = storage
        .create_generation(message("a2", 102), generation("g2", "a2", 102))
        .await
        .expect_err("second active generation should conflict");
    assert_eq!(conflict.kind(), RepositoryErrorKind::Conflict);

    let connection = raw(&directory);
    let message_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
        .expect("message count should load");
    assert_eq!(
        message_count, 1,
        "failed transaction must roll back message"
    );
}

#[tokio::test]
async fn only_one_active_generation_is_allowed_per_conversation() {
    let (directory, storage) = database().await;
    storage
        .create(conversation("c1", 100))
        .await
        .expect("conversation should create");
    let connection = raw(&directory);
    for id in ["a1", "a2", "a3"] {
        connection
            .execute(
                "INSERT INTO messages
                 (id, conversation_id, role, content, status, model, created_at)
                 VALUES (?1, 'c1', 'assistant', '', 'streaming', 'test-model', 101)",
                [id],
            )
            .expect("assistant should insert");
    }
    connection
        .execute(
            "INSERT INTO generations
             (id, conversation_id, assistant_message_id, provider, model, status, started_at)
             VALUES ('g1', 'c1', 'a1', 'provider', 'test-model', 'pending', 101)",
            [],
        )
        .expect("first active generation should insert");
    assert!(
        connection
            .execute(
                "INSERT INTO generations
                 (id, conversation_id, assistant_message_id, provider, model, status, started_at)
                 VALUES ('g2', 'c1', 'a2', 'provider', 'test-model', 'streaming', 102)",
                [],
            )
            .is_err()
    );
    connection
        .execute(
            "UPDATE generations SET status = 'completed', finished_at = 103 WHERE id = 'g1'",
            [],
        )
        .expect("generation should complete");
    connection
        .execute(
            "INSERT INTO generations
             (id, conversation_id, assistant_message_id, provider, model, status, started_at)
             VALUES ('g3', 'c1', 'a3', 'provider', 'test-model', 'streaming', 104)",
            [],
        )
        .expect("new generation should insert after terminal state");
}

#[tokio::test]
async fn startup_recovery_interrupts_unfinished_rows_and_preserves_content() {
    let (directory, storage) = database().await;
    storage
        .create(conversation("c1", 100))
        .await
        .expect("conversation should create");
    let connection = raw(&directory);
    connection
        .execute(
            "INSERT INTO messages
             (id, conversation_id, role, content, status, model, created_at)
             VALUES ('a1', 'c1', 'assistant', 'partial private output', 'streaming', 'test-model', 101)",
            [],
        )
        .expect("assistant should insert");
    connection
        .execute(
            "INSERT INTO generations
             (id, conversation_id, assistant_message_id, provider, model, status, started_at)
             VALUES ('g1', 'c1', 'a1', 'provider', 'test-model', 'cancelling', 101)",
            [],
        )
        .expect("generation should insert");
    drop(connection);

    SqliteStorage::initialize(directory.path().join("chat.db"))
        .await
        .expect("restart should recover");
    let connection = raw(&directory);
    let (message_status, content, error_code): (String, String, String) = connection
        .query_row(
            "SELECT status, content, error_code FROM messages WHERE id = 'a1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("message should load");
    let generation_status: String = connection
        .query_row(
            "SELECT status FROM generations WHERE id = 'g1'",
            [],
            |row| row.get(0),
        )
        .expect("generation should load");
    assert_eq!(message_status, "interrupted");
    assert_eq!(content, "partial private output");
    assert_eq!(error_code, "generation_interrupted");
    assert_eq!(generation_status, "interrupted");
}

#[tokio::test]
async fn schema_enforces_assistant_generation_link_and_allows_model_changes() {
    let (directory, storage) = database().await;
    storage
        .create(conversation("c1", 100))
        .await
        .expect("conversation should create");
    storage
        .create(conversation("c2", 100))
        .await
        .expect("conversation should create");
    let connection = raw(&directory);
    connection
        .execute(
            "INSERT INTO messages
             (id, conversation_id, client_message_id, role, content, status, model, created_at, finished_at)
             VALUES ('u1', 'c1', 'client-1', 'user', 'body', 'completed', NULL, 101, 101)",
            [],
        )
        .expect("user message should insert");
    connection
        .execute(
            "INSERT INTO messages
             (id, conversation_id, role, content, status, model, created_at)
             VALUES ('a2', 'c2', 'assistant', '', 'streaming', 'test-model', 102)",
            [],
        )
        .expect("assistant should insert");

    connection
        .pragma_update(None, "foreign_keys", false)
        .expect("test should disable foreign keys");
    assert!(
        connection
            .execute(
                "INSERT INTO generations
                 (id, conversation_id, assistant_message_id, provider, model, status, started_at)
                 VALUES ('g-missing', 'c1', 'missing', 'provider', 'test-model', 'pending', 103)",
                [],
            )
            .is_err(),
        "trigger must reject a missing assistant when foreign keys are disabled"
    );
    connection
        .pragma_update(None, "foreign_keys", true)
        .expect("test should restore foreign keys");
    assert!(
        connection
            .execute(
                "INSERT INTO generations
                 (id, conversation_id, assistant_message_id, provider, model, status, started_at)
                 VALUES ('g-user', 'c1', 'u1', 'provider', 'test-model', 'pending', 103)",
                [],
            )
            .is_err()
    );
    assert!(
        connection
            .execute(
                "INSERT INTO generations
                 (id, conversation_id, assistant_message_id, provider, model, status, started_at)
                 VALUES ('g-other', 'c1', 'a2', 'provider', 'test-model', 'pending', 103)",
                [],
            )
            .is_err()
    );
    connection
        .execute(
            "UPDATE conversations SET model = 'changed' WHERE id = 'c1'",
            [],
        )
        .expect("mutable current model should update after messages exist");
}

#[tokio::test]
async fn foreign_keys_reject_orphan_rows() {
    let (directory, _storage) = database().await;
    let result = raw(&directory).execute(
        "INSERT INTO messages
         (id, conversation_id, client_message_id, role, content, status, model, created_at, finished_at)
         VALUES ('m1', 'missing', 'orphan-client', 'user', 'body', 'completed', NULL, 100, 100)",
        params![],
    );
    assert!(result.is_err());
}

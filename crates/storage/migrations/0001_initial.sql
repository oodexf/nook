CREATE TABLE conversations (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    model       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_conversations_updated_at_id
    ON conversations(updated_at DESC, id DESC);

CREATE TABLE messages (
    id                  TEXT PRIMARY KEY,
    conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    client_message_id   TEXT NULL,
    role                TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content             TEXT NOT NULL,
    status              TEXT NOT NULL CHECK (status IN ('completed', 'streaming', 'stopped', 'error', 'interrupted')),
    model               TEXT NULL,
    error_code          TEXT NULL,
    created_at          INTEGER NOT NULL,
    finished_at         INTEGER NULL,
    CHECK (
        (role = 'assistant' AND model IS NOT NULL AND client_message_id IS NULL)
        OR (role = 'user' AND model IS NULL AND client_message_id IS NOT NULL AND status = 'completed')
    ),
    CHECK (
        (status = 'streaming' AND role = 'assistant' AND finished_at IS NULL)
        OR (status != 'streaming' AND finished_at IS NOT NULL)
    )
) STRICT;

CREATE INDEX idx_messages_conversation_created_at_id
    ON messages(conversation_id, created_at ASC, id ASC);
CREATE UNIQUE INDEX idx_messages_conversation_id_id
    ON messages(conversation_id, id);
CREATE UNIQUE INDEX idx_messages_client_message_id
    ON messages(client_message_id)
    WHERE client_message_id IS NOT NULL;

CREATE TABLE generations (
    id                    TEXT PRIMARY KEY,
    conversation_id       TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    assistant_message_id  TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    provider              TEXT NOT NULL,
    model                 TEXT NOT NULL,
    status                TEXT NOT NULL CHECK (status IN ('pending', 'streaming', 'cancelling', 'completed', 'stopped', 'error', 'interrupted')),
    input_tokens          INTEGER NULL,
    output_tokens         INTEGER NULL,
    started_at            INTEGER NOT NULL,
    finished_at           INTEGER NULL,
    CHECK (
        (status IN ('pending', 'streaming', 'cancelling') AND finished_at IS NULL)
        OR (status NOT IN ('pending', 'streaming', 'cancelling') AND finished_at IS NOT NULL)
    ),
    FOREIGN KEY (conversation_id, assistant_message_id)
        REFERENCES messages(conversation_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_generations_conversation_started_at_id
    ON generations(conversation_id, started_at ASC, id ASC);
CREATE UNIQUE INDEX idx_generations_active_conversation
    ON generations(conversation_id)
    WHERE status IN ('pending', 'streaming', 'cancelling');

CREATE TRIGGER trg_generations_assistant_message_insert
BEFORE INSERT ON generations
WHEN NOT EXISTS (
    SELECT 1
    FROM messages
    WHERE id = NEW.assistant_message_id
      AND conversation_id = NEW.conversation_id
      AND role = 'assistant'
)
BEGIN
    SELECT RAISE(ABORT, 'generation message must be an assistant in its conversation');
END;

CREATE TRIGGER trg_conversations_model_locked
BEFORE UPDATE OF model ON conversations
WHEN NEW.model != OLD.model
 AND EXISTS (SELECT 1 FROM messages WHERE conversation_id = OLD.id)
BEGIN
    SELECT RAISE(ABORT, 'conversation model is locked');
END;

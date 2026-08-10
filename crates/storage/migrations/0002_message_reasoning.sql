ALTER TABLE messages ADD COLUMN reasoning TEXT NULL
    CHECK (reasoning IS NULL OR role = 'assistant');

# Database Guidelines

## Scope

SQLite is the only MVP database. Access it through explicit SQL and repository
implementations; no ORM is part of the baseline.

Evidence:

- MVP `design.md` sections 8, 11, 14, and 17.

## Connection Configuration

Every connection enables:

```sql
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

Database initialization enables:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
```

The database file defaults to `/data/chat.db` in production. Never place it on
NFS, SMB, or another network filesystem.

## Query Ownership

- SQL exists only in the storage layer.
- Bind every value; never construct SQL from user or provider strings.
- Map rows into storage records, then into core entities.
- Repository methods expose domain concepts, not arbitrary query fragments.
- Keep write transactions short and free of provider/network calls.
- Use deterministic ordering with an ID tie-breaker for pagination.

Forbidden:

- SQL in Axum handlers;
- returning `rusqlite::Row` outside storage;
- accepting table names, column names, or sort expressions from HTTP input;
- silently treating a missing row as an empty entity.

## Transactions

The first-message flow uses one transaction for:

1. conversation creation and immutable model assignment;
2. user message insertion;
3. assistant placeholder insertion;
4. generation insertion.

Commit before calling the provider. Final generation content/state is written in
one short transaction on completion, cancellation, or failure.

Never hold a SQLite transaction while:

- awaiting provider I/O;
- streaming to the browser;
- waiting on a cancellation token;
- performing model catalog refresh.

## Schema Rules

- Tables and columns use `snake_case`.
- Application IDs are TEXT using the single project-selected UUID v7 or ULID
  representation.
- Public timestamps are stored as UTC Unix milliseconds in INTEGER columns.
- Foreign keys declare their delete behavior.
- Assistant messages store the historical model ID even though conversations
  also store their locked model.
- Status columns use core-defined values; SQL and HTTP layers do not invent
  additional spellings.

Index names use:

```text
idx_<table>_<columns-or-purpose>
```

Unique partial indexes enforce:

- non-null `client_message_id` idempotency;
- one active generation per conversation.

## Migrations

- Migration files are ordered and immutable after release.
- The binary embeds and applies pending migrations at startup.
- Each migration is recorded in `schema_migrations`.
- Migration execution is transactional when SQLite supports the operations.
- Do not edit an already released migration; add a new one.
- Destructive changes use expand/contract releases.

Initial migration tests cover:

- empty database;
- repeated startup;
- foreign-key cascade;
- indexes and constraints;
- startup recovery from `streaming` to `interrupted`.

## Backup and Recovery

Use SQLite's backup API or the application backup command. Copying only
`chat.db` while WAL writes may be active is not an accepted backup.

Schema-affecting releases require a verified pre-migration backup and a restore
test.

## Tests

Repository tests use a unique temporary local database per test or isolated test
case. They must not share the developer database or depend on execution order.


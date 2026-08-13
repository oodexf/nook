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

1. conversation creation and initial current-model assignment;
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
- Assistant messages store the historical model ID while conversations store the mutable current model for the next generation.
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

Initial migration and connection management are implemented in
`crates/storage/migrations/0001_initial.sql`,
`crates/storage/src/connection.rs`, and `crates/storage/src/migration.rs`.
`SqliteStorage` opens a fresh configured connection for each repository operation
inside `tokio::task::spawn_blocking`; migrations and startup recovery run before
the HTTP listener starts.

The schema uses deterministic `(updated_at DESC, id DESC)` conversation ordering,
a global partial unique `client_message_id` index, a partial active-generation
index, composite foreign keys to keep generations in the assistant message's
conversation, and triggers to enforce assistant-only generation links. Migration 0003 removes
the former conversation-model lock trigger; current-model updates are now an
explicit repository transaction that rejects active generations. The generation-link trigger uses
`NOT EXISTS` over message ID, conversation ID, and assistant role so a missing
row cannot bypass enforcement through SQL NULL comparison semantics.

Persisted enum/status conversion failures, column type mismatches, and integer
representation failures are categorized as corrupt data, not transient storage
unavailability.

Phase E generation persistence is implemented in
`crates/storage/src/generation_repository.rs`. First-message creation inserts the
conversation with its initial current model, globally keyed user message, assistant
placeholder, and generation in one blocking-pool transaction, then commits
before provider I/O. Retry setup validates the latest assistant and appends new
rows. Terminal finalization conditionally transitions only active rows and
writes accumulated/partial content once in one short transaction; repeated
finalization is a no-op.

## Tests

Repository tests use a unique temporary local database per test or isolated test
case. They must not share the developer database or depend on execution order.

Production deployment and operations are implemented in `crates/server/src/main.rs`,
`crates/server/src/static_assets.rs`, `crates/storage/src/lib.rs`, `Dockerfile`,
`compose.yaml`, and `README.md`. The `chat-server backup <destination.db>`
command uses rusqlite's online backup API and atomically renames a complete
temporary database into place; it rejects the live database path as the
destination. `GET /api/v1/health/ready` checks both validated configuration and
a fresh SQLite `SELECT 1`, while the container `healthcheck` subcommand probes
liveness over loopback without credentials.

All responses receive CSP, `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy`, and COOP headers. Embedded `index.html` is `no-cache`;
Vite hashed assets are `public, max-age=31536000, immutable`. The release image
runs as `10001:10001`, writes persistently only to `/data`, and the Compose
baseline adds a read-only root, `/tmp` tmpfs, localhost binding, and
`no-new-privileges`. SIGTERM cancels every registered generation before Axum's
graceful shutdown waits for in-flight requests.

## Scenario: Online SQLite Backup and Runtime Health

### 1. Scope / Trigger

Use this contract for deployment health probes, pre-upgrade backups, restore
operations, and container hardening changes.

### 2. Signatures

```text
chat-server healthcheck
chat-server backup <destination.db>
GET /api/v1/health/live
GET /api/v1/health/ready
SqliteStorage::backup(destination: impl AsRef<Path>) -> Result<(), StorageError>
```

### 3. Contracts

- `DATABASE_PATH` identifies the live local SQLite database.
- Backup destination must differ from `DATABASE_PATH`; parent directories are
  created and incomplete temporary files are removed on failure.
- Liveness checks only process reachability; readiness checks configuration and
  database access and never call the provider.
- Health bodies contain only `{"status":"..."}` and no configuration.
- Backup/restore is done while respecting WAL: never copy only the live main
  database file.

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Missing backup destination | exit 2 with usage text |
| Invalid required environment | exit 2; no secret value logged |
| Destination equals live database | backup fails without touching live data |
| SQLite backup failure | exit 1; incomplete temporary file removed |
| Database unavailable at readiness | HTTP 503 `not_ready` |
| Liveness reachable | HTTP 200 `ok` |

### 5. Good / Base / Bad Cases

- Good: online backup opens as fresh storage and contains an existing
  conversation.
- Base: readiness performs a local SQLite query while the provider is offline.
- Bad: copying `chat.db` alone during WAL activity is not a supported backup.

### 6. Tests Required

- Storage integration creates a conversation, backs up, initializes the backup,
  and reads the same conversation.
- API integration asserts readiness and security headers.
- Release smoke asserts UID/GID, read-only-root deployment, healthcheck,
  SIGTERM, and backup integrity.
- Multi-architecture build covers Linux AMD64 and ARM64.

### 7. Wrong vs Correct

#### Wrong

```text
cp /data/chat.db backup.db  # live WAL may be omitted
```

#### Correct

```text
/app/chat-server backup /data/chat-backup.db
sqlite3 /data/chat-backup.db 'PRAGMA integrity_check;'
```

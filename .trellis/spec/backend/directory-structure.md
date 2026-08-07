# Backend Directory Structure

## Current Layout

The approved design owns this initial layout:

```text
Cargo.toml
crates/
  core/
    src/
      conversation.rs
      generation.rs
      provider.rs
      repository.rs
      error.rs
  storage/
    migrations/
    src/
      connection.rs
      conversation_repository.rs
      migration.rs
  server/
    src/
      api/
      auth/
      provider/
      config.rs
      request_context.rs
      state.rs
      static_assets.rs
      main.rs
```

The workspace manifests are `Cargo.toml`, `crates/core/Cargo.toml`,
`crates/storage/Cargo.toml`, and `crates/server/Cargo.toml`. Phase A establishes
the three crates and the real server modules `config.rs` and
`static_assets.rs`; later feature directories are added only when their
vertical slice starts.

Evidence:

- `design.md` sections 3 and 4 in the active MVP task.

Phase C adds real domain modules `conversation.rs`, `generation.rs`, and
`repository.rs`; SQLite modules `connection.rs`, `migration.rs`, and
`conversation_repository.rs`; the embedded migration under
`crates/storage/migrations/`; and server-owned HTTP boundaries
`crates/server/src/conversations.rs` and `crates/server/src/request_context.rs`.

Phase D adds core-owned model contracts in `crates/core/src/model.rs`, normalized
provider URL and wire DTO ownership in `crates/server/src/provider.rs`, cache and
availability service ownership in `crates/server/src/model_catalog.rs`, and
public model DTO/handler ownership in `crates/server/src/models.rs`. Provider
JSON types must not move into core, and public model DTOs must not be reused as
provider rows.

Phase E adds `crates/core/src/provider.rs`,
`crates/storage/src/generation_repository.rs`, and server-owned
`crates/server/src/chat.rs` / `generation_registry.rs`. Core owns normalized
chat/context/error contracts; storage owns setup/retry/finalization SQL; server
owns OpenAI wire decoding, public SSE, authenticated handlers, and live
cancellation tokens.

## Ownership

### `core`

- Domain entities and state transitions;
- application commands and services;
- repository and provider traits;
- domain error taxonomy.

It must not import:

- Axum request/response types;
- Reqwest;
- Rusqlite rows or connections;
- environment variables;
- JSON payload structs created only for an external boundary.

### `storage`

- SQLite connection settings;
- embedded migrations;
- SQL and row mapping;
- repository trait implementations;
- startup recovery for interrupted generations.

SQL belongs here, not in HTTP handlers or core services.

### `server`

- process startup and shutdown;
- typed configuration;
- Axum routes and middleware;
- public DTOs and SSE encoding;
- cookie and CSRF mechanics;
- provider HTTP adapters;
- embedded static assets.

Handlers remain thin: decode, validate, call an application service, and encode.

## Naming

- Rust modules and files use `snake_case`.
- Domain types use nouns: `Conversation`, `Generation`.
- Commands describe intent: `CreateMessage`, `CancelGeneration`.
- Boundary DTOs include direction when ambiguity exists:
  `CreateMessageRequest`, `ConversationResponse`.
- Repository implementations name their storage:
  `SqliteConversationRepository`.
- Do not create generic `utils.rs`, `helpers.rs`, or `common.rs`. Put a function
  with the concept it serves.

## Dependency Direction

```text
server ──► core
storage ─► core
server ──► storage composition
core ────► nothing infrastructure-specific
```

Circular crate or module dependencies are forbidden.

For example, `crates/server/src/config.rs` owns environment decoding and
validation, while `crates/server/src/static_assets.rs` owns the embedded Vite
artifact response. Neither concern belongs in `core`.

Authentication is owned by `crates/server/src/auth.rs`: stateless session
signing, cookie parsing, Origin/CSRF validation, rate limiting, and session HTTP
handlers remain together until a second authentication adapter requires a
deeper split.

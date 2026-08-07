# Backend Directory Structure

## Planned Layout

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
      state.rs
      static_assets.rs
      main.rs
```

If Phase A proves a single crate is materially simpler, keep the same module
boundaries under `src/`. Do not collapse responsibilities merely to reduce the
number of directories.

Evidence:

- `design.md` sections 3 and 4 in the active MVP task.

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

## Spec Update Requirement

After Phase A, update this guide with actual manifest paths and at least one
real module example before adding the second backend feature.


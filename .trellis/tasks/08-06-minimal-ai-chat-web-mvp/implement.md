# Minimal AI Chat Web MVP — Implementation Plan

## 1. Planning Gate

Do not run `task.py start` until:

- this PRD and design have explicit user approval;
- the separate `00-bootstrap-guidelines` task has populated the backend and
  frontend spec files with conventions appropriate for this greenfield stack;
- `implement.jsonl` and `check.jsonl` have been revalidated against the completed
  specs;
- the task validation command succeeds.

The work is delivered as vertical, runnable slices. Do not build all backend
layers before proving a browser-to-database path.

## 2. Phase A — Project Foundation

- [x] `A-01` Complete the Trellis bootstrap-guidelines task for Rust/Axum,
      Svelte/TypeScript, SQLite, testing, logging, and accessibility conventions.
- [x] `A-02` Initialize Cargo workspace or approved module-equivalent structure.
- [x] `A-03` Initialize Svelte + TypeScript + Vite.
- [x] `A-04` Add formatting, lint, type-check, unit-test, and release-build
      commands.
- [x] `A-05` Implement typed configuration loading and secret-safe validation.
- [x] `A-06` Implement Axum liveness endpoint and graceful shutdown.
- [x] `A-07` Build frontend assets and embed them into the Rust binary.
- [x] `A-08` Add a first multi-stage Dockerfile and non-root runtime.
- [x] `A-09` Add CI for formatting, lint, type-check, tests, and release build.

### Validation

```text
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
frontend type-check command
frontend unit-test command
frontend production-build command
docker build
container liveness smoke test
```

### Rollback point

The repository can be returned to a compiling health-page skeleton without
database or provider code.

## 3. Phase B — Authentication Vertical Slice

- [x] `B-01` Define session claims, expiry, signing, and token-rotation behavior.
- [x] `B-02` Implement `POST`, `GET`, and `DELETE /api/v1/session`.
- [x] `B-03` Add constant-time token comparison and authentication rate limiting.
- [x] `B-04` Add HttpOnly, SameSite, Secure/session/30-day cookie behavior.
- [x] `B-05` Add authentication middleware to all non-public API routes.
- [x] `B-06` Add session-bound CSRF token and same-origin validation to all
      state-changing routes.
- [x] `B-07` Build session bootstrap and dedicated authentication page.
- [x] `B-08` Implement unchecked-by-default "Remember me" and sign-out.
- [x] `B-09` Add auth integration, cookie, expiry, rotation, CSRF, and rate-limit
      tests.

### Validation

- unauthenticated API requests are rejected;
- health endpoints remain public and safe;
- browser-session and remembered cookies have correct attributes;
- raw token is absent from storage, logs, and browser bundles;
- rotating `APP_ACCESS_TOKEN` invalidates existing sessions.
- cross-origin state-changing requests fail with a valid session cookie.

### Rollback point

Authentication can be removed while retaining the public static shell and
health endpoint; no persistent data exists yet.

## 4. Phase C — SQLite and Conversation CRUD

- [x] `C-01` Add SQLite connection management and required PRAGMAs.
- [x] `C-02` Add embedded transactional migration runner.
- [x] `C-03` Create conversations, messages, generations, and migrations schema.
- [x] `C-04` Implement repositories with explicit SQL and domain mapping.
- [x] `C-05` Implement conversation pagination, open, rename, and delete APIs.
- [x] `C-06` Add startup recovery from streaming to interrupted.
- [x] `C-07` Add client-message idempotency and active-generation constraints.
- [x] `C-08` Build sidebar and empty-conversation UI against real APIs.
- [x] `C-09` Add repository and CRUD integration tests.

### Validation

```text
fresh database migration
second startup with no migration changes
CRUD round-trip
foreign-key cascade
cursor pagination
duplicate client_message_id
active-generation unique constraint
container restart with mounted volume
```

### Rollback point

Back up the database before changing migration code. During initial development,
an explicitly disposable development database may be recreated; production-like
test data must use forward migrations.

## 5. Phase D — Model Catalog and Conversation Model

- [x] `D-01` Define provider model DTOs and normalized catalog types.
- [x] `D-02` Normalize `AI_BASE_URL` once for all provider endpoints.
- [x] `D-03` Implement authenticated provider `/v1/models` fetch.
- [x] `D-04` Add deterministic filtering, deduplication, sorting, and error
      mapping.
- [x] `D-05` Add in-memory TTL cache, explicit refresh, and stale-cache behavior.
- [x] `D-06` Validate `AI_DEFAULT_MODEL` against the catalog.
- [x] `D-07` Implement authenticated `/api/v1/models` and refresh endpoints.
- [x] `D-08` Build draft-conversation model selector and model error states.
- [x] `D-09` Persist one immutable model on conversation creation. **Phase E
      boundary:** the schema trigger locks model changes after a message, and the
      first-message transaction now persists the conversation/model together
      with user message, assistant placeholder, and generation.
- [x] `D-10` Display the locked model on existing conversations. Historical
      conversations retain their stored model and visibly indicate when it is
      absent from the current catalog.
- [x] `D-11` Test missing/duplicate/malformed/empty/stale/removed model cases.

### Validation

- provider credentials never reach the browser;
- an empty draft can change its model;
- the first message locks the selected model;
- API attempts to change a non-empty conversation return `model_locked`;
- removed models preserve history and block new generation without substitution.

### Rollback point

Conversation creation must not be released before both model validation and
database assignment occur in the same application flow.

## 6. Phase E — Streaming Chat Vertical Slice

- [x] `E-01` Define `ChatProvider` and provider error taxonomy.
- [x] `E-02` Implement OpenAI-compatible streaming request and upstream SSE
      decoder.
- [x] `E-03` Implement bounded conversation context selection.
- [x] `E-04` Implement transactional user/assistant/generation creation.
- [x] `E-05` Implement public SSE event encoder.
- [x] `E-06` Implement generation registry and cancellation tokens.
- [x] `E-07` Finalize completed/stopped/error message states with one database
      write of accumulated content.
- [x] `E-08` Build one central frontend SSE decoder from `unknown`.
- [x] `E-09` Build composer, message list, streaming buffer, and state machine.
- [x] `E-10` Implement AbortController plus explicit cancel request.
- [x] `E-11` Implement retry of the latest assistant response.
- [x] `E-12` Add fake provider with deterministic success and failure scripts.

### Validation

- `meta` is first and exactly one terminal event is present;
- Unicode split across transport chunks is decoded correctly;
- ten-turn chat has no cross-conversation updates;
- cancel drops upstream work and persists partial output;
- provider 401, 429, timeout, 5xx, malformed stream, and mid-stream disconnect
  produce the documented states;
- retries do not overwrite old responses;
- repeated submissions do not duplicate messages.

### Rollback point

The fake provider remains the default in automated tests. Real-provider failures
must never require destructive database repair.

## 7. Phase F — Complete Browser Experience

- [x] `F-01` Implement responsive app shell, desktop sidebar, and mobile drawer.
- [x] `F-02` Implement auto-resizing composer and IME-safe keyboard behavior.
- [x] `F-03` Implement auto-follow, user-scroll detection, and return-to-bottom.
- [x] `F-04` Implement safe Markdown parsing and sanitization.
- [x] `F-05` Add message and code-block copy actions.
- [x] `F-06` Add inline error/recovery states and accessible announcements.
- [x] `F-07` Add conversation rename and permanent-delete confirmation.
- [x] `F-08` Persist only allowed UI preferences and unsent drafts.
- [x] `F-09` Add reduced-motion, keyboard, focus, contrast, and touch-target checks.

### Validation

```text
375x667
390x844
768x1024
1024x768
1440x900
desktop IME
mobile software keyboard
keyboard-only navigation
screen-reader smoke test
100 KB streamed response
```

### Rollback point

Visual refinements may be reverted independently, but message state, auth
boundaries, and sanitizer behavior are not styling concerns and must remain.

## 8. Phase G — Deployment, Security, and Recovery

- [x] `G-01` Add security headers and same-origin policy.
- [x] `G-02` Add body, message, context, concurrency, and timeout limits.
- [x] `G-03` Add structured request/provider/generation logs with redaction tests.
- [x] `G-04` Add readiness database check and application healthcheck subcommand.
- [x] `G-05` Add Compose example with localhost binding, `/data`, read-only root,
      tmpfs, and `no-new-privileges`.
- [x] `G-06` Add reverse-proxy examples that disable SSE buffering.
- [x] `G-07` Add SQLite backup command using the backup API.
- [x] `G-08` Document and execute restore, upgrade, and rollback drills.
- [x] `G-09` Verify SIGTERM drain and bounded shutdown.
- [x] `G-10` Build and smoke-test AMD64 and ARM64 release images.

### Validation

- non-root, read-only runtime passes;
- data survives container replacement;
- backup restores into a fresh container;
- no secrets or conversation bodies appear in logs;
- readiness fails safely when database is unavailable;
- proxy preserves incremental streaming;
- shutdown does not leave completed generations marked streaming.

### Rollback point

Every schema-affecting release requires a pre-migration backup. Immutable image
tags and documented environment configuration are required for application
rollback.

## 9. Phase H — Release Gate

- [x] `H-01` Run full Rust and frontend quality commands.
- [x] `H-02` Run API, repository, auth, provider, and Docker integration suites.
- [ ] `H-03` Run browser E2E for auth, models, chat, cancel, retry, refresh,
      restart, rename, and delete.
- [x] `H-04` Run Markdown XSS and authentication security suites.
- [ ] `H-05` Manually verify Safari and iOS Safari.
- [x] `H-06` Record idle RSS, frontend asset size, and bounded load results.
      Local release smoke measured approximately 9.7 MiB idle RSS; built assets
      total approximately 194 KiB uncompressed / 63 KiB gzip, and component
      coverage includes a 100 KiB streamed response without per-token Markdown
      parsing.
- [x] `H-07` Reconcile README, environment variables, API docs, and actual
      behavior.
- [x] `H-08` Run Trellis check and resolve every verified blocking finding.
- [ ] `H-09` Complete Trellis spec update, commit, finish, and archive workflow.

## 10. Required Test Fixtures

The fake provider must cover:

```text
valid model catalog
duplicate model IDs
empty and malformed model catalog
model catalog auth/rate-limit/timeout/5xx
successful token stream
timeout before first token
401, 429, and 5xx before first token
invalid upstream SSE
Unicode split across chunks
disconnect after partial output
stream that never terminates
delayed cancellation
usage present and absent
```

## 11. Files With Elevated Risk

Once created, changes to these areas require focused review:

- database migrations;
- session signing and cookie creation;
- provider base-URL normalization;
- provider and public SSE decoders;
- Markdown sanitizer configuration;
- generation finalization and cancellation;
- Docker user, filesystem, and volume configuration;
- log field construction.

## 12. Task Decomposition Note

This task retains the integrated requirements and design. Before implementation,
it may be converted into a Trellis parent with child tasks aligned to Phases
A–H if independent review and archival are preferred. Dependencies remain
ordered; creating child tasks does not make later phases executable early.

# Backend Quality Guidelines

## Required Checks

The backend quality gate includes:

```text
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --workspace --release
```

Phase A may name wrapper commands, but they must execute these capabilities.

## Required Patterns

- Validate untrusted input at the owning boundary.
- Use typed domain states and exhaustive matching.
- Propagate cancellation through provider calls and streaming bodies.
- Keep network I/O outside database transactions.
- Use one owner for every serialized contract.
- Add a request ID to public failures and structured logs.
- Keep provider, database, and HTTP types separate.
- Test final persisted state, not only returned status.

## Forbidden Patterns

- `unwrap` or `expect` on runtime input paths;
- catch-all `Box<dyn Error>` as a public application contract;
- string-based error classification;
- blocking SQLite work directly on async executor threads;
- per-token database writes;
- spawning detached tasks without owned cancellation and shutdown behavior;
- global mutable state outside the composed application state;
- secrets or conversation bodies in logs;
- raw provider JSON passed to frontend components;
- silent model substitution;
- network calls while holding a database transaction.

`unwrap` may appear in tests or compile-time/static initialization only when the
invariant is obvious and documented.

## Test Layers

- Core unit tests: state transitions, context selection, title/model rules.
- Storage integration tests: migrations, constraints, CRUD, recovery.
- API tests: auth, CSRF, validation, error DTOs, request IDs.
- Provider tests: model normalization, upstream SSE, error taxonomy.
- End-to-end service tests: cancellation, retry, restart, idempotency.
- Docker smoke tests: non-root, read-only root, health, persistent volume.

External paid providers are never required for automated tests. Use the
deterministic fake provider described in the approved implementation plan.

## Review Checklist

- Does the change preserve one model per conversation?
- Can duplicate or concurrent requests violate state constraints?
- Does cancellation reach all owned tasks and connections?
- Is the transaction boundary short and explicit?
- Are all new error variants mapped and tested?
- Are logs safe under both success and failure?
- Do API/SSE changes update the frontend decoder and cross-layer tests?
- Does a new dependency solve a documented requirement with minimal features?
- Are migrations forward-only and recoverable?

## Greenfield Follow-up

After the first backend vertical slice, update this guide with real test command
names and representative source/test paths.


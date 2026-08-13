# Backend Development Guidelines

## Status and Evidence

This is a greenfield Rust backend. No application source exists at the time of
this baseline. These rules are derived from the approved contracts in:

- `.trellis/tasks/08-06-minimal-ai-chat-web-mvp/prd.md`
- `.trellis/tasks/08-06-minimal-ai-chat-web-mvp/design.md`

They are binding implementation constraints, not claims about existing source
patterns. After the first vertical slice, replace planned-path references with
real source and test examples during the required Trellis spec-update phase.

## Guides

| Guide | Owns |
|---|---|
| [Directory Structure](./directory-structure.md) | Rust workspace and module ownership |
| [API Contracts](./api-contracts.md) | HTTP DTOs, sessions, SSE, and boundary validation |
| [Provider Guidelines](./provider-guidelines.md) | OpenAI-compatible model and chat adapters |
| [Database Guidelines](./database-guidelines.md) | SQLite schema, migrations, and repositories |
| [Error Handling](./error-handling.md) | Domain, adapter, and public errors |
| [Logging Guidelines](./logging-guidelines.md) | Structured tracing and redaction |
| [Quality Guidelines](./quality-guidelines.md) | Required checks, tests, and forbidden patterns |

## Backend Invariants

- The production application is one Rust process.
- `core` does not depend on Axum, Reqwest, Rusqlite, or frontend types.
- Provider payloads, database rows, and public API DTOs are separate types.
- Every state-changing authenticated request passes session, Origin, CSRF, and
  input validation before business logic.
- One conversation has one server-authoritative current model for its next generation and at most one active generation.
- Every assistant message and generation retains its immutable actual-model snapshot.
- Provider credentials and conversation bodies never enter normal logs.
- SQLite is used on a local persistent volume only.

## Quality Check

The exact commands are established during Phase A, but the backend gate must
include the equivalents of:

```text
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --workspace --release
```

For cross-layer changes, also verify API DTOs, core states, repository mapping,
frontend decoders, and final persisted state as one flow. The detailed checklist
is in [Quality Guidelines](./quality-guidelines.md).

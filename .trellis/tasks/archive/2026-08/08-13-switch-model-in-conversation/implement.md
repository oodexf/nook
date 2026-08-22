# Implementation Plan: 支持同一对话切换模型

## 1. Source provenance and notices

- [x] Preserve the approved research baseline: Open WebUI `v0.5.20` / `3b70cd64d7fa6902e8c79cf8dcbf3c7e84cf704b`.
- [x] Compare the upstream selector/chat flow before implementation; implement the feature independently in project-native Svelte/Rust code.
- [x] Confirm no Open WebUI code or assets were copied or closely translated; therefore no new BSD-3-Clause distribution notice is required for this implementation.

## 2. Migration and repository

- [x] Add a new SQLite migration that drops only the immutable-model trigger; keep historical values and message/generation snapshots intact.
- [x] Update migration/version tests for empty DB, upgrade from the prior schema, repeated startup and preservation of existing conversation/message model values.
- [x] Add `ConversationRepository::update_model` and its `SqliteStorage` implementation.
- [x] In one transaction, reject missing conversations and active generations, then update current model + timestamp.
- [x] Keep generation and retry setup checks that transaction-read conversation current model equals the assistant/generation model snapshot; revise internal error naming/mapping if needed.
- [x] Add repository tests for successful switching, active-generation conflict, historical snapshot preservation and generation setup with the new current model.

## 3. HTTP/API layer

- [x] Register `PUT /api/v1/conversations/{id}/model` behind session, Origin and CSRF middleware with the existing body limit conventions.
- [x] Add strict request DTO validation and current catalog validation.
- [x] Return the standard decoded conversation shape and stable errors for unavailable model, active generation, not found and invalid input.
- [x] Update existing-message generation to use/validate server current model while retaining compatibility for an omitted request model.
- [x] Update retry to use current conversation model rather than the source reply model.
- [x] Add API/chat tests for unavailable model, cross-model context and storage precondition behavior; existing auth/CSRF/idempotency suites remain green.

## 4. Frontend API and stores

- [x] Add the typed current-model mutation to `frontend/src/lib/api/conversations.ts` and decoder tests.
- [x] Add a conversation-store action that updates current detail and the matching sidebar summary only from the server response.
- [x] Extend model selection state/actions so draft selection remains local while existing-conversation selection persists through the conversation store.
- [x] Add tests for successful update and sidebar/detail synchronization.

## 5. Svelte UI adaptation

- [x] Keep `ComposerModelSelector` available for existing conversations, using server current model as its selected value.
- [x] Disable model changes while a generation or model-update request is active; expose accessible busy/disabled state and recoverable errors.
- [x] Preserve draft selection behavior and keyboard/focus interaction.
- [x] Implement removed-model recovery: newest-to-oldest available historical assistant model, persisted via the same API; otherwise block send and require manual selection.
- [x] Continue displaying persisted `message.model` for historical responses even when absent from the catalog.
- [x] Add component/flow tests for switch persistence, selector availability and historical fallback.

## 6. Context and end-to-end validation

- [x] Add a provider/context assertion that model B retains prior bounded messages including model A's completed answer.
- [x] Verify retry excludes the old attempt and routes through conversation current model in code/repository checks.
- [x] Preserve existing SSE `meta.model`, overlay and persisted snapshot contracts.
- [x] Verify migration with an old single-model conversation through migration/storage tests.

## Validation commands

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --workspace --release
npm --prefix frontend run format:check
npm --prefix frontend run check
npm --prefix frontend run lint
npm --prefix frontend test -- --run
npm --prefix frontend run build
```

Run the repository-defined critical browser E2E command if present, plus a focused manual flow:

1. open an old conversation on model A;
2. switch to B and refresh before sending;
3. send and verify B receives A history;
4. switch to A/B and retry the latest reply, verifying current model is used;
5. attempt switch during generation and confirm both UI and API reject it;
6. remove the current model from the test catalog and verify nearest available historical fallback.

## Risky files / rollback points

- `crates/storage/migrations/*`: take/verify a pre-migration backup; do not edit released migrations.
- `crates/storage/src/generation_repository.rs`: preserve idempotency and one-active-generation checks.
- `crates/server/src/chat.rs`: preserve SSE and context/retry ordering.
- `frontend/src/lib/conversations/ChatPane.svelte`: preserve generation ownership and draft restore behavior.
- If model mutation causes inconsistent snapshots, stop rollout and restore the pre-migration database/application pair; do not recreate the old lock trigger over mixed-model conversations.

## Final review gates

- [x] Update backend/frontend Trellis specs from immutable/locked model to mutable conversation current model + immutable message/generation snapshots.
- [x] Review third-party provenance: implementation is project-native and independently written; no Open WebUI code was copied/closely translated, so no new notice is required.
- [x] Run the Trellis full quality check and inspect the final diff for unrelated changes, especially because the worktree already contains modifications from another active task.

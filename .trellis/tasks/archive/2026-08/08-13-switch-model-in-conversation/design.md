# Technical Design: 支持同一对话切换模型

## 1. Architecture and source baseline

- Open-source UI baseline: Open WebUI `v0.5.20`, commit `3b70cd64d7fa6902e8c79cf8dcbf3c7e84cf704b`, BSD-3-Clause.
- Relevant upstream files:
  - `src/lib/components/chat/ModelSelector.svelte`
  - `src/lib/components/chat/ModelSelector/Selector.svelte`
  - `src/lib/components/chat/Chat.svelte`
  - `src/lib/components/chat/Messages/ResponseMessage.svelte`
- The upstream implementation is a UX/state-flow source, not a backend source. Its Svelte 4-style multi-model/sessionStorage state and Python/JSON persistence do not match this project. Any copied or closely translated code must be documented in `THIRD_PARTY_NOTICES.md`; backend behavior is independently implemented in Rust.

## 2. Domain semantics

`Conversation.model` changes meaning from an immutable creation model to the server-authoritative **current model for the next generation**. It remains non-null so old rows need no data backfill: the existing value becomes the initial current model.

`Message.model` remains the immutable model snapshot for each assistant response. `Generation.model` remains the immutable routing/accounting snapshot. Historical rows are never updated when `Conversation.model` changes.

The model catalog IDs are treated as opaque, globally routable IDs under the existing single configured provider/catalog contract. Provider+model schema expansion is deferred because this feature does not add providers.

## 3. API contracts

### Update current model

Add a dedicated mutation to avoid overloading title rename:

```text
PUT /api/v1/conversations/{conversation_id}/model
Cookie + Origin + X-CSRF-Token
{"model":"opaque-model-id"}
```

Success returns the normal `ConversationResponse` with the new current `model` and updated `updated_at`.

Validation order:

1. authenticated mutation middleware;
2. canonical conversation ID and strict JSON/body bounds;
3. exact model ID availability via the existing catalog service;
4. repository transaction verifies the conversation exists and has no active generation;
5. update `conversations.model` and `updated_at`.

Errors use existing public shapes:

- `400 invalid_request`: malformed ID/body/model format;
- `404 conversation_not_found`;
- `409 generation_in_progress`: active generation prevents switching;
- `409 model_unavailable` and existing catalog refresh/provider codes as applicable;
- `503 storage_unavailable`.

### Send existing message

Keep the existing request DTO backward-compatible: an existing-conversation request may omit `model`. If it includes `model`, it must equal the server current model; otherwise reject rather than implicitly changing server state. The handler validates the current model against the catalog, while the repository transaction re-reads `conversations.model` and requires equality with `generation.model`. This preserves the current TOCTOU defense.

### Retry

Retry finds the conversation from the source assistant ID, then reads and validates `conversation.model`, not `source_message.model`. The new assistant and generation snapshot that current model. The repository transaction rechecks the current model and retry eligibility before insertion.

## 4. Storage and migration

Add a new migration; never edit `0001_initial.sql`.

- Drop the `lock_conversation_model_after_message` trigger created by migration 0001.
- Keep `conversations.model TEXT NOT NULL`; no table rewrite or backfill is required.
- Existing rows retain their old model as their initial current selection.
- Add repository method `update_model(id, model, updated_at)` implemented as one short transaction.
- The update transaction checks for an active generation (`pending`, `streaming`, `cancelling`) before changing the model. The existing partial unique active-generation index continues to enforce one generation per conversation.
- Generation setup keeps the equality check between transaction-read `conversations.model` and `setup.generation.model`; rename the internal `ModelLocked` concept to a current-model mismatch/conflict where practical, without exposing stale `model_locked` behavior for normal supported switching.

Directory availability cannot be checked inside SQLite. The API checks immediately before the transaction; send/retry check again before their generation transaction. A provider catalog can theoretically change after validation, but the generation records the exact validated snapshot and provider failures follow the existing terminal/error behavior.

## 5. Frontend state and flow

### Selector

Reuse the existing `ComposerModelSelector` rather than porting Open WebUI wholesale. Adopt the upstream interaction pattern that the selector remains available in an existing chat and the selected model is visible at the composer/header.

- Draft view: selection remains `modelStore.draftModelId` and localStorage behavior is unchanged.
- Existing conversation: selection is `store.current.conversation.model` from server state.
- Choosing an existing-conversation model calls `PUT .../model`; the conversation store updates both current detail and matching sidebar summary from the decoded response.
- While saving, disable repeat selection and show a compact pending state.
- While `generation.isBusy`, disable the selector. The server independently rejects API bypass attempts while a generation is active.
- On mutation failure, keep the authoritative prior selection and show a recoverable error.

### Removed current model

After both conversation detail and catalog are ready:

1. if current model is available, do nothing;
2. otherwise scan assistant messages newest-to-oldest and select the first `message.model` still in the catalog;
3. persist it through the same model update API;
4. if none exists or persistence fails, keep sending disabled and require manual selection/show an error.

Do not silently use `AI_DEFAULT_MODEL`. Historical message badges render their persisted raw model ID even if absent from the catalog.

### Send/retry

Existing sends may omit model and let the server current selection win. Retry carries no model parameter and likewise uses server current selection. On `meta`, the generation overlay uses the returned model snapshot; reconciliation replaces it with persisted `message.model` as today.

## 6. Context behavior

No reset marker is introduced. Existing `messages_before_assistant` and `select_bounded_context` continue to include prior user/assistant content independent of model metadata, subject to current count/character limits. Cross-model tests assert that a generation routed to model B receives prior content produced under model A.

Retry continues to exclude the source assistant attempt according to the existing retry-context rule; only the routing model changes to the conversation current model.

## 7. Compatibility and rollout

- Database migration is additive/constraint-relaxing and preserves all old data.
- Conversation API response shape is unchanged; `model` semantics become mutable current selection.
- Existing clients that omit model on existing sends continue working.
- Existing clients attempting a different model in message POST still receive a conflict and must use the explicit model mutation first.
- Rollback requires a pre-migration backup if returning to a binary that assumes immutability. The old trigger can only be restored after ensuring each conversation model equals the desired locked model; therefore application rollback should restore the database backup rather than blindly recreate the trigger.

## 8. Licensing

Before copying or closely translating upstream code:

- retain source URL, tag, full SHA, exact source file and copied section in a provenance note;
- add the Open WebUI BSD-3-Clause copyright, conditions and disclaimer to `THIRD_PARTY_NOTICES.md` and binary distribution materials as required;
- do not copy branding, logos, translations or assets;
- do not imply endorsement by Open WebUI contributors.

If implementation only adapts interaction concepts and writes original project-native code, still record the research reference, but distinguish it from copied code in the notice/review.

## 9. Key trade-offs

- Dedicated immediate-save API adds one request per switch but makes refresh/cross-device state deterministic.
- Blocking switch during generation reduces flexibility but removes ambiguity and races.
- Falling back to the nearest available historical model matches user intent better than default fallback, at the cost of one client-side scan and update request.
- Keeping the `model` field name minimizes migration/API churn, but specs and comments must be updated everywhere to remove the old immutable meaning.

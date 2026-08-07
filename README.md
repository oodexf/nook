# Minimal AI Chat

Minimal AI Chat is a lightweight, self-hosted web AI chat application currently
in Trellis planning.

## Confirmed MVP Direction

- Web only; no desktop client or DMG work;
- Svelte + TypeScript static frontend;
- Rust + Axum backend;
- SQLite on a mounted `/data` volume;
- one Docker application container;
- one shared instance access token with a first-visit authentication page;
- optional 30-day "Remember me" session;
- one OpenAI-compatible provider;
- server-side model discovery through `/v1/models`;
- one immutable model per conversation;
- streamed responses, cancellation, retry, and conversation history.

## Trellis Source of Truth

The active planning task is:

```text
.trellis/tasks/08-06-minimal-ai-chat-web-mvp/
```

Artifacts:

- [`prd.md`](.trellis/tasks/08-06-minimal-ai-chat-web-mvp/prd.md) — product
  requirements, scope, and observable acceptance criteria;
- [`design.md`](.trellis/tasks/08-06-minimal-ai-chat-web-mvp/design.md) —
  architecture, contracts, data flow, security, and rollback design;
- [`implement.md`](.trellis/tasks/08-06-minimal-ai-chat-web-mvp/implement.md) —
  ordered implementation slices, validation, and rollback points;
- [`research/technology-baseline.md`](.trellis/tasks/08-06-minimal-ai-chat-web-mvp/research/technology-baseline.md)
  — external capability baseline;
- `implement.jsonl` and `check.jsonl` — curated Trellis execution and review
  context.

Use Trellis to inspect the current task:

```bash
python3 ./.trellis/scripts/task.py current --source
python3 ./.trellis/scripts/task.py validate \
  .trellis/tasks/08-06-minimal-ai-chat-web-mvp
```

## Planning Status

The task remains in `planning`. Product implementation must not begin until:

1. the final plan is explicitly approved;
2. the separate `00-bootstrap-guidelines` task replaces placeholder backend and
   frontend specs with real project conventions;
3. Trellis context manifests are revalidated;
4. the task is activated with `task.py start`.

Long-lived deployment and API documentation will be generated from verified
implementation behavior before the first release. The previous standalone
drafts were removed to avoid maintaining a second, conflicting source of truth.


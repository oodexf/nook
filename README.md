# 栖语 NooK

栖语 NooK is a lightweight, single-instance, self-hosted AI chat service.
A Svelte browser client and Rust/Axum API ship in one container; conversations
are stored in SQLite under `/data`, and provider credentials remain server-side.

<p align="center">
  <img src="nook-icon.svg" alt="NooK app icon" width="128" />
</p>

## Features

- shared-token login exchanged for a Secure, HttpOnly, SameSite session cookie;
- server-side OpenAI-compatible model discovery and one immutable model per chat;
- streamed responses with stop, retry, partial-output preservation, and recovery;
- persistent conversation list, rename, delete, and idempotent message submission;
- responsive desktop/mobile UI with safe Markdown and code-copy actions;
- liveness/readiness probes, non-root container, online SQLite backup, and
  structured secret-safe logs.

## Quick start

You need Docker and nothing else — no source checkout, no Node, no Rust.

```bash
mkdir nook && cd nook
curl -O https://raw.githubusercontent.com/oodexf/nook/v0.1.0/compose.yaml
curl -o .env https://raw.githubusercontent.com/oodexf/nook/v0.1.0/.env.example
```

Edit `.env` and set at least these five values; see [Configuration](#configuration)
for the complete reference:

- `APP_ACCESS_TOKEN` — instance login token, at least 32 random bytes
- `APP_ORIGIN` — the exact external origin you will open in the browser
- `AI_BASE_URL` — your OpenAI-compatible provider endpoint
- `AI_API_KEY` — the provider credential
- `AI_DEFAULT_MODEL` — a model id that provider's `/v1/models` returns

Then start it:

```bash
docker compose up -d
curl --fail http://127.0.0.1:8080/api/v1/health/live
curl --fail http://127.0.0.1:8080/api/v1/health/ready
```

The image is published at `ghcr.io/oodexf/nook` for `linux/amd64` and
`linux/arm64`. The runtime uses UID/GID `10001`, a read-only root filesystem,
and one named volume mounted at `/data`.

The server reads configuration from its process environment at startup and never
reads `.env` itself — Compose injects the file through `env_file`. A missing or
invalid value stops the container with exit code 2, so check
`docker compose logs chat` if it will not start.

Both health probes answer over plain HTTP, but signing in does not: the session
cookie is `Secure` by default, so put a TLS reverse proxy in front and set
`APP_ORIGIN` to that public HTTPS origin. See
[Reverse proxy and streaming](#reverse-proxy-and-streaming). For a loopback-only
trial you can instead set `APP_COOKIE_SECURE=false`.

## Configuration

All values are supplied through the process environment; Compose loads them from
`.env`. Required values have no default and stop startup when absent.

| Variable | Required | Purpose |
|---|---:|---|
| `APP_ACCESS_TOKEN` | yes | Shared instance token; use at least 32 random bytes in production |
| `APP_ALLOW_INSECURE_TEST_TOKEN` | no | Local testing only; explicitly allows a short shared token such as `test` (default `false`) |
| `APP_ORIGIN` | yes | Exact external origin used for cookie and CSRF checks |
| `AI_BASE_URL` | yes | Provider origin, optionally ending in `/v1` |
| `AI_API_KEY` | yes | Server-side provider credential |
| `AI_DEFAULT_MODEL` | yes | Default model; must appear in `/v1/models` |
| `APP_BIND` | no | Listener, default `0.0.0.0:8080` |
| `APP_COOKIE_SECURE` | no | Default `true`; disable only for loopback development |
| `DATABASE_PATH` | no | Default `/data/chat.db` |
| `AI_REQUEST_TIMEOUT_SECS` | no | Provider timeout, default `30` |
| `MODEL_CACHE_TTL_SECS` | no | Model catalog cache TTL, default `60` |
| `MAX_MESSAGE_CHARS` | no | Per-message character limit, default `32000` |
| `MAX_CONTEXT_MESSAGES` | no | Context message limit, default `100` |
| `MAX_CONTEXT_CHARS` | no | Context character limit, default `200000` |
| `MAX_ACTIVE_GENERATIONS` | no | Process-wide generation limit, default `4` |
| `RUST_LOG` | no | Tracing filter, default `info` |

Generate a token, for example:

```bash
openssl rand -base64 32
```

Production must use HTTPS so the default Secure cookie can be sent. The Compose
example binds only to localhost; place a TLS reverse proxy in front of it.

## Build from source

Only needed to run your own build instead of the published image.
`compose.dev.yaml` is an override that swaps the image for a local build; the
runtime configuration is inherited from `compose.yaml`, so both paths run the
same way.

```bash
git clone https://github.com/oodexf/nook.git && cd nook
cp .env.example .env    # then edit it
docker compose -f compose.yaml -f compose.dev.yaml up --build -d
```

`make docker-dev` is the same thing wrapped in the full quality gate: it runs
`make check` and `make test` first, then builds the image and starts it.

## Reverse proxy and streaming

Forward the original `Host` and scheme, and disable response buffering for SSE.
For Nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;
}
```

Set `APP_ORIGIN` to the exact public HTTPS origin. CORS is intentionally not
enabled; the browser UI and API are same-origin.

## Backup and restore

Do not copy only `chat.db` while the app is running: SQLite may have live WAL
content. Use the binary's online backup command to produce a consistent file.

With Compose:

```bash
mkdir -p backups
docker compose exec -T chat /app/chat-server backup /data/chat-backup.db
docker compose cp chat:/data/chat-backup.db ./backups/chat-$(date +%Y%m%d-%H%M%S).db
```

Verify a backup before relying on it:

```bash
sqlite3 ./backups/chat-YYYYMMDD-HHMMSS.db 'PRAGMA integrity_check;'
```

Restore drill:

1. Stop the application: `docker compose down` (do not add `-v`).
2. Preserve the current database as an additional rollback copy.
3. Replace `/data/chat.db` with the verified backup while the container is
   stopped; remove stale `chat.db-wal` and `chat.db-shm` files from that stopped
   volume.
4. Start the container and wait for readiness.
5. Sign in and open an existing conversation.

A convenient volume restore uses a temporary container. Compose prefixes the
volume with its project name, which defaults to the checkout directory; replace
`<project>` below with the value shown by `docker volume ls`:

```bash
docker run --rm -v <project>_chat-data:/data \
  -v "$PWD/backups:/backup:ro" alpine sh -c \
  'rm -f /data/chat.db /data/chat.db-wal /data/chat.db-shm && cp /backup/chat.db /data/chat.db && chown 10001:10001 /data/chat.db'
```

Adjust the volume and backup names for your deployment.

## Upgrade and rollback

1. Create and integrity-check an online backup.
2. Pin an immutable image tag in `compose.yaml`; never rely on `latest` for
   rollback.
3. `docker compose up -d` pulls the new tag and restarts against the existing
   `/data`.
4. Confirm readiness, login, model discovery, historical chat, and one streamed
   response.
5. If startup fails before migration, restore the previous image tag.
6. If a migration completed and the previous image cannot read the new schema,
   stop the app, restore the pre-upgrade backup, then run the previous image.

SQLite must be on local persistent storage, not NFS/SMB. Multiple replicas
sharing the database are unsupported.

## Project layout

```
crates/core       domain types, provider client, streaming orchestration
crates/storage    SQLite schema, migrations, online backup
crates/server     Axum HTTP/SSE surface, auth, health probes
frontend/         Svelte browser client (Vite)
scripts/          local development helpers
.github/workflows CI quality gate and tagged multi-arch release pipeline
Dockerfile        single-image build: frontend bundle + Rust server
compose.yaml      single-instance deployment, pulls the published image
compose.dev.yaml  developer override that builds the image locally
```

## Local development and quality checks

Prerequisites: Node.js 24 and Rust 1.97.1.

```bash
npm --prefix frontend ci
make check
make test
make build
make docker-build
```

Frontend checks include Svelte/TypeScript, ESLint, Vitest, and Vite production
build. Backend checks include rustfmt, Clippy with warnings denied, tests, and a
release build.

## Health and operations

- `GET /api/v1/health/live` checks process liveness.
- `GET /api/v1/health/ready` checks validated configuration and SQLite access.
- The container healthcheck uses the unauthenticated liveness endpoint.
- `SIGTERM` stops admission through Axum's graceful shutdown and cancels active
  provider generations so partial responses finalize as stopped where possible.
- Logs include request IDs, route templates, status, and duration. They exclude
  cookies, tokens, provider keys, prompts, assistant bodies, and raw upstream
  responses.

## Browser release gate

Automated tests cover contracts and Svelte components. Before a release, also
manually verify current Safari and iOS Safari, including login, software-keyboard
composer visibility, IME Enter behavior, streaming, stop/retry, rename/delete,
and sanitized Markdown rendering.

## License

MIT. See [LICENSE](LICENSE); the same identifier is declared in the workspace
`Cargo.toml`.

# Technology Baseline Research

## Purpose

Record the external capabilities relied upon by the design so implementation
agents do not depend on conversational memory.

## Findings

### Axum streaming

Axum provides Server-Sent Events through `axum::response::sse`, including event
encoding and keep-alive support. The project can therefore implement a POST
handler whose response body is SSE without introducing WebSocket infrastructure.

Source:

- https://docs.rs/axum/latest/axum/response/sse/

### Rust static frontend embedding

The application design embeds the Vite output into the Rust release binary. The
specific embedding crate should be selected during the foundation slice based on
build behavior and cache headers; the architectural requirement is one runtime
process, not a specific embedding library.

### Vite static production output

Vite produces optimized static assets through its production build. Svelte can
be compiled through the official Vite plugin, so Node.js is needed at build time
but not at runtime.

Sources:

- https://github.com/vitejs/vite/blob/main/docs/guide/static-deploy.md
- https://github.com/sveltejs/vite-plugin-svelte

### SQLite deployment fit

SQLite is appropriate for an application-specific server with one application
process and local storage. It should not be placed on a network filesystem, and
multiple application replicas writing the same file are out of scope.

Source:

- https://www.sqlite.org/whentouse.html

### Browser streaming choice

The request must carry message content and an idempotency identifier, so the
browser uses `fetch` with POST and reads the response stream. Native
`EventSource` is not used because its request shape does not satisfy this
contract.

## Constraints Carried Into Design

- No Node.js production runtime;
- no WebSocket without a bidirectional requirement;
- no database server for the single-instance MVP;
- no provider credential in browser requests to the upstream provider;
- no native desktop framework in the web-first release.


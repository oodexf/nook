# Minimal AI Chat Web MVP

## Goal

Deliver a minimal, self-hosted web AI chat that can be deployed as a single
Docker application, persists conversations across restarts, and provides a
reliable streaming chat experience on desktop and mobile browsers.

The MVP should minimize runtime and operational complexity rather than optimize
only for image size.

## User Value

- A user can run a private AI chat service on a server they control.
- A user can access the same conversations from desktop and mobile browsers.
- A deployer can configure an AI provider without exposing provider credentials
  to the browser.
- A deployer can back up and restore all application data without operating a
  separate database service.

## Confirmed Facts

- The MVP is implemented as a Svelte 5 frontend served by the Rust application.
- Persisted assistant messages already use the single sanitized `MarkdownContent`
  rendering boundary; streamed assistant text is currently plain text until the
  generation reaches a terminal state.
- Conversation rename already exists through the typed API and conversation
  store, but its editing control is currently in the chat header rather than
  the sidebar.
- Desktop uses a fixed 300px sidebar, while mobile already uses an accessible
  modal drawer.
- The existing frontend specification requires at least 44×44 touch targets,
  accessible names for icon-only buttons, controlled live-region announcements,
  and no Markdown parsing for every transport delta.

## Requirements

### R1. Core chat

- After authentication, the user can see the models returned by the configured
  provider's `/v1/models` endpoint.
- Model discovery is performed by the server; provider credentials are never
  sent to the browser.
- The user can select an available model before sending a message.
- The selected model is stored on the conversation and cannot be changed after
  its first message is created.
- Starting a new conversation preselects the most recently used available model;
  when that model is no longer available, the configured default model is used.
- The user can create a conversation by sending its first message.
- The assistant response is displayed incrementally while it is generated.
- The user can stop an active generation.
- The user can continue a conversation after a completed, stopped, or failed
  generation.
- The user can retry the latest assistant response without overwriting the
  previous response.

### R2. Conversation persistence

- The application persists conversations and messages across browser refreshes,
  application restarts, and container replacement.
- The user can list, open, rename, and permanently delete conversations.
- An application restart marks unfinished generations as interrupted instead of
  presenting them as complete.
- Duplicate submission of the same client message identifier must not create
  duplicate messages.

### R3. Browser experience

- An unauthenticated first visit displays a dedicated authentication page.
- Submitting a valid instance token opens the chat application.
- Invalid credentials remain on the authentication page and show a generic,
  actionable error without revealing server configuration.
- The authentication page includes a "Remember me" control that is unchecked by
  default.
- The user can sign out and return to the authentication page.
- The primary experience works on current desktop and mobile browsers.
- Desktop supports Enter to send and Shift+Enter for a newline.
- IME composition must not trigger accidental submission.
- Mobile keeps the composer visible when the software keyboard opens.
- The UI preserves partial output and provides a clear recovery action when a
  request fails.
- Markdown and code blocks are rendered safely and can be copied.
- User messages form a distinct right-aligned visual flow; assistant messages
  form a distinct left-aligned visual flow, including the optimistic user
  message and in-progress assistant response.
- Message and code-copy actions use compact icons with accessible names; their
  borders become visible on hover and keyboard focus without relying on hover
  for discoverability.
- The desktop sidebar can be collapsed and restored without changing the
  existing mobile drawer behavior.
- A conversation title can be edited inline from its sidebar item using the
  existing server-authoritative rename behavior, with validation and recoverable
  inline errors.
- Assistant Markdown is rendered safely while generation is in progress, using
  bounded update cadence so streaming remains responsive and does not parse on
  every transport delta.

### R4. Self-hosting

- The production application runs as one application container.
- Production does not require a Node.js runtime, Redis, a separate database
  container, a message queue, or Kubernetes.
- Application data is stored in one mounted `/data` volume.
- Provider URL, model, API key, limits, and logging level are configured through
  environment variables.
- The container provides liveness and readiness checks.
- The project documents backup, restore, upgrade, and rollback procedures.

### R5. Security and privacy

- All conversation, message, generation, and safe client-configuration endpoints
  require the shared instance credential.
- Liveness and readiness endpoints remain unauthenticated and expose no
  sensitive configuration.
- The access token is never placed in a URL.
- The browser must not persist the raw instance token after exchanging it for a
  server-issued session.
- The authenticated session is carried by a Secure, HttpOnly, SameSite cookie.
- Remembered sessions have a maximum lifetime of 30 days; non-remembered
  sessions use a browser-session cookie.
- Signing out clears the session, and rotating the configured instance token
  invalidates sessions derived from the previous token.
- Access-token comparison is resistant to timing disclosure.
- Repeated authentication failures are rate-limited.
- Cookie-authenticated state-changing requests are protected against CSRF.
- Provider API keys never appear in browser assets or API responses.
- Logs do not contain access credentials, user message bodies, or assistant
  response bodies.
- Rendered Markdown must not allow script execution or dangerous URL schemes.
- Requests have bounded body, message, context, concurrency, and timeout limits.
- The browser communicates with the application API over the same origin by
  default.

### R6. Reliability

- Failure to refresh the model list is distinguishable from chat-generation
  failure.
- The application does not invent or silently substitute a model identifier
  that was not selected or configured.
- A model removed from `/v1/models` remains visible on historical conversations,
  but new messages in that conversation fail with a clear unavailable-model
  error.
- A client disconnect or explicit stop cancels the upstream model request.
- Model authentication, rate-limit, timeout, unavailable, and malformed-stream
  failures are distinguishable.
- Exactly one terminal stream event is produced for each generation.
- Already received output is retained when a generation is stopped or fails.
- The application does not write every streamed token to the database.

## Acceptance Criteria

- [ ] `AC-01` A user can complete a ten-turn conversation with streamed
      responses without duplicated, missing, or cross-conversation messages.
- [ ] `AC-01A` After authentication, the application fetches models through the
      server from the configured provider's `/v1/models` endpoint and allows the
      user to select an available model without exposing provider credentials.
- [ ] `AC-01B` A conversation stores one model selected before its first message;
      the model cannot change after messages exist; and historical assistant
      messages identify the model that generated them.
- [ ] `AC-02` A user can stop a response, retain the partial response, and send a
      follow-up message.
- [ ] `AC-03` A failed or interrupted response is visibly distinguished from a
      completed response and offers an appropriate retry action.
- [ ] `AC-04` Refreshing the page and restarting or replacing the container
      preserves completed conversations stored in the mounted data volume.
- [ ] `AC-05` Repeating a submission with the same client message identifier
      does not create duplicate user or assistant messages.
- [ ] `AC-06` Conversation list, open, rename, retry, and permanent delete
      operations work from both desktop and mobile layouts.
- [ ] `AC-07` Markdown security tests reject scripts, event attributes,
      dangerous URL schemes, iframes, and unsafe SVG content.
- [ ] `AC-08` An unauthenticated first visit shows the authentication page;
      invalid credentials cannot access application data; valid credentials
      open the chat interface; and sign-out removes access.
- [ ] `AC-08A` "Remember me" is off by default; a normal session ends with the
      browser session; a remembered session remains valid for no more than 30
      days; and rotating the instance token invalidates old sessions.
- [ ] `AC-09` Provider credentials, the instance access token, and conversation
      bodies are absent from browser bundles, normal logs, health endpoints, and
      unauthenticated responses.
- [ ] `AC-10` Every data-bearing API rejects missing or invalid credentials,
      while health endpoints remain usable without revealing configuration.
- [ ] `AC-10A` Cross-origin attempts to create, modify, cancel, retry, or delete
      application data fail even when the browser has a valid session cookie.
- [ ] `AC-11` The release image runs as a non-root user, persists only under
      `/data`, and passes liveness and readiness checks.
- [ ] `AC-12` A documented SQLite backup can be restored into a fresh container
      and used to open an existing conversation.
- [ ] `AC-13` Provider 401, 429, timeout, unavailable, malformed stream, and
      mid-stream disconnect scenarios produce stable application states.
- [ ] `AC-13A` A `/v1/models` authentication, timeout, unavailable, malformed
      response, or empty-list failure is shown separately from generation
      errors and does not expose the upstream response body.
- [ ] `AC-14` The release build is manually verified on Safari and iOS Safari
      in addition to automated browser coverage.
- [ ] `AC-15` Persisted and streaming user messages are visually grouped on the
      right, while persisted and streaming assistant messages are grouped on the
      left, with readable widths at desktop and mobile viewports.
- [ ] `AC-16` Message and code-copy controls are compact icon buttons with
      accessible names, visible keyboard focus, and a border that appears on
      hover/focus; copied and failed feedback remains announced.
- [ ] `AC-17` Desktop users can collapse and restore the sidebar with keyboard
      and pointer controls, while the mobile modal drawer retains its focus trap,
      Escape behavior, and body-scroll lock.
- [ ] `AC-18` A user can start, submit, cancel, and recover from a conversation
      rename directly within the sidebar; a successful rename reconciles the
      sidebar and open header from the server response, and a failed rename does
      not replace the old title.
- [ ] `AC-19` During generation, safe Markdown structures become visible before
      the terminal event, partial/incomplete Markdown remains usable, XSS
      protections remain unchanged, and rendering is rate-limited rather than
      triggered for every incoming transport delta.

## Out of Scope

- Native desktop applications and DMG packaging;
- Tauri, Wry, Electron, and SwiftUI clients;
- User registration, password recovery, teams, roles, and tenant isolation;
- File, image, and audio input;
- Image generation and voice chat;
- RAG, knowledge bases, embeddings, and vector databases;
- Plugin systems, tools UI, and multi-agent workflows;
- Conversation sharing or a public community;
- Multiple application replicas and shared-database horizontal scaling;
- Offline mode and PWA service-worker caching.

## Constraints

- The implementation must follow the Trellis workflow and must not begin until
  this task has complete planning artifacts and the final plan is explicitly
  approved.
- Because there is no established codebase yet, project conventions must be
  captured deliberately during the bootstrap-guidelines task rather than
  described as existing practice.
- SQLite data must live on a local persistent volume, not a network filesystem.
- Any additional production dependency must solve a documented requirement.

## Deferred Decisions

- The provider model-list cache duration will be selected during implementation
  and made configurable only if operational testing shows a need.

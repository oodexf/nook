/**
 * Generation store (spec: state-management.md §Generation,
 * streaming-data-access.md §Generation Ownership).
 *
 * Owns exactly one active chat stream:
 * - conversation/stream identity (a local instance ID plus the server IDs
 *   from `meta`);
 * - the stream `AbortController`;
 * - the transient assistant text buffer;
 * - the single terminal transition.
 *
 * Ownership rules:
 * - events are applied only to the stream instance whose callback received
 *   them; a stale stream (replaced send, new retry) can never mutate the
 *   visible state of its successor;
 * - navigating to another conversation never transfers ownership: the
 *   stream keeps its own conversation ID and components decide per view
 *   whether the stream belongs to what is on screen;
 * - visible text updates are batched to at most one animation frame;
 * - partial text is preserved through stops, failures, and disconnects.
 *
 * The store holds no conversation data. Server reconciliation after
 * terminal states is delegated to the owning shell via callbacks, so the
 * conversation store remains the only owner of persisted messages.
 */

import { ApiError, errorMessageOf, isAbortError } from "../api/client";
import {
  STREAM_INCOMPLETE_MESSAGE,
  cancelGeneration,
  streamAssistantRetry,
  streamConversationMessage,
  streamNewConversationMessage
} from "../api/chat";
import { newClientMessageId } from "../api/ids";
import { SseProtocolError } from "../api/sse";
import type { ChatStreamEvent } from "../api/sse";

export type GenerationPhase =
  | "idle"
  | "connecting"
  | "streaming"
  | "stopping"
  | "completed"
  | "stopped"
  | "failed";

export type GenerationTerminal =
  | { kind: "completed"; finishReason: string }
  | { kind: "stopped" }
  | {
      kind: "failed";
      message: string;
      code: string | null;
      requestId: string | null;
    };

export type GenerationCallbacks = {
  /**
   * Fired once when a draft send learns its server conversation ID from
   * `meta`. The shell typically refreshes the sidebar and opens the new
   * conversation (unless the user navigated elsewhere meanwhile).
   */
  onConversationCreated?: (conversationId: string) => void;
  /**
   * Fired after every terminal transition that reached the server, so
   * persisted state (sidebar ordering, final message content/status) can
   * be reloaded. Awaited before the internal settle completes.
   */
  onReconcile?: (conversationId: string) => Promise<void> | void;
};

type ActiveGeneration = {
  /** Local identity; stale async continuations compare against `active`. */
  instanceId: number;
  /** True when started from the empty draft (creates the conversation). */
  isDraft: boolean;
  /** Null for a draft until `meta` assigns the server conversation ID. */
  conversationId: string | null;
  clientMessageId: string;
  /** Optimistic user message content; empty for retries. */
  userContent: string;
  userMessageId: string | null;
  assistantMessageId: string | null;
  generationId: string | null;
  model: string | null;
  controller: AbortController;
  /** Deltas not yet flushed to the visible text. */
  pending: string;
  /** rAF-batched visible stream text. */
  visible: string;
  /** Reasoning deltas not yet flushed to the visible reasoning text. */
  pendingReasoning: string;
  /** rAF-batched visible reasoning (thinking chain) text. */
  visibleReasoning: string;
  flushScheduled: boolean;
  cancelRequested: boolean;
};

export type GenerationStore = {
  readonly phase: GenerationPhase;
  /** The conversation the active/last stream belongs to (null = draft). */
  readonly conversationId: string | null;
  readonly generationId: string | null;
  readonly assistantMessageId: string | null;
  readonly clientMessageId: string | null;
  /** Optimistic user message content (empty string for retries). */
  readonly pendingUserContent: string | null;
  readonly model: string | null;
  /** rAF-batched visible assistant text of the active/last stream. */
  readonly streamingText: string;
  /** rAF-batched visible reasoning text of the active/last stream. */
  readonly streamingReasoning: string;
  readonly terminal: GenerationTerminal | null;
  readonly isBusy: boolean;
  /**
   * True when the active stream belongs to the given view. `null` is the
   * empty-draft view and matches only a draft stream that has not yet
   * received `meta`.
   */
  isActiveFor(conversationId: string | null): boolean;
  /** Starts a new message stream. No-op while a stream is busy. */
  send(options: {
    conversationId: string | null;
    content: string;
    /** Required when `conversationId` is null (new draft); ignored
     * otherwise — existing conversations use their locked model. */
    model: string | null;
    csrfToken: string;
  }): Promise<void>;
  /** Retries an assistant response; appends, never overwrites. */
  retry(options: {
    conversationId: string;
    assistantMessageId: string;
    csrfToken: string;
  }): Promise<void>;
  /**
   * User stop: aborts the stream fetch, then sends a separate authenticated
   * cancel request on a distinct signal, then reconciles server state.
   */
  stop(csrfToken: string): Promise<void>;
  /** Releases a finished stream from view (e.g. after user dismisses). */
  clear(): void;
};

let nextInstanceId = 1;

const ABORTED_MESSAGE = "生成已中断。";

export function createGenerationStore(
  callbacks: GenerationCallbacks = {}
): GenerationStore {
  let active = $state<ActiveGeneration | null>(null);
  let phase = $state<GenerationPhase>("idle");
  let terminal = $state<GenerationTerminal | null>(null);

  function isBusyPhase(value: GenerationPhase): boolean {
    return (
      value === "connecting" || value === "streaming" || value === "stopping"
    );
  }

  /**
   * Ownership check. `$state` deeply proxies assigned objects, so object
   * identity between a captured raw stream and the reactive `active` value
   * cannot be compared directly; the monotonically increasing instance ID
   * is the identity token, and all mutations go through the `active` proxy.
   */
  function owns(stream: ActiveGeneration): ActiveGeneration | null {
    if (active === null || active.instanceId !== stream.instanceId) {
      return null;
    }
    return active;
  }

  function scheduleFlush(stream: ActiveGeneration): void {
    if (stream.flushScheduled) return;
    stream.flushScheduled = true;
    const schedule: (callback: () => void) => void =
      typeof requestAnimationFrame === "function"
        ? (callback) => {
            requestAnimationFrame(callback);
          }
        : (callback) => {
            setTimeout(callback, 16);
          };
    schedule(() => {
      const current = owns(stream);
      if (current === null) return;
      current.flushScheduled = false;
      flushNow(current);
    });
  }

  function flushNow(stream: ActiveGeneration): void {
    if (stream.pending.length > 0) {
      stream.visible += stream.pending;
      stream.pending = "";
    }
    if (stream.pendingReasoning.length > 0) {
      stream.visibleReasoning += stream.pendingReasoning;
      stream.pendingReasoning = "";
    }
  }

  async function settle(
    stream: ActiveGeneration,
    outcome: GenerationTerminal
  ): Promise<void> {
    // Identity + single-terminal guard: exactly one terminal transition per
    // stream, applied only while the stream still owns the store.
    const current = owns(stream);
    if (current === null || terminal !== null) return;
    flushNow(current);
    terminal = outcome;
    phase =
      outcome.kind === "completed"
        ? "completed"
        : outcome.kind === "stopped"
          ? "stopped"
          : "failed";
    if (current.conversationId !== null) {
      try {
        await callbacks.onReconcile?.(current.conversationId);
      } catch {
        // Reconciliation failure must not discard the terminal state; the
        // locally preserved text stays visible and the conversation pane
        // offers its own reload affordance.
      }
    }
  }

  function failureTerminal(error: unknown): GenerationTerminal {
    if (error instanceof SseProtocolError) {
      return {
        kind: "failed",
        message: error.message,
        code: "malformed_stream",
        requestId: null
      };
    }
    if (error instanceof ApiError) {
      return {
        kind: "failed",
        message: error.message,
        code: error.code,
        requestId: error.requestId
      };
    }
    return {
      kind: "failed",
      message: errorMessageOf(error),
      code: null,
      requestId: null
    };
  }

  function applyEvent(stream: ActiveGeneration, event: ChatStreamEvent): void {
    // Ownership guard: a stale stream instance can never mutate the state
    // of its successor, regardless of which conversation is on screen.
    const current = owns(stream);
    if (current === null || terminal !== null) return;
    switch (event.kind) {
      case "meta": {
        if (
          current.conversationId !== null &&
          current.conversationId !== event.conversationId
        ) {
          // The server answered about a different conversation than this
          // stream owns: never cross-apply. Surface as a safe failure.
          void settle(current, {
            kind: "failed",
            message: STREAM_INCOMPLETE_MESSAGE,
            code: "stream_conversation_mismatch",
            requestId: null
          });
          return;
        }
        const wasDraft = current.conversationId === null;
        current.conversationId = event.conversationId;
        current.userMessageId = event.userMessageId;
        current.assistantMessageId = event.assistantMessageId;
        current.generationId = event.generationId;
        current.model = event.model;
        phase = "streaming";
        if (wasDraft) {
          callbacks.onConversationCreated?.(event.conversationId);
        }
        break;
      }
      case "delta":
        current.pending += event.text;
        scheduleFlush(current);
        break;
      case "reasoning-delta":
        current.pendingReasoning += event.text;
        scheduleFlush(current);
        break;
      case "done":
        void settle(current, {
          kind: "completed",
          finishReason: event.finishReason
        });
        break;
      case "stopped":
        void settle(current, { kind: "stopped" });
        break;
      case "error":
        void settle(current, {
          kind: "failed",
          message: event.message,
          code: event.code,
          requestId: event.requestId
        });
        break;
    }
  }

  function freshStream(
    init: Pick<
      ActiveGeneration,
      "isDraft" | "conversationId" | "userContent" | "model"
    > & { clientMessageId?: string }
  ): ActiveGeneration {
    return {
      instanceId: nextInstanceId,
      clientMessageId: init.clientMessageId ?? newClientMessageId(),
      userMessageId: null,
      assistantMessageId: null,
      generationId: null,
      controller: new AbortController(),
      pending: "",
      visible: "",
      pendingReasoning: "",
      visibleReasoning: "",
      flushScheduled: false,
      cancelRequested: false,
      isDraft: init.isDraft,
      conversationId: init.conversationId,
      userContent: init.userContent,
      model: init.model
    };
  }

  function beginStream(stream: ActiveGeneration): void {
    nextInstanceId += 1;
    active = stream;
    terminal = null;
    phase = "connecting";
  }

  async function runStream(
    stream: ActiveGeneration,
    start: () => Promise<void>
  ): Promise<void> {
    try {
      await start();
    } catch (error) {
      const current = owns(stream);
      if (current === null || terminal !== null) return;
      if (isAbortError(error)) {
        // Aborts only happen through stop(), which performs the terminal
        // transition itself. A foreign abort still fails safe.
        if (!current.cancelRequested) {
          await settle(stream, {
            kind: "failed",
            message: ABORTED_MESSAGE,
            code: "stream_aborted",
            requestId: null
          });
        }
        return;
      }
      await settle(stream, failureTerminal(error));
    }
  }

  return {
    get phase() {
      return phase;
    },
    get conversationId() {
      return active?.conversationId ?? null;
    },
    get generationId() {
      return active?.generationId ?? null;
    },
    get assistantMessageId() {
      return active?.assistantMessageId ?? null;
    },
    get clientMessageId() {
      return active?.clientMessageId ?? null;
    },
    get pendingUserContent() {
      if (active === null || active.userContent.length === 0) return null;
      return active.userContent;
    },
    get model() {
      return active?.model ?? null;
    },
    get streamingText() {
      return active?.visible ?? "";
    },
    get streamingReasoning() {
      return active?.visibleReasoning ?? "";
    },
    get terminal() {
      return terminal;
    },
    get isBusy() {
      return isBusyPhase(phase);
    },

    isActiveFor(conversationId: string | null): boolean {
      if (active === null) return false;
      if (active.conversationId !== null) {
        return active.conversationId === conversationId;
      }
      return conversationId === null && active.isDraft;
    },

    async send(options): Promise<void> {
      if (active !== null && isBusyPhase(phase)) return;
      const content = options.content.trim();
      if (content.length === 0) return;
      if (options.conversationId === null) {
        const model = options.model;
        if (model === null || model.length === 0) return;
        const stream = freshStream({
          isDraft: true,
          conversationId: null,
          userContent: content,
          model
        });
        beginStream(stream);
        await runStream(stream, () =>
          streamNewConversationMessage({
            content,
            model,
            clientMessageId: stream.clientMessageId,
            csrfToken: options.csrfToken,
            signal: stream.controller.signal,
            onEvent: (event) => {
              applyEvent(stream, event);
            }
          })
        );
        return;
      }
      const conversationId = options.conversationId;
      const stream = freshStream({
        isDraft: false,
        conversationId,
        userContent: content,
        model: null
      });
      beginStream(stream);
      await runStream(stream, () =>
        streamConversationMessage(conversationId, {
          content,
          clientMessageId: stream.clientMessageId,
          csrfToken: options.csrfToken,
          signal: stream.controller.signal,
          onEvent: (event) => {
            applyEvent(stream, event);
          }
        })
      );
    },

    async retry(options): Promise<void> {
      if (active !== null && isBusyPhase(phase)) return;
      const stream = freshStream({
        isDraft: false,
        conversationId: options.conversationId,
        userContent: "",
        model: null
      });
      beginStream(stream);
      await runStream(stream, () =>
        streamAssistantRetry(options.assistantMessageId, {
          csrfToken: options.csrfToken,
          signal: stream.controller.signal,
          onEvent: (event) => {
            applyEvent(stream, event);
          }
        })
      );
    },

    async stop(csrfToken: string): Promise<void> {
      const stream = active;
      if (
        stream === null ||
        terminal !== null ||
        stream.cancelRequested ||
        !isBusyPhase(phase)
      ) {
        return;
      }
      stream.cancelRequested = true;
      phase = "stopping";
      // 1. Abort the stream fetch. The reader rejects asynchronously; its
      //    catch path sees `cancelRequested` and leaves the terminal
      //    transition to this function.
      stream.controller.abort();
      // 2. Explicit cancel on a distinct signal: covers proxies that delay
      //    disconnect propagation. Idempotent server-side.
      const generationId = stream.generationId;
      if (generationId !== null) {
        const cancelController = new AbortController();
        try {
          await cancelGeneration(
            generationId,
            csrfToken,
            cancelController.signal
          );
        } catch (error) {
          if (
            !isAbortError(error) &&
            error instanceof ApiError &&
            error.kind === "session-expired"
          ) {
            // The 401 listener already transitioned the session; the local
            // terminal below still preserves the partial text.
          }
        }
      }
      // 3. Terminal transition: the server persists partial output as
      //    stopped; reconciliation reloads it.
      if (owns(stream) !== null && terminal === null) {
        await settle(stream, { kind: "stopped" });
      }
    },

    clear(): void {
      if (active !== null && isBusyPhase(phase)) return;
      active = null;
      terminal = null;
      phase = "idle";
    }
  };
}

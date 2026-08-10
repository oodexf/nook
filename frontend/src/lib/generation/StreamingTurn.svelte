<script lang="ts">
  import { onDestroy } from "svelte";

  import CopyButton from "../components/CopyButton.svelte";
  import ReasoningBlock from "../components/ReasoningBlock.svelte";
  import MessageLane from "../conversations/MessageLane.svelte";
  import MarkdownContent from "../markdown/MarkdownContent.svelte";
  import type {
    GenerationPhase,
    GenerationTerminal
  } from "./generation-store.svelte";

  /**
   * The in-flight turn: optimistic user message plus the assistant stream.
   *
   * - Role lanes (Phase I-01): the optimistic user message sits in the
   *   same right-aligned lane as persisted user messages; the assistant
   *   stream uses the left reading lane.
   * - Live Markdown (Phase I-05): the visible buffer (already rAF-batched
   *   by the generation store) is additionally time-throttled here, so
   *   Markdown is never parsed per transport delta; incomplete Markdown
   *   renders defensively through the same pipeline, and the terminal
   *   transition forces one immediate final render. `MarkdownContent`
   *   remains the only sanitized HTML insertion point.
   * - Announcements change only on phase transitions, so assistive
   *   technology is not spammed per token (component-guidelines.md
   *   §Accessibility). Each terminal transition has exactly one live
   *   region owner: the failed alert / stopped note announce their own
   *   outcome, while the phase label announces the in-progress and
   *   completed transitions.
   * - Message-level copy (shared `CopyButton`, same contract as
   *   `MessageItem`): the optimistic user message and the current
   *   assistant buffer are copyable whenever they are non-empty —
   *   including partial, stopped, and failed replies. `getText` is read
   *   at click time, so mid-stream clicks copy the latest buffer. These
   *   message actions stay outside the Markdown content and are distinct
   *   from the per-code-block copy controls.
   */
  type Props = {
    /** Optimistic user message; null when the server copy is already shown. */
    userContent: string | null;
    assistantText: string;
    /** Accumulated thinking chain of the active stream (empty when absent). */
    reasoningText: string;
    phase: GenerationPhase;
    terminal: GenerationTerminal | null;
    model: string | null;
  };

  const {
    userContent,
    assistantText,
    reasoningText,
    phase,
    terminal,
    model
  }: Props = $props();

  /**
   * Minimum interval between streamed Markdown renders. Bounded
   * independently of transport chunk cadence; the first paint and the
   * terminal render are always immediate.
   */
  const LIVE_RENDER_INTERVAL_MS = 120;

  let renderedText = $state("");
  let lastRenderAt = 0;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelRenderTimer(): void {
    if (renderTimer !== null) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
  }

  $effect(() => {
    const text = assistantText;
    // Terminal transition: render the final buffer immediately and stop
    // throttling, so the settled view never waits for a trailing timer.
    if (terminal !== null) {
      cancelRenderTimer();
      renderedText = text;
      return;
    }
    if (text === renderedText) return;
    const now = Date.now();
    const elapsed = now - lastRenderAt;
    if (renderedText.length === 0 || elapsed >= LIVE_RENDER_INTERVAL_MS) {
      lastRenderAt = now;
      renderedText = text;
      return;
    }
    // Trailing render: one pending timer picks up the latest buffer.
    if (renderTimer === null) {
      renderTimer = setTimeout(() => {
        renderTimer = null;
        lastRenderAt = Date.now();
        renderedText = assistantText;
      }, LIVE_RENDER_INTERVAL_MS - elapsed);
    }
  });

  onDestroy(cancelRenderTimer);

  function statusLabel(currentPhase: GenerationPhase): string {
    switch (currentPhase) {
      case "connecting":
        return "正在连接…";
      case "streaming":
        return "正在生成…";
      case "stopping":
        return "正在停止…";
      case "completed":
        return "已完成";
      case "stopped":
        return "已停止";
      case "failed":
        return "生成失败";
      case "idle":
        return "";
    }
  }

  const label = $derived(statusLabel(phase));
  const isStreaming = $derived(
    phase === "connecting" || phase === "streaming" || phase === "stopping"
  );
  /**
   * One announcement owner per terminal transition: the failed alert and
   * the stopped note are themselves live regions (`role=alert` is
   * implicitly assertive, `role=status` polite), so the phase label drops
   * its live semantics for those two outcomes instead of announcing the
   * same transition twice. `completed` has no extra block, so the label
   * remains its announcement owner.
   */
  const terminalOwnsAnnouncement = $derived(
    terminal?.kind === "failed" || terminal?.kind === "stopped"
  );
</script>

<div class="turn" data-phase={phase}>
  {#if userContent !== null}
    <MessageLane role="user" ariaLabel="你">
      <header class="meta">
        <span class="role">你</span>
        <span class="status">发送中</span>
      </header>
      <p class="content">{userContent}</p>
      {#if userContent.length > 0}
        <div class="actions">
          <CopyButton
            label="复制你消息内容"
            copiedAnnouncement="消息内容已复制到剪贴板"
            failedAnnouncement="复制失败，请手动选择文本复制"
            getText={() => userContent ?? ""}
          />
        </div>
      {/if}
    </MessageLane>
  {/if}

  <MessageLane role="assistant" ariaLabel="助手">
    <header class="meta">
      <span class="role">助手</span>
      {#if model !== null}
        <code class="model">{model}</code>
      {/if}
      {#if label !== ""}
        {#if terminalOwnsAnnouncement}
          <!-- Visible only; the terminal block below owns the announcement. -->
          <span class="status" data-phase={phase}>{label}</span>
        {:else}
          <span
            class="status"
            data-phase={phase}
            role="status"
            aria-live="polite">{label}</span
          >
        {/if}
      {/if}
    </header>
    {#if reasoningText.length > 0}
      <!-- Thinking chain: expanded while it grows, auto-collapses once
           answer content starts; afterwards fully user-controlled. -->
      <ReasoningBlock
        reasoning={reasoningText}
        streaming={isStreaming && renderedText.length === 0}
        contentStarted={renderedText.length > 0}
        initiallyExpanded={true}
      />
    {/if}
    {#if renderedText.length > 0}
      <!-- Throttled snapshot; parsed and sanitized by the single
           MarkdownContent boundary, never per transport delta. Code-block
           copy controls are suppressed until the terminal render so the
           transient snapshots never expose interactive controls. -->
      <MarkdownContent
        content={renderedText}
        ariaLabel="助手消息内容"
        suppressCodeCopy={terminal === null}
      />
    {:else if isStreaming}
      <p class="content empty">…</p>
    {/if}
    {#if terminal?.kind === "failed"}
      <div class="failure" role="alert">
        <p class="failure-message">{terminal.message}</p>
        {#if terminal.code !== null}
          <p class="failure-code">
            错误代码：<code>{terminal.code}</code>{#if terminal.requestId}
              · 请求 ID：<code>{terminal.requestId}</code>{/if}
          </p>
        {/if}
      </div>
    {:else if terminal?.kind === "stopped"}
      <p class="stopped-note" role="status">已停止，以上内容已保留。</p>
    {/if}
    {#if assistantText.length > 0}
      <!-- Offered for the live buffer too: a stopped or failed turn keeps
           its partial reply copyable. -->
      <div class="actions">
        <CopyButton
          label="复制助手消息内容"
          copiedAnnouncement="消息内容已复制到剪贴板"
          failedAnnouncement="复制失败，请手动选择文本复制"
          getText={() => assistantText}
        />
      </div>
    {/if}
  </MessageLane>
</div>

<style>
  .turn {
    display: grid;
    gap: var(--space-5);
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .role {
    font-size: 0.85rem;
    font-weight: 700;
  }

  .model {
    overflow: hidden;
    max-width: 100%;
    padding: 1px var(--space-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--muted);
    background: var(--surface);
    font-size: 0.72rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status {
    padding: 1px var(--space-2);
    border-radius: 999px;
    color: var(--muted);
    background: var(--surface-muted);
    font-size: 0.72rem;
    font-weight: 650;
  }

  .status[data-phase="streaming"],
  .status[data-phase="connecting"] {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--surface));
  }

  .status[data-phase="failed"] {
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, var(--surface));
  }

  .content {
    margin: 0;
    line-height: 1.7;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .content.empty {
    color: var(--muted);
  }

  /* Message-level copy action row, attached to the owning lane (the user
     lane right-aligns it through the shared MessageLane contract). */
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .failure {
    display: grid;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    border: 1px solid color-mix(in srgb, var(--danger) 30%, var(--surface));
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--danger) 6%, var(--surface));
  }

  .failure-message {
    margin: 0;
    color: var(--danger);
    font-size: 0.85rem;
    line-height: 1.6;
  }

  .failure-code {
    margin: 0;
    color: var(--muted);
    font-size: 0.78rem;
  }

  .failure-code code {
    font-size: 0.75rem;
  }

  .stopped-note {
    margin: 0;
    color: var(--muted);
    font-size: 0.8rem;
  }
</style>

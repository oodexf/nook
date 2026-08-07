<script lang="ts">
  import MarkdownContent from "../markdown/MarkdownContent.svelte";
  import type {
    GenerationPhase,
    GenerationTerminal
  } from "./generation-store.svelte";

  /**
   * The in-flight turn: optimistic user message plus the assistant stream.
   *
   * Streamed deltas are plain text and never inserted as HTML; only the
   * terminal buffer renders once through the sanitized Markdown path
   * (Phase F-04). The status line is the only live region and changes
   * only on phase transitions, so assistive technology is not spammed
   * per token (component-guidelines.md §Accessibility).
   */
  type Props = {
    /** Optimistic user message; null when the server copy is already shown. */
    userContent: string | null;
    assistantText: string;
    phase: GenerationPhase;
    terminal: GenerationTerminal | null;
    model: string | null;
  };

  const { userContent, assistantText, phase, terminal, model }: Props =
    $props();

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
</script>

<div class="turn" data-phase={phase}>
  {#if userContent !== null}
    <article class="message user" aria-label="你">
      <header class="meta">
        <span class="role">你</span>
        <span class="status">发送中</span>
      </header>
      <p class="content">{userContent}</p>
    </article>
  {/if}

  <article class="message assistant" aria-label="助手">
    <header class="meta">
      <span class="role">助手</span>
      {#if model !== null}
        <code class="model">{model}</code>
      {/if}
      {#if label !== ""}
        <span
          class="status"
          data-phase={phase}
          role="status"
          aria-live="polite">{label}</span
        >
      {/if}
    </header>
    {#if terminal !== null && assistantText.length > 0}
      <!-- Terminal buffer: static content, parsed and sanitized once. -->
      <MarkdownContent content={assistantText} ariaLabel="助手消息内容" />
    {:else}
      <p class="content" class:empty={assistantText.length === 0}>
        {#if assistantText.length > 0}{assistantText}{:else if isStreaming}…{/if}
      </p>
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
  </article>
</div>

<style>
  .turn {
    display: grid;
    gap: var(--space-5);
  }

  .message {
    display: grid;
    gap: var(--space-2);
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

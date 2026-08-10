<script lang="ts">
  import type { ChatMessage } from "../api/conversations";
  import CopyButton from "../components/CopyButton.svelte";
  import ReasoningBlock from "../components/ReasoningBlock.svelte";
  import RefreshIcon from "../components/RefreshIcon.svelte";
  import MarkdownContent from "../markdown/MarkdownContent.svelte";
  import MessageLane from "./MessageLane.svelte";

  /**
   * One persisted message (Phase F-04/F-05, lanes in Phase I-01).
   *
   * - Role lanes come from the shared `MessageLane`: user on the right,
   *   assistant on the left, with status/copy/retry attached to the
   *   owning message.
   * - Assistant content renders through the single sanitized
   *   `MarkdownContent` path; the message list only receives final server
   *   content, so each message parses at most once per content change.
   * - User content is always plain text via normal Svelte escaping.
   * - The copy action is the shared compact icon control; feedback is
   *   announced through its polite status region, not a toast.
   */
  type Props = {
    message: ChatMessage;
    /** Retry is offered only for the latest retry-eligible assistant turn. */
    retryable?: boolean;
    retryDisabled?: boolean;
    onRetry?: ((assistantMessageId: string) => void) | null;
  };

  const {
    message,
    retryable = false,
    retryDisabled = false,
    onRetry = null
  }: Props = $props();

  const roleLabel = $derived(message.role === "user" ? "你" : "助手");

  function statusLabel(status: ChatMessage["status"]): string {
    switch (status) {
      case "completed":
        return "已完成";
      case "streaming":
        return "正在生成";
      case "stopped":
        return "已停止";
      case "error":
        return "出错";
      case "interrupted":
        return "已中断";
    }
  }

  function formatTime(milliseconds: number): string {
    return new Date(milliseconds).toLocaleString();
  }
</script>

<MessageLane role={message.role} ariaLabel={roleLabel}>
  <header class="meta">
    <span class="role">{roleLabel}</span>
    {#if message.model !== null}
      <code class="model">{message.model}</code>
    {/if}
    <span class="status" data-status={message.status}>
      {statusLabel(message.status)}
    </span>
    <time class="time">{formatTime(message.createdAt)}</time>
  </header>
  {#if message.role === "assistant"}
    {#if message.reasoning !== null && message.reasoning.length > 0}
      <!-- Persisted thinking chain: collapsed by default in history. -->
      <ReasoningBlock
        reasoning={message.reasoning}
        streaming={false}
        contentStarted={true}
        initiallyExpanded={false}
      />
    {/if}
    <MarkdownContent content={message.content} ariaLabel="助手消息内容" />
  {:else}
    <p class="content">{message.content}</p>
  {/if}
  {#if message.status === "error" || message.status === "interrupted"}
    <p class="failure-note" role="alert">
      {message.status === "interrupted"
        ? "这次响应因服务重启而中断，已保留当前内容。"
        : "这次响应未能完成，已保留当前内容。"}
      {#if message.errorCode !== null}
        错误代码：<code>{message.errorCode}</code>
      {/if}
    </p>
  {:else if message.status === "stopped"}
    <p class="stopped-note" role="status">已停止，以上内容已保留。</p>
  {/if}
  <div class="actions">
    <CopyButton
      label={`复制${roleLabel}消息内容`}
      copiedAnnouncement="消息内容已复制到剪贴板"
      failedAnnouncement="复制失败，请手动选择文本复制"
      getText={() => message.content}
    />
    {#if retryable}
      <button
        type="button"
        class="retry"
        disabled={retryDisabled}
        aria-label={message.status === "completed"
          ? "重新生成助手消息"
          : "重试助手消息"}
        title={message.status === "completed" ? "重新生成" : "重试"}
        onclick={() => onRetry?.(message.id)}
      >
        <RefreshIcon size={14} />
      </button>
    {/if}
  </div>
</MessageLane>

<style>
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

  .status[data-status="streaming"] {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--surface));
  }

  .status[data-status="error"],
  .status[data-status="interrupted"] {
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, var(--surface));
  }

  .time {
    color: var(--muted);
    font-size: 0.75rem;
  }

  .content {
    margin: 0;
    line-height: 1.7;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .failure-note {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid color-mix(in srgb, var(--danger) 30%, var(--surface));
    border-radius: var(--radius-sm);
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 6%, var(--surface));
    font-size: 0.8rem;
    line-height: 1.6;
  }

  .failure-note code {
    font-size: 0.75rem;
  }

  .stopped-note {
    margin: 0;
    color: var(--muted);
    font-size: 0.8rem;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .retry {
    display: inline-flex;
    width: var(--compact-action-size);
    height: var(--compact-action-size);
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--muted);
    background: transparent;
    transition:
      background-color var(--motion-fast),
      border-color var(--motion-fast),
      color var(--motion-fast),
      opacity var(--motion-fast);
  }

  .retry:hover:not(:disabled),
  .retry:focus-visible {
    border-color: var(--border-strong);
    color: var(--text);
    background: var(--surface-muted);
  }

  .retry:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  @media (any-pointer: coarse) {
    .retry {
      position: relative;
    }

    .retry::after {
      position: absolute;
      width: var(--touch-target);
      height: var(--touch-target);
      content: "";
    }
  }
</style>

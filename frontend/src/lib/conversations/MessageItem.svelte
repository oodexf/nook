<script lang="ts">
  import { copyText } from "../clipboard/copy-text";
  import type { ChatMessage } from "../api/conversations";
  import MarkdownContent from "../markdown/MarkdownContent.svelte";

  /**
   * One persisted message (Phase F-04/F-05).
   *
   * - Assistant content renders through the single sanitized
   *   `MarkdownContent` path; the message list only receives final server
   *   content, so each message parses at most once per content change.
   * - User content is always plain text via normal Svelte escaping.
   * - The copy action reports success/failure through a polite status
   *   region, not a toast.
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

  const COPY_LABEL = "复制";
  const FEEDBACK_MS = 1600;

  type CopyStatus = "idle" | "copied" | "failed";
  let copyStatus = $state<CopyStatus>("idle");
  let feedbackTimer: ReturnType<typeof setTimeout> | null = null;

  const roleLabel = $derived(message.role === "user" ? "你" : "助手");
  const copyButtonLabel = $derived(
    copyStatus === "copied"
      ? "已复制"
      : copyStatus === "failed"
        ? "复制失败"
        : COPY_LABEL
  );
  const copyAnnouncement = $derived(
    copyStatus === "copied"
      ? "消息内容已复制到剪贴板"
      : copyStatus === "failed"
        ? "复制失败，请手动选择文本复制"
        : ""
  );

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

  function handleCopy() {
    if (feedbackTimer !== null) {
      clearTimeout(feedbackTimer);
      feedbackTimer = null;
    }
    void copyText(message.content).then((ok) => {
      copyStatus = ok ? "copied" : "failed";
      feedbackTimer = setTimeout(() => {
        copyStatus = "idle";
        feedbackTimer = null;
      }, FEEDBACK_MS);
    });
  }
</script>

<article aria-label={roleLabel}>
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
    <button
      type="button"
      class="copy"
      data-state={copyStatus}
      aria-label={`复制${roleLabel}消息内容`}
      onclick={handleCopy}
    >
      {copyButtonLabel}
    </button>
    {#if retryable}
      <button
        type="button"
        class="retry"
        disabled={retryDisabled}
        onclick={() => onRetry?.(message.id)}
      >
        {message.status === "completed" ? "重新生成" : "重试"}
      </button>
    {/if}
    <span class="visually-hidden" role="status" aria-live="polite">
      {copyAnnouncement}
    </span>
  </div>
</article>

<style>
  article {
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

  .copy,
  .retry {
    min-height: var(--touch-target);
    padding: 0 var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    background: var(--surface);
    font-size: 0.85rem;
    font-weight: 650;
    transition:
      background-color var(--motion-fast),
      border-color var(--motion-fast),
      color var(--motion-fast),
      opacity var(--motion-fast);
  }

  .copy:hover,
  .retry:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--surface-muted);
  }

  .copy[data-state="copied"] {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
    color: var(--accent);
  }

  .copy[data-state="failed"] {
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
    color: var(--danger);
  }

  .retry:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
</style>

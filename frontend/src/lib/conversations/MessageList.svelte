<script lang="ts">
  import type { ChatMessage } from "../api/conversations";
  import type { ChatArtifact } from "../artifacts/artifacts";
  import MessageItem from "./MessageItem.svelte";

  /**
   * Persisted message list.
   *
   * Assistant content renders as sanitized Markdown and user content as
   * escaped plain text (both inside `MessageItem`). Retry is offered only
   * for the latest assistant message in a retry-eligible terminal state
   * (mirrors the server constraint in
   * `crates/storage/src/generation_repository.rs::create_retry_generation`);
   * the server always appends a new attempt and never overwrites.
   */
  type Props = {
    messages: ChatMessage[];
    /** IDs the generation overlay currently renders; hidden here. */
    excludedMessageIds?: readonly string[];
    onRetry?: ((assistantMessageId: string) => void) | null;
    retryDisabled?: boolean;
    onOpenArtifact?: ((artifact: ChatArtifact, trigger: HTMLButtonElement) => void) | null;
  };

  const {
    messages,
    excludedMessageIds = [],
    onRetry = null,
    retryDisabled = false,
    onOpenArtifact = null
  }: Props = $props();

  const RETRYABLE_STATUSES: readonly ChatMessage["status"][] = [
    "completed",
    "stopped",
    "error",
    "interrupted"
  ];

  const visibleMessages = $derived(
    messages.filter((message) => !excludedMessageIds.includes(message.id))
  );

  const latestAssistantId = $derived.by(() => {
    for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
      const message = visibleMessages[index];
      if (message.role === "assistant") return message.id;
    }
    return null;
  });

  function isRetryable(message: ChatMessage): boolean {
    return (
      onRetry !== null &&
      message.role === "assistant" &&
      message.id === latestAssistantId &&
      RETRYABLE_STATUSES.includes(message.status)
    );
  }
</script>

<ol class="messages">
  {#each visibleMessages as message (message.id)}
    <li class="message">
      <MessageItem
        {message}
        retryable={isRetryable(message)}
        {retryDisabled}
        {onRetry}
        {onOpenArtifact}
      />
    </li>
  {/each}
</ol>

<style>
  .messages {
    display: grid;
    gap: var(--space-5);
    margin: 0;
    padding: 0;
    list-style: none;
  }
</style>

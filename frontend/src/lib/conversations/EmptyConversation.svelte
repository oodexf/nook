<script lang="ts">
  import SparkIcon from "../components/SparkIcon.svelte";
  import DraftModelSelector from "../models/DraftModelSelector.svelte";
  import type { ModelStore } from "../models/model-store.svelte";

  type Props = {
    modelStore: ModelStore;
    csrfToken: string;
  };

  const { modelStore, csrfToken }: Props = $props();
</script>

<div class="empty">
  <span class="brand-mark"><SparkIcon size={22} /></span>
  <h2>开始一个新对话</h2>
  <p>从左侧选择历史对话继续查看,或为下方的新对话选择一个模型。</p>
  <DraftModelSelector store={modelStore} {csrfToken} />
  <p class="composer-note">在下方输入第一条消息后,对话将创建并锁定所选模型。</p>
</div>

<style>
  .empty {
    display: grid;
    justify-items: center;
    padding: var(--space-7) var(--space-5);
    text-align: center;
  }

  .brand-mark {
    display: grid;
    width: 52px;
    height: 52px;
    margin-bottom: var(--space-4);
    place-items: center;
    border-radius: var(--radius-md);
    color: var(--accent-contrast);
    background: var(--text);
  }

  h2 {
    margin: 0;
    font-size: 1.35rem;
    letter-spacing: -0.02em;
  }

  p {
    max-width: 24rem;
    margin: var(--space-3) 0 0;
    color: var(--muted);
    font-size: 0.925rem;
    line-height: 1.7;
  }

  .empty :global(.model-panel) {
    margin-top: var(--space-5);
  }

  .composer-note {
    font-size: 0.8rem;
  }
</style>

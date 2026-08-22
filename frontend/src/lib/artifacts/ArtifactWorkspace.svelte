<script lang="ts">
  import { tick } from "svelte";

  import { copyText } from "../clipboard/copy-text";
  import {
    ARTIFACT_IFRAME_PERMISSIONS,
    artifactDownloadName,
    buildArtifactPreviewDocument,
    captureArtifactTheme,
    downloadArtifact,
    type ChatArtifact
  } from "./artifacts";

  type Props = {
    artifact: ChatArtifact;
    artifacts: ChatArtifact[];
    onSelect: (artifactId: string) => void;
    onClose: () => void;
  };

  const { artifact, artifacts, onSelect, onClose }: Props = $props();
  let activeTab = $state<"preview" | "source">("preview");
  let copyStatus = $state<"idle" | "copied" | "failed">("idle");
  let closeButton = $state<HTMLButtonElement | null>(null);
  const previewDocument = $derived(
    buildArtifactPreviewDocument(artifact.kind, artifact.code, captureArtifactTheme())
  );

  $effect(() => {
    void artifact.id;
    activeTab = "preview";
    copyStatus = "idle";
  });

  $effect(() => {
    void tick().then(() => closeButton?.focus({ preventScroll: true }));
  });

  async function copySource(): Promise<void> {
    copyStatus = (await copyText(artifact.code)) ? "copied" : "failed";
  }

  function downloadPreview(): void {
    downloadArtifact(artifactDownloadName(artifact.kind), previewDocument);
  }

  function labelOf(item: ChatArtifact, index: number): string {
    const kind = item.kind === "javascript" ? "JS" : item.kind.toUpperCase();
    return `${kind} #${index + 1}`;
  }
</script>

<aside class="workspace" aria-label="Artifact 预览">
  <header class="toolbar">
    <div class="identity">
      <h2>Artifact</h2>
      {#if artifacts.length > 1}
        <label>
          <span class="visually-hidden">选择 Artifact</span>
          <select value={artifact.id} onchange={(event) => onSelect(event.currentTarget.value)}>
            {#each artifacts as item, index (item.id)}
              <option value={item.id}>{labelOf(item, index)}</option>
            {/each}
          </select>
        </label>
      {:else}
        <span class="kind">{labelOf(artifact, 0)}</span>
      {/if}
    </div>

    <div class="tabs" role="tablist" aria-label="Artifact 显示模式">
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "preview"}
        class:active={activeTab === "preview"}
        onclick={() => (activeTab = "preview")}>预览</button
      >
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "source"}
        class:active={activeTab === "source"}
        onclick={() => (activeTab = "source")}>源码</button
      >
    </div>

    <div class="actions">
      <button type="button" onclick={() => void copySource()} aria-label="复制 Artifact 源码">
        {copyStatus === "copied" ? "已复制" : copyStatus === "failed" ? "复制失败" : "复制"}
      </button>
      <button type="button" onclick={downloadPreview}>下载</button>
      <button bind:this={closeButton} type="button" onclick={onClose} aria-label="关闭 Artifact 预览">关闭</button>
    </div>
  </header>

  {#if activeTab === "preview"}
    {#key artifact.id}
      <iframe
        title="Artifact 隔离预览"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        allow={ARTIFACT_IFRAME_PERMISSIONS}
        srcdoc={previewDocument}
      ></iframe>
    {/key}
  {:else}
    <pre class="source"><code>{artifact.code}</code></pre>
  {/if}
  <span class="visually-hidden" role="status" aria-live="polite">
    {copyStatus === "copied" ? "Artifact 源码已复制" : copyStatus === "failed" ? "复制失败，请手动选择源码" : ""}
  </span>
</aside>

<style>
  .workspace {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    border-left: 1px solid var(--border);
    background: var(--surface);
  }

  .toolbar {
    position: relative;
    display: flex;
    min-height: 60px;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
  }

  .identity,
  .actions,
  .tabs {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: var(--space-1);
  }

  h2 {
    margin: 0;
    font-size: 0.9rem;
  }

  select,
  .kind {
    max-width: 8rem;
    color: var(--muted);
    background: var(--surface);
    font-size: 0.75rem;
  }

  button,
  select {
    min-height: 36px;
    padding: 0 var(--space-2);
    border: 1px solid transparent;
    border-radius: 8px;
  }

  button {
    color: var(--muted);
    background: transparent;
  }

  button:hover,
  button:focus-visible,
  button.active {
    border-color: var(--border-strong);
    color: var(--text);
    background: var(--surface-muted);
  }

  iframe {
    width: 100%;
    min-height: 0;
    flex: 1;
    border: 0;
    background: white;
  }

  .source {
    min-height: 0;
    flex: 1;
    overflow: auto;
    margin: 0;
    padding: var(--space-4);
    background: var(--surface-muted);
    font: 0.82rem/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    white-space: pre;
  }

  @media (max-width: 760px) {
    .workspace {
      border-left: 0;
    }

    .toolbar {
      flex-wrap: wrap;
    }

    .tabs {
      order: 3;
      width: 100%;
      justify-content: center;
    }

    button,
    select {
      min-height: var(--touch-target);
    }
  }
</style>

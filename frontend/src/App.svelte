<script lang="ts">
  import { onMount } from "svelte";

  import { fetchReadiness, type HealthStatus } from "./lib/api/health";

  let status = $state<HealthStatus>("checking");

  onMount(() => {
    const controller = new AbortController();
    void fetchReadiness(controller.signal).then((result) => {
      status = result;
    });

    return () => controller.abort();
  });
</script>

<svelte:head>
  <title>Minimal AI Chat</title>
</svelte:head>

<main>
  <section class="shell" aria-labelledby="app-title">
    <div class="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" role="img">
        <path d="M5 5.75A2.75 2.75 0 0 1 7.75 3h8.5A2.75 2.75 0 0 1 19 5.75v6.5A2.75 2.75 0 0 1 16.25 15H11l-4.7 4.1c-.5.43-1.3.08-1.3-.58V5.75Z" />
      </svg>
    </div>

    <p class="eyebrow">Self-hosted · Web-first</p>
    <h1 id="app-title">Minimal AI Chat</h1>
    <p class="summary">
      一个轻量、安静、由你掌控数据的 AI 对话空间。
    </p>

    <div class="status" aria-live="polite">
      <span class:ready={status === "ready"} class="status-dot"></span>
      {#if status === "checking"}
        正在检查服务…
      {:else if status === "ready"}
        服务已就绪
      {:else}
        暂时无法连接服务
      {/if}
    </div>

    <p class="note">
      项目骨架已经运行。鉴权与聊天功能将在后续实施阶段接入。
    </p>
  </section>
</main>


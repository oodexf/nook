<script lang="ts">
  import { onMount } from "svelte";

  import { onSessionExpired } from "./lib/api/client";
  import AuthPage from "./lib/auth/AuthPage.svelte";
  import { createSessionStore } from "./lib/auth/session-store.svelte";
  import PrimaryButton from "./lib/components/PrimaryButton.svelte";
  import AppShell from "./lib/conversations/AppShell.svelte";
  import { createThemeStore } from "./lib/theme/theme-store.svelte";

  const session = createSessionStore();
  // Created at the root so the theme applies to the auth page too; the
  // shell receives the same instance for the settings dialog (08-08).
  const theme = createThemeStore();

  onMount(() => {
    const controller = new AbortController();
    void session.bootstrap(controller.signal);
    // Centralized session expiry: any 401 from an authenticated API call
    // transitions back to the login page instead of leaving stale private
    // data on screen.
    const unsubscribe = onSessionExpired(() => session.expire());
    return () => {
      controller.abort();
      unsubscribe();
    };
  });
</script>

<svelte:head>
  <title>Minimal AI Chat</title>
</svelte:head>

{#if session.status.kind === "authenticated"}
  <AppShell
    csrfToken={session.status.csrfToken}
    isSigningOut={session.isBusy}
    onSignOut={() => void session.logout()}
    {theme}
  />
{:else}
<main class="auth-main">
  {#if session.status.kind === "checking"}
    <section class="panel panel-narrow" aria-label="会话检查">
      <AuthPage variant="checking" />
    </section>
  {:else if session.status.kind === "unauthenticated"}
    <section class="panel panel-narrow" aria-label="登录">
      <AuthPage
        variant="form"
        isSubmitting={session.isBusy}
        errorMessage={session.errorMessage}
        onLogin={(token, rememberMe) => session.login(token, rememberMe)}
      />
    </section>
  {:else if session.status.kind === "unavailable"}
    <section class="panel panel-narrow centered" aria-labelledby="unavailable-title">
      <p class="eyebrow">连接失败</p>
      <h1 id="unavailable-title">暂时无法连接服务</h1>
      <p class="summary">{session.status.message}</p>
      <PrimaryButton
        disabled={session.isBusy}
        onclick={() => void session.retryBootstrap()}
      >
        重试
      </PrimaryButton>
    </section>
  {/if}
</main>
{/if}

<style>
  .panel {
    padding: clamp(28px, 6vw, 56px);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .panel-narrow {
    width: min(100%, 480px);
  }

  .centered {
    display: grid;
    justify-items: center;
    text-align: center;
  }

  .centered .summary {
    margin: var(--space-4) 0 var(--space-6);
  }

  .eyebrow {
    margin: 0 0 var(--space-3);
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    font-size: clamp(1.9rem, 6vw, 2.6rem);
    letter-spacing: -0.03em;
    line-height: 1.1;
  }

  .summary {
    max-width: 30rem;
    margin: var(--space-5) 0 0;
    color: var(--muted);
    font-size: 1rem;
    line-height: 1.7;
  }

  @media (max-width: 480px) {
    .panel {
      display: flex;
      min-height: calc(100vh - 24px);
      flex-direction: column;
      justify-content: center;
      border-radius: var(--radius-md);
    }
  }
</style>

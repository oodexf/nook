<script lang="ts">
  import { onMount } from "svelte";

  import { onSessionExpired } from "./lib/api/client";
  import AuthPage from "./lib/auth/AuthPage.svelte";
  import AuthScene from "./lib/auth/AuthScene.svelte";
  import { createSessionStore } from "./lib/auth/session-store.svelte";
  import CircleAlertIcon from "./lib/components/CircleAlertIcon.svelte";
  import PrimaryButton from "./lib/components/PrimaryButton.svelte";
  import RefreshCwIcon from "./lib/components/RefreshCwIcon.svelte";
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
  <title>栖语 NooK</title>
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
  <AuthScene {theme}>
    {#if session.status.kind === "checking"}
      <AuthPage variant="checking" />
    {:else if session.status.kind === "unauthenticated"}
      <AuthPage
        variant="form"
        isSubmitting={session.isBusy}
        errorMessage={session.errorMessage}
        onLogin={(token, rememberMe) => session.login(token, rememberMe)}
      />
    {:else if session.status.kind === "unavailable"}
      <section class="card" aria-labelledby="unavailable-title">
        <span class="unavailable-icon" aria-hidden="true">
          <CircleAlertIcon size={22} />
        </span>
        <h1 id="unavailable-title">暂时无法连接服务</h1>
        <p class="summary">{session.status.message}</p>
        <PrimaryButton
          disabled={session.isBusy}
          onclick={() => void session.retryBootstrap()}
        >
          <span class="retry-content">
            <span class="retry-loader" class:spinning={session.isBusy} aria-hidden="true">
              <RefreshCwIcon size={18} />
            </span>
            <span>重试</span>
          </span>
        </PrimaryButton>
      </section>
    {/if}
  </AuthScene>
</main>
{/if}

<style>
  /* Mirrors the AuthPage card so every auth-stage state shares one shape. */
  .card {
    position: relative;
    z-index: 1;
    width: min(100%, 400px);
    padding: clamp(26px, 4vw, 36px);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow);
    color: var(--text);
  }

  .unavailable-icon {
    display: grid;
    width: 48px;
    height: 48px;
    margin-bottom: var(--space-5);
    place-items: center;
    border-radius: 14px;
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 12%, transparent);
  }

  h1 {
    margin: 0;
    color: var(--text-strong);
    font-size: 1.6rem;
    font-weight: 650;
    letter-spacing: -0.02em;
    line-height: 1.2;
  }

  .summary {
    margin: var(--space-2) 0 var(--space-6);
    color: var(--muted);
    font-size: 0.9rem;
    line-height: 1.6;
  }

  /* Shared `PrimaryButton` owns the button chrome; only the glyph + label row
     is styled here (matching the AuthPage submit action). */
  .retry-content {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .retry-loader {
    display: grid;
    place-items: center;
  }

  .retry-loader.spinning {
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .retry-loader.spinning {
      animation: none;
    }
  }

  @media (max-width: 480px) {
    .card {
      border-radius: var(--radius-md);
    }
  }
</style>

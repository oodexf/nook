<script lang="ts">
  import CheckIcon from "../components/CheckIcon.svelte";
  import NookLogo from "../components/NookLogo.svelte";
  import PrimaryButton from "../components/PrimaryButton.svelte";

  type Props = {
    variant: "checking" | "form";
    isSubmitting?: boolean;
    errorMessage?: string | null;
    onLogin?: (token: string, rememberMe: boolean) => Promise<boolean>;
  };

  const {
    variant,
    isSubmitting = false,
    errorMessage = null,
    onLogin
  }: Props = $props();

  // The raw token lives only in this field until the exchange completes; it is
  // never persisted (prd R5) and is cleared only after a successful exchange.
  // On failure it stays in place so the user can correct and resubmit it.
  let tokenField = $state("");
  let rememberMe = $state(false);
  let tokenInput = $state<HTMLInputElement | null>(null);

  async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (isSubmitting || tokenField.length === 0 || !onLogin) return;
    const token = tokenField;
    const exchanged = await onLogin(token, rememberMe).catch(() => false);
    if (exchanged) {
      tokenField = "";
    }
  }

  $effect(() => {
    if (variant === "form") {
      tokenInput?.focus();
    }
  });
</script>

{#if variant === "checking"}
  <div class="checking" role="status">
    <span class="brand-mark"><NookLogo size={72} /></span>
    <span class="checking-spinner" aria-hidden="true"></span>
    <p class="checking-text">正在验证会话…</p>
  </div>
{:else}
  <div class="auth-panel" aria-labelledby="auth-title">
    <span class="brand-mark"><NookLogo size={72} /></span>
    <p class="eyebrow">栖语</p>
    <h1 id="auth-title">欢迎回来</h1>

    <form onsubmit={handleSubmit}>
      <label class="field-label" for="access-token">访问令牌</label>
      <input
        id="access-token"
        bind:this={tokenInput}
        name="access-token"
        type="password"
        bind:value={tokenField}
        autocomplete="current-password"
        required
        disabled={isSubmitting}
      />

      <label class="remember">
        <input
          class="remember-input"
          type="checkbox"
          bind:checked={rememberMe}
          disabled={isSubmitting}
        />
        <span class="remember-box" aria-hidden="true">
          {#if rememberMe}
            <CheckIcon size={13} />
          {/if}
        </span>
        <span>记住我 30 天</span>
      </label>

      {#if errorMessage}
        <p class="form-error" role="alert">{errorMessage}</p>
      {/if}

      <PrimaryButton
        type="submit"
        fullWidth
        disabled={isSubmitting || tokenField.length === 0}
      >
        {isSubmitting ? "正在验证…" : "继续"}
      </PrimaryButton>
    </form>
  </div>
{/if}

<style>
  .brand-mark {
    display: grid;
    width: 72px;
    height: 72px;
    margin: 0 auto var(--space-7);
    place-items: center;
  }

  .checking {
    display: grid;
    justify-items: center;
    text-align: center;
  }

  .checking-spinner {
    width: 28px;
    height: 28px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .checking-text {
    margin: var(--space-4) 0 0;
    color: var(--muted);
    font-size: 0.9rem;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .checking-spinner {
      animation: none;
    }
  }

  .auth-panel {
    text-align: center;
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

  form {
    display: grid;
    margin-top: var(--space-7);
    text-align: left;
  }

  .field-label {
    margin-bottom: var(--space-2);
    font-size: 0.875rem;
    font-weight: 650;
  }

  input[type="password"] {
    width: 100%;
    min-height: var(--control-height);
    padding: 0 var(--space-4);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text);
    background: var(--surface);
    font-size: 1rem;
    transition: border-color var(--motion-fast);
  }

  .remember {
    position: relative;
    display: inline-flex;
    min-height: var(--touch-target);
    margin-top: var(--space-4);
    align-items: center;
    gap: var(--space-3);
    color: var(--muted);
    font-size: 0.9rem;
    cursor: pointer;
  }

  /* Native input stays in the DOM for semantics/focus but is invisible; */
  /* the visible control is the custom box with a Lucide check mark. */
  .remember-input {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    border: 0;
    opacity: 0;
    overflow: hidden;
  }

  .remember-box {
    display: grid;
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    place-items: center;
    border: 1.5px solid var(--border-strong);
    border-radius: 6px;
    color: var(--accent-contrast);
    background: var(--surface);
    transition:
      border-color var(--motion-fast),
      background-color var(--motion-fast);
  }

  .remember-input:checked + .remember-box {
    border-color: var(--accent);
    background: var(--accent);
  }

  .remember-input:focus-visible + .remember-box {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .remember-input:disabled ~ span {
    opacity: 0.6;
  }

  .form-error {
    margin: var(--space-2) 0 0;
    color: var(--danger);
    font-size: 0.875rem;
    line-height: 1.5;
  }

  form :global(.button-full) {
    margin-top: var(--space-4);
  }

</style>

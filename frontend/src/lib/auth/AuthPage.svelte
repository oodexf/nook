<script lang="ts">
  import { tick } from "svelte";

  import ArrowRightIcon from "../components/ArrowRightIcon.svelte";
  import CheckIcon from "../components/CheckIcon.svelte";
  import CircleAlertIcon from "../components/CircleAlertIcon.svelte";
  import EyeIcon from "../components/EyeIcon.svelte";
  import EyeOffIcon from "../components/EyeOffIcon.svelte";
  import KeyRoundIcon from "../components/KeyRoundIcon.svelte";
  import LoaderCircleIcon from "../components/LoaderCircleIcon.svelte";
  import NookLogo from "../components/NookLogo.svelte";
  import PrimaryButton from "../components/PrimaryButton.svelte";
  import ShieldCheckIcon from "../components/ShieldCheckIcon.svelte";

  /**
   * Authentication page.
   *
   * One calm card on the AuthScene backdrop: brand mark, title, a single
   * token field, remember-me, and the submit action. No canvas, no marquee,
   * no parallax — the page reads as part of the app, in the app's own
   * light/dark palette, and every color comes from a global token.
   *
   * DOM contract preserved for the AuthPage tests:
   * - `variant="checking"` renders a `[role="status"]` region and no `<form>`.
   * - `variant="form"` renders `input[type="password"]`, a default-unchecked
   *   `input[type="checkbox"]`, and `button[type="submit"]` that is disabled
   *   while the token is empty.
   * - The token field clears on a successful exchange and is retained on
   *   failure or a thrown callback, so the user can correct and resubmit.
   * - Errors are announced through a `[role="alert"]` element — now the
   *   field's own caption, paired with a danger-tinted, shaking field.
   * - `isSubmitting` disables the password input, checkbox, and submit button.
   *
   * No emoji anywhere; every glyph is a Lucide inline-SVG component.
   */

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
  let revealToken = $state(false);
  let tokenInput = $state<HTMLInputElement | null>(null);
  let fieldElement = $state<HTMLDivElement | null>(null);

  // Error presentation lives on the token field: the control turns danger and
  // shakes once, and the message sits directly under it. Two pieces of local
  // state separate "this submit was rejected" (the red field) from "there is a
  // message to read" — an expired-session message arrives without a submit, so
  // it must explain itself without painting an empty field red.
  let submitRejected = $state(false);
  let errorDismissed = $state(false);
  let shaking = $state(false);

  const showError = $derived(Boolean(errorMessage) && !errorDismissed);
  const fieldInvalid = $derived(showError && submitRejected);
  const errorId = "access-token-error";

  // Restarting the animation needs the browser to actually observe the class
  // leaving the element; a same-batch off/on is coalesced into no change, and
  // a rAF callback never runs while the tab is hidden. Flushing the removal
  // and forcing one style recalc restarts it reliably in both cases.
  async function replayShake(): Promise<void> {
    shaking = false;
    await tick();
    void fieldElement?.offsetWidth;
    shaking = true;
  }

  // Touching the field acknowledges the failure: the danger styling and the
  // message clear together, so the control never disagrees with its label.
  function handleInput(): void {
    if (!submitRejected && !showError) return;
    submitRejected = false;
    errorDismissed = true;
    // Also drops a shake that a hidden tab left un-ended (no `animationend`
    // fires while the page is not rendering).
    shaking = false;
  }

  async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (isSubmitting || tokenField.length === 0 || !onLogin) return;
    const token = tokenField;
    submitRejected = false;
    errorDismissed = false;
    const exchanged = await onLogin(token, rememberMe).catch(() => false);
    if (exchanged) {
      tokenField = "";
      return;
    }
    submitRejected = true;
    await replayShake();
  }

  $effect(() => {
    if (variant === "form") {
      tokenInput?.focus();
    }
  });
</script>

{#if variant === "checking"}
  <div class="card card-checking" role="status">
    <span class="mark"><NookLogo size={30} /></span>
    <p class="checking-text">
      正在验证会话
      <span class="spinner" aria-hidden="true">
        <LoaderCircleIcon size={16} />
      </span>
    </p>
  </div>
{:else}
  <section class="card" aria-labelledby="auth-title">
    <span class="mark"><NookLogo size={30} /></span>
    <h1 id="auth-title" class="title">欢迎回来</h1>
    <p class="subtitle">输入访问令牌，继续你的对话</p>

    <form onsubmit={handleSubmit}>
      <label class="field-label" for="access-token">访问令牌</label>

      <div
        class="field"
        class:invalid={fieldInvalid}
        class:shaking
        bind:this={fieldElement}
        onanimationend={() => (shaking = false)}
      >
        <span class="field-icon" aria-hidden="true">
          {#if fieldInvalid}
            <CircleAlertIcon size={17} />
          {:else}
            <KeyRoundIcon size={17} />
          {/if}
        </span>
        <input
          id="access-token"
          bind:this={tokenInput}
          name="access-token"
          type={revealToken ? "text" : "password"}
          bind:value={tokenField}
          oninput={handleInput}
          autocomplete="current-password"
          placeholder="粘贴你的访问令牌"
          required
          disabled={isSubmitting}
          aria-invalid={fieldInvalid}
          aria-describedby={showError ? errorId : undefined}
        />
        <button
          type="button"
          class="reveal-toggle"
          onclick={() => (revealToken = !revealToken)}
          disabled={isSubmitting}
          aria-label={revealToken ? "隐藏令牌" : "显示令牌"}
          aria-pressed={revealToken}
        >
          {#if revealToken}
            <EyeOffIcon size={17} />
          {:else}
            <EyeIcon size={17} />
          {/if}
        </button>
      </div>

      {#if showError}
        <p class="field-error" id={errorId} role="alert">{errorMessage}</p>
      {/if}

      <label class="remember">
        <input
          class="remember-input"
          type="checkbox"
          bind:checked={rememberMe}
          disabled={isSubmitting}
        />
        <span class="remember-box" aria-hidden="true">
          {#if rememberMe}
            <CheckIcon size={12} />
          {/if}
        </span>
        <span>记住我 30 天</span>
      </label>

      <div class="submit-row">
        <PrimaryButton
          type="submit"
          fullWidth
          disabled={isSubmitting || tokenField.length === 0}
        >
          <span class="submit-content">
            <span>{isSubmitting ? "正在验证" : "继续"}</span>
            {#if isSubmitting}
              <span class="spinner" aria-hidden="true">
                <LoaderCircleIcon size={17} />
              </span>
            {:else}
              <span class="submit-arrow" aria-hidden="true">
                <ArrowRightIcon size={17} />
              </span>
            {/if}
          </span>
        </PrimaryButton>
      </div>
    </form>

    <p class="note">
      <span class="note-icon" aria-hidden="true">
        <ShieldCheckIcon size={14} />
      </span>
      <span>令牌只用于这一次校验，不会保存在浏览器中</span>
    </p>
  </section>
{/if}

<style>
  .card {
    position: relative;
    z-index: 1;
    display: block;
    width: min(100%, 400px);
    padding: clamp(26px, 4vw, 36px);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow);
    animation: rise 480ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
  }

  .mark {
    display: grid;
    width: 48px;
    height: 48px;
    margin-bottom: var(--space-5);
    place-items: center;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: color-mix(in srgb, var(--text) 4%, transparent);
  }

  .title {
    margin: 0;
    color: var(--text-strong);
    font-size: 1.6rem;
    font-weight: 650;
    letter-spacing: -0.02em;
    line-height: 1.2;
  }

  .subtitle {
    margin: var(--space-2) 0 0;
    color: var(--muted);
    font-size: 0.9rem;
    line-height: 1.6;
  }

  /* Checking: the same card shrunk to a compact horizontal capsule, so the
     brief pre-form moment does not present a large mostly-empty panel. */
  .card-checking {
    display: flex;
    width: auto;
    max-width: 100%;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-5) var(--space-6) var(--space-5) var(--space-5);
  }

  .card-checking .mark {
    margin-bottom: 0;
  }

  .checking-text {
    display: flex;
    margin: 0;
    align-items: center;
    gap: var(--space-3);
    color: var(--text);
    font-size: 0.95rem;
    font-weight: 550;
  }

  .spinner {
    display: grid;
    place-items: center;
    color: var(--muted);
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  form {
    display: grid;
    margin-top: var(--space-6);
  }

  .field-label {
    margin-bottom: var(--space-2);
    color: var(--text);
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .field {
    display: flex;
    height: var(--control-height);
    align-items: center;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--text) 3%, transparent);
    transition:
      border-color var(--motion-fast),
      background-color var(--motion-fast),
      box-shadow var(--motion-fast);
  }

  /* The field itself carries the focus ring: the inner input suppresses its
     own outline so the control reads as one object. */
  .field:focus-within {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
    background: var(--surface);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 14%, transparent);
  }

  /* Rejected submit: the field itself carries the failure — danger border and
     tint, the key glyph swapped for an alert glyph, and one shake. It reverts
     the moment the user edits the token. */
  .field.invalid {
    border-color: var(--danger);
    background: color-mix(in srgb, var(--danger) 7%, transparent);
  }

  .field.invalid:focus-within {
    border-color: var(--danger);
    background: color-mix(in srgb, var(--danger) 5%, var(--surface));
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--danger) 16%, transparent);
  }

  .field.invalid .field-icon {
    color: var(--danger);
  }

  .field.shaking {
    animation: shake 400ms cubic-bezier(0.36, 0.07, 0.19, 0.97);
  }

  /* Short, decaying travel: enough to read as a refusal, not a tantrum. */
  @keyframes shake {
    20% {
      transform: translateX(-5px);
    }
    40% {
      transform: translateX(4px);
    }
    60% {
      transform: translateX(-3px);
    }
    80% {
      transform: translateX(2px);
    }
    100% {
      transform: translateX(0);
    }
  }

  .field-icon {
    display: grid;
    width: 42px;
    height: 100%;
    flex-shrink: 0;
    place-items: center;
    color: var(--muted);
    transition: color var(--motion-fast);
  }

  input[type="password"],
  input[type="text"] {
    width: 100%;
    height: 100%;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text);
    font-size: 0.95rem;
  }

  input[type="password"]::placeholder,
  input[type="text"]::placeholder {
    color: var(--muted);
    opacity: 0.75;
  }

  input[type="password"]:focus-visible,
  input[type="text"]:focus-visible {
    outline: none;
  }

  input:disabled {
    color: var(--muted);
  }

  .reveal-toggle {
    display: grid;
    width: 44px;
    height: 100%;
    flex-shrink: 0;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    color: var(--muted);
    background: transparent;
    transition: color var(--motion-fast);
  }

  .reveal-toggle:hover:not(:disabled) {
    color: var(--text);
  }

  .reveal-toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -3px;
  }

  .reveal-toggle:disabled {
    opacity: 0.5;
  }

  .remember {
    position: relative;
    display: inline-flex;
    min-height: var(--touch-target);
    margin-top: var(--space-3);
    align-items: center;
    gap: var(--space-3);
    color: var(--muted);
    font-size: 0.875rem;
    cursor: pointer;
  }

  /* Native input stays in the DOM for semantics/focus but is invisible; the
     visible control is the custom box with a Lucide check mark. */
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
    width: 18px;
    height: 18px;
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
    outline: 3px solid color-mix(in srgb, var(--accent) 55%, transparent);
    outline-offset: 2px;
  }

  .remember:hover .remember-box {
    border-color: var(--accent);
  }

  .remember-input:disabled ~ span {
    opacity: 0.6;
  }

  /* The message is the field's own caption, not a separate panel. */
  .field-error {
    margin: var(--space-2) 0 0;
    color: var(--danger);
    font-size: 0.8125rem;
    line-height: 1.5;
    animation: error-in 220ms ease both;
  }

  @keyframes error-in {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }

  /* The action is the shared `PrimaryButton` so the auth CTA keeps the app's
     primary-button language; only the label/glyph row is styled here. */
  .submit-row {
    margin-top: var(--space-5);
  }

  .submit-content {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .submit-arrow {
    display: grid;
    place-items: center;
  }

  .note {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-5) 0 0;
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 0.75rem;
    line-height: 1.5;
  }

  .note-icon {
    display: grid;
    flex-shrink: 0;
    place-items: center;
  }

  @media (prefers-reduced-motion: reduce) {
    .card,
    .spinner,
    .field-error {
      animation: none;
    }

    /* The danger color still carries the failure without any movement. */
    .field.shaking {
      animation: none;
    }
  }

  @media (max-width: 480px) {
    .card {
      border-radius: var(--radius-md);
    }
  }
</style>

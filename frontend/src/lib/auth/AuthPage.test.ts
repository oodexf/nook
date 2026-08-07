// @vitest-environment jsdom
import { mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AuthPage from "./AuthPage.svelte";

function submit(container: HTMLElement) {
  const form = container.querySelector("form");
  expect(form).not.toBeNull();
  form?.dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true })
  );
}

describe("AuthPage", () => {
  let container: HTMLElement;
  let instance: Record<string, never> | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (instance) {
      void unmount(instance);
      instance = undefined;
    }
    container.remove();
  });

  it("shows a polite checking state while the session is verified", () => {
    instance = mount(AuthPage, {
      target: container,
      props: { variant: "checking" }
    }) as Record<string, never>;

    expect(container.querySelector("[role='status']")).not.toBeNull();
    expect(container.querySelector("form")).toBeNull();
  });

  it("leaves Remember me unchecked by default", () => {
    instance = mount(AuthPage, {
      target: container,
      props: { variant: "form" }
    }) as Record<string, never>;

    const remember = container.querySelector<HTMLInputElement>(
      "input[type='checkbox']"
    );
    expect(remember?.checked).toBe(false);
  });

  it("requires a token before submitting", () => {
    const onLogin = vi.fn();
    instance = mount(AuthPage, {
      target: container,
      props: { variant: "form", onLogin }
    }) as Record<string, never>;

    const button = container.querySelector<HTMLButtonElement>(
      "button[type='submit']"
    );
    expect(button?.disabled).toBe(true);

    submit(container);
    expect(onLogin).not.toHaveBeenCalled();
  });

  function fillForm(token: string) {
    const input = container.querySelector<HTMLInputElement>(
      "input[type='password']"
    );
    const remember = container.querySelector<HTMLInputElement>(
      "input[type='checkbox']"
    );
    expect(input).not.toBeNull();
    expect(remember).not.toBeNull();
    if (!input || !remember) return { input: null, remember: null };

    input.value = token;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    remember.click();
    return { input, remember };
  }

  it("submits the token and remember-me choice once, then clears the field on success", async () => {
    const onLogin = vi.fn().mockResolvedValue(true);
    instance = mount(AuthPage, {
      target: container,
      props: { variant: "form", onLogin }
    }) as Record<string, never>;

    const { input } = fillForm("raw-token");
    if (!input) return;

    submit(container);

    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(onLogin).toHaveBeenCalledWith("raw-token", true);
    await vi.waitFor(() => {
      expect(input.value).toBe("");
    });
  });

  it("keeps the entered token after a failed login so it can be corrected", async () => {
    const onLogin = vi.fn().mockResolvedValue(false);
    instance = mount(AuthPage, {
      target: container,
      props: { variant: "form", onLogin }
    }) as Record<string, never>;

    const { input } = fillForm("wrong-token");
    if (!input) return;

    submit(container);

    expect(onLogin).toHaveBeenCalledWith("wrong-token", true);
    // Let the async submit handler settle, then prove the field survived.
    await vi.waitFor(() => {
      expect(onLogin).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    expect(input.value).toBe("wrong-token");
  });

  it("keeps the entered token when the login callback throws", async () => {
    const onLogin = vi.fn().mockRejectedValue(new Error("network down"));
    instance = mount(AuthPage, {
      target: container,
      props: { variant: "form", onLogin }
    }) as Record<string, never>;

    const { input } = fillForm("raw-token");
    if (!input) return;

    submit(container);

    await vi.waitFor(() => {
      expect(onLogin).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    expect(input.value).toBe("raw-token");
  });

  it("announces errors politely without leaking focus or state", () => {
    instance = mount(AuthPage, {
      target: container,
      props: { variant: "form", errorMessage: "访问令牌无效" }
    }) as Record<string, never>;

    const alert = container.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("访问令牌无效");
  });

  it("disables the form while a submission is in flight", () => {
    instance = mount(AuthPage, {
      target: container,
      props: { variant: "form", isSubmitting: true }
    }) as Record<string, never>;

    expect(
      container.querySelector<HTMLInputElement>("input[type='password']")
        ?.disabled
    ).toBe(true);
    expect(
      container.querySelector<HTMLInputElement>("input[type='checkbox']")
        ?.disabled
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>("button[type='submit']")
        ?.disabled
    ).toBe(true);
  });
});

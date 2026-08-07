// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Composer from "./Composer.svelte";

function mountComposer(props: {
  value?: string;
  disabled?: boolean;
  streaming?: boolean;
  stopping?: boolean;
  onSend?: (content: string) => void;
  onStop?: () => void;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const instance = mount(Composer, {
    target: container,
    props: {
      value: props.value ?? "",
      disabled: props.disabled ?? false,
      streaming: props.streaming ?? false,
      stopping: props.stopping ?? false,
      onSend: props.onSend ?? (() => undefined),
      onStop: props.onStop ?? (() => undefined)
    }
  }) as Record<string, never>;
  return { container, instance };
}

function textareaOf(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector("textarea");
  expect(textarea).not.toBeNull();
  if (!textarea) throw new Error("missing textarea");
  return textarea;
}

function type(container: HTMLElement, value: string) {
  const textarea = textareaOf(container);
  textarea.value = value;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  // Svelte flushes DOM updates asynchronously; tests observe the settled DOM.
  flushSync();
}

function pressEnter(
  container: HTMLElement,
  options: { shiftKey?: boolean; isComposing?: boolean } = {}
) {
  textareaOf(container).dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: options.shiftKey ?? false,
      isComposing: options.isComposing ?? false,
      bubbles: true,
      cancelable: true
    })
  );
}

describe("Composer", () => {
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    cleanup = null;
  });

  afterEach(() => {
    cleanup?.();
  });

  it("sends on Enter with trimmed content", () => {
    const onSend = vi.fn();
    const { container, instance } = mountComposer({ onSend });
    cleanup = () => {
      void unmount(instance);
      container.remove();
    };

    type(container, "  你好  ");
    pressEnter(container);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("你好");
  });

  it("inserts a newline on Shift+Enter instead of sending", () => {
    const onSend = vi.fn();
    const { container, instance } = mountComposer({ onSend });
    cleanup = () => {
      void unmount(instance);
      container.remove();
    };

    type(container, "第一行");
    pressEnter(container, { shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  it("suppresses send-on-Enter during IME composition", () => {
    const onSend = vi.fn();
    const { container, instance } = mountComposer({ onSend });
    cleanup = () => {
      void unmount(instance);
      container.remove();
    };
    const textarea = textareaOf(container);

    type(container, "ni hao");
    // Keydown flagged as composing (browser-driven IME).
    pressEnter(container, { isComposing: true });
    expect(onSend).not.toHaveBeenCalled();

    // Composition events (some browsers report composition only via events).
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    pressEnter(container);
    expect(onSend).not.toHaveBeenCalled();

    textarea.dispatchEvent(new CompositionEvent("compositionend"));
    pressEnter(container);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("keeps the send button disabled for empty or whitespace input", () => {
    const onSend = vi.fn();
    const { container, instance } = mountComposer({ onSend });
    cleanup = () => {
      void unmount(instance);
      container.remove();
    };

    const button = container.querySelector<HTMLButtonElement>("button.send");
    expect(button?.disabled).toBe(true);

    type(container, "   ");
    expect(button?.disabled).toBe(true);

    type(container, "内容");
    expect(button?.disabled).toBe(false);

    // Clicking the enabled button sends.
    button?.click();
    expect(onSend).toHaveBeenCalledWith("内容");
  });

  it("disables send while externally gated (no model / locked model removed)", () => {
    const onSend = vi.fn();
    const { container, instance } = mountComposer({ disabled: true, onSend });
    cleanup = () => {
      void unmount(instance);
      container.remove();
    };

    type(container, "内容");
    pressEnter(container);
    expect(onSend).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>("button.send")?.disabled).toBe(true);
  });

  it("shows Stop instead of Send while streaming and reports stops", () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const { container, instance } = mountComposer({
      streaming: true,
      onSend,
      onStop
    });
    cleanup = () => {
      void unmount(instance);
      container.remove();
    };

    expect(container.querySelector("button.send")).toBeNull();
    const stop = container.querySelector<HTMLButtonElement>("button.stop");
    expect(stop?.disabled).toBe(false);
    stop?.click();
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("disables Stop while a stop is already reconciling", () => {
    const { container, instance } = mountComposer({
      streaming: true,
      stopping: true
    });
    cleanup = () => {
      void unmount(instance);
      container.remove();
    };

    const stop = container.querySelector<HTMLButtonElement>("button.stop");
    expect(stop?.disabled).toBe(true);
  });

  it("auto-resizes the textarea within the cap on input", async () => {
    const { container, instance } = mountComposer({});
    cleanup = () => {
      void unmount(instance);
      container.remove();
    };
    const textarea = textareaOf(container);

    // jsdom reports scrollHeight as 0; the style contract is what matters:
    // height is recalculated from content on every input (inline style).
    type(container, "一行");
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(textarea.style.height).toBe("0px");
  });

  it("has an accessible label for the input", () => {
    const { container, instance } = mountComposer({});
    cleanup = () => {
      void unmount(instance);
      container.remove();
    };

    const textarea = textareaOf(container);
    const label = container.querySelector(`label[for='${textarea.id}']`);
    expect(label).not.toBeNull();
    expect(label?.textContent).toContain("消息输入框");
  });
});

// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import CopyButton from "./CopyButton.svelte";

function mountButton(getText: () => string = () => "文本") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const instance = mount(CopyButton, {
    target: container,
    props: {
      label: "复制消息内容",
      copiedAnnouncement: "已复制到剪贴板",
      failedAnnouncement: "复制失败，请手动复制",
      getText
    }
  }) as Record<string, never>;
  flushSync();
  return {
    container,
    destroy: () => {
      void unmount(instance);
      container.remove();
    }
  };
}

function stubClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true
  });
}

function buttonOf(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>("button.copy-button");
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

describe("CopyButton", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    // @ts-expect-error test cleanup of the stubbed clipboard
    delete navigator.clipboard;
  });

  it("renders a compact icon-only control with an accessible name", () => {
    const view = mountButton();

    const button = buttonOf(view.container);
    expect(button.getAttribute("aria-label")).toBe("复制消息内容");
    expect(button.title).toBe("复制消息内容");
    expect(button.dataset.state).toBe("idle");
    // Icon-only: the glyph is decorative and hidden from AT.
    const icon = button.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(button.textContent?.trim()).toBe("");
    // The polite feedback region exists and starts empty.
    const status = view.container.querySelector("[role='status']");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toBe("");
    view.destroy();
  });

  it("announces copied feedback through data-state and the live region", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const view = mountButton(() => "复制我");

    const button = buttonOf(view.container);
    button.click();

    await vi.waitFor(() => {
      expect(button.dataset.state).toBe("copied");
    });
    // The text is read at click time, not at mount time.
    expect(writeText).toHaveBeenCalledWith("复制我");
    expect(
      view.container.querySelector("[role='status']")?.textContent
    ).toBe("已复制到剪贴板");
    view.destroy();
  });

  it("announces failed feedback when the clipboard is unavailable", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    const view = mountButton();

    const button = buttonOf(view.container);
    button.click();

    await vi.waitFor(() => {
      expect(button.dataset.state).toBe("failed");
    });
    expect(
      view.container.querySelector("[role='status']")?.textContent
    ).toBe("复制失败，请手动复制");
    view.destroy();
  });

  it("swaps to a check glyph on copy and restores after about 1s", async () => {
    vi.useFakeTimers();
    try {
      stubClipboard(vi.fn().mockResolvedValue(undefined));
      const view = mountButton();

      const button = buttonOf(view.container);
      // Both glyphs ship in the markup; CSS swaps them via data-state.
      expect(button.querySelector("svg.icon-copy")).not.toBeNull();
      expect(button.querySelector("svg.icon-check")).not.toBeNull();

      button.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(button.dataset.state).toBe("copied");

      // Still showing the check just before the 1s mark...
      await vi.advanceTimersByTimeAsync(999);
      expect(button.dataset.state).toBe("copied");
      // ...and restored right after it.
      await vi.advanceTimersByTimeAsync(2);
      expect(button.dataset.state).toBe("idle");
      view.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the feedback state after the timeout", async () => {
    vi.useFakeTimers();
    try {
      stubClipboard(vi.fn().mockResolvedValue(undefined));
      const view = mountButton();

      const button = buttonOf(view.container);
      button.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(button.dataset.state).toBe("copied");

      await vi.advanceTimersByTimeAsync(1700);
      expect(button.dataset.state).toBe("idle");
      expect(
        view.container.querySelector("[role='status']")?.textContent
      ).toBe("");
      view.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

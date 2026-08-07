// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ConfirmDialog from "./ConfirmDialog.svelte";

type Mounted = Record<string, never>;

function keydown(target: HTMLElement, key: string, shiftKey = false) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })
  );
}

describe("ConfirmDialog", () => {
  let container: HTMLElement;
  let instance: Mounted | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (instance) {
      await unmount(instance);
      instance = undefined;
    }
    container.remove();
  });

  type DialogProps = {
    title: string;
    description?: string | null;
    confirmLabel: string;
    cancelLabel?: string;
    busy?: boolean;
    errorMessage?: string | null;
    onConfirm: () => void;
    onCancel: () => void;
    onRestoreFocus?: () => void;
  };

  async function openDialog(props: Partial<DialogProps> = {}) {
    instance = mount(ConfirmDialog, {
      target: container,
      props: {
        title: "删除对话",
        description: "此操作无法撤销。",
        confirmLabel: "永久删除",
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
        ...props
      }
    }) as Mounted;
    await tick();
    return instance;
  }

  function dialog(): HTMLElement {
    const element = container.querySelector<HTMLElement>("[role='dialog']");
    expect(element).not.toBeNull();
    if (!element) throw new Error("dialog missing");
    return element;
  }

  it("renders a labelled modal dialog", async () => {
    await openDialog();

    const element = dialog();
    expect(element.getAttribute("aria-modal")).toBe("true");
    const labelId = element.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(container.querySelector(`#${labelId}`)?.textContent).toBe("删除对话");
    expect(element.textContent).toContain("此操作无法撤销。");
  });

  it("moves initial focus to the cancel action", async () => {
    await openDialog();

    const active = document.activeElement;
    expect(active instanceof HTMLButtonElement).toBe(true);
    expect((active as HTMLButtonElement).textContent).toContain("取消");
  });

  it("cancels on Escape", async () => {
    const onCancel = vi.fn();
    await openDialog({ onCancel });

    keydown(dialog(), "Escape");

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancels when the backdrop itself is clicked, but not the dialog body", async () => {
    const onCancel = vi.fn();
    await openDialog({ onCancel });

    dialog().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onCancel).not.toHaveBeenCalled();

    const backdrop = container.querySelector<HTMLElement>(".backdrop");
    expect(backdrop).not.toBeNull();
    backdrop?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("confirms through the destructive action", async () => {
    const onConfirm = vi.fn();
    await openDialog({ onConfirm });

    const confirm = Array.from(
      dialog().querySelectorAll<HTMLButtonElement>("button")
    ).find((button) => button.textContent?.includes("永久删除"));
    expect(confirm).toBeDefined();
    confirm?.click();

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("traps Tab within the dialog", async () => {
    await openDialog();

    const buttons = dialog().querySelectorAll<HTMLButtonElement>("button");
    expect(buttons.length).toBe(2);
    const cancel = buttons[0];
    const confirm = buttons[1];
    cancel.focus();

    // Tab on the last element wraps to the first.
    confirm.focus();
    keydown(dialog(), "Tab");
    expect(document.activeElement).toBe(cancel);

    // Shift+Tab on the first element wraps to the last.
    keydown(dialog(), "Tab", true);
    expect(document.activeElement).toBe(confirm);
  });

  it("restores focus to the opening element on close", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    await openDialog();
    expect(document.activeElement).not.toBe(opener);

    await unmount(instance as Mounted);
    instance = undefined;

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("uses the fallback focus target when the opener is gone", async () => {
    const onRestoreFocus = vi.fn();
    await openDialog({ onRestoreFocus });

    await unmount(instance as Mounted);
    instance = undefined;

    // Opener was document.body (not an HTMLElement button), so the fallback runs.
    expect(onRestoreFocus).toHaveBeenCalledTimes(1);
  });

  it("blocks cancel and confirms nothing while busy", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    await openDialog({ busy: true, onCancel, onConfirm });

    const buttons = dialog().querySelectorAll<HTMLButtonElement>("button");
    expect(buttons[0]?.disabled).toBe(true);
    expect(buttons[1]?.disabled).toBe(true);
    keydown(dialog(), "Escape");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("announces an inline error", async () => {
    await openDialog({ errorMessage: "删除失败，请稍后重试。" });

    const alert = dialog().querySelector("[role='alert']");
    expect(alert?.textContent).toBe("删除失败，请稍后重试。");
  });
});

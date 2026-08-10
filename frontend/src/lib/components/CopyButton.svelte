<script lang="ts">
  import type { Attachment } from "svelte/attachments";

  import {
    createCopyControl,
    type CopyControlOptions
  } from "../clipboard/copy-control";

  /**
   * Compact icon-only copy action (Phase I-02).
   *
   * Wraps the shared `createCopyControl` factory so Svelte views and the
   * code-block enhancement in `MarkdownContent` share exactly one copy
   * implementation (44px target, transparent resting border, hover/focus
   * border, polite copied/failed announcement).
   */
  type Props = CopyControlOptions;

  const props: Props = $props();

  const attach: Attachment<HTMLElement> = (slot) => {
    // `getText` is a closure read at click time, so the control never
    // holds stale content even though it is created only once.
    const control = createCopyControl(props);
    slot.append(control.button, control.status);
    return () => {
      control.destroy();
      control.button.remove();
      control.status.remove();
    };
  };
</script>

<span class="copy-slot" {@attach attach}></span>

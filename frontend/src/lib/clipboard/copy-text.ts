/**
 * Clipboard helper for message and code-block copy actions (Phase F-05).
 *
 * Prefers the async Clipboard API and falls back to a hidden textarea plus
 * `document.execCommand("copy")` for browsers or permission states where the
 * async API is unavailable or rejects (e.g. non-secure-context dev hosts).
 * Never throws: the boolean result drives the accessible status text.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or API rejection: try the legacy path below.
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  // Keep the helper off-screen without display:none (unselectable in some
  // browsers) and without stealing layout space.
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return (
      typeof document.execCommand === "function" &&
      document.execCommand("copy")
    );
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

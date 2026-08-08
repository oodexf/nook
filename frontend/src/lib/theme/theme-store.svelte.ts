/**
 * Theme preference store (08-08 UI polish).
 *
 * Owns the user's theme preference ("system" follows the OS), persists it
 * to localStorage, and applies the effective theme as `data-theme` on the
 * document root so the palette swap lives entirely in global.css custom
 * properties. The store is created once by `App` during component init
 * (its `$effect`s need that context) and passed down to the settings
 * dialog; `AppShell` falls back to its own instance when mounted without
 * one (unit tests), which is safe because the applied DOM state is
 * identical.
 */

export type ThemePreference = "system" | "light" | "dark";
export type EffectiveTheme = "light" | "dark";

const STORAGE_KEY = "chat.theme-preference";

function readStoredPreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "system" || raw === "light" || raw === "dark") return raw;
  } catch {
    // Storage unavailable (private mode, jsdom): fall through to default.
  }
  return "system";
}

function systemPrefersDark(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export type ThemeStore = {
  readonly preference: ThemePreference;
  /** The resolved theme after applying the system fallback. */
  readonly effective: EffectiveTheme;
  setPreference(next: ThemePreference): void;
};

export function createThemeStore(): ThemeStore {
  let preference = $state<ThemePreference>(readStoredPreference());
  let systemDark = $state(systemPrefersDark());

  const effective = $derived<EffectiveTheme>(
    preference === "system" ? (systemDark ? "dark" : "light") : preference
  );

  // Single application point: the whole palette is CSS variables keyed
  // off this attribute in global.css.
  $effect(() => {
    document.documentElement.dataset.theme = effective;
  });

  // Track OS theme changes while following the system.
  $effect(() => {
    if (preference !== "system") return;
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (event: MediaQueryListEvent) => {
      systemDark = event.matches;
    };
    query.addEventListener("change", listener);
    return () => {
      query.removeEventListener("change", listener);
    };
  });

  return {
    get preference() {
      return preference;
    },
    get effective() {
      return effective;
    },
    setPreference(next: ThemePreference) {
      preference = next;
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Persistence is best-effort; the in-memory choice still applies.
      }
    }
  };
}

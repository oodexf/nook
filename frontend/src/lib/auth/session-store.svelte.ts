import {
  fetchSession,
  login as exchangeToken,
  logout as clearServerSession
} from "../api/session";

/**
 * Session state machine (design.md §12):
 *
 *   checking → unauthenticated | authenticated | unavailable
 *   unauthenticated --login--> authenticated
 *   authenticated --logout or expiry--> unauthenticated
 *   unavailable --retry--> checking
 *
 * `unavailable` is a recoverable transport/config failure with a retry action;
 * it never renders application data. The raw access token never enters this
 * store; it exists only inside the login submission call.
 */
export type SessionStatus =
  | { kind: "checking" }
  | { kind: "unauthenticated" }
  | { kind: "authenticated"; csrfToken: string }
  | { kind: "unavailable"; message: string };

export type SessionStore = {
  readonly status: SessionStatus;
  readonly isBusy: boolean;
  readonly errorMessage: string | null;
  bootstrap(signal?: AbortSignal): Promise<void>;
  retryBootstrap(): Promise<void>;
  /** Resolves to true only when the exchange ends in an authenticated session. */
  login(token: string, rememberMe: boolean): Promise<boolean>;
  logout(): Promise<void>;
  /**
   * Centralized session-expiry transition: any authenticated API call that
   * receives 401 routes here (via `onSessionExpired` in `lib/api/client`),
   * dropping the in-memory session so private data is never left on screen.
   */
  expire(): void;
  clearError(): void;
};

const UNEXPECTED_ERROR_MESSAGE = "操作失败，请稍后重试。";

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : UNEXPECTED_ERROR_MESSAGE;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function createSessionStore(): SessionStore {
  let status = $state<SessionStatus>({ kind: "checking" });
  let busy = $state(false);
  let errorMessage = $state<string | null>(null);

  async function bootstrap(signal?: AbortSignal): Promise<void> {
    status = { kind: "checking" };
    errorMessage = null;
    try {
      const session = await fetchSession(signal);
      status = session;
    } catch (error) {
      if (isAbort(error)) {
        return;
      }
      status = { kind: "unavailable", message: errorMessageOf(error) };
    }
  }

  return {
    get status() {
      return status;
    },
    get isBusy() {
      return busy;
    },
    get errorMessage() {
      return errorMessage;
    },

    bootstrap,

    async retryBootstrap(): Promise<void> {
      // Own the busy flag so repeated clicks collapse into one request and the
      // retry button disables. The initial onMount bootstrap calls bootstrap()
      // directly with its AbortSignal and is unaffected by this guard.
      if (busy) return;
      busy = true;
      try {
        await bootstrap();
      } finally {
        busy = false;
      }
    },

    async login(token: string, rememberMe: boolean): Promise<boolean> {
      if (busy || token.length === 0) return false;
      busy = true;
      errorMessage = null;
      try {
        await exchangeToken(token, rememberMe);
        const session = await fetchSession();
        if (session.kind !== "authenticated") {
          // The exchange returned 2xx but no session materialized; treat it as
          // a failure so the form keeps the token for correction.
          errorMessage = UNEXPECTED_ERROR_MESSAGE;
          return false;
        }
        status = session;
        return true;
      } catch (error) {
        if (!isAbort(error)) {
          errorMessage = errorMessageOf(error);
        }
        return false;
      } finally {
        busy = false;
      }
    },

    async logout(): Promise<void> {
      if (busy || status.kind !== "authenticated") return;
      const { csrfToken } = status;
      busy = true;
      errorMessage = null;
      try {
        await clearServerSession(csrfToken);
        status = { kind: "unauthenticated" };
      } catch (error) {
        if (isAbort(error)) {
          return;
        }
        errorMessage = errorMessageOf(error);
      } finally {
        busy = false;
      }
    },

    clearError(): void {
      errorMessage = null;
    },

    expire(): void {
      if (status.kind !== "authenticated") return;
      status = { kind: "unauthenticated" };
      errorMessage = "登录已过期，请重新登录。";
    }
  };
}

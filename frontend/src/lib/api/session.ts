export type AuthenticatedSession = {
  kind: "authenticated";
  csrfToken: string;
};

export type SessionState =
  | { kind: "checking" }
  | { kind: "unauthenticated" }
  | AuthenticatedSession;

const NETWORK_ERROR_MESSAGE = "暂时无法连接服务，请检查网络后重试。";

export function decodeSession(value: unknown): AuthenticatedSession | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "authenticated" in value &&
    value.authenticated === true &&
    "csrf_token" in value &&
    typeof value.csrf_token === "string" &&
    value.csrf_token.length > 0
  ) {
    return { kind: "authenticated", csrfToken: value.csrf_token };
  }
  return null;
}

export function decodeSessionError(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null &&
    "code" in value.error &&
    typeof value.error.code === "string"
  ) {
    switch (value.error.code) {
      case "invalid_credentials":
        return "访问令牌无效，请检查后重试。";
      case "rate_limited":
        return "尝试次数过多，请稍后再试。";
      case "csrf_rejected":
        return "请求来源验证失败，请刷新页面后重试。";
      default:
        return "登录失败，请稍后重试。";
    }
  }
  return null;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function fetchSession(signal?: AbortSignal): Promise<SessionState> {
  let response: Response;
  try {
    response = await fetch("/api/v1/session", {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      signal
    });
  } catch (error) {
    if (isAbort(error)) {
      throw error;
    }
    throw new Error(NETWORK_ERROR_MESSAGE, { cause: error });
  }

  if (response.status === 401) {
    return { kind: "unauthenticated" };
  }
  if (!response.ok) {
    throw new Error("暂时无法验证登录状态，请稍后重试。");
  }
  const session = decodeSession(await response.json().catch(() => null));
  if (!session) {
    throw new Error("服务返回了无法识别的登录状态。");
  }
  return session;
}

export async function login(token: string, rememberMe: boolean): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/v1/session", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ token, remember_me: rememberMe })
    });
  } catch (error) {
    throw new Error(NETWORK_ERROR_MESSAGE, { cause: error });
  }

  if (response.ok) {
    return;
  }

  const payload: unknown = await response.json().catch(() => null);
  throw new Error(
    decodeSessionError(payload) ?? "登录失败，请检查访问令牌后重试。"
  );
}

export async function logout(csrfToken: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/v1/session", {
      method: "DELETE",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "X-CSRF-Token": csrfToken
      }
    });
  } catch (error) {
    throw new Error(NETWORK_ERROR_MESSAGE, { cause: error });
  }

  // 401 means the session is already gone; the logout goal is reached.
  if (!response.ok && response.status !== 401) {
    throw new Error("退出失败，请稍后重试。");
  }
}

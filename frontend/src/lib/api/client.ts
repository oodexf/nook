/**
 * Shared API client boundary (spec: streaming-data-access.md).
 *
 * Every feature API module sends requests through `apiRequest`, which owns:
 * - same-origin paths and `credentials: "same-origin"`;
 * - the session-bound `X-CSRF-Token` header on mutations;
 * - JSON parsing from `unknown`;
 * - the normalized `ApiError` taxonomy;
 * - the centralized session-expiry (401) notification.
 *
 * Components never call `fetch` directly and never see a raw `Response`.
 */

const API_INVALID_PAYLOAD = Symbol("api-invalid-payload");

export type ApiErrorKind =
  | "network"
  | "session-expired"
  | "http"
  | "invalid-response";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  /** Stable server error code when the error envelope was decodable. */
  readonly code: string | null;
  readonly requestId: string | null;

  constructor(
    kind: ApiErrorKind,
    message: string,
    init: {
      status?: number;
      code?: string;
      requestId?: string;
      cause?: unknown;
    } = {}
  ) {
    super(message, { cause: init.cause });
    this.name = "ApiError";
    this.kind = kind;
    this.status = init.status ?? null;
    this.code = init.code ?? null;
    this.requestId = init.requestId ?? null;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export const NETWORK_ERROR_MESSAGE =
  "暂时无法连接服务，请检查网络后重试。";
export const SESSION_EXPIRED_MESSAGE = "登录已过期，请重新登录。";
export const INVALID_RESPONSE_MESSAGE =
  "服务返回了无法识别的数据，请稍后重试。";
export const GENERIC_ERROR_MESSAGE = "操作失败，请稍后重试。";

export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : GENERIC_ERROR_MESSAGE;
}

/**
 * Central session-expiry mechanism: any authenticated API call that receives
 * 401 notifies every registered listener exactly once per response. The app
 * wires one listener that transitions the session store to `unauthenticated`,
 * so stale private data is never left on screen.
 */
export type SessionExpiredListener = () => void;

const sessionExpiredListeners = new Set<SessionExpiredListener>();

export function onSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(listener);
  return () => {
    sessionExpiredListeners.delete(listener);
  };
}

function notifySessionExpired(): void {
  for (const listener of sessionExpiredListeners) {
    listener();
  }
}

type DecodedErrorBody = {
  code: string;
  message: string;
  requestId: string;
};

const MAX_ERROR_FIELD_LENGTH = 300;

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** Decodes the public error envelope: `{ error: { code, message, request_id } }`. */
export function decodeErrorBody(value: unknown): DecodedErrorBody | null {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return null;
  }
  const error = value.error;
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const { code, message, request_id: requestId } = error as Record<
    string,
    unknown
  >;
  if (
    isBoundedString(code, MAX_ERROR_FIELD_LENGTH) &&
    isBoundedString(message, MAX_ERROR_FIELD_LENGTH) &&
    isBoundedString(requestId, MAX_ERROR_FIELD_LENGTH)
  ) {
    return { code, message, requestId };
  }
  return null;
}

export type ApiRequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Required on state-changing requests; sent as `X-CSRF-Token`. */
  csrfToken?: string;
  /** JSON-serializable request body. */
  body?: unknown;
  signal?: AbortSignal;
};

/**
 * Sends one same-origin JSON API request. Resolves with the decoded payload as
 * `unknown` (feature modules decode it further) and rejects only with
 * `ApiError` — or the original abort error, which callers pass through.
 */
export async function apiRequest(
  path: string,
  options: ApiRequestOptions = {}
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (options.csrfToken !== undefined) {
    headers["X-CSRF-Token"] = options.csrfToken;
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : null,
      signal: options.signal ?? null
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new ApiError("network", NETWORK_ERROR_MESSAGE, { cause: error });
  }

  if (response.status === 401) {
    notifySessionExpired();
    throw new ApiError("session-expired", SESSION_EXPIRED_MESSAGE, {
      status: 401
    });
  }

  if (response.status === 204) {
    return null;
  }

  const payload: unknown = await response
    .json()
    .catch(() => API_INVALID_PAYLOAD);

  if (!response.ok) {
    const decoded = decodeErrorBody(
      payload === API_INVALID_PAYLOAD ? null : payload
    );
    throw new ApiError(
      "http",
      decoded?.message ?? GENERIC_ERROR_MESSAGE,
      {
        status: response.status,
        code: decoded?.code,
        requestId: decoded?.requestId
      }
    );
  }

  if (payload === API_INVALID_PAYLOAD) {
    throw new ApiError("invalid-response", INVALID_RESPONSE_MESSAGE, {
      status: response.status
    });
  }
  return payload;
}

export type ApiStreamRequestOptions = {
  /** Required: chat streams are state-changing POSTs. */
  csrfToken: string;
  /** JSON-serializable request body; omitted for body-less POSTs. */
  body?: unknown;
  signal?: AbortSignal;
};

/**
 * Sends one same-origin streaming POST and returns the raw `Response` for
 * body consumption by the central SSE decoder (`lib/api/sse.ts`).
 *
 * Mirrors `apiRequest` for the pre-stream phase: cookie credentials, the
 * session-bound CSRF header (the Origin header is attached automatically by
 * the browser for same-origin POSTs and validated server-side), 401 session
 * expiry notification, and JSON error-envelope decoding. After a 2xx the
 * caller owns `response.body`; in-stream failures are reported by the
 * decoder/reader, not here.
 */
export async function apiStreamRequest(
  path: string,
  options: ApiStreamRequestOptions
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    "X-CSRF-Token": options.csrfToken
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : null,
      signal: options.signal ?? null
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new ApiError("network", NETWORK_ERROR_MESSAGE, { cause: error });
  }

  if (response.status === 401) {
    notifySessionExpired();
    throw new ApiError("session-expired", SESSION_EXPIRED_MESSAGE, {
      status: 401
    });
  }

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const decoded = decodeErrorBody(payload);
    throw new ApiError("http", decoded?.message ?? GENERIC_ERROR_MESSAGE, {
      status: response.status,
      code: decoded?.code,
      requestId: decoded?.requestId
    });
  }

  if (response.body === null) {
    throw new ApiError("invalid-response", INVALID_RESPONSE_MESSAGE, {
      status: response.status
    });
  }
  return response;
}

/**
 * Model catalog API boundary.
 *
 * Decodes the public DTOs owned by `crates/server/src/models.rs` from
 * `unknown`. Field names on the wire are snake_case; decoded frontend types
 * use camelCase. The provider API key and raw upstream bodies never cross
 * this boundary: failures arrive as typed `ApiError`s with safe server
 * messages, and a malformed success payload is rejected wholesale (the
 * frontend never repairs or invents catalog entries).
 *
 * A refresh error paired with a stale cached catalog is 200 + `stale: true`;
 * a catalog failure with no cache, an empty/malformed catalog, or a missing
 * configured default is an HTTP error with a stable `error.code`.
 */

import { ApiError, INVALID_RESPONSE_MESSAGE, apiRequest } from "./client";

export type ModelEntry = {
  id: string;
  label: string;
};

/** Safe, stable model-catalog failure categories (mirror of the server). */
export type ModelCatalogErrorCode =
  | "model_provider_unauthorized"
  | "model_provider_rate_limited"
  | "model_provider_timeout"
  | "model_provider_unavailable"
  | "model_provider_invalid_response"
  | "model_catalog_empty"
  | "model_default_missing";

export type ModelRefreshError = {
  code: ModelCatalogErrorCode;
  message: string;
  requestId: string;
};

export type ModelCatalog = {
  models: ModelEntry[];
  defaultModel: string;
  refreshedAt: number;
  stale: boolean;
  refreshError: ModelRefreshError | null;
};

/** Catalog failure codes that indicate an operator configuration problem. */
export type ModelConfigurationErrorCode =
  | "model_default_missing"
  | "model_catalog_empty"
  | "model_provider_invalid_response";

const CONFIGURATION_ERROR_CODES: readonly ModelConfigurationErrorCode[] = [
  "model_default_missing",
  "model_catalog_empty",
  "model_provider_invalid_response"
];

const CATALOG_ERROR_CODES: readonly ModelCatalogErrorCode[] = [
  "model_provider_unauthorized",
  "model_provider_rate_limited",
  "model_provider_timeout",
  "model_provider_unavailable",
  "model_provider_invalid_response",
  "model_catalog_empty",
  "model_default_missing"
];

// Bounds mirror the server contract: provider model IDs are capped at 200
// characters and safe error fields stay short single-line strings.
const MAX_MODEL_FIELD_LENGTH = 200;
const MAX_ERROR_FIELD_LENGTH = 300;
const MAX_REQUEST_ID_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCatalogErrorCode(value: unknown): value is ModelCatalogErrorCode {
  return (
    typeof value === "string" &&
    CATALOG_ERROR_CODES.includes(value as ModelCatalogErrorCode)
  );
}

function decodeModelEntry(value: unknown): ModelEntry | null {
  if (!isRecord(value)) return null;
  if (
    isBoundedString(value.id, MAX_MODEL_FIELD_LENGTH) &&
    isBoundedString(value.label, MAX_MODEL_FIELD_LENGTH)
  ) {
    return { id: value.id, label: value.label };
  }
  return null;
}

function decodeRefreshError(value: unknown): ModelRefreshError | null {
  if (!isRecord(value)) return null;
  if (
    isCatalogErrorCode(value.code) &&
    isBoundedString(value.message, MAX_ERROR_FIELD_LENGTH) &&
    isBoundedString(value.request_id, MAX_REQUEST_ID_LENGTH)
  ) {
    return {
      code: value.code,
      message: value.message,
      requestId: value.request_id
    };
  }
  return null;
}

export function decodeModelCatalog(value: unknown): ModelCatalog | null {
  if (!isRecord(value) || !Array.isArray(value.models)) return null;
  const models: ModelEntry[] = [];
  for (const entry of value.models) {
    const decoded = decodeModelEntry(entry);
    if (!decoded) return null;
    models.push(decoded);
  }
  if (
    !isBoundedString(value.default_model, MAX_MODEL_FIELD_LENGTH) ||
    !isTimestamp(value.refreshed_at) ||
    typeof value.stale !== "boolean"
  ) {
    return null;
  }
  const refreshErrorRaw = value.refresh_error;
  const refreshError =
    refreshErrorRaw === null ? null : decodeRefreshError(refreshErrorRaw);
  if (refreshErrorRaw !== null && refreshError === null) return null;
  return {
    models,
    defaultModel: value.default_model,
    refreshedAt: value.refreshed_at,
    stale: value.stale,
    refreshError
  };
}

/**
 * Blocking configuration failures: the server rejected the catalog because
 * the configured default is absent or the catalog itself is unusable. These
 * are never recoverable by picking another model client-side.
 */
export function isModelConfigurationErrorCode(
  code: string | null
): code is ModelConfigurationErrorCode {
  return (
    code !== null &&
    CONFIGURATION_ERROR_CODES.includes(code as ModelConfigurationErrorCode)
  );
}

function invalidResponse(): ApiError {
  return new ApiError("invalid-response", INVALID_RESPONSE_MESSAGE);
}

export async function fetchModels(signal?: AbortSignal): Promise<ModelCatalog> {
  const payload = await apiRequest("/api/v1/models", { signal });
  const catalog = decodeModelCatalog(payload);
  if (!catalog) throw invalidResponse();
  return catalog;
}

export async function refreshModels(
  csrfToken: string,
  signal?: AbortSignal
): Promise<ModelCatalog> {
  const payload = await apiRequest("/api/v1/models/refresh", {
    method: "POST",
    csrfToken,
    signal
  });
  const catalog = decodeModelCatalog(payload);
  if (!catalog) throw invalidResponse();
  return catalog;
}

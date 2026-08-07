/**
 * Unsent composer draft persistence (Phase F-08; spec:
 * state-management.md §Persistence allow-list).
 *
 * Drafts are the only message-like content permitted in localStorage, and
 * only in unsent form:
 * - one JSON record keyed by conversation identity (`chat.composer-drafts`),
 *   where each key is the server conversation ID or the literal `new` for
 *   the empty-draft view;
 * - values are bounded (server `MAX_MESSAGE_CHARS` is 32_000) and the entry
 *   count is capped with oldest-first eviction, so storage stays small and
 *   a corrupted/hostile payload is discarded wholesale instead of parsed
 *   into the UI;
 * - an empty value removes the entry, which is how a successful send
 *   clears its draft;
 * - sent message bodies, tokens, and CSRF values are never written here.
 *
 * All functions are total: storage failures (private mode, quota) degrade
 * to session-only drafts.
 */

const DRAFTS_STORAGE_KEY = "chat.composer-drafts";

/** Matches the server `MAX_MESSAGE_CHARS` default (config.rs). */
export const MAX_DRAFT_LENGTH = 32_000;
export const MAX_DRAFT_ENTRIES = 20;
/** Hard ceiling for the serialized record; anything larger is corrupt. */
const MAX_RAW_LENGTH = 800_000;
/** Conversation IDs are server-generated identifiers; `new` is the draft view. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type DraftKey = string;

/** Returns a safe storage key, or null when the identity is unusable. */
export function draftKeyFor(conversationId: string | null): DraftKey | null {
  const key = conversationId ?? "new";
  return KEY_PATTERN.test(key) ? key : null;
}

type DraftMap = Record<string, string>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validates the raw record from storage. Every bound is enforced here so a
 * tampered or corrupted payload can never reach the composer.
 */
function decodeDrafts(raw: string | null): DraftMap {
  if (raw === null || raw.length === 0 || raw.length > MAX_RAW_LENGTH) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isPlainObject(parsed)) return {};
  const entries = Object.entries(parsed);
  if (entries.length > MAX_DRAFT_ENTRIES) return {};
  const drafts: DraftMap = {};
  for (const [key, value] of entries) {
    if (!KEY_PATTERN.test(key)) return {};
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_DRAFT_LENGTH
    ) {
      return {};
    }
    drafts[key] = value;
  }
  return drafts;
}

function readAll(): DraftMap {
  try {
    return decodeDrafts(window.localStorage.getItem(DRAFTS_STORAGE_KEY));
  } catch {
    return {};
  }
}

function writeAll(drafts: DraftMap): void {
  try {
    const keys = Object.keys(drafts);
    if (keys.length === 0) {
      window.localStorage.removeItem(DRAFTS_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // Best-effort persistence only.
  }
}

export function readDraft(key: DraftKey): string | null {
  const value = readAll()[key];
  return typeof value === "string" ? value : null;
}

/**
 * Stores the draft for a view. Empty/whitespace-only values and overlong
 * values are not persisted: empty removes the entry (post-send cleanup),
 * overlong stays session-only rather than truncating user text silently.
 * Insertion order is refreshed so eviction drops the stalest draft first.
 */
export function writeDraft(key: DraftKey, value: string): void {
  const drafts = readAll();
  delete drafts[key];
  const trimmedRelevant = value.length > 0;
  if (trimmedRelevant && value.length <= MAX_DRAFT_LENGTH) {
    drafts[key] = value;
    const keys = Object.keys(drafts);
    while (keys.length > MAX_DRAFT_ENTRIES) {
      const oldest = keys.shift();
      if (oldest === undefined) break;
      delete drafts[oldest];
    }
  }
  writeAll(drafts);
}

/** Explicit cleanup (e.g. after a successful send or conversation delete). */
export function clearDraft(key: DraftKey): void {
  const drafts = readAll();
  if (!(key in drafts)) return;
  delete drafts[key];
  writeAll(drafts);
}

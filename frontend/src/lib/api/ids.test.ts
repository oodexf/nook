import { describe, expect, it } from "vitest";

import { newClientMessageId } from "./ids";

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("newClientMessageId", () => {
  it("produces 26-character Crockford Base32 ULIDs", () => {
    for (let index = 0; index < 100; index += 1) {
      expect(newClientMessageId()).toMatch(ULID_PATTERN);
    }
  });

  it("satisfies the server client_message_id rules", () => {
    const id = newClientMessageId();
    expect(id.length).toBeGreaterThan(0);
    expect(id.length).toBeLessThanOrEqual(200);
    // No control characters (server-side rejection rule).
    // eslint-disable-next-line no-control-regex
    expect(id).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it("generates unique values", () => {
    const ids = new Set<string>();
    for (let index = 0; index < 1000; index += 1) {
      ids.add(newClientMessageId());
    }
    expect(ids.size).toBe(1000);
  });

  it("encodes the timestamp in the leading characters", () => {
    const before = newClientMessageId();
    const after = newClientMessageId();
    // Same-millisecond prefixes are equal or increasing; never decreasing
    // across a time boundary more than one millisecond apart.
    expect(after.slice(0, 8) >= before.slice(0, 8)).toBe(true);
  });
});

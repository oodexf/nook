import { describe, expect, it } from "vitest";

import { decodeHealthResponse } from "./health";

describe("decodeHealthResponse", () => {
  it("accepts the documented ready response", () => {
    expect(decodeHealthResponse({ status: "ready" })).toBe("ready");
  });

  it.each([
    null,
    "ready",
    {},
    { status: "ok" },
    { status: 200 }
  ])("rejects malformed response %#", (value) => {
    expect(decodeHealthResponse(value)).toBe("unavailable");
  });
});


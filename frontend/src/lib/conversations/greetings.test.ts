import { describe, expect, it } from "vitest";

import {
  GREETING_POOLS,
  greetingBucketFor,
  pickGreeting
} from "./greetings";

function at(hour: number): Date {
  return new Date(2026, 7, 10, hour, 0, 0);
}

describe("greetingBucketFor", () => {
  it("maps local hours onto the five time-of-day buckets", () => {
    expect(greetingBucketFor(at(0))).toBe("dawn");
    expect(greetingBucketFor(at(4))).toBe("dawn");
    expect(greetingBucketFor(at(5))).toBe("morning");
    expect(greetingBucketFor(at(10))).toBe("morning");
    expect(greetingBucketFor(at(11))).toBe("noon");
    expect(greetingBucketFor(at(13))).toBe("noon");
    expect(greetingBucketFor(at(14))).toBe("afternoon");
    expect(greetingBucketFor(at(17))).toBe("afternoon");
    expect(greetingBucketFor(at(18))).toBe("evening");
    expect(greetingBucketFor(at(23))).toBe("evening");
  });
});

describe("pickGreeting", () => {
  it("picks from the pool of the current bucket", () => {
    const greeting = pickGreeting(at(9), () => 0);
    expect(GREETING_POOLS.morning).toContain(greeting);
  });

  it("honours the random source within pool bounds", () => {
    const pool = GREETING_POOLS.evening;
    for (const [index] of pool.entries()) {
      const greeting = pickGreeting(at(20), () => index / pool.length + 0.001);
      expect(greeting).toBe(pool[index]);
    }
  });

  it("clamps an out-of-range random value to the last entry", () => {
    const pool = GREETING_POOLS.dawn;
    expect(pickGreeting(at(2), () => 0.9999)).toBe(pool[pool.length - 1]);
    expect(pickGreeting(at(2), () => 1)).toBe(pool[pool.length - 1]);
  });

  it("never contains emoji (Lucide-only iconography rule)", () => {
    const emojiPattern = /\p{Extended_Pictographic}/u;
    for (const pool of Object.values(GREETING_POOLS)) {
      for (const greeting of pool) {
        expect(emojiPattern.test(greeting)).toBe(false);
      }
    }
  });
});

/**
 * Time-of-day greeting pools for the empty draft conversation (08-10 new
 * chat UI upgrade). The fixed "开始一个新对话" heading is replaced by one
 * greeting picked at random from the pool matching the user's local time.
 * Greetings never contain emoji (project iconography rule: Lucide only).
 */

export type GreetingBucket = "dawn" | "morning" | "noon" | "afternoon" | "evening";

export const GREETING_POOLS: Record<GreetingBucket, readonly string[]> = {
  // 00:00–05:00 凌晨
  dawn: [
    "夜深了，早点休息。",
    "这么晚还在忙，有什么需要帮忙的吗？",
    "夜已深，有什么想法或问题，随时可以聊聊。"
  ],
  // 05:00–11:00 早上
  morning: [
    "早上好！有什么我可以帮你的吗？",
    "早上好！今天有什么想聊的，尽管告诉我。",
    "早安，又是新的一天，有什么需要随时说。"
  ],
  // 11:00–14:00 中午
  noon: [
    "忙碌了一上午，有什么我可以帮忙的吗？",
    "午安，有什么想法正好理一理？",
    "中午好！有什么想法或需要，我随时都在。"
  ],
  // 14:00–18:00 下午
  afternoon: [
    "下午好，继续推进点什么吧。",
    "下午好，有什么需要，随时告诉我",
    "下午好，说说接下来的计划。"
  ],
  // 18:00–24:00 晚上
  evening: [
    "晚上好，今晚想聊些什么？",
    "晚上好！今天辛苦了，有什么我能帮你的吗？",
    "晚上好，忙完了吗？有什么需要尽管说"
  ]
};

/** Local-time bucket boundaries, in hours: [startInclusive, endExclusive). */
const BUCKET_RANGES: readonly (readonly [GreetingBucket, number, number])[] = [
  ["dawn", 0, 5],
  ["morning", 5, 11],
  ["noon", 11, 14],
  ["afternoon", 14, 18],
  ["evening", 18, 24]
];

export function greetingBucketFor(date: Date): GreetingBucket {
  const hour = date.getHours();
  for (const [bucket, start, end] of BUCKET_RANGES) {
    if (hour >= start && hour < end) return bucket;
  }
  return "evening";
}

/**
 * Picks one greeting from the pool for the given moment. Both parameters
 * are injectable so tests stay deterministic; production callers use the
 * defaults and pick once per component mount (no reactive re-roll, so the
 * greeting never flickers within a mounted view).
 */
export function pickGreeting(
  date: Date = new Date(),
  random: () => number = Math.random
): string {
  const pool = GREETING_POOLS[greetingBucketFor(date)];
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return pool[index];
}

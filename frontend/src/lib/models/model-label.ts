/**
 * Human-facing display name for a provider model ID (08-15 header refresh).
 *
 * The server locks a raw provider ID on the conversation
 * (`anthropic/claude-sonnet-4-20250514`) and the catalog's `label` is that
 * same string, so any surface printing it reads as configuration rather
 * than as the name of the model the user is talking to. This derives a name
 * from the ID: the vendor prefix and a trailing release date come off, the
 * remaining segments become words, and the handful of tokens with a
 * conventional casing keep it.
 *
 * Presentation only — never an identifier. Callers must keep the exact ID
 * reachable (the chat header repeats it in the tooltip; the
 * model-unavailable banner prints it verbatim), because the ID is what the
 * server matches against the catalog.
 */

/** Tokens whose conventional casing is not "capitalize the first letter". */
const CASED_TOKENS = new Map([
  ["gpt", "GPT"],
  ["ai", "AI"],
  ["llm", "LLM"],
  ["tts", "TTS"],
  ["stt", "STT"],
  ["hd", "HD"],
  ["xl", "XL"],
  ["vl", "VL"],
  ["moe", "MoE"],
  ["o1", "o1"],
  ["o3", "o3"],
  ["o4", "o4"],
  // Size/variant qualifiers are written lowercase after the family name
  // ("GPT-4o mini"), unlike tier names such as Pro or Max.
  ["mini", "mini"],
  ["nano", "nano"],
  ["micro", "micro"],
  ["preview", "preview"],
  ["latest", "latest"]
]);

/** `-20250514`, `-2025-05-14`, `@2025.05.14`: a release stamp, not a name. */
const RELEASE_DATE_SUFFIX = /[-_@]20\d{2}[-._]?\d{2}[-._]?\d{2}$/;

function formatToken(token: string): string {
  const cased = CASED_TOKENS.get(token.toLowerCase());
  if (cased !== undefined) return cased;
  // Leading digits ("4o", "2.5") have no case to fix; anything else gets a
  // capital initial while the rest of the token is left as the provider
  // wrote it, so intentional casing ("DeepSeek") survives.
  const first = token[0] ?? "";
  if (!/[a-z]/i.test(first)) return token;
  return first.toUpperCase() + token.slice(1);
}

/**
 * Returns the display name, or the trimmed input when nothing survives the
 * transformation (an ID made only of separators, say) — a surface must
 * never end up showing an empty model.
 */
export function formatModelLabel(modelId: string): string {
  const trimmed = modelId.trim();
  if (trimmed === "") return "";
  const withoutVendor = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  const withoutDate = withoutVendor.replace(RELEASE_DATE_SUFFIX, "");
  const words = withoutDate
    .split(/[-_\s]+/)
    .filter((token) => token !== "")
    .map(formatToken);
  return words.length === 0 ? trimmed : words.join(" ");
}

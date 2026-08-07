/**
 * Client-generated identifier boundary.
 *
 * The backend generates ULIDs for every server-side ID and accepts any
 * bounded, control-character-free string as `client_message_id`
 * (`crates/server/src/chat.rs::valid_client_message_id`). To keep one
 * project-compatible identifier shape, the frontend generates the same
 * 26-character Crockford Base32 ULID form for idempotency keys:
 * 48 bits of Unix-millisecond time followed by 80 bits of randomness.
 *
 * Uniqueness across transport retries is what matters; monotonic ordering
 * within one millisecond is intentionally not implemented (the backend does
 * not rely on client ID ordering).
 */

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_LENGTH = 26;
const TIME_CHARS = 10;
const RANDOM_CHARS = ULID_LENGTH - TIME_CHARS;

function encodeCrockford(value: number, length: number): string {
  let remaining = value;
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output = CROCKFORD_ALPHABET[remaining % 32] + output;
    remaining = Math.floor(remaining / 32);
  }
  return output;
}

function randomCrockford(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let output = "";
  for (const byte of bytes) {
    output += CROCKFORD_ALPHABET[byte % 32];
  }
  return output;
}

/**
 * Returns a fresh ULID-shaped idempotency key for one user message. A new
 * value must be generated per logical message; retries of the same logical
 * message reuse the same value (generation store owns that lifecycle).
 */
export function newClientMessageId(): string {
  const time = Date.now();
  // 48 bits of millisecond time cannot be encoded by Number division alone;
  // split into high/low chunks that stay below 2^53.
  const high = Math.floor(time / 2 ** 24);
  const low = time % 2 ** 24;
  return (
    encodeCrockford(high, TIME_CHARS - 5) +
    encodeCrockford(low, 5) +
    randomCrockford(RANDOM_CHARS)
  );
}

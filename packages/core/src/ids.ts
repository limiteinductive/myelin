// UUIDv7 ids. Learner events get their id on the client, so a retried send never duplicates.

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function format(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += HEX[bytes[i]!];
    if (i === 3 || i === 5 || i === 7 || i === 9) s += "-";
  }
  return s;
}

function stamp(bytes: Uint8Array, ms: number): Uint8Array {
  if (!Number.isInteger(ms) || ms < 0 || ms > 0xffffffffffff) throw new RangeError(`bad uuidv7 timestamp: ${ms}`);
  let t = ms;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256;
    t = Math.floor(t / 256);
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f); // version 7
  bytes[8] = 0x80 | (bytes[8]! & 0x3f); // RFC 9562 variant
  return bytes;
}

/** A random UUIDv7 for time `ms` (defaults to now). */
export function uuidv7(ms: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return format(stamp(bytes, ms));
}

/**
 * A UUIDv7 whose random bits are a hash of `seed`. The same (ms, seed) always gives the same id,
 * which makes imports idempotent. Not for anything security-related.
 */
export function deterministicUuidv7(ms: number, seed: string): string {
  const h = hash128(seed);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 4; i++) {
    const w = h[i]!;
    bytes[i * 4] = w >>> 24;
    bytes[i * 4 + 1] = (w >>> 16) & 0xff;
    bytes[i * 4 + 2] = (w >>> 8) & 0xff;
    bytes[i * 4 + 3] = w & 0xff;
  }
  return format(stamp(bytes, ms));
}

/** Milliseconds encoded in a UUIDv7. */
export function uuidv7Time(id: string): number {
  return parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}

// cyrb128: a small, well-mixed 128-bit string hash.
function hash128(str: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

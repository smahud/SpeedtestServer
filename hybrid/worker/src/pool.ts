/**
 * pool.ts — the printable-ASCII random pool (daemon parity F-9).
 *
 * The reference daemon generates a 2 MiB pool of printable ASCII
 * [0x20..0x7F] (96 values, including DEL 0x7F) at startup and serves every
 * DOWNLOAD reply / random{N}x{N}.jpg body from it.
 *
 * G-6 (Workers Free, 10 ms CPU): the pool is materialized LAZILY in 64 KiB
 * increments — an isolate only generates the span of pool bytes a request
 * actually reads (a 256 KiB download builds 256 KiB of pool, not 2 MiB).
 * The mapping uses a 256-entry lookup table (one indexed load per byte)
 * instead of a per-byte modulo, and fills views of the pool directly with
 * crypto.getRandomValues (no intermediate allocations). Fully materialized
 * cost: 32 × getRandomValues(64 KiB) + 2 MiB table lookups, paid once per
 * isolate; memory stays 2 MiB of the 128 MB isolate budget.
 */

const POOL_SIZE = 2 * 1024 * 1024;
const CHUNK = 65536; // crypto.getRandomValues per-call limit

// 256-entry map: random byte → printable ASCII [0x20..0x7F] (96 values,
// including DEL 0x7F — daemon parity; identical output to 0x20 + (b % 96)).
const MAP = new Uint8Array(256);
for (let i = 0; i < 256; i++) MAP[i] = 0x20 + (i % 96);

let pool: Uint8Array | null = null;
let filled = 0; // bytes of the pool already generated ([0, filled) is valid)

/** Ensure pool bytes [0, end) exist (lazy 64 KiB increments). */
function ensureSpan(end: number): Uint8Array {
  if (!pool) pool = new Uint8Array(POOL_SIZE);
  while (filled < end) {
    const len = Math.min(CHUNK, end - filled);
    const view = pool.subarray(filled, filled + len);
    crypto.getRandomValues(view);
    for (let i = 0; i < len; i++) view[i] = MAP[view[i]];
    filled += len;
  }
  return pool;
}

export function getPool(): Uint8Array {
  return ensureSpan(POOL_SIZE);
}

/** Fill `out` with pool bytes starting at logical stream offset `streamOff`.
 * The pool wraps every POOL_SIZE bytes exactly like the daemon's cyclic
 * pool; the read span of this call is generated on demand. */
export function fillFromPool(out: Uint8Array, streamOff: number): void {
  const plen = POOL_SIZE;
  const pos = streamOff % plen;
  // This call reads [pos, pos + out.length) (wrapped). Everything past the
  // first wrap re-reads [0, …) which is already valid, so the maximal span
  // that must exist is min(POOL_SIZE, pos + out.length).
  const p = ensureSpan(Math.min(plen, pos + out.length));
  let cur = pos;
  for (let i = 0; i < out.length; ) {
    const take = Math.min(plen - cur, out.length - i);
    out.set(p.subarray(cur, cur + take), i);
    cur = (cur + take) % plen;
    i += take;
  }
}

/** Test hook: reset the lazily-filled pool. */
export function resetPoolForTests(): void {
  pool = null;
  filled = 0;
}

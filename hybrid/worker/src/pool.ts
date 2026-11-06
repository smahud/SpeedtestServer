/**
 * pool.ts — the printable-ASCII random pool (daemon parity F-9).
 *
 * The reference daemon generates a 2 MiB pool of printable ASCII
 * [0x20..0x7F] (96 values, including DEL 0x7F) at startup and serves every
 * DOWNLOAD reply / random{N}x{N}.jpg body from it. The Worker generates the
 * same pool lazily per isolate (32 × crypto.getRandomValues(64 KiB)) and
 * reuses it for the isolate's lifetime — CPU-cheap, memory-bounded (2 MiB of
 * the 128 MB isolate budget), never transmitted through the VPS.
 */

const POOL_SIZE = 2 * 1024 * 1024;
const CHUNK = 65536; // crypto.getRandomValues per-call limit

let pool: Uint8Array | null = null;

export function getPool(): Uint8Array {
  if (pool) return pool;
  const p = new Uint8Array(POOL_SIZE);
  for (let off = 0; off < POOL_SIZE; off += CHUNK) {
    const len = Math.min(CHUNK, POOL_SIZE - off);
    const slice = new Uint8Array(len);
    crypto.getRandomValues(slice);
    // Printable ASCII pool: map each random byte into [0x20..0x7F].
    for (let i = 0; i < len; i++) slice[i] = 0x20 + (slice[i] % 96);
    p.set(slice, off);
  }
  pool = p;
  return p;
}

/** Fill `out` with pool bytes starting at logical stream offset `streamOff`. */
export function fillFromPool(out: Uint8Array, streamOff: number): void {
  const p = getPool();
  const plen = p.length;
  let pos = streamOff % plen;
  for (let i = 0; i < out.length; ) {
    const take = Math.min(plen - pos, out.length - i);
    out.set(p.subarray(pos, pos + take), i);
    pos = (pos + take) % plen;
    i += take;
  }
}

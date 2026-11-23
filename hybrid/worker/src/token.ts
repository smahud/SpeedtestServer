/**
 * token.ts — stateless HMAC session tokens binding a speedtest session to
 * the VPS control plane.
 *
 * The VPS gateway mints `v1~<guid>~<expMs>~<ip>~<sig>` where
 * sig = HMAC-SHA256(secret, `v1|guid|expMs|ip`). The Worker (and any other
 * component holding the shared secret) verifies locally — zero subrequests,
 * zero coordination round-trips, works in every PoP simultaneously.
 *
 * An empty secret disables enforcement (open lab mode).
 */

const encoder = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return bufToHex(new Uint8Array(sig));
}

function bufToHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export interface TokenClaims {
  guid: string;
  expMs: number;
  ip: string;
}

/** Mint a token (used by the VPS gateway; also exported for lab tooling). */
export async function mintToken(secret: string, claims: TokenClaims): Promise<string> {
  const sig = await hmac(secret, `v1|${claims.guid}|${claims.expMs}|${claims.ip}`);
  return `v1~${claims.guid}~${claims.expMs}~${claims.ip}~${sig}`;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  claims?: TokenClaims;
}

/** Verify a token string against the shared secret + request context. */
export async function verifyToken(
  secret: string,
  token: string | null,
  ctx: { ip: string; nowMs?: number },
): Promise<VerifyResult> {
  if (!secret) return { ok: true, reason: 'open-mode' }; // lab mode: no enforcement
  if (!token) return { ok: false, reason: 'missing-token' };
  const parts = token.split('~');
  if (parts.length !== 5 || parts[0] !== 'v1') return { ok: false, reason: 'malformed' };
  const [v, guid, expStr, ip, sig] = parts;
  const expMs = Number(expStr);
  if (!Number.isFinite(expMs)) return { ok: false, reason: 'bad-exp' };
  const expect = await hmac(secret, `${v}|${guid}|${expStr}|${ip}`);
  // Constant-time-ish compare (hex strings of equal length).
  if (expect.length !== sig.length) return { ok: false, reason: 'bad-signature' };
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return { ok: false, reason: 'bad-signature' };
  if ((ctx.nowMs ?? Date.now()) > expMs) return { ok: false, reason: 'expired' };
  if (ctx.ip && ip !== '*' && ip !== ctx.ip) return { ok: false, reason: 'ip-mismatch' };
  return { ok: true, claims: { guid, expMs, ip } };
}

/** Extract a token from query param `token` or header `X-Hybrid-Token`. */
export function extractToken(request: Request, url: URL): string | null {
  return url.searchParams.get('token') || request.headers.get('x-hybrid-token');
}

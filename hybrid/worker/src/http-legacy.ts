/**
 * http-legacy.ts — daemon-parity HTTP surface on the Workers runtime.
 *
 * Mirrors reverse-engineered/typescript/src/server/HttpApi.ts (byte-verified
 * against the reference daemon — PROTOCOL_CONTRACT.md §4) with documented
 * platform deviations where the Workers runtime forbids exact byte parity:
 *
 *   D-W2  The status line always speaks HTTP/1.1+ (the runtime owns the
 *         protocol; the daemon echoes the request's HTTP/1.0).
 *   D-W5  Connection framing (Content-Length on empty bodies, chunked
 *         framing, header ordering, Date format) is runtime-controlled;
 *         the semantic set (status, body bytes, security headers) matches.
 *   D-W6  upload.php answers every POST with size=N. The daemon never
 *         answers chunked bodies (holds until timeout); the Worker cannot
 *         observe the framing distinction — answering is the safe behavior.
 *
 * Purpose: functional compatibility for real HTTP speedtest clients (HTML5
 * host pages, legacy Flash-era paths) at the edge, NOT daemon differential
 * byte parity — SpeedtestServer on the VPS remains the parity reference.
 */

import { fillFromPool } from './pool';
import { Env, domainList, num, bool } from './config';

/** Deterministic legacy file sizes (fingerprint captured from the reference
 * daemon; identical across lab, third-party and Ookla production hosts). */
export const IMAGE_SIZES: Record<number, number> = {
  250: 129145,
  350: 245388,
  500: 505544,
  750: 1118012,
  1000: 1986284,
  1500: 4468241,
  2000: 7907740,
  2500: 12407926,
  3000: 17816816,
  3500: 24262167,
  4000: 31625365,
  5000: 49454450,
  6000: 71154024,
  7000: 96912152,
};

const IMAGE_RE = /random([0-9]+)x([0-9]+)\.jpg$/;
const CSP_DEFAULT_DOMAINS = ['*.ookla.com', '*.speedtest.net', '*.speedtestcustom.com'];
const JWT_SHAPE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

export function effectiveDomains(env: Env): string[] {
  const configured = domainList(env);
  if (configured.includes('*')) return ['*'];
  const out = [...configured];
  if (!bool(env.EXCLUDE_DEFAULT_DOMAINS)) {
    for (const d of CSP_DEFAULT_DOMAINS) if (!out.includes(d)) out.push(d);
  }
  return out;
}

/** CORS Origin filter (verified F-23): reflect only matching origins;
 * "null" is never reflected (F-37). */
export function originAllowed(origin: string, env: Env): boolean {
  if (origin === 'null') return false;
  const domains = effectiveDomains(env);
  if (domains.includes('*')) return true;
  const m = origin.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/);
  if (!m) return false;
  let host = m[1].toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  else {
    const colon = host.lastIndexOf(':');
    if (colon !== -1 && host.indexOf(':') === colon) host = host.slice(0, colon);
  }
  for (const d of domains) {
    const pat = d.toLowerCase();
    if (pat === '*') return true;
    if (pat.startsWith('*.')) {
      if (host.endsWith('.' + pat.slice(2))) return true;
    } else if (host === pat) return true;
  }
  return false;
}

function securityHeaders(env: Env): [string, string][] {
  const connectSrc = effectiveDomains(env).join(' ');
  return [
    ['Cache-Control', 'no-store'],
    ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', 'DENY'],
    ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
    [
      'Content-Security-Policy',
      `default-src 'none'; frame-ancestors 'none'; script-src 'none'; object-src 'none';  connect-src ${connectSrc}; upgrade-insecure-requests`,
    ],
  ];
}

/** Daemon path normalization (verified): collapse //, resolve ./.. — but
 * keep a trailing slash distinct. */
export function normalizePath(pathname: string): string {
  if (!pathname.startsWith('/')) return pathname;
  const parts = pathname.split('/');
  const keepTrailing = parts.length > 1 && parts[parts.length - 1] === '';
  const segments: string[] = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(seg);
  }
  return '/' + segments.join('/') + (keepTrailing && segments.length > 0 ? '/' : '');
}

/** Split scheme://authority from absolute-form targets, strip query/fragment. */
export function requestTargetPath(url: string): { target: string; path: string } {
  let target = url || '/';
  const m = target.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]+(.*)$/);
  if (m) target = m[1] || '/';
  let path = target;
  const q = path.indexOf('?');
  if (q !== -1) path = path.slice(0, q);
  const f = path.indexOf('#');
  if (f !== -1) path = path.slice(0, f);
  return { target, path: normalizePath(path) };
}

function hostMatches(host: string, allowed: string[]): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const colon = h.lastIndexOf(':');
  if (colon !== -1 && h.indexOf(':') === colon) h = h.slice(0, colon);
  return allowed.some((a) => a.toLowerCase() === h);
}

/** Build a daemon-shaped Response. */
function respond(
  status: number,
  body: Uint8Array | string,
  headers: [string, string][],
  opts: { noBody?: boolean; headLength?: number } = {},
): Response {
  const h = new Headers();
  for (const [k, v] of headers) h.set(k, v);
  // Daemon header set (contract §4.4): Connection: Keep-Alive on normal
  // responses (capital K-A, daemon casing). Hop-by-hop in Fetch terms —
  // the runtime may drop it; D-W9 documents the outcome.
  try {
    h.set('Connection', 'Keep-Alive');
  } catch {
    /* forbidden header — documented deviation */
  }
  const bodyBytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const length = opts.headLength !== undefined ? opts.headLength : bodyBytes.length;
  if (length > 0 || status === 200) h.set('Content-Length', String(length));
  return new Response(opts.noBody ? null : bodyBytes, { status, headers: h });
}

function minimal500(reason = 'Internal Server Error'): Response {
  // Daemon minimal 500: status + Connection: Close only (D-W5 documents the
  // runtime-added framing bytes).
  return new Response(null, {
    status: 500,
    headers: { Connection: 'Close' },
  });
}

/** Stream `size` bytes of pool data with a fixed Content-Length. */
export function poolResponse(size: number, headers: [string, string][]): Response {
  const h = new Headers();
  for (const [k, v] of headers) h.set(k, v);
  h.set('Content-Length', String(size));
  const stream = new ReadableStream({
    start(controller) {
      const CHUNK = 256 * 1024;
      let off = 0;
      const push = (): void => {
        while (off < size) {
          const len = Math.min(CHUNK, size - off);
          const out = new Uint8Array(len);
          fillFromPool(out, off);
          off += len;
          controller.enqueue(out);
          if (off % (CHUNK * 8) === 0) {
            setTimeout(push, 0); // yield periodically
            return;
          }
        }
        controller.close();
      };
      push();
    },
  });
  return new Response(stream, { status: 200, headers: h });
}

/** Handle the daemon-parity HTTP surface. Returns null when the path is not
 * part of the legacy surface (falls through to hybrid endpoints). */
export async function handleLegacyHttp(request: Request, url: URL, env: Env): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const { target, path } = requestTargetPath(url.pathname + url.search + url.hash);

  // ---- Request-validation chain (order verified against the daemon) ----

  // 1. Host header must be present (missing → minimal 500).
  const host = request.headers.get('host');
  if (host === null) return minimal500();

  // 2. Host must match the SAN-equivalent list when strict validation is on.
  //    Default OFF at the edge (D-W7): Cloudflare routes by SNI/Host before
  //    the Worker runs, so the daemon's redirect cannot occur in production;
  //    the check remains available for conformance testing.
  if (bool(env.STRICT_HOST_VALIDATION)) {
    const allowedHosts = (env.ALLOWED_HOSTS || 'localhost,127.0.0.1').split(',').map((s) => s.trim()).filter(Boolean);
    if (!hostMatches(host, allowedHosts)) {
      const certHost = env.CERT_CN || allowedHosts[0] || 'localhost';
      const h = new Headers({
        Date: new Date().toUTCString(),
        Connection: 'Close',
        'Content-Length': '0',
        Location: `https://${certHost}:443${target}`,
      });
      return new Response(null, { status: 307, headers: h });
    }
  }

  // 3. User-Agent header must be present (empty value counts as present).
  if (!request.headers.has('user-agent')) return minimal500();

  // 4. "Authorization: Bearer <x>" with a non-JWT-shaped token → minimal 500.
  const authorization = request.headers.get('authorization');
  if (authorization && authorization.startsWith('Bearer ')) {
    const token = authorization.slice(7).trim();
    if (!JWT_SHAPE_RE.test(token)) return minimal500();
  }

  const origin = request.headers.get('origin');
  const common = (): [string, string][] => {
    const headers = securityHeaders(env);
    if (origin && originAllowed(origin, env)) {
      headers.push(['Access-Control-Allow-Origin', origin] as [string, string], ['Vary', 'Origin'] as [string, string]);
    }
    return headers;
  };
  const notFound = (): Response => {
    const h = new Headers({ Connection: 'Close' });
    for (const [k, v] of common()) h.set(k, v);
    return new Response(null, { status: 404, headers: h });
  };
  const isRead = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  const noBody = method !== 'GET';

  // 5. GET /ws without an upgrade request: daemon drops silently. The
  //    Worker cannot hold sockets open (D-W4) — answer with the minimal 500.
  if (path === '/ws' && (request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
    return minimal500();
  }

  const m = path.match(IMAGE_RE);
  if (m) {
    const n = parseInt(m[1], 10);
    if (IMAGE_SIZES[n] && m[1] === m[2] && isRead) {
      const size = IMAGE_SIZES[n];
      const headers: [string, string][] = [...common(), ['Content-Type', 'image/jpeg'] as [string, string]];
      if (method === 'GET') {
        if (size <= 1024 * 1024) {
          // Fixed body → the runtime preserves the exact Content-Length
          // (daemon parity). Covers the 250/350/500/750 sizes.
          const body = new Uint8Array(size);
          fillFromPool(body, 0);
          return respond(200, body, headers);
        }
        // Larger sizes stream from the pool (chunked framing, D-W8) — byte
        // totals stay exact; only the framing differs from the daemon.
        return poolResponse(size, headers);
      }
      return respond(200, new Uint8Array(0), headers, { noBody, headLength: method === 'HEAD' ? size : 0 });
    }
    return notFound();
  }
  if (path === '/') {
    if (isRead) {
      const body = '<html><head><title>OoklaServer</title></head><body><h1>OoklaServer</h1><p>It worked!<br /></p></body></html>\n';
      return respond(200, body, [...common(), ['Content-Type', 'text/html'] as [string, string]], { noBody });
    }
    return notFound();
  }
  if (path === '/hi') {
    if (isRead) {
      const version = env.VERSION_STRING || '2.11 (2.11.5) 2026-06-04.1737.7d0993d';
      return respond(200, `hello ${version}\n`, [...common(), ['Content-Type', 'text/plain; charset=UTF-8'] as [string, string]], { noBody });
    }
    return notFound();
  }
  if (path === '/speedtest/latency.txt' || path === '/latency.txt') {
    if (isRead) {
      return respond(200, 'test=test\n', [...common(), ['Content-Type', 'text/plain; charset=UTF-8'] as [string, string]], { noBody });
    }
    return notFound();
  }
  if (path === '/crossdomain.xml') {
    if (isRead) {
      const domains = effectiveDomains(env);
      const entries = domains.map((d) => `<allow-access-from domain="${d}" to-ports="443"/>\n`).join('');
      const body = `<?xml version="1.0"?>\n<cross-domain-policy>\n${entries}</cross-domain-policy>\n`;
      return respond(200, body, [...common(), ['Content-Type', 'text/xml'] as [string, string]], { noBody });
    }
    return notFound();
  }
  if (path === '/speedtest/upload.php' || path === '/upload.php') {
    if (method !== 'POST') return notFound();
    // D-W6: the Worker cannot distinguish chunked framing; always drain+count.
    // Streaming count — never buffers the body (128 MB isolate budget).
    const maxBody = num(env.MAX_UPLOAD_BYTES, 0x7fffffff);
    const received = await countBody(request.body);
    if (received > maxBody) return new Response(null, { status: 413, headers: { Connection: 'Close' } });
    return respond(200, `size=${received}\n`, [...common(), ['Content-Type', 'text/plain; charset=UTF-8'] as [string, string]]);
  }
  return null; // not a legacy path
}

/** Drain a request body, counting bytes without buffering (edge-terminated
 * upload streams — the payload never transits the VPS). */
export async function countBody(body: ReadableStream<Uint8Array> | null): Promise<number> {
  let received = 0;
  if (!body) return 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
  }
  return received;
}

/**
 * ookla-xhr.ts — Ookla WEB-CLIENT XHR surface, served AT THE EDGE.
 *
 * DIRECT-LANE ARCHITECTURE (operator contract, 27 Nov 2026 — "relay/bridge
 * = salah total; worker membantu load berat LANGSUNG ke client"):
 *
 *   The official speedtest.net web client (unmodified Ookla JS SDK) does its
 *   measurement over TWO transports on the server host:
 *     - WSS  /ws        → control plane  (HI/GETIP/CAPABILITIES/PING +
 *                         loaded-latency) — served by the VPS.
 *     - XHR  /download  → heavy payload  → the VPS answers **307** and the
 *              /upload                   browser follows it HERE, so the
 *                         payload bytes flow CLIENT ↔ CLOUDFLARE EDGE only.
 *   The VPS NIC never carries a payload byte on this lane (that is the
 *   point: relay was banned by the operator — it wasted the Worker while
 *   the traffic stayed capped at the VPS link).
 *
 * Endpoint semantics are byte-verified daemon parity from the production
 * probes (docs/WEB_CLIENT_REVERSE_ENGINEERING_2026-11-26.md §4/§5 and
 * docs/HTTPS_WEB_CLIENT_SUPPORT_2026-11-27.md — ground truth: XLSMART
 * 2.11.5 + Tuxsindo 2.11.7 production servers):
 *
 *   GET  /download?size=N   → 200 application/octet-stream, Content-Length
 *                              EXACTLY N, no-store, CORS (Origin reflected)
 *   POST /upload            → drains the body, answers `size=<N>\n`
 *                              text/plain; charset=UTF-8 + CORS
 *   GET  /hello?guid=&nocache= → `hello <version>\n` (lowercase, XHR form)
 *   GET  /getip             → `<client-ip>\n` (cf-connecting-ip at the edge)
 *   GET  /capabilities      → `capabilities SERVER_HOST_AUTH UPLOAD_STATS\n`
 *   GET  /ping?nocache=     → `pong\n` (lowercase, no timestamp — quirk)
 *   OPTIONS (any of these)  → 200 CL 0 + CORS allow (preflight support)
 *
 * Auth: same policy as /__down & /__up — token-gated when
 * HYBRID_SHARED_SECRET is set (the VPS mints the token into the 307
 * Location); open in lab/test deployments with no secret.
 *
 * Attribution: every transfer logs a JSONL event (guid preserved from the
 * 307 query) so `wrangler tail` / observability gives per-session byte
 * accounting for the 3-sided evidence the project contract requires.
 */

import { Env, DEFAULTS, num } from './config';
import { countBody, originAllowed, poolResponse } from './http-legacy';

const OOKLA_PATHS = new Set(['/download', '/upload', '/hello', '/getip', '/capabilities', '/ping']);

export function isOoklaXhrPath(path: string): boolean {
  return OOKLA_PATHS.has(path);
}

/** CORS headers for the Ookla XHR surface.
 *
 *  CRITICAL redirect semantics (verified live, 27 Nov 2026): when the VPS
 *  answers the SDK's XHR with 307 → this worker, the browser follows the
 *  redirect but serializes the Origin header to `null` (fetch-spec rule for
 *  cross-origin redirects). `Origin: null` must therefore be reflected as
 *  `Access-Control-Allow-Origin: null` — a valid ACAO value for opaque
 *  origins — or the redirected measurement request is blocked by CORS
 *  (observed: "TypeError: Failed to fetch"; direct fetches carry the real
 *  Origin and reflect normally). */
function cors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  const expose = { 'Access-Control-Expose-Headers': 'Content-Length, X-Hybrid-Lane, X-Hybrid-Server' };
  if (origin === 'null') return { 'Access-Control-Allow-Origin': 'null', ...expose };
  if (!originAllowed(origin, env)) return {};
  return { 'Access-Control-Allow-Origin': origin, ...expose };
}

type LogFn = (kind: string, detail: Record<string, unknown>) => void;

export async function handleOoklaXhr(
  request: Request,
  url: URL,
  env: Env,
  log: LogFn,
  onDone?: () => void,
): Promise<Response> {
  const method = (request.method || 'GET').toUpperCase();
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const guid = url.searchParams.get('guid') || '';
  const versionString = env.VERSION_STRING || DEFAULTS.versionString;

  // Preflight (browsers re-preflight after a cross-origin redirect on
  // non-simple requests — the POST /upload octet-stream flow may hit this).
  if (method === 'OPTIONS') {
    const h: Record<string, string> = {
      ...cors(request, env),
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
      'Cache-Control': 'no-store, no-transform',
    };
    const reqHeaders = request.headers.get('access-control-request-headers');
    if (reqHeaders) h['Access-Control-Allow-Headers'] = reqHeaders;
    return new Response(null, { status: 200, headers: h });
  }

  switch (path) {
    // ---- heavy payload: download ------------------------------------
    case '/download': {
      if (method !== 'GET' && method !== 'HEAD') {
        return new Response(null, { status: 404, headers: { Connection: 'Close', 'Cache-Control': 'no-store' } });
      }
      const max = num(env.MAX_DOWNLOAD_BYTES, DEFAULTS.maxDownloadBytes);
      const raw = url.searchParams.get('size');
      const n = raw === null ? 0 : Number(raw);
      const size = Number.isInteger(n) && n >= 0 ? Math.min(n, max) : 0;
      if (raw !== null && n > max) log('xhr_dl_capped', { requested: n, served: size, guid });
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'Content-Length': String(size), 'Cache-Control': 'no-store', ...cors(request, env) },
        });
      }
      log('xhr_dl', { size, guid, lane: 'edge' });
      const headers: [string, string][] = [
        ['Content-Type', 'application/octet-stream'],
        ['Cache-Control', 'no-store, no-transform'],
        ['X-Content-Type-Options', 'nosniff'],
        ['X-Hybrid-Lane', 'edge'],
        ...Object.entries(cors(request, env)),
      ];
      if (size === 0) return new Response(null, { status: 200, headers });
      return poolResponse(size, headers, request.signal, onDone);
    }

    // ---- heavy payload: upload (drain at the edge) -------------------
    case '/upload': {
      if (method !== 'POST') {
        return new Response(null, { status: 404, headers: { Connection: 'Close', 'Cache-Control': 'no-store' } });
      }
      const max = num(env.MAX_UPLOAD_BYTES, DEFAULTS.maxUploadBytes);
      const declared = Number(request.headers.get('content-length') || '');
      if (Number.isFinite(declared) && declared > max) {
        try { await request.body?.cancel(); } catch { /* already closed */ }
        log('xhr_ul_rejected', { declared, max, guid });
        return new Response('size=0\n', {
          status: 413,
          headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'Cache-Control': 'no-store', ...cors(request, env) },
        });
      }
      const received = await countBody(request.body, max);
      if (received < 0) {
        log('xhr_ul_rejected', { declared, max, guid });
        return new Response('size=0\n', {
          status: 413,
          headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'Cache-Control': 'no-store', ...cors(request, env) },
        });
      }
      log('xhr_ul', { bytes: received, guid, lane: 'edge' });
      const body = `size=${received}\n`;
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=UTF-8',
          'Content-Length': String(body.length),
          'Cache-Control': 'no-store, no-transform',
          'X-Hybrid-Lane': 'edge',
          ...cors(request, env),
        },
      });
    }

    // ---- light control (parity surface; normally served by the VPS,
    //      present here so the edge can stand alone when useful) -------
    case '/hello': {
      const body = `hello ${versionString}\n`;
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=UTF-8',
          'Content-Length': String(body.length),
          'Cache-Control': 'no-store',
          ...cors(request, env),
        },
      });
    }
    case '/getip': {
      const ip = request.headers.get('cf-connecting-ip') || '127.0.0.1';
      const body = `${ip}\n`;
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=UTF-8',
          'Content-Length': String(body.length),
          'Cache-Control': 'no-store',
          ...cors(request, env),
        },
      });
    }
    case '/capabilities': {
      const body = 'capabilities SERVER_HOST_AUTH UPLOAD_STATS\n';
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=UTF-8',
          'Content-Length': String(body.length),
          'Cache-Control': 'no-store',
          ...cors(request, env),
        },
      });
    }
    case '/ping': {
      const body = 'pong\n';
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=UTF-8',
          'Content-Length': String(body.length),
          'Cache-Control': 'no-store',
          ...cors(request, env),
        },
      });
    }
    default:
      return new Response(null, { status: 404, headers: { Connection: 'Close', 'Cache-Control': 'no-store' } });
  }
}

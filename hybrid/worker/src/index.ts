/**
 * index.ts — hybrid speedtest Worker: NetGauge-over-WebSocket + HTTP legacy
 * surface + hybrid __down/__up endpoints, at the Cloudflare edge.
 *
 * HYBRID ARCHITECTURE (see hybrid/README.md):
 *
 *   ┌────────┐  control plane (tiny): discovery, session tokens, results
 *   │   VPS  │  data plane that REQUIRES native sockets: NetGauge TCP/TLS
 *   │ (STS)  │  for the official CLI + UDP packet-loss/jitter
 *   └───┬────┘
 *       │  shared HMAC secret (no runtime coupling)
 *   ┌───▼─────────────┐  payload data plane: WSS NetGauge (web clients),
 *   │ Cloudflare Worker│  HTTP __down/__up (custom engines), legacy HTTP
 *   │ (this code)      │  surface — generated/drained AT THE EDGE
 *   └─────────────────┘
 *
 * The VPS never sees a payload byte for sessions served here.
 */

import { Env, DEFAULTS, num, bool } from './config';
import { NetGaugeEngine, firstCommandLine } from './netgauge';
import { handleLegacyHttp, poolResponse, countBody } from './http-legacy';
import { verifyToken, extractToken } from './token';
import { fillFromPool } from './pool';

// Per-isolate identity (daemon parity: one instance UUID / uptime per
// process). Lazily initialized — the runtime forbids random generation and
// timers at global scope.
let isolateStartedAt = 0;
let instanceUuid: string | null = null;
const ISOLATE_COUNTERS = { sessions: 0, wsSessions: 0, httpDown: 0, httpUp: 0, upRejected: 0 };

function startedAt(): number {
  if (!isolateStartedAt) isolateStartedAt = Date.now();
  return isolateStartedAt;
}

function getInstanceUuid(): string {
  if (!instanceUuid) instanceUuid = crypto.randomUUID();
  return instanceUuid;
}

function logEvent(kind: string, detail: Record<string, unknown>): void {
  // JSONL to stdout — visible via `wrangler tail` / `wrangler dev` console.
  console.log(JSON.stringify({ ts: Date.now(), kind, ...detail }));
}

function peerIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') || '127.0.0.1';
}

// ---------------------------------------------------------------------------
// Hybrid throughput endpoints (speed.cloudflare.com-style)
// ---------------------------------------------------------------------------

function downResponse(bytes: number, env: Env, signal?: AbortSignal): Response {
  const headers: [string, string][] = [
    ['Cache-Control', 'no-store, no-transform'],
    ['X-Content-Type-Options', 'nosniff'],
    ['Content-Type', 'application/octet-stream'],
    ['X-Hybrid-Server', 'speedtest-hybrid-worker/1.1'],
  ];
  if (bytes === 0) return new Response(null, { status: 200, headers }); // TTFB ping
  // G-5: client cancel (disconnect) aborts generation via request.signal
  // when the runtime provides it.
  return poolResponse(bytes, headers, signal);
}

async function handleDown(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }
  const raw = url.searchParams.get('bytes');
  if (raw === null) return new Response(JSON.stringify({ error: 'missing bytes parameter' }), { status: 400 });
  const bytes = Number(raw);
  const max = num(env.MAX_DOWNLOAD_BYTES, DEFAULTS.maxDownloadBytes);
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > max) {
    return new Response(JSON.stringify({ error: `bytes must be an integer in [0, ${max}]` }), { status: 400 });
  }
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: { 'Content-Length': String(bytes), 'Cache-Control': 'no-store' } });
  }
  ISOLATE_COUNTERS.httpDown++;
  return downResponse(bytes, env, request.signal);
}

async function handleUp(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }
  const max = num(env.MAX_UPLOAD_BYTES, DEFAULTS.maxUploadBytes);
  // G-4: reject oversized uploads EARLY on Content-Length (no body read).
  const declared = Number(request.headers.get('content-length') || '');
  if (Number.isFinite(declared) && declared > max) {
    ISOLATE_COUNTERS.upRejected++;
    return new Response(JSON.stringify({ error: 'upload too large', limit: max }), { status: 413, headers: { 'Cache-Control': 'no-store' } });
  }
  // Streaming count with cap — chunked bodies over the cap are cancelled.
  const received = await countBody(request.body, max);
  if (received < 0) {
    ISOLATE_COUNTERS.upRejected++;
    return new Response(JSON.stringify({ error: 'upload too large', limit: max }), { status: 413, headers: { 'Cache-Control': 'no-store' } });
  }
  ISOLATE_COUNTERS.httpUp++;
  const h = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-transform',
    'X-Hybrid-Server': 'speedtest-hybrid-worker/1.1',
  });
  const origin = request.headers.get('origin');
  if (origin) h.set('Access-Control-Allow-Origin', origin);
  return new Response(JSON.stringify({ bytes: received }), { status: 200, headers: h });
}

function handleMeta(request: Request): Response {
  const cf = (request as unknown as { cf?: Record<string, unknown> }).cf || {};
  return new Response(
    JSON.stringify(
      {
        server: 'speedtest-hybrid-worker/1.0',
        instanceUuid: getInstanceUuid(),
        isolateUptimeSeconds: Math.floor((Date.now() - startedAt()) / 1000),
        colo: cf.colo ?? null,
        country: cf.country ?? null,
        city: cf.city ?? null,
        asn: cf.asn ?? null,
        counters: ISOLATE_COUNTERS,
        endpoints: {
          netgaugeWs: '/ws (upgrade; NetGauge commands as WS frames)',
          legacyHttp: '/, /hi, /latency.txt, /speedtest/random{N}x{N}.jpg, /speedtest/upload.php, /crossdomain.xml',
          hybridDown: '/__down?bytes=N (N=0 for TTFB ping)',
          hybridUp: 'POST /__up (drain + count)',
        },
      },
      null,
      2,
    ),
    { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
}

// ---------------------------------------------------------------------------
// WebSocket NetGauge sessions (the web-client measurement plane)
// ---------------------------------------------------------------------------

function handleWsUpgrade(request: Request, url: URL, env: Env): Response {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  server.accept();
  ISOLATE_COUNTERS.wsSessions++;

  const ip = peerIp(request);
  const versionString = env.VERSION_STRING || DEFAULTS.versionString;
  const wsLimit = num(env.WS_FRAME_LIMIT_BYTES, DEFAULTS.wsFrameLimitBytes);

  const hooks = {
    writeLine: (line: string): void => {
      // WS HELLO quirk [V]: the HELLO reply carries no trailing newline;
      // every other reply does.
      const payload = line.startsWith('HELLO ') ? line : line + '\n';
      server.send(payload);
    },
    writeBinary: (data: Uint8Array): void => {
      server.send(data);
    },
    close: (): void => {
      try {
        server.close(1000, 'disconnect');
      } catch {
        /* already closing */
      }
    },
    peerIp: () => ip,
    instanceUuid: () => getInstanceUuid(),
    startedAt: () => startedAt(),
    onEvent: (kind: string, detail: Record<string, unknown>): void => {
      // G-6/Free-CPU: the per-command 'cmd' event is hot — only log it in
      // verbose mode. Sessions, transfers and errors always log.
      if (kind === 'cmd' && !bool(env.WORKER_VERBOSE_LOGS)) return;
      logEvent('ng_' + kind, detail);
    },
  };
  const engine = new NetGaugeEngine(hooks, {
    versionString,
    maxDownloadBytes: num(env.MAX_DOWNLOAD_BYTES, DEFAULTS.maxDownloadBytes),
    maxUploadBytes: num(env.MAX_UPLOAD_BYTES, DEFAULTS.maxUploadBytes),
    maxLineBytes: 1024 * 1024,
  });

  server.addEventListener('message', (event: MessageEvent) => {
    // Normalize the payload across runtimes: text frames arrive as strings;
    // binary frames arrive as ArrayBuffer (documented edge behavior) or as
    // Blob (workerd local dev) — handle both.
    void (async () => {
      let data: Uint8Array;
      if (typeof event.data === 'string') {
        data = new TextEncoder().encode(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        data = new Uint8Array(event.data);
      } else {
        // Blob path (workerd local): read asynchronously.
        const blob = event.data as unknown as Blob;
        data = new Uint8Array(await blob.arrayBuffer());
      }
      if (data.byteLength > wsLimit) {
        // Daemon parity intent (F-27): oversized frames get NO reply and the
        // connection is torn down. The Worker cannot send a raw TCP RST
        // (D-W3) — close without a reply is the closest platform behavior.
        logEvent('ws_frame_too_big', { limit: wsLimit, bytes: data.byteLength });
        try {
          server.close(1009, 'payload too big');
        } catch {
          /* noop */
        }
        return;
      }
      // Pre-session GETIP gate on the RAW frame (F-12) — must run before the
      // first-command reduction discards trailing bytes.
      if (engine.rawFramePreCheck(data)) return;
      // One command per frame while idle (F-13); upload payload frames are
      // exempt and count as data.
      const payload = engine.isIdle ? firstCommandLine(data) : data;
      engine.feedFrame(payload);
    })();
  });
  server.addEventListener('close', () => engine.destroy());
  server.addEventListener('error', (e: Event) => logEvent('ws_error', { error: String((e as ErrorEvent).message || 'error') }));

  logEvent('ws_session_open', { ip, instance: getInstanceUuid() });
  return new Response(null, { status: 101, webSocket: client });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      // NetGauge over WebSocket — the primary web-lane measurement endpoint.
      if (path === '/ws') {
        if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
          // Daemon drops silently; closest Worker behavior (D-W4).
          return new Response(null, { status: 500, headers: { Connection: 'Close' } });
        }
        const secret = env.HYBRID_SHARED_SECRET || '';
        if (secret) {
          const v = await verifyToken(secret, extractToken(request, url), { ip: peerIp(request) });
          if (!v.ok) return new Response(JSON.stringify({ error: 'unauthorized', reason: v.reason }), { status: 401 });
        }
        return handleWsUpgrade(request, url, env);
      }

      // Hybrid throughput endpoints (token-gated when a secret is set).
      if (path === '/__down' || path === '/__up') {
        const secret = env.HYBRID_SHARED_SECRET || '';
        if (secret) {
          const v = await verifyToken(secret, extractToken(request, url), { ip: peerIp(request) });
          if (!v.ok) return new Response(JSON.stringify({ error: 'unauthorized', reason: v.reason }), { status: 401 });
        }
        return path === '/__down' ? handleDown(request, url, env) : handleUp(request, url, env);
      }

      if (path === '/__meta' || path === '/__health') {
        return handleMeta(request);
      }

      // Daemon-parity legacy HTTP surface (/, /hi, latency.txt, random*.jpg,
      // upload.php, crossdomain.xml, 404 shape) — G-7: OFF by default in
      // code. Production (K-7) keeps it off; local conformance and the
      // [env.test] Worker set LEGACY_HTTP_ENABLED="true".
      if (!bool(env.LEGACY_HTTP_ENABLED)) {
        // Legacy paths return the daemon 404 shape when the surface is off,
        // so probing /hi, /upload.php, random*.jpg yields nothing usable.
        const legacyPaths = ['/', '/hi', '/latency.txt', '/crossdomain.xml', '/upload.php'];
        const p = url.pathname.replace(/\/+$/, '') || '/';
        const isLegacy =
          legacyPaths.includes(p) ||
          p.startsWith('/speedtest/') ||
          /random[0-9]+x[0-9]+\.jpg$/.test(p);
        if (isLegacy) {
          return new Response(null, {
            status: 404,
            headers: { Connection: 'Close', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
          });
        }
      } else {
        const legacy = await handleLegacyHttp(request, url, env);
        if (legacy) return legacy;
      }

      // Unknown path → daemon 404 shape.
      return new Response(null, {
        status: 404,
        headers: { Connection: 'Close', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    } catch (e) {
      logEvent('worker_exception', { error: String(e).slice(0, 200) });
      return new Response(JSON.stringify({ error: 'internal' }), { status: 500 });
    }
  },
};

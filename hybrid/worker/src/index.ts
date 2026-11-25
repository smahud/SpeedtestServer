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
 *
 * WORKER POOL (2026-11-25): this script is deployed N times (N ≤ 100 —
 * the Workers Free script cap) as `speedtest-hybrid-worker` (id 1) and
 * `speedtest-hybrid-worker-2..N`. Each deployment carries WORKER_ID and
 * WORKER_POOL_MAX vars. The VPS gateway's pool manager decides which
 * workers receive traffic (smart activation); a worker that senses
 * local saturation (per-isolate in-flight gauge) AUTONOMOUSLY deflects
 * an authenticated request to its sibling (302/307 + hop guard, no
 * redirect loops) — "worker berikutnya membantu traffic besar".
 */

import { Env, DEFAULTS, num, bool } from './config';
import { NetGaugeEngine, firstCommandLine } from './netgauge';
import { handleLegacyHttp, poolResponse, countBody, originAllowed } from './http-legacy';
import { verifyToken, extractToken } from './token';
import { fillFromPool } from './pool';

// Per-isolate identity (daemon parity: one instance UUID / uptime per
// process). Lazily initialized — the runtime forbids random generation and
// timers at global scope.
let isolateStartedAt = 0;
let instanceUuid: string | null = null;
const ISOLATE_COUNTERS = { sessions: 0, wsSessions: 0, httpDown: 0, httpUp: 0, upRejected: 0, deflections: 0, deflectedHere: 0 };

// --- per-isolate load gauge (worker-pool smart activation signal) ---------
// Rough but cheap: in-flight requests in THIS isolate + a 60 s EWMA of the
// request rate. Cloudflare routes to warm isolates first, so the gauge is a
// usable saturation hint; the gateway treats it as ONE input among others.
let inFlight = 0;
let loadEwma = 0; // requests/minute estimate
let lastRateSample = 0;
function sampleRate(now: number): void {
  if (!lastRateSample) {
    lastRateSample = now;
    return;
  }
  const dtSec = (now - lastRateSample) / 1000;
  if (dtSec >= 1) {
    // One request just arrived; instantaneous rate = 1/dt, EWMA-smoothed.
    const instPerMin = 60 / dtSec;
    loadEwma = loadEwma === 0 ? instPerMin : Math.min(loadEwma * 0.8 + instPerMin * 0.2, 10000);
    lastRateSample = now;
  }
}
function beginRequest(): void {
  const now = Date.now();
  sampleRate(now);
  inFlight++;
}
function endRequest(): void {
  if (inFlight > 0) inFlight--;
}

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
// Worker pool helpers (self-identification + sibling deflection)
// ---------------------------------------------------------------------------

function workerId(env: Env): number {
  const n = Number(env.WORKER_ID);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function poolMax(env: Env): number {
  const n = Number(env.WORKER_POOL_MAX);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** URL of the NEXT worker in the pool ring (wraps to the primary).
 *  Derived from this request's own host: `<script>.<account>.workers.dev`
 *  ↔ `<script>-N.<account>.workers.dev`. */
function nextWorkerUrl(request: Request, env: Env): string | null {
  const myId = workerId(env);
  const max = poolMax(env);
  if (max < 2) return null; // single-worker deployment: nowhere to deflect
  let next = myId + 1;
  if (next > max) next = 1; // wrap to the primary (no numeric suffix)
  const u = new URL(request.url);
  const host = u.hostname.toLowerCase();
  if (!host.endsWith('.workers.dev')) return null; // custom domain: cannot derive siblings
  const hostPart = host.slice(0, -'.workers.dev'.length);
  const lastDot = hostPart.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const script = hostPart.slice(0, lastDot);
  const account = hostPart.slice(lastDot + 1);
  const mySuffix = myId === 1 ? '' : `-${myId}`;
  if (!hostPart.endsWith(mySuffix)) return null; // unexpected host shape — do not guess
  const nextHost = next === 1 ? `${script}.${account}.workers.dev` : `${script}-${next}.${account}.workers.dev`;
  u.hostname = nextHost;
  // hop guard: mark the redirect so the target never deflects again
  u.searchParams.set('hop', '1');
  return u.toString();
}

/** Autonomous mutual help: when THIS isolate is saturated, hand the
 *  (authenticated) request to the next worker. Returns a Response when the
 *  request was deflected, null when it should be served locally. */
function maybeDeflect(request: Request, url: URL, env: Env, authenticated: boolean): Response | null {
  if (!authenticated) return null; // never redirect anonymous traffic
  if (url.searchParams.get('hop') === '1') return null; // loop guard: already deflected once
  if (inFlight < num(env.WORKER_DEFLECT_CONCURRENCY, 6)) return null; // not saturated
  const target = nextWorkerUrl(request, env);
  if (!target) return null;
  ISOLATE_COUNTERS.deflections++;
  logEvent('pool_deflect', { to: target, inFlight });
  if (request.method === 'GET' || request.method === 'HEAD') {
    return new Response(null, {
      status: 302,
      headers: { Location: target, 'Cache-Control': 'no-store, no-transform' },
    });
  }
  // POST (upload): 307 preserves the method+body for capable clients.
  return new Response(null, {
    status: 307,
    headers: { Location: target, 'Cache-Control': 'no-store, no-transform' },
  });
}

// ---------------------------------------------------------------------------
// Hybrid throughput endpoints (speed.cloudflare.com-style)
// ---------------------------------------------------------------------------

function downResponse(bytes: number, env: Env, signal?: AbortSignal, onDone?: () => void): Response {
  const headers: [string, string][] = [
    ['Cache-Control', 'no-store, no-transform'],
    ['X-Content-Type-Options', 'nosniff'],
    ['Content-Type', 'application/octet-stream'],
    ['X-Hybrid-Server', 'speedtest-hybrid-worker/1.2'],
  ];
  if (bytes === 0) return new Response(null, { status: 200, headers }); // TTFB ping
  // G-5: client cancel (disconnect) aborts generation via request.signal
  // when the runtime provides it. onDone releases the in-flight gauge.
  return poolResponse(bytes, headers, signal, onDone);
}

async function handleDown(request: Request, url: URL, env: Env, onDone?: () => void): Promise<Response> {
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
  return downResponse(bytes, env, request.signal, onDone);
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
    // G-4b: cancel the incoming body so the runtime can flush the 413
    // before the client finishes (or never finishes) sending it.
    try { await request.body?.cancel(); } catch { /* already closed */ }
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
    'X-Hybrid-Server': 'speedtest-hybrid-worker/1.2',
  });
  // BUG FIX: the origin was reflected verbatim — an arbitrary website could
  // read the (token-gated) response from the browser. Reflect only origins
  // the CORS allowlist accepts, like every other surface.
  const origin = request.headers.get('origin');
  if (origin && originAllowed(origin, env)) h.set('Access-Control-Allow-Origin', origin);
  return new Response(JSON.stringify({ bytes: received }), { status: 200, headers: h });
}

function handleMeta(request: Request, env: Env): Response {
  const cf = (request as unknown as { cf?: Record<string, unknown> }).cf || {};
  return new Response(
    JSON.stringify(
      {
        server: 'speedtest-hybrid-worker/1.2',
        instanceUuid: getInstanceUuid(),
        isolateUptimeSeconds: Math.floor((Date.now() - startedAt()) / 1000),
        colo: cf.colo ?? null,
        country: cf.country ?? null,
        city: cf.city ?? null,
        asn: cf.asn ?? null,
        // Worker-pool identity + per-isolate load hints (the gateway probes
        // these as ONE input to its smart-activation decision).
        worker: {
          id: workerId(env),
          poolMax: poolMax(env),
          inFlight,
          loadHintPerMin: Math.round(loadEwma),
        },
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
      // BUG FIX: server.send() throws when the socket is closing — the
      // throw escaped into the WS message handler as an unhandled rejection
      // and left the session half-processed.
      try {
        // WS HELLO quirk [V]: the HELLO reply carries no trailing newline;
        // every other reply does.
        const payload = line.startsWith('HELLO ') ? line : line + '\n';
        server.send(payload);
      } catch {
        /* socket closing — the close handler tears the engine down */
      }
    },
    writeBinary: (data: Uint8Array): void => {
      try {
        server.send(data);
      } catch {
        /* socket closing */
      }
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
    // BUG FIX: rejections of this async IIFE were unhandled ("Uncaught (in
    // promise)" in the tail) — they are now logged and the session torn down.
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
      // exempt and count as data. When the frame has NO newline, one is
      // synthesized for the line-based engine — the REAL wire length is
      // passed so UPLOAD's inclusive counting counts bytes actually sent.
      if (engine.isIdle) {
        const nl = data.indexOf(0x0a);
        engine.feedFrame(firstCommandLine(data), nl === -1 ? data.byteLength : undefined);
      } else {
        engine.feedFrame(data);
      }
    })().catch((e) => {
      logEvent('ws_msg_error', { error: String(e).slice(0, 200) });
      try {
        server.close(1011, 'engine error');
      } catch {
        /* already closing */
      }
      engine.destroy();
    });
  });
  server.addEventListener('close', () => {
    engine.destroy();
    endRequest(); // WS session gauge
  });
  server.addEventListener('error', (e: Event) => logEvent('ws_error', { error: String((e as ErrorEvent).message || 'error') }));

  beginRequest(); // WS session gauge (ends on close)
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
    beginRequest();
    try {
      // NetGauge over WebSocket — the primary web-lane measurement endpoint.
      if (path === '/ws') {
        if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
          // Daemon drops silently; closest Worker behavior (D-W4).
          return new Response(null, { status: 500, headers: { Connection: 'Close' } });
        }
        const secret = env.HYBRID_SHARED_SECRET || '';
        let authed = true;
        if (secret) {
          const v = await verifyToken(secret, extractToken(request, url), { ip: peerIp(request) });
          if (!v.ok) return new Response(JSON.stringify({ error: 'unauthorized', reason: v.reason }), { status: 401 });
          authed = true;
        }
        // Autonomous deflection for WS upgrades: the client cannot follow an
        // HTTP redirect on an upgrade — answer 503 + Location and let the
        // hybrid-aware clients reconnect to the sibling.
        if (inFlight >= num(env.WORKER_DEFLECT_CONCURRENCY, 6) && url.searchParams.get('hop') !== '1') {
          const target = nextWorkerUrl(request, env);
          if (target) {
            ISOLATE_COUNTERS.deflections++;
            logEvent('pool_deflect_ws', { to: target, inFlight });
            return new Response(JSON.stringify({ error: 'worker-busy', location: target }), {
              status: 503,
              headers: { Location: target, 'Retry-After': '1', 'Cache-Control': 'no-store' },
            });
          }
        }
        void authed;
        return handleWsUpgrade(request, url, env);
      }

      // Hybrid throughput endpoints (token-gated when a secret is set).
      if (path === '/__down' || path === '/__up') {
        const secret = env.HYBRID_SHARED_SECRET || '';
        let authed = true;
        if (secret) {
          const v = await verifyToken(secret, extractToken(request, url), { ip: peerIp(request) });
          if (!v.ok) return new Response(JSON.stringify({ error: 'unauthorized', reason: v.reason }), { status: 401 });
          authed = true;
        }
        // Smart-pool mutual help: deflect to a sibling when saturated.
        const deflected = maybeDeflect(request, url, env, authed);
        if (deflected) return deflected;
        return path === '/__down' ? handleDown(request, url, env, endRequest) : handleUp(request, url, env);
      }

      if (path === '/__meta' || path === '/__health') {
        return handleMeta(request, env);
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
    } finally {
      // Non-streaming requests release the gauge here; streaming responses
      // (__down, WS) release it via stream completion / close handlers.
      const streaming =
        path === '/ws' ||
        (path === '/__down' && request.method === 'GET' && Number(url.searchParams.get('bytes') || 0) > 0);
      if (!streaming) endRequest();
    }
  },
};

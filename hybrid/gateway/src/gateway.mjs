#!/usr/bin/env node
/**
 * gateway.mjs — the VPS control plane of the hybrid architecture.
 *
 * Responsibilities (the "origin" role of the VPS):
 *   - discovery:      GET  /api/servers   — the role-split endpoint map
 *   - session tokens: POST /api/sessions  — HMAC token (verified locally by
 *                     the Worker; zero runtime coupling)
 *   - result intake:  POST /api/results   — measurement records land here
 *   - latency plane:  GET  /api/ping      — TTFB-style timestamp echo on the
 *                     VPS path (the UDP echo/jitter plane stays on STS :8080)
 *   - worker pool:    GET  /api/pool      — smart worker-pool status (see
 *                     workerpool.mjs — the "VPS memegang kendali worker"
 *                     control plane for the 1..100 Worker pool)
 *
 * The payload data plane (DOWNLOAD/UPLOAD bytes) NEVER transits this
 * service — that is the entire point of the hybrid split.
 *
 * Zero dependencies: node:http + node:crypto (+ node:tls for HTTPS).
 *
 * Env:
 *   HYBRID_GATEWAY_PORT       default 8090
 *   HYBRID_GATEWAY_BIND       default 127.0.0.1 (use 0.0.0.0 to expose; pair with TLS)
 *   HYBRID_GATEWAY_TLS_CERT   optional path to PEM cert — enables HTTPS listener
 *   HYBRID_GATEWAY_TLS_KEY    optional path to PEM key (required when cert set)
 *   HYBRID_SHARED_SECRET      HMAC secret (same value as the Worker secret)
 *   HYBRID_WORKER_BASE        default http://127.0.0.1:8790 (edge stand-in)
 *   HYBRID_VPS_PUBLIC_BASE    default http://127.0.0.1:8090 (this gateway)
 *   HYBRID_STS_BASE           default http://127.0.0.1:8080 (SpeedtestServer)
 *   HYBRID_TOKEN_TTL_MS       default 300000 (5 min; G-1)
 *   HYBRID_TOKEN_BIND_IP      default false. true = bind token to the peer
 *                             socket IP (pre-G-1 behaviour; breaks clients
 *                             behind proxies / dual-stack mismatches)
 *   HYBRID_DISCOVERY_FALLBACK default false. true = advertise the STS /ws
 *                             fallback in discovery (K-7: off in production)
 *   HYBRID_RESULTS_FILE       optional JSONL result log
 *   HYBRID_RESULTS_DEDUP_MS   default 3600000 — duplicate result POSTs for the
 *                             same guid within this window get the same
 *                             response and are logged once (G-9)
 *   HYBRID_SESSIONS_RATE_LIMIT_MPM default 60 — per-IP token-mint rate limit on
 *                             /api/sessions (BUG FIX: this endpoint was an
 *                             unthrottled token fountain that could burn the
 *                             account's daily Worker quota)
 *   HYBRID_VPS_DL_SHARE       default 0.15 — v1.4 assist model: fraction of
 *                             front download REQUESTS served directly by the
 *                             VPS at full speed (no budget, no throttle);
 *                             the rest is 302-assisted by the worker pool.
 *                             1.0 = pure VPS, 0.0 = pure edge. REMOVED v1.4:
 *                             HYBRID_VPS_DL_BUDGET_MBPS (operator decision —
 *                             the VPS must never be bandwidth-capped)
 *   HYBRID_WORKER_* / HYBRID_CF_*   see workerpool.mjs (worker pool control)
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createFront } from './front.mjs';
import { createWorkerPool, createRateLimiter } from './workerpool.mjs';

const PORT = Number(process.env.HYBRID_GATEWAY_PORT || 8090);
const BIND = process.env.HYBRID_GATEWAY_BIND || '127.0.0.1';
const TLS_CERT = process.env.HYBRID_GATEWAY_TLS_CERT || '';
const TLS_KEY = process.env.HYBRID_GATEWAY_TLS_KEY || '';
const SECRET = process.env.HYBRID_SHARED_SECRET || '';
const WORKER_BASE = process.env.HYBRID_WORKER_BASE || 'http://127.0.0.1:8790';
const VPS_BASE = process.env.HYBRID_VPS_PUBLIC_BASE || 'http://127.0.0.1:8090';
const STS_BASE = process.env.HYBRID_STS_BASE || 'http://127.0.0.1:8080';
const TTL_MS = Number(process.env.HYBRID_TOKEN_TTL_MS || 300000);
const TOKEN_BIND_IP = String(process.env.HYBRID_TOKEN_BIND_IP || '') === 'true';
const DISCOVERY_FALLBACK = String(process.env.HYBRID_DISCOVERY_FALLBACK || '') === 'true';
const RESULTS_FILE = process.env.HYBRID_RESULTS_FILE || '';
const RESULTS_DEDUP_MS = Number(process.env.HYBRID_RESULTS_DEDUP_MS || 3600000);
const SESSIONS_RATE_LIMIT_MPM = Number(process.env.HYBRID_SESSIONS_RATE_LIMIT_MPM ?? 60);

// --- speedtest front (legacy HTTP surface: edge offload + VPS assist) ---
const FRONT_ENABLED = String(process.env.HYBRID_FRONT_ENABLED || '') === 'true';
const FRONT_RATE_LIMIT_MPM = Number(process.env.HYBRID_FRONT_RATE_LIMIT_MPM ?? 90);
const FRONT_MAX_DOWN_BYTES = Number(process.env.HYBRID_FRONT_MAX_DOWN_BYTES ?? 26214400);
const FRONT_TOKEN_CACHE_MS = Number(process.env.HYBRID_FRONT_TOKEN_CACHE_MS ?? Math.max(30000, TTL_MS - 60000));
// --- VPS assist lane (v1.4: "VPS mengeluarkan SEMUA potensi, CF membantu") ---
// Share of front download REQUESTS served DIRECTLY by the VPS at FULL link
// speed — there is NO token bucket and NO byte budget (the v1.3
// HYBRID_VPS_DL_BUDGET_MBPS was removed at operator request: it capped the
// VPS's contribution). The complementary (1 - share) of requests is
// 302-assisted by the CF worker pool in parallel, so the client aggregate
// ≈ VPS capacity + edge capacity. 1.0 = pure VPS potential; 0.0 = legacy
// pure edge offload. Empty/unset → 0.15; "0" is honored as an explicit 0.
const VPS_DL_SHARE_RAW = String(process.env.HYBRID_VPS_DL_SHARE ?? '').trim();
const VPS_DL_SHARE = VPS_DL_SHARE_RAW === ''
  ? 0.15
  : Math.min(1, Math.max(0, Number(VPS_DL_SHARE_RAW) || 0));

// Evidence counters — how many control-plane bytes the VPS actually served.
const counters = { servers: 0, sessions: 0, results: 0, pings: 0, bytesIn: 0, bytesOut: 0 };

const startedAt = Date.now();
const instanceId = crypto.randomUUID();

function log(kind, detail = {}) {
  console.log(JSON.stringify({ ts: Date.now(), kind, ...detail }));
}

// --- worker pool ("VPS memegang kendali worker": 1..100 smart activation) --
const pool = createWorkerPool({ base: WORKER_BASE, log });

// --- token minting (format shared with hybrid/worker/src/token.ts) ---------
// G-1: by default the token is NOT bound to a socket IP ('*'), so clients
// behind proxies/NAT or with v4↔v6 path asymmetry (IPv4 to the VPS, IPv6 to
// Cloudflare) are not rejected with ip-mismatch. Set HYBRID_TOKEN_BIND_IP=true
// to restore strict binding.
function mintToken(ip) {
  const guid = crypto.randomUUID();
  const expMs = Date.now() + TTL_MS;
  const tip = TOKEN_BIND_IP ? ip : '*';
  const sig = crypto.createHmac('sha256', SECRET).update(`v1|${guid}|${expMs}|${tip}`).digest('hex');
  return { token: `v1~${guid}~${expMs}~${tip}~${sig}`, guid, expMs };
}

function verifyToken(token, ip) {
  if (!SECRET) return { ok: true, reason: 'open-mode' };
  if (!token) return { ok: false, reason: 'missing-token' };
  const parts = token.split('~');
  if (parts.length !== 5 || parts[0] !== 'v1') return { ok: false, reason: 'malformed' };
  const [v, guid, expStr, tip, sig] = parts;
  const expMs = Number(expStr);
  if (!Number.isFinite(expMs)) return { ok: false, reason: 'bad-exp' };
  const expect = crypto.createHmac('sha256', SECRET).update(`${v}|${guid}|${expStr}|${tip}`).digest('hex');
  // BUG FIX: plain !== short-circuits at the first differing byte (signature
  // comparison side channel). Constant-time compare with a length guard.
  const a = Buffer.from(expect, 'utf8');
  const b = Buffer.from(String(sig), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature' };
  if (Date.now() > expMs) return { ok: false, reason: 'expired' };
  if (tip !== '*' && ip && tip !== ip) return { ok: false, reason: 'ip-mismatch' };
  return { ok: true, guid };
}

/** Mint a session token routed to a pool-selected worker. */
function mintSessionToken(ip) {
  const worker = pool.pickWorker();
  pool.recordMint(worker.id);
  const minted = mintToken(TOKEN_BIND_IP ? ip : '*');
  return { ...minted, worker };
}

function readBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve) => {
    // BUG FIX: the old path destroyed the socket IMMEDIATELY on overflow —
    // the 413/400 response written afterwards went into a destroyed socket
    // and the client saw a connection reset instead of a status. The socket
    // is now torn down only after the response has flushed.
    const chunks = [];
    let total = 0;
    let destroyed = false;
    req.on('data', (c) => {
      total += c.length;
      if (total > limitBytes) {
        if (!destroyed) {
          destroyed = true;
          resolve({ overLimit: true, body: null });
          // Stop reading; the caller responds, then destroys on finish.
          req.pause();
        }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve({ overLimit: false, body: Buffer.concat(chunks) }));
    req.on('error', () => resolve({ overLimit: false, body: Buffer.concat(chunks) }));
  });
}

function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2));
  counters.bytesOut += body.length;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'Cache-Control': 'no-store, no-transform',
    'X-Hybrid-Gateway': '1.4',
  });
  res.end(body);
}

// --- the discovery document: the role split of the hybrid architecture -----
function serversDocument() {
  const primary = pool.primaryUrl;
  const throughput = {
    primary: { url: `${primary}/ws`, transport: 'wss-netgauge', description: 'NetGauge over WebSocket at the edge' },
    http: { url: `${primary}/__down`, upload: `${primary}/__up`, transport: 'http-streaming' },
    pool: {
      description: 'Smart worker pool — POST /api/sessions returns the assigned worker; GET /api/pool returns the live pool state',
      activeCount: pool.status().activeCount,
      max: pool.status().poolMax,
    },
  };
  // G-3 / K-7: the STS /ws fallback is opt-in and OFF by default — no mass
  // fallback of throughput traffic to the VPS.
  if (DISCOVERY_FALLBACK) {
    throughput.fallback = { url: `${STS_BASE}/ws`, transport: 'ws-netgauge', description: 'OPT-IN: VPS fallback when the edge is unavailable (not for production discovery)' };
  }
  return {
    version: 2,
    issuedAt: new Date().toISOString(),
    roles: {
      control: { url: VPS_BASE, description: 'discovery, session tokens, result intake' },
      latency: {
        vpsTtfb: `${VPS_BASE}/api/ping`,
        vpsUdpLoss: `${STS_BASE.replace(/^https?:\/\//, '')} (NetGauge UDP LOSS/RECV via SpeedtestServer)`,
        edgeTtfb: `${primary}/__down?bytes=0`,
        description: 'UDP jitter/loss and stable-identity latency stay on the VPS; edge TTFB is a comparative metric',
      },
      throughput,
    },
    notes: 'Official Ookla CLI clients: use the VPS NetGauge TCP endpoint (SpeedtestServer :8080) — the CLI cannot speak HTTP/WebSocket transports.',
  };
}

// G-9: result deduplication per guid — replays within the window get the
// identical response and are persisted once.
const resultMemory = new Map(); // guid -> { expiresAt, response }
function rememberResult(guid, response) {
  const now = Date.now();
  for (const [k, v] of resultMemory) if (v.expiresAt < now) resultMemory.delete(k);
  resultMemory.set(guid, { expiresAt: now + RESULTS_DEDUP_MS, response });
  if (resultMemory.size > 4096) {
    const first = resultMemory.keys().next().value;
    resultMemory.delete(first);
  }
}

/** Append a result record to the JSONL log (async, failure-isolated). */
function appendResultRecord(record) {
  if (!RESULTS_FILE) return;
  // BUG FIX: appendFileSync threw synchronously inside the async handler on
  // any I/O error (disk full / bad path) and killed the process.
  fs.appendFile(RESULTS_FILE, JSON.stringify(record) + '\n', (err) => {
    if (err) log('result_log_error', { error: String(err).slice(0, 200) });
  });
}

// Per-IP rate limit for /api/sessions (BUG FIX: unthrottled token fountain).
const sessionsLimiter = createRateLimiter(SESSIONS_RATE_LIMIT_MPM);

// The front router (only when enabled). Shares mintToken/counters/logging.
const front = FRONT_ENABLED
  ? createFront({
      mintToken,
      log,
      counters,
      workerBase: WORKER_BASE,
      pool,
      rateLimitMpm: FRONT_RATE_LIMIT_MPM,
      maxDownBytes: FRONT_MAX_DOWN_BYTES,
      tokenTtlMs: TTL_MS,
      tokenCacheMs: FRONT_TOKEN_CACHE_MS,
      tokenBindIp: TOKEN_BIND_IP,
      vpsDlShare: VPS_DL_SHARE,
    })
  : null;

const requestHandler = async (req, res) => {
  // BUG FIX (crash): a malformed Host header made the WHATWG URL constructor
  // throw synchronously inside the async handler → unhandled rejection →
  // process death (Node ≥15 default). Parse defensively.
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return json(res, 400, { error: 'bad-request' });
  }
  let ip = req.socket.remoteAddress || '127.0.0.1';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // normalize IPv4-mapped IPv6

  // The speedtest front MUST run before any body buffering: it answers
  // redirects/drains on its own and never buffers payload in memory.
  if (front) {
    let handled = false;
    try {
      handled = front(req, res, url, ip);
    } catch (e) {
      log('front_error', { error: String(e).slice(0, 200) });
    }
    if (handled) return;
  }

  const isBodyMethod = req.method === 'POST' || req.method === 'PUT';
  let body = null;
  if (isBodyMethod) {
    const r = await readBody(req);
    if (r.overLimit) {
      // Respond FIRST, then tear the socket down after the response flushed.
      json(res, 413, { error: 'payload too large' });
      res.on('finish', () => req.destroy());
      return;
    }
    body = r.body;
    if (body) counters.bytesIn += body.length;
  }
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/api/servers' && req.method === 'GET') {
    counters.servers++;
    return json(res, 200, serversDocument());
  }

  if (path === '/api/sessions' && req.method === 'POST') {
    if (!SECRET) return json(res, 500, { error: 'HYBRID_SHARED_SECRET not configured' });
    // BUG FIX: rate limit — this endpoint minted unlimited 5-minute wildcard
    // tokens (each spendable at the edge up to the per-request caps), an
    // easy account-quota burn vector.
    if (!sessionsLimiter.allow(ip)) {
      log('sessions_rate_limited', { ip });
      return json(res, 429, { error: 'rate-limited', retryAfterMs: 60000 });
    }
    if (pool.quotaBlocksMint()) {
      log('sessions_quota_blocked', { ip });
      return json(res, 503, { error: 'worker-quota-exhausted', retryAfterMs: 60000 });
    }
    counters.sessions++;
    const { token, guid, expMs, worker } = mintSessionToken(ip);
    log('session_minted', { guid, ip, expMs, bound: TOKEN_BIND_IP, workerId: worker.id });
    return json(res, 200, {
      token,
      guid,
      expiresAt: new Date(expMs).toISOString(),
      worker: { id: worker.id, url: worker.url },
      endpoints: serversDocument().roles,
    });
  }

  if (path === '/api/ping' && req.method === 'GET') {
    counters.pings++;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    const body = `{"t":${Date.now()}}`;
    counters.bytesOut += body.length;
    return res.end(body);
  }

  if (path === '/api/results' && req.method === 'POST') {
    let payload = null;
    try {
      payload = JSON.parse(body ? body.toString() : '{}');
    } catch {
      return json(res, 400, { error: 'invalid json' });
    }
    // BUG FIX (verified crash): JSON.parse('null') returns null — the old
    // code dereferenced payload.token and killed the process.
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return json(res, 400, { error: 'invalid json' });
    }
    const v = verifyToken(payload.token, ip);
    if (!v.ok) return json(res, 401, { error: 'unauthorized', reason: v.reason });
    // Optional worker feedback: a client reporting which worker served it.
    if (typeof payload.workerId === 'number' && payload.workerOk === false) pool.recordWorkerError(payload.workerId);
    if (typeof payload.workerId === 'number' && payload.workerOk === true) pool.recordWorkerOk(payload.workerId, -1);
    const guid = v.guid || payload.guid || null;
    const mem = guid ? resultMemory.get(guid) : null;
    if (mem && mem.expiresAt > Date.now()) {
      counters.results++; // counted, but NOT re-persisted
      return json(res, 200, mem.response);
    }
    counters.results++;
    const record = {
      receivedAt: new Date().toISOString(),
      guid,
      ip,
      metrics: payload.metrics || {},
      accounting: payload.accounting || {},
      client: payload.client || {},
    };
    const response = { ok: true, guid };
    rememberResult(guid, response);
    log('result_accepted', { guid, ip });
    appendResultRecord(record);
    return json(res, 200, response);
  }

  if (path === '/api/pool' && req.method === 'GET') {
    return json(res, 200, pool.status());
  }

  if (path === '/api/health' && req.method === 'GET') {
    return json(res, 200, {
      server: 'hybrid-gateway/1.4',
      instanceId,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      counters,
      front: front
        ? {
            enabled: true,
            rateLimitMpm: FRONT_RATE_LIMIT_MPM,
            // v1.4 — the assist lane: which download lane served what.
            // NO bandwidth budget exists anymore: the VPS lane runs
            // uncapped; share only distributes requests between lanes.
            assist: {
              vpsDlShare: VPS_DL_SHARE,
              enabled: VPS_DL_SHARE > 0,
            },
            counters: {
              latency: counters.frontLatency || 0,
              downloads: counters.frontDownloads || 0,
              dlLocal: counters.frontDlLocal || 0,
              dlLocalServed: counters.frontDlLocalServed || 0,
              dlLocalBytes: counters.frontDlLocalBytes || 0,
              dlLocalForced: counters.frontDlLocalForced || 0,
              downRedirects: counters.frontDownRedirects || 0,
              downCapped: counters.frontDownCapped || 0,
              uploadsDrained: counters.frontUploads || 0,
              miniProbes: counters.frontMiniProbe || 0,
              tokensMinted: counters.frontTokensMinted || 0,
              rateLimited: counters.frontRateLimited || 0,
              bytesIn: counters.frontBytesIn || 0,
              bytesOut: counters.frontBytesOut || 0,
            },
          }
        : { enabled: false },
      pool: pool.status(),
      config: { workerBase: WORKER_BASE, vpsBase: VPS_BASE, stsBase: STS_BASE, tokenTtlMs: TTL_MS, tokenBindIp: TOKEN_BIND_IP, discoveryFallback: DISCOVERY_FALLBACK, tls: Boolean(TLS_CERT), resultsDedupMs: RESULTS_DEDUP_MS, secretConfigured: Boolean(SECRET), sessionsRateLimitMpm: SESSIONS_RATE_LIMIT_MPM },
    });
  }

  return json(res, 404, { error: 'not found', path });
};

if (TLS_CERT) {
  if (!TLS_KEY) {
    console.error(JSON.stringify({ kind: 'gateway_error', error: 'HYBRID_GATEWAY_TLS_CERT set without HYBRID_GATEWAY_TLS_KEY' }));
    process.exit(2);
  }
}
const safeHandler = (req, res) => {
  // BUG FIX (process crash): Node does NOT catch rejections returned by an
  // async request listener — one bad request (null JSON body, throw in a
  // helper) killed the whole control plane (verified live). Every
  // rejection is now answered with a 500 and logged.
  requestHandler(req, res).catch((e) => {
    log('handler_error', { method: req.method, url: String(req.url).slice(0, 120), error: String(e).slice(0, 200) });
    try {
      if (!res.headersSent) json(res, 500, { error: 'internal' });
      else res.destroy();
    } catch {
      /* socket already gone */
    }
  });
};

const listener = TLS_CERT
  ? https.createServer(
      { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY), minVersion: 'TLSv1.2' },
      safeHandler,
    )
  : http.createServer(safeHandler);

// BUG FIX (production hardening): an EADDRINUSE/EACCES on listen surfaced as
// an unhandled 'error' event → hard crash → systemd restart loop with no
// diagnosable log line. Fail loudly ONCE with the real errno instead.
listener.on('error', (e) => {
  console.error(JSON.stringify({ kind: 'gateway_error', error: String(e && e.code ? e.code : e).slice(0, 200), syscall: e && e.syscall, port: PORT, bind: BIND }));
  process.exit(1);
});

// Safety net: log any stray rejection instead of dying.
process.on('unhandledRejection', (e) => {
  log('unhandled_rejection', { error: String(e).slice(0, 200) });
});

listener.listen(PORT, BIND, () => {
  console.log(JSON.stringify({
    kind: 'gateway_started',
    port: PORT,
    bind: BIND,
    tls: Boolean(TLS_CERT),
    front: FRONT_ENABLED,
    frontRateLimitMpm: FRONT_RATE_LIMIT_MPM,
    frontTokenCacheMs: FRONT_TOKEN_CACHE_MS,
    vpsDlShare: VPS_DL_SHARE,
    workerBase: WORKER_BASE,
    workerPoolMax: pool.poolMax,
    vpsBase: VPS_BASE,
    stsBase: STS_BASE,
    tokenTtlMs: TTL_MS,
    tokenBindIp: TOKEN_BIND_IP,
    discoveryFallback: DISCOVERY_FALLBACK,
    secretConfigured: Boolean(SECRET),
  }));
});

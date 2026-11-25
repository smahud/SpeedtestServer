#!/usr/bin/env node
/**
 * gateway.mjs — the VPS control plane of the hybrid architecture (v1.5).
 *
 * Responsibilities (the "origin" role of the VPS):
 *   - discovery:      GET  /api/servers   — the role-split endpoint map
 *   - session tokens: POST /api/sessions  — HMAC token (verified locally by
 *                     the Worker; zero runtime coupling)
 *   - result intake:  POST /api/results   — measurement records land here
 *   - latency plane:  GET  /api/ping      — TTFB-style timestamp echo on the
 *                     VPS path (the UDP echo/jitter plane stays on STS :8080)
 *   - worker pool:    GET  /api/pool      — routing pool status (workerpool.mjs)
 *   - worker sync:    GET  /api/workers   — deployment sync status (v1.5: the
 *                     deployed Cloudflare pool converges to the .env target
 *                     ON THE FLY; see workersync.mjs)
 *
 * v1.5 ON-THE-FLY CONFIGURATION: the repository .env (path in
 * HYBRID_ENV_FILE) is watched and applied live — worker deploy count, pool
 * bounds, lane share, front limits, credentials, shared secret. A restart
 * is only needed for port/bind/TLS changes (re-run install.sh).
 *
 * Mode:
 *   hybrid   (default)  Cloudflare credentials usable + deploy target > 0
 *   vps-only (fallback) no credentials / target 0 — everything served by
 *                       the VPS; the front forces the local lane.
 *
 * The payload data plane (DOWNLOAD/UPLOAD bytes) NEVER transits this
 * service — that is the entire point of the hybrid split.
 *
 * Zero dependencies: node:http + node:crypto (+ node:tls for HTTPS).
 *
 * Env: see .env.example and hybrid/gateway/gateway.env.example — every
 * variable, including all Cloudflare credential scopes, is documented in
 * docs/CLOUDFLARE_CREDENTIALS.md.
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createFront } from './front.mjs';
import { createWorkerPool, createRateLimiter } from './workerpool.mjs';
import { createRuntime } from './runtime.mjs';
import { createWorkerSync } from './workersync.mjs';

const PORT = Number(process.env.HYBRID_GATEWAY_PORT || 8090);
const BIND = process.env.HYBRID_GATEWAY_BIND || '127.0.0.1';
const TLS_CERT = process.env.HYBRID_GATEWAY_TLS_CERT || '';
const TLS_KEY = process.env.HYBRID_GATEWAY_TLS_KEY || '';
const WORKER_BASE_FALLBACK = process.env.HYBRID_WORKER_BASE || 'http://127.0.0.1:8790';
const VPS_BASE = process.env.HYBRID_VPS_PUBLIC_BASE || 'http://127.0.0.1:8090';
const STS_BASE = process.env.HYBRID_STS_BASE || 'http://127.0.0.1:8080';
const RESULTS_FILE = process.env.HYBRID_RESULTS_FILE || '';
const RESULTS_DEDUP_MS = Number(process.env.HYBRID_RESULTS_DEDUP_MS || 3600000);
const DISCOVERY_FALLBACK = String(process.env.HYBRID_DISCOVERY_FALLBACK || '') === 'true';

function log(kind, detail = {}) {
  console.log(JSON.stringify({ ts: Date.now(), kind, ...detail }));
}

// --- v1.5 live runtime configuration (.env watcher) -----------------------
const RT = createRuntime({ log });
const cfg = RT.cfg;

// Evidence counters — how many control-plane bytes the VPS actually served.
const counters = { servers: 0, sessions: 0, results: 0, pings: 0, bytesIn: 0, bytesOut: 0 };

const startedAt = Date.now();
const instanceId = crypto.randomUUID();

let appVersion = null;
function readVersion() {
  if (appVersion !== null) return appVersion;
  try {
    appVersion = fs.readFileSync(cfg.versionFile, 'utf8').trim();
  } catch {
    appVersion = '';
  }
  return appVersion;
}

// --- worker routing pool ("VPS memegang kendali worker") ------------------
const pool = createWorkerPool({ base: cfg.workerBase || WORKER_BASE_FALLBACK, log });

/** Routing-pool patch derived from the live cfg (deploy-target aware). */
function poolPatch() {
  const target = RT.deployTarget();
  const routingMax = Math.max(1, target > 0 ? target : cfg.poolMax);
  return {
    poolMax: routingMax,
    activeMin: cfg.activeMin,
    activeMax: cfg.activeMax > 0 ? cfg.activeMax : routingMax,
    scaleRate: cfg.scaleRate,
    shrinkRate: cfg.shrinkRate,
    idleShrinkMs: cfg.idleShrinkMs,
    probeIntervalMs: cfg.probeIntervalMs,
    workerBase: cfg.workerBase || WORKER_BASE_FALLBACK,
    workerUrls: cfg.workerUrls,
  };
}
pool.reconfigure(poolPatch());

// --- worker deployment sync (v1.5: .env → deployed pool, on the fly) -----
const workersync = createWorkerSync({ cfg, log });

/** Is the edge (worker) lane actually available to the front RIGHT NOW? */
const edgeAvailable = () => {
  // Legacy local-pool mode (tests/labs, explicit HYBRID_WORKER_URLS,
  // no Cloudflare deployment plane): assume the configured pool is
  // alive — the routing pool canaries it anyway.
  if (cfg.cf.mode === 'none' && !cfg.deployCountExplicit) return cfg.poolMax > 0 || cfg.workerUrls.length > 0;
  // Production: the deployment plane decides. 'error' (bad/expired
  // credentials, CF outage) degrades the front to the VPS lane until
  // the next successful sync — fixing .env re-enables hybrid on the fly.
  return workersync.status().mode === 'hybrid' && workersync.status().deployStatus !== 'error';
};

// --- token minting (format shared with hybrid/worker/src/token.ts) --------
// G-1: by default the token is NOT bound to a socket IP ('*'), so clients
// behind proxies/NAT or with v4↔v6 path asymmetry (IPv4 to the VPS, IPv6 to
// Cloudflare) are not rejected with ip-mismatch. Set HYBRID_TOKEN_BIND_IP=true
// to restore strict binding. v1.5: secret/TTL/bind are read LIVE from cfg —
// a shared-secret rotation applies to new mints immediately.
function mintToken(ip) {
  const guid = crypto.randomUUID();
  const expMs = Date.now() + cfg.tokenTtlMs;
  const tip = cfg.tokenBindIp ? ip : '*';
  const sig = crypto.createHmac('sha256', cfg.secret).update(`v1|${guid}|${expMs}|${tip}`).digest('hex');
  return { token: `v1~${guid}~${expMs}~${tip}~${sig}`, guid, expMs };
}

function verifyToken(token, ip) {
  if (!cfg.secret) return { ok: true, reason: 'open-mode' };
  if (!token) return { ok: false, reason: 'missing-token' };
  const parts = token.split('~');
  if (parts.length !== 5 || parts[0] !== 'v1') return { ok: false, reason: 'malformed' };
  const [v, guid, expStr, tip, sig] = parts;
  const expMs = Number(expStr);
  if (!Number.isFinite(expMs)) return { ok: false, reason: 'bad-exp' };
  const expect = crypto.createHmac('sha256', cfg.secret).update(`${v}|${guid}|${expStr}|${tip}`).digest('hex');
  // BUG FIX (kept): constant-time compare — plain !== short-circuits at the
  // first differing byte (signature comparison side channel).
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
  const minted = mintToken(cfg.tokenBindIp ? ip : '*');
  return { ...minted, worker };
}

function readBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve) => {
    // BUG FIX (kept): tear the socket down only after the response flushed —
    // destroying immediately sent the 413 into a dead socket (client saw RST).
    const chunks = [];
    let total = 0;
    let destroyed = false;
    req.on('data', (c) => {
      total += c.length;
      if (total > limitBytes) {
        if (!destroyed) {
          destroyed = true;
          resolve({ overLimit: true, body: null });
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
    'X-Hybrid-Gateway': '1.5',
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
  // G-3 / K-7 (kept): the STS /ws fallback is opt-in and OFF by default — no
  // mass fallback of throughput traffic to the VPS.
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

// G-9 (kept): result deduplication per guid — replays within the window get
// the identical response and are persisted once.
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
  // BUG FIX (kept): appendFileSync threw synchronously inside the async
  // handler on any I/O error (disk full / bad path) and killed the process.
  fs.appendFile(RESULTS_FILE, JSON.stringify(record) + '\n', (err) => {
    if (err) log('result_log_error', { error: String(err).slice(0, 200) });
  });
}

// Per-IP rate limit for /api/sessions (BUG FIX kept: unthrottled token
// fountain). v1.5: the rate itself is live-configurable (setMpm).
const sessionsLimiter = createRateLimiter(cfg.sessionsRateLimitMpm);

// --- the front router (v1.5: mutable options + vps-only fallback) ----------
const front = cfg.frontEnabled
  ? createFront({
      mintToken,
      log,
      counters,
      workerBase: cfg.workerBase || WORKER_BASE_FALLBACK,
      pool,
      rateLimitMpm: cfg.frontRateLimitMpm,
      maxDownBytes: cfg.frontMaxDownBytes,
      tokenTtlMs: cfg.tokenTtlMs,
      tokenCacheMs: cfg.frontTokenCacheMs,
      tokenBindIp: cfg.tokenBindIp,
      vpsDlShare: cfg.vpsDlShare,
      workersAvailable: edgeAvailable,
    })
  : null;

// Boot-time application of the live cfg (covers process-env-only configs
// where no .env file is watched).
applyLiveConfig();

/** Push the live cfg into every mutable component (start + every .env change). */
function applyLiveConfig() {
  sessionsLimiter.setMpm(cfg.sessionsRateLimitMpm);
  pool.reconfigure(poolPatch());
  if (front && front.setOptions) {
    front.setOptions({
      rateLimitMpm: cfg.frontRateLimitMpm,
      maxDownBytes: cfg.frontMaxDownBytes,
      tokenCacheMs: cfg.frontTokenCacheMs,
      vpsDlShare: cfg.vpsDlShare,
    });
  }
}

const requestHandler = async (req, res) => {
  // BUG FIX (kept, crash): a malformed Host header made the WHATWG URL
  // constructor throw synchronously inside the async handler → unhandled
  // rejection → process death (Node ≥15 default). Parse defensively.
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
    if (!cfg.secret) return json(res, 500, { error: 'HYBRID_SHARED_SECRET not configured' });
    // BUG FIX (kept): rate limit — this endpoint minted unlimited 5-minute
    // wildcard tokens, an easy account-quota burn vector.
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
    log('session_minted', { guid, ip, expMs, bound: cfg.tokenBindIp, workerId: worker.id });
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
    // BUG FIX (kept, verified crash): JSON.parse('null') returns null — the
    // old code dereferenced payload.token and killed the process.
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

  if (path === '/api/workers' && req.method === 'GET') {
    return json(res, 200, workersync.status());
  }

  if (path === '/api/health' && req.method === 'GET') {
    return json(res, 200, {
      server: 'hybrid-gateway/1.5',
      version: readVersion(),
      mode: cfg.frontEnabled ? (edgeAvailable() ? 'hybrid' : 'vps-only') : 'control-only',
      instanceId,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      counters,
      front: front
        ? {
            enabled: true,
            rateLimitMpm: cfg.frontRateLimitMpm,
            // v1.4+ assist lane: which download lane served what. NO bandwidth
            // budget exists: the VPS lane runs uncapped; share only
            // distributes requests between lanes.
            assist: {
              vpsDlShare: cfg.vpsDlShare,
              enabled: cfg.vpsDlShare > 0,
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
      workers: workersync.status(),
      env: {
        file: cfg.envFile || null,
        watching: RT.state.watching,
        lastChangeAt: RT.state.lastChangeAt ? new Date(RT.state.lastChangeAt).toISOString() : null,
        lastChangeKeys: RT.state.lastChangeKeys,
        lastError: RT.state.lastError,
      },
      config: { workerBase: cfg.workerBase || WORKER_BASE_FALLBACK, vpsBase: VPS_BASE, stsBase: STS_BASE, tokenTtlMs: cfg.tokenTtlMs, tokenBindIp: cfg.tokenBindIp, discoveryFallback: DISCOVERY_FALLBACK, tls: Boolean(TLS_CERT), resultsDedupMs: RESULTS_DEDUP_MS, secretConfigured: Boolean(cfg.secret), sessionsRateLimitMpm: cfg.sessionsRateLimitMpm },
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
  // BUG FIX (kept, process crash): Node does NOT catch rejections returned by
  // an async request listener — one bad request killed the whole control
  // plane (verified live). Every rejection is answered with a 500 and logged.
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

// BUG FIX (kept): an EADDRINUSE/EACCES on listen surfaced as an unhandled
// 'error' event → hard crash → systemd restart loop. Fail loudly ONCE.
listener.on('error', (e) => {
  console.error(JSON.stringify({ kind: 'gateway_error', error: String(e && e.code ? e.code : e).slice(0, 200), syscall: e && e.syscall, port: PORT, bind: BIND }));
  process.exit(1);
});

// Safety net: log any stray rejection instead of dying.
process.on('unhandledRejection', (e) => {
  log('unhandled_rejection', { error: String(e).slice(0, 200) });
});

// --- v1.5: .env hot-reload wiring -----------------------------------------
// Any change to the watched .env (worker count, pool bounds, share, front
// limits, credentials, secret) is applied LIVE; deployment-plane keys also
// trigger a worker-pool convergence.
RT.startEnvWatch((changedKeys) => {
  applyLiveConfig();
  const deploymentish = changedKeys.some((k) =>
    k.startsWith('CLOUDFLARE') || k.startsWith('CF_WORKER') || k === 'HYBRID_SHARED_SECRET' || k === 'HYBRID_WORKER_URLS',
  );
  if (deploymentish) {
    workersync
      .sync()
      .then(() => pool.reconfigure(poolPatch()))
      .catch((e) => log('worker_sync_error', { error: String(e).slice(0, 160) }));
  }
});

// --- v1.5: initial deployment convergence (non-blocking) ------------------
if (cfg.envFile || cfg.workerSyncIntervalMs > 0) {
  workersync
    .sync()
    .then((r) => {
      pool.reconfigure(poolPatch());
      log('worker_sync_initial', r);
    })
    .catch((e) => log('worker_sync_initial_error', { error: String(e).slice(0, 160) }));
}

listener.listen(PORT, BIND, () => {
  console.log(JSON.stringify({
    kind: 'gateway_started',
    version: readVersion(),
    server: 'hybrid-gateway/1.5',
    port: PORT,
    bind: BIND,
    tls: Boolean(TLS_CERT),
    mode: cfg.frontEnabled ? (edgeAvailable() ? 'hybrid' : 'vps-only') : 'control-only',
    deployTarget: RT.deployTarget(),
    front: cfg.frontEnabled,
    frontRateLimitMpm: cfg.frontRateLimitMpm,
    frontTokenCacheMs: cfg.frontTokenCacheMs,
    vpsDlShare: cfg.vpsDlShare,
    workerBase: cfg.workerBase || WORKER_BASE_FALLBACK,
    workerPoolMax: pool.poolMax,
    vpsBase: VPS_BASE,
    stsBase: STS_BASE,
    tokenTtlMs: cfg.tokenTtlMs,
    tokenBindIp: cfg.tokenBindIp,
    discoveryFallback: DISCOVERY_FALLBACK,
    envFile: cfg.envFile || null,
    secretConfigured: Boolean(cfg.secret),
  }));
});

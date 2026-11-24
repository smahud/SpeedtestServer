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
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createFront } from './front.mjs';

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

// --- speedtest front (legacy HTTP surface with edge offload) ---
const FRONT_ENABLED = String(process.env.HYBRID_FRONT_ENABLED || '') === 'true';
const FRONT_RATE_LIMIT_MPM = Number(process.env.HYBRID_FRONT_RATE_LIMIT_MPM ?? 90);
const FRONT_MAX_DOWN_BYTES = Number(process.env.HYBRID_FRONT_MAX_DOWN_BYTES ?? 26214400);

// Evidence counters — how many control-plane bytes the VPS actually served.
const counters = { servers: 0, sessions: 0, results: 0, pings: 0, bytesIn: 0, bytesOut: 0 };

const startedAt = Date.now();
const instanceId = crypto.randomUUID();

function log(kind, detail = {}) {
  console.log(JSON.stringify({ ts: Date.now(), kind, ...detail }));
}

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
  if (expect !== sig) return { ok: false, reason: 'bad-signature' };
  if (Date.now() > expMs) return { ok: false, reason: 'expired' };
  if (tip !== '*' && ip && tip !== ip) return { ok: false, reason: 'ip-mismatch' };
  return { ok: true, guid };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > 1024 * 1024) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2));
  counters.bytesOut += body.length;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'Cache-Control': 'no-store, no-transform',
    'X-Hybrid-Gateway': '1.1',
  });
  res.end(body);
}

// --- the discovery document: the role split of the hybrid architecture -----
function serversDocument() {
  const throughput = {
    primary: { url: `${WORKER_BASE}/ws`, transport: 'wss-netgauge', description: 'NetGauge over WebSocket at the edge' },
    http: { url: `${WORKER_BASE}/__down`, upload: `${WORKER_BASE}/__up`, transport: 'http-streaming' },
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
        edgeTtfb: `${WORKER_BASE}/__down?bytes=0`,
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

// The front router (only when enabled). Shares mintToken/counters/logging.
const front = FRONT_ENABLED
  ? createFront({ mintToken, log, counters, workerBase: WORKER_BASE, rateLimitMpm: FRONT_RATE_LIMIT_MPM, maxDownBytes: FRONT_MAX_DOWN_BYTES })
  : null;

const requestHandler = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
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

  const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : null;
  if (body) counters.bytesIn += body.length;
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/api/servers' && req.method === 'GET') {
    counters.servers++;
    return json(res, 200, serversDocument());
  }

  if (path === '/api/sessions' && req.method === 'POST') {
    if (!SECRET) return json(res, 500, { error: 'HYBRID_SHARED_SECRET not configured' });
    counters.sessions++;
    const { token, guid, expMs } = mintToken(ip);
    log('session_minted', { guid, ip, expMs, bound: TOKEN_BIND_IP });
    return json(res, 200, { token, guid, expiresAt: new Date(expMs).toISOString(), endpoints: serversDocument().roles });
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
    const v = verifyToken(payload.token, ip);
    if (!v.ok) return json(res, 401, { error: 'unauthorized', reason: v.reason });
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
    if (RESULTS_FILE) {
      fs.appendFileSync(RESULTS_FILE, JSON.stringify(record) + '\n');
    }
    return json(res, 200, response);
  }

  if (path === '/api/health' && req.method === 'GET') {
    return json(res, 200, {
      server: 'hybrid-gateway/1.1',
      instanceId,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      counters,
      front: front
        ? {
            enabled: true,
            rateLimitMpm: FRONT_RATE_LIMIT_MPM,
            counters: {
              latency: counters.frontLatency || 0,
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
      config: { workerBase: WORKER_BASE, vpsBase: VPS_BASE, stsBase: STS_BASE, tokenTtlMs: TTL_MS, tokenBindIp: TOKEN_BIND_IP, discoveryFallback: DISCOVERY_FALLBACK, tls: Boolean(TLS_CERT), resultsDedupMs: RESULTS_DEDUP_MS, secretConfigured: Boolean(SECRET) },
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
const listener = TLS_CERT
  ? https.createServer(
      { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY), minVersion: 'TLSv1.2' },
      requestHandler,
    )
  : http.createServer(requestHandler);

listener.listen(PORT, BIND, () => {
  console.log(JSON.stringify({
    kind: 'gateway_started',
    port: PORT,
    bind: BIND,
    tls: Boolean(TLS_CERT),
    front: FRONT_ENABLED,
    frontRateLimitMpm: FRONT_RATE_LIMIT_MPM,
    workerBase: WORKER_BASE,
    vpsBase: VPS_BASE,
    stsBase: STS_BASE,
    tokenTtlMs: TTL_MS,
    tokenBindIp: TOKEN_BIND_IP,
    discoveryFallback: DISCOVERY_FALLBACK,
    secretConfigured: Boolean(SECRET),
  }));
});


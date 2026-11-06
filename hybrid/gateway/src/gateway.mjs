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
 * Zero dependencies: node:http + node:crypto only.
 *
 * Env:
 *   HYBRID_GATEWAY_PORT       default 8090
 *   HYBRID_SHARED_SECRET      HMAC secret (same value as the Worker secret)
 *   HYBRID_WORKER_BASE        default http://127.0.0.1:8790 (edge stand-in)
 *   HYBRID_VPS_PUBLIC_BASE    default http://127.0.0.1:8090 (this gateway)
 *   HYBRID_STS_BASE           default http://127.0.0.1:8080 (SpeedtestServer)
 *   HYBRID_TOKEN_TTL_MS       default 600000 (10 min)
 *   HYBRID_RESULTS_FILE       optional JSONL result log
 */

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.HYBRID_GATEWAY_PORT || 8090);
const SECRET = process.env.HYBRID_SHARED_SECRET || '';
const WORKER_BASE = process.env.HYBRID_WORKER_BASE || 'http://127.0.0.1:8790';
const VPS_BASE = process.env.HYBRID_VPS_PUBLIC_BASE || 'http://127.0.0.1:8090';
const STS_BASE = process.env.HYBRID_STS_BASE || 'http://127.0.0.1:8080';
const TTL_MS = Number(process.env.HYBRID_TOKEN_TTL_MS || 600000);
const RESULTS_FILE = process.env.HYBRID_RESULTS_FILE || '';

// Evidence counters — how many control-plane bytes the VPS actually served.
const counters = { servers: 0, sessions: 0, results: 0, pings: 0, bytesIn: 0, bytesOut: 0 };

const startedAt = Date.now();
const instanceId = crypto.randomUUID();

function log(kind, detail = {}) {
  console.log(JSON.stringify({ ts: Date.now(), kind, ...detail }));
}

// --- token minting (format shared with hybrid/worker/src/token.ts) --------
function mintToken(ip) {
  const guid = crypto.randomUUID();
  const expMs = Date.now() + TTL_MS;
  const sig = crypto.createHmac('sha256', SECRET).update(`v1|${guid}|${expMs}|${ip}`).digest('hex');
  return { token: `v1~${guid}~${expMs}~${ip}~${sig}`, guid, expMs };
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
    'Cache-Control': 'no-store',
    'X-Hybrid-Gateway': '1.0',
  });
  res.end(body);
}

// --- the discovery document: the role split of the hybrid architecture ---
function serversDocument() {
  return {
    version: 1,
    issuedAt: new Date().toISOString(),
    roles: {
      control: { url: VPS_BASE, description: 'discovery, session tokens, result intake' },
      latency: {
        vpsTtfb: `${VPS_BASE}/api/ping`,
        vpsUdpLoss: `${STS_BASE.replace(/^https?:\/\//, '')} (NetGauge UDP LOSS/RECV via SpeedtestServer)`,
        edgeTtfb: `${WORKER_BASE}/__down?bytes=0`,
        description: 'UDP jitter/loss and stable-identity latency stay on the VPS; edge TTFB is a comparative metric',
      },
      throughput: {
        primary: { url: `${WORKER_BASE}/ws`, transport: 'wss-netgauge', description: 'NetGauge over WebSocket at the edge' },
        http: { url: `${WORKER_BASE}/__down`, upload: `${WORKER_BASE}/__up`, transport: 'http-streaming' },
        fallback: { url: `${STS_BASE}/ws`, transport: 'ws-netgauge', description: 'VPS fallback when the edge is unavailable' },
      },
    },
    notes: 'Official Ookla CLI clients: use the VPS NetGauge TCP endpoint (SpeedtestServer :8080) — the CLI cannot speak HTTP/WebSocket transports.',
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let ip = req.socket.remoteAddress || '127.0.0.1';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // normalize IPv4-mapped IPv6
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
    log('session_minted', { guid, ip, expMs });
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
    counters.results++;
    const record = {
      receivedAt: new Date().toISOString(),
      guid: v.guid || payload.guid || null,
      ip,
      metrics: payload.metrics || {},
      accounting: payload.accounting || {},
      client: payload.client || {},
    };
    log('result_accepted', { guid: record.guid, ip });
    if (RESULTS_FILE) {
      const fs = await import('node:fs');
      fs.appendFileSync(RESULTS_FILE, JSON.stringify(record) + '\n');
    }
    return json(res, 200, { ok: true, guid: record.guid });
  }

  if (path === '/api/health' && req.method === 'GET') {
    return json(res, 200, {
      server: 'hybrid-gateway/1.0',
      instanceId,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      counters,
      config: { workerBase: WORKER_BASE, vpsBase: VPS_BASE, stsBase: STS_BASE, tokenTtlMs: TTL_MS, secretConfigured: Boolean(SECRET) },
    });
  }

  return json(res, 404, { error: 'not found', path });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({ kind: 'gateway_started', port: PORT, workerBase: WORKER_BASE, vpsBase: VPS_BASE, stsBase: STS_BASE, secretConfigured: Boolean(SECRET) }));
});

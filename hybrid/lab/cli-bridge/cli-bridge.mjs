#!/usr/bin/env node
/**
 * cli-bridge.mjs — the official-CLI native lane bridge: VPS front + Worker
 * payload (cli-bridge v1, 2026-11-27).
 *
 * WHAT THIS IS
 *   The unmodified official Ookla Speedtest CLI speaks the native NetGauge
 *   protocol (TCP :8080 + UDP loss) and has no edge transport — the 26–27
 *   Nov 2026 audit verdict for it is NATIVE_VPS_ONLY (BLOCKED_BY_PROTOCOL +
 *   BLOCKED_BY_FREE_PLAN for a DIRECT edge path). This bridge is the
 *   explicitly-labeled follow-up experiment: the VPS TERMINATES the native
 *   protocol exactly like the daemon (control + identity + loss plane stay
 *   on the VPS), while the measurement payload is ORIGINATED BY THE
 *   CLOUDFLARE WORKER and relayed through the VPS:
 *
 *     official CLI --NetGauge TCP/UDP--> cli-bridge :8080 (VPS)
 *       control:  HI/HELLO, GETIP, PING, CAPABILITIES, INITPLOSS/PLOSS,
 *                 UDP LOSS → served LOCALLY (daemon-parity semantics,
 *                 validation/PROTOCOL_CONTRACT.md §2–3)
 *       download: pool bytes ← Worker /__down (chunked, streamed with real
 *                 HTTP backpressure) or Worker /ws NetGauge (chunked
 *                 commands with the per-command framing stripped)
 *       upload:   payload → Worker /__up (chunked POSTs, {bytes:N} receipts)
 *                 or /ws frames (worker "OK n <ts>" ack = receipt)
 *
 *   HONEST LABEL: this is edge-ORIGIN payload with VPS RELAY. Every bridged
 *   byte still transits the VPS link (no single-session capacity gain); a
 *   DIRECT (non-relay) edge path for the official CLI remains blocked per
 *   the audit. Per-lane byte attribution is logged to JSONL.
 *
 * PROTOCOL PARITY (front) — faithful port of the verified daemon semantics
 *   (engine reference: reverse-engineered/typescript/src/server/NetGaugeEngine.ts):
 *   HI/HELLO (+uuid session), strict GETIP + pre-session gate (mute), three
 *   strikes (F-24), CAPABILITIES/SERVERID/UPTIME/PING/INITPLOSS/PLOSS/
 *   UPLOAD_STATS, DOWNLOAD n byte-exact ("DOWNLOAD " prefix + pool +
 *   trailing "\n", all counted in n, F-9), UPLOAD n inclusive counting +
 *   "OK n <epoch-ms>", QUIT closes, unknown/encrypted-binary hello → ERROR
 *   (drives the CLI's documented plaintext fallback), UDP LOSS init form
 *   (counted, no reply) / loaded-latency form (counted + "RECV ..." reply),
 *   PLOSS stats line, bounded loss registry (F-33 port).
 *
 * BACKENDS (BRIDGE_BACKEND)
 *   worker-http (default, recommended) — chunked /__down streaming (real
 *     HTTP backpressure: the Worker only generates what the bridge drains)
 *     + chunked /__up POSTs with receipts. Validated under the CLI's own
 *     connection pattern on the live worker (32×32 MiB: 32/32 DL +
 *     32/32 UL, 0 errors, 2026-11-27).
 *   worker-ws — one NetGauge WSS session per CLI connection; DOWNLOAD
 *     relayed as chunked DOWNLOAD commands with the framing stripped
 *     (byte stream stays daemon-parity) so per-command in-flight bytes
 *     stay bounded: unpaced single-command 32 MiB relays get
 *     exceededResources-killed under the CLI's 32-connection pattern
 *     (reproduced 2026-11-27: 10/32 sessions died mid-stream). UPLOAD
 *     payload forwarded as WS frames; the worker's "OK n <ts>" ack is the
 *     receipt.
 *   local — daemon-parity pool served by the VPS itself (front control
 *     lane: A/B baseline against the worker lanes).
 *
 * USAGE (VPS, during an experiment window; the daemon must not hold :8080)
 *   BRIDGE_BACKEND=worker-http node hybrid/lab/cli-bridge/cli-bridge.mjs \
 *     --port 8080 --log /var/lib/cli-bridge/cli-bridge.jsonl
 *   Token: minted from the hybrid gateway (BRIDGE_GATEWAY_BASE, default
 *   https://127.0.0.1:8790) or fixed via BRIDGE_TOKEN + BRIDGE_WORKER_BASE.
 *
 * Env (BRIDGE_*): see README.md. Zero dependencies (node:net/dgram/tls/
 * http(s)/crypto/fs/path + the global WebSocket client).
 */

import net from 'node:net';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- config
const cfg = {
  port: 8080,
  backend: (process.env.BRIDGE_BACKEND || 'worker-http').toLowerCase(),
  gatewayBase: process.env.BRIDGE_GATEWAY_BASE || 'https://127.0.0.1:8790',
  workerBase: process.env.BRIDGE_WORKER_BASE || '',
  token: process.env.BRIDGE_TOKEN || '',
  log: path.join(process.cwd(), 'cli-bridge.jsonl'),
  idleMs: Number(process.env.BRIDGE_IDLE_MS || 3600000), // daemon maxConnectionSeconds parity
  maxConnPerIp: Number(process.env.BRIDGE_MAX_CONN_PER_IP || 500),
  maxLineBytes: 1024 * 1024,
  maxDownloadBytes: Number(process.env.BRIDGE_MAX_DL_BYTES || 128 * 1024 * 1024),
  maxUploadBytes: Number(process.env.BRIDGE_MAX_UL_BYTES || 128 * 1024 * 1024),
  httpChunk: Number(process.env.BRIDGE_HTTP_CHUNK || 4 * 1024 * 1024),
  ulChunk: Number(process.env.BRIDGE_UL_CHUNK || 4 * 1024 * 1024),
  ulInFlight: Number(process.env.BRIDGE_UL_INFLIGHT || 2),
  wsChunk: Number(process.env.BRIDGE_WS_CHUNK || 1024 * 1024),
  wsPaceMs: Number(process.env.BRIDGE_WS_PACE_MS ?? 0),
  localChunk: 512 * 1024,
  versionString: process.env.BRIDGE_VERSION_STRING || '2.11 (2.11.5) 2026-06-04.1737.7d0993d',
  instanceUuid: crypto.randomUUID(), // lower-case, daemon parity
  startedAt: Date.now(),
};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (t === '--port') cfg.port = +process.argv[++i];
  else if (t === '--backend') cfg.backend = process.argv[++i].toLowerCase();
  else if (t === '--log') cfg.log = process.argv[++i];
  else if (t === '--gateway') cfg.gatewayBase = process.argv[++i];
  else if (t === '--worker') cfg.workerBase = process.argv[++i];
}
fs.mkdirSync(path.dirname(cfg.log), { recursive: true });
const LOG = fs.createWriteStream(cfg.log, { flags: 'w' });
const t0hr = process.hrtime.bigint();
const relMs = () => Number((process.hrtime.bigint() - t0hr) / 1000000n);
function log(o) { o.ts = Date.now(); o.rt = relMs(); LOG.write(JSON.stringify(o) + '\n'); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DOWNLOAD_PREFIX = 'DOWNLOAD ';
const counters = {
  conns: 0, closed: 0, rejected: 0,
  downloads: 0, uploads: 0,
  bytesDownCli: 0, bytesUpCli: 0,
  bytesFromWorkerDl: 0, bytesToWorkerUl: 0, bytesLocalDl: 0,
  workerRequests: 0, workerErrors: 0, workerReceipts: 0,
};

// ---------------------------------------------------------------- loss registry
// Bounded port of the daemon LossRegistry (F-33): per-IP fairness, LRU
// eviction, auto-registration of client-supplied UUIDs.
function normIp(ip) {
  if (!ip) return ip;
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}
const loss = {
  sessions: new Map(), // uuid -> {uuid, clientIp, count, dupes, maxSeq, lastSeen}
  perIp: new Map(),
  maxSessions: 2048, maxPerIp: 64,
  ensure(uuid, clientIp) {
    let s = this.sessions.get(uuid);
    if (s) { this.sessions.delete(uuid); this.sessions.set(uuid, s); return s; }
    const ip = normIp(clientIp);
    if ((this.perIp.get(ip) || 0) >= this.maxPerIp) this.evictForIp(ip);
    if (this.sessions.size >= this.maxSessions) {
      const first = this.sessions.keys().next().value;
      if (first !== undefined) this.remove(this.sessions.get(first));
    }
    s = { uuid, clientIp: ip, count: 0, dupes: 0, maxSeq: -1, lastSeen: Date.now() };
    this.sessions.set(uuid, s);
    this.perIp.set(ip, (this.perIp.get(ip) || 0) + 1);
    return s;
  },
  remove(s) {
    this.sessions.delete(s.uuid);
    const n = this.perIp.get(s.clientIp) || 0;
    if (n <= 1) this.perIp.delete(s.clientIp); else this.perIp.set(s.clientIp, n - 1);
  },
  evictForIp(ip) {
    for (const s of this.sessions.values()) if (s.clientIp === ip) { this.remove(s); return; }
  },
  record(uuid, clientIp, seq, clientTimer) {
    const s = this.ensure(uuid, clientIp);
    if (s.clientIp !== normIp(clientIp)) return null; // anti-spoof, daemon parity
    s.lastSeen = Date.now();
    if (seq <= s.maxSeq) s.dupes++; else s.maxSeq = seq;
    s.count++;
    return clientTimer === undefined ? null : `RECV ${seq} ${clientTimer} [${s.count} ${seq} ${s.dupes}]`;
  },
  statsLine() {
    let last = null;
    for (const s of this.sessions.values()) last = s;
    if (!last) return 'PLOSS 0 0 0';
    return `PLOSS ${last.count} ${last.dupes} ${Math.max(0, last.maxSeq)}`;
  },
};

// ---------------------------------------------------------------- token mint
const tokenMgr = {
  cached: null, inflight: null, cooldownUntil: 0,
  async get() {
    if (cfg.token) return { token: cfg.token, workerBase: cfg.workerBase || null, expMs: Infinity };
    const now = Date.now();
    if (this.cached && this.cached.expMs - 60000 > now) return this.cached;
    // Mint backoff: a failed mint (429 rate-limited / network) must not
    // hammer the gateway — every connection's first measurement would
    // otherwise re-mint (92 mints observed run b2-wh-2 → gateway 429 →
    // CLI connection aborts). One shared token serves ALL connections.
    if (now < this.cooldownUntil) throw new Error(`mint cooling down (${Math.ceil((this.cooldownUntil - now) / 1000)}s)`);
    if (!this.inflight) {
      this.inflight = this.mint()
        .then((t) => { this.cached = t; return t; })
        .catch((e) => { this.cooldownUntil = Date.now() + 5000; throw e; })
        .finally(() => { this.inflight = null; });
    }
    return this.inflight;
  },
  mint() {
    return new Promise((resolve, reject) => {
      const u = new URL(cfg.gatewayBase.replace(/\/+$/, '') + '/api/sessions');
      if (u.protocol !== 'https:') return reject(new Error('gateway must be https'));
      const req = https.request(
        { hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': '2', 'User-Agent': 'cli-bridge/1.0' },
          rejectUnauthorized: false, timeout: 10000 },
        (res) => {
          let b = '';
          res.on('data', (c) => { b += c; });
          res.on('end', () => {
            try {
              const d = JSON.parse(b);
              if (res.statusCode !== 200 || !d.token) throw new Error(`mint ${res.statusCode}: ${b.slice(0, 120)}`);
              resolve({ token: d.token, workerBase: d.worker ? d.worker.url : null, expMs: Date.parse(d.expiresAt) || Infinity });
            } catch (e) { reject(e); }
          });
        });
      req.on('timeout', () => req.destroy(new Error('mint timeout')));
      req.on('error', reject);
      req.end('{}');
    });
  },
};

// ---------------------------------------------------------------- http helper
function isHttp(base) { return base.startsWith('http://'); }
async function httpJson(method, urlStr, headers, body, timeoutMs = 120000, agent = undefined) {
  const u = new URL(urlStr);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method,
        headers, rejectUnauthorized: false, timeout: timeoutMs, agent },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

// ---------------------------------------------------------------- backends
// Per-CLI-connection interface:
//   download(poolBytes, emit) — emit exactly poolBytes pool bytes via emit(buf)
//   uploadStart(n)            — begin an upload (n = declared total)
//   uploadFeed(buf)          — forward payload bytes (may buffer)
//   uploadEnd()              — finish; returns {receipts, errors} (async ok)
//   close()                  — best-effort teardown on connection close
//   name                     — JSONL lane label

/** local — the daemon-parity pool served by the VPS (control lane). */
function makeLocalBackend(connId) {
  const POOL = 2 * 1024 * 1024;
  const pool = new Uint8Array(POOL);
  const MAP = new Uint8Array(256);
  for (let i = 0; i < 256; i++) MAP[i] = 32 + (i % 96);
  const rnd = new Uint8Array(POOL);
  for (let off = 0; off < POOL; off += 65536) { // getRandomValues 65 536-byte limit
    crypto.getRandomValues(rnd.subarray(off, Math.min(off + 65536, POOL)));
  }
  for (let i = 0; i < POOL; i++) pool[i] = MAP[rnd[i]];
  let downloads = 0;
  return {
    name: 'local',
    async download(n, emit) {
      const phase = (n + downloads++) % POOL;
      let off = 0;
      while (off < n) {
        const len = Math.min(cfg.localChunk, n - off);
        const chunk = Buffer.allocUnsafe(len);
        let p = (phase + off) % POOL;
        for (let done = 0; done < len; ) {
          const take = Math.min(POOL - p, len - done);
          chunk.set(pool.subarray(p, p + take), done);
          p = (p + take) % POOL;
          done += take;
        }
        await emit(chunk);
        off += len;
      }
      counters.bytesLocalDl += n;
    },
    async uploadStart() {}, async uploadFeed() {},
    async uploadEnd() { return { receipts: 0, errors: 0 }; },
    async close() {},
  };
}

/** worker-http — chunked /__down streaming + chunked /__up POSTs. */
function makeWorkerHttpBackend(connId) {
  let workerBase = null;
  let dlChunks = 0, ulPosts = 0, ulInFlight = 0, ulErrors = 0, wake = null;
  let receipts = [];
  // Persistent between uploadFeed calls: the CLI socket delivers the payload
  // in ~64 KiB TCP chunks — accumulation MUST span feeds (a per-call buffer
  // dropped everything but the last chunk; fixed 2026-11-27 after run
  // b2-wh-1 relayed only 55 478 of 181 873 801 upload bytes).
  let pending = null;
  // keep-alive agent: CF closes idle connections aggressively; combined with
  // the retry below this is both fast and resilient (47 ECONNRESET observed
  // 2026-11-27 run b2-wh-1 before this).
  const agentOpts = { keepAlive: true, keepAliveMsecs: 1000, maxSockets: 128, scheduling: 'lifo' };
  const agentHttps = new https.Agent(agentOpts);
  const agentHttp = new http.Agent(agentOpts);
  const RETRY_ERRORS = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED']);
  async function base() {
    const t = await tokenMgr.get();
    workerBase = (t.workerBase || cfg.workerBase || workerBase || '').replace(/\/+$/, '');
    if (!workerBase) throw new Error('no worker base (gateway mint or BRIDGE_WORKER_BASE)');
    return t.token;
  }
  function kick() { if (wake) { const r = wake; wake = null; r(); } }
  async function postUp(body, token) {
    // In-flight accounting lives in postUpTracked (single increment per
    // tracked slot; the retry loop below re-attempts within the same slot).
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await httpJson('POST', workerBase + '/__up',
          { Authorization: `Bearer ${token}`, 'Content-Length': String(body.length), 'User-Agent': 'cli-bridge/1.0' },
          body, 120000, workerBase.startsWith('http://') ? agentHttp : agentHttps);
        counters.workerRequests++;
        if (r.status !== 200) throw new Error(`__up ${r.status}`);
        const j = JSON.parse(r.body.toString('utf8'));
        if (j.bytes !== body.length) throw new Error(`receipt ${j.bytes} != ${body.length}`);
        receipts.push(j.bytes);
        counters.workerReceipts++;
        counters.bytesToWorkerUl += body.length;
        ulPosts++;
        return;
      } catch (e) {
        const code = String((e && e.code) || e.message || e);
        if (attempt < 3 && (RETRY_ERRORS.has(code) || /hang up|reset/.test(code))) {
          log({ k: 'worker_retry', conn: connId, lane: 'up', attempt, error: code });
          await sleep(150);
          continue;
        }
        throw e;
      } finally { /* in-flight released by caller wrapper */ }
    }
  }
  async function getDown(want, token) {
    // Idempotent GET: retry once on connection-reset class errors with a
    // fresh request (keep-alive reuse races with CF edge idle closes).
    for (let attempt = 1; ; attempt++) {
      try {
        const u = new URL(workerBase + `/__down?bytes=${want}`);
        const mod = u.protocol === 'https:' ? https : http;
        return await new Promise((resolve, reject) => {
          const req = mod.request(
            { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
              path: u.pathname + u.search, method: 'GET',
              headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'cli-bridge/1.0' },
              rejectUnauthorized: false, timeout: 60000,
              agent: u.protocol === 'https:' ? agentHttps : agentHttp },
            resolve);
          req.on('timeout', () => req.destroy(new Error('down timeout')));
          req.on('error', reject);
          req.end();
        });
      } catch (e) {
        const code = String((e && e.code) || e.message || e);
        if (attempt < 3 && (RETRY_ERRORS.has(code) || /hang up|reset/.test(code))) {
          log({ k: 'worker_retry', conn: connId, lane: 'down', attempt, error: code });
          await sleep(150);
          continue;
        }
        throw e;
      }
    }
  }
  async function postUpTracked(body, token) {
    ulInFlight++;
    try { await postUp(body, token); }
    catch (e) {
      ulErrors++; counters.workerErrors++;
      log({ k: 'worker_err', conn: connId, lane: 'up', error: String(e.message || e) });
    } finally { ulInFlight--; kick(); }
  }
  return {
    name: 'worker-http',
    async download(n, emit) {
      const token = await base();
      let off = 0;
      while (off < n) {
        const want = Math.min(cfg.httpChunk, n - off);
        const t0 = Date.now();
        const res = await getDown(want, token);
        if (res.statusCode !== 200) {
          res.resume();
          throw new Error(`__down ${res.statusCode}`);
        }
        counters.workerRequests++;
        // async iteration = real backpressure: the worker only generates
        // what this loop drains (emit awaits the CLI socket drain).
        for await (const c of res) {
          counters.bytesFromWorkerDl += c.length;
          await emit(c);
        }
        dlChunks++;
        log({ k: 'worker_chunk_dl', conn: connId, bytes: want, chunks: dlChunks, ms: Date.now() - t0 });
        off += want;
      }
    },
    async uploadStart() { receipts = []; ulPosts = 0; ulErrors = 0; pending = null; },
    async uploadFeed(buf) {
      // ACCUMULATE across feeds, then POST ulChunk-sized bodies with bounded
      // in-flight (the CLI's send rate is not throttled by edge RTT).
      pending = pending ? Buffer.concat([pending, buf]) : buf;
      while (pending.length >= cfg.ulChunk) {
        const body = pending.subarray(0, cfg.ulChunk);
        pending = pending.subarray(cfg.ulChunk);
        while (ulInFlight >= cfg.ulInFlight) await new Promise((r) => { wake = r; });
        const token = await base();
        void postUpTracked(body, token);
      }
    },
    async uploadEnd() {
      const rest = pending;
      pending = null;
      if (rest && rest.length) {
        while (ulInFlight >= cfg.ulInFlight) await new Promise((r) => { wake = r; });
        const token = await base();
        await postUpTracked(rest, token);
      }
      while (ulInFlight > 0) await new Promise((r) => setTimeout(r, 20));
      return { receipts: receipts.length, posts: ulPosts, errors: ulErrors };
    },
    async close() {
      // Per-connection teardown must NOT destroy the shared agents — in-flight
      // POSTs continue; their receipts/errors land in the log.
    },
  };
}

/** worker-ws — one NetGauge WSS session per CLI connection (chunked
 *  DOWNLOAD commands, framing stripped; UPLOAD forwarded as frames). */
function makeWorkerWsBackend(connId) {
  let ws = null, workerBase = null, opening = null, closedByWorker = false;
  const waiters = [];
  const queue = [];
  let acks = 0, dlCommands = 0;

  async function session() {
    if (ws && ws.readyState === WebSocket.OPEN) return ws;
    if (closedByWorker) throw new Error('worker ws closed');
    if (!opening) opening = open().finally(() => { opening = null; });
    return opening;
  }
  async function open() {
    const t = await tokenMgr.get();
    workerBase = (t.workerBase || cfg.workerBase || '').replace(/\/+$/, '');
    if (!workerBase) throw new Error('no worker base');
    const u = new URL(workerBase.replace(/^http/, 'ws') + '/ws');
    u.searchParams.set('token', t.token);
    if (cfg.wsPaceMs > 0) u.searchParams.set('pace', String(cfg.wsPaceMs));
    return new Promise((resolve, reject) => {
      const s = new WebSocket(u);
      s.binaryType = 'arraybuffer';
      const to = setTimeout(() => { try { s.close(); } catch {} reject(new Error('ws open timeout')); }, 15000);
      s.addEventListener('open', () => { clearTimeout(to); ws = s; resolve(s); });
      s.addEventListener('error', () => { clearTimeout(to); reject(new Error('ws open error')); });
      s.addEventListener('close', () => {
        closedByWorker = true; ws = null;
        for (const w of waiters.splice(0)) w.reject(new Error('ws closed mid-session'));
      });
      s.addEventListener('message', (ev) => {
        const item = typeof ev.data === 'string' ? { text: ev.data } : { bin: new Uint8Array(ev.data) };
        if (waiters.length) waiters.shift().resolve(item);
        else queue.push(item);
      });
    });
  }
  function nextMsg(timeoutMs, what) {
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      const t = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i !== -1) waiters.splice(i, 1);
        reject(new Error(what + ' timeout'));
      }, timeoutMs);
      w.resolve = (x) => { clearTimeout(t); resolve(x); };
      w.reject = (e) => { clearTimeout(t); reject(e); };
      if (queue.length) { clearTimeout(t); resolve(queue.shift()); }
      else waiters.push(w);
    });
  }
  return {
    name: 'worker-ws',
    async download(n, emit) {
      // n = pure pool bytes wanted. Each worker DOWNLOAD k answers
      // "DOWNLOAD " + (k-10) pool bytes + "\n" — the framing (9-byte prefix
      // + trailing "\n") is stripped, so the emitted stream is pure pool.
      const sizes = [];
      if (n > 0) {
        const full = Math.floor(n / cfg.wsChunk);
        let rem = n - full * cfg.wsChunk;
        for (let i = 0; i < full; i++) sizes.push(cfg.wsChunk);
        if (rem > 0) {
          if (sizes.length && rem < 64 * 1024) sizes[sizes.length - 1] += rem;
          else sizes.push(rem);
        }
      }
      for (const poolBytes of sizes) {
        const k = poolBytes + 10; // worker command total (framing inclusive)
        dlCommands++;
        const s = await session();
        s.send(`DOWNLOAD ${k}`);
        let received = 0, skipped = 0;
        const needSkip = 9;
        while (received < k) {
          const item = await nextMsg(30000, `ws download stall at ${received}/${k}`);
          if (item.text !== undefined) throw new Error('unexpected text frame during download: ' + JSON.stringify(item.text.slice(0, 60)));
          let buf = item.bin;
          received += buf.length;
          counters.bytesFromWorkerDl += buf.length;
          let emitBuf = buf;
          if (skipped < needSkip) {
            const skip = Math.min(needSkip - skipped, emitBuf.length);
            emitBuf = emitBuf.subarray(skip);
            skipped += skip;
          }
          if (received >= k && emitBuf.length > 0) emitBuf = emitBuf.subarray(0, emitBuf.length - 1); // strip trailing "\n"
          if (emitBuf.length > 0) await emit(emitBuf);
        }
        counters.workerRequests++;
      }
    },
    async uploadStart() { acks = 0; },
    async uploadFeed(buf) {
      const s = await session();
      for (let off = 0; off < buf.length; off += 64 * 1024) {
        s.send(buf.subarray(off, Math.min(off + 64 * 1024, buf.length)));
      }
      counters.bytesToWorkerUl += buf.length;
    },
    async uploadEnd() {
      // The worker's "OK n <ts>" ack is the receipt; the FRONT already
      // answered the CLI (daemon parity: OK right after consuming n).
      try {
        const item = await nextMsg(60000, 'ws upload ack');
        const text = (item.text ?? '').trim();
        if (/^OK \d+ \d+$/.test(text)) { acks++; counters.workerReceipts++; return { receipts: acks, errors: 0 }; }
        return { receipts: acks, errors: 1 };
      } catch (e) {
        counters.workerErrors++;
        log({ k: 'worker_err', conn: connId, lane: 'up-ack', error: String(e.message || e) });
        return { receipts: acks, errors: 1 };
      }
    },
    async close() {
      try { if (ws) ws.close(1000, 'conn-close'); } catch { /* noop */ }
    },
  };
}

function makeBackend(connId) {
  if (cfg.backend === 'local') return makeLocalBackend(connId);
  if (cfg.backend === 'worker-ws') return makeWorkerWsBackend(connId);
  if (cfg.backend === 'worker-http') return makeWorkerHttpBackend(connId);
  throw new Error('unknown BRIDGE_BACKEND: ' + cfg.backend);
}

// ---------------------------------------------------------------- TCP front
const perIpConns = new Map();

function handleConn(sock) {
  const id = ++counters.conns;
  const peer = `${sock.remoteAddress}:${sock.remotePort}`;
  const peerIp = normIp(sock.remoteAddress || '');
  const ipCount = (perIpConns.get(peerIp) || 0) + 1;
  if (ipCount > cfg.maxConnPerIp) {
    counters.rejected++;
    log({ k: 'conn_rejected', id, peer, reason: 'max-conn-per-ip' });
    sock.destroy();
    return;
  }
  perIpConns.set(peerIp, ipCount);
  sock.setNoDelay(true);
  sock.setTimeout(cfg.idleMs);
  log({ k: 'conn_open', id, peer });

  const backend = makeBackend(id);
  const st = {
    buf: Buffer.alloc(0), closed: false, muted: false, hiSeen: false,
    sessionUuid: null, uploadRemaining: 0, uploadTotal: 0, uploadCounted: 0,
    errorStrikes: 0, processing: false, firstRead: true,
    cmds: 0, bytesDown: 0, bytesUp: 0, dl: 0, ul: 0, openedRt: relMs(),
  };

  sock.on('timeout', () => { log({ k: 'conn_timeout', id }); sock.destroy(); });
  sock.on('error', () => {});
  sock.on('close', () => {
    if (st.closed === 'logged') return;
    st.closed = 'logged';
    counters.closed++;
    counters.bytesDownCli += st.bytesDown; counters.bytesUpCli += st.bytesUp;
    const n = perIpConns.get(peerIp) || 1;
    if (n <= 1) perIpConns.delete(peerIp); else perIpConns.set(peerIp, n - 1);
    log({ k: 'conn_close', id, peer, commands: st.cmds, downloads: st.dl, uploads: st.ul,
      bytesDown: st.bytesDown, bytesUp: st.bytesUp, durMs: relMs() - st.openedRt });
    void backend.close().catch(() => {});
  });
  sock.on('data', (chunk) => {
    // Pre-session GETIP gate (F-12): before any HI on this connection, a
    // read whose first line is exactly "GETIP" with trailing bytes in the
    // same read mutes the connection (no reply ever, socket kept open).
    if (st.firstRead) {
      st.firstRead = false;
      if (!st.hiSeen && st.uploadRemaining === 0 && chunk.length > 6 &&
          chunk.subarray(0, 5).toString('latin1') === 'GETIP') {
        const nl = chunk.indexOf(0x0a);
        if (nl === -1 || nl + 1 < chunk.length) {
          st.muted = true;
          log({ k: 'conn_muted_getip_gate', conn: id, bytes: chunk.length });
        }
      }
    }
    st.buf = Buffer.concat([st.buf, chunk]);
    void pump();
  });

  function writeLine(line) {
    if (st.closed) return;
    st.bytesDown += line.length + 1;
    sock.write(line + '\n');
  }
  function errorReply(counts = true) {
    writeLine('ERROR');
    if (counts) {
      st.errorStrikes++;
      if (st.errorStrikes >= 3) {
        log({ k: 'conn_error_strike_close', conn: id, strikes: st.errorStrikes });
        sock.destroy();
      }
    }
  }
  async function emitDownload(buf) {
    if (st.closed) throw new Error('conn closed');
    st.bytesDown += buf.length;
    await writeWait(sock, buf);
  }

  async function pump() {
    if (st.processing) return;
    st.processing = true;
    try {
      while (st.buf.length && st.closed !== 'logged' && !st.muted) {
        if (st.uploadRemaining > 0) {
          const take = Math.min(st.uploadRemaining, st.buf.length);
          const part = st.buf.subarray(0, take);
          st.buf = st.buf.subarray(take);
          st.uploadRemaining -= take;
          st.uploadCounted += take;
          st.bytesUp += take;
          await backend.uploadFeed(part);
          if (st.uploadRemaining === 0) {
            st.ul++;
            counters.uploads++;
            // daemon parity: OK right after consuming n; the worker receipts
            // are flushed and logged asynchronously (attribution lane).
            writeLine(`OK ${st.uploadTotal} ${Date.now()}`);
            void backend.uploadEnd().then((rec) => {
              log({ k: 'ul_done', conn: id, declared: st.uploadTotal, counted: st.uploadCounted, lane: backend.name, ...rec });
            }).catch((e) => log({ k: 'worker_err', conn: id, lane: 'upload-end', error: String(e.message || e) }));
          }
          continue;
        }
        const idx = st.buf.indexOf(0x0a);
        if (idx === -1) {
          if (st.buf.length > cfg.maxLineBytes) {
            log({ k: 'line_overflow', conn: id, bytes: st.buf.length });
            st.buf = Buffer.alloc(0);
            sock.destroy();
          }
          return;
        }
        const line = st.buf.subarray(0, idx);
        const lineLen = idx + 1; // includes \n — UPLOAD inclusive counting
        st.buf = st.buf.subarray(idx + 1);
        await processCommand(line, lineLen);
      }
    } catch (e) {
      log({ k: 'conn_abort', conn: id, error: String(e.message || e) });
      counters.workerErrors++;
      sock.destroy();
    } finally { st.processing = false; }
  }

  async function processCommand(line, lineLen) {
    const rawLine = line.toString('latin1');
    // F-25: strip ONE trailing \r pre-dispatch — except GETIP (strictness on
    // the raw line).
    const s = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    st.cmds++;
    log({ k: 'cmd', conn: id, line: s.length > 90 ? s.slice(0, 90) + '…' : s });

    if (s === 'HI' || s.startsWith('HI ')) {
      const tokens = s.split(' ');
      if (tokens.length === 1) {
        st.hiSeen = true;
        writeLine(`HELLO ${cfg.versionString}`);
        return;
      }
      if (tokens.length === 2) {
        if (!UUID_RE.test(tokens[1])) { writeLine('ERROR'); return; } // no strike (F-24)
        st.hiSeen = true;
        st.sessionUuid = tokens[1];
        loss.ensure(tokens[1], peerIp).lastSeen = Date.now();
        writeLine(`HELLO ${cfg.versionString}`);
        return;
      }
      // "HI <a> <b>…": daemon client-JWT parse failure → silent disconnect.
      log({ k: 'hi_jwt_disconnect', conn: id });
      sock.destroy();
      return;
    }
    if (s.startsWith('GETIP') || rawLine.startsWith('GETIP')) {
      if (rawLine !== 'GETIP') {
        st.muted = true; // strict GETIP (F-11)
        log({ k: 'conn_muted_getip_strict', conn: id, line: rawLine.slice(0, 40) });
        return;
      }
      writeLine(`YOURIP ${peerIp}`);
      return;
    }
    if (s === 'CAPABILITIES' || s.startsWith('CAPABILITIES')) {
      writeLine('CAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS');
      return;
    }
    if (s === 'SERVERID' || s.startsWith('SERVERID')) {
      writeLine(`SERVERID ${cfg.instanceUuid}`);
      return;
    }
    if (s === 'UPTIME' || s.startsWith('UPTIME')) {
      writeLine(`UPTIME ${Math.floor((Date.now() - cfg.startedAt) / 1000)}`);
      return;
    }
    if (s === 'PING') { errorReply(); return; } // argument required (F-10)
    if (s.startsWith('PING ')) { writeLine(`PONG ${Date.now()}`); return; }
    if (s === 'INITPLOSS') {
      if (st.sessionUuid) loss.ensure(st.sessionUuid, peerIp).lastSeen = Date.now();
      writeLine('OK');
      return;
    }
    if (s === 'PLOSS') { writeLine(loss.statsLine()); return; }
    if (s === 'UPLOAD_STATS') { errorReply(); return; } // daemon parity
    if (s.startsWith('DOWNLOAD ')) {
      const n = parseInt(s.slice(9).trim().split(/\s+/)[0], 10);
      if (!Number.isFinite(n) || n < 0 || n > cfg.maxDownloadBytes) {
        errorReply(); // documented safety deviation
        return;
      }
      counters.downloads++;
      st.dl++;
      const t0 = Date.now();
      if (n === 0) { writeLine(''); return; } // exactly "\n" (1 byte)
      // Byte-exact front framing (F-9): "DOWNLOAD " prefix truncated to
      // min(n-1, 9), pool bytes, trailing "\n" — all counted in n.
      const prefixLen = Math.min(n - 1, DOWNLOAD_PREFIX.length);
      await emitDownload(Buffer.from(DOWNLOAD_PREFIX.slice(0, prefixLen), 'latin1'));
      const poolBytes = Math.max(0, n - 10);
      if (poolBytes > 0) {
        try {
          await backend.download(poolBytes, emitDownload);
        } catch (e) {
          counters.workerErrors++;
          log({ k: 'worker_err', conn: id, lane: 'down', error: String(e.message || e) });
          sock.destroy();
          return;
        }
      }
      await emitDownload(Buffer.from('\n', 'latin1'));
      log({ k: 'dl_done', conn: id, n, lane: backend.name, ms: Date.now() - t0 });
      return;
    }
    if (s.startsWith('UPLOAD ')) {
      const parts = s.slice(7).trim().split(/\s+/);
      const n = parseInt(parts[0], 10);
      if (!Number.isFinite(n) || n < 0) {
        log({ k: 'upload_invalid_ignored', conn: id, arg: (parts[0] || '').slice(0, 24) });
        return; // verified daemon behavior: silent ignore
      }
      if (n > cfg.maxUploadBytes) { errorReply(); return; }
      if (n < lineLen) { errorReply(); return; }
      st.uploadTotal = n;
      st.uploadRemaining = n - lineLen;
      st.uploadCounted = 0;
      log({ k: 'ul_start', conn: id, declared: n, cmdLen: lineLen, lane: backend.name });
      await backend.uploadStart(n).catch(() => {});
      if (st.uploadRemaining === 0) {
        st.ul++;
        counters.uploads++;
        writeLine(`OK ${n} ${Date.now()}`);
      }
      return;
    }
    if (s === 'QUIT') { sock.end(); return; }
    errorReply(); // unknown — includes the encrypted-binary hello → fallback
  }
}

function writeWait(sock, buf) {
  return new Promise((resolve, reject) => {
    if (sock.destroyed) return reject(new Error('socket destroyed'));
    if (sock.write(buf)) return resolve();
    const onDrain = () => { cleanup(); resolve(); };
    const onErr = (e) => { cleanup(); reject(e); };
    const cleanup = () => {
      sock.removeListener('drain', onDrain);
      sock.removeListener('error', onErr);
    };
    sock.once('drain', onDrain);
    sock.once('error', onErr);
  });
}

// ---------------------------------------------------------------- UDP front
const udpSock = dgram.createSocket({ type: 'udp6', ipv6Only: false });
udpSock.on('message', (msg, rinfo) => {
  if (msg.length > 2048) return;
  const s = msg.toString('latin1');
  const parts = s.trim().split(/\s+/);
  if (parts[0] !== 'LOSS' || (parts.length !== 4 && parts.length !== 5)) return;
  const seq = parseInt(parts[2], 10);
  const uuid = parts[3];
  const clientTimer = parts[4];
  if (!UUID_RE.test(uuid) || !Number.isFinite(seq)) return;
  const reply = loss.record(uuid, normIp(rinfo.address), seq, clientTimer);
  if (reply !== null) {
    udpSock.send(Buffer.from(reply + '\n', 'latin1'), rinfo.port, rinfo.address);
    log({ k: 'udp_recv', uuid, seq, from: rinfo.address });
  } else {
    log({ k: 'udp_count', uuid, seq, from: rinfo.address });
  }
});
udpSock.on('error', (e) => { console.error('[cli-bridge] udp error:', e.message); process.exit(1); });

// ---------------------------------------------------------------- server
const server = net.createServer(handleConn);
server.on('error', (e) => { console.error('[cli-bridge] tcp error:', e.message); process.exit(1); });
server.listen(cfg.port, '::', () => {
  console.log(`[cli-bridge] tcp+udp :${cfg.port} | backend=${cfg.backend} | gateway=${cfg.gatewayBase} | log=${cfg.log}`);
  log({ k: 'meta', pid: process.pid, port: cfg.port, backend: cfg.backend, gateway: cfg.gatewayBase,
    wsChunk: cfg.wsChunk, httpChunk: cfg.httpChunk, wsPaceMs: cfg.wsPaceMs,
    versionString: cfg.versionString, instanceUuid: cfg.instanceUuid, node: process.version });
});
udpSock.bind(cfg.port);

setInterval(() => { log({ k: 'heartbeat', ...counters }); }, 5000).unref();

function summary(sig) {
  log({ k: 'summary', signal: sig, ...counters, wallMs: relMs() });
  setTimeout(() => process.exit(0), 50);
}
process.on('SIGINT', () => summary('SIGINT'));
process.on('SIGTERM', () => summary('SIGTERM'));

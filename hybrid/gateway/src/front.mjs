/**
 * front.mjs — legacy speedtest HTTP surface on the gateway: VPS full
 * potential + edge assist (v1.5 — "VPS mengeluarkan SEMUA potensi
 * bandwidth-nya, Cloudflare hanya MEMBANTU").
 *
 * Serves the *measurement* plane of the hybrid architecture for HTTP
 * speedtest clients (speedtest-cli / mini clients):
 *
 *   - GET  /speedtest/latency.txt            → served DIRECTLY (ping = VPS)
 *   - GET  /speedtest/random{N}x{N}.jpg      → TWO assist lanes, split by
 *       request SHARE (no bandwidth budget, no throttle):
 *       1. VPS lane: HYBRID_VPS_DL_SHARE of the download requests is
 *          served DIRECTLY from the gateway with daemon-parity
 *          printable-ASCII pool bytes at FULL socket speed. There is NO
 *          token bucket and NO byte budget: every local response runs as
 *          fast as the VPS link allows (socket backpressure is the only
 *          flow control). The VPS therefore always contributes up to its
 *          real capacity — Cloudflare is a HELPER on top, never a cap.
 *       2. Edge assist lane: the complementary (1 - share) of the requests
 *          is 302-redirected to a pool-selected Worker /__down — the edge
 *          adds its aggregate capacity IN PARALLEL with the VPS lane, so
 *          throughput ≈ VPS capacity + edge capacity for fast clients.
 *          The split is a per-IP Bresenham interleave — deterministic and
 *          correct from the very first request.
 *       3. Forced-local fallback: when the offload token mint is
 *          rate-limited AND the VPS lane is enabled (share > 0), serve
 *          locally instead of failing the client's measurement.
 *       4. vps-only mode: when NO Cloudflare worker deployment is available
 *          (no credentials / target 0 — workersAvailable() === false), ALL
 *          downloads are served by the VPS lane (graceful fallback).
 *
 *       HYBRID_VPS_DL_SHARE=1.0 → 100% VPS (pure VPS potential, edge idle,
 *       CF quota saved). 0.0 → 100% edge (pure offload). Tune ≈
 *       VPS capacity / expected client demand for maximum aggregate.
 *   - POST /speedtest/upload.php             → drain + answer (stock clients
 *                                              without hybrid routing) — the
 *              VPS ingress contribution
 *   - GET  /speedtest/upload.php             → `size=0` (mini-server probe)
 *   - GET  / , /hi                           → daemon-parity banners
 *
 * v1.5: ALL limits (share, rate limit, byte cap, token cache) are LIVE —
 * setOptions() applies .env changes without a restart.
 *
 * Security:
 *   - disabled by default (HYBRID_FRONT_ENABLED)
 *   - per-IP rate limit on token MINTING (HYBRID_FRONT_RATE_LIMIT_MPM;
 *     IPv6 peers are bucketed per /64)
 *   - tokens never logged; responses carry no-store
 */

import crypto from 'node:crypto';
import { ipKey } from './workerpool.mjs';

const IMAGE_SIZES = {
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
const VERSION_STRING = '2.11 (2.11.5) 2026-06-04.1737.7d0993d';
const FRONT_ID = 'hybrid-gateway-front/1.5';

// --- VPS download pool (daemon parity F-9): 2 MiB printable ASCII ------
// Materialized ONCE per process; every local-lane response is streamed from
// this pool cyclically, exactly like the reference daemon and the Worker's
// pool.ts.
const POOL_SIZE = 2 * 1024 * 1024;
let vpsPool = null;
function getVpsPool() {
  if (!vpsPool) {
    const buf = Buffer.allocUnsafe(POOL_SIZE);
    crypto.randomFillSync(buf);
    for (let i = 0; i < POOL_SIZE; i++) buf[i] = 0x20 + (buf[i] % 96);
    vpsPool = buf;
  }
  return vpsPool;
}

/** Create the front router. Returns (req, res, url, ip) => boolean (handled?)
 *  with a .setOptions(patch) method for v1.5 live configuration.
 *  ctx: { mintToken, log, counters, workerBase, pool?, rateLimitMpm, tokenBindIp?,
 *         tokenTtlMs?, tokenCacheMs?, maxDownBytes?, vpsDlShare?, workersAvailable? }
 */
export function createFront(ctx) {
  const { mintToken, log, counters } = ctx;
  const pickWorker = ctx.pool ? () => ctx.pool.pickWorker() : () => ({ id: 1, url: ctx.workerBase });
  const recordMint = ctx.pool ? (id) => ctx.pool.recordMint(id) : () => {};
  const workersAvailable = ctx.workersAvailable || (() => true);
  // Cap redirected download size at the Worker's MAX_DOWNLOAD_BYTES (deployed
  // production cap: 25 MiB). LIVE (v1.5): mutable via setOptions.
  const opts = {
    rateLimitMpm: Number(ctx.rateLimitMpm ?? 90),
    maxDownBytes: Number(ctx.maxDownBytes ?? 26214400),
    tokenCacheMs: Number(
      ctx.tokenCacheMs ?? Math.max(30_000, (Number(ctx.tokenTtlMs ?? 300_000) || 300_000) - 60_000),
    ),
    vpsDlShare: Math.min(1, Math.max(0, Number.isFinite(Number(ctx.vpsDlShare)) ? Number(ctx.vpsDlShare) : 0.15)),
    // DIRECT LANE (operator contract 27 Nov 2026): the official web client's
    // heavy XHRs are 307-handed to the Worker so payload bytes flow client ↔
    // edge ONLY. Default ON (falls back to full-VPS serving when the edge is
    // unavailable or the mint is rate-limited).
    webDirect: ctx.webDirect === false ? false : true,
  };
  const tokenBindIp = ctx.tokenBindIp === true;

  // --- VPS assist lane: request-share interleave --------------------------
  // NO token bucket. NO byte budget. NO throttle. opts.vpsDlShare is the
  // fraction of download REQUESTS answered directly by the VPS — each at
  // full socket speed. Distribution: per-IP Bresenham interleave.
  const dlSeq = new Map(); // ipKey -> Bresenham phase
  function pickVpsLane(ip) {
    const share = opts.vpsDlShare;
    if (share <= 0) return false;
    if (share >= 1) return true;
    const key = ipKey(ip);
    let phase = (dlSeq.get(key) || 0) + share;
    const vps = phase >= 1;
    if (vps) phase -= 1;
    dlSeq.set(key, phase);
    if (dlSeq.size > 10_000) dlSeq.delete(dlSeq.keys().next().value);
    return vps;
  }

  /** Serve `size` bytes of daemon-parity pool data as image/jpeg with the
   *  exact Content-Length and socket backpressure (res.write → drain).
   *  A client disconnect stops generation immediately (no wasted bytes). */
  function serveLocalJpeg(res, size, meta) {
    counters.frontDlLocalServed = (counters.frontDlLocalServed || 0) + 1;
    log('front_download_local', { ...meta, lane: meta && meta.lane ? meta.lane : 'vps' });
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': size,
      'Cache-Control': 'no-store, no-transform',
      'X-Hybrid-Lane': 'vps',
      'X-Hybrid-Front': FRONT_ID,
    });
    if (size === 0) {
      res.end();
      return;
    }
    const pool = getVpsPool();
    const CHUNK = 256 * 1024;
    let off = 0;
    let stopped = false;
    res.on('close', () => {
      stopped = true;
    });
    const writeNext = () => {
      while (off < size && !stopped) {
        const len = Math.min(CHUNK, size - off);
        const start = off % POOL_SIZE;
        const take = Math.min(POOL_SIZE - start, len);
        // Fresh buffer per chunk: res.write() queues a REFERENCE, so a
        // reused buffer would corrupt a queued-but-unflushed write.
        const out = Buffer.allocUnsafe(len);
        pool.copy(out, 0, start, start + take);
        if (take < len) pool.copy(out, take, 0, len - take);
        off += len;
        counters.frontDlLocalBytes = (counters.frontDlLocalBytes || 0) + len;
        counters.frontBytesOut = (counters.frontBytesOut || 0) + len;
        let writable;
        try {
          writable = res.write(out);
        } catch {
          stopped = true;
          break;
        }
        if (!writable) {
          res.once('drain', writeNext);
          return;
        }
      }
      if (off >= size && !stopped) {
        try {
          res.end();
        } catch {
          /* socket gone */
        }
      }
    };
    writeNext();
  }

  // --- per-IP token mint rate limiting (sliding 60s window, /64 IPv6) ----
  const mintWindow = new Map(); // ipKey -> [timestamps]
  function allowMint(ip) {
    if (!opts.rateLimitMpm) return true;
    const key = ipKey(ip);
    const now = Date.now();
    const list = (mintWindow.get(key) || []).filter((t) => now - t < 60_000);
    if (list.length >= opts.rateLimitMpm) {
      mintWindow.set(key, list);
      if (mintWindow.size > 10_000) mintWindow.delete(mintWindow.keys().next().value);
      return false;
    }
    list.push(now);
    mintWindow.set(key, list);
    if (mintWindow.size > 10_000) mintWindow.delete(mintWindow.keys().next().value);
    return true;
  }

  // --- per-IP cached offload token ---------------------------------------
  // Tokens are stateless HMAC bearer capabilities — REUSE within the TTL is
  // safe and collapses mint churn to ~1 per (TTL - margin) per client.
  const TOKEN_MARGIN_MS = 60_000;
  const tokenCache = new Map(); // ipKey -> { token, expMs }
  function getOffloadToken(ip) {
    const key = ipKey(ip);
    const now = Date.now();
    const hit = tokenCache.get(key);
    if (opts.tokenCacheMs > 0 && hit && hit.expMs - TOKEN_MARGIN_MS > now) return hit.token;
    if (!allowMint(ip)) {
      counters.frontRateLimited = (counters.frontRateLimited || 0) + 1;
      log('front_rate_limited', { ip });
      return null;
    }
    counters.frontTokensMinted = (counters.frontTokensMinted || 0) + 1;
    const minted = mintToken(tokenBindIp ? ip : '*');
    const rec = { token: minted.token, expMs: minted.expMs };
    if (opts.tokenCacheMs > 0) {
      tokenCache.set(key, rec);
      if (tokenCache.size > 10_000) tokenCache.delete(tokenCache.keys().next().value);
    }
    return rec.token;
  }

  function finish(res, status, body, headers) {
    const bodyBuf = Buffer.from(body || '');
    counters.frontBytesOut = (counters.frontBytesOut || 0) + bodyBuf.length;
    res.writeHead(status, {
      'Content-Length': bodyBuf.length,
      'Cache-Control': 'no-store, no-transform',
      'X-Hybrid-Front': FRONT_ID,
      ...(headers || {}),
    });
    res.end(bodyBuf);
  }

  function redirect(res, status, location, close = true) {
    res.writeHead(status, {
      'Content-Length': 0,
      Location: location,
      'Cache-Control': 'no-store, no-transform',
      ...(close ? { Connection: 'close' } : {}),
      'X-Hybrid-Front': FRONT_ID,
    });
    res.end();
  }

  /** CORS reflection (daemon §4.5 semantics: reflect when allowedDomains
   *  accepts — the gateway default serves "*"). Every hop of a CORS
   *  redirect must carry ACAO or the browser aborts the measurement. */
  function corsHeaders(req) {
    const o = req.headers.origin;
    if (!o) return {};
    return { 'Access-Control-Allow-Origin': o };
  }

  /** Serve `size` bytes of daemon-parity pool data as application/octet-stream
   *  with the exact Content-Length (the Ookla web-client download shape). */
  function serveLocalOctet(res, size, meta) {
    counters.frontDlLocalServed = (counters.frontDlLocalServed || 0) + 1;
    log('web_download_local', { ...meta, lane: meta && meta.lane ? meta.lane : 'vps' });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': size,
      'Cache-Control': 'no-store, no-transform',
      'X-Hybrid-Lane': 'vps',
      'X-Hybrid-Front': FRONT_ID,
    });
    if (size === 0) {
      res.end();
      return;
    }
    const pool = getVpsPool();
    const CHUNK = 256 * 1024;
    let off = 0;
    let stopped = false;
    res.on('close', () => {
      stopped = true;
    });
    const writeNext = () => {
      while (off < size && !stopped) {
        const len = Math.min(CHUNK, size - off);
        const start = off % POOL_SIZE;
        const take = Math.min(POOL_SIZE - start, len);
        const out = Buffer.allocUnsafe(len);
        pool.copy(out, 0, start, start + take);
        if (take < len) pool.copy(out, take, 0, len - take);
        off += len;
        counters.frontDlLocalBytes = (counters.frontDlLocalBytes || 0) + len;
        counters.frontBytesOut = (counters.frontBytesOut || 0) + len;
        let writable;
        try {
          writable = res.write(out);
        } catch {
          stopped = true;
          break;
        }
        if (!writable) {
          res.once('drain', writeNext);
          return;
        }
      }
      if (off >= size && !stopped) {
        try {
          res.end();
        } catch {
          /* socket gone */
        }
      }
    };
    writeNext();
  }

  /** 307 redirect with CORS (each redirect hop of a CORS request must pass
   *  the CORS check — verified live in the 27 Nov direct-lane PoC). */
  function redirectCors(req, res, location) {
    res.writeHead(307, {
      'Content-Length': 0,
      Location: location,
      'Cache-Control': 'no-store, no-transform',
      'X-Hybrid-Lane': 'edge',
      'X-Hybrid-Front': FRONT_ID,
      ...corsHeaders(req),
    });
    res.end();
  }

  /** Drain the upload body FULLY, then answer `size=N` (daemon legacy
   *  parity). No early answer: an early response + close would abort the
   *  client's send loop mid-body on real-RTT links (observed T-10). */
  function handleUpload(req, res, ip, url) {
    const declared = Number(req.headers['content-length'] || 0);
    counters.frontUploads = (counters.frontUploads || 0) + 1;
    log('front_upload_start', { ip, path: url.pathname, declared });
    let drained = 0;
    let answered = false;
    const started = Date.now();
    const clearWatchdog = () => {
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    };
    let watchdog = setTimeout(() => {
      log('front_upload_timeout', { ip, declared, drained, ms: Date.now() - started });
      try { res.destroy(); } catch { /* noop */ }
      req.destroy();
    }, 180_000); // 3-minute drain cap per request
    req.on('data', (c) => {
      drained += c.length;
      counters.frontBytesIn = (counters.frontBytesIn || 0) + c.length;
      if (drained > 256 * 1024 * 1024) { // 256 MiB safety cap
        clearWatchdog();
        // BUG FIX (kept): pause the request now; destroy only after finish —
        // destroying immediately defeated the 413 flush (client saw ECONNRESET).
        answered = true;
        req.pause();
        finish(res, 413, 'size=0\n', { 'Content-Type': 'text/plain; charset=UTF-8', Connection: 'close' });
        res.on('finish', () => req.destroy());
      }
    });
    req.on('end', () => {
      if (answered) return;
      answered = true;
      clearWatchdog();
      log('front_upload_done', { ip, declared, drained, ms: Date.now() - started });
      finish(res, 200, `size=${drained}\n`, {
        'Content-Type': 'text/plain; charset=UTF-8',
      });
    });
    req.on('error', () => {
      answered = true;
      clearWatchdog();
      log('front_upload_abort', { ip, declared, drained });
    });
    // A client RST mid-body surfaces as res 'close' WITHOUT an 'error' on req.
    res.on('close', clearWatchdog);
    req.resume();
  }

  function front(req, res, url, ip) {
    const method = (req.method || 'GET').toUpperCase();
    let path = url.pathname;
    // accept both /speedtest/x and /x (daemon-parity alias)
    const stripped = path.startsWith('/speedtest/') ? path.slice('/speedtest'.length) : path;
    if (stripped.endsWith('/') && stripped !== '/') stripped = stripped.slice(0, -1);

    // ---- OPTIONS (compat + web-client preflight) -----------------------
    // The Ookla web SDK POSTs application/octet-stream, which browsers
    // preflight with Access-Control-Request-Headers: content-type. Without
    // echoing ACAH the preflight fails and the upload POST is never sent
    // (verified live, 27 Nov direct-lane PoC — this exact failure killed
    // the upload stage before the fix).
    if (method === 'OPTIONS') {
      const h = {
        Allow: 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        ...corsHeaders(req),
      };
      const reqH = req.headers['access-control-request-headers'];
      if (reqH) h['Access-Control-Allow-Headers'] = reqH;
      finish(res, 200, '', h);
      return true;
    }

    // ---- Ookla WEB-CLIENT XHR surface (direct lane, 27 Nov 2026) -------
    // Control endpoints are served here (tiny); the heavy endpoints
    // (/download, POST /upload) are 307-handed to the Worker so the payload
    // flows client ↔ edge ONLY. Byte shapes verified against production
    // OoklaServer 2.11.5/2.11.7 + the live speedtest.net SDK (PoC 27 Nov).
    if (stripped === '/hello' && (method === 'GET' || method === 'HEAD')) {
      counters.webHello = (counters.webHello || 0) + 1;
      finish(res, 200, `hello ${VERSION_STRING}\n`, {
        'Content-Type': 'text/plain; charset=UTF-8',
        ...corsHeaders(req),
      });
      return true;
    }
    if (stripped === '/getip' && (method === 'GET' || method === 'HEAD')) {
      counters.webGetip = (counters.webGetip || 0) + 1;
      finish(res, 200, `${ip}\n`, {
        'Content-Type': 'text/plain; charset=UTF-8',
        ...corsHeaders(req),
      });
      return true;
    }
    if (stripped === '/capabilities' && (method === 'GET' || method === 'HEAD')) {
      counters.webCapabilities = (counters.webCapabilities || 0) + 1;
      // NO UPLOAD_STATS: on the direct lane the upload bytes land at the
      // edge — the SDK then measures upload LOCALLY (its designed fallback).
      finish(res, 200, 'capabilities SERVER_HOST_AUTH\n', {
        'Content-Type': 'text/plain; charset=UTF-8',
        ...corsHeaders(req),
      });
      return true;
    }
    if (stripped === '/ping' && (method === 'GET' || method === 'HEAD')) {
      counters.webPing = (counters.webPing || 0) + 1;
      finish(res, 200, 'pong\n', {
        'Content-Type': 'text/plain; charset=UTF-8',
        ...corsHeaders(req),
      });
      return true;
    }
    if (stripped === '/upload-stats') {
      // production parity: 400 (the web client measures via WSS, not HTTP)
      finish(res, 400, '', corsHeaders(req));
      return true;
    }

    // ---- /download?size=N — the web client's heavy download -------------
    if (stripped === '/download' && (method === 'GET' || method === 'HEAD')) {
      const n = Number(url.searchParams.get('size') || 0);
      const size = Number.isInteger(n) && n >= 0 ? n : 0;
      counters.webDownloads = (counters.webDownloads || 0) + 1;
      const guid = url.searchParams.get('guid') || '';

      const edgeUsable = opts.webDirect && workersAvailable() && method === 'GET' && size > 0;
      if (edgeUsable) {
        const effective = opts.maxDownBytes && size > opts.maxDownBytes ? opts.maxDownBytes : size;
        if (effective !== size) counters.frontDownCapped = (counters.frontDownCapped || 0) + 1;
        const token = getOffloadToken(ip);
        if (token) {
          const worker = pickWorker();
          recordMint(worker.id);
          counters.webDownRedirects = (counters.webDownRedirects || 0) + 1;
          log('web_download_redirect', { ip, size: effective, guid, workerId: worker.id, lane: 'edge' });
          const sep = url.search ? '&' : '?';
          redirectCors(req, res, `${worker.url}/download${url.search}${sep}token=${token}`);
          return true;
        }
        // mint rate-limited → forced local serve (never break the client)
        counters.webDlLocalForced = (counters.webDlLocalForced || 0) + 1;
        log('web_download_local_forced', { ip, size, guid });
      }
      if (method === 'HEAD') {
        finish(res, 200, '', {
          'Content-Type': 'application/octet-stream',
          'Content-Length': size,
          'X-Hybrid-Lane': 'vps',
          ...corsHeaders(req),
        });
        return true;
      }
      counters.webDlLocal = (counters.webDlLocal || 0) + 1;
      serveLocalOctet(res, size, { ip, guid });
      return true;
    }

    // ---- POST /upload — the web client's heavy upload -------------------
    if (stripped === '/upload') {
      if (method !== 'POST') {
        finish(res, 404, '', corsHeaders(req));
        return true;
      }
      counters.webUploads = (counters.webUploads || 0) + 1;
      const guid = url.searchParams.get('guid') || '';
      if (opts.webDirect && workersAvailable()) {
        const token = getOffloadToken(ip);
        if (token) {
          const worker = pickWorker();
          recordMint(worker.id);
          counters.webUlRedirects = (counters.webUlRedirects || 0) + 1;
          let saw = 0;
          req.on('data', (c) => {
            saw += c.length;
          });
          log('web_upload_redirect', { ip, guid, workerId: worker.id, lane: 'edge' });
          const sep = url.search ? '&' : '?';
          // 307 preserves method+body: the browser re-POSTs the whole body
          // DIRECTLY to the edge. Answer immediately; discard the body bytes
          // that were already in flight (redirect spill ≈ 1 RTT of body).
          res.writeHead(307, {
            'Content-Length': 0,
            Location: `${worker.url}/upload${url.search}${sep}token=${token}`,
            'Cache-Control': 'no-store, no-transform',
            'X-Hybrid-Lane': 'edge',
            'X-Hybrid-Front': FRONT_ID,
            ...corsHeaders(req),
          });
          res.end(() => {
            counters.webUlSpillBytes = (counters.webUlSpillBytes || 0) + saw;
            log('web_upload_redirect_flushed', { ip, guid, spillBytes: saw });
            req.destroy();
          });
          return true;
        }
        counters.webUlLocalForced = (counters.webUlLocalForced || 0) + 1;
      }
      // full-VPS upload (direct lane off / no edge / mint limited)
      handleUpload(req, res, ip, url);
      return true;
    }

    // ---- root banner ----
    if (stripped === '' || stripped === '/') {
      if (method === 'GET') {
        counters.frontRoot = (counters.frontRoot || 0) + 1;
        finish(res, 200, '<html><head><title>OoklaServer</title></head><body><h1>OoklaServer</h1><p>It worked!<br /></p></body></html>\n', {
          'Content-Type': 'text/html',
        });
        return true;
      }
      if (method === 'HEAD') {
        counters.frontRoot = (counters.frontRoot || 0) + 1;
        finish(res, 200, '', { 'Content-Type': 'text/html' });
        return true;
      }
      return false;
    }

    // ---- /hi ----
    if (stripped === '/hi' && (method === 'GET' || method === 'HEAD')) {
      counters.frontHi = (counters.frontHi || 0) + 1;
      finish(res, 200, `hello ${VERSION_STRING}\n`, {
        'Content-Type': 'text/plain; charset=UTF-8',
      });
      return true;
    }

    // ---- latency.txt: THE VPS ping plane (served directly, never redirected)
    if (stripped === '/latency.txt' && (method === 'GET' || method === 'HEAD')) {
      counters.frontLatency = (counters.frontLatency || 0) + 1;
      log('front_latency', { ip });
      finish(res, 200, 'test=test\n', { 'Content-Type': 'text/plain; charset=UTF-8' });
      return true;
    }

    // ---- upload.php ----
    if (stripped === '/upload.php') {
      if (method === 'POST') {
        handleUpload(req, res, ip, url);
        return true;
      }
      if (method === 'GET' || method === 'HEAD') {
        // mini-server extension probe: single line matching size=[0-9]
        counters.frontMiniProbe = (counters.frontMiniProbe || 0) + 1;
        finish(res, 200, 'size=0\n', { 'Content-Type': 'text/plain; charset=UTF-8' });
        return true;
      }
      return false;
    }

    // ---- random{N}x{N}.jpg: the assist lanes (share-interleaved) --------
    const m = stripped.match(IMAGE_RE);
    if (m && m[1] === m[2] && (method === 'GET' || method === 'HEAD')) {
      const n = parseInt(m[1], 10);
      const size = IMAGE_SIZES[n];
      if (!size) return false; // unknown size → fall through to 404
      counters.frontDownloads = (counters.frontDownloads || 0) + 1;

      // v1.5 vps-only fallback: no deployed edge → everything served locally.
      const fallbackLocal = !workersAvailable();

      // Lane 1 — VPS assist (UNCAPPED, full-speed local serve on its share
      // of requests; the byte cap is an EDGE limit, the VPS lane has none).
      if (method === 'GET' && (fallbackLocal || pickVpsLane(ip))) {
        counters.frontDlLocal = (counters.frontDlLocal || 0) + 1;
        serveLocalJpeg(res, size, fallbackLocal ? { ip, n, size, lane: 'vps-fallback' } : { ip, n, size });
        return true;
      }
      if (method === 'HEAD' && (opts.vpsDlShare > 0 || fallbackLocal)) {
        // HEAD costs no bytes: serve the daemon-parity headers locally.
        finish(res, 200, '', {
          'Content-Type': 'image/jpeg',
          'Content-Length': size,
          'X-Hybrid-Lane': 'vps',
        });
        return true;
      }

      // Lane 2 — edge assist: 302 → pool-selected Worker __down.
      const effective = opts.maxDownBytes && size > opts.maxDownBytes ? opts.maxDownBytes : size;
      if (effective !== size) counters.frontDownCapped = (counters.frontDownCapped || 0) + 1;
      counters.frontDownRedirects = (counters.frontDownRedirects || 0) + 1;
      const token = getOffloadToken(ip);
      if (!token) {
        // Lane 3 — mint rate-limited: degrade to a forced local serve (only
        // when the VPS lane is part of the design) instead of breaking the
        // measurement. With share=0 the operator chose pure edge offload,
        // so the legacy 429 applies.
        if ((opts.vpsDlShare > 0 || fallbackLocal) && method === 'GET') {
          counters.frontDlLocalForced = (counters.frontDlLocalForced || 0) + 1;
          serveLocalJpeg(res, size, { ip, n, size, forced: true, lane: 'vps-forced' });
          return true;
        }
        finish(res, 429, JSON.stringify({ error: 'rate-limited', retryAfterMs: 60000 }), {
          'Content-Type': 'application/json',
          Connection: 'close',
        });
        return true;
      }
      const worker = pickWorker();
      recordMint(worker.id);
      log('front_download_redirect', { ip, n, size, effective, workerId: worker.id, lane: 'edge' });
      // 302: urllib/others follow this with GET directly to the edge
      redirect(res, 302, `${worker.url}/__down?bytes=${effective}&token=${token}`);
      return true;
    }

    return false; // not a front path — let the gateway answer (404)
  }

  /** v1.5: apply live .env changes (clamped, logged). */
  front.setOptions = function setOptions(patch = {}) {
    const applied = {};
    if (patch.rateLimitMpm !== undefined && Number.isFinite(Number(patch.rateLimitMpm)) && Number(patch.rateLimitMpm) >= 0) {
      opts.rateLimitMpm = Math.floor(Number(patch.rateLimitMpm));
      applied.rateLimitMpm = opts.rateLimitMpm;
    }
    if (patch.maxDownBytes !== undefined && Number.isFinite(Number(patch.maxDownBytes)) && Number(patch.maxDownBytes) >= 0) {
      opts.maxDownBytes = Math.floor(Number(patch.maxDownBytes));
      applied.maxDownBytes = opts.maxDownBytes;
    }
    if (patch.tokenCacheMs !== undefined && Number.isFinite(Number(patch.tokenCacheMs)) && Number(patch.tokenCacheMs) >= 0) {
      opts.tokenCacheMs = Number(patch.tokenCacheMs);
      applied.tokenCacheMs = opts.tokenCacheMs;
    }
    if (patch.vpsDlShare !== undefined && Number.isFinite(Number(patch.vpsDlShare))) {
      opts.vpsDlShare = Math.min(1, Math.max(0, Number(patch.vpsDlShare)));
      applied.vpsDlShare = opts.vpsDlShare;
    }
    if (patch.webDirect !== undefined) {
      opts.webDirect = patch.webDirect === true || patch.webDirect === 'true' || patch.webDirect === 1;
      applied.webDirect = opts.webDirect;
    }
    if (Object.keys(applied).length > 0) log('front_options_updated', applied);
  };

  return front;
}

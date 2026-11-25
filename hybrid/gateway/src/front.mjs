/**
 * front.mjs — legacy speedtest HTTP surface on the gateway: VPS full
 * potential + edge assist (v1.4 — "VPS mengeluarkan SEMUA potensi
 * bandwidth-nya, Cloudflare hanya MEMBANTU").
 *
 * Serves the *measurement* plane of the hybrid architecture for HTTP
 * speedtest clients (speedtest-cli / mini clients):
 *
 *   - GET  /speedtest/latency.txt            → served DIRECTLY (ping = VPS)
 *   - GET  /speedtest/random{N}x{N}.jpg      → TWO assist lanes, split by
 *       request SHARE (no bandwidth budget, no throttle — v1.4):
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
 *          The split is a per-IP Bresenham interleave — the same proven
 *          deterministic distribution as the hybrid client's upload split
 *          (correct from the very first request).
 *       3. Forced-local fallback: when the offload token mint is
 *          rate-limited AND the VPS lane is enabled (share > 0), serve
 *          locally instead of failing the client's measurement.
 *
 *       HYBRID_VPS_DL_SHARE=1.0 → 100% VPS (pure VPS potential, edge idle,
 *       CF quota saved). 0.0 → 100% edge (legacy pure offload). Tune ≈
 *       VPS capacity / expected client demand for maximum aggregate.
 *   - POST /speedtest/upload.php             → drain + answer (stock clients
 *                                              without hybrid routing) — the
 *                                              VPS ingress contribution
 *   - GET  /speedtest/upload.php             → `size=0` (mini-server probe)
 *   - GET  / , /hi                           → daemon-parity banners
 *
 * Offload tokens are CACHED per client IP for (TTL - margin): a 16-32
 * thread download ramp no longer mints one token per request (the mint
 * flood tripped the per-IP rate limit MID-MEASUREMENT, and the limiter now
 * counts actual mints only). recordMint() is still called per redirect so
 * the pool autoscaler keeps its per-worker traffic signal.
 *
 * Security:
 *   - disabled by default (HYBRID_FRONT_ENABLED)
 *   - per-IP rate limit on token MINTING (HYBRID_FRONT_RATE_LIMIT_MPM;
 *     IPv6 peers are bucketed per /64)
 *   - tokens never logged; responses carry no-store
 *
 * Env (via the gateway ctx):
 *   HYBRID_FRONT_ENABLED         default false
 *   HYBRID_FRONT_RATE_LIMIT_MPM  default 90 (token mints per IP per minute; 0 = off)
 *   HYBRID_FRONT_MAX_DOWN_BYTES  default 26 MiB (edge redirect cap)
 *   HYBRID_FRONT_TOKEN_CACHE_MS  default = token TTL − 60 s; 0 disables the cache
 *   HYBRID_VPS_DL_SHARE          default 0.15 — fraction of download requests
 *                                served by the uncapped VPS lane (0..1).
 *                                REMOVED in v1.4 (operator decision):
 *                                HYBRID_VPS_DL_BUDGET_MBPS — the token-bucket
 *                                budget that capped the VPS's contribution.
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
const FRONT_ID = 'hybrid-gateway-front/1.4';

// --- VPS download pool (daemon parity F-9): 2 MiB printable ASCII ------
// Materialized ONCE per process (one randomFill + one 0x20+b%96 map pass,
// ~15 ms for 2 MiB); every local-lane response is streamed from this pool
// cyclically, exactly like the reference daemon and the Worker's pool.ts.
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

/** Create the front router. Returns (req, res, url, ip) => boolean (handled?).
 *  ctx: { mintToken, log, counters, workerBase, pool?, rateLimitMpm, tokenBindIp?,
 *         tokenTtlMs?, tokenCacheMs?, maxDownBytes?, vpsDlShare? }
 */
export function createFront(ctx) {
  const { mintToken, log, counters } = ctx;
  const rateLimitMpm = Number(ctx.rateLimitMpm ?? 90);
  const tokenBindIp = ctx.tokenBindIp === true;
  const pickWorker = ctx.pool ? () => ctx.pool.pickWorker() : () => ({ id: 1, url: ctx.workerBase });
  const recordMint = ctx.pool ? (id) => ctx.pool.recordMint(id) : () => {};
  // Cap redirected download size at the Worker's MAX_DOWNLOAD_BYTES (deployed
  // production cap: 25 MiB). Sizes above the cap would 400 at the edge and
  // count as zero; capping keeps the bytes measurable (the client counts
  // bytes it actually receives, so the measurement stays honest).
  const maxDownBytes = Number(ctx.maxDownBytes ?? 26214400);

  // --- VPS assist lane: request-share interleave (v1.4) -------------------
  // NO token bucket. NO byte budget. NO throttle. HYBRID_VPS_DL_SHARE is
  // the fraction of download REQUESTS answered directly by the VPS — each
  // at full socket speed (the only flow control is TCP backpressure).
  // The complementary fraction is 302-assisted by the worker pool, IN
  // PARALLEL, so the aggregate = VPS capacity + edge capacity.
  // Distribution: per-IP Bresenham interleave — deterministic, correct
  // from the first request (same algorithm as the client upload split).
  const shareRaw = ctx.vpsDlShare;
  const vpsDlShare = Math.min(1, Math.max(0, Number.isFinite(Number(shareRaw)) ? Number(shareRaw) : 0.15));
  const dlSeq = new Map(); // ipKey -> Bresenham phase
  function pickVpsLane(ip) {
    if (vpsDlShare <= 0) return false;
    if (vpsDlShare >= 1) return true;
    const key = ipKey(ip);
    let phase = (dlSeq.get(key) || 0) + vpsDlShare;
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
    log('front_download_local', { ...meta, lane: 'vps' });
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
    if (!rateLimitMpm) return true;
    const key = ipKey(ip);
    const now = Date.now();
    const list = (mintWindow.get(key) || []).filter((t) => now - t < 60_000);
    if (list.length >= rateLimitMpm) {
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
  // v1.2 and earlier minted one token PER download request: a 16-32 thread
  // ramp (the throughput-boosting mode) minted dozens of tokens per second
  // and tripped the per-IP rate limit MID-MEASUREMENT. Tokens are stateless
  // HMAC bearer capabilities — REUSE within the TTL is safe and collapses
  // mint churn to ~1 per (TTL - margin) per client.
  const TOKEN_MARGIN_MS = 60_000;
  const tokenCacheMs = Number(
    ctx.tokenCacheMs ?? Math.max(30_000, (Number(ctx.tokenTtlMs ?? 300_000) || 300_000) - TOKEN_MARGIN_MS),
  );
  const tokenCache = new Map(); // ipKey -> { token, expMs }
  function getOffloadToken(ip) {
    const key = ipKey(ip);
    const now = Date.now();
    const hit = tokenCache.get(key);
    if (tokenCacheMs > 0 && hit && hit.expMs - TOKEN_MARGIN_MS > now) return hit.token;
    if (!allowMint(ip)) {
      counters.frontRateLimited = (counters.frontRateLimited || 0) + 1;
      log('front_rate_limited', { ip });
      return null;
    }
    counters.frontTokensMinted = (counters.frontTokensMinted || 0) + 1;
    const minted = mintToken(tokenBindIp ? ip : '*');
    const rec = { token: minted.token, expMs: minted.expMs };
    if (tokenCacheMs > 0) {
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

  /** Drain the upload body FULLY, then answer `size=N` (daemon legacy
   *  parity). No early answer: an early response + close would abort the
   *  client's send loop mid-body on real-RTT links (observed T-10) and
   *  corrupt the stock-client upload measurement. */
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
        // BUG FIX (verified live, v1.2 regression): req.destroy() ran
        // IMMEDIATELY after res.on('finish', ...) — defeating its own hook
        // (the socket died before the 413 flushed; the client saw
        // ECONNRESET). Pause the request now; destroy only after finish.
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
    // A client RST mid-body surfaces as res 'close' WITHOUT an 'error' on
    // req — clear the watchdog here too (v1.1 fix, kept).
    res.on('close', clearWatchdog);
    req.resume();
  }

  return function front(req, res, url, ip) {
    const method = (req.method || 'GET').toUpperCase();
    let path = url.pathname;
    // accept both /speedtest/x and /x (daemon-parity alias)
    const stripped = path.startsWith('/speedtest/') ? path.slice('/speedtest'.length) : path;
    if (stripped.endsWith('/') && stripped !== '/') stripped = stripped.slice(0, -1);

    // ---- OPTIONS (compat) ----
    if (method === 'OPTIONS') {
      finish(res, 200, '', { Allow: 'GET, HEAD, POST, OPTIONS' });
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

      // Lane 1 — VPS assist (UNCAPPED, full-speed local serve on its share
      // of requests; the 25 MiB cap is an EDGE limit, the VPS lane has no
      // such limit — a VPS-lane response is never budget-gated).
      if (method === 'GET' && pickVpsLane(ip)) {
        counters.frontDlLocal = (counters.frontDlLocal || 0) + 1;
        serveLocalJpeg(res, size, { ip, n, size });
        return true;
      }
      if (method === 'HEAD' && vpsDlShare > 0) {
        // HEAD costs no bytes: serve the daemon-parity headers locally.
        finish(res, 200, '', {
          'Content-Type': 'image/jpeg',
          'Content-Length': size,
          'X-Hybrid-Lane': 'vps',
        });
        return true;
      }

      // Lane 2 — edge assist: 302 → pool-selected Worker __down.
      const effective = maxDownBytes && size > maxDownBytes ? maxDownBytes : size;
      if (effective !== size) counters.frontDownCapped = (counters.frontDownCapped || 0) + 1;
      counters.frontDownRedirects = (counters.frontDownRedirects || 0) + 1;
      const token = getOffloadToken(ip);
      if (!token) {
        // Lane 3 — mint rate-limited: degrade to a forced local serve (only
        // when the VPS lane is part of the design) instead of breaking the
        // measurement. With share=0 the operator chose pure edge offload,
        // so the legacy 429 applies.
        if (vpsDlShare > 0 && method === 'GET') {
          counters.frontDlLocalForced = (counters.frontDlLocalForced || 0) + 1;
          serveLocalJpeg(res, size, { ip, n, size, forced: true });
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
  };
}

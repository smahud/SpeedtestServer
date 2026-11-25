/**
 * front.mjs — legacy speedtest HTTP surface on the gateway: edge offload
 * + the VPS ASSIST lane (v1.3 — "Cloudflare membantu beban, bukan
 * menggantikan").
 *
 * Serves the *measurement* plane of the hybrid architecture for HTTP
 * speedtest clients (speedtest-cli / mini clients):
 *
 *   - GET  /speedtest/latency.txt            → served DIRECTLY (ping = VPS)
 *   - GET  /speedtest/random{N}x{N}.jpg      → THREE download lanes:
 *       1. VPS assist lane (budget-gated): served DIRECTLY from the gateway
 *          with daemon-parity printable-ASCII pool bytes while a token
 *          bucket still has budget (HYBRID_VPS_DL_BUDGET_MBPS). The VPS
 *          therefore contributes up to its link capacity to every client's
 *          measurement — Cloudflare is a HELPER, not a replacement.
 *       2. Edge lane (overflow): once the budget is drained the request is
 *          302-redirected to a pool-selected Worker /__down — aggregate
 *          throughput ≈ VPS budget + edge capacity, so a 1 Gbps client
 *          behind a 100 Mbps VPS still gets ~1 Gbps.
 *       3. Forced-local fallback: when the offload token mint is
 *          rate-limited AND the assist lane is enabled, serve locally
 *          instead of failing the client's measurement.
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
 *   HYBRID_VPS_DL_BUDGET_MBPS    default 0 = off (pure edge offload — legacy
 *                                behavior). Set to the VPS link capacity
 *                                (e.g. 100 on a 100 Mbps VPS).
 *   HYBRID_VPS_DL_BURST_S        default 2 (bucket capacity = budget × seconds)
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
const FRONT_ID = 'hybrid-gateway-front/1.3';

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
 *         tokenTtlMs?, tokenCacheMs?, maxDownBytes?, vpsDlBudgetMbps?, vpsDlBurstS? }
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

  // --- VPS assist lane: token-bucket budget (bytes) ----------------------
  const vpsDlBudgetMbps = Math.max(0, Number(ctx.vpsDlBudgetMbps || 0));
  const vpsDlBurstS = Math.max(0.5, Number(ctx.vpsDlBurstS ?? 2));
  const vpsDlBps = vpsDlBudgetMbps * 125_000; // Mbps → bytes/s (decimal)
  const vpsDlBucketCap = vpsDlBps * vpsDlBurstS;
  let vpsDlTokens = vpsDlBucketCap; // full bucket: the VPS contributes first
  let vpsDlLastRefill = Date.now();

  function refillDlTokens() {
    const now = Date.now();
    if (vpsDlBps > 0) {
      const add = ((now - vpsDlLastRefill) / 1000) * vpsDlBps;
      vpsDlTokens = Math.min(vpsDlBucketCap, vpsDlTokens + add);
    }
    vpsDlLastRefill = now;
  }

  /** Budget decision for a local-lane serve of `bytes` (token bucket). */
  function takeLocalBudget(bytes) {
    if (vpsDlBps <= 0) return false; // assist lane disabled → pure offload
    refillDlTokens();
    if (vpsDlTokens >= bytes) {
      vpsDlTokens -= bytes;
      return true;
    }
    return false;
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

    // ---- random{N}x{N}.jpg: the three download lanes ------------------
    const m = stripped.match(IMAGE_RE);
    if (m && m[1] === m[2] && (method === 'GET' || method === 'HEAD')) {
      const n = parseInt(m[1], 10);
      const size = IMAGE_SIZES[n];
      if (!size) return false; // unknown size → fall through to 404
      counters.frontDownloads = (counters.frontDownloads || 0) + 1;

      // Lane 1 — VPS assist (budget-gated; full size, no Workers cap: the
      // 25 MiB cap is an EDGE limit, the VPS lane has no such limit).
      if (method === 'GET' && takeLocalBudget(size)) {
        counters.frontDlLocal = (counters.frontDlLocal || 0) + 1;
        serveLocalJpeg(res, size, { ip, n, size });
        return true;
      }
      if (method === 'HEAD' && vpsDlBps > 0) {
        // HEAD costs no bytes: serve the daemon-parity headers locally.
        finish(res, 200, '', {
          'Content-Type': 'image/jpeg',
          'Content-Length': size,
          'X-Hybrid-Lane': 'vps',
        });
        return true;
      }

      // Lane 2 — edge overflow: 302 → pool-selected Worker __down.
      const effective = maxDownBytes && size > maxDownBytes ? maxDownBytes : size;
      if (effective !== size) counters.frontDownCapped = (counters.frontDownCapped || 0) + 1;
      counters.frontDownRedirects = (counters.frontDownRedirects || 0) + 1;
      const token = getOffloadToken(ip);
      if (!token) {
        // Lane 3 — mint rate-limited: degrade to a forced local serve (only
        // when the assist lane exists) instead of breaking the measurement.
        if (vpsDlBps > 0 && method === 'GET') {
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

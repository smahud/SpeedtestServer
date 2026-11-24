/**
 * front.mjs — legacy speedtest HTTP surface on the gateway, WITH edge offload.
 *
 * Serves the *light* plane of the hybrid architecture for HTTP speedtest
 * clients (speedtest-cli / mini clients):
 *
 *   - GET  /speedtest/latency.txt            → served DIRECTLY (ping = VPS)
 *   - GET  /speedtest/random{N}x{N}.jpg      → 302 → Worker /__down?bytes=N&token=…
 *   - POST /speedtest/upload.php             → drain + early answer (stock
 *                                              clients without hybrid routing)
 *   - GET  /speedtest/upload.php             → `size=0` (mini-server probe)
 *   - GET  / , /hi                           → daemon-parity banners
 *
 * DOWNLOAD payload therefore NEVER transits the VPS: the client follows the
 * 302 straight to the Cloudflare edge. UPLOAD offload for stock urllib
 * clients is impossible via redirect (urllib streams the full body before
 * reading the response), so hybrid-aware clients route their POSTs directly
 * to the Worker (`__up` + Bearer) — see hybrid/probe-client/speedtest-cli-hybrid.py.
 *
 * Security:
 *   - disabled by default (HYBRID_FRONT_ENABLED)
 *   - per-IP rate limit on token minting (HYBRID_FRONT_RATE_LIMIT_MPM)
 *   - tokens never logged; responses carry no-store
 *
 * Env:
 *   HYBRID_FRONT_ENABLED       default false
 *   HYBRID_FRONT_RATE_LIMIT_MPM default 90 (token mints per IP per minute; 0 = off)
 */

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
const FRONT_ID = 'hybrid-gateway-front/1.0';

/** Create the front router. Returns (req, res, url, ip) => boolean (handled?).
 *  ctx: { mintToken, log, counters, workerBase, rateLimitMpm }
 */
export function createFront(ctx) {
  const { mintToken, log, counters, workerBase } = ctx;
  const rateLimitMpm = Number(ctx.rateLimitMpm ?? 90);
  // Cap redirected download size at the Worker's MAX_DOWNLOAD_BYTES (deployed
  // production cap: 25 MiB). Sizes above the cap would 400 at the edge and
  // count as zero; capping keeps the bytes measurable (the client counts
  // bytes it actually receives, so the measurement stays honest).
  const maxDownBytes = Number(ctx.maxDownBytes ?? 26214400);

  // per-IP token mint rate limiting (sliding 60s window)
  const mintWindow = new Map(); // ip -> [timestamps]
  function allowMint(ip) {
    if (!rateLimitMpm) return true;
    const now = Date.now();
    const list = (mintWindow.get(ip) || []).filter((t) => now - t < 60_000);
    if (list.length >= rateLimitMpm) {
      mintWindow.set(ip, list);
      if (mintWindow.size > 10_000) mintWindow.delete(mintWindow.keys().next().value);
      return false;
    }
    list.push(now);
    mintWindow.set(ip, list);
    if (mintWindow.size > 10_000) mintWindow.delete(mintWindow.keys().next().value);
    return true;
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
    counters.frontBytesOut = (counters.frontBytesOut || 0) + 0;
    res.writeHead(status, {
      'Content-Length': 0,
      Location: location,
      'Cache-Control': 'no-store, no-transform',
      ...(close ? { Connection: 'close' } : {}),
      'X-Hybrid-Front': FRONT_ID,
    });
    res.end();
  }

  /** Mint an offload token (ip='*' by gateway policy) or null when rate limited. */
  function mintOffloadToken(ip) {
    if (!allowMint(ip)) {
      counters.frontRateLimited = (counters.frontRateLimited || 0) + 1;
      log('front_rate_limited', { ip });
      return null;
    }
    counters.frontTokensMinted = (counters.frontTokensMinted || 0) + 1;
    return mintToken('*'); // G-1 policy: wildcard IP binding
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
    const started = Date.now();
    const watchdog = setTimeout(() => {
      log('front_upload_timeout', { ip, declared, drained, ms: Date.now() - started });
      try { res.destroy(); } catch { /* noop */ }
      req.destroy();
    }, 180_000); // 3-minute drain cap per request
    req.on('data', (c) => {
      drained += c.length;
      counters.frontBytesIn = (counters.frontBytesIn || 0) + c.length;
      if (drained > 256 * 1024 * 1024) { // 256 MiB safety cap
        clearTimeout(watchdog);
        finish(res, 413, 'size=0\n', { 'Content-Type': 'text/plain; charset=UTF-8', Connection: 'close' });
        req.destroy();
      }
    });
    req.on('end', () => {
      clearTimeout(watchdog);
      log('front_upload_done', { ip, declared, drained, ms: Date.now() - started });
      finish(res, 200, `size=${drained}\n`, {
        'Content-Type': 'text/plain; charset=UTF-8',
      });
    });
    req.on('error', () => {
      clearTimeout(watchdog);
      log('front_upload_abort', { ip, declared, drained });
    });
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

    // ---- random{N}x{N}.jpg: DOWNLOAD offload → 302 → Worker __down ----
    const m = stripped.match(IMAGE_RE);
    if (m && m[1] === m[2] && (method === 'GET' || method === 'HEAD')) {
      const n = parseInt(m[1], 10);
      const size = IMAGE_SIZES[n];
      if (!size) return false; // unknown size → fall through to 404
      const effective = maxDownBytes && size > maxDownBytes ? maxDownBytes : size;
      if (effective !== size) counters.frontDownCapped = (counters.frontDownCapped || 0) + 1;
      counters.frontDownRedirects = (counters.frontDownRedirects || 0) + 1;
      const token = mintOffloadToken(ip);
      if (!token) {
        finish(res, 429, JSON.stringify({ error: 'rate-limited', retryAfterMs: 60000 }), {
          'Content-Type': 'application/json',
          Connection: 'close',
        });
        return true;
      }
      log('front_download_redirect', { ip, n, size, effective });
      // 302: urllib/others follow this with GET directly to the edge
      redirect(res, 302, `${workerBase}/__down?bytes=${effective}&token=${token.token}`);
      return true;
    }

    return false; // not a front path — let the gateway answer (404)
  };
}

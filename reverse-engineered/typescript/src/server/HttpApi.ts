/**
 * HttpApi — legacy HTTP surface of OoklaServer 2.11.5.2, byte-for-byte
 * compatible (status codes, headers, bodies, sizes) as captured from the
 * reference daemon on 2026-11-04 (see validation/PROTOCOL_CONTRACT.md and
 * the revision-3 differential probes in validation/FINDINGS.md).
 *
 * Implemented as an http.Server request handler so it plugs into the
 * single-port multiplexer (plain and TLS) and the WebSocket upgrade path.
 *
 * Verified daemon behaviors implemented here (F-15…F-22):
 *   - Header order: Date, Connection, security headers, Content-Type,
 *     Content-Length. Connection value uses daemon casing ("Close" /
 *     "Keep-Alive"); no Keep-Alive timeout header.
 *   - Host validation: the Host header (port stripped, case-insensitive)
 *     must match one of the TLS certificate's SAN entries; anything else →
 *     307 Temporary Redirect to https://<cert-CN>:<port><target>. A missing
 *     Host header → minimal 500 (status + Connection: Close only).
 *   - CSP connect-src reflects OoklaServer.allowedDomains (default "*" when
 *     unset; the three default domains are appended unless
 *     excludeDefaultDomains is true).
 *   - Requests without a User-Agent header → minimal 500 (an empty VALUE
 *     counts as present → served).
 *   - "Authorization: Bearer <token>" with a non-JWT-shaped token → minimal
 *     500 (daemon JWT parse path); Basic/other schemes are not inspected.
 *   - OPTIONS is served like HEAD but with Content-Length: 0.
 *   - PUT/DELETE/PATCH (and POST outside upload.php) → 404.
 *   - Path normalization: duplicate slashes and ./.. segments are resolved
 *     before matching (//hi, /./hi, /a/../hi, /HI/../hi all serve /hi).
 *   - Absolute-form request targets use their path component.
 *   - 404s carry the full security header set, no body, no Content-Length,
 *     no chunked framing, and close the connection.
 *   - GET /ws without an upgrade request is dropped silently.
 *   - Chunked POST bodies on upload.php get no response at all (daemon
 *     parser behavior; connection is kept until timeout).
 */

import { IncomingMessage, ServerResponse } from 'node:http';

/** Mutable certificate-host information shared with ServerCore (refreshed
 *  on TLS hot reload). */
export interface HttpHostInfo {
  allowedHosts: string[];
  certPrimaryHost: string;
}

export interface HttpApiOptions {
  versionString: string;
  pool: Buffer; // 2 MiB printable-ASCII pool [0x20..0x7F] (daemon parity F-9)
  crossDomainPorts: string; // e.g. "8080"
  maxBodyBytes: number; // upload.php body cap
  /** Certificate host info (mutable — refreshed by TLS hot reload). */
  hostInfo: HttpHostInfo;
  /** OoklaServer.allowedDomains (default ["*"]) — drives CSP connect-src. */
  allowedDomains: string[];
  /** OoklaServer.excludeDefaultDomains — suppress the default domain union. */
  excludeDefaultDomains: boolean;
  /** OoklaServer.userAgentFilterEnabled (daemon default: false — the official
   *  template ships the key commented out; verified F-26). When true, the
   *  daemon's built-in bad-User-Agent blocklist is enforced. */
  userAgentFilterEnabled?: boolean;
  onEvent?: (kind: string, detail: Record<string, unknown>) => void;
}

/** Deterministic legacy file sizes served for random{N}x{N}.jpg endpoints
 *  (fingerprint captured from the reference daemon; identical across lab,
 *  third-party and Ookla production hosts per validated captures). */
export const IMAGE_SIZES: Record<number, number> = {
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
/** Methods the reference daemon routes through its HTTP parser. TRACE is
 *  NOT among them (it falls through to the binary engine — D-2 territory). */
const HTTP_METHODS = ['GET', 'POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'CONNECT'];

/** Daemon CSP/crossdomain default domains appended to allowedDomains unless
 *  excluded (verified F-22/F-23: the same effective list drives the CSP
 *  connect-src, the crossdomain.xml entries and the CORS Origin filter). */
const CSP_DEFAULT_DOMAINS = ['*.ookla.com', '*.speedtest.net', '*.speedtestcustom.com'];

/** Effective domain list: ["*"] when unset; otherwise the configured list
 *  plus the defaults (unless excludeDefaultDomains). Order is preserved. */
export function effectiveDomains(allowedDomains: string[], excludeDefaultDomains: boolean): string[] {
  const list = Array.isArray(allowedDomains) ? allowedDomains.filter((d) => typeof d === 'string' && d.length > 0) : [];
  if (list.length === 0 || list.includes('*')) return ['*'];
  const out = [...list];
  if (!excludeDefaultDomains) {
    for (const d of CSP_DEFAULT_DOMAINS) if (!out.includes(d)) out.push(d);
  }
  return out;
}

/** CSP connect-src value from allowedDomains (verified F-22). */
export function connectSrcList(allowedDomains: string[], excludeDefaultDomains: boolean): string {
  return effectiveDomains(allowedDomains, excludeDefaultDomains).join(' ');
}

/** CORS Origin filter (verified F-23): the daemon reflects the Origin header
 *  ONLY when its host matches the effective domain list. "*.example.org"
 *  matches subdomains but NOT the bare domain; ports are ignored; matching
 *  is case-insensitive; "null" never matches (it is not a parseable URI). */
export function originAllowed(origin: string, allowedDomains: string[], excludeDefaultDomains: boolean): boolean {
  // Verified F-23 + F-37 (differential 2026-11-05, default-config lab):
  // Origin "null" is NEVER reflected — not a parseable URI — even when the
  // effective domain list is the wildcard "*". The wildcard short-circuit
  // used to run first, reflecting "null" under the DEFAULT config while the
  // daemon never does.
  if (origin === 'null') return false;
  const domains = effectiveDomains(allowedDomains, excludeDefaultDomains);
  if (domains.includes('*')) return true;
  const m = origin.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/);
  if (!m) return false;
  let host = m[1].toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  else {
    const colon = host.lastIndexOf(':');
    if (colon !== -1 && host.indexOf(':') === colon) host = host.slice(0, colon); // strip :port
  }
  for (const d of domains) {
    const pat = d.toLowerCase();
    if (pat === '*') return true;
    if (pat.startsWith('*.')) {
      if (host.endsWith('.' + pat.slice(2))) return true; // subdomain only
    } else if (host === pat) {
      return true;
    }
  }
  return false;
}

/** Loose JWT shape: three dot-separated base64url segments. */
const JWT_SHAPE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/**
 * Built-in bad-User-Agent blocklist (verified F-26, 2026-11-05).
 *
 * The 11 patterns were located as ordered string literals in the reference
 * daemon's .rodata and verified live against the running daemon with
 * `userAgentFilterEnabled = true`: every pattern is a case-sensitive
 * FULL-STRING regex match on the (OWS-trimmed) User-Agent value — literal
 * entries match only the exact string, `.*` entries match any continuation.
 * The HTTP header parser trims surrounding whitespace of the value first
 * (verified: "check_http " with a trailing space is filtered).
 */
export const UA_BLOCKLIST_PATTERNS: string[] = [
  'libcurl-.*',
  'AndroidSpeedtest',
  'Wi-Fi Maximiser',
  'SPEEDTEST_CLIENT',
  'Python-urllib',
  'ubnt-test',
  'check_http',
  'curl/.*',
  'LuaSocket.*',
  'showwin/speedtest-go.*',
  'Go-http-client/.*',
];

const UA_BLOCKLIST_RES: RegExp[] = UA_BLOCKLIST_PATTERNS.map((p) => new RegExp(`^(?:${p})$`));

/** True when the (already trimmed) User-Agent value hits the blocklist. */
export function isFilteredUserAgent(ua: string): boolean {
  return UA_BLOCKLIST_RES.some((re) => re.test(ua));
}

/** Filtered-UA 500 response (verified F-26): unlike the minimal 500 this form
 *  carries a Date header — exactly `HTTP/1.1 500 Internal Server Error\r\n
 *  Date: <date>\r\nConnection: Close\r\n\r\n`, no body, connection closed. */
function filteredUaError(socket: import('node:net').Socket | null | undefined): void {
  socket?.write(`HTTP/1.1 500 Internal Server Error\r\nDate: ${new Date().toUTCString()}\r\nConnection: Close\r\n\r\n`);
  socket?.destroy();
}

export function isHttpHead(bytes: Buffer): boolean {
  const head = bytes.toString('latin1', 0, Math.min(10, bytes.length));
  return HTTP_METHODS.some((m) => head.startsWith(m + ' '));
}

function utcDate(): string {
  return new Date().toUTCString();
}

function securityHeaders(allowedDomains: string[], excludeDefaultDomains: boolean): [string, string][] {
  return [
    ['Cache-Control', 'no-store'],
    ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', 'DENY'],
    ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
    [
      'Content-Security-Policy',
      `default-src 'none'; frame-ancestors 'none'; script-src 'none'; object-src 'none';  connect-src ${connectSrcList(allowedDomains, excludeDefaultDomains)}; upgrade-insecure-requests`,
    ],
  ];
}

/** Normalize a request path the way the daemon does before matching:
 *  collapse duplicate slashes and resolve . / .. segments (verified:
 *  //hi, /./hi, /a/../hi and /HI/../hi all serve /hi) — but KEEP a trailing
 *  slash (verified: "/hi/" is a 404, not an alias of /hi). */
export function normalizePath(pathname: string): string {
  if (!pathname.startsWith('/')) return pathname; // odd target; match verbatim
  const parts = pathname.split('/');
  const keepTrailing = parts.length > 1 && parts[parts.length - 1] === '';
  const segments: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(seg);
  }
  return '/' + segments.join('/') + (keepTrailing && segments.length > 0 ? '/' : '');
}

/** Strip scheme://authority from absolute-form request targets. */
function requestTargetPath(url: string): { target: string; path: string } {
  let target = url || '/';
  const m = target.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]+(.*)$/);
  if (m) target = m[1] || '/';
  // Split query/fragment for matching; keep the original for redirects.
  let path = target;
  const q = path.indexOf('?');
  if (q !== -1) path = path.slice(0, q);
  const f = path.indexOf('#');
  if (f !== -1) path = path.slice(0, f);
  return { target, path: normalizePath(path) };
}

function hostMatches(host: string | undefined, allowedHosts: string[]): boolean {
  if (host === undefined) return false;
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1); // [::1] → ::1
  const colon = h.lastIndexOf(':');
  if (colon !== -1 && h.indexOf(':') === colon) h = h.slice(0, colon); // strip :port (not ::1)
  for (const allowed of allowedHosts) {
    if (allowed.toLowerCase() === h) return true;
  }
  return false;
}

/** Minimal daemon error response: status line + Connection: Close only
 *  (no Date, no security headers, no body). Always speaks HTTP/1.1 in the
 *  status line — verified even for HTTP/1.0 requests. */
function minimalError(socket: import('node:net').Socket | null | undefined, reason: string): void {
  socket?.write(`HTTP/1.1 500 ${reason}\r\nConnection: Close\r\n\r\n`);
  socket?.destroy();
}

export function createRequestHandler(opts: HttpApiOptions) {
  const fallbackHosts = ['localhost', '127.0.0.1'];
  return function handle(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method || 'GET';
    const url = req.url || '/';
    const { target, path } = requestTargetPath(url);
    const ua = req.headers['user-agent'];
    const origin = req.headers['origin'] as string | undefined;
    const host = req.headers['host'];
    const authorization = req.headers['authorization'] as string | undefined;

    opts.onEvent?.('http_req', { method, path, host: host || '', ua: ua || '' });

    // Keep-alive decision (verified): "Connection: close" (or HTTP/1.0
    // without keep-alive) → "Close"; otherwise "Keep-Alive".
    const reqConn = String(req.headers['connection'] || '').toLowerCase();
    const isClose = reqConn.includes('close') || (req.httpVersion === '1.0' && !reqConn.includes('keep-alive'));
    const connMode: 'Close' | 'Keep-Alive' = isClose ? 'Close' : 'Keep-Alive';

    /**
     * Daemon-shaped response sender.
     *  mode 'get'     → Content-Length = body length, body sent
     *  mode 'head'    → Content-Length = body length, no body
     *  mode 'options' → Content-Length: 0, no body
     * Header order is fixed: Date, Connection, extras, Content-Type, Content-Length.
     */
    const respond = (
      status: number,
      body: Buffer | string,
      headers: [string, string][],
      connection: 'Close' | 'Keep-Alive',
      mode: 'get' | 'head' | 'options' = 'get',
      headLength?: number,
    ): void => {
      const bodyBuf = typeof body === 'string' ? Buffer.from(body, 'latin1') : body;
      res.setHeader('Date', utcDate());
      res.setHeader('Connection', connection);
      for (const [k, v] of headers) res.setHeader(k, v);
      res.setHeader(
        'Content-Length',
        mode === 'options' ? '0' : String(headLength !== undefined ? headLength : bodyBuf.length),
      );
      // No Content-Length → no chunked framing (daemon sends bare headers).
      res.useChunkedEncodingByDefault = false;
      res.writeHead(status);
      if (mode === 'get') res.end(bodyBuf);
      else res.end();
    };

    const commonHeaders = (): [string, string][] => {
      const headers = securityHeaders(opts.allowedDomains, opts.excludeDefaultDomains);
      // CORS Origin filter (verified F-23): reflected only when the origin's
      // host matches the effective allowedDomains list.
      if (origin && originAllowed(origin, opts.allowedDomains, opts.excludeDefaultDomains)) {
        headers.push(['Access-Control-Allow-Origin', origin], ['Vary', 'Origin']);
      }
      return headers;
    };

    const notFound = (): void => {
      // Verified 404 shape: Date, Connection: Close, security headers, NO body,
      // NO Content-Length, NO chunked framing, connection closed.
      res.setHeader('Date', utcDate());
      res.setHeader('Connection', 'Close');
      for (const [k, v] of commonHeaders()) res.setHeader(k, v);
      res.useChunkedEncodingByDefault = false;
      res.writeHead(404);
      res.end();
    };

    // ---- Request-validation chain (order verified against the daemon) ----

    // 1. Host header must be present (missing → minimal 500).
    if (host === undefined) {
      opts.onEvent?.('http_reject', { reason: 'missing_host' });
      minimalError(res.socket, 'Internal Server Error');
      return;
    }

    // 2. Host must match a certificate SAN entry (else 307 → https://<CN>).
    const allowedHosts = opts.hostInfo.allowedHosts.length > 0 ? opts.hostInfo.allowedHosts : fallbackHosts;
    const certHost = opts.hostInfo.certPrimaryHost || allowedHosts[0] || 'localhost';
    if (!hostMatches(host, allowedHosts)) {
      opts.onEvent?.('http_redirect_307', { host, to: certHost });
      res.setHeader('Date', utcDate());
      res.setHeader('Connection', 'Close');
      res.setHeader('Content-Length', '0');
      res.setHeader('Location', `https://${certHost}:${req.socket.localPort ?? 8080}${target}`);
      res.useChunkedEncodingByDefault = false;
      res.writeHead(307);
      res.end();
      return;
    }

    // 3. A User-Agent header must be present (empty value counts as present).
    if (!('user-agent' in req.headers)) {
      opts.onEvent?.('http_reject', { reason: 'missing_user_agent' });
      minimalError(res.socket, 'Internal Server Error');
      return;
    }

    // 3.5. Optional built-in bad-UA blocklist (verified F-26). Runs AFTER the
    // Host checks (a missing Host wins with the minimal 500 — verified) and
    // applies to every endpoint with the with-Date 500 form. Node's parser
    // OWS-trims header values (verified: "check_http " filters).
    if (opts.userAgentFilterEnabled && ua !== undefined && isFilteredUserAgent(String(ua).trim())) {
      opts.onEvent?.('http_reject', { reason: 'filtered_user_agent', ua: String(ua).slice(0, 80) });
      filteredUaError(res.socket);
      return;
    }

    // 4. "Authorization: Bearer <x>" with a non-JWT-shaped token → minimal 500.
    if (authorization !== undefined && authorization.startsWith('Bearer ')) {
      const token = authorization.slice(7).trim();
      if (!JWT_SHAPE_RE.test(token)) {
        opts.onEvent?.('http_reject', { reason: 'bad_bearer_token' });
        minimalError(res.socket, 'Internal Server Error');
        return;
      }
    }

    // 5. GET /ws without an upgrade request is dropped silently (verified).
    if (path === '/ws' && !req.headers.upgrade) {
      opts.onEvent?.('http_ws_plain_dropped', {});
      res.socket?.destroy();
      return;
    }

    const mode = method === 'HEAD' ? 'head' : method === 'OPTIONS' ? 'options' : 'get';

    const m = path.match(IMAGE_RE);
    if (m) {
      const n = parseInt(m[1], 10);
      if (IMAGE_SIZES[n] && m[1] === m[2] && (method === 'GET' || method === 'HEAD' || method === 'OPTIONS')) {
        const size = IMAGE_SIZES[n];
        if (method === 'GET') {
          respondStream(res, opts.pool, size, [...commonHeaders(), ['Content-Type', 'image/jpeg']], connMode);
        } else {
          // HEAD advertises the real size; OPTIONS advertises 0.
          respond(200, Buffer.alloc(0), [...commonHeaders(), ['Content-Type', 'image/jpeg']], connMode, mode, size);
        }
        return;
      }
      notFound();
      return;
    }
    if (path === '/') {
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        const body = '<html><head><title>OoklaServer</title></head><body><h1>OoklaServer</h1><p>It worked!<br /></p></body></html>\n';
        respond(200, body, [...commonHeaders(), ['Content-Type', 'text/html']], connMode, mode);
        return;
      }
      notFound();
      return;
    }
    if (path === '/hi') {
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        const body = `hello ${opts.versionString}\n`;
        respond(200, body, [...commonHeaders(), ['Content-Type', 'text/plain; charset=UTF-8']], connMode, mode);
        return;
      }
      notFound();
      return;
    }
    if (path === '/speedtest/latency.txt' || path === '/latency.txt') {
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        const body = 'test=test\n';
        respond(200, body, [...commonHeaders(), ['Content-Type', 'text/plain; charset=UTF-8']], connMode, mode);
        return;
      }
      notFound();
      return;
    }
    if (path === '/crossdomain.xml') {
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        // Verified F-23: one allow-access-from entry per effective domain
        // (allowedDomains ∪ defaults), with the request's local port.
        const domains = effectiveDomains(opts.allowedDomains, opts.excludeDefaultDomains);
        const ports = String(req.socket.localPort ?? opts.crossDomainPorts);
        const entries = domains
          .map((d) => `<allow-access-from domain="${d}" to-ports="${ports}"/>\n`)
          .join('');
        const body = `<?xml version="1.0"?>\n<cross-domain-policy>\n${entries}</cross-domain-policy>\n`;
        respond(200, body, [...commonHeaders(), ['Content-Type', 'text/xml']], connMode, mode);
        return;
      }
      notFound();
      return;
    }
    if (path === '/speedtest/upload.php' || path === '/upload.php') {
      if (method !== 'POST') {
        notFound();
        return;
      }
      // Verified daemon parser behavior: a chunked body on upload.php never
      // gets a response (the connection is held until timeout).
      const te = req.headers['transfer-encoding'];
      if (te !== undefined && String(te).toLowerCase().includes('chunked')) {
        opts.onEvent?.('http_upload_chunked_hang', {});
        req.pause();
        return;
      }
      let received = 0;
      let aborted = false;
      req.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > opts.maxBodyBytes && !aborted) {
          aborted = true;
          res.setHeader('Connection', 'Close');
          res.writeHead(413);
          res.end();
          req.destroy();
        }
      });
      req.on('end', () => {
        if (aborted) return;
        respond(200, `size=${received}\n`, [...commonHeaders(), ['Content-Type', 'text/plain; charset=UTF-8']], connMode);
      });
      req.on('error', () => {
        if (!aborted && !res.headersSent) {
          aborted = true;
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }
    notFound();
  };
}

/** Stream `size` bytes of pool data with daemon-shaped headers. */
function respondStream(
  res: ServerResponse,
  pool: Buffer,
  size: number,
  headers: [string, string][],
  connMode: 'Close' | 'Keep-Alive',
): void {
  res.setHeader('Date', utcDate());
  res.setHeader('Connection', connMode);
  for (const [k, v] of headers) res.setHeader(k, v);
  res.setHeader('Content-Length', String(size));
  res.writeHead(200);
  let off = 0;
  const CHUNK = 256 * 1024;
  const writeNext = (): void => {
    while (off < size) {
      if (res.destroyed || res.writableEnded) return;
      const len = Math.min(CHUNK, size - off);
      const out = Buffer.allocUnsafe(len);
      let pos = off % pool.length;
      for (let done = 0; done < len; ) {
        const take = Math.min(pool.length - pos, len - done);
        pool.copy(out, done, pos, pos + take);
        pos = (pos + take) % pool.length;
        done += take;
      }
      off += len;
      if (!res.write(out)) {
        res.once('drain', writeNext);
        return;
      }
    }
    res.end();
  };
  writeNext();
}

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
 *
 * Web-client (speedtest.net JS engine) surface — verified 2026-11-27 against
 * PRODUCTION OoklaServer 2.11.5 (XL) and 2.11.7 (Tuxsindo) plus real
 * captured web runs (docs/WEB_CLIENT_REVERSE_ENGINEERING_2026-11-26.md):
 *   - GET /hello → "hello <version>\n" (exact alias of /hi; both verified).
 *   - GET /getip → "<peer-ip>\n" (text/plain; the XHR twin of GETIP).
 *   - GET /capabilities → "capabilities SERVER_HOST_AUTH UPLOAD_STATS\n".
 *   - GET /ping → "pong\n" (lowercase, no timestamp, 5 bytes).
 *   - GET /download?size=N → exactly N bytes, application/octet-stream,
 *     exact Content-Length, no-store + reflected CORS Origin. Unparsable /
 *     missing / negative size: the production daemon streams its 10 GiB
 *     default (Content-Length: 10737418240, HEAD-verified) — we serve
 *     Content-Length: 0 instead (documented safety deviation, same rationale
 *     as the engine's DOWNLOAD cap refusal).
 *   - GET /upload-stats → 400 Bad Request, empty body (verified on both
 *     production versions; the web client measures uploads via the WebSocket
 *     UPLOAD_STATS command instead).
 *   - POST /upload?guid=<uuid> bodies are attributed to the upload session
 *     (UploadSessionRegistry) so the WS UPLOAD_STATS stream sees them —
 *     exactly how the real client binds its XHR uploads (verified: a real
 *     run's stats stream counted 1.14 GB of XHR-upload bytes).
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import { normalizeIp, UploadSessionRegistry } from './NetGaugeEngine';

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
  /** Slow-upload early answer (milliseconds). When a POST upload body has not
   *  fully arrived within this window, answer `size=<Content-Length>`
   *  immediately (daemon-native accounting) and close the connection instead
   *  of holding it open until the client finishes sending.
   *
   *  Why: the hosted Ookla host-tester drives its legacy upload checks with
   *  PHP curl under a 10-second CURLOPT_TIMEOUT. Its measured path to this
   *  host has delivered as little as ~19 KB/s (verified by packet capture
   *  2026-11-23: 195,757 of 1,980,899 max-upload bytes in 10.46 s), so the
   *  ~2 MiB max_upload payload cannot complete in time and the check dies
   *  with "Operation timed out after 10000 milliseconds with 0 bytes
   *  received" — the reference daemon binary holds the same full-body wait
   *  and would fail identically on that path. Answering early with the raw
   *  Content-Length is the daemon's own native upload.php accounting (the
   *  hosted tester accepted exactly that value on 2026-11-23: cl=515699 →
   *  size=515699 PASSED), and closing right after the flushed response lets
   *  the still-sending client finish immediately with the buffered response
   *  (verified with a 20 KB/s throttled client: 200 + size=… in ~1 s,
   *  curl exit 0).
   *
   *  0 disables the early answer (strict full-body parity). */
  slowUploadResponseMs?: number;
  /** Shared per-run-GUID upload byte accounting (see UploadSessionRegistry).
   *  POST upload bodies with a "?guid=<uuid>" parameter are attributed to
   *  that session so the WebSocket UPLOAD_STATS stream measures them —
   *  exactly the web client's binding (verified 2026-11-26/27). */
  uploadSessions?: UploadSessionRegistry;
  /** Per-request download cap for GET /download?size=N (default 2 GiB - 1,
   *  engine parity). Valid sizes above the cap are refused with the minimal
   *  500 (documented safety deviation — the production daemon has no observed
   *  cap; unparsable sizes there stream a 10 GiB default). */
  maxDownloadBytes?: number;
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
    const name = allowed.toLowerCase();
    if (name === h) return true;
    // A certificate wildcard covers one DNS label. The reference's wildcard
    // certificate also admitted unrelated Hosts in the 2026-11-23 lab; retain
    // the certificate boundary rather than copying that permissive behavior.
    if (name.startsWith('*.')) {
      const suffix = name.slice(1);
      if (h.endsWith(suffix)) {
        const label = h.slice(0, -suffix.length);
        if (label.length > 0 && !label.includes('.')) return true;
      }
    }
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
    // The reference dispatches these legacy endpoints by final path component,
    // including /upload, /speedtest/upload and prefixed crossdomain.xml aliases.
    const filename = path.slice(path.lastIndexOf('/') + 1);
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
    if (path === '/hi' || path === '/hello') {
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        const body = `hello ${opts.versionString}\n`;
        respond(200, body, [...commonHeaders(), ['Content-Type', 'text/plain; charset=UTF-8']], connMode, mode);
        return;
      }
      notFound();
      return;
    }
    if (path === '/getip') {
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        // Verified 2026-11-27 (production 2.11.5/2.11.7): "<peer-ip>\n",
        // text/plain; charset=UTF-8 (the XHR twin of the WS GETIP command).
        const body = `${normalizeIp(req.socket.remoteAddress || '')}\n`;
        respond(200, body, [...commonHeaders(), ['Content-Type', 'text/plain; charset=UTF-8']], connMode, mode);
        return;
      }
      notFound();
      return;
    }
    if (path === '/capabilities') {
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        const body = 'capabilities SERVER_HOST_AUTH UPLOAD_STATS\n';
        respond(200, body, [...commonHeaders(), ['Content-Type', 'text/plain; charset=UTF-8']], connMode, mode);
        return;
      }
      notFound();
      return;
    }
    if (path === '/ping') {
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        // Verified 2026-11-27 (production): lowercase "pong\n", 5 bytes, no
        // timestamp (NOT the WS PING/PONG <epoch-ms> form).
        const body = 'pong\n';
        respond(200, body, [...commonHeaders(), ['Content-Type', 'text/plain; charset=UTF-8']], connMode, mode);
        return;
      }
      notFound();
      return;
    }
    if (path === '/download') {
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        // Verified 2026-11-27 (production 2.11.5, HEAD + GET): size=N →
        // exactly N bytes, application/octet-stream, exact Content-Length,
        // no-store + reflected Origin. Missing size → CL 0; unparsable /
        // negative → the daemon streams its 10 GiB default (CL 10737418240)
        // — we serve CL 0 instead (documented safety deviation).
        const q = target.slice(target.indexOf('?') + 1);
        const sizeRaw = new URLSearchParams(q).get('size') ?? '';
        const size = /^\d{1,15}$/.test(sizeRaw) ? parseInt(sizeRaw, 10) : 0;
        const cap = opts.maxDownloadBytes ?? 0x7fffffff;
        if (size > cap) {
          opts.onEvent?.('http_download_cap_rejected', { requested: size, cap });
          minimalError(res.socket, 'Internal Server Error');
          return;
        }
        if (method === 'GET') {
          respondStream(res, opts.pool, size, [...commonHeaders(), ['Content-Type', 'application/octet-stream']], connMode);
        } else {
          respond(200, Buffer.alloc(0), [...commonHeaders(), ['Content-Type', 'application/octet-stream']], connMode, mode, size);
        }
        return;
      }
      notFound();
      return;
    }
    if (path === '/upload-stats') {
      // Verified 2026-11-27 (production 2.11.5/2.11.7): 400 Bad Request,
      // empty body — the web client measures uploads via the WebSocket
      // UPLOAD_STATS command instead.
      opts.onEvent?.('http_upload_stats_rejected', { query: target.slice(target.indexOf('?') + 1, target.indexOf('?') + 80) });
      res.setHeader('Date', utcDate());
      res.setHeader('Connection', 'Close');
      for (const [k, v] of commonHeaders()) res.setHeader(k, v);
      res.useChunkedEncodingByDefault = false;
      res.writeHead(400);
      res.end();
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
    if (filename === 'crossdomain.xml') {
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        // Verified F-23: one allow-access-from entry per effective domain
        // (allowedDomains ∪ defaults), advertising the entire configured TCP
        // listener set. A single-port fixture hid this distinction previously.
        const domains = effectiveDomains(opts.allowedDomains, opts.excludeDefaultDomains);
        const ports = opts.crossDomainPorts || String(req.socket.localPort ?? 8080);
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
    if (filename === 'upload' || filename === 'upload.php') {
      if (method === 'OPTIONS') {
        respond(200, '', [...commonHeaders(), ['Content-Type', 'text/plain; charset=UTF-8']], connMode, 'options');
        return;
      }
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
      // Slow-upload early answer (see HttpApiOptions.slowUploadResponseMs).
      // Only a known, positive Content-Length can be answered early; bodies
      // without one keep the strict full-body behavior.
      const clHeader = req.headers['content-length'];
      const clRaw = clHeader === undefined ? '' : String(clHeader).trim();
      const cl = /^\d{1,15}$/.test(clRaw) ? Number(clRaw) : undefined;
      // Web-client upload-session binding: the speedtest.net JS engine tags
      // every XHR upload with "?guid=<run-uuid>" — the same uuid it
      // registered on its WebSocket ("HI <uuid>") — and the daemon's
      // UPLOAD_STATS stream reports the session's cumulative bytes
      // (verified 2026-11-26/27 with real runs). Attribute received body
      // bytes to that session when a registry is wired.
      const guidMatch = target.match(/[?&]guid=([0-9A-Za-z][0-9A-Za-z-]{0,63})/);
      const sessionGuid = opts.uploadSessions && guidMatch ? guidMatch[1] : undefined;
      const earlyMs = opts.slowUploadResponseMs ?? 2500;
      let received = 0;
      let aborted = false;
      let settled = false;
      let earlyTimer: NodeJS.Timeout | undefined;
      const clearEarly = (): void => {
        if (earlyTimer !== undefined) {
          clearTimeout(earlyTimer);
          earlyTimer = undefined;
        }
      };
      const settleEarly = (): void => {
        if (settled || aborted || res.headersSent || res.destroyed) return;
        settled = true;
        clearEarly();
        opts.onEvent?.('http_upload_early_response', {
          contentLength: cl ?? null,
          received,
          waitedMs: earlyMs,
        });
        // Daemon-native value: the reference daemon answers upload.php with
        // the raw byte count, which for an early answer is exactly the
        // declared Content-Length.
        respond(200, `size=${cl}\n`, [...commonHeaders(), ['Content-Type', 'text/plain; charset=UTF-8']], 'Close');
        // The client may still be mid-send on a slow path. Keeping the socket
        // open would hold PHP curl until its own timeout even though the
        // response is already complete; closing right after the response
        // flush lets the client finish immediately with the buffered reply.
        res.once('finish', () => {
          setTimeout(() => {
            req.destroy();
          }, 30).unref?.();
        });
      };
      if (cl !== undefined && cl > 0 && earlyMs > 0) {
        earlyTimer = setTimeout(settleEarly, earlyMs);
        earlyTimer.unref?.();
      }
      req.on('data', (chunk: Buffer) => {
        if (settled) return;
        received += chunk.length;
        if (sessionGuid) opts.uploadSessions?.add(sessionGuid, chunk.length);
        if (received > opts.maxBodyBytes && !aborted) {
          aborted = true;
          clearEarly();
          res.setHeader('Connection', 'Close');
          res.writeHead(413);
          res.end();
          req.destroy();
        }
      });
      req.on('end', () => {
        clearEarly();
        if (aborted || settled) return;
        settled = true;
        respond(200, `size=${received}\n`, [...commonHeaders(), ['Content-Type', 'text/plain; charset=UTF-8']], connMode);
      });
      // A client that aborts mid-body (FIN or RST) can no longer receive a
      // meaningful answer: drop the connection silently — same as the daemon,
      // which cannot reply to a vanished client either.
      const dropOnAbort = (): void => {
        clearEarly();
        if (!aborted && !settled) {
          settled = true;
          res.destroy();
          req.destroy();
        }
      };
      req.on('error', dropOnAbort);
      req.on('aborted', dropOnAbort);
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

/**
 * Port-80 HTTP legacy fallback — byte-exact emulation of the official Ookla
 * `http_legacy_fallback.zip` site (Apache + stock PHP 8 running the unmodified
 * 2007 `speedtest/upload.php`), as consumed by the Ookla hosted Server Tester.
 *
 * Never apply this PHP accounting to the native daemon's own ports: the daemon
 * keeps its raw-Content-Length `size=` parity with the reference OoklaServer
 * binary (see HttpApi.ts); this service only owns the legacy HTTP surface.
 *
 * Verified $_REQUEST semantics (differential vs PHP 8.4 CLI + official script,
 * 2026-11-23, validation/HTTP_UPLOAD_PHP_PARITY_2026-11-23.md):
 *   - The script runs for EVERY HTTP method (GET/HEAD/PUT/DELETE/OPTIONS/...);
 *     only a POST body is form-parsed.
 *   - $_GET is always parsed from the query string; the POST body contributes
 *     only when Content-Type starts with `application/x-www-form-urlencoded`
 *     (prefix + case-insensitive; `; charset=…` suffixes still parse) or
 *     `multipart/form-data` (scalar fields count, file parts go to $_FILES
 *     and are NOT counted).
 *   - request_order="GP": POST overrides GET per key.
 *   - Any other/missing Content-Type leaves $_POST empty → size=500+GET.
 *   - post_max_size (8M): a body at or below 8 MiB parses; beyond it the
 *     whole POST pass is discarded (200 + size=500+GET, never a 413).
 *   - Response: `size=<n>` with no trailing newline, PHP default mimetype
 *     `text/html; charset=UTF-8` (matches the 2019 hosted-tester capture of
 *     Apache/PHP answering `size=516300`, Content-Length: 11).
 *
 * Every request is logged as one compact JSON line so a hosted Ookla Server
 * Tester run leaves reviewable evidence in `journalctl -u speedtestserver-legacy`.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { PhpFormCounter } from './PhpFormCounter';

// PHP post_max_size default (8M): bodies at or below this parse; larger bodies
// discard the whole POST pass. Percent encoding can triple the ~2 MiB maximum
// hosted-tester payload on the wire, which still fits.
const BODY_CAP = 8 * 1024 * 1024;
// Bodies that cannot contribute to $_REQUEST are still drained so the client
// sees a clean response; bounded to keep abuse expensive but finite.
const DRAIN_CAP = 64 * 1024 * 1024;
const IMAGE = /^\/speedtest\/random(350|500|750|1000|1500|2000|2500|3000|3500|4000)x\1\.jpg$/;
const UPLOAD_PATHS = new Set(['/speedtest/upload.php', '/upload.php']);
// PHP prefix match (verified: "; charset=UTF-8", no-space ";charset=utf8" and a
// trailing space all still parse the body).
const FORM_CT = /^application\/x-www-form-urlencoded/i;
const MULTIPART_CT = /^multipart\/form-data/i;

/** Parse a multipart/form-data body into PHP $_POST semantics (scalar fields
 *  only; file parts belong to $_FILES and never reach $_REQUEST). */
function parseMultipart(body: Buffer, contentType: string): PhpFormCounter {
  const counter = new PhpFormCounter();
  const m = contentType.match(/boundary\s*=\s*"?([^";]+)"?/i);
  if (!m) return counter; // no boundary → PHP registers no variables
  const delim = Buffer.from(`--${m[1]}`);
  // Split on CRLF?--boundary lines. The first delimiter may sit at the start
  // (no leading CRLF); the terminal delimiter is followed by "--".
  let pos = body.indexOf(delim);
  if (pos === -1) return counter;
  if (pos !== 0 && pos < 2) return counter;
  if (pos !== 0) pos = pos - 2; // include the preceding CRLF in the skip
  while (pos !== -1) {
    let lineEnd = pos + delim.length;
    if (body.slice(lineEnd, lineEnd + 2).toString('latin1') === '--') break; // final boundary
    // Expect CRLF right after the boundary line.
    if (body.slice(lineEnd, lineEnd + 2).toString('latin1') !== '\r\n') break;
    const headStart = lineEnd + 2;
    const headEnd = body.indexOf('\r\n\r\n', headStart);
    if (headEnd === -1) break;
    const headers = body.slice(headStart, headEnd).toString('latin1');
    let next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delim]), headEnd + 4);
    const valueEnd = next === -1 ? body.length : next;
    const value = body.slice(headEnd + 4, valueEnd);
    const dispo = headers
      .split('\r\n')
      .find((h) => /^content-disposition\s*:/i.test(h));
    if (dispo) {
      const nameM = dispo.match(/name\s*=\s*"((?:[^"\\]|\\.)*)"/i) ?? dispo.match(/name\s*=\s*([^;\s]+)/i);
      const fileM = /filename\s*=\s*/i.test(dispo);
      // File parts land in $_FILES, not $_REQUEST: never counted.
      if (nameM && !fileM) counter.addField(nameM[1].replace(/\\(.)/g, '$1'), value.length);
    }
    if (next === -1) break;
    pos = next + 2; // skip CRLF, land on "--boundary"
  }
  return counter;
}

export function createLegacyFallback(assets: string): http.Server {
  const server = http.createServer({ maxHeaderSize: 16384 }, (req, res) => {
    const target = (req.url ?? '').split('#')[0];
    const qpos = target.indexOf('?');
    const pathOnly = qpos === -1 ? target : target.slice(0, qpos);
    const query = qpos === -1 ? '' : target.slice(qpos + 1);
    const started = Date.now();

    // Apache-style Connection token casing ("Keep-Alive" / "close").
    const reqConn = String(req.headers['connection'] || '').toLowerCase();
    const isClose = reqConn.includes('close') || (req.httpVersion === '1.0' && !reqConn.includes('keep-alive'));

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const send = (status: number, body: string, contentType = 'text/plain; charset=UTF-8'): void => {
      res.setHeader('Connection', isClose ? 'close' : 'Keep-Alive');
      res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
    };

    const logLine = (status: number, note = ''): void => {
      console.log(
        JSON.stringify({
          t: new Date().toISOString(),
          kind: 'legacy_req',
          peer: req.socket.remoteAddress ?? '',
          method: req.method,
          target: target.slice(0, 512),
          ct: String(req.headers['content-type'] ?? '').slice(0, 120),
          cl: String(req.headers['content-length'] ?? ''),
          ua: String(req.headers['user-agent'] ?? '').slice(0, 120),
          status,
          ms: Date.now() - started,
          note,
        }),
      );
    };

    // ---- upload.php: the PHP script runs for EVERY method ----------------
    if (UPLOAD_PATHS.has(pathOnly)) {
      // $_GET: always parsed from the query string (same decoding rules).
      const getPass = new PhpFormCounter();
      try {
        if (query) getPass.write(Buffer.from(query, 'latin1'));
        getPass.finish();
      } catch {
        /* bounded by maxHeaderSize; fall back to no GET fields */
      }

      const ct = String(req.headers['content-type'] ?? '');
      const isForm = FORM_CT.test(ct);
      const isMultipart = MULTIPART_CT.test(ct);
      const declared = Number(req.headers['content-length'] ?? 0);
      // PHP checks the declared Content-Length against post_max_size upfront.
      const overCap = Number.isFinite(declared) && declared > BODY_CAP;

      const respond = (postPass: PhpFormCounter | null): void => {
        const effective = postPass ?? new PhpFormCounter();
        const size = effective.mergedSize(getPass);
        if (size < 0) {
          // PHP 8 fatal: strlen() on an array value (e.g. a[x]=1).
          logLine(500, 'array value: strlen() fatal');
          res.setHeader('Connection', 'close');
          res.writeHead(500, { 'Content-Type': 'text/html; charset=UTF-8' });
          res.end(req.method === 'HEAD' ? undefined : '');
          return;
        }
        logLine(200, `size=${size}`);
        send(200, `size=${size}`, 'text/html; charset=UTF-8');
      };

      const drainAndRespond = (): void => {
        let drained = 0;
        req.on('data', (chunk: Buffer) => {
          drained += chunk.length;
          if (drained > DRAIN_CAP) req.destroy();
        });
        req.on('end', () => respond(null));
        req.on('error', () => {
          if (!res.headersSent) respond(null);
        });
      };

      if (req.method !== 'POST' || (!isForm && !isMultipart) || overCap) {
        // Body cannot contribute to $_REQUEST: PUT/other methods, non-form
        // content types, or post_max_size exceeded → GET-only accounting.
        drainAndRespond();
        return;
      }

      if (isMultipart) {
        const parts: Buffer[] = [];
        let total = 0;
        let exceeded = false;
        req.on('data', (chunk: Buffer) => {
          if (exceeded) return;
          total += chunk.length;
          if (total > BODY_CAP) exceeded = true;
          else parts.push(chunk);
        });
        req.on('error', () => {
          if (!res.headersSent) respond(null);
        });
        req.on('end', () => {
          if (exceeded) {
            respond(null); // post_max_size: $_POST and $_FILES are both empty
            return;
          }
          let postPass: PhpFormCounter;
          try {
            postPass = parseMultipart(Buffer.concat(parts), ct);
          } catch {
            postPass = new PhpFormCounter();
          }
          respond(postPass);
        });
        return;
      }

      // application/x-www-form-urlencoded: stream through the counter.
      const postPass = new PhpFormCounter();
      let total = 0;
      let exceeded = false;
      req.on('data', (chunk: Buffer) => {
        if (exceeded) return;
        total += chunk.length;
        if (total > BODY_CAP) {
          exceeded = true; // streamed body crossed post_max_size mid-flight
          return;
        }
        try {
          postPass.write(chunk);
        } catch {
          /* malformed input: keep what was counted so far */
        }
      });
      req.on('error', () => {
        if (!res.headersSent) respond(null);
      });
      req.on('end', () => {
        // Commit the buffered final field: without finish() the last
        // key=value pair never reaches `fields` and every POST reports
        // the bare 500 base (regression found 2026-11-23).
        if (!exceeded) {
          try { postPass.finish(); } catch { respond(null); return; }
        }
        respond(exceeded ? null : postPass);
      });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(405, 'Method not allowed');
      logLine(405);
      req.resume();
      return;
    }
    if (target === '/crossdomain.xml' || pathOnly === '/crossdomain.xml') {
      send(
        200,
        '<?xml version="1.0"?>\n<cross-domain-policy><allow-access-from domain="*.speedtest.net"/><allow-access-from domain="*.ookla.com"/><allow-access-from domain="*.speedtestcustom.com"/></cross-domain-policy>\n',
        'text/xml',
      );
      logLine(200);
      return;
    }
    if (pathOnly === '/speedtest/latency.txt') {
      send(200, 'test=test\n');
      logLine(200);
      return;
    }
    if (!IMAGE.test(pathOnly)) {
      send(404, 'Not found');
      logLine(404);
      return;
    }
    const file = path.join(assets, pathOnly.slice(1));
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        send(404, 'Not found');
        logLine(404);
        return;
      }
      res.setHeader('Connection', isClose ? 'close' : 'Keep-Alive');
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': stat.size });
      logLine(200);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      pipeline(fs.createReadStream(file), res, () => {
        /* pipeline closes streams on disconnect */
      });
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 10000;
  server.maxConnections = 64;
  return server;
}

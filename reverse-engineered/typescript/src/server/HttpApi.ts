/**
 * HttpApi — legacy HTTP surface of OoklaServer 2.11.5.2, byte-for-byte
 * compatible (status codes, headers, bodies, sizes) as captured from the
 * reference daemon on 2026-11-04 (see validation/PROTOCOL_CONTRACT.md).
 *
 * Implemented as an http.Server request handler so it plugs into the
 * single-port multiplexer (plain and TLS) and the WebSocket upgrade path.
 */

import { IncomingMessage, ServerResponse } from 'node:http';

export interface HttpApiOptions {
  versionString: string;
  pool: Buffer; // 2 MiB random pool
  crossDomainPorts: string; // e.g. "8080"
  maxBodyBytes: number; // upload.php body cap
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
const HTTP_METHODS = ['GET', 'POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'TRACE'];

export function isHttpHead(bytes: Buffer): boolean {
  const head = bytes.toString('latin1', 0, Math.min(10, bytes.length));
  return HTTP_METHODS.some((m) => head.startsWith(m + ' '));
}

function securityHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy':
      "default-src 'none'; frame-ancestors 'none'; script-src 'none'; object-src 'none';  connect-src *; upgrade-insecure-requests",
  };
}

export function createRequestHandler(opts: HttpApiOptions) {
  return function handle(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method || 'GET';
    const url = req.url || '/';
    const path = url.split('?')[0];
    const ua = req.headers['user-agent'];
    const origin = req.headers['origin'] as string | undefined;

    opts.onEvent?.('http_req', { method, path, ua: ua || '' });

    const applyCommon = (): void => {
      for (const [k, v] of Object.entries(securityHeaders())) res.setHeader(k, v);
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
    };

    if (!ua) {
      // Reference daemon core behavior: requests without a User-Agent → 500.
      applyCommon();
      res.setHeader('Connection', 'close');
      res.writeHead(500);
      res.end();
      return;
    }

    const m = path.match(IMAGE_RE);
    if (m) {
      const n = parseInt(m[1], 10);
      if (IMAGE_SIZES[n] && m[1] === m[2]) {
        applyCommon();
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Content-Length', String(IMAGE_SIZES[n]));
        res.writeHead(200);
        if (method === 'HEAD') {
          res.end();
          return;
        }
        streamPool(res, opts.pool, IMAGE_SIZES[n]);
        return;
      }
      res.setHeader('Connection', 'close');
      res.writeHead(404);
      res.end();
      return;
    }
    if (path === '/') {
      applyCommon();
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><head><title>OoklaServer</title></head><body><h1>OoklaServer</h1><p>It worked!<br /></p></body></html>\n');
      return;
    }
    if (path === '/hi') {
      applyCommon();
      res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
      res.end(`hello ${opts.versionString}\n`);
      return;
    }
    if (path === '/speedtest/latency.txt' || path === '/latency.txt') {
      applyCommon();
      res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
      res.end('test=test\n');
      return;
    }
    if (path === '/crossdomain.xml') {
      applyCommon();
      res.setHeader('Content-Type', 'text/xml');
      res.end(
        `<?xml version="1.0"?>\n<cross-domain-policy>\n<allow-access-from domain="*" to-ports="${opts.crossDomainPorts}"/>\n</cross-domain-policy>\n`,
      );
      return;
    }
    if (path === '/speedtest/upload.php' || path === '/upload.php') {
      if (method !== 'POST') {
        res.setHeader('Connection', 'close');
        res.writeHead(404);
        res.end();
        return;
      }
      let received = 0;
      let aborted = false;
      req.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > opts.maxBodyBytes && !aborted) {
          aborted = true;
          res.setHeader('Connection', 'close');
          res.writeHead(413);
          res.end();
          req.destroy();
        }
      });
      req.on('end', () => {
        if (aborted) return;
        applyCommon();
        res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
        res.end(`size=${received}\n`);
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
    res.setHeader('Connection', 'close');
    res.writeHead(404);
    res.end();
  };
}

function streamPool(res: ServerResponse, pool: Buffer, size: number): void {
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

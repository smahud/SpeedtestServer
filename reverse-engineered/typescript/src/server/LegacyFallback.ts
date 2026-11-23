/** HTTP fallback is a separate service: never apply PHP accounting to NetGauge's native upload. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { PhpFormCounter } from './PhpFormCounter';

// Percent encoding can triple the ~2 MiB maximum test payload on the wire.
// Match the reference PHP default post_max_size while keeping values streamed.
const BODY_CAP = 8 * 1024 * 1024;
const IMAGE = /^\/speedtest\/random(350|500|750|1000|1500|2000|2500|3000|3500|4000)x\1\.jpg$/;

export function createLegacyFallback(assets: string): http.Server {
  const server = http.createServer({ maxHeaderSize: 16384 }, (req, res) => {
    const target = (req.url ?? '').split('?')[0];
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status: number, body: string, contentType = 'text/plain; charset=UTF-8'): void => {
      res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method === 'POST' && (target === '/speedtest/upload.php' || target === '/upload.php')) {
      if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(String(req.headers['content-type'] ?? ''))) {
        send(415, 'Expected application/x-www-form-urlencoded');
        req.resume();
        return;
      }
      let total = 0;
      let rejected = false;
      const counter = new PhpFormCounter();
      const rejectBody = (): void => {
        rejected = true;
        res.setHeader('Connection', 'close');
        send(413, 'Payload too large');
      };
      const rejectForm = (): void => {
        rejected = true;
        res.setHeader('Connection', 'close');
        send(400, 'Invalid or oversized form field name');
      };
      if (Number(req.headers['content-length'] ?? 0) > BODY_CAP) {
        rejectBody();
        req.resume();
        return;
      }
      req.on('data', (chunk: Buffer) => {
        if (rejected) return;
        total += chunk.length;
        if (total > BODY_CAP) rejectBody();
        else {
          try { counter.write(chunk); }
          catch { rejectForm(); }
        }
      });
      req.on('error', () => { res.destroy(); });
      req.on('end', () => {
        if (rejected) return;
        try { counter.finish(); }
        catch { rejectForm(); return; }
        send(200, `size=${counter.size()}`);
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(405, 'Method not allowed');
      req.resume();
      return;
    }
    if (target === '/crossdomain.xml') {
      send(200, '<?xml version="1.0"?>\n<cross-domain-policy><allow-access-from domain="*.speedtest.net"/><allow-access-from domain="*.ookla.com"/><allow-access-from domain="*.speedtestcustom.com"/></cross-domain-policy>\n', 'text/xml');
      return;
    }
    if (target === '/speedtest/latency.txt') { send(200, 'test=test\n'); return; }
    if (!IMAGE.test(target)) { send(404, 'Not found'); return; }
    const file = path.join(assets, target.slice(1));
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) { send(404, 'Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': stat.size });
      if (req.method === 'HEAD') { res.end(); return; }
      pipeline(fs.createReadStream(file), res, () => { /* pipeline closes streams on disconnect */ });
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 10000;
  server.maxConnections = 64;
  return server;
}

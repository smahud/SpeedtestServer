#!/usr/bin/env node
/**
 * fake-worker.mjs — minimal stand-in for a pool worker, used ONLY by
 * e2e-pool-test.sh to drive the gateway's autoscaler (workerd cannot run
 * two simultaneous `wrangler dev` instances). Implements the exact surface
 * the pool manager consumes:
 *   GET /__down?bytes=0            → 200 (canary health probe)
 *   GET /__down?bytes=N&token=...  → 200 + N bytes (real bytes streamed)
 *   GET /__meta                    → { worker: { id, poolMax } }
 *   POST /__up                     → { bytes: N } (drain)
 * "broken" mode: /__down?bytes=0 → 500 (canary failure → the gateway benches
 * this worker instead of activating it).
 *
 * Usage: node fake-worker.mjs <port> <workerId> [broken]
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || 18991);
const ID = Number(process.argv[3] || 1);
const BROKEN = process.argv[4] === 'broken';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/__meta' || url.pathname === '/__health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ server: `fake-worker/${ID}`, worker: { id: ID, poolMax: 3, inFlight: 0, loadHintPerMin: 0 } }));
    return;
  }
  if (url.pathname === '/__down') {
    const bytes = Number(url.searchParams.get('bytes') || 0);
    if (BROKEN && bytes === 0) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"canary-broken"}');
      return;
    }
    if (bytes === 0) {
      res.writeHead(200, { 'Content-Length': '0', 'X-Hybrid-Server': `fake-worker/${ID}` });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Length': String(bytes), 'Content-Type': 'application/octet-stream', 'X-Hybrid-Server': `fake-worker/${ID}` });
    const CHUNK = 256 * 1024;
    let sent = 0;
    const iv = setInterval(() => {
      if (sent >= bytes) {
        clearInterval(iv);
        res.end();
        return;
      }
      const len = Math.min(CHUNK, bytes - sent);
      res.write(Buffer.alloc(len, 0x41));
      sent += len;
    }, 5);
    req.on('close', () => clearInterval(iv));
    return;
  }
  if (url.pathname === '/__up' && req.method === 'POST') {
    let n = 0;
    req.on('data', (c) => (n += c.length));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ bytes: n }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({ kind: 'fake_worker_started', port: PORT, id: ID, broken: BROKEN }));
});

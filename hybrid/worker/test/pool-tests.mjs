#!/usr/bin/env node
/**
 * pool-tests.mjs — worker-pool feature tests (2026-11-25).
 *
 * Run: node test/pool-tests.mjs <base> [secret]
 *
 * Requires a `wrangler dev` instance started with:
 *   --var HYBRID_SHARED_SECRET:<secret> --var WORKER_ID:1
 *   --var WORKER_POOL_MAX:2 --var WORKER_DEFLECT_CONCURRENCY:0
 * (CONCURRENCY 0 = always saturated → deterministic deflection checks.)
 *
 * Checks:
 *   P1 /__meta exposes worker identity + pool fields
 *   P2 anonymous requests are NOT deflected (they 401 first)
 *   P3 authenticated __down is deflected (302) to the sibling URL with hop=1
 *   P4 a request already carrying hop=1 is served locally (loop guard)
 *   P5 WS upgrades answer 503 + Location when saturated (hop-guarded)
 *   P6 UPLOAD inclusive counting uses the WIRE length (no-newline frames)
 *
 * NOTE P3/P5 use RAW http requests: undici's fetch() silently ignores a
 * custom Host header (verified), and the deflection target is derived from
 * the workers.dev-shaped Host the client sends.
 */

import http from 'node:http';
import crypto from 'node:crypto';

const BASE = process.argv[2] || 'http://127.0.0.1:8791';
const SECRET = process.env.TOKEN_TEST_SECRET || process.argv[3] || 'testsecret123';
const PORT = Number(new URL(BASE).port);
const POOL_HOST = 'speedtest-hybrid-worker.example.workers.dev';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function token() {
  const guid = crypto.randomUUID();
  const expMs = Date.now() + 300000;
  return `v1~${guid}~${expMs}~*~${await hmac(SECRET, `v1|${guid}|${expMs}|*`)}`;
}

/** Raw request with full control over the Host header. */
function rawReq(path, headers = {}, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    // node:http emits 'upgrade' (not 'response') for 101 protocol switches.
    r.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: 101, headers: res.headers, body: '' });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const meta = await (await fetch(`${BASE}/__meta`)).json();
check('P1 /__meta exposes worker identity + pool fields', meta.worker && meta.worker.id === 1 && meta.worker.poolMax === 2 && typeof meta.worker.inFlight === 'number', JSON.stringify(meta.worker || {}));

{
  // P2: anonymous — no redirect, straight 401.
  const r = await rawReq('/__down?bytes=1024', { Host: POOL_HOST });
  check('P2 anonymous __down NOT deflected (401, no Location)', r.status === 401 && !r.headers.location, `got ${r.status}`);
}
{
  // P3: authenticated + saturated (CONCURRENCY 0) → 302 to sibling with hop=1.
  const t = await token();
  const r = await rawReq(`/__down?bytes=1024&token=${t}`, { Host: POOL_HOST });
  const loc = r.headers.location || '';
  check(
    'P3 saturated __down deflected 302 → sibling URL + hop=1',
    r.status === 302 && /-2\.[a-z0-9.-]*workers\.dev/.test(loc) && /hop=1/.test(loc),
    `status=${r.status} loc=${loc.slice(0, 80)}`,
  );
}
{
  // P4: hop=1 already present → served locally (loop guard).
  const t = await token();
  const r = await rawReq(`/__down?bytes=1024&token=${t}&hop=1`, { Host: POOL_HOST });
  check('P4 hop=1 request served locally (no redirect loop)', r.status === 200 && !r.headers.location, `status=${r.status}`);
  check('P4 local serve streams exactly 1024 bytes', Number(r.headers['content-length']) === 1024, `${r.headers['content-length']}`);
}
{
  // P5: WS upgrade while saturated → 503 + Location (no upgrade attempted).
  const t = await token();
  const r = await rawReq(`/ws?token=${t}`, { Host: POOL_HOST, Upgrade: 'websocket', Connection: 'Upgrade' });
  check(
    'P5 saturated WS upgrade → 503 + Location',
    r.status === 503 && Boolean(r.headers.location) && /-2\.[a-z0-9.-]*workers\.dev/.test(r.headers.location || ''),
    `status=${r.status} loc=${(r.headers.location || '').slice(0, 60)}`,
  );
  // hop=1 guard also applies to the WS lane (full upgrade headers needed):
  const r2 = await rawReq(`/ws?token=${t}&hop=1`, {
    Host: POOL_HOST,
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
    'Sec-WebSocket-Version': '13',
  });
  check('P5b saturated WS WITH hop=1 proceeds (101 upgrade)', r2.status === 101, `status=${r2.status}`);
}

// P6: WS UPLOAD wire-length counting (no-newline frames). Uses hop=1 to
// bypass the (deliberately saturated) deflection lane and exercise the
// engine directly.
try {
  const t = await token();
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${t}&hop=1`);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws open failed')), { once: true });
    setTimeout(() => rej(new Error('ws open timeout')), 5000);
  });
  const lines = [];
  ws.addEventListener('message', (ev) => lines.push(typeof ev.data === 'string' ? ev.data : '[bin]'));
  await new Promise((r) => setTimeout(r, 300));
  // "UPLOAD 11" with NO trailing newline (9 wire bytes) + 2 payload bytes = 11 total.
  ws.send('UPLOAD 11');
  await new Promise((r) => setTimeout(r, 150));
  ws.send('XY');
  await new Promise((r) => setTimeout(r, 400));
  const okLine = lines.find((l) => /^OK 11 \d+/.test(l));
  check('P6 UPLOAD no-newline frame counts WIRE bytes (OK 11)', Boolean(okLine), JSON.stringify(lines.slice(0, 5)));
  ws.close();
} catch (e) {
  check('P6 UPLOAD no-newline frame counts WIRE bytes (OK 11)', false, String(e).slice(0, 120));
}

console.log(`\n== POOL RESULT: ${passed} passed, ${failed} failed ==`);
process.exit(failed ? 1 : 0);

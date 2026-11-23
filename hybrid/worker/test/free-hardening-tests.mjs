#!/usr/bin/env node
/**
 * free-hardening-tests.mjs — Free-plan hardening battery (G-4, G-5, G-7).
 *
 * Runs against an instance configured with:
 *   --var HYBRID_SHARED_SECRET:<secret>
 *   --var MAX_DOWNLOAD_BYTES:<dl> --var MAX_UPLOAD_BYTES:<ul>
 *   (LEGACY_HTTP_ENABLED unset/false — production posture)
 * Env:
 *   TOKEN_TEST_SECRET (default testsecret123)
 *   TEST_MAX_DL       (default 26214400) — must match the instance's MAX_DOWNLOAD_BYTES
 *   TEST_MAX_UL       (default 26214400) — must match the instance's MAX_UPLOAD_BYTES
 *   TOKEN_TEST_IP     (default 127.0.0.1)
 *
 * Usage: node test/free-hardening-tests.mjs [baseURL]
 */
import { createHmac } from 'node:crypto';
import http from 'node:http';

const BASE = process.argv[2] || 'http://127.0.0.1:8791';
const SECRET = process.env.TOKEN_TEST_SECRET || 'testsecret123';
const TOKEN_IP = process.env.TOKEN_TEST_IP || '127.0.0.1';
const MAX_DL = Number(process.env.TEST_MAX_DL || 26214400);
const MAX_UL = Number(process.env.TEST_MAX_UL || 26214400);

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function token(ip = TOKEN_IP, ttl = 60000) {
  const guid = 'eeeeeeee-2222-3333-4444-555555555555';
  const exp = Date.now() + ttl;
  const sig = createHmac('sha256', SECRET).update(`v1|${guid}|${exp}|${ip}`).digest('hex');
  return `v1~${guid}~${exp}~${ip}~${sig}`;
}

/** Raw HTTP request with a LYING Content-Length (undici refuses those).
 * Returns {status} as soon as response headers arrive; socket is destroyed. */
function rawRequestLieCL(path, method, contentLength, bodyChunk) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port || 80,
        path,
        method,
        headers: { 'Content-Length': String(contentLength), 'User-Agent': 'free-hardening/1.0' },
        setHost: true,
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode });
        req.destroy();
      },
    );
    req.on('error', () => resolve(null));
    if (bodyChunk) req.write(bodyChunk);
    // do NOT end with the full declared length — the server must reject early
    req.flushHeaders();
    setTimeout(() => {
      req.destroy();
      resolve(null);
    }, 8000);
  });
}

// --- G-4: download cap ------------------------------------------------------
{
  const r = await fetch(`${BASE}/__down?bytes=${MAX_DL + 1}&token=${token()}`);
  check(`__down bytes>MAX (${MAX_DL + 1}) → 400`, r.status === 400, `got ${r.status}`);
  await r.text();
}
{
  const r = await fetch(`${BASE}/__down?bytes=abc&token=${token()}`);
  check('__down bytes=abc → 400', r.status === 400, `got ${r.status}`);
  await r.text();
}
{
  // exact 1 MiB within cap is allowed and streams the exact total
  const r = await fetch(`${BASE}/__down?bytes=1048576&token=${token()}`);
  const buf = await r.arrayBuffer();
  check('__down 1 MiB → 200 + exactly 1048576 bytes', r.status === 200 && buf.byteLength === 1048576, `got ${r.status} ${buf.byteLength}`);
  const view = new Uint8Array(buf);
  let printable = 0;
  for (let i = 0; i < view.length; i++) if (view[i] >= 0x20 && view[i] <= 0x7f) printable++;
  check('__down payload is printable-ASCII pool data (F-9 parity)', printable === view.length, `${printable}/${view.length}`);
  check('__down has Cache-Control: no-store, no-transform', /no-store/.test(r.headers.get('cache-control') || '') && /no-transform/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control'));
}
{
  // HEAD works at cap boundary
  const r = await fetch(`${BASE}/__down?bytes=${MAX_DL}&token=${token()}`, { method: 'HEAD' });
  check(`HEAD __down at MAX (${MAX_DL}) → 200`, r.status === 200, `got ${r.status}`);
}

// --- G-4: upload cap --------------------------------------------------------
{
  // within-cap body is counted exactly
  const body = new Uint8Array(4096);
  crypto.getRandomValues(body);
  const r = await fetch(`${BASE}/__up?token=${token()}`, { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  check('__up 4 KiB within cap → {bytes:4096}', r.status === 200 && j.bytes === 4096, JSON.stringify(j));
}
{
  // over-cap body (real bytes): only valid when MAX_UL < 8 MiB, else skipped
  if (MAX_UL < 8 * 1024 * 1024) {
    const body = new Uint8Array(MAX_UL + 4096);
    const r = await fetch(`${BASE}/__up?token=${token()}`, { method: 'POST', body });
    check(`__up body MAX+4KiB (${body.byteLength}) → 413`, r.status === 413, `got ${r.status}`);
    await r.text().catch(() => {});
  } else {
    console.log(`  – __up body over cap skipped (MAX_UL=${MAX_UL} ≥ 8 MiB; lying-CL test below covers the early path)`);
  }
}
{
  // early Content-Length rejection — raw socket with declared CL > MAX and a
  // tiny partial body; the Worker must answer 413 without draining anything.
  // NOTE: local workerd does not flush a response while the request body is
  // still inbound (verified 2026-11-24: no early response in 20 s), so this
  // check only runs against the REAL edge — set EDGE_EARLY_RESPONSE=1.
  if (process.env.EDGE_EARLY_RESPONSE === '1') {
    const r = await rawRequestLieCL(`/__up?token=${token()}`, 'POST', MAX_UL + 1, new Uint8Array(16));
    check(`__up lying Content-Length>MAX (${MAX_UL + 1}) → 413 early`, r && r.status === 413, r ? `got ${r.status}` : 'no response');
  } else {
    console.log('  – __up early lying-CL check skipped locally (workerd holds responses until body completes; run with EDGE_EARLY_RESPONSE=1 against the real edge)');
  }
}

// --- G-7: legacy surface OFF by default --------------------------------------
{
  const paths = ['/', '/hi', '/latency.txt', '/crossdomain.xml', '/upload.php', '/speedtest/random350x350.jpg'];
  for (const p of paths) {
    const r = await fetch(BASE + p, { redirect: 'manual' });
    const ok = r.status === 404;
    check(`legacy ${p} with LEGACY_HTTP_ENABLED unset → 404`, ok, `got ${r.status}`);
    await r.text();
  }
}
{
  const body = new Uint8Array(4096);
  const r = await fetch(BASE + '/speedtest/upload.php', { method: 'POST', body });
  check('legacy upload.php POST with surface off → 404', r.status === 404, `got ${r.status}`);
  await r.text();
}

// --- /__meta reachable without token (observability) -------------------------
{
  const r = await fetch(BASE + '/__meta');
  const j = await r.json().catch(() => ({}));
  check('/__meta without token → 200 JSON', r.status === 200 && Boolean(j.server), JSON.stringify(j).slice(0, 80));
}

console.log(`\n== FREE-HARDENING RESULT: ${pass} passed, ${fail} failed ==`);
if (failures.length) {
  console.log('failed:', failures.join(' | '));
  process.exit(1);
}

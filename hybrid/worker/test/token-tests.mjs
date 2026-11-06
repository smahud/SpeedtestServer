#!/usr/bin/env node
/**
 * token-tests.mjs — session-token enforcement battery against a Worker
 * instance started with HYBRID_SHARED_SECRET=testsecret123.
 *
 * Usage: node test/token-tests.mjs [baseURL]
 */
import { createHmac } from 'node:crypto';

const SECRET_BASE = process.argv[2] || 'http://127.0.0.1:8791';
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

const secret = 'testsecret123';
const guid = '11111111-2222-3333-4444-555555555555';
const exp = Date.now() + 60000;
const sig = createHmac('sha256', secret).update(`v1|${guid}|${exp}|127.0.0.1`).digest('hex');
const token = `v1~${guid}~${exp}~127.0.0.1~${sig}`;

{
  const r = await fetch(SECRET_BASE + '/__down?bytes=10');
  check('__down without token → 401', r.status === 401, `got ${r.status}`);
}
{
  const r = await fetch(SECRET_BASE + `/__down?bytes=10&token=${token}`);
  check('__down with valid token → 200 + 10 bytes', r.status === 200 && (await r.arrayBuffer()).byteLength === 10, `got ${r.status}`);
}
{
  const r = await fetch(SECRET_BASE + `/__down?bytes=10&token=${token}x`);
  check('__down with tampered token → 401', r.status === 401, `got ${r.status}`);
}
{
  const guid2 = '99999999-2222-3333-4444-555555555555';
  const sig2 = createHmac('sha256', secret).update(`v1|${guid2}|${Date.now() - 1000}|127.0.0.1`).digest('hex');
  const expired = `v1~${guid2}~${Date.now() - 1000}~127.0.0.1~${sig2}`;
  const r = await fetch(SECRET_BASE + `/__down?bytes=10&token=${expired}`);
  check('__down with expired token → 401', r.status === 401, `got ${r.status}`);
}
{
  const body = new Uint8Array(4096);
  crypto.getRandomValues(body);
  const r = await fetch(SECRET_BASE + `/__up?token=${token}`, { method: 'POST', body });
  const j = await r.json();
  check('__up with valid token → {bytes:4096}', r.status === 200 && j.bytes === 4096, JSON.stringify(j));
}
{
  // WS upgrade without token → rejected (no 101 upgrade).
  const wsBase = SECRET_BASE.replace(/^http/, 'ws');
  const outcome = await new Promise((resolve) => {
    const ws = new WebSocket(wsBase + '/ws');
    ws.addEventListener('error', () => resolve('error'));
    ws.addEventListener('open', () => {
      ws.close();
      resolve('open');
    });
    setTimeout(() => resolve('timeout'), 3000);
  });
  check('WS upgrade without token → rejected', outcome === 'error', `outcome=${outcome}`);
}
{
  // WS upgrade with token → 101 + full NetGauge handshake.
  const wsBase = SECRET_BASE.replace(/^http/, 'ws');
  const outcome = await new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}/ws?token=${token}`);
    ws.addEventListener('error', () => resolve('error'));
    ws.addEventListener('open', () => {
      ws.send('HI\n');
      ws.addEventListener('message', (ev) => {
        ws.close();
        resolve(String(ev.data).startsWith('HELLO ') ? 'hello' : 'other:' + ev.data);
      });
    });
    setTimeout(() => resolve('timeout'), 5000);
  });
  check('WS upgrade with valid token → NetGauge HELLO', outcome === 'hello', `outcome=${outcome}`);
}

console.log(`\n== TOKEN RESULT: ${pass} passed, ${fail} failed ==`);
if (failures.length) {
  console.log('failed:', failures.join(' | '));
  process.exit(1);
}

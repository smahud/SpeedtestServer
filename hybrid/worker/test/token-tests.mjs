#!/usr/bin/env node
/**
 * token-tests.mjs — session-token enforcement battery.
 *
 * G-10: secret, IP, and caps are parameterized via env so the battery runs
 * against BOTH local workerd and the real edge:
 *   TOKEN_TEST_SECRET   (default testsecret123)
 *   TOKEN_TEST_IP       expected cf-connecting-ip (default 127.0.0.1; use
 *                       the value that matches your egress at the edge)
 *   TOKEN_TEST_GUID     optional fixed guid
 * Remote runs against a token-gated deployment: the test mints its own
 * tokens with the same secret, so it works from any network position.
 *
 * Usage: node test/token-tests.mjs [baseURL]
 */
import { createHmac } from 'node:crypto';

const SECRET_BASE = process.argv[2] || 'http://127.0.0.1:8791';
const SECRET = process.env.TOKEN_TEST_SECRET || 'testsecret123';
const TOKEN_IP = process.env.TOKEN_TEST_IP || '127.0.0.1';
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

const guid = process.env.TOKEN_TEST_GUID || '11111111-2222-3333-4444-555555555555';
const exp = Date.now() + 60000;
const sig = createHmac('sha256', SECRET).update(`v1|${guid}|${exp}|${TOKEN_IP}`).digest('hex');
const token = `v1~${guid}~${exp}~${TOKEN_IP}~${sig}`;
// wildcard-IP token (G-1 default mint from the gateway)
const expW = Date.now() + 60000;
const sigW = createHmac('sha256', SECRET).update(`v1|${guid}|${expW}|*`).digest('hex');
const wildcardToken = `v1~${guid}~${expW}~*~${sigW}`;

{
  const r = await fetch(SECRET_BASE + '/__down?bytes=10');
  check('__down without token → 401', r.status === 401, `got ${r.status}`);
}
{
  const r = await fetch(SECRET_BASE + `/__down?bytes=10&token=${token}`);
  check('__down with valid token → 200 + 10 bytes', r.status === 200 && (await r.arrayBuffer()).byteLength === 10, `got ${r.status}`);
}
{
  // G-8: Authorization: Bearer
  const r = await fetch(SECRET_BASE + '/__down?bytes=10', { headers: { Authorization: `Bearer ${token}` } });
  check('__down with Bearer token → 200 + 10 bytes', r.status === 200 && (await r.arrayBuffer()).byteLength === 10, `got ${r.status}`);
}
{
  // G-1: wildcard-IP token verifies from any source IP
  const r = await fetch(SECRET_BASE + '/__down?bytes=10', { headers: { Authorization: `Bearer ${wildcardToken}` } });
  check('__down with ip=* token → 200 (G-1)', r.status === 200 && (await r.arrayBuffer()).byteLength === 10, `got ${r.status}`);
}
{
  const r = await fetch(SECRET_BASE + `/__down?bytes=10&token=${token}x`);
  check('__down with tampered token → 401', r.status === 401, `got ${r.status}`);
}
{
  const guid2 = '99999999-2222-3333-4444-555555555555';
  const sig2 = createHmac('sha256', SECRET).update(`v1|${guid2}|${Date.now() - 1000}|${TOKEN_IP}`).digest('hex');
  const expired = `v1~${guid2}~${Date.now() - 1000}~${TOKEN_IP}~${sig2}`;
  const r = await fetch(SECRET_BASE + `/__down?bytes=10&token=${expired}`);
  check('__down with expired token → 401', r.status === 401, `got ${r.status}`);
}
{
  const guid3 = 'aaaaaaaa-2222-3333-4444-555555555555';
  const exp3 = Date.now() + 60000;
  const sig3 = createHmac('sha256', 'wrong-secret-entirely', `v1|${guid3}|${exp3}|${TOKEN_IP}`).digest('hex');
  const wrongSecret = `v1~${guid3}~${exp3}~${TOKEN_IP}~${sig3}`;
  const r = await fetch(SECRET_BASE + `/__down?bytes=10&token=${wrongSecret}`);
  check('__down with wrong-secret token → 401', r.status === 401, `got ${r.status}`);
}
{
  const body = new Uint8Array(4096);
  crypto.getRandomValues(body);
  const r = await fetch(SECRET_BASE + `/__up?token=${token}`, { method: 'POST', body });
  const j = await r.json();
  check('__up with valid token → {bytes:4096}', r.status === 200 && j.bytes === 4096, JSON.stringify(j));
}
{
  // G-8: Bearer on __up too
  const body = new Uint8Array(2048);
  crypto.getRandomValues(body);
  const r = await fetch(SECRET_BASE + '/__up', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
  const j = await r.json();
  check('__up with Bearer token → {bytes:2048}', r.status === 200 && j.bytes === 2048, JSON.stringify(j));
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

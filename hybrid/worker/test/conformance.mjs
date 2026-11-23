#!/usr/bin/env node
/**
 * conformance.mjs — protocol conformance battery for the hybrid Worker,
 * executed against a local `wrangler dev` (workerd) instance.
 *
 * Asserts the verified OoklaServer 2.11.5.2 contract rows
 * (validation/PROTOCOL_CONTRACT.md §2/§4/§5) that apply to the
 * WebSocket + HTTP surfaces the Worker serves, plus the hybrid endpoints.
 *
 * Usage: node test/conformance.mjs [baseURL] [secretBaseURL]
 *   baseURL        default http://127.0.0.1:8787
 *   secretBaseURL  an instance started with HYBRID_SHARED_SECRET set
 */

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const SECRET_BASE = process.argv[3] || '';
const WS_BASE = BASE.replace(/^http/, 'ws');

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Open a WS session; returns helpers bound to a message queue. */
function wsSession(path = '/ws') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_BASE + path);
    ws.binaryType = 'arraybuffer';
    const queue = [];
    const waiters = [];
    ws.addEventListener('message', (ev) => {
      const item = typeof ev.data === 'string' ? { type: 'text', data: ev.data } : { type: 'binary', data: new Uint8Array(ev.data) };
      if (waiters.length) waiters.shift()(item);
      else queue.push(item);
    });
    const closed = new Promise((res) => ws.addEventListener('close', (ev) => res(ev)));
    ws.addEventListener('open', () => {
      resolve({
        ws,
        closed,
        sendText: (s) => ws.send(s),
        sendBinary: (b) => ws.send(typeof b === 'number' ? new Uint8Array(b) : b),
        next: (timeoutMs = 2500) =>
          new Promise((res, rej) => {
            if (queue.length) return res(queue.shift());
            const t = setTimeout(() => rej(new Error('timeout waiting for message')), timeoutMs);
            waiters.push((item) => {
              clearTimeout(t);
              res(item);
            });
          }),
        nextText: async (timeoutMs) => (await this.next(timeoutMs)),
        silence: async (ms = 700) => {
          await sleep(ms);
          return queue.splice(0);
        },
      });
    });
    ws.addEventListener('error', () => reject(new Error('ws error')));
    setTimeout(() => reject(new Error('ws open timeout')), 5000);
  });
}

const enc = new TextEncoder();

async function textMessage(sess, timeoutMs) {
  const m = await sess.next(timeoutMs);
  if (m.type !== 'text') throw new Error('expected text message, got binary');
  // Non-HELLO replies carry a trailing newline (verified WS quirk); HELLO
  // does not. Normalize one trailing \n for comparisons.
  return m.data.endsWith('\n') ? m.data.slice(0, -1) : m.data;
}

// ---------------------------------------------------------------------------
console.log('\n== WebSocket NetGauge conformance ==');

{
  const s = await wsSession();
  s.sendText('HI\n');
  check('HI → HELLO without trailing newline', (await textMessage(s)) === 'HELLO 2.11 (2.11.5) 2026-06-04.1737.7d0993d');
  s.sendText('HI 123e4567-e89b-12d3-a456-426614174000\n');
  check('HI <uuid> → HELLO (session)', (await textMessage(s)) === 'HELLO 2.11 (2.11.5) 2026-06-04.1737.7d0993d');
  s.sendText('HI not-a-uuid\n');
  check('HI <bad-uuid> → ERROR', (await textMessage(s)) === 'ERROR');
  s.sendText('GETIP\n');
  check('GETIP → YOURIP <ip>', /^YOURIP /.test(await textMessage(s)));
  s.sendText('CAPABILITIES\n');
  check('CAPABILITIES → exact banner', (await textMessage(s)) === 'CAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS');
  s.sendText('SERVERID\n');
  const sid = await textMessage(s);
  check('SERVERID → lowercase uuid', /^SERVERID [0-9a-f-]{36}$/.test(sid));
  s.sendText('UPTIME\n');
  check('UPTIME → seconds', /^UPTIME \d+$/.test(await textMessage(s)));
  s.sendText('PING 1\n');
  check('PING 1 → PONG <ms>', /^PONG \d{13}$/.test(await textMessage(s)));
  s.sendText('PING\n');
  check('bare PING → ERROR', (await textMessage(s)) === 'ERROR');
  s.sendText('UPLOAD_STATS\n');
  check('UPLOAD_STATS → ERROR (daemon parity)', (await textMessage(s)) === 'ERROR');
  s.sendText('INITPLOSS\n');
  check('INITPLOSS → OK', (await textMessage(s)) === 'OK');
  s.sendText('PLOSS\n');
  check('PLOSS → PLOSS 0 0 0 (no UDP at edge)', (await textMessage(s)) === 'PLOSS 0 0 0');
  s.sendText('QUIT\n');
  check('QUIT → ERROR, session stays open', (await textMessage(s)) === 'ERROR');
  s.sendText('GETIP\n');
  check('post-QUIT GETIP still answered', /^YOURIP /.test(await textMessage(s)));
  s.ws.close();
}

{
  // One command per frame (F-13): a "HI\nGETIP\n" frame yields ONE HELLO.
  const s = await wsSession();
  s.sendText('HI\nGETIP\n');
  const first = await textMessage(s);
  check('one-command-per-frame: single HELLO for "HI\\nGETIP\\n"', first.startsWith('HELLO '));
  const extra = await s.silence(800);
  check('one-command-per-frame: GETIP in same frame discarded', extra.length === 0, JSON.stringify(extra));
  s.ws.close();
}

{
  // No three-strikes over WS (F-24).
  const s = await wsSession();
  s.sendText('GARBAGE1\n');
  check('garbage #1 → ERROR', (await textMessage(s)) === 'ERROR');
  s.sendText('GARBAGE2\n');
  check('garbage #2 → ERROR', (await textMessage(s)) === 'ERROR');
  s.sendText('GARBAGE3\n');
  check('garbage #3 → ERROR', (await textMessage(s)) === 'ERROR');
  s.sendText('GETIP\n');
  check('no three-strikes: session alive after 3 ERRORs', /^YOURIP /.test(await textMessage(s)));
  s.ws.close();
}

{
  // CRLF tolerance (F-25).
  const s = await wsSession();
  s.sendText('HI\r\n');
  check('HI\\r\\n → HELLO (one \\r stripped)', (await textMessage(s)).startsWith('HELLO '));
  s.sendText('PING 1\r\n');
  check('PING 1\\r\\n → PONG', /^PONG \d+$/.test(await textMessage(s)));
  s.ws.close();
}

{
  // GETIP strictness (F-11): "GETIP x" mutes the connection.
  const s = await wsSession();
  s.sendText('GETIP x\n');
  const got = await s.silence(700);
  check('GETIP x → silent (no reply)', got.length === 0);
  s.sendText('PING 1\n');
  const still = await s.silence(500);
  check('muted connection stays mute for later commands', still.length === 0);
  s.ws.close();
}

{
  // DOWNLOAD semantics (F-9).
  const s = await wsSession();
  s.sendText('HI\n');
  await textMessage(s);
  s.sendText('DOWNLOAD 0\n');
  const d0 = await s.next();
  check('DOWNLOAD 0 → single 1-byte frame "\\n"', d0.type === 'binary' && d0.data.length === 1 && d0.data[0] === 0x0a);
  s.sendText('DOWNLOAD 100\n');
  let total = 0;
  let first = null;
  while (total < 100) {
    const m = await s.next();
    if (m.type !== 'binary') throw new Error('expected binary frame');
    if (!first) first = m.data;
    total += m.data.length;
  }
  const all = first; // 100 ≤ 64KiB → one frame
  check('DOWNLOAD 100 → exactly 100 bytes total', total === 100, `got ${total}`);
  check(
    'DOWNLOAD 100 → "DOWNLOAD " prefix + trailing \\n',
    Buffer.from(all.subarray(0, 9)).toString() === 'DOWNLOAD ' && all[99] === 0x0a,
  );
  s.sendText('DOWNLOAD bogus\n');
  check('DOWNLOAD <unparsable> → ERROR (safety deviation)', (await textMessage(s)) === 'ERROR');
  s.ws.close();
}

{
  // DOWNLOAD 5 MiB — multi-frame, exact total, paced sending.
  const s = await wsSession();
  s.sendText('HI\n');
  await textMessage(s);
  s.sendText('DOWNLOAD 5242880\n');
  let total = 0;
  let frames = 0;
  while (total < 5242880) {
    const m = await s.next(10000);
    if (m.type !== 'binary') throw new Error('expected binary frame');
    total += m.data.length;
    frames++;
  }
  check('DOWNLOAD 5242880 → exact byte total', total === 5242880, `got ${total}`);
  check('DOWNLOAD 5242880 → multiple 64 KiB frames', frames === 80, `got ${frames} frames`);
  s.ws.close();
}

{
  // UPLOAD semantics (inclusive counting).
  const s = await wsSession();
  s.sendText('HI\n');
  await textMessage(s);
  s.sendText('UPLOAD 100\n'); // command line = 11 bytes → 89 payload bytes
  s.sendBinary(89);
  const ok = await textMessage(s);
  check('UPLOAD 100 (+89 payload) → OK 100 <ms>', /^OK 100 \d{13}$/.test(ok), ok);
  s.sendText('UPLOAD 5\n');
  check('UPLOAD 5 (< command line) → ERROR', (await textMessage(s)) === 'ERROR');
  s.sendText('UPLOAD bogus\n');
  s.sendText('PING 1\n');
  check('UPLOAD <non-numeric> silently ignored', /^PONG \d+$/.test(await textMessage(s)));
  s.ws.close();
}

{
  // HI <uuid> <extra> → connection closed (JWT parse fail).
  const s = await wsSession();
  s.sendText('HI 123e4567-e89b-12d3-a456-426614174000 extra\n');
  const closeEvent = await Promise.race([s.closed, sleep(3000).then(() => null)]);
  check('HI <uuid> <extra> → connection closed', closeEvent !== null);
}

// ---------------------------------------------------------------------------
console.log('\n== HTTP legacy conformance ==');

{
  const r = await fetch(BASE + '/');
  const body = await r.text();
  check(
    'GET / → exact daemon body',
    r.status === 200 &&
      body === '<html><head><title>OoklaServer</title></head><body><h1>OoklaServer</h1><p>It worked!<br /></p></body></html>\n',
  );
  check('GET / → security headers', r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('cache-control') === 'no-store');
}
{
  const r = await fetch(BASE + '/hi');
  check('GET /hi → exact body', (await r.text()) === 'hello 2.11 (2.11.5) 2026-06-04.1737.7d0993d\n');
}
{
  const r1 = await fetch(BASE + '/latency.txt');
  const r2 = await fetch(BASE + '/speedtest/latency.txt');
  check('latency.txt aliases → "test=test\\n"', (await r1.text()) === 'test=test\n' && (await r2.text()) === 'test=test\n');
}
{
  const r = await fetch(BASE + '/crossdomain.xml');
  const body = await r.text();
  check('crossdomain.xml → wildcard entry', r.status === 200 && body.includes('<allow-access-from domain="*"'));
}
{
  const r = await fetch(BASE + '/speedtest/random350x350.jpg');
  const buf = await r.arrayBuffer();
  check(
    'random350x350.jpg → 200 image/jpeg 245388 B',
    r.status === 200 && r.headers.get('content-type') === 'image/jpeg' && r.headers.get('content-length') === '245388' && buf.byteLength === 245388,
    `CL=${r.headers.get('content-length')} len=${buf.byteLength}`,
  );
}
{
  const r = await fetch(BASE + '/speedtest/random3500x3500.jpg', { method: 'HEAD' });
  check('HEAD random3500x3500.jpg → CL 24262167', r.headers.get('content-length') === '24262167');
}
{
  const r = await fetch(BASE + '/speedtest/random360x360.jpg');
  check('random360x360.jpg → 404 (unknown size)', r.status === 404);
}
{
  const body = new Uint8Array(12345);
  crypto.getRandomValues(body);
  const r = await fetch(BASE + '/speedtest/upload.php', { method: 'POST', body });
  check('POST upload.php → size=12345', (await r.text()) === 'size=12345\n');
}
{
  const r = await fetch(BASE + '/hi', { method: 'PUT' });
  check('PUT /hi → 404', r.status === 404);
  const r2 = await fetch(BASE + '/nonexistent');
  check('GET /nonexistent → 404', r2.status === 404);
}
{
  // Missing User-Agent → minimal 500 (node:http sends none by default).
  const { execFile } = await import('node:child_process');
  const noUa = await new Promise((res) => {
    execFile('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '-H', 'User-Agent:', BASE + '/hi'], (err, out) => res(err ? 'ERR' : out));
  });
  check('GET /hi without User-Agent → 500', noUa === '500', `got ${noUa}`);
}
{
  const r = await fetch(BASE + '/ws'); // no Upgrade header
  check('GET /ws without upgrade → 500 (daemon drops silently; D-W4)', r.status === 500);
}

// ---------------------------------------------------------------------------
console.log('\n== Hybrid endpoints ==');

{
  const r = await fetch(BASE + '/__down?bytes=1000');
  const buf = await r.arrayBuffer();
  check('__down?bytes=1000 → exactly 1000 bytes', r.status === 200 && buf.byteLength === 1000);
  check('__down → X-Hybrid-Server header', (r.headers.get('x-hybrid-server') || '').startsWith('speedtest-hybrid-worker'));
}
{
  const r = await fetch(BASE + '/__down?bytes=0');
  const buf = await r.arrayBuffer();
  check('__down?bytes=0 → empty 200 (TTFB ping)', r.status === 200 && buf.byteLength === 0);
}
{
  const r = await fetch(BASE + '/__down?bytes=-5');
  check('__down?bytes=-5 → 400', r.status === 400);
  const r2 = await fetch(BASE + '/__down?bytes=abc');
  check('__down?bytes=abc → 400', r2.status === 400);
}
{
  const body = new Uint8Array(5000);
  crypto.getRandomValues(body);
  const r = await fetch(BASE + '/__up', { method: 'POST', body });
  const j = await r.json();
  check('__up → {bytes:5000}', r.status === 200 && j.bytes === 5000, JSON.stringify(j));
}
{
  const r = await fetch(BASE + '/__down?bytes=25000000');
  const buf = await r.arrayBuffer();
  check('__down?bytes=25000000 → 25 MB streamed exactly', buf.byteLength === 25000000);
}
{
  const r = await fetch(BASE + '/__meta');
  const j = await r.json();
  check('__meta → instance metadata', r.status === 200 && typeof j.instanceUuid === 'string' && j.endpoints !== undefined);
}

// ---------------------------------------------------------------------------
console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
if (failures.length) {
  console.log('failed:', failures.join(' | '));
  process.exit(1);
}

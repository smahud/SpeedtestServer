#!/usr/bin/env node
/**
 * speedtest-bridge.test.mjs — protocol + backend + mux + guard battery for
 * speedtest-bridge.mjs (adapted from the validated 158-check lab battery;
 * same synthetic client that mimics the official CLI's observed pattern:
 *   encrypted-binary hello → ERROR → HI → GETIP/PING/CAPABILITIES →
 *   DOWNLOAD <n> loops → UPLOAD <n> <ms> <c> + payload → UDP LOSS forms.
 *
 * Sections:
 *   1. protocolSuite × 3 backends (local / worker-http / worker-ws) —
 *      parity, byte-exactness, backpressure-safe backends, receipts,
 *      UDP loss, three-strikes, GETIP gate/strict, caps.
 *   2. TLS mux — first-byte routing (ClientHello → loopback gateway proxy;
 *      NetGauge/binary/garbage → front), split-ClientHello tolerance,
 *      bad-record fallthrough, TLS_MUX=0 knob.
 *   3. per-IP connection rate limit (CONN_RATE_PER_MIN).
 *   4. concurrency smoke (worker-http, CLI pattern: 8 × DL 1 MiB + UL 256 KiB).
 *   5. PORT AUTHORITY wiring — OoklaServer.properties is the only port
 *      source: SPEEDTEST_BRIDGE_PORTS multi-port (every port serves the FULL
 *      mux), per-port UDP loss plane, and the gateway reached over a UNIX
 *      domain socket (mint + HTTP lane) with NO gateway TCP port at all.
 *
 * Usage: node test/speedtest-bridge.test.mjs            (everything)
 *        node test/speedtest-bridge.test.mjs local       (single backend)
 * Run:   bash test/run-tests.sh
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BRIDGE = new URL('../speedtest-bridge.mjs', import.meta.url).pathname;
const BRIDGE_PORT = 18080;
const BRIDGE_PORT_2 = 18082; // second properties port (multi-port front)
const WORKER_PORT = 18081;
const GW_MOCK_PORT = 18890; // TLS-mux upstream, lab raw-proxy mode (plain TCP echo)
const GW_PLAIN_PORT = 18891; // gateway plain loopback listener stand-in (echo)
const GW_UNIX_SOCK = path.join(os.tmpdir(), `speedtest-bridge-test-gw-${process.pid}.sock`); // production wiring: gateway over a Unix socket
const TLS_CERT_PORT = 18892; // (unused port range guard)
const TOKEN = 'test-token-abcdef';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let pass = 0, fail = 0;
const fails = [];
const children = []; // spawned bridge processes (killed on exit)
function expect(cond, label) {
  if (cond) { pass++; }
  else { fail++; fails.push(label); console.error('  FAIL:', label); }
}
function section(s) { console.log('== ' + s + ' =='); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------- mock pool
const MOCK_POOL = (() => {
  const p = Buffer.alloc(1 * 1024 * 1024);
  const rnd = new Uint8Array(p.length);
  for (let off = 0; off < rnd.length; off += 65536) { // getRandomValues limit
    crypto.getRandomValues(rnd.subarray(off, Math.min(off + 65536, rnd.length)));
  }
  for (let i = 0; i < p.length; i++) p[i] = 32 + (rnd[i] % 96);
  return p;
})();
function mockPoolSlice(out, streamOff) {
  let pos = streamOff % MOCK_POOL.length;
  for (let i = 0; i < out.length; ) {
    const take = Math.min(MOCK_POOL.length - pos, out.length - i);
    MOCK_POOL.copy(out, i, pos, pos + take);
    pos = (pos + take) % MOCK_POOL.length;
    i += take;
  }
}

// ---------------------------------------------------------------- mock worker
// HTTP: /__down?bytes=N (pool stream), /__up (count + {bytes:N} receipt).
// WS:   NetGauge engine with the Worker's verified semantics (one command
//       per frame, HELLO no-newline quirk, DOWNLOAD = "DOWNLOAD "+pool+"\n"
//       in 64 KiB binary frames, UPLOAD inclusive + "OK n <ts>", ?token=).
function startMockWorker() {
  let downRequests = 0, upRequests = 0, upBytes = 0, wsSessions = 0, wsCommands = 0;
  const stats = () => ({ downRequests, upRequests, upBytes, wsSessions, wsCommands });

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    // token via Bearer header or query — mirrors the worker's extractToken()
    const auth = req.headers['authorization'] || '';
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const token = bearer || u.searchParams.get('token');
    if (u.pathname === '/__down') {
      if (token !== TOKEN) { res.writeHead(401); return res.end(); }
      const n = Number(u.searchParams.get('bytes'));
      if (!Number.isInteger(n) || n < 0) { res.writeHead(400); return res.end(); }
      downRequests++;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(n) });
      let off = 0;
      const pumpChunk = () => {
        while (off < n) {
          const len = Math.min(64 * 1024, n - off);
          const chunk = Buffer.alloc(len);
          mockPoolSlice(chunk, off);
          off += len;
          if (!res.write(chunk)) { res.once('drain', pumpChunk); return; }
        }
        res.end();
      };
      pumpChunk();
      return;
    }
    if (u.pathname === '/__up' && req.method === 'POST') {
      if (token !== TOKEN) { res.writeHead(401); return res.end(); }
      let count = 0;
      req.on('data', (c) => { count += c.length; });
      req.on('end', () => {
        upRequests++; upBytes += count;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ bytes: count }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });

  // ---- hand-rolled NetGauge-over-WS (/ws) with Worker semantics
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/ws' || u.searchParams.get('token') !== TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    wsSessions++;
    if (head && head.length) wsFeed(socket, head);
    socket.on('data', (c) => wsFeed(socket, c));

    const st = { buf: Buffer.alloc(0), uploadRemaining: 0, uploadTotal: 0, hi: false };
    function sendText(s, noNl) { wsSend(socket, 0x1, Buffer.from(s + (noNl ? '' : '\n'), 'latin1')); }
    function sendBinary(b) { wsSend(socket, 0x2, b); }

    function handleCommand(line) {
      wsCommands++;
      const s = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (s === 'HI' || s.startsWith('HI ')) { st.hi = true; sendText('HELLO 2.11 (mock) 2026', true); return; }
      if (s === 'GETIP') { sendText('YOURIP 127.0.0.1'); return; }
      if (s.startsWith('PING ')) { sendText('PONG ' + Date.now()); return; }
      if (s.startsWith('DOWNLOAD ')) {
        const n = parseInt(s.slice(9).trim(), 10);
        if (!Number.isFinite(n) || n < 0) { sendText('ERROR'); return; }
        // exactly n bytes: "DOWNLOAD " + pool + "\n" in 64 KiB frames
        const prefix = Buffer.from('DOWNLOAD ', 'latin1');
        let sent = 0;
        const prefixLen = n >= 1 ? Math.min(n - 1, 9) : 0;
        const step = () => {
          while (sent < n) {
            const len = Math.min(64 * 1024, n - sent);
            const chunk = Buffer.alloc(len);
            const localStart = Math.max(prefixLen - sent, 0);
            if (localStart > 0) chunk.set(prefix.subarray(0, Math.min(prefixLen, len)), 0);
            const localEnd = Math.min(len, Math.max(n - 1 - sent, 0));
            if (localEnd > localStart) mockPoolSlice(chunk.subarray(localStart, localEnd), sent + localStart - prefixLen);
            if (sent + len === n) chunk[len - 1] = 0x0a;
            sendBinary(chunk);
            sent += len;
          }
        };
        step();
        return;
      }
      if (s.startsWith('UPLOAD ')) {
        const n = parseInt(s.slice(7).trim().split(/\s+/)[0], 10);
        if (!Number.isFinite(n) || n < 0) return; // silent ignore
        const lineLen = Buffer.byteLength(s, 'latin1') + 1;
        if (n < lineLen) { sendText('ERROR'); return; }
        st.uploadTotal = n;
        st.uploadRemaining = n - lineLen;
        if (st.uploadRemaining === 0) sendText(`OK ${n} ${Date.now()}`);
        return;
      }
      if (s === 'QUIT') { sendText('ERROR'); return; } // WS semantics
      sendText('ERROR'); // unknown → drives CLI fallback
    }

    function onFrame(opcode, payload) {
      if (opcode === 0x8) { try { socket.end(); } catch {} return; } // close
      if (st.uploadRemaining > 0 && opcode === 0x2) {
        const take = Math.min(st.uploadRemaining, payload.length);
        st.uploadRemaining -= take;
        upBytes += take;
        if (st.uploadRemaining === 0) sendText(`OK ${st.uploadTotal} ${Date.now()}`);
        return;
      }
      if (opcode !== 0x1 && opcode !== 0x2) return;
      // one command per frame: first line only; no-newline = complete command
      const nl = payload.indexOf(0x0a);
      const first = nl === -1 ? payload : payload.subarray(0, nl + 1);
      handleCommand(first.toString('latin1').replace(/\n$/, ''));
    }

    function wsFeed(sock, chunk) {
      st.buf = Buffer.concat([st.buf, chunk]);
      for (;;) {
        const f = wsParse(st.buf);
        if (!f) break;
        st.buf = st.buf.subarray(f.consumed);
        onFrame(f.opcode, f.payload);
      }
    }
    void st;
  });

  return new Promise((resolve) => {
    server.listen(WORKER_PORT, '127.0.0.1', () => resolve({ server, stats }));
  });
}

// -------------------------------------------------- mock gateway (TLS-mux upstream)
// Plain TCP echo server standing in for the loopback hybrid gateway: the mux
// only ROUTES (raw proxy), so a TCP echo proves routing + byte fidelity.
function startMockGateway() {
  let conns = 0, closed = 0;
  const received = [];
  const server = net.createServer((sock) => {
    conns++;
    sock.setNoDelay(true);
    sock.on('data', (c) => { received.push(c); sock.write(Buffer.concat([Buffer.from('ECHO:'), c])); });
    sock.on('close', () => { closed++; });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(GW_MOCK_PORT, '127.0.0.1', () => resolve({ server, stats: () => ({ conns, closed, received: Buffer.concat(received) }) }));
  });
}

// Plain gateway stand-in: echoes "PLAIN-GW:" + the first line of whatever it
// receives — proves the HTTP lane pipes through (request line fidelity).
function startMockPlainGateway() {
  let conns = 0;
  const seen = [];
  const server = net.createServer((sock) => {
    conns++;
    let buf = Buffer.alloc(0);
    let answered = false;
    sock.on('data', (c) => {
      if (answered) return;
      buf = Buffer.concat([buf, c]);
      const nl = buf.indexOf(0x0d);
      if (nl !== -1) {
        answered = true;
        seen.push(buf.subarray(0, nl).toString('latin1'));
        sock.write(Buffer.from('PLAIN-GW: ' + buf.subarray(0, nl).toString('latin1') + '\r\n'));
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(GW_PLAIN_PORT, '127.0.0.1', () => resolve({ server, stats: () => ({ conns, seen }) }));
  });
}

// Unix-socket gateway stand-in — the PRODUCTION wiring (the gateway has NO
// TCP port): POST /api/sessions mints the fixed TOKEN (so the worker-http
// backend's lazy mint over the socket is exercised end-to-end); GET
// /api/health answers JSON (proves the bridge's HTTP lane pipes over the
// same socket).
function startMockUnixGateway() {
  let mints = 0, healths = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/sessions' && req.method === 'POST') {
      mints++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: TOKEN, guid: 'unix-gw-guid', expiresAt: new Date(Date.now() + 300000).toISOString(), worker: { id: 1, url: `http://127.0.0.1:${WORKER_PORT}` } }));
      return;
    }
    if (u.pathname === '/api/health') {
      healths++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, via: 'unix-socket' }));
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => {
    try { fs.unlinkSync(GW_UNIX_SOCK); } catch {}
    server.listen(GW_UNIX_SOCK, () => resolve({ server, stats: () => ({ mints, healths }) }));
  });
}

// Self-signed cert for the TLS-termination tests (openssl at runtime).
function makeSelfSignedCert(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const cert = path.join(dir, 'test-cert.pem');
  const key = path.join(dir, 'test-key.pem');
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  if (r.status !== 0) return null;
  return { cert, key };
}

// TLS client helper (rejectUnauthorized:false — the mux serves its own cert).
function tlsConnect(port = BRIDGE_PORT) {
  const sock = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
  sock.setNoDelay(true);
  const state = { buf: Buffer.alloc(0), closed: false, waiters: [] };
  sock.on('data', (c) => {
    state.buf = Buffer.concat([state.buf, c]);
    while (state.waiters.length) {
      const w = state.waiters[0];
      const r = w.try();
      if (r !== undefined) { state.waiters.shift(); w.consume(); w.resolve(r); }
      else break;
    }
  });
  sock.on('close', () => { state.closed = true; for (const w of state.waiters.splice(0)) w.reject(new Error('closed')); });
  sock.on('error', () => {});
  const api = {
    sock, state,
    write(b) { sock.write(b); },
    writeLine(s) { sock.write(s + '\n'); },
    async readExact(n, timeoutMs = 10000) {
      const t0 = Date.now();
      for (;;) {
        if (state.buf.length >= n) { const out = state.buf.subarray(0, n); state.buf = state.buf.subarray(n); return out; }
        if (state.closed) throw new Error('closed');
        if (Date.now() - t0 > timeoutMs) throw new Error('readExact timeout');
        await sleep(20);
      }
    },
    async readLine(timeoutMs = 10000) {
      const t0 = Date.now();
      for (;;) {
        const idx = state.buf.indexOf(0x0a);
        if (idx !== -1) { const line = state.buf.subarray(0, idx).toString('latin1'); state.buf = state.buf.subarray(idx + 1); return line; }
        if (state.closed) throw new Error('closed');
        if (Date.now() - t0 > timeoutMs) throw new Error('readLine timeout');
        await sleep(20);
      }
    },
    closed() { return state.closed; },
    destroy() { sock.destroy(); },
  };
  return api;
}

// Minimal WS server-side frame ENCODER (unmasked server frames)
function wsSend(socket, opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  try { socket.write(Buffer.concat([header, payload])); } catch { /* closing */ }
}
// Minimal WS client-frame PARSER (masked client frames)
function wsParse(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2)); off = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;
  const mask = masked ? buf.subarray(off, off + 4) : null;
  const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { opcode, payload, consumed: off + maskLen + len };
}

// ---------------------------------------------------------------- synthetic CLI client
function connect(port = BRIDGE_PORT, host = '127.0.0.1') {
  const sock = net.connect({ port, host });
  sock.setNoDelay(true);
  const state = { buf: Buffer.alloc(0), closed: false, waiters: [] };
  sock.on('data', (c) => {
    state.buf = Buffer.concat([state.buf, c]);
    while (state.waiters.length) {
      const w = state.waiters[0];
      const r = w.try();
      if (r !== undefined) { state.waiters.shift(); w.consume(); w.resolve(r); }
      else break;
    }
  });
  sock.on('close', () => { state.closed = true; for (const w of state.waiters.splice(0)) w.reject(new Error('closed')); });
  sock.on('error', () => {});
  const api = {
    sock, state,
    write(b) { sock.write(b); },
    writeLine(s) { sock.write(s + '\n'); },
    /** Wait until `n` bytes buffered; consumes them atomically. */
    readExact(n, timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          const i = state.waiters.indexOf(w);
          if (i !== -1) state.waiters.splice(i, 1);
          reject(new Error('readExact timeout'));
        }, timeoutMs);
        const w = {
          try: () => (state.buf.length >= n ? state.buf.subarray(0, n) : undefined),
          consume: () => { state.buf = state.buf.subarray(n); },
          resolve: (v) => { clearTimeout(t); resolve(v); },
          reject: (e) => { clearTimeout(t); reject(e); },
        };
        const r = w.try();
        if (r !== undefined) { w.consume(); clearTimeout(t); resolve(r); return; }
        state.waiters.push(w);
      });
    },
    /** Wait until a full \n-terminated line; consumes it. */
    async readLine(timeoutMs = 10000) {
      const t0 = Date.now();
      for (;;) {
        const idx = state.buf.indexOf(0x0a);
        if (idx !== -1) {
          const line = state.buf.subarray(0, idx).toString('latin1');
          state.buf = state.buf.subarray(idx + 1);
          return line;
        }
        if (state.closed) throw new Error('closed');
        if (Date.now() - t0 > timeoutMs) throw new Error('readLine timeout');
        await sleep(20);
      }
    },
    async readMaybe(timeoutMs) {
      try { return await api.readLine(timeoutMs); } catch { return null; }
    },
    closed() { return state.closed; },
    end() { sock.end(); },
    destroy() { sock.destroy(); },
  };
  return api;
}

// ---------------------------------------------------------------- UDP client
function udpClient(port = BRIDGE_PORT) {
  const sock = dgram.createSocket('udp4');
  const state = { msgs: [], waiters: [] };
  sock.on('message', (m) => { state.msgs.push(m); if (state.waiters.length) state.waiters.shift()(); });
  const api = {
    send(s) { sock.send(Buffer.from(s, 'latin1'), port, '127.0.0.1'); },
    async next(timeoutMs = 1500) {
      if (state.msgs.length) return state.msgs.shift().toString('latin1').replace(/\n$/, '');
      await Promise.race([new Promise((r) => state.waiters.push(r)), sleep(timeoutMs).then(() => null)]);
      return state.msgs.length ? state.msgs.shift().toString('latin1').replace(/\n$/, '') : null;
    },
    close() { sock.close(); },
  };
  return api;
}

// ---------------------------------------------------------------- per-backend suite
async function protocolSuite(label, checkLog) {
  section(`backend=${label}: protocol parity`);
  // 1. encrypted-binary hello → ERROR → HI → HELLO (the CLI fallback drive).
  //    Deterministic content: opaque bytes with NO stray 0x0a (random
  //    newlines would produce 3+ ERROR strikes and close the connection
  //    mid-test — the real CLI's hello is one line, one ERROR, fallback),
  //    and a first-bytes shape that can NEVER look like a TLS ClientHello
  //    (mux safety: 0x16 0x03 …) nor like "HI " (JWT disconnect path).
  {
    const c = connect();
    const binHello = crypto.randomBytes(16);
    for (let i = 0; i < binHello.length; i++) if (binHello[i] === 0x0a) binHello[i] = 0x0b;
    binHello[0] = 0x48; binHello[1] = 0x49; binHello[2] = 0x7e; // "HI~…" → unknown
    c.write(Buffer.concat([binHello, Buffer.from('\n', 'latin1')]));
    const e1 = await c.readLine();
    expect(e1 === 'ERROR', `${label}: binary hello → ERROR`);
    c.writeLine('HI');
    const hello = await c.readLine();
    expect(/^HELLO 2\.11 /.test(hello), `${label}: HI → HELLO 2.11…`);
    c.writeLine('GETIP');
    const ip = await c.readLine();
    expect(/^YOURIP /.test(ip), `${label}: GETIP → YOURIP <ip>`);
    c.writeLine('PING 1');
    const pong = await c.readLine();
    expect(/^PONG \d+$/.test(pong), `${label}: PING 1 → PONG <ms>`);
    c.writeLine('CAPABILITIES');
    const caps = await c.readLine();
    expect(caps === 'CAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS', `${label}: CAPABILITIES exact`);
    c.writeLine('SERVERID');
    const sid = await c.readLine();
    expect(/^SERVERID [0-9a-f-]{36}$/.test(sid), `${label}: SERVERID lower-case uuid`);
    c.writeLine('UPTIME');
    const up = await c.readLine();
    expect(/^UPTIME \d+$/.test(up), `${label}: UPTIME <s>`);
    c.writeLine('QUIT');
    await sleep(150);
    expect(c.closed(), `${label}: QUIT closes TCP`);
    c.destroy();
  }
  // 2. GETIP strictness (mute) + pre-session gate (mute)
  {
    const c = connect();
    c.writeLine('GETIP x');
    const r = await c.readMaybe(400);
    expect(r === null, `${label}: strict GETIP "GETIP x" → mute (no reply)`);
    c.writeLine('PING 1');
    const r2 = await c.readMaybe(400);
    expect(r2 === null, `${label}: muted conn stays muted`);
    c.destroy();
  }
  {
    const c = connect();
    c.write(Buffer.from('GETIP\nGETIP\n', 'latin1'));
    const r = await c.readMaybe(400);
    expect(r === null, `${label}: pre-session GETIP gate → mute`);
    c.destroy();
  }
  // 3. three strikes; HI-bad-uuid ERROR does not count
  {
    const c = connect();
    c.writeLine('AAA');
    expect((await c.readLine()) === 'ERROR', `${label}: strike 1`);
    c.writeLine('BBB');
    expect((await c.readLine()) === 'ERROR', `${label}: strike 2`);
    c.writeLine('CCC');
    await sleep(200);
    expect(c.closed(), `${label}: closed right after 3rd ERROR`);
    c.destroy();
  }
  {
    const c = connect();
    c.writeLine('HI nope');
    expect((await c.readLine()) === 'ERROR', `${label}: HI bad uuid → ERROR (no strike)`);
    c.writeLine('HI nope2');
    expect((await c.readLine()) === 'ERROR', `${label}: HI bad uuid #2`);
    c.writeLine('HI nope3');
    expect((await c.readLine()) === 'ERROR', `${label}: HI bad uuid #3 — still open`);
    c.writeLine('GETIP');
    expect(/^YOURIP /.test(await c.readLine()), `${label}: valid after 3 no-strike ERRORs`);
    c.destroy();
  }
  // 4. DOWNLOAD byte-exactness
  for (const n of [0, 5, 12, 100, 100000]) {
    const c = connect();
    c.writeLine(`DOWNLOAD ${n}`);
    const data = await c.readExact(n === 0 ? 1 : n);
    const total = n === 0 ? 1 : n;
    expect(data.length === total, `${label}: DOWNLOAD ${n} exact byte count`);
    const prefixLen = n >= 1 ? Math.min(n - 1, 9) : 0;
    const expectPrefix = 'DOWNLOAD '.slice(0, prefixLen);
    expect(data.subarray(0, prefixLen).toString('latin1') === expectPrefix, `${label}: DOWNLOAD ${n} prefix`);
    expect(data[data.length - 1] === 0x0a, `${label}: DOWNLOAD ${n} trailing \\n`);
    const pool = data.subarray(prefixLen, data.length - 1);
    let printable = true;
    for (let i = 0; i < pool.length; i++) if (pool[i] < 0x20 || pool[i] > 0x7f) { printable = false; break; }
    expect(printable, `${label}: DOWNLOAD ${n} pool region printable ASCII`);
    c.writeLine('QUIT');
    c.destroy();
  }
  // 5. UPLOAD inclusive counting + OK; too-small ERROR; invalid silent
  {
    const c = connect();
    c.writeLine('UPLOAD 100 15000 16');
    c.write(Buffer.alloc(89, 0x61)); // 11 (cmd+\n) + 89 = 100
    const ok = await c.readLine();
    expect(/^OK 100 \d+$/.test(ok), `${label}: UPLOAD 100 → OK 100 <ms>`);
    c.writeLine('UPLOAD 3'); // n < cmdLen → ERROR (counts strike)
    expect((await c.readLine()) === 'ERROR', `${label}: UPLOAD too-small → ERROR`);
    c.writeLine('UPLOAD abc'); // silent ignore
    const r = await c.readMaybe(400);
    expect(r === null, `${label}: UPLOAD invalid → silent`);
    c.writeLine('UPLOAD 50 15000 2');
    c.write(Buffer.alloc(39, 0x62));
    const ok2 = await c.readLine();
    expect(/^OK 50 \d+$/.test(ok2), `${label}: UPLOAD 50 (2 strikes used) OK`);
    c.destroy();
  }
  // 6. UDP LOSS forms + PLOSS
  {
    const c = connect();
    const uuid = crypto.randomUUID();
    c.writeLine(`HI ${uuid}`);
    expect(/^HELLO /.test(await c.readLine()), `${label}: HI uuid session`);
    c.writeLine('INITPLOSS');
    expect((await c.readLine()) === 'OK', `${label}: INITPLOSS → OK`);
    const u = udpClient();
    u.send(`LOSS 123 0 ${uuid}`);          // init form: counted, no reply
    u.send(`LOSS 124 1 ${uuid}`);
    const none = await u.next(600);
    expect(none === null, `${label}: LOSS init form → no reply`);
    u.send(`LOSS 125 2 ${uuid} 999`);      // loaded-latency: RECV reply
    const recv = await u.next(2000);
    expect(recv !== null && recv.startsWith('RECV 2 999 ['), `${label}: LOSS loaded → RECV <seq> <timer> [`);
    c.writeLine('PLOSS');
    const ploss = await c.readLine();
    expect(/^PLOSS 3 0 2$/.test(ploss), `${label}: PLOSS 3 0 2 (got "${ploss}")`);
    u.close();
    c.destroy();
  }
  // 7. multi-command DOWNLOAD on one connection (CLI reuses connections)
  {
    const c = connect();
    c.writeLine('DOWNLOAD 50');
    const d1 = await c.readExact(50);
    c.writeLine('DOWNLOAD 70');
    const d2 = await c.readExact(70);
    expect(d1[49] === 0x0a && d2[69] === 0x0a, `${label}: sequential DOWNLOADs on one conn`);
    c.writeLine('UPLOAD 64 15000 4');
    c.write(Buffer.alloc(51, 0x63));
    expect(/^OK 64 \d+$/.test(await c.readLine()), `${label}: UPLOAD after DOWNLOADs`);
    c.destroy();
  }
  // 8. CRLF tolerance + UPLOAD_STATS + bare PING
  {
    const c = connect();
    c.write(Buffer.from('HI\r\n', 'latin1'));
    expect(/^HELLO /.test(await c.readLine()), `${label}: CRLF HI → HELLO`);
    c.writeLine('UPLOAD_STATS');
    expect((await c.readLine()) === 'ERROR', `${label}: UPLOAD_STATS → ERROR`);
    c.writeLine('PING');
    expect((await c.readLine()) === 'ERROR', `${label}: bare PING → ERROR`);
    c.destroy();
  }
  if (checkLog) await checkLog(label);
}

// ---------------------------------------------------------------- TLS mux suite
async function tlsMuxSuite(gw) {
  section('TLS mux (first-byte routing, daemon parity PROTOCOL_CONTRACT §1)');

  // A well-formed fake ClientHello record: 16 03 01 <len:2> 01 <junk>.
  const mkClientHello = () => {
    const body = crypto.randomBytes(40);
    const rec = Buffer.alloc(5 + body.length);
    rec[0] = 0x16; rec[1] = 0x03; rec[2] = 0x01;      // handshake, TLS 1.0 record
    rec.writeUInt16BE(body.length, 3);
    body.copy(rec, 5);
    // body[0] must be 0x01 (ClientHello) for the 6th byte check
    rec[5] = 0x01;
    return rec;
  };

  // 1. ClientHello → proxied to the loopback gateway (ECHO: prefix proves it)
  {
    const ch = mkClientHello();
    const c = connect();
    c.write(ch);
    const back = await c.readExact(5 + ch.length, 5000);
    expect(back.subarray(0, 5).toString('latin1') === 'ECHO:', 'mux: ClientHello routed to gateway upstream');
    expect(back.subarray(5).equals(ch), 'mux: proxied bytes exact (prebuf forwarded, no loss/dup)');
    c.destroy();
  }
  // 2. NetGauge stays on the front (no proxy)
  {
    const c = connect();
    c.writeLine('HI');
    const hello = await c.readLine();
    expect(/^HELLO 2\.11 /.test(hello), 'mux: NetGauge HI → front HELLO (not proxied)');
    c.destroy();
  }
  // 3. split ClientHello (byte 1 arrives, rest 300 ms later) → still proxied
  {
    const ch = mkClientHello();
    const c = connect();
    c.write(ch.subarray(0, 3));
    await sleep(300);
    c.write(ch.subarray(3));
    const back = await c.readExact(5 + ch.length, 5000);
    expect(back.subarray(0, 5).toString('latin1') === 'ECHO:' && back.subarray(5).equals(ch),
      'mux: split ClientHello tolerated (waits for decisive bytes)');
    c.destroy();
  }
  // 4. 0x16 0x03 with an IMPOSSIBLE record shape (minor 0x09) → NetGauge front
  {
    const c = connect();
    const bad = Buffer.concat([Buffer.from([0x16, 0x03, 0x09, 0x00, 0x40, 0x01, 0x77]), Buffer.from('\n', 'latin1')]);
    c.write(bad);
    const line = await c.readLine();
    expect(line === 'ERROR', 'mux: bad TLS record shape falls to NetGauge front (ERROR)');
    c.destroy();
  }
  // 5. gateway-side accounting: exactly 2 proxied connections so far
  await sleep(200);
  const s = gw.stats();
  expect(s.conns === 2, `mux: upstream saw exactly 2 proxied conns (got ${s.conns})`);
  expect(s.received.length > 0, 'mux: upstream received the ClientHello bytes');

  // 6. CRASH REGRESSION: a client that RSTs mid-sniff (0x16 0x03 … sent,
  //    then abort) must never kill the process — the very first official-CLI
  //    run against the mux died exactly this way (unhandled ECONNRESET,
  //    27 Nov 2026). The bridge must keep serving afterwards.
  for (let i = 0; i < 3; i++) {
    const c = connect();
    c.write(Buffer.from([0x16, 0x03]));
    await sleep(60);
    try { c.sock.resetAndDestroy ? c.sock.resetAndDestroy() : c.sock.destroy(); } catch { /* race */ }
  }
  await sleep(250);
  const c6 = connect();
  c6.writeLine('HI');
  expect(/^HELLO 2\.11 /.test(await c6.readLine()), 'mux: survives client RST during sniff (no crash)');
  c6.destroy();
}

// ------------------------------------------------- port-authority suite
// The operator contract: OoklaServer.properties is the ONLY port authority —
// multiple ports, every port serves the FULL mux, per-port UDP loss plane,
// and the gateway reached over a UNIX SOCKET (mint + HTTP lane) with no
// gateway TCP port anywhere.
async function portAuthoritySuite(gwUnix) {
  section('port authority: multi-port front + unix-socket gateway');
  const logPath = path.join(os.tmpdir(), `speedtest-bridge-test-portauth-${Date.now()}.jsonl`);
  const child = spawn(process.execPath, [BRIDGE, '--log', logPath], {
    env: {
      ...process.env,
      SPEEDTEST_BRIDGE_PORTS: `${BRIDGE_PORT},${BRIDGE_PORT_2}`,
      SPEEDTEST_BRIDGE_UDP_PORTS: `${BRIDGE_PORT},${BRIDGE_PORT_2}`,
      SPEEDTEST_BRIDGE_GATEWAY_BASE: `unix:${GW_UNIX_SOCK}`,
      SPEEDTEST_BRIDGE_HTTP_UPSTREAM: `unix:${GW_UNIX_SOCK}`,
      SPEEDTEST_BRIDGE_BACKEND: 'worker-http',
      // NOTE: no SPEEDTEST_BRIDGE_TOKEN — the mint MUST go over the socket.
      SPEEDTEST_BRIDGE_WORKER_BASE: `http://127.0.0.1:${WORKER_PORT}`,
      SPEEDTEST_BRIDGE_HTTP_CHUNK: String(64 * 1024),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  await sleep(700);
  try {
    expect(child.exitCode === null, `portauth: bridge started (multi-port ${BRIDGE_PORT}+${BRIDGE_PORT_2})`);

    // 1. EVERY port serves the full native front (no port is "special").
    for (const p of [BRIDGE_PORT, BRIDGE_PORT_2]) {
      const c = connect(p);
      c.writeLine('HI');
      expect(/^HELLO /.test(await c.readLine()), `portauth: :${p} HI → HELLO (full mux on every port)`);
      c.writeLine('DOWNLOAD 4096');
      const d = await c.readExact(4096);
      expect(d.length === 4096 && d[4095] === 0x0a, `portauth: :${p} DOWNLOAD 4096 byte-exact`);
      c.destroy();
    }

    // 2. The lazy mint went over the UNIX socket (no TCP gateway exists).
    await sleep(300);
    expect(gwUnix.stats().mints >= 1, `portauth: token minted over the unix socket (${gwUnix.stats().mints})`);
    const events = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const meta = events.find((e) => e.k === 'meta');
    expect(meta && Array.isArray(meta.ports) && meta.ports.join(',') === `${BRIDGE_PORT},${BRIDGE_PORT_2}`,
      `portauth: meta logs the port list (${meta && JSON.stringify(meta.ports)})`);
    expect(meta && Array.isArray(meta.udpPorts) && meta.udpPorts.length === 2, 'portauth: meta logs the udp port list');
    expect(events.filter((e) => e.k === 'dl_done').length >= 2, 'portauth: dl_done on both ports');
    expect(events.filter((e) => e.k === 'worker_err').length === 0, 'portauth: zero worker_err');

    // 3. Per-port UDP loss plane on BOTH udp ports.
    for (const p of [BRIDGE_PORT, BRIDGE_PORT_2]) {
      const c = connect();
      const uuid = crypto.randomUUID();
      c.writeLine(`HI ${uuid}`);
      await c.readLine();
      c.writeLine('INITPLOSS');
      await c.readLine();
      const u = udpClient(p);
      u.send(`LOSS 125 2 ${uuid} 999`);
      const recv = await u.next(2500);
      expect(recv !== null && recv.startsWith('RECV 2 999 ['), `portauth: UDP :${p} LOSS loaded → RECV`);
      u.close();
      c.destroy();
    }

    // 4. HTTP lane: a plain-HTTP request on a front port pipes to the
    //    gateway over the SAME unix socket and the answer comes back.
    {
      const resp = await new Promise((resolve, reject) => {
        const s = net.connect({ port: BRIDGE_PORT, host: '127.0.0.1' });
        let buf = '';
        const t = setTimeout(() => { s.destroy(); reject(new Error('http-pipe timeout')); }, 5000);
        s.on('connect', () => s.write('GET /api/health HTTP/1.0\r\nHost: x\r\n\r\n'));
        s.on('data', (c) => { buf += c.toString('latin1'); });
        s.on('close', () => { clearTimeout(t); resolve(buf); });
        s.on('error', (e) => { clearTimeout(t); reject(e); });
      });
      expect(/^HTTP\/1\.[01] 200/.test(resp) && resp.includes('"ok":true'),
        `portauth: HTTP on :${BRIDGE_PORT} → piped via unix socket → gateway 200 (${resp.split('\r\n')[0]})`);
      expect(gwUnix.stats().healths >= 1, 'portauth: gateway saw the piped /api/health');
    }
  } finally {
    await waitExit(child);
  }
}

async function rateLimitSuite() {
  section('per-IP connection rate limit (SPEEDTEST_BRIDGE_CONN_RATE_PER_MIN=4)');
  const b = await spawnBridge('local', { SPEEDTEST_BRIDGE_CONN_RATE_PER_MIN: '4' });
  children.push(b.child);
  const keep = [];
  for (let i = 0; i < 4; i++) {
    const c = connect();
    c.writeLine('HI');
    expect(/^HELLO /.test(await c.readLine()), `rate: conn ${i + 1}/4 served`);
    keep.push(c);
  }
  // 5th connection within the same minute → destroyed without any reply
  const c5 = connect();
  const r = await c5.readMaybe(800);
  expect(r === null, 'rate: 5th conn gets no reply');
  await sleep(300);
  expect(c5.closed(), 'rate: 5th conn destroyed');
  for (const c of keep) c.destroy();
  await waitExit(b.child);
  await sleep(200);
  const events = fs.readFileSync(b.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(events.some((e) => e.k === 'conn_rate_rejected'), 'rate: conn_rate_rejected logged');
  expect(!events.some((e) => e.k === 'tls_proxy_open'), 'rate: no spurious TLS routing');
}

// ------------------------------------------------ TLS-termination suite (production mode)
// Production mux shape: TLS terminates IN the bridge (daemon parity) so the
// official client's PRIMARY path — NetGauge INSIDE TLS — is served by the
// front; an HTTP method (outside or inside TLS) pipes to the gateway's
// loopback plain listener.
async function tlsTerminateSuite() {
  section('TLS mux — terminate in-bridge (daemon parity: NetGauge INSIDE TLS)');
  const certDir = path.join(os.tmpdir(), `speedtest-bridge-tlscert-${Date.now()}`);
  const pem = makeSelfSignedCert(certDir);
  if (!pem) { console.error('  SKIP: openssl not available'); return; }

  const b = await spawnBridge('local', {
    SPEEDTEST_BRIDGE_TLS_CERT: pem.cert,
    SPEEDTEST_BRIDGE_TLS_KEY: pem.key,
    SPEEDTEST_BRIDGE_HTTP_UPSTREAM: `127.0.0.1:${GW_PLAIN_PORT}`,
  });
  children.push(b.child);
  try {
    // 1. THE official-CLI primary path: TLS handshake, encrypted-binary hello
    //    → ERROR INSIDE TLS → HI → HELLO → full NetGauge semantics inside TLS.
    {
      const c = tlsConnect();
      const binHello = crypto.randomBytes(16);
      for (let i = 0; i < binHello.length; i++) if (binHello[i] === 0x0a) binHello[i] = 0x0b;
      binHello[0] = 0x48; binHello[1] = 0x49; binHello[2] = 0x7e;
      c.write(Buffer.concat([binHello, Buffer.from('\n', 'latin1')]));
      expect((await c.readLine()) === 'ERROR', 'tls-term: binary hello → ERROR (inside TLS)');
      c.writeLine('HI');
      expect(/^HELLO 2\.11 /.test(await c.readLine()), 'tls-term: HI → HELLO inside TLS');
      c.writeLine('GETIP');
      expect(/^YOURIP /.test(await c.readLine()), 'tls-term: GETIP → YOURIP inside TLS');
      c.writeLine('DOWNLOAD 100');
      const d = await c.readExact(100);
      expect(d.length === 100 && d[99] === 0x0a && d.subarray(0, 9).toString('latin1') === 'DOWNLOAD ',
        'tls-term: DOWNLOAD 100 byte-exact inside TLS');
      c.destroy();
    }
    // 2. HTTP INSIDE TLS → piped to the gateway plain listener.
    {
      const c = tlsConnect();
      c.write('GET /api/health HTTP/1.0\r\nHost: x\r\n\r\n');
      const line = (await c.readLine()).replace(/\r$/, '');
      expect(line === 'PLAIN-GW: GET /api/health HTTP/1.0', `tls-term: HTTP-inside-TLS piped to gateway (got "${line}")`);
      c.destroy();
    }
    // 3. Plain HTTP (outside TLS) → same gateway pipe.
    {
      const c = connect();
      c.write('POST /api/sessions HTTP/1.0\r\nHost: x\r\n\r\n');
      const line = (await c.readLine()).replace(/\r$/, '');
      expect(line === 'PLAIN-GW: POST /api/sessions HTTP/1.0', `tls-term: plain HTTP piped to gateway (got "${line}")`);
      c.destroy();
    }
    // 4. Plain NetGauge (outside TLS) still on the front (the fallback lane).
    {
      const c = connect();
      c.writeLine('HI');
      expect(/^HELLO 2\.11 /.test(await c.readLine()), 'tls-term: plain NetGauge HI → HELLO (front unchanged)');
      c.destroy();
    }
    await sleep(200);
    const logText = fs.readFileSync(b.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(logText.some((e) => e.k === 'tls_open'), 'tls-term: tls_open logged');
    expect(!logText.some((e) => e.k === 'tls_handshake_err'), 'tls-term: zero tls_handshake_err');
  } finally {
    await waitExit(b.child);
    try { fs.rmSync(certDir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}

// ---------------------------------------------------------------- runner
async function spawnBridge(backend, extraEnv = {}) {
  const logPath = path.join(os.tmpdir(), `speedtest-bridge-test-${backend}-${Date.now()}.jsonl`);
  const child = spawn(process.execPath, [BRIDGE, '--port', String(BRIDGE_PORT), '--backend', backend, '--log', logPath], {
    env: {
      ...process.env,
      SPEEDTEST_BRIDGE_TOKEN: TOKEN,
      SPEEDTEST_BRIDGE_WORKER_BASE: `http://127.0.0.1:${WORKER_PORT}`,
      SPEEDTEST_BRIDGE_TLS_UPSTREAM: `127.0.0.1:${GW_MOCK_PORT}`,
      SPEEDTEST_BRIDGE_WS_CHUNK: String(64 * 1024), // exercise multi-chunk relays with small sizes
      SPEEDTEST_BRIDGE_HTTP_CHUNK: String(64 * 1024),
      SPEEDTEST_BRIDGE_UL_CHUNK: String(32 * 1024),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  await sleep(700);
  if (child.exitCode !== null) throw new Error('bridge exited: ' + out);
  return { child, logPath, out: () => out };
}

async function waitExit(child) {
  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));
}

async function main() {
  const which = process.argv[2] || 'all';
  const mock = await startMockWorker();
  const gw = await startMockGateway();
  const gwPlain = await startMockPlainGateway();
  const gwUnix = await startMockUnixGateway();
  process.on('unhandledRejection', (e) => {
    fail++; fails.push('unhandled rejection: ' + String((e && e.message) || e));
  });
  const cleanup = () => { for (const c of children) { try { c.kill('SIGKILL'); } catch {} } };
  process.on('exit', cleanup);

  async function runBackend(name, checkLogFn) {
    const b = await spawnBridge(name);
    children.push(b.child);
    try {
      await protocolSuite(name, checkLogFn ? () => checkLogFn(b) : null);
    } finally {
      await waitExit(b.child);
    }
  }

  if (which === 'all' || which === 'mux') {
    const b = await spawnBridge('local');
    children.push(b.child);
    try {
      await protocolSuite('local');
      await tlsMuxSuite(gw);
    } finally {
      await waitExit(b.child);
    }
  }
  if (which === 'all' || which === 'rate') {
    await rateLimitSuite();
  }
  if (which === 'all' || which === 'portauth') {
    await portAuthoritySuite(gwUnix);
  }
  if (which === 'all' || which === 'tls-term') {
    await tlsTerminateSuite();
    await sleep(150);
    const s = gwPlain.stats();
    expect(s.seen.includes('GET /api/health HTTP/1.0') && s.seen.includes('POST /api/sessions HTTP/1.0'),
      `tls-term: gateway plain listener saw both piped requests (${JSON.stringify(s.seen)})`);
  }

  if (which === 'all' || which === 'local') {
    await runBackend('local');
  }
  if (which === 'all' || which === 'worker-http') {
    await runBackend('worker-http', (b) => async (label) => {
      await sleep(400); // let async receipts flush
      const logText = fs.readFileSync(b.logPath, 'utf8');
      const events = logText.trim().split('\n').map((l) => JSON.parse(l));
      const dls = events.filter((e) => e.k === 'dl_done');
      const uls = events.filter((e) => e.k === 'ul_done');
      const dlErrs = events.filter((e) => e.k === 'worker_err');
      expect(dls.length >= 7, `${label}: dl_done events logged (${dls.length})`);
      expect(uls.length >= 3, `${label}: ul_done events logged (${uls.length})`);
      expect(uls.every((e) => (e.receipts || 0) >= 1), `${label}: upload receipts present per ul_done`);
      expect(dlErrs.length === 0, `${label}: zero worker_err (${dlErrs.length})`);
      const s = mock.stats();
      expect(s.downRequests >= 7, `${label}: mock worker saw __down requests (${s.downRequests})`);
      expect(s.upRequests >= 3 && s.upBytes >= 89 + 39 + 51, `${label}: mock worker drained upload bytes (${s.upBytes}B)`);
    });
  }
  if (which === 'all' || which === 'worker-ws') {
    await runBackend('worker-ws', (b) => async (label) => {
      await sleep(400);
      const events = fs.readFileSync(b.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const uls = events.filter((e) => e.k === 'ul_done');
      const dlErrs = events.filter((e) => e.k === 'worker_err');
      expect(uls.length >= 3 && uls.every((e) => (e.receipts || 0) >= 1), `${label}: ws upload ack receipts`);
      expect(dlErrs.length === 0, `${label}: zero worker_err (${dlErrs.length})`);
      const s = mock.stats();
      expect(s.wsSessions >= 1 && s.wsCommands >= 10, `${label}: mock ws saw commands (${s.wsCommands})`);
    });
  }

  if (which === 'all' || which === 'concurrency') {
    section('concurrency smoke (worker-http, CLI pattern: 8 × DL 1 MiB + UL 256 KiB)');
    const b = await spawnBridge('worker-http');
    const N = 8;
    const results = await Promise.all(Array.from({ length: N }, async (_, i) => {
      try {
        const c = connect();
        c.writeLine('DOWNLOAD 1048576');
        let got = 0;
        while (got < 1048576) {
          const chunk = await c.readExact(Math.min(65536, 1048576 - got));
          got += chunk.length;
        }
        c.writeLine('UPLOAD 262144 15000 4');
        c.write(Buffer.alloc(262144 - 17, 0x64));
        const ok = await c.readLine();
        c.destroy();
        return { i, got, ok: /^OK 262144 \d+$/.test(ok) };
      } catch (e) {
        return { i, error: String(e.message || e) };
      }
    }));
    expect(results.every((r) => r.got === 1048576 && r.ok), 'concurrency: 8/8 sessions complete');
    await sleep(600);
    const events = fs.readFileSync(b.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(events.filter((e) => e.k === 'worker_err').length === 0, 'concurrency: zero worker_err');
    await waitExit(b.child);
  }

  section('verdict');
  console.log(`${pass}/${pass + fail} checks passed`);
  if (fail > 0) {
    console.error('FAILED:', fails);
    process.exit(1);
  }
  mock.server.close();
  gw.server.close();
  gwPlain.server.close();
  gwUnix.server.close();
  try { fs.unlinkSync(GW_UNIX_SOCK); } catch {}
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });

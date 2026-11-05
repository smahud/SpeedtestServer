#!/usr/bin/env node
/**
 * probe-config-parity.mjs — Configuration-parity probe: behavioral snapshot of
 * ONE server (reference daemon or SpeedtestServer) for the config keys that
 * CONFIG_MATRIX.md lists as P/PNA:
 *   OoklaServer.userAgentFilterEnabled   (UA battery over HTTP)
 *   OoklaServer.websocket.frameSizeLimitBytes (WS frame-size battery)
 *   OoklaServer.addresses / useIPv4 / useIPv6  (listener inventory + per-family connect)
 *
 * Usage: node probe-config-parity.mjs <port> <label> [outDir]
 * Writes <outDir>/config-<label>.json (default outDir: /home/z/my-project/rea-lab/evidence)
 * and prints a compact summary. All variable fields are normalized
 * (Date, PONG timestamps, Sec-WebSocket-Accept, random keys).
 */
import * as net from 'node:net';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const PORT = parseInt(process.argv[2] || '18080', 10);
const LABEL = process.argv[3] || 'run';
const OUTDIR = process.argv[4] || '/home/z/my-project/rea-lab/evidence';
const HOST4 = '127.0.0.1';
const HOST6 = '::1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UA_BATTERY = [
  { tag: 'none', ua: null },
  { tag: 'empty', ua: '' },
  { tag: 'x', ua: 'x' },
  { tag: 'curl', ua: 'curl/8.5.0' },
  { tag: 'wget', ua: 'Wget/1.21.4' },
  { tag: 'python-requests', ua: 'python-requests/2.31.0' },
  { tag: 'go-http', ua: 'Go-http-client/2.0' },
  { tag: 'okhttp', ua: 'okhttp/4.12.0' },
  { tag: 'java', ua: 'Java/1.8.0_312' },
  { tag: 'libwww-perl', ua: 'libwww-perl/6.36' },
  { tag: 'chrome', ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
  { tag: 'firefox', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0' },
  { tag: 'mozilla-token', ua: 'Mozilla' },
  { tag: 'speedtest-cli', ua: 'Speedtest/1.2.0.84' },
  { tag: 'hackerbot', ua: 'HackerBot/1.0' },
  { tag: 'zgrab', ua: 'Mozilla/5.0 zgrab/0.x' },
  { tag: 'masscan', ua: 'masscan/1.3' },
  { tag: 'sqlmap', ua: 'sqlmap/1.7.2#stable (http://sqlmap.org)' },
  { tag: 'nmap', ua: 'nmap-testing' },
  { tag: 'long-4k', ua: 'A'.repeat(4096) },
  { tag: 'spaces', ua: '   ' },
];

const WS_SIZES = process.env.WS_SIZES ? process.env.WS_SIZES.split(',').map(Number) : [12, 64, 4096, 65535, 262144, 1048576, 5242879, 5242880, 5242881, 6291456];

/** Raw HTTP request probe: returns normalized status line + body meta. */
function httpProbe(port, req, { waitMs = 700 } = {}) {
  return new Promise((resolve) => {
    let data = Buffer.alloc(0);
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try { sock.destroy(); } catch {}
      const text = data.toString('latin1');
      const status = text.split('\r\n')[0] || '(no response)';
      resolve({
        status,
        len: data.length,
        closed,
        normalized: text
          .replace(/Date: .*\r\n/m, 'Date: <date>\r\n')
          .replace(/\r\n\r\n.*/s, '\r\n\r\n<body>')
          .slice(0, 400),
      });
    };
    let t;
    const sock = net.connect({ host: HOST4, port }, () => {
      sock.write(req);
      t = setTimeout(() => finish(false), waitMs);
    });
    sock.on('data', (d) => { data = Buffer.concat([data, d]); });
    sock.on('close', () => finish(true));
    sock.on('error', () => finish(true));
  });
}

/** One WS connection: handshake then a single text frame of `payload`. */
function wsFrameProbe(port, payload, { waitMs = 900 } = {}) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const head = `GET /ws HTTP/1.1\r\nHost: san1.local\r\nUser-Agent: probe\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
    const sock = net.connect({ host: HOST4, port }, () => sock.write(head));
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let handshake = '';
    let frames = [];
    let closed = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try { sock.destroy(); } catch {}
      resolve({
        handshake: handshake
          .replace(/Sec-WebSocket-Accept: .+/m, 'Sec-WebSocket-Accept: <hash>')
          .replace(/Date: .*\r\n/m, 'Date: <date>\r\n')
          .split('\r\n')[0],
        frames,
        closedByServer: closed,
      });
    };
    let t = setTimeout(finish, waitMs + 600);
    const sendFrame = (pl) => {
      const mask = crypto.randomBytes(4);
      const len = pl.length;
      let hdr;
      if (len < 126) hdr = Buffer.from([0x81, 0x80 | len]);
      else if (len < 65536) hdr = Buffer.from([0x81, 0x80 | 126, len >> 8, len & 0xff]);
      else hdr = Buffer.concat([Buffer.from([0x81, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = pl[i] ^ mask[i % 4];
      sock.write(Buffer.concat([hdr, mask, masked]));
    };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx !== -1) {
          handshake = buf.subarray(0, idx).toString('latin1');
          upgraded = true;
          buf = buf.subarray(idx + 4);
          sendFrame(payload);
          t = setTimeout(finish, waitMs);
        }
      }
      if (upgraded) {
        while (buf.length >= 2) {
          const opcode = buf[0] & 0x0f;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) break;
          const pl = buf.subarray(off, off + len);
          frames.push({ opcode, len, preview: pl.toString('latin1').slice(0, 80) });
          buf = buf.subarray(off + len);
          if (opcode === 0x8) closed = true;
        }
      }
    });
    sock.on('close', () => { closed = true; finish(); });
    sock.on('error', () => finish());
  });
}

/** Family connectivity check. */
function familyCheck(host, port, timeout = 900) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok, err) => { try { s.destroy(); } catch {}; resolve({ host, ok, err: err ? String(err.code || err).slice(0, 60) : undefined }); };
    s.setTimeout(timeout, () => done(false, 'timeout'));
    s.on('connect', () => done(true));
    s.on('error', (e) => done(false, e));
  });
}

function listenerInventory(port) {
  const parse = (out) =>
    out.split('\n').filter(Boolean).slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c.length > 3 && c[3] && c[3].endsWith(`:${port}`))
      .map((c) => ({ local: c[3], process: (c[6] || '').replace(/users:\(\("([^"]+)".*/, '$1') }));
  let tcp = [], udp = [];
  try { tcp = parse(execSync(`ss -tlnp 2>/dev/null`, { encoding: 'utf8' })); } catch {}
  try { udp = parse(execSync(`ss -ulnp 2>/dev/null`, { encoding: 'utf8' })); } catch {}
  return { tcp, udp };
}

const out = { label: LABEL, port: PORT, generatedAt: new Date().toISOString(), listeners: listenerInventory(PORT) };

// per-family connects
out.familyConnect = {
  v4: await familyCheck(HOST4, PORT),
  v6: await familyCheck(HOST6, PORT),
};

// UA battery (HTTP /hi, Host: san1.local — a certificate SAN)
out.uaFilter = [];
for (const { tag, ua } of UA_BATTERY) {
  const uaLine = ua === null ? '' : `User-Agent: ${ua}\r\n`;
  const req = `GET /hi HTTP/1.1\r\nHost: san1.local\r\n${uaLine}Connection: Close\r\n\r\n`;
  const r = await httpProbe(PORT, req);
  out.uaFilter.push({ tag, ua: ua === null ? null : ua.slice(0, 60), response: r.status, len: r.len, closed: r.closed });
  await sleep(80);
}

// WS frame-size battery (fresh connection per size; payload = "PING 1\n" + # padding)
out.wsFrameLimit = [];
for (const size of WS_SIZES) {
  const payload = (() => { const b = Buffer.alloc(Math.max(size, 0), 0x23); Buffer.from('PING 1\n').copy(b, 0); return b; })(); // EXACT `size`-byte payload ('PING 1\n' is 7 bytes)
  const r = await wsFrameProbe(PORT, payload);
  out.wsFrameLimit.push({
    size,
    handshake: r.handshake,
    frames: r.frames.map((f) => ({ opcode: f.opcode, len: f.len, preview: f.preview.replace(/PONG \d+/, 'PONG <ts>') })),
    closedByServer: r.closedByServer,
  });
  await sleep(120);
}

fs.mkdirSync(OUTDIR, { recursive: true });
const file = path.join(OUTDIR, `config-${LABEL}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`wrote ${file}`);
console.log('--- listeners ---');
console.log(JSON.stringify(out.listeners));
console.log('--- familyConnect ---');
console.log(`v4: ${out.familyConnect.v4.ok ? 'OK' : 'FAIL'}  v6: ${out.familyConnect.v6.ok ? 'OK' : 'FAIL'}`);
console.log('--- uaFilter (tag -> status/len) ---');
for (const u of out.uaFilter) console.log(`${u.tag.padEnd(18)} ${String(u.response).padEnd(30)} len=${u.len}${u.closed ? ' closed' : ''}`);
console.log('--- wsFrameLimit (size -> outcome) ---');
for (const w of out.wsFrameLimit) {
  const reply = w.frames.length ? `frame op=${w.frames[0].opcode} len=${w.frames[0].len}` : 'no frame';
  console.log(`${String(w.size).padEnd(8)} ${w.handshake.padEnd(30)} ${reply}${w.closedByServer ? ' CLOSED-BY-SERVER' : ''}`);
}

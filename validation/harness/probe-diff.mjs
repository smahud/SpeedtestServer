#!/usr/bin/env node
/**
 * rea-lab/probe-diff.mjs — Differential probe battery: official OoklaServer
 * daemon vs SpeedtestServer (TypeScript). Byte-exact comparison with
 * normalization ONLY for inherently variable fields (timestamps, random
 * payload, instance UUIDs — case/format still compared).
 *
 * Usage: node probe-diff.mjs <daemon-port> <sts-port> [--http-only|--tcp-only|--udp-only|--ws-only]
 */
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as dgram from 'node:dgram';
import * as crypto from 'node:crypto';

const DAEMON_PORT = parseInt(process.argv[2] || '18080', 10);
const STS_PORT = parseInt(process.argv[3] || '18081', 10);
const HOST = '127.0.0.1';
const ONLY = process.argv[4] || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Collect everything a server sends back for a raw TCP payload, until quiet. */
function tcpProbe(port, payload, { tlsMode = false, waitMs = 900, maxBytes = 3 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      resolve({ data: Buffer.concat(chunks), closed });
    };
    let timer;
    const makeSocket = () =>
      tlsMode
        ? tls.connect({ host: HOST, port, rejectUnauthorized: false, servername: 'localhost', minVersion: 'TLSv1.2' }, () => {
            sock.write(payload);
            timer = setTimeout(() => finish(false), waitMs);
          })
        : net.connect({ host: HOST, port }, () => {
            sock.write(payload);
            timer = setTimeout(() => finish(false), waitMs);
          });
    let sock = makeSocket();
    sock.on('data', (d) => {
      chunks.push(d);
      total += d.length;
      if (total >= maxBytes) finish(false);
    });
    sock.on('close', () => finish(true));
    sock.on('error', () => finish(true));
    if (!tlsMode) {
      // write immediately for plain
      // (connection callback above writes)
    }
  });
}

/** HTTP probe: send raw request, capture raw response bytes. */
async function httpProbe(port, raw, { tlsMode = false } = {}) {
  const r = await tcpProbe(port, Buffer.from(raw, 'latin1'), { tlsMode, waitMs: 700 });
  return r;
}

/** UDP probe: send datagrams, collect replies with source info. */
function udpProbe(port, datagrams, waitMs = 700) {
  return new Promise((resolve) => {
    const replies = [];
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch {}
      resolve(replies);
    };
    let timer;
    sock.on('message', (msg, rinfo) => replies.push({ from: `${rinfo.address}:${rinfo.port}`, data: msg.toString('latin1'), bytes: msg.length }));
    sock.on('error', () => finish());
    sock.bind(0, () => {
      (async () => {
        for (const d of datagrams) {
          await new Promise((r) => sock.send(Buffer.from(d, 'latin1'), port, HOST, r));
          await sleep(60);
        }
        timer = setTimeout(finish, waitMs);
      })();
    });
  });
}

/* ---------------- normalization ---------------- */
function normNetGauge(buf) {
  // Normalize variable fields; PRESERVE structural format + case of UUIDs.
  let s = buf.toString('latin1');
  s = s.replace(/PONG \d{10,}/g, 'PONG <ts>');
  s = s.replace(/UPTIME \d+/g, 'UPTIME <s>');
  s = s.replace(/OK (\d+) \d{10,}/g, 'OK $1 <ts>');
  return s;
}
function maskDownloadPayload(s) {
  // DOWNLOAD data: keep the 9-byte prefix and the total length only.
  const m = s.match(/^DOWNLOAD /);
  if (m) return `DOWNLOAD<prefix9> <${s.length} bytes total>`;
  return s;
}
function normHttp(raw) {
  let s = raw.toString('latin1');
  s = s.replace(/^Date: .*\r?\n/m, 'Date: <date>\r\n');
  s = s.replace(/^Set-Cookie: .*\r?\n/mi, 'Set-Cookie: <cookie>\r\n');
  return s;
}
function uuidShape(s) {
  const m = s.match(/\b([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\b/);
  if (!m) return null;
  return { raw: m[1], case: m[1] === m[1].toUpperCase() ? 'UPPER' : m[1] === m[1].toLowerCase() ? 'lower' : 'mixed' };
}

/* ---------------- battery ---------------- */
const results = [];
async function tcpCase(name, payload, opts = {}) {
  const d = await tcpProbe(DAEMON_PORT, Buffer.from(payload, 'latin1'), opts);
  const s = await tcpProbe(STS_PORT, Buffer.from(payload, 'latin1'), opts);
  const nd = normNetGauge(d.data);
  const ns = normNetGauge(s.data);
  results.push({
    group: opts.group || 'netgauge-tcp',
    name,
    daemon: { closed: d.closed, len: d.data.length, preview: maskDownloadPayload(nd.slice(0, 220)) },
    sts: { closed: s.closed, len: s.data.length, preview: maskDownloadPayload(ns.slice(0, 220)) },
    identical: nd === ns && d.closed === s.closed,
  });
}
async function httpCase(name, raw, opts = {}) {
  const d = await httpProbe(DAEMON_PORT, raw, opts);
  const s = await httpProbe(STS_PORT, raw, opts);
  const nd = normHttp(d.data);
  const ns = normHttp(s.data);
  results.push({
    group: 'http',
    name,
    daemon: { closed: d.closed, len: d.data.length, preview: nd.slice(0, 400).replace(/\r\n/g, '⏎') },
    sts: { closed: s.closed, len: s.data.length, preview: ns.slice(0, 400).replace(/\r\n/g, '⏎') },
    identical: nd === ns && d.closed === s.closed,
  });
}

const UA = 'User-Agent: probe-diff\r\n';

async function runTcp() {
  // --- basics ---
  await tcpCase('HI', 'HI\n');
  await tcpCase('HI with uuid', 'HI 12345678-1234-1234-1234-123456789abc\n');
  await tcpCase('HI with NON-uuid', 'HI not-a-uuid\n');
  await tcpCase('HI extra spaces', 'HI  12345678-1234-1234-1234-123456789abc\n');
  await tcpCase('HI trailing space', 'HI \n');
  await tcpCase('lowercase hi', 'hi\n');
  await tcpCase('GETIP', 'GETIP\n');
  await tcpCase('CAPABILITIES', 'CAPABILITIES\n');
  await tcpCase('UPTIME', 'UPTIME\n');
  await tcpCase('PING', 'PING\n');
  await tcpCase('PING 1', 'PING 1\n');
  await tcpCase('PING extra', 'PING 1 2 3\n');
  await tcpCase('UPLOAD_STATS', 'UPLOAD_STATS\n');
  await tcpCase('INITPLOSS bare (no HI)', 'INITPLOSS\n');
  await tcpCase('PLOSS no session', 'PLOSS\n');
  await tcpCase('QUIT', 'QUIT\n');
  await tcpCase('unknown cmd', 'FROBNICATE\n');
  await tcpCase('empty line', '\n');
  await tcpCase('CRLF line ending', 'GETIP\r\n');
  await tcpCase('pipelined burst', 'HI\nGETIP\nCAPABILITIES\nUPTIME\nPING 1\n');
  await tcpCase('GETIP twice', 'GETIP\nGETIP\n');
  await tcpCase('GETIP trailing space', 'GETIP \n');
  await tcpCase('GETIP extra arg', 'GETIP 1\n');
  // --- SERVERID + uuid case ---
  {
    const d = await tcpProbe(DAEMON_PORT, Buffer.from('SERVERID\n'));
    const s = await tcpProbe(STS_PORT, Buffer.from('SERVERID\n'));
    const du = uuidShape(d.data.toString('latin1'));
    const su = uuidShape(s.data.toString('latin1'));
    results.push({
      group: 'netgauge-tcp',
      name: 'SERVERID uuid case/format',
      daemon: { preview: d.data.toString('latin1').slice(0, 120), uuid: du },
      sts: { preview: s.data.toString('latin1').slice(0, 120), uuid: su },
      identical: !!du && !!su && du.case === su.case,
    });
  }
  // --- DOWNLOAD edges ---
  await tcpCase('DOWNLOAD 0', 'DOWNLOAD 0\n');
  await tcpCase('DOWNLOAD 9 (prefix only)', 'DOWNLOAD 9\n', { waitMs: 500 });
  await tcpCase('DOWNLOAD 10', 'DOWNLOAD 10\n', { waitMs: 500 });
  await tcpCase('DOWNLOAD 100', 'DOWNLOAD 100\n', { waitMs: 500 });
  await tcpCase('DOWNLOAD with args', 'DOWNLOAD 100000 16 0\n', { waitMs: 500 });
  await tcpCase('DOWNLOAD negative', 'DOWNLOAD -1\n');
  await tcpCase('DOWNLOAD notanumber', 'DOWNLOAD abc\n');
  await tcpCase('DOWNLOAD huge', 'DOWNLOAD 99999999999999999999\n');
  await tcpCase('DOWNLOAD lowercase', 'download 100\n');
  // --- UPLOAD edges (must count inclusive) ---
  await tcpCase('UPLOAD exact line len', 'UPLOAD 11\n');
  await tcpCase('UPLOAD shorter than line', 'UPLOAD 5\n');
  await tcpCase('UPLOAD 100 + 89B', 'UPLOAD 100\n' + 'x'.repeat(89), { waitMs: 700 });
  await tcpCase('UPLOAD with extra args', 'UPLOAD 100 15000 16\n' + 'y'.repeat(89));
  await tcpCase('UPLOAD 0', 'UPLOAD 0\n');
  await tcpCase('UPLOAD negative', 'UPLOAD -5\n');
  await tcpCase('UPLOAD garbage arg', 'UPLOAD abc\n');
  // --- after QUIT ---
  await tcpCase('cmd after QUIT', 'QUIT\nGETIP\n');
  // --- binary garbage (encrypted-hello path) ---
  await tcpCase('binary garbage', Buffer.from([0x17, 0x83, 0x92, 0xaa, 0x00, 0x11, 0x22, 0x33]).toString('latin1'));
  // --- long line under limit ---
  await tcpCase('long-ish line (500B)', 'PING ' + 'a'.repeat(500) + '\n');
}

async function runHttp() {
  await httpCase('GET /', `GET / HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('GET /hi', `GET /hi HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('GET /hi?query=1', `GET /hi?x=1 HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('HEAD /hi', `HEAD /hi HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('GET /HI (case)', `GET /HI HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('GET /hi/ (trailing slash)', `GET /hi/ HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('GET //hi (double slash)', `GET //hi HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('GET /./hi (dot segment)', `GET /./hi HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('OPTIONS *', `OPTIONS * HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('OPTIONS /hi', `OPTIONS /hi HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('TRACE /hi', `TRACE /hi HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('PUT /hi', `PUT /hi HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('DELETE /hi', `DELETE /hi HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('PATCH /hi', `PATCH /hi HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('no User-Agent', `GET /hi HTTP/1.1\r\nHost: san1.local\r\nConnection: close\r\n\r\n`);
  await httpCase('empty UA value', `GET /hi HTTP/1.1\r\nHost: san1.local\r\nUser-Agent: \r\nConnection: close\r\n\r\n`);
  await httpCase('HTTP/1.0 GET /hi', `GET /hi HTTP/1.0\r\n${UA}\r\n`);
  await httpCase('no Host header', `GET /hi HTTP/1.1\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('GET unknown path', `GET /nope HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('GET /speedtest/latency.txt', `GET /speedtest/latency.txt HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('GET /latency.txt', `GET /latency.txt HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('GET /crossdomain.xml', `GET /crossdomain.xml HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('GET random250x250.jpg', `GET /speedtest/random250x250.jpg HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`, { waitMs: 900 });
  await httpCase('HEAD random250x250.jpg', `HEAD /speedtest/random250x250.jpg HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('GET random250x500.jpg (mismatch)', `GET /speedtest/random250x500.jpg HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('GET random123x123.jpg (unknown size)', `GET /speedtest/random123x123.jpg HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('GET random250x250.jpg weird prefix', `GET /foo/bar/random250x250.jpg HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('Range on /hi', `GET /hi HTTP/1.1\r\nHost: san1.local\r\n${UA}Range: bytes=0-1\r\nConnection: close\r\n\r\n`);
  await httpCase('Origin reflection', `GET /hi HTTP/1.1\r\nHost: san1.local\r\n${UA}Origin: https://example.org\r\nConnection: close\r\n\r\n`);
  await httpCase('Origin null', `GET /hi HTTP/1.1\r\nHost: san1.local\r\n${UA}Origin: null\r\nConnection: close\r\n\r\n`);
  await httpCase('POST /speedtest/upload.php body', `POST /speedtest/upload.php HTTP/1.1\r\nHost: san1.local\r\n${UA}Content-Length: 5\r\nConnection: close\r\n\r\n12345`);
  await httpCase('POST /speedtest/upload.php empty', `POST /speedtest/upload.php HTTP/1.1\r\nHost: san1.local\r\n${UA}Content-Length: 0\r\nConnection: close\r\n\r\n`);
  await httpCase('GET /speedtest/upload.php', `GET /speedtest/upload.php HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('POST chunked upload.php', `POST /speedtest/upload.php HTTP/1.1\r\nHost: san1.local\r\n${UA}Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\n12345\r\n0\r\n\r\n`);
  await httpCase('keep-alive two requests', `GET /hi HTTP/1.1\r\nHost: san1.local\r\n${UA}\r\nGET /hi HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('HTTP/2 preface', `PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n${UA}`);
  await httpCase('absolute-form URI', `GET http://localhost/hi HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('long URL 2KB', `GET /${'a'.repeat(2048)} HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
  await httpCase('GET /ws (plain GET not upgrade)', `GET /ws HTTP/1.1\r\nHost: san1.local\r\n${UA}Connection: close\r\n\r\n`);
}

async function runTls() {
  await tcpCase('TLS GETIP (netgauge over TLS)', 'GETIP\n', { tlsMode: true, group: 'tls' });
  await tcpCase('TLS HI', 'HI\n', { tlsMode: true, group: 'tls' });
  // TLS version floors
  for (const [label, min] of [['TLS1.0', 'TLSv1'], ['TLS1.1', 'TLSv1.1']]) {
    const tryOne = async (port) =>
      new Promise((resolve) => {
        const sock = tls.connect({ host: HOST, port, rejectUnauthorized: false, minVersion: min, maxVersion: min }, () => {
          resolve({ ok: true, proto: sock.getProtocol() });
          sock.destroy();
        });
        sock.on('error', (e) => resolve({ ok: false, code: e.code, message: e.message.slice(0, 60) }));
        setTimeout(() => { try { sock.destroy(); } catch {}; resolve({ ok: false, timeout: true }); }, 2500);
      });
    const d = await tryOne(DAEMON_PORT);
    const s = await tryOne(STS_PORT);
    results.push({ group: 'tls', name: `${label} handshake rejected`, daemon: d, sts: s, identical: d.ok === s.ok });
  }
}

async function runUdp() {
  const uuid = crypto.randomUUID();
  const udpCase = async (name, datagrams, followTcp = null) => {
    const d = await udpProbe(DAEMON_PORT, datagrams);
    const s = await udpProbe(STS_PORT, datagrams);
    results.push({
      group: 'udp',
      name,
      daemon: d.map((r) => ({ ...r, from: r.from.replace(/:\d+$/, ':<port>') })),
      sts: s.map((r) => ({ ...r, from: r.from.replace(/:\d+$/, ':<port>') })),
      identical: JSON.stringify(d.map((r) => r.data)) === JSON.stringify(s.map((r) => r.data)),
    });
  };
  await udpCase('LOSS 4-field init', [`LOSS 123 0 ${uuid}\n`]);
  await udpCase('LOSS 5-field loaded', [`LOSS 123 1 ${uuid} 456\n`]);
  await udpCase('LOSS out-of-order + dupe', [`LOSS 1 5 ${uuid} 10\n`, `LOSS 2 3 ${uuid} 20\n`, `LOSS 3 3 ${uuid} 30\n`]);
  await udpCase('LOSS bad uuid', [`LOSS 1 0 not-a-uuid\n`]);
  await udpCase('LOSS wrong field count', [`LOSS 1 2\n`]);
  await udpCase('LOSS 6 fields', [`LOSS 1 2 ${uuid} 3 4\n`]);
  await udpCase('garbage datagram', [`\x17\x83\x92\xaa\x00\x11\x22\x33`]);
  await udpCase('empty datagram', ['']);
  // TCP PLOSS after UDP session
  {
    const uuid2 = crypto.randomUUID();
    await udpProbe(DAEMON_PORT, [`LOSS 100 5 ${uuid2} 200\n`, `LOSS 101 3 ${uuid2} 201\n`]);
    const d = await tcpProbe(DAEMON_PORT, Buffer.from('PLOSS\n'));
    await udpProbe(STS_PORT, [`LOSS 100 5 ${uuid2} 200\n`, `LOSS 101 3 ${uuid2} 201\n`]);
    const s = await tcpProbe(STS_PORT, Buffer.from('PLOSS\n'));
    results.push({
      group: 'udp',
      name: 'PLOSS after 2 UDP pkts (5 then 3)',
      daemon: d.data.toString('latin1').slice(0, 80),
      sts: s.data.toString('latin1').slice(0, 80),
      identical: false,
    });
  }
}

async function runWs() {
  const wsProbe = async (port, frames, { secure = false } = {}) =>
    new Promise((resolve) => {
      const key = crypto.randomBytes(16).toString('base64');
      const head = `GET /ws HTTP/1.1\r\nHost: san1.local\r\n${UA}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
      const sock = secure
        ? tls.connect({ host: HOST, port, rejectUnauthorized: false, servername: 'localhost' }, () => sock.write(head))
        : net.connect({ host: HOST, port }, () => sock.write(head));
      const chunks = [];
      let upgraded = false;
      let handshake = '';
      let frameData = [];
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        try { sock.destroy(); } catch {}
        resolve({ handshake: handshake.replace(/Sec-WebSocket-Accept: .+/m, 'Sec-WebSocket-Accept: <hash>').replace(/Date: .*\r\n/m, 'Date: <date>\r\n'), frames: frameData, closedByServer: closed });
      };
      let closed = false;
      let t = setTimeout(finish, 1400);
      // minimal WS client framing (masked, from client)
      const sendFrame = (payload, opcode = 0x1) => {
        const mask = crypto.randomBytes(4);
        const len = payload.length;
        let hdr;
        if (len < 126) hdr = Buffer.from([0x80 | opcode, 0x80 | len]);
        else hdr = Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 0xff]);
        const masked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
        sock.write(Buffer.concat([hdr, mask, masked]));
      };
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        chunks.push(d);
        buf = Buffer.concat([buf, d]);
        if (!upgraded) {
          const idx = buf.indexOf('\r\n\r\n');
          if (idx !== -1) {
            handshake = buf.subarray(0, idx).toString('latin1');
            upgraded = true;
            buf = buf.subarray(idx + 4);
            (async () => {
              for (const f of frames) {
                sendFrame(Buffer.from(f, 'utf8'));
                await sleep(120);
              }
              t = setTimeout(finish, 900);
            })();
          }
        }
        if (upgraded) {
          // parse server frames (unmasked)
          while (buf.length >= 2) {
            const opcode = buf[0] & 0x0f;
            const masked = (buf[1] & 0x80) !== 0;
            let len = buf[1] & 0x7f;
            let off = 2;
            if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
            if (buf.length < off + len) break;
            const payload = buf.subarray(off, off + len);
            frameData.push({ opcode, bin: opcode === 2, len, preview: payload.toString('latin1').slice(0, 100) });
            buf = buf.subarray(off + len);
            if (opcode === 0x8) { closed = true; }
          }
        }
      });
      sock.on('close', () => { closed = true; finish(); });
      sock.on('error', () => finish());
    });
  const wsCase = async (name, frames, opts = {}) => {
    const d = await wsProbe(DAEMON_PORT, frames, opts);
    await sleep(150);
    const s = await wsProbe(STS_PORT, frames, opts);
    results.push({ group: 'ws', name, daemon: d, sts: s, identical: JSON.stringify(d) === JSON.stringify(s) });
  };
  await wsCase('WS HI', ['HI\n']);
  await wsCase('WS HI no newline', ['HI']);
  await wsCase('WS GETIP', ['GETIP\n']);
  await wsCase('WS HI+GETIP one frame', ['HI\nGETIP\n']);
  await wsCase('WS HI then separate GETIP', ['HI\n', 'GETIP\n']);
  await wsCase('WS garbage text', ['\x17\x83\x92\xaa']);
  await wsCase('WS QUIT', ['QUIT\n']);
  await wsCase('WS PING', ['PING 1\n']);
  // WS HELLO trailing-newline quirk: compare exact frame preview
}

(async () => {
  if (!ONLY || ONLY === '--tcp-only') await runTcp();
  if (!ONLY || ONLY === '--http-only') await runHttp();
  if (!ONLY || ONLY === '--tls-only') await runTls();
  if (!ONLY || ONLY === '--ws-only') await runWs();
  if (!ONLY || ONLY === '--udp-only') await runUdp();
  const out = { generatedAt: new Date().toISOString(), daemonPort: DAEMON_PORT, stsPort: STS_PORT, results };
  const fs = await import('node:fs');
  fs.writeFileSync('/home/z/my-project/rea-lab/evidence/probe-diff-results.json', JSON.stringify(out, null, 2));
  const identical = results.filter((r) => r.identical).length;
  console.log(`TOTAL: ${results.length} cases | identical: ${identical} | DIFFERING: ${results.length - identical}`);
  for (const r of results.filter((x) => !x.identical)) {
    console.log(`\n=== [${r.group}] ${r.name} ===`);
    console.log(`  daemon: ${JSON.stringify(r.daemon).slice(0, 600)}`);
    console.log(`  sts   : ${JSON.stringify(r.sts).slice(0, 600)}`);
  }
})();

#!/usr/bin/env node
/**
 * probe-round2.mjs — Focused deep-dive probes to nail exact daemon behavior
 * for newly-discovered divergences. Hex dumps + state-machine exploration.
 */
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as dgram from 'node:dgram';
import * as crypto from 'node:crypto';

const DAEMON_PORT = parseInt(process.argv[2] || '18080', 10);
const STS_PORT = parseInt(process.argv[3] || '18081', 10);
const HOST = '127.0.0.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hex(b, maxHead = 20, maxTail = 6) {
  if (b.length === 0) return '(empty)';
  const head = [...b.subarray(0, maxHead)].map((x) => x.toString(16).padStart(2, '0')).join(' ');
  const tail = b.length > maxHead + maxTail
    ? ' ... ' + [...b.subarray(b.length - maxTail)].map((x) => x.toString(16).padStart(2, '0')).join(' ')
    : (b.length > maxHead ? ' ' + [...b.subarray(maxHead)].map((x) => x.toString(16).padStart(2, '0')).join(' ') : '');
  const ascii = [...b.subarray(0, Math.min(24, b.length))].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '·')).join('');
  return `[${b.length}B] ${head}${tail} | "${ascii}"`;
}

/** Multi-stage TCP session probe: write sequences with delays, collect all. */
function session(port, writes, { tlsMode = false, waitMs = 800 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      resolve({ data: Buffer.concat(chunks), closed });
    };
    let timer;
    let sock = tlsMode
      ? tls.connect({ host: HOST, port, rejectUnauthorized: false, servername: 'localhost' }, run)
      : net.connect({ host: HOST, port }, run);
    function run() {
      (async () => {
        for (const w of writes) {
          const p = typeof w === 'string' || Buffer.isBuffer(w) ? w : w.p;
          const delayAfter = typeof w === 'object' && w !== null && !Buffer.isBuffer(w) ? (w.delayAfter || 0) : 120;
          const payload = typeof p === 'string' ? Buffer.from(p, 'latin1') : p;
          sock.write(payload);
          await sleep(delayAfter);
        }
        timer = setTimeout(() => finish(false), waitMs);
      })();
    }
    sock.on('data', (d) => chunks.push(d));
    sock.on('close', () => finish(true));
    sock.on('error', () => finish(true));
  });
}

const out = [];
function report(name, daemonRes, stsRes) {
  out.push({ name, daemon: daemonRes, sts: stsRes });
  console.log(`\n### ${name}`);
  console.log(`  D: closed=${daemonRes.closed} ${hex(daemonRes.data || Buffer.alloc(0))}`);
  console.log(`  S: closed=${stsRes.closed} ${hex(stsRes.data || Buffer.alloc(0))}`);
}

async function both(name, writes, opts = {}) {
  const d = await session(DAEMON_PORT, writes, opts);
  const s = await session(STS_PORT, writes, opts);
  report(name, d, s);
}

(async () => {
  console.log('========== DOWNLOAD STRUCTURE (hex) ==========');
  for (const n of [0, 1, 5, 8, 9, 10, 11, 15, 20, 100]) {
    await both(`DOWNLOAD ${n}`, [`DOWNLOAD ${n}\n`], { waitMs: 500 });
  }

  console.log('\n========== UPLOAD EDGES ==========');
  await both('UPLOAD 11 (exact line)', ['UPLOAD 11\n']);
  await both('UPLOAD 12 (+1)', ['UPLOAD 12\nZ']);
  await both('UPLOAD 5 (short)', ['UPLOAD 5\n']);
  await both('UPLOAD 0', ['UPLOAD 0\n']);
  await both('UPLOAD 20 then 9 bytes', ['UPLOAD 20\n' + 'A'.repeat(9)]);
  await both('UPLOAD 20 then 9 bytes then GETIP', ['UPLOAD 20\n' + 'A'.repeat(9), 'GETIP\n']);

  console.log('\n========== PRE-SESSION GATE ==========');
  await both('GETIP twice one segment', ['GETIP\nGETIP\n']);
  await both('GETIP, delay, GETIP', [{ p: 'GETIP\n', delayAfter: 250 }, { p: 'GETIP\n', delayAfter: 250 }]);
  await both('GETIP+PING one segment', ['GETIP\nPING 1\n']);
  await both('PING 1 twice one segment', ['PING 1\nPING 1\n']);
  await both('HI+GETIP one segment', ['HI\nGETIP\n']);
  await both('GETIP then HI one segment', ['GETIP\nHI\n']);
  await both('HI, delay, GETIP, GETIP one seg', [{ p: 'HI\n', delayAfter: 200 }, 'GETIP\nGETIP\n']);
  await both('bad GETIP then good GETIP', ['GETIP \nGETIP\n']);

  console.log('\n========== HI VARIANTS ==========');
  await both('HI trailing space', ['HI \n']);
  await both('HI double space + uuid', ['HI  12345678-1234-1234-1234-123456789abc\n']);
  await both('HI uuid + extra token', ['HI 12345678-1234-1234-1234-123456789abc extra\n']);
  await both('HI uuid + trailing space', ['HI 12345678-1234-1234-1234-123456789abc \n']);
  await both('HI tab separator', ['HI\t12345678-1234-1234-1234-123456789abc\n']);

  console.log('\n========== PING VARIANTS ==========');
  await both('PING bare', ['PING\n']);
  await both('PING space', ['PING \n']);
  await both('PING abc', ['PING abc\n']);
  await both('PING 1 2', ['PING 1 2\n']);

  console.log('\n========== OTHER COMMANDS ==========');
  await both('CAPABILITIES twice one seg', ['CAPABILITIES\nCAPABILITIES\n']);
  await both('lowercase getip', ['getip\n']);
  await both('GETIP\\r\\n', ['GETIP\r\n']);
  await both('empty line then GETIP', ['\nGETIP\n']);
  await both('SERVERID after HI uuid', ['HI 12345678-1234-1234-1234-123456789abc\nSERVERID\n']);
  await both('INITPLOSS after HI uuid', ['HI 12345678-1234-1234-1234-123456789abc\nINITPLOSS\nPLOSS\n']);
  await both('QUIT then GETIP', ['QUIT\nGETIP\n']);
  await both('UPLOAD_STATS', ['UPLOAD_STATS\n']);
  await both('GETIP over TLS', ['GETIP\n'], { tlsMode: true });

  console.log('\n========== UDP WITH REGISTERED TCP SESSION ==========');
  const uuid = crypto.randomUUID();
  const udpFlow = async (port) => {
    // 1. TCP session with HI <uuid> — keep open
    const tcpSock = net.connect({ host: HOST, port }, () => {
      tcpSock.write(`HI ${uuid}\n`);
    });
    const tcpChunks = [];
    tcpSock.on('data', (d) => tcpChunks.push(d));
    await sleep(300);
    // 2. UDP 4-field then 5-field from same host
    const replies = [];
    const usock = dgram.createSocket('udp4');
    await new Promise((r) => usock.bind(0, HOST, r));
    usock.on('message', (m, ri) => replies.push({ from: `${ri.address}`, data: m.toString('latin1') }));
    await new Promise((r) => usock.send(Buffer.from(`LOSS 100 0 ${uuid}\n`), port, HOST, r));
    await sleep(150);
    await new Promise((r) => usock.send(Buffer.from(`LOSS 100 1 ${uuid} 200\n`), port, HOST, r));
    await sleep(150);
    await new Promise((r) => usock.send(Buffer.from(`LOSS 100 1 ${uuid} 201\n`), port, HOST, r));
    await sleep(250);
    // 3. PLOSS over the TCP session
    tcpSock.write('PLOSS\n');
    await sleep(400);
    // 4. GETIP too
    tcpSock.write('GETIP\n');
    await sleep(300);
    try { usock.close(); } catch {}
    try { tcpSock.destroy(); } catch {}
    return { tcp: Buffer.concat(tcpChunks).toString('latin1'), udpReplies: replies };
  };
  const dUdp = await udpFlow(DAEMON_PORT);
  const sUdp = await udpFlow(STS_PORT);
  console.log('\n### UDP with registered session');
  console.log(`  D tcp: ${JSON.stringify(dUdp.tcp)}`);
  console.log(`  D udp: ${JSON.stringify(dUdp.udpReplies)}`);
  console.log(`  S tcp: ${JSON.stringify(sUdp.tcp)}`);
  console.log(`  S udp: ${JSON.stringify(sUdp.udpReplies)}`);
  out.push({ name: 'UDP registered session', daemon: dUdp, sts: sUdp });

  console.log('\n========== HTTP MINIMAL-500 & OTHERS (hex) ==========');
  async function httpBoth(name, raw) {
    const d = await session(DAEMON_PORT, [{ p: raw, delayAfter: 0 }], { waitMs: 600 });
    const s = await session(STS_PORT, [{ p: raw, delayAfter: 0 }], { waitMs: 600 });
    report(name, d, s);
  }
  await httpBoth('no UA', 'GET /hi HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  await httpBoth('HTTP/1.0', 'GET /hi HTTP/1.0\r\nUser-Agent: p\r\n\r\n');
  await httpBoth('no Host', 'GET /hi HTTP/1.1\r\nUser-Agent: p\r\nConnection: close\r\n\r\n');
  await httpBoth('empty UA', 'GET /hi HTTP/1.1\r\nHost: x\r\nUser-Agent: \r\nConnection: close\r\n\r\n');
  await httpBoth('GET /ws no upgrade', 'GET /ws HTTP/1.1\r\nHost: x\r\nUser-Agent: p\r\nConnection: close\r\n\r\n');
  await httpBoth('POST chunked upload.php', 'POST /speedtest/upload.php HTTP/1.1\r\nHost: x\r\nUser-Agent: p\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\n12345\r\n0\r\n\r\n');
  await httpBoth('absolute-form', 'GET http://localhost/hi HTTP/1.1\r\nHost: x\r\nUser-Agent: p\r\nConnection: close\r\n\r\n');
  await httpBoth('keep-alive first resp headers', 'GET /hi HTTP/1.1\r\nHost: x\r\nUser-Agent: p\r\n\r\n');
  await httpBoth('CONNECT method', 'CONNECT localhost:80 HTTP/1.1\r\nHost: x\r\nUser-Agent: p\r\n\r\n');
  await httpBoth('GET with fragment', 'GET /hi#frag HTTP/1.1\r\nHost: x\r\nUser-Agent: p\r\nConnection: close\r\n\r\n');
  await httpBoth('GET /hI mixed case path', 'GET /hI HTTP/1.1\r\nHost: x\r\nUser-Agent: p\r\nConnection: close\r\n\r\n');

  console.log('\n========== WS DEEP ==========');
  async function wsBoth(name, frames) {
    const wsProbe = (port) =>
      new Promise((resolve) => {
        const key = crypto.randomBytes(16).toString('base64');
        const head = `GET /ws HTTP/1.1\r\nHost: localhost\r\nUser-Agent: p\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
        const sock = net.connect({ host: HOST, port }, () => sock.write(head));
        let upgraded = false;
        let frameData = [];
        let closed = false;
        let settled = false;
        let buf = Buffer.alloc(0);
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          try { sock.destroy(); } catch {}
          resolve({ frames: frameData, closedByServer: closed });
        };
        let t = setTimeout(finish, 1800);
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
        sock.on('data', (d) => {
          buf = Buffer.concat([buf, d]);
          if (!upgraded) {
            const idx = buf.indexOf('\r\n\r\n');
            if (idx !== -1) {
              upgraded = true;
              buf = buf.subarray(idx + 4);
              (async () => {
                for (const f of frames) {
                  const p = typeof f === 'string' ? Buffer.from(f, 'latin1') : f;
                  sendFrame(p, f.bin ? 0x2 : 0x1);
                  await sleep(150);
                }
                t = setTimeout(finish, 900);
              })();
            }
          }
          while (buf.length >= 2) {
            const opcode = buf[0] & 0x0f;
            let len = buf[1] & 0x7f;
            let off = 2;
            if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
            if (buf.length < off + len) break;
            const payload = buf.subarray(off, off + len);
            frameData.push({ opcode, len, preview: payload.toString('latin1').slice(0, 60) });
            buf = buf.subarray(off + len);
            if (opcode === 0x8) closed = true;
          }
        });
        sock.on('close', () => { closed = true; finish(); });
        sock.on('error', () => finish());
      });
    const d = await wsProbe(DAEMON_PORT);
    const s = await wsProbe(STS_PORT);
    console.log(`\n### ${name}`);
    console.log(`  D: ${JSON.stringify(d)}`);
    console.log(`  S: ${JSON.stringify(s)}`);
    out.push({ name, daemon: d, sts: s });
  }
  await wsBoth('WS GETIP no newline', ['GETIP']);
  await wsBoth('WS HI then QUIT', ['HI\n', 'QUIT\n']);
  await wsBoth('WS HI then QUIT same frame', ['HI\nQUIT\n']);
  await wsBoth('WS binary frame HI', [{ bin: true, toString: () => 'HI\n' }]);
  await wsBoth('WS PING then GETIP one frame', ['PING 1\nGETIP\n']);
  await wsBoth('WS empty text frame', ['']);

  const fs = await import('node:fs');
  fs.writeFileSync('/home/z/my-project/rea-lab/evidence/probe-round2-results.json', JSON.stringify(out, null, 2));
  console.log('\nDONE — saved evidence/probe-round2-results.json');
})();

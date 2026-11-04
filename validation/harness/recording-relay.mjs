#!/usr/bin/env node
/**
 * Recording TCP+UDP relay for OoklaServer protocol observation (lab tap).
 *
 * Listens on LISTEN (default 8080, dual-stack) and forwards to UPSTREAM
 * (default 127.0.0.1:18080), logging every command-sized chunk and every UDP
 * datagram to a JSONL file. Bulk data is aggregated (counts only) so a full
 * multi-GB speedtest run produces a small, analyzable log.
 *
 * Usage: node relay.mjs --listen 8080 --upstream 127.0.0.1:18080 --log cap.jsonl [--label x]
 */
import net from 'node:net';
import dgram from 'node:dgram';
import fs from 'node:fs';

function parseArgs(argv) {
  const a = { listen: '8080', upstream: '127.0.0.1:18080', log: 'relay.jsonl', label: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--listen') a.listen = argv[++i];
    else if (argv[i] === '--upstream') a.upstream = argv[++i];
    else if (argv[i] === '--log') a.log = argv[++i];
    else if (argv[i] === '--label') a.label = argv[++i];
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const [upHost, upPortS] = args.upstream.split(':');
const upPort = parseInt(upPortS, 10);
const listenPort = parseInt(args.listen, 10);
const logStream = fs.createWriteStream(args.log, { flags: 'w' });

function ev(o) { o.ts = Date.now(); logStream.write(JSON.stringify(o) + '\n'); }
function printable(buf) {
  let s = '';
  for (const b of buf) s += (b >= 32 && b < 127) ? String.fromCharCode(b) : '.';
  return s;
}
const SMALL = 255;          // chunks <= this are logged verbatim (hex)
const HEXCAP = 1024;        // max hex bytes per event
const AGG_FLUSH_BYTES = 4 * 1024 * 1024;
const AGG_FLUSH_MS = 500;

ev({ k: 'meta', relay: `:${listenPort}->${args.upstream}`, label: args.label, argv: process.argv.slice(2), pid: process.pid });

/* ---------------- TCP ---------------- */
let connSeq = 0;
const tcpServer = net.createServer({ noDelay: true }, (client) => {
  const id = ++connSeq;
  const from = `${client.remoteAddress}:${client.remotePort}`;
  ev({ k: 'tcp_open', id, from });

  const up = net.connect({ host: upHost, port: upPort });
  up.setNoDelay(true);

  const agg = {
    c2s: { chunks: 0, bytes: 0, started: false },
    s2c: { chunks: 0, bytes: 0, started: false },
  };
  function flush(dir, force) {
    const a = agg[dir];
    if (a.chunks > 0 || (force && (a.bytes > 0 || a.started))) {
      ev({ k: 'tcp_agg', id, dir, chunks: a.chunks, bytes: a.bytes });
      a.chunks = 0; a.bytes = 0;
    }
  }
  const timers = {};
  function record(dir, chunk) {
    const a = agg[dir];
    if (chunk.length <= SMALL) {
      flush(dir === 'c2s' ? 's2c' : 'c2s'); // flush the opposite direction first (ordering)
      flush(dir);
      ev({
        k: 'tcp_data', id, dir, len: chunk.length,
        hex: chunk.toString('hex'),
        ascii: printable(chunk),
      });
      a.started = true;
    } else {
      a.chunks++; a.bytes += chunk.length;
      if (!a.started) {
        a.started = true;
        ev({
          k: 'tcp_head', id, dir, len: chunk.length,
          headHex: chunk.subarray(0, 64).toString('hex'),
          headAscii: printable(chunk.subarray(0, 64)),
        });
      }
      if (a.bytes >= AGG_FLUSH_BYTES) flush(dir);
      else if (!timers[dir]) {
        timers[dir] = setTimeout(() => { timers[dir] = null; flush(dir); }, AGG_FLUSH_MS);
      }
    }
  }

  client.on('data', (c) => { record('c2s', c); if (!up.destroyed) up.write(c); });
  up.on('data', (c) => { record('s2c', c); if (!client.destroyed) client.write(c); });

  function closeBoth(why) {
    for (const d of ['c2s', 's2c']) { if (timers[d]) { clearTimeout(timers[d]); timers[d] = null; } flush(d, true); }
    ev({ k: 'tcp_close', id, why });
    client.destroy(); up.destroy();
  }
  client.on('error', (e) => closeBoth('client_err:' + e.code));
  up.on('error', (e) => closeBoth('upstream_err:' + e.code));
  client.on('close', () => closeBoth('client_close'));
  up.on('close', () => closeBoth('upstream_close'));
});

tcpServer.on('error', (e) => { console.error('TCP relay error:', e.message); process.exit(1); });
tcpServer.listen(listenPort, '::', () => {
  console.log(`[relay] TCP listening on [::]:${listenPort} (dual-stack) -> ${args.upstream}`);
});

/* ---------------- UDP ---------------- */
const udp = dgram.createSocket('udp6');
const udpClients = new Map(); // "addr:port" -> { up, last }
const UDP_IDLE_MS = 120000;

udp.on('message', (msg, rinfo) => {
  const key = `${rinfo.address}:${rinfo.port}`;
  const hex = msg.subarray(0, HEXCAP).toString('hex');
  ev({ k: 'udp_c2s', from: key, len: msg.length, hex, truncated: msg.length > HEXCAP });
  let e = udpClients.get(key);
  if (!e) {
    const up = dgram.createSocket('udp4');
    up.on('message', (m, ri) => {
      ev({ k: 'udp_s2c', to: key, len: m.length, hex: m.subarray(0, HEXCAP).toString('hex'), truncated: m.length > HEXCAP });
      udp.send(m, rinfo.port, rinfo.address);
    });
    up.on('error', () => {});
    up.bind(() => up.connect(upPort, upHost === 'localhost' ? '127.0.0.1' : upHost));
    e = { up, last: Date.now() };
    udpClients.set(key, e);
  }
  e.last = Date.now();
  e.up.send(msg, upPort, upHost === 'localhost' ? '127.0.0.1' : upHost);
});

udp.on('error', (e) => { console.error('UDP relay error:', e.message); process.exit(1); });
udp.bind(listenPort, () => {
  console.log(`[relay] UDP listening on [::]:${listenPort} (dual-stack) -> ${upHost}:${upPort}`);
});

setInterval(() => {
  const now = Date.now();
  for (const [k, e] of udpClients) {
    if (now - e.last > UDP_IDLE_MS) { e.up.close(); udpClients.delete(k); ev({ k: 'udp_idle_gc', client: k }); }
  }
}, 30000).unref();

process.on('SIGINT', () => { console.log('[relay] shutting down'); process.exit(0); });

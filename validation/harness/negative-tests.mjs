#!/usr/bin/env node
/** Level-4 negative/stability battery against a running SpeedtestServer (default :8080). */
import net from 'node:net';
import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs';

const PORT = parseInt(process.argv[2] || '8080', 10);
const results = [];
const note = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} — ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function alive() {
  return new Promise((res) => {
    const c = net.connect(PORT, '127.0.0.1', () => c.write('PING 0\n'));
    let b = '';
    c.on('data', (d) => { b += d; c.end(); });
    c.on('close', () => res(b.startsWith('PONG')));
    c.on('error', () => res(false));
    setTimeout(() => res(false), 1500);
  });
}

await (async () => {
  // 1. invalid command → ERROR, connection remains usable
  const r1 = await new Promise((res) => {
    const c = net.connect(PORT, '127.0.0.1', () => c.write('BOGUS\nPING 1\n'));
    let b = '';
    c.on('data', (d) => (b += d));
    setTimeout(() => { c.end(); res(b); }, 500);
  });
  note('invalid command → ERROR then usable', r1.startsWith('ERROR\nPONG '), JSON.stringify(r1));

  // 2. oversized command line (>1 MiB without newline) → connection dropped
  const r2 = await new Promise((res) => {
    const c = net.connect(PORT, '127.0.0.1', () => c.write(Buffer.alloc(2 * 1024 * 1024, 0x41)));
    let closed = false;
    c.on('close', () => { closed = true; res(closed); });
    c.on('error', () => {});
    setTimeout(() => res(closed), 1500);
  });
  note('oversized command line → connection dropped', r2 === true, String(r2));

  note('server survives abuse', await alive(), String(await alive()));

  // 4. malformed TLS (garbage after ClientHello record header)
  const c4 = net.connect(PORT, '127.0.0.1', () => c4.write(Buffer.from('160301deadbeef', 'hex')));
  c4.on('error', () => {});
  await sleep(700);
  note('server survives malformed TLS', await alive(), String(await alive()));

  // 5. abrupt disconnect mid-download
  await new Promise((res) => {
    const c = net.connect(PORT, '127.0.0.1', () => c.write('DOWNLOAD 100000000\n'));
    c.on('data', () => { if (!c.destroyed) c.destroy(); res(); });
  });
  await sleep(800);
  note('server survives mid-download abort', await alive(), String(await alive()));

  // 6. oversized HTTP headers
  await new Promise((res) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/', headers: { 'User-Agent': 't', 'X-Big': 'x'.repeat(70000) } }, () => res());
    req.on('error', () => res());
    req.end();
    setTimeout(res, 1500);
  });
  note('server survives oversized HTTP headers', await alive(), String(await alive()));

  // 7. UDP garbage flood
  const s = dgram.createSocket('udp4');
  s.bind(() => { for (let i = 0; i < 200; i++) s.send(Buffer.from('GARBAGE NOT LOSS\n'), PORT, '127.0.0.1'); });
  await sleep(600);
  s.close();
  note('server survives UDP garbage flood', await alive(), String(await alive()));

  console.log(`\nNEGATIVE SUITE: ${results.filter((r) => r.pass).length}/${results.length} PASS`);
  fs.writeFileSync('/home/z/my-project/lab/captures/negative-tests.json', JSON.stringify(results, null, 2));
  process.exit(results.every((r) => r.pass) ? 0 : 1);
})();

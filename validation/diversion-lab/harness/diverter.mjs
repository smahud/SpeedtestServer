#!/usr/bin/env node
/**
 * diverter.mjs — connection/command-level backend diversion gateway (authorized lab).
 *
 * Sits between the UNMODIFIED official Ookla Speedtest CLI and two measurement
 * backends on loopback:
 *   Backend A ("ref")  : official OoklaServer daemon     (default 127.0.0.1:18080)
 *   Backend B ("sts")  : SpeedtestServer (this repo, TS) (default 127.0.0.1:8080)
 *
 * The CLI is pointed at this gateway via the lab config-proxy (server entries
 * rewritten to localhost:DIV_PORT). The gateway then routes:
 *   - every incoming TCP connection to a backend according to a POLICY, and
 *   - every UDP datagram to a fixed backend (or drops them),
 * splicing bytes WITHOUT modification, while logging routing decisions,
 * per-connection byte counters and observed NetGauge command lines (the audit
 * channel used to attribute each measurement phase to a backend).
 *
 * POLICIES (--policy):
 *   all:A | all:B            control — everything to one backend (no sniffing)
 *   firstN:A:<n>             connections 1..n → A, n+1.. → B   (pure index split)
 *   firstN:B:<n>             connections 1..n → B, n+1.. → A
 *   phase:<map>              connection-level, protocol-aware. The connection's
 *                            generic prefix (encrypted hello, or HI… until the
 *                            first phase-revealing command) is served by the
 *                            "pre" backend; from the first phase-revealing
 *                            command the connection is spliced to the mapped
 *                            backend. When the phase backend differs from the
 *                            prefix backend the prefix is first REPLAYED to it
 *                            (stateless commands; its duplicate replies are
 *                            swallowed) so the phase backend sees a complete
 *                            session. Triggers: binary hello → enc · bare HI
 *                            (no UUID) → sel · PING → ping · INITPLOSS → loss ·
 *                            DOWNLOAD → dn · UPLOAD → up · CAPABILITIES → upctl
 *                            map keys: pre,sel,enc,ping,loss,dn,up,upctl,def
 *   cmd:<map>                TRUE command-level split: every command line is
 *                            forwarded to the backend mapped for it (both
 *                            upstreams kept open; UPLOAD payload follows its
 *                            UPLOAD command). map keys: hi,getip,caps,ping,dn,
 *                            up,upctl,loss,ploss,def
 *   blackhole                accept and drop (failure injection)
 *
 * UDP (--udp): A | B | drop  (default A)
 *
 * Output: JSONL log (--log, default ./diverter.jsonl): meta, conn_open,
 *   conn_route, conn_cmd, conn_sample, conn_close, conn_upstream_err, udp_map,
 *   udp_datagram, udp_send_err, heartbeat, summary.
 *
 * Usage:
 *   node diverter.mjs --port 9090 --a 127.0.0.1:18080 --b 127.0.0.1:8080 \
 *     --policy firstN:A:5 --udp B --log out/diverter.jsonl
 */
import net from 'node:net';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- args
const a = {
  port: 9090, a: '127.0.0.1:18080', b: '127.0.0.1:8080',
  policy: 'all:A', udp: 'A', log: path.join(process.cwd(), 'diverter.jsonl'),
};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (t === '--port') a.port = +process.argv[++i];
  else if (t === '--a') a.a = process.argv[++i];
  else if (t === '--b') a.b = process.argv[++i];
  else if (t === '--policy') a.policy = process.argv[++i];
  else if (t === '--udp') a.udp = process.argv[++i];
  else if (t === '--log') a.log = process.argv[++i];
}
fs.mkdirSync(path.dirname(a.log), { recursive: true });
const LOG = fs.createWriteStream(a.log, { flags: 'w' });
const t0hr = process.hrtime.bigint();
const relMs = () => Number((process.hrtime.bigint() - t0hr) / 1000000n);
function log(o) { o.ts = Date.now(); o.rt = relMs(); LOG.write(JSON.stringify(o) + '\n'); }
const BE = { A: a.a, B: a.b };

// ---------------------------------------------------------------- policy
function parsePolicy(p) {
  const idx = p.indexOf(':');
  const mode = idx === -1 ? p : p.slice(0, idx);
  const spec = idx === -1 ? '' : p.slice(idx + 1); // SELURUH sisa (mis. "A:12" / "pre=A,dn=B")
  if (mode === 'all') return { mode, be: spec === 'B' ? 'B' : 'A' };
  if (mode === 'firstN') {
    const parts = spec.split(':');
    return { mode, be: parts[0] === 'B' ? 'B' : 'A', other: parts[0] === 'B' ? 'A' : 'B', n: +parts[1] };
  }
  if (mode === 'phase' || mode === 'cmd') {
    const map = {};
    for (const kv of (spec || '').split(',')) { const c = kv.indexOf('='); if (c > 0) map[kv.slice(0, c)] = kv.slice(c + 1) === 'B' ? 'B' : 'A'; }
    for (const k of mode === 'phase'
      ? ['pre', 'sel', 'enc', 'ping', 'loss', 'dn', 'up', 'upctl', 'def']
      : ['hi', 'getip', 'caps', 'ping', 'dn', 'up', 'upctl', 'loss', 'ploss', 'def'])
      if (!map[k]) map[k] = map.def || 'A';
    return { mode, map };
  }
  if (mode === 'blackhole') return { mode };
  throw new Error('unknown policy: ' + p);
}
const POLICY = parsePolicy(a.policy);
log({ k: 'meta', policy: a.policy, parsed: POLICY, udp: a.udp, a: BE.A, b: BE.B, port: a.port, pid: process.pid, ts0: Date.now() });

// ---------------------------------------------------------------- helpers
const printable = (buf) => { for (let i = 0; i < buf.length; i++) { const c = buf[i]; if (c < 0x09 || (c > 0x0d && c < 0x20) || c > 0x7e) return false; } return true; };
const connStats = { seq: 0, closed: 0, bytes: { A: 0, B: 0 } };
const udpUpstreams = new Map();

// ---------------------------------------------------------------- TCP server
const server = net.createServer((cliSock) => {
  const id = ++connStats.seq;
  const openedAt = relMs();
  log({ k: 'conn_open', id, peer: `${cliSock.remoteAddress}:${cliSock.remotePort}` });
  cliSock.setNoDelay(true);

  if (POLICY.mode === 'blackhole') {
    let n = 0;
    cliSock.on('data', (c) => { n += c.length; });
    cliSock.on('close', () => { connStats.closed++; log({ k: 'conn_close', id, backend: 'DROP', bytesCli2Be: n, bytesBe2Cli: 0, durMs: relMs() - openedAt }); });
    cliSock.on('error', () => {});
    return;
  }
  if (POLICY.mode === 'all' || POLICY.mode === 'firstN') {
    const be = POLICY.mode === 'all' ? POLICY.be : (id <= POLICY.n ? POLICY.be : POLICY.other);
    routeImmediate(cliSock, id, be, POLICY.mode === 'all' ? 'policy:all' : `index:${id}(${id <= POLICY.n ? '≤N' : '>N'})`, openedAt);
    return;
  }
  protocolAware(cliSock, id, openedAt);
});
server.on('error', (e) => { console.error('diverter tcp error:', e.message); process.exit(1); });
server.listen(a.port, () => console.log(`[diverter] tcp :${a.port} | policy=${a.policy} | udp=${a.udp} | A=${BE.A} B=${BE.B} | log=${a.log}`));

/** Control path: route immediately, splice raw, count bytes, sniff first bytes for the log. */
function routeImmediate(cliSock, id, be, reason, openedAt) {
  const [h, p] = BE[be].split(':');
  const up = net.connect({ host: h, port: +p });
  let c2b = 0, b2c = 0, lastSample = 0, sniffLeft = 256, lineBuf = '', logged = 0;
  up.on('connect', () => { up.setNoDelay(true); log({ k: 'conn_route', id, backend: be, reason, heldMs: relMs() - openedAt }); });
  cliSock.on('data', (c) => { c2b += c.length; up.write(c); if (sniffLeft > 0) sniff(c); sample(); });
  up.on('data', (c) => { b2c += c.length; cliSock.write(c); sample(); });
  function sample() { const t = relMs(); if (t - lastSample > 500) { lastSample = t; log({ k: 'conn_sample', id, c2b, b2c }); } }
  function sniff(c) {
    const head = c.subarray(0, Math.min(c.length, sniffLeft)); sniffLeft -= head.length;
    if (!printable(head)) { if (logged < 30) { log({ k: 'conn_cmd', id, backend: be, line: `«BIN ${c.length}B»` }); logged++; } if (sniffLeft <= 0) lineBuf = ''; return; }
    lineBuf += head.toString('latin1');
    let i;
    while ((i = lineBuf.indexOf('\n')) !== -1 && logged < 30) {
      const line = lineBuf.slice(0, i).replace(/\r$/, ''); lineBuf = lineBuf.slice(i + 1);
      if (line) { log({ k: 'conn_cmd', id, backend: be, line: line.slice(0, 90) }); logged++; }
    }
    if (lineBuf.length > 4096) lineBuf = '';
  }
  cliSock.on('close', () => {
    connStats.closed++; connStats.bytes[be] += c2b;
    log({ k: 'conn_close', id, backend: be, bytesCli2Be: c2b, bytesBe2Cli: b2c, durMs: relMs() - openedAt });
    try { up.destroy(); } catch {}
  });
  cliSock.on('error', () => { try { up.destroy(); } catch {} });
  up.on('close', () => { try { cliSock.destroy(); } catch {} });
  up.on('error', (e) => { log({ k: 'conn_upstream_err', id, backend: be, error: e.code || String(e) }); try { cliSock.destroy(); } catch {} });
}

/**
 * Protocol-aware routing (phase / cmd modes) — satu mesin status per koneksi:
 * SEMUA byte klien masuk ke rawBuf dan diproses sekuensial oleh SATU loop
 * (tidak ada pergantian handler data → tidak ada race saat await openUp):
 *   (a) payload UPLOAD (mode cmd) dikonsumsi mentah sesuai sisa byte;
 *   (b) mode fase pasca-routing: pipe mentah ke upMain (jalur cepat);
 *   (c) byte pertama biner → hello terenkripsi → backend enc;
 *   (d) baris teks → perintah → diteruskan sesuai kebijakan.
 */
function protocolAware(cliSock, id, openedAt) {
  const map = POLICY.map;
  const mode = POLICY.mode;
  const upstreams = {};      // be -> socket
  let upMain = null;         // fase: socket tempat stream di-splice
  let curBe = null;
  let routed = false;
  let c2b = 0, b2c = 0, logged = 0;
  const replayBuf = [];      // byte persis yang sudah diteruskan ke backend prefix
  let replayLines = 0;
  let rawBuf = Buffer.alloc(0);
  let processing = false;
  let firstChunkSeen = false;
  let upCtl = null;          // {be, remaining} saat mengonsumsi payload UPLOAD (cmd)

  function pipeHandlerFor(s) {
    let swallowLeft = 0, swBuf = '';
    s._swallow = (n) => { swallowLeft = n; swBuf = ''; };
    return (c) => {
      b2c += c.length;
      if (swallowLeft > 0) {
        swBuf += c.toString('latin1');
        let i;
        while ((i = swBuf.indexOf('\n')) !== -1 && swallowLeft > 0) { swBuf = swBuf.slice(i + 1); swallowLeft--; }
        if (swallowLeft <= 0 && swBuf) { cliSock.write(Buffer.from(swBuf, 'latin1')); swBuf = ''; }
        return;
      }
      cliSock.write(c);
      if (relMs() - (s._lastS || 0) > 500) { s._lastS = relMs(); log({ k: 'conn_sample', id, c2b, b2c }); }
    };
  }

  function openUp(be) {
    return new Promise((res, rej) => {
      if (upstreams[be]) return res(upstreams[be]);
      const [h, p] = BE[be].split(':');
      const s = net.connect({ host: h, port: +p });
      upstreams[be] = s;
      s.setNoDelay(true);
      s.on('error', (e) => { log({ k: 'conn_upstream_err', id, backend: be, error: e.code || String(e) }); if (!upMain) { try { cliSock.destroy(); } catch {} } rej(e); });
      s.on('connect', () => {
        s.on('data', pipeHandlerFor(s));
        s.on('close', () => { if (upMain === s || (mode === 'cmd' && curBe === be)) { try { cliSock.end(); } catch {} } });
        res(s);
      });
    });
  }

  cliSock.on('error', () => {});
  cliSock.on('close', () => {
    connStats.closed++;
    log({ k: 'conn_close', id, backend: curBe || map.pre, mode, routed, bytesCli2Be: c2b, bytesBe2Cli: b2c, durMs: relMs() - openedAt });
    for (const be in upstreams) { try { upstreams[be].destroy(); } catch {} }
  });
  cliSock.on('data', onData);

  async function onData(chunk) {
    c2b += chunk.length;
    rawBuf = Buffer.concat([rawBuf, chunk]);
    if (processing) return; // loop utama sedang berjalan — byte diproses oleh loop itu
    processing = true;
    try {
      while (rawBuf.length) {
        if (upCtl) { // (a) payload UPLOAD
          const take = Math.min(rawBuf.length, upCtl.remaining);
          const s = upstreams[upCtl.be];
          s.write(rawBuf.subarray(0, take)); upCtl.remaining -= take;
          rawBuf = rawBuf.subarray(take);
          if (upCtl.remaining <= 0) upCtl = null;
          continue;
        }
        if (upMain) { // (b) fase pasca-routing: pipe mentah
          upMain.write(rawBuf); rawBuf = Buffer.alloc(0); continue;
        }
        if (!firstChunkSeen) { // (c) deteksi biner pada byte pertama
          firstChunkSeen = true;
          if (!printable(rawBuf.subarray(0, 64))) {
            const be = mode === 'phase' ? map.enc : map.def;
            try { upMain = await openUp(be); } catch { return; }
            curBe = be; routed = true;
            log({ k: 'conn_route', id, backend: be, reason: 'enc-hello', heldMs: relMs() - openedAt });
            upMain.write(rawBuf); rawBuf = Buffer.alloc(0);
            continue;
          }
        }
        const nl = rawBuf.indexOf(0x0a); // (d) baris teks
        if (nl === -1) break; // baris parsial — tunggu data lagi
        const line = rawBuf.subarray(0, nl).toString('latin1').replace(/\r$/, '');
        rawBuf = rawBuf.subarray(nl + 1);
        if (!line) continue;
        await handleLine(line, Buffer.from(line + '\n', 'latin1'));
      }
    } finally { processing = false; }
  }

  async function handleLine(line, framed) {
    if (logged < 80) { log({ k: 'conn_cmd', id, backend: mode === 'cmd' ? (cmdBe(line) || map.def) : (curBe || map.pre), line: line.slice(0, 90) }); logged++; }
    const parts = line.split(' ');
    const cmd = (parts[0] || '').toUpperCase();

    if (mode === 'phase') {
      let targetBe = null, reason = null, isTrigger = false;
      if (cmd === 'HI' && !parts[1]) { targetBe = map.sel; reason = 'phase:sel(bare-HI)'; isTrigger = true; }
      else if (cmd === 'PING') { targetBe = map.ping; reason = 'phase:ping'; isTrigger = true; }
      else if (cmd === 'INITPLOSS') { targetBe = map.loss; reason = 'phase:loss'; isTrigger = true; }
      else if (cmd === 'DOWNLOAD') { targetBe = map.dn; reason = 'phase:dn'; isTrigger = true; }
      else if (cmd === 'UPLOAD') { targetBe = map.up; reason = 'phase:up'; isTrigger = true; }
      else if (cmd === 'CAPABILITIES') { targetBe = map.upctl; reason = 'phase:upctl'; isTrigger = true; }

      if (isTrigger && !routed) {
        const preBe = curBe;
        const replayNeeded = preBe !== null && preBe !== targetBe;
        try { upMain = await openUp(targetBe); } catch { return; }
        curBe = targetBe; routed = true;
        log({ k: 'conn_route', id, backend: targetBe, reason, heldMs: relMs() - openedAt, prefixBackend: preBe ?? 'none', replayed: replayNeeded });
        if (replayNeeded) {
          upMain._swallow(replayLines);
          upMain.write(Buffer.concat(replayBuf));
        }
        if (preBe !== null && preBe !== targetBe && upstreams[preBe]) { try { upstreams[preBe].destroy(); delete upstreams[preBe]; } catch {} }
        upMain.write(framed);
        replayBuf.length = 0; replayLines = 0;
        return;
      }
      if (routed && upMain) { upMain.write(framed); return; }
      const preBe = curBe || map.pre;
      if (curBe === null) {
        try { await openUp(preBe); } catch { return; }
        curBe = preBe;
        log({ k: 'conn_route', id, backend: preBe, reason: 'phase:pre(prefix)', heldMs: relMs() - openedAt });
      }
      upstreams[preBe].write(framed);
      replayBuf.push(framed); replayLines++;
      return;
    }

    // ---- cmd mode: route setiap perintah ke backend petanya
    let be = map.def;
    if (cmd === 'HI') be = map.hi;
    else if (cmd === 'GETIP') be = map.getip;
    else if (cmd === 'CAPABILITIES') be = map.caps;
    else if (cmd === 'PING') be = map.ping;
    else if (cmd === 'DOWNLOAD') be = map.dn;
    else if (cmd === 'UPLOAD') be = map.up;
    else if (cmd === 'UPLOAD_STATS') be = map.upctl;
    else if (cmd === 'INITPLOSS') be = map.loss;
    else if (cmd === 'PLOSS') be = map.ploss;
    if (curBe === null) { curBe = be; log({ k: 'conn_route', id, backend: be, reason: 'cmd-mode:first' }); }
    try { (await openUp(be)).write(framed); } catch { return; }
    if (cmd === 'UPLOAD') {
      const n = parseInt(parts[1], 10);
      if (Number.isFinite(n) && n > framed.length) upCtl = { be, remaining: n - framed.length };
    }
  }
  function cmdBe(line) { const c = (line.split(' ')[0] || '').toUpperCase(); return ({ HI: map.hi, GETIP: map.getip, CAPABILITIES: map.caps, PING: map.ping, DOWNLOAD: map.dn, UPLOAD: map.up, UPLOAD_STATS: map.upctl, INITPLOSS: map.loss, PLOSS: map.ploss })[c] || map.def; }
}

// ---------------------------------------------------------------- UDP
const udpSock = dgram.createSocket({ type: 'udp6', ipv6Only: false });
function logUdp(key, dir, msg) {
  const head = printable(msg.subarray(0, 60)) ? msg.subarray(0, 60).toString('latin1').replace(/\n/g, '⏎') : `«BIN ${msg.length}B»`;
  log({ k: 'udp_datagram', client: key, dir, bytes: msg.length, head });
}
udpSock.on('message', (msg, rinfo) => {
  const key = `${rinfo.address}:${rinfo.port}`;
  if (a.udp === 'drop') { logUdp(key, 'drop', msg); return; }
  let u = udpUpstreams.get(key);
  if (!u) {
    const [bh, bp] = BE[a.udp].split(':');
    const isV6 = bh.includes(':');
    const s = dgram.createSocket(isV6 ? 'udp6' : 'udp4'); // family HARUS cocok dgn alamat backend (udp6 tidak bisa kirim ke literal IPv4)
    u = { sock: s, be: a.udp, sent: 0, recv: 0, logged: 0, host: bh, port: +bp };
    udpUpstreams.set(key, u);
    s.on('message', (m) => {
      u.recv++; if (u.recv <= 80) logUdp(key, 'be→cli', m);
      udpSock.send(m, rinfo.port, rinfo.address);
    });
    s.on('error', (e) => log({ k: 'udp_upstream_err', client: key, backend: a.udp, error: e.code || String(e) }));
    log({ k: 'udp_map', client: key, backend: a.udp });
  }
  u.sent++; if (u.sent <= 80) logUdp(key, 'cli→be', msg);
  u.sock.send(msg, u.port, u.host, (err) => { if (err) log({ k: 'udp_send_err', client: key, backend: a.udp, error: err.code || String(err) }); });
});
udpSock.on('error', (e) => { console.error('diverter udp error:', e.message); });
udpSock.bind(a.port, () => console.log(`[diverter] udp :${a.port} → ${a.udp}`));

// ---------------------------------------------------------------- shutdown / summary
function summary(sig) {
  const s = { k: 'summary', signal: sig, conns: connStats.seq, closed: connStats.closed, bytesCliToBackends: connStats.bytes, wallMs: relMs(), udpClients: [...udpUpstreams.entries()].map(([k, u]) => ({ client: k, backend: u.be, sent: u.sent, recv: u.recv })) };
  log(s);
  setTimeout(() => process.exit(0), 50);
}
process.on('SIGINT', () => summary('SIGINT'));
process.on('SIGTERM', () => summary('SIGTERM'));
setInterval(() => log({ k: 'heartbeat', conns: connStats.seq, closed: connStats.closed, bytes: connStats.bytes }), 5000).unref();

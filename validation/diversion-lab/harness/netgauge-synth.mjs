#!/usr/bin/env node
/**
 * netgauge-synth.mjs — klien NetGauge sintetis yang MENIRU pola koneksi CLI resmi
 * (mode fallback plaintext, berdasarkan evidence gate-cli2-sts-evidence.jsonl):
 *
 *   1. 11 probe seleksi : HI (tanpa UUID) → GETIP → PING×3 → close
 *   2. 1 probe pemenang : HI <UUID> → GETIP → PING×5 → close
 *   3. koneksi loss     : HI <UUID> → INITPLOSS → PLOSS tiap 500 ms
 *   4. monitor ping     : HI <UUID> → PING tiap 700 ms
 *   5. 4 worker download: HI <UUID> → DOWNLOAD 32000000 berulang
 *   6. kontrol upload   : HI <UUID> → CAPABILITIES → UPLOAD_STATS
 *   7. 4 worker upload  : HI <UUID> → UPLOAD 32000000 15000 16 + payload
 *   8. UDP              : LOSS <timer> <seq> <UUID> berulang
 *
 * Tujuan: validasi mekanisme diverter (routing fase, replay+swallow, mode cmd,
 * forward UDP, akuntansi byte) TANPA CLI resmi — hasilnya menjadi evidence
 * pendukung (berlabel SYNTHETIC), bukan pengganti gerbang CLI resmi.
 *
 * Pemakaian: node netgauge-synth.mjs <host> <port> [--small] [--dn N] [--up N]
 *   --small : DOWNLOAD/UPLOAD 1 MB (cepat)
 *   --dn N  : jumlah DOWNLOAD per worker (default 8)
 *   --up N  : jumlah UPLOAD per worker (default 6)
 */
import net from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';

const host = process.argv[2] || '127.0.0.1';
const port = +process.argv[3] || 9090;
const small = process.argv.includes('--small');
const DNN = +(process.argv.find((_, i, a) => a[i - 1] === '--dn') || 8);
const UPN = +(process.argv.find((_, i, a) => a[i - 1] === '--up') || 6);
const DLSIZE = small ? 1000000 : 32000000;
const UUID = crypto.randomUUID ? crypto.randomUUID() : 'a1111111-2222-4333-8444-555555555555'; // UUID acak per run (sesi loss backend diidentifikasi per-UUID)
const t0 = Date.now();
const rel = () => Date.now() - t0;
const log = (...a) => console.log(`[${String(rel()).padStart(6)}ms]`, ...a);

/** Satu koneksi NetGauge dengan pembaca respons baris-per-baris. */
class NgConn {
  constructor(name) {
    this.name = name; this.buf = ''; this.lines = []; this.waiters = [];
    this.bytesIn = 0; this.bytesOut = 0; this.closed = false;
    this.sock = net.connect({ host, port });
    this.sock.setNoDelay(true);
    this.sock.on('data', (c) => {
      this.bytesIn += c.length; this.buf += c.toString('latin1');
      let i;
      while ((i = this.buf.indexOf('\n')) !== -1) {
        const l = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        const w = this.waiters.shift();
        if (w) w(l); else this.lines.push(l);
      }
    });
    this.sock.on('close', () => { this.closed = true; this.waiters.forEach((w) => w(null)); });
    this.sock.on('error', () => { this.closed = true; this.waiters.forEach((w) => w(null)); });
  }
  send(line, payload) { const b = Buffer.from(line + '\n', 'latin1'); this.bytesOut += b.length; this.sock.write(b); if (payload) { this.bytesOut += payload.length; this.sock.write(payload); } }
  readLine(timeoutMs = 10000) {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.closed) return Promise.resolve(null); // koneksi mati → jangan tunggu timeout
    return new Promise((res) => {
      const t = setTimeout(() => { const ix = this.waiters.indexOf(fn); if (ix >= 0) this.waiters.splice(ix, 1); res(this.buf || null); }, timeoutMs);
      const fn = (l) => { clearTimeout(t); res(l); };
      this.waiters.push(fn);
    });
  }
  /** Baca respons DOWNLOAD: n byte total (prefix + payload + \n). */
  async readDownload(n, timeoutMs = 30000) {
    let got = 0; const start = Date.now();
    return new Promise((res) => {
      const done = () => { clearTimeout(t); res(got); };
      const t = setTimeout(() => { log(`  ${this.name}: DOWNLOAD timeout setelah ${got}/${n} B`); done(); }, timeoutMs);
      const onData = (c) => {
        got += c.length;
        if (got >= n) { this.sock.removeListener('data', onData); this.buf = ''; done(); }
      };
      this.sock.on('data', onData);
    });
  }
  close() { try { this.sock.end(); } catch {} }
}

const stats = { conns: [], dls: 0, uls: 0, ploss: [], udpSent: 0, udpRecv: 0 };
async function main() {
  log(`=== netgauge-synth → ${host}:${port} (DL ${DLSIZE} B ×${DNN}, UL ×${UPN}) ===`);

  // 1) probe seleksi (bare HI)
  for (let i = 0; i < 11; i++) {
    const c = new NgConn(`probe${i}`);
    await new Promise((r) => c.sock.once('connect', r));
    c.send('HI'); log(`probe${i}: HELLO =`, (await c.readLine() || '').slice(0, 44));
    c.send('GETIP'); await c.readLine();
    c.send('PING 111'); c.send('PING 222'); c.send('PING 333');
    await c.readLine(); await c.readLine(); await c.readLine();
    c.close(); stats.conns.push(c);
  }
  // 2) probe pemenang (HI UUID)
  {
    const c = new NgConn('winner');
    await new Promise((r) => c.sock.once('connect', r));
    c.send(`HI ${UUID}`); await c.readLine();
    c.send('GETIP'); await c.readLine();
    for (let i = 0; i < 5; i++) { c.send(`PING ${1000 + i}`); await c.readLine(); }
    c.close(); stats.conns.push(c);
    log('winner probe selesai (HI UUID + PING×5)');
  }
  // 3) koneksi loss
  const loss = new NgConn('loss');
  await new Promise((r) => loss.sock.once('connect', r));
  loss.send(`HI ${UUID}`); await loss.readLine();
  loss.send('INITPLOSS'); log('loss: INITPLOSS →', await loss.readLine());
  // 4) monitor ping
  const ping = new NgConn('pingmon');
  await new Promise((r) => ping.sock.once('connect', r));
  ping.send(`HI ${UUID}`); await ping.readLine();
  // 8) UDP stream — family socket harus cocok dengan alamat tujuan
  const isV6T = host.includes(':');
  const udp = dgram.createSocket(isV6T ? 'udp6' : 'udp4');
  let lossSeq = 0;
  udp.on('message', (m) => { stats.udpRecv++; });
  udp.on('error', (e) => log('UDP error:', e.message));
  const udpSend = () => {
    const timer = Date.now();
    const msg = Buffer.from(`LOSS ${timer} ${lossSeq} ${UUID} ${timer}\n`);
    udp.send(msg, port, host, (err) => { if (err) log('UDP send err:', err.message); });
    stats.udpSent++; lossSeq++;
  };
  for (let i = 0; i < 3; i++) udpSend();

  // 5) download workers (paralel)
  const dnWorkers = [];
  for (let w = 0; w < 4; w++) {
    const c = new NgConn(`dn${w}`);
    await new Promise((r) => c.sock.once('connect', r));
    c.send(`HI ${UUID}`); await c.readLine();
    dnWorkers.push(c); stats.conns.push(c);
  }
  await Promise.all(dnWorkers.map(async (c, w) => {
    for (let i = 0; i < DNN; i++) {
      c.send(`DOWNLOAD ${DLSIZE}`);
      const got = await c.readDownload(DLSIZE);
      stats.dls++;
      if (got !== DLSIZE) log(`  ${c.name}: DOWNLOAD tidak lengkap ${got}/${DLSIZE}`);
    }
  }));
  log(`download selesai: ${stats.dls} × ${DLSIZE} B`);

  // 6) kontrol upload + 7) upload workers
  {
    const c = new NgConn('upctl');
    await new Promise((r) => c.sock.once('connect', r));
    c.send(`HI ${UUID}`); await c.readLine();
    c.send('CAPABILITIES'); log('upctl: CAPABILITIES →', await c.readLine());
    c.send('UPLOAD_STATS 15000 16 0'); log('upctl: UPLOAD_STATS →', await c.readLine());
    c.close(); stats.conns.push(c);
  }
  const upWorkers = [];
  for (let w = 0; w < 4; w++) {
    const c = new NgConn(`up${w}`);
    await new Promise((r) => c.sock.once('connect', r));
    c.send(`HI ${UUID}`); await c.readLine();
    upWorkers.push(c); stats.conns.push(c);
  }
  const cmdLen = Buffer.byteLength(`UPLOAD ${DLSIZE} 15000 16\n`);
  await Promise.all(upWorkers.map(async (c) => {
    for (let i = 0; i < UPN; i++) {
      const payload = Buffer.alloc(DLSIZE - cmdLen, 0x75); // 'u'
      c.send(`UPLOAD ${DLSIZE} 15000 16`, payload);
      const resp = await c.readLine(30000);
      if (resp && resp.startsWith('OK')) stats.uls++;
      else log(`  ${c.name}: UPLOAD balasan aneh:`, resp);
    }
  }));
  log(`upload selesai: ${stats.uls}/${UPN * 4} OK`);

  // PLOSS query
  for (let i = 0; i < 3; i++) { loss.send('PLOSS'); const r = await loss.readLine(); log(`PLOSS → ${r}`); stats.ploss.push(r); }
  // ping monitor beberapa kali
  for (let i = 0; i < 5; i++) { ping.send(`PING ${Date.now()}`); await ping.readLine(); }
  for (let i = 0; i < 10; i++) udpSend();

  // ringkasan
  const totalIn = stats.conns.reduce((s, c) => s + c.bytesIn, 0);
  const totalOut = stats.conns.reduce((s, c) => s + c.bytesOut, 0);
  console.log('\n=== RINGKASAN SYNTH ===');
  console.log(`koneksi: ${stats.conns.length} | DOWNLOAD selesai: ${stats.dls} | UPLOAD OK: ${stats.uls} | PLOSS: ${JSON.stringify(stats.ploss)}`);
  console.log(`UDP terkirim: ${stats.udpSent} | UDP diterima (RECV): ${stats.udpRecv}`);
  console.log(`total bytes in/out (semua koneksi): ${totalIn.toLocaleString()} / ${totalOut.toLocaleString()}`);
  loss.close(); ping.close(); dnWorkers.forEach((c) => c.close()); upWorkers.forEach((c) => c.close());
  setTimeout(() => process.exit(0), 300);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

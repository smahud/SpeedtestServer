#!/usr/bin/env node
/**
 * offline-config-proxy.mjs — lab config proxy dengan snapshot offline.
 *
 * Teknik yang sama dengan validation/harness/cv-proxy.mjs (repo ini), dengan
 * dua perbedaan yang didokumentasikan untuk matriks diversion:
 *   1. Config TIDAK diambil live dari cli.speedtest.net pada setiap run
 *      (menghindari rate-limit 429 dan membuat setiap run dapat direproduksi),
 *      melainkan dilayani dari snapshot config asli yang diambil langsung
 *      (first-hand) dari endpoint resmi pada tanggal yang tercatat di
 *      --snapshot. Query milik CLI tetap dicatat; parameter engine yang
 *      dilayani identik dengan snapshot (threadCount, durasi, maxConnections,
 *      pingCount, dll.).
 *   2. Semua entri servers[] diarahkan ke --target (mode rewrite-all), sehingga
 *      CLI tidak pernah fallback ke server produksi.
 *
 * Jaminan non-publishing (default): CONNECT results.speedtest.net DITOLAK.
 * Mode --publish (opt-in, TIDAK dipakai di matriks diversion): tunnel.
 * Semua host lain di-tunnel transparan + dicatat.
 *
 * Pemakaian:
 *   node offline-config-proxy.mjs --port 8888 --target localhost:9090 \
 *     --snapshot ../evidence/config-snapshot.json --log out/proxy.jsonl
 */
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';

const LAB = path.dirname(new URL(import.meta.url).pathname);
const a = { port: 8888, target: 'localhost:9090', snapshot: path.join(LAB, '..', 'evidence', 'config-snapshot.json'), log: path.join(process.cwd(), 'proxy.jsonl'), publish: false };
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (t === '--port') a.port = +process.argv[++i];
  else if (t === '--target') a.target = process.argv[++i];
  else if (t === '--snapshot') a.snapshot = process.argv[++i];
  else if (t === '--log') a.log = process.argv[++i];
  else if (t === '--publish') a.publish = true;
}
fs.mkdirSync(path.dirname(a.log), { recursive: true });
const LOG = fs.createWriteStream(a.log, { flags: 'w' });
function log(o) { o.ts = Date.now(); LOG.write(JSON.stringify(o) + '\n'); }

const SNAPSHOT = JSON.parse(fs.readFileSync(a.snapshot, 'utf8'));
const MITM_CERT = fs.readFileSync(path.join(LAB, 'certs', 'mitm.pem'));
const MITM_KEY = fs.readFileSync(path.join(LAB, 'certs', 'mitm.key'));
const BLOCKED = new Set(a.publish ? [] : ['results.speedtest.net']);
log({ k: 'meta', port: a.port, target: a.target, snapshot: a.snapshot, snapshotServers: (SNAPSHOT.servers || []).length, publish: a.publish, pid: process.pid });

function rewrittenConfig() {
  const cfg = JSON.parse(JSON.stringify(SNAPSHOT)); // deep copy per run
  const changed = [];
  for (const s of cfg.servers || []) {
    changed.push({ id: s.id, host: s.host, name: s.name });
    s.host = a.target;
    s.name = `${s.name || ''} -> LAB (${a.target}) [diversion audit]`;
  }
  return { body: Buffer.from(JSON.stringify(cfg)), changed };
}

function serveConfigApi(tlsSock) {
  let buf = Buffer.alloc(0);
  tlsSock.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    let idx;
    while ((idx = buf.indexOf('\r\n\r\n')) !== -1) {
      const head = buf.subarray(0, idx).toString('latin1');
      buf = buf.subarray(idx + 4);
      const [line, ...hdrs] = head.split('\r\n');
      const [method, target] = line.split(' ');
      const headers = {};
      for (const h of hdrs) { const c2 = h.indexOf(':'); if (c2 > 0) headers[h.slice(0, c2).trim().toLowerCase()] = h.slice(c2 + 1).trim(); }
      log({ k: 'config_req', method, target, ua: headers['user-agent'] || '' });
      if (method === 'GET' && target.startsWith('/api/cli/config')) {
        const { body, changed } = rewrittenConfig();
        log({ k: 'config_served', source: 'offline-snapshot', servedBytes: body.length, rewritten: changed });
        tlsSock.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n' +
          `Content-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n` + body.toString('utf8'));
      } else {
        const out = Buffer.from('not found');
        log({ k: 'config_404', target });
        tlsSock.write('HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n' +
          `Content-Length: ${out.length}\r\nConnection: keep-alive\r\n\r\n` + out.toString());
      }
    }
  });
  tlsSock.on('error', (e) => log({ k: 'tls_err', error: String(e) }));
}

const server = net.createServer((sock) => {
  sock.setNoDelay(true);
  let buf = Buffer.alloc(0);
  let handled = false;
  sock.on('data', function onData(c) {
    buf = Buffer.concat([buf, c]);
    if (handled) return;
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) { if (buf.length > 65536) sock.destroy(); return; }
    const head = buf.subarray(0, idx).toString('latin1');
    const rest = buf.subarray(idx + 4);
    sock.removeListener('data', onData);
    const lines = head.split('\r\n');
    const [method, target] = lines[0].split(' ');
    if (method !== 'CONNECT') {
      log({ k: 'plain_http', method, target });
      sock.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      sock.end();
      return;
    }
    handled = true;
    const hostPort = target;
    const host = hostPort.replace(/:\d+$/, '');
    if (BLOCKED.has(host)) {
      log({ k: 'blocked', target: hostPort, reason: 'non-publishing guarantee' });
      sock.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      sock.end();
      return;
    }
    if (host === 'cli.speedtest.net') {
      log({ k: 'mitm', target: hostPort, note: 'offline snapshot' });
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const tlsSock = new tls.TLSSocket(sock, { isServer: true, cert: MITM_CERT, key: MITM_KEY, ALPNProtocols: ['http/1.1'] });
      tlsSock.on('secure', () => log({ k: 'mitm_tls_ok', alpn: tlsSock.alpnProtocol || 'none' }));
      tlsSock.on('error', (e) => log({ k: 'mitm_tls_err', error: String(e) }));
      serveConfigApi(tlsSock);
      if (rest.length) tlsSock.emit('data', rest);
      return;
    }
    log({ k: 'tunnel', target: hostPort });
    const up = net.connect({ host, port: parseInt(hostPort.split(':').pop(), 10) }, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (rest.length) up.write(rest);
      sock.pipe(up); up.pipe(sock);
    });
    up.on('error', (e) => { log({ k: 'tunnel_err', target: hostPort, error: e.code || String(e) }); try { sock.destroy(); } catch {} });
    sock.on('error', () => { try { up.destroy(); } catch {} });
    sock.on('close', () => { try { up.destroy(); } catch {} });
    up.on('close', () => { try { sock.destroy(); } catch {} });
  });
  sock.on('error', () => {});
});
server.on('error', (e) => { console.error('offline-config-proxy error:', e.message); process.exit(1); });
server.listen(a.port, '127.0.0.1', () => {
  console.log(`[offline-config-proxy] :${a.port} | cli.speedtest.net → snapshot ${path.basename(a.snapshot)} (all ${ (SNAPSHOT.servers || []).length } servers → ${a.target}) | results.speedtest.net ${a.publish ? 'TUNNELED (publishing)' : 'BLOCKED (non-publishing)'}`);
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

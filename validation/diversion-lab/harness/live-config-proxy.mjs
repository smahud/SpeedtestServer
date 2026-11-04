#!/usr/bin/env node
/**
 * live-config-proxy.mjs — config-proxy lab dengan fetch LIVE via curl.
 *
 * Teknik yang sama dengan validation/harness/cv-proxy.mjs (repo ini), dengan
 * satu perbedaan penting yang ditemukan sesi diversion-lab 2026-11-04:
 *
 *   Node https.request ke cli.speedtest.net kena rate-limit 429 (Cloudflare
 *   membedakan TLS fingerprint), sedangkan curl lolos. Karena itu fetch live
 *   dijalankan via subprocess curl dengan UA + query PERSIS milik CLI, dan
 *   responsnya (fresh, 1–3 detik) langsung di-rewrite (semua entri servers[]
 *   → --target) dan disajikan ke CLI.
 *
 * Jaminan non-publishing: CONNECT results.speedtest.net DITOLAK (default).
 * Semua host lain di-tunnel transparan. Fallback opsional ke snapshot offline
 * bila fetch live gagal (--fallback-snapshot, TIDAK default karena licenseKey
 * snapshot pernah ditolak CLI; lihat laporan).
 *
 * Pemakaian:
 *   node live-config-proxy.mjs --port 8888 --target localhost:9090 \
 *     [--fallback-snapshot ../evidence/config-snapshot.json] --log out/proxy.jsonl
 */
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const LAB = path.dirname(new URL(import.meta.url).pathname);
const a = { port: 8888, target: 'localhost:9090', snapshot: null, log: path.join(process.cwd(), 'proxy.jsonl'), cache: null };
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (t === '--port') a.port = +process.argv[++i];
  else if (t === '--target') a.target = process.argv[++i];
  else if (t === '--fallback-snapshot') a.snapshot = process.argv[++i];
  else if (t === '--cache') a.cache = process.argv[++i]; // file config pre-warmed (hasil curl retry-loop orchestrator)
  else if (t === '--log') a.log = process.argv[++i];
}
fs.mkdirSync(path.dirname(a.log), { recursive: true });
const LOG = fs.createWriteStream(a.log, { flags: 'w' });
function log(o) { o.ts = Date.now(); LOG.write(JSON.stringify(o) + '\n'); }

const MITM_CERT = fs.readFileSync(path.join(LAB, 'certs', 'mitm.pem'));
const MITM_KEY = fs.readFileSync(path.join(LAB, 'certs', 'mitm.key'));
const BLOCKED = new Set(['results.speedtest.net']); // non-publishing guarantee
log({ k: 'meta', port: a.port, target: a.target, mode: 'live-curl-fetch', fallbackSnapshot: a.snapshot, pid: process.pid });

/** Fetch live config via curl (TLS fingerprint yang lolos CDN). */
function fetchLiveCurl(query, ua) {
  return new Promise((resolve) => {
    const url = 'https://cli.speedtest.net/api/cli/config' + (query ? '?' + query : '');
    execFile('curl', ['-sS', '--max-time', '20', '-A', ua || 'ookla-cli/1.2.0.84-1.ea6b6773cf (speedtest-cli-linux-x86_64)',
      '-H', 'Accept: application/json', '-w', '\n%{http_code}', url],
      { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve({ status: 0, error: String(err) });
        const idx = stdout.lastIndexOf('\n');
        const status = parseInt(stdout.slice(idx + 1).trim(), 10);
        const body = Buffer.from(stdout.slice(0, idx), 'utf8');
        resolve({ status, body });
      });
  });
}

function rewriteConfig(cfgBuf) {
  const cfg = JSON.parse(cfgBuf.toString('utf8'));
  const changed = [];
  for (const s of cfg.servers || []) {
    changed.push({ id: s.id, host: s.host });
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
        const query = target.split('?', 2)[1] || '';
        // cache pre-warmed (hasil curl retry orchestrator) → tidak memanggil API
        if (a.cache && fs.existsSync(a.cache)) {
          const raw = fs.readFileSync(a.cache);
          const stat = fs.statSync(a.cache);
          const ageMs = Date.now() - stat.mtimeMs;
          const { body: out, changed } = rewriteConfig(raw);
          log({ k: 'config_served', source: 'prewarmed-cache', cacheFile: a.cache, ageMs, servedBytes: out.length, rewritten: changed.map((x) => x.id) });
          tlsSock.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n' +
            `Content-Length: ${out.length}\r\nConnection: keep-alive\r\n\r\n` + out.toString('utf8'));
          return;
        }
        fetchLiveCurl(query, headers['user-agent'])
          .then(({ status, body, error }) => {
            if (status !== 200) {
              log({ k: 'config_error', status, error: error || null });
              let out = null;
              if (a.snapshot) {
                out = Buffer.from(fs.readFileSync(a.snapshot));
                log({ k: 'config_served', source: 'fallback-snapshot', note: 'licenseKey snapshot — berisiko InvalidLicenseKey' });
              } else {
                out = Buffer.from(JSON.stringify({ error: `lab proxy upstream status ${status}` }));
                tlsSock.write('HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\n' +
                  `Content-Length: ${out.length}\r\nConnection: close\r\n\r\n` + out.toString());
                tlsSock.end();
                return;
              }
              const { body: out2, changed } = rewriteConfig(out);
              tlsSock.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n' +
                `Content-Length: ${out2.length}\r\nConnection: keep-alive\r\n\r\n` + out2.toString('utf8'));
              return;
            }
            const { body: out, changed } = rewriteConfig(body);
            log({ k: 'config_served', source: 'live-curl', liveBytes: body.length, servedBytes: out.length, rewritten: changed.map((x) => x.id) });
            tlsSock.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n' +
              `Content-Length: ${out.length}\r\nConnection: keep-alive\r\n\r\n` + out.toString('utf8'));
          })
          .catch((e) => {
            log({ k: 'config_error', error: String(e) });
            try { tlsSock.end(); } catch {}
          });
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
      log({ k: 'mitm', target: hostPort, note: 'live curl fetch + rewrite' });
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
server.on('error', (e) => { console.error('live-config-proxy error:', e.message); process.exit(1); });
server.listen(a.port, '127.0.0.1', () => {
  console.log(`[live-config-proxy] :${a.port} | cli.speedtest.net → LIVE curl fetch + rewrite (all servers → ${a.target}) | results.speedtest.net BLOCKED (non-publishing)${a.snapshot ? ' | fallback: snapshot' : ''}`);
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

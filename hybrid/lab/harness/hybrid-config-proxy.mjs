#!/usr/bin/env node
/**
 * hybrid-config-proxy.mjs — config-proxy for the hybrid-research CLI
 * experiments (E-D / E-E), adapted from
 * validation/diversion-lab/harness/live-config-proxy.mjs.
 *
 * Differences from the diversion-lab proxy:
 *   - per-entry server-list rewriting: `--servers "t0,t1,t2,..."` maps the
 *     i-th entry of the LIVE config's servers[] to the i-th target
 *     (cycling when the live list is longer). This lets ONE official CLI
 *     run see a mixed candidate list — e.g. Cloudflare-fronted hostnames
 *     AND the local SpeedtestServer — which is exactly the hybrid
 *     selection scenario under test.
 *   - non-publishing guarantee preserved: results.speedtest.net refused.
 *
 * The live fetch goes through curl with the CLI's exact query (the CDN
 * rate-limits non-curl TLS fingerprints — verified in the diversion lab).
 *
 * Usage:
 *   node hybrid-config-proxy.mjs --port 8888 \
 *     --servers "speed.cloudflare.com:8080,speed.cloudflare.com:443,127.0.0.1:8080" \
 *     --log out/proxy.jsonl
 */
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const LAB = path.dirname(new URL(import.meta.url).pathname);
const a = { port: 8888, servers: [], log: path.join(process.cwd(), 'proxy.jsonl') };
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (t === '--port') a.port = +process.argv[++i];
  else if (t === '--servers') a.servers = process.argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
  else if (t === '--log') a.log = process.argv[++i];
}
if (!a.servers.length) {
  console.error('usage: node hybrid-config-proxy.mjs --port 8888 --servers "h1:p1,h2:p2,..." --log out.jsonl');
  process.exit(2);
}
fs.mkdirSync(path.dirname(a.log), { recursive: true });
const LOG = fs.createWriteStream(a.log, { flags: 'w' });
function log(o) {
  o.ts = Date.now();
  LOG.write(JSON.stringify(o) + '\n');
}

const CERTS = '/home/z/my-project/baseline/validation/harness/certs';
const MITM_CERT = fs.readFileSync(path.join(CERTS, 'mitm.pem'));
const MITM_KEY = fs.readFileSync(path.join(CERTS, 'mitm.key'));
const BLOCKED = new Set(['results.speedtest.net']); // non-publishing guarantee
log({ k: 'meta', port: a.port, mode: 'hybrid-per-entry', servers: a.servers, pid: process.pid });

function fetchLiveCurl(query, ua) {
  return new Promise((resolve) => {
    const url = 'https://cli.speedtest.net/api/cli/config' + (query ? '?' + query : '');
    execFile(
      'curl',
      ['-sS', '--max-time', '20', '-A', ua || 'ookla-cli/1.2.0.84-1.ea6b6773cf (speedtest-cli-linux-x86_64)', '-H', 'Accept: application/json', '-w', '\n%{http_code}', url],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve({ status: 0, error: String(err) });
        const idx = stdout.lastIndexOf('\n');
        const status = parseInt(stdout.slice(idx + 1).trim(), 10);
        const body = Buffer.from(stdout.slice(0, idx), 'utf8');
        resolve({ status, body });
      },
    );
  });
}

function rewriteConfig(cfgBuf) {
  const cfg = JSON.parse(cfgBuf.toString('utf8'));
  const changed = [];
  const servers = cfg.servers || [];
  for (let i = 0; i < servers.length; i++) {
    const s = servers[i];
    const target = a.servers[i % a.servers.length];
    changed.push({ id: s.id, host: s.host, port: s.port, to: target });
    const [host, port] = target.includes(':') ? target.split(':') : [target, '8080'];
    s.host = `${host}:${port}`;
    s.port = Number(port);
    s.name = `${s.name || ''} -> HYBRID (${target}) [e-d/e-e experiment]`;
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
      for (const h of hdrs) {
        const c2 = h.indexOf(':');
        if (c2 > 0) headers[h.slice(0, c2).trim().toLowerCase()] = h.slice(c2 + 1).trim();
      }
      log({ k: 'config_req', method, target, ua: headers['user-agent'] || '' });
      if (method === 'GET' && target.startsWith('/api/cli/config')) {
        const query = target.split('?', 2)[1] || '';
        fetchLiveCurl(query, headers['user-agent']).then(({ status, body, error }) => {
          if (status !== 200) {
            log({ k: 'config_error', status, error: error || null });
            const out = Buffer.from(JSON.stringify({ error: `hybrid proxy upstream status ${status}` }));
            tlsSock.write('HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\n' + `Content-Length: ${out.length}\r\nConnection: close\r\n\r\n` + out.toString('utf8'));
            tlsSock.end();
            return;
          }
          const { body: out, changed } = rewriteConfig(body);
          log({ k: 'config_served', source: 'live-curl', liveBytes: body.length, servedBytes: out.length, rewritten: changed });
          tlsSock.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n' + `Content-Length: ${out.length}\r\nConnection: keep-alive\r\n\r\n` + out.toString('utf8'));
        });
      } else {
        const out = Buffer.from('not found');
        log({ k: 'config_404', target });
        tlsSock.write('HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n' + `Content-Length: ${out.length}\r\nConnection: keep-alive\r\n\r\n` + out.toString('utf8'));
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
    if (idx === -1) {
      if (buf.length > 65536) sock.destroy();
      return;
    }
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
      log({ k: 'mitm', target: hostPort, note: 'live curl fetch + per-entry rewrite' });
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
      sock.pipe(up);
      up.pipe(sock);
    });
    up.on('error', (e) => {
      log({ k: 'tunnel_err', target: hostPort, error: e.code || String(e) });
      try {
        sock.destroy();
      } catch {}
    });
    sock.on('error', () => {
      try {
        up.destroy();
      } catch {}
    });
    sock.on('close', () => {
      try {
        up.destroy();
      } catch {}
    });
    up.on('close', () => {
      try {
        sock.destroy();
      } catch {}
    });
  });
  sock.on('error', () => {});
});
server.on('error', (e) => {
  console.error('hybrid-config-proxy error:', e.message);
  process.exit(1);
});
server.listen(a.port, '127.0.0.1', () => {
  console.log(`[hybrid-config-proxy] :${a.port} | cli.speedtest.net → LIVE curl + per-entry rewrite (${a.servers.join(' | ')}) | results.speedtest.net BLOCKED (non-publishing)`);
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

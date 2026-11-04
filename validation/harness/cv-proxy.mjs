#!/usr/bin/env node
/**
 * Lab config-proxy: directs the official Ookla Speedtest CLI at a local server.
 *
 * Principle (independently implemented for this audit; same technique family
 * as the SpeedtestHost-Tester cross-validation proxies):
 *
 *  1. The CLI is run with ALL_PROXY/HTTPS_PROXY pointing here and
 *     --ca-certificate=<system store + lab CA> so it trusts the lab CA.
 *  2. CONNECT cli.speedtest.net:443 is TLS-terminated with a lab cert and the
 *     REAL live engine config is fetched from Ookla using the CLI's OWN query
 *     string and User-Agent (license/engine params stay genuine), with exactly
 *     ONE server entry redirected to the local test server.
 *  3. NON-PUBLISHING GUARANTEE: CONNECT results.speedtest.net is REFUSED, so
 *     no lab measurement can be submitted as a genuine public result.
 *  4. Everything else is transparently tunneled.
 *
 * Usage: node cv-proxy.mjs [--port 8888] [--target localhost:8080] [--server-id ID]
 *       (rewrites servers[0] unless --server-id given)
 */
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const LAB = path.dirname(new URL(import.meta.url).pathname);
const CERTS = path.join(LAB, 'certs');

function parseArgs(argv) {
  const a = { port: 8888, target: 'localhost:8080', serverId: null, log: path.join(LAB, 'captures', 'cv-proxy.jsonl') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') a.port = parseInt(argv[++i], 10);
    else if (argv[i] === '--target') a.target = argv[++i];
    else if (argv[i] === '--server-id') a.serverId = argv[++i];
    else if (argv[i] === '--log') a.log = argv[++i];
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
fs.mkdirSync(path.dirname(args.log), { recursive: true });
const LOG = fs.createWriteStream(args.log, { flags: 'w' });
function log(o) { o.ts = Date.now(); LOG.write(JSON.stringify(o) + '\n'); }

const MITM_CERT = fs.readFileSync(path.join(CERTS, 'mitm.pem'));
const MITM_KEY = fs.readFileSync(path.join(CERTS, 'mitm.key'));
const SYSTEM_CA = fs.readFileSync('/etc/ssl/certs/ca-certificates.crt');
const BLOCKED_HOSTS = new Set(['results.speedtest.net']); // non-publishing guarantee

log({ k: 'meta', port: args.port, target: args.target, serverId: args.serverId, pid: process.pid });

async function fetchLiveConfig(query, ua) {
  const url = 'https://cli.speedtest.net/api/cli/config' + (query ? '?' + query : '');
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: {
        'User-Agent': ua || 'ookla-cli/1.2.0.84-1.ea6b6773cf (speedtest-cli-linux-x86_64)',
        'Accept': 'application/json',
      },
      ca: SYSTEM_CA,
      timeout: 20000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    req.end();
  });
}

function rewriteConfig(cfgBuf) {
  const cfg = JSON.parse(cfgBuf.toString('utf8'));
  const servers = cfg.servers || [];
  const rewriteAll = process.env.CV_REWRITE_ALL === '1';
  const changed = [];
  const targets = rewriteAll ? servers : [args.serverId ? servers.find((s) => String(s.id) === String(args.serverId)) : servers[0]].filter(Boolean);
  for (const pick of targets) {
    changed.push({ id: pick.id, host: pick.host, name: pick.name });
    pick.host = args.target;
    pick.name = `${pick.name || ''} -> LAB (${args.target}) [SpeedtestServer audit]`;
  }
  return { body: Buffer.from(JSON.stringify(cfg)), changed };
}

function serveConfigApi(tlsSock) {
  // Minimal HTTP/1.1 server over the TLS socket (ALPN: http/1.1 only)
  let buf = Buffer.alloc(0);
  tlsSock.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    // parse request headers
    let idx;
    while ((idx = buf.indexOf('\r\n\r\n')) !== -1) {
      const head = buf.subarray(0, idx).toString('latin1');
      buf = buf.subarray(idx + 4);
      const [line, ...hdrs] = head.split('\r\n');
      const [method, target] = line.split(' ');
      const headers = {};
      for (const h of hdrs) {
        const c = h.indexOf(':');
        if (c > 0) headers[h.slice(0, c).trim().toLowerCase()] = h.slice(c + 1).trim();
      }
      log({ k: 'config_req', method, target, ua: headers['user-agent'] || '' });
      if (method === 'GET' && target.startsWith('/api/cli/config')) {
        const query = target.split('?', 2)[1] || '';
        fetchLiveConfig(query, headers['user-agent'])
          .then(({ status, body }) => {
            if (status !== 200) throw new Error(`live config status ${status}`);
            const { body: out, changed } = rewriteConfig(body);
            log({ k: 'config_served', liveBytes: body.length, servedBytes: out.length, rewritten: changed });
            const resp = 'HTTP/1.1 200 OK\r\n' +
              'Content-Type: application/json\r\n' +
              `Content-Length: ${out.length}\r\n` +
              'Connection: keep-alive\r\n\r\n';
            tlsSock.write(resp + out.toString('utf8'), 'utf8');
          })
          .catch((e) => {
            log({ k: 'config_error', error: String(e) });
            const out = Buffer.from(JSON.stringify({ error: 'lab proxy upstream failure' }));
            tlsSock.write('HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\n' +
              `Content-Length: ${out.length}\r\nConnection: close\r\n\r\n` + out.toString());
            tlsSock.end();
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
  let handledConnect = false;
  sock.on('data', function onData(c) {
    buf = Buffer.concat([buf, c]);
    if (handledConnect) return;
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) {
      if (buf.length > 65536) { sock.destroy(); return; }
      return;
    }
    const head = buf.subarray(0, idx).toString('latin1');
    const rest = buf.subarray(idx + 4);
    sock.removeListener('data', onData);
    const lines = head.split('\r\n');
    const [method, target] = lines[0].split(' ');
    if (method !== 'CONNECT') {
      // Plain HTTP via absolute URI: refuse (the CLI uses HTTPS for its APIs)
      log({ k: 'plain_http', method, target });
      sock.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      sock.end();
      return;
    }
    handledConnect = true;
    const hostPort = target;
    const host = hostPort.replace(/:\d+$/, '');
    if (BLOCKED_HOSTS.has(host)) {
      log({ k: 'blocked', target: hostPort, reason: 'non-publishing guarantee' });
      sock.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      sock.end();
      return;
    }
    if (host === 'cli.speedtest.net') {
      log({ k: 'mitm', target: hostPort });
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const tlsSock = new tls.TLSSocket(sock, {
        isServer: true,
        cert: MITM_CERT,
        key: MITM_KEY,
        ALPNProtocols: ['http/1.1'],
      });
      tlsSock.on('secure', () => log({ k: 'mitm_tls_ok', alpn: tlsSock.alpnProtocol || 'none' }));
      tlsSock.on('error', (e) => log({ k: 'mitm_tls_err', error: String(e) }));
      // re-inject any bytes already received after the CONNECT head
      serveConfigApi(tlsSock);
      if (rest.length) tlsSock.emit('data', rest); // not typical, but safe
      return;
    }
    // Transparent tunnel
    log({ k: 'tunnel', target: hostPort });
    const up = net.connect({ host, port: parseInt(hostPort.split(':').pop(), 10) }, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (rest.length) up.write(rest);
      sock.pipe(up); up.pipe(sock);
    });
    up.on('error', (e) => { log({ k: 'tunnel_err', target: hostPort, error: e.code || String(e) }); try { sock.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {} sock.destroy(); });
    sock.on('error', () => up.destroy());
    sock.on('close', () => up.destroy());
    up.on('close', () => sock.destroy());
  });
  sock.on('error', () => {});
});

server.on('error', (e) => { console.error('cv-proxy error:', e.message); process.exit(1); });
server.listen(args.port, '127.0.0.1', () => {
  console.log(`[cv-proxy] on 127.0.0.1:${args.port} | cli.speedtest.net -> crafted config (1 server -> ${args.target}) | results.speedtest.net BLOCKED`);
});
process.on('SIGINT', () => process.exit(0));

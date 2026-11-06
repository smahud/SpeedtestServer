#!/usr/bin/env node
/**
 * tls-terminator.mjs — TLS front for the local workerd Worker.
 *
 * In production the Cloudflare edge terminates TLS before the Worker sees
 * plaintext HTTP/WS. Local `wrangler dev` serves plain HTTP only, so this
 * terminator reproduces the production shape for instruments that require
 * https/wss (e.g. the Speedtest Host Tester's HTTPS check):
 *
 *   client ──TLS(lab cert)──> :8793 ──TCP──> workerd :8790
 *
 * Usage: node tls-terminator.mjs [listenPort] [targetPort] [cert] [key]
 */
import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs';

const LISTEN = Number(process.argv[2] || 8793);
const TARGET_PORT = Number(process.argv[3] || 8790);
const TARGET_HOST = '127.0.0.1';
const CERT = process.argv[4] || '/home/z/my-project/baseline/validation/harness/certs/server.pem';
const KEY = process.argv[5] || '/home/z/my-project/baseline/validation/harness/certs/server.key';

let conns = 0;
const server = tls.createServer(
  { cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY), ALPNProtocols: ['http/1.1'] },
  (tlsSock) => {
    conns++;
    const up = net.connect({ host: TARGET_HOST, port: TARGET_PORT }, () => {
      tlsSock.pipe(up);
      up.pipe(tlsSock);
    });
    const done = () => {
      try { up.destroy(); } catch {}
      try { tlsSock.destroy(); } catch {}
    };
    tlsSock.on('error', done);
    up.on('error', done);
    tlsSock.on('close', done);
    up.on('close', done);
  },
);
server.listen(LISTEN, '127.0.0.1', () => {
  console.log(JSON.stringify({ kind: 'tls_terminator_started', listen: LISTEN, target: `${TARGET_HOST}:${TARGET_PORT}`, alpn: 'http/1.1' }));
});

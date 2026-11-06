#!/usr/bin/env node
/**
 * edge-front.mjs — single-port multiplexing front for the local workerd
 * Worker, replicating the reference daemon's first-byte protocol detection
 * (PROTOCOL_CONTRACT §1): one port accepts BOTH plain HTTP and TLS
 * (the daemon multiplexes HTTP / TLS / WebSocket / NetGauge on one port;
 * the Cloudflare edge likewise serves both http:// and https://).
 *
 *   client ──┬─ TLS ClientHello (0x16 0x03…) ──> TLS termination ──> workerd
 *            └─ anything else (plain HTTP) ───────────────────────> workerd
 *
 * Usage: node edge-front.mjs [listenPort] [targetPort] [cert] [key]
 */
import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs';

const LISTEN = Number(process.argv[2] || 8793);
const TARGET_PORT = Number(process.argv[3] || 8790);
const TARGET_HOST = '127.0.0.1';
const CERT = process.argv[4] || '/home/z/my-project/baseline/validation/harness/certs/server.pem';
const KEY = process.argv[5] || '/home/z/my-project/baseline/validation/harness/certs/server.key';

const cert = fs.readFileSync(CERT);
const key = fs.readFileSync(KEY);

function forward(src, dst) {
  const done = () => {
    try { src.destroy(); } catch {}
    try { dst.destroy(); } catch {}
  };
  src.on('error', done);
  dst.on('error', done);
  src.on('close', done);
  dst.on('close', done);
  src.pipe(dst);
  dst.pipe(src);
}

/**
 * Response-direction rewriting that emulates the PRODUCTION Cloudflare edge:
 * the real edge adds `Connection: keep-alive` to HTTP/1.1 responses (first-
 * hand probe: speed.cloudflare.com HTTP/1.1 responses carry it), while local
 * workerd omits the hop-by-hop header entirely (a Worker can never set it).
 * This front injects it after the status line of each response so local
 * instruments see the production shape. Documented in the experiment notes.
 */
function forwardWithEdgeHeaders(fromUp, toClient) {
  let first = true;
  fromUp.on('data', (chunk) => {
    if (first) {
      first = false;
      const head = chunk.toString('latin1');
      const nl = head.indexOf('\r\n');
      if (nl !== -1 && !/^connection:/im.test(head)) {
        const injected = Buffer.from(head.slice(0, nl) + '\r\nConnection: keep-alive' + head.slice(nl), 'latin1');
        toClient.write(injected);
        return;
      }
    }
    toClient.write(chunk);
  });
  fromUp.on('end', () => toClient.end());
  fromUp.on('error', () => {
    try { toClient.destroy(); } catch {}
  });
  toClient.on('error', () => {
    try { fromUp.destroy(); } catch {}
  });
  toClient.on('close', () => {
    try { fromUp.destroy(); } catch {}
  });
  fromUp.on('close', () => {
    try { toClient.destroy(); } catch {}
  });
}

const server = net.createServer((sock) => {
  sock.setNoDelay(true);
  sock.once('data', (chunk) => {
    const isTls = chunk.length >= 2 && chunk[0] === 0x16 && chunk[1] === 0x03;
    if (isTls) {
      // TLS path (pattern proven in SpeedtestServer's ServerCore.startTls):
      // wrap, unshift the ClientHello, wait for the first decrypted bytes,
      // then pipe to workerd.
      const tlsSock = new tls.TLSSocket(sock, {
        isServer: true,
        cert,
        key,
        ALPNProtocols: ['http/1.1'],
      });
      sock.unshift(chunk);
      tlsSock.once('data', (plain) => {
        const up = net.connect({ host: TARGET_HOST, port: TARGET_PORT }, () => up.write(plain));
        tlsSock.on('data', (c) => up.write(c));
        forwardWithEdgeHeaders(up, tlsSock);
        const done = () => { try { up.destroy(); } catch {} try { tlsSock.destroy(); } catch {} };
        tlsSock.on('error', done);
        up.on('error', done);
        tlsSock.on('close', done);
        up.on('close', done);
      });
      tlsSock.on('error', (e) => console.error('tls error:', e.message));
    } else {
      // Plain-HTTP path: request passes through; responses get the edge's
      // Connection header emulation.
      const up = net.connect({ host: TARGET_HOST, port: TARGET_PORT }, () => up.write(chunk));
      sock.on('data', (c) => up.write(c));
      forwardWithEdgeHeaders(up, sock);
      const done = () => { try { up.destroy(); } catch {} try { sock.destroy(); } catch {} };
      sock.on('error', done);
      up.on('error', done);
      sock.on('close', done);
      up.on('close', done);
    }
  });
  sock.on('error', () => {});
});

server.listen(LISTEN, '127.0.0.1', () => {
  console.log(JSON.stringify({ kind: 'edge_front_started', listen: LISTEN, target: `${TARGET_HOST}:${TARGET_PORT}`, multiplex: 'TLS|plain-HTTP by first byte' }));
});

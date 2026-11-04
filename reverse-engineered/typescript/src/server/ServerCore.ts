/**
 * ServerCore — canonical listener architecture for SpeedtestServer.
 *
 * Fixes the P0 defects of the previous implementation:
 *   - ONE listener per TCP port with per-connection protocol multiplexing
 *     (TLS / HTTP / WebSocket / native NetGauge), exactly like the reference
 *     daemon's deployment model. No competing HTTP-vs-HTTPS listeners on the
 *     same port.
 *   - Bind failures are FATAL (fail closed). The old code resolved the
 *     EADDRINUSE promise and logged "All servers started successfully".
 *   - Runs unprivileged (no /var/lock, /etc/ooklaserver requirements).
 *
 * Transport detection per connection (first bytes):
 *   0x16 0x03 ...          → TLS (then HTTP/WSS or TLS-wrapped NetGauge)
 *   GET/POST/HEAD/... SP   → HTTP (incl. WebSocket upgrade on /ws)
 *   anything else          → native NetGauge (plaintext), including the
 *                            official CLI's encrypted-binary hello which we
 *                            answer with ERROR to trigger its documented
 *                            plaintext fallback.
 */

import * as net from 'node:net';
import * as tls from 'node:tls';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { NetGaugeEngine, LossRegistry, NetGaugeSessionHooks } from './NetGaugeEngine';
import { UdpLossEngine } from './UdpLossEngine';
import { createRequestHandler, isHttpHead } from './HttpApi';

export interface ServerCoreOptions {
  tcpPorts: number[];
  udpPorts: number[];
  versionString: string; // NetGauge/HTTP version banner (interop profile default)
  tls?: { cert: Buffer; key: Buffer } | null;
  crossDomainPorts: string;
  evidenceLogPath?: string;
  maxConnections: number;
  maxConnectionsPerIp: number;
  idleTimeoutMs: number;
  onEvent?: (kind: string, detail: Record<string, unknown>) => void;
}

interface ConnStats {
  peer: string;
  openedAt: number;
  transport: 'tcp' | 'tls' | 'ws' | 'wss';
  bytesDown: number;
  bytesUp: number;
  commands: number;
}

export class ServerCore {
  private opts: ServerCoreOptions;
  private loss = new LossRegistry();
  private pool = crypto.randomBytes(2 * 1024 * 1024); // 2 MiB download pool (daemon parity)
  private instanceUuid = crypto.randomUUID().toUpperCase();
  private startedAt = Date.now();
  private listeners: net.Server[] = [];
  private udp: UdpLossEngine | null = null;
  private httpServer: http.Server;
  private httpsServer: http.Server;
  private wss: WebSocketServer;
  private evidence: fs.WriteStream | null = null;
  private conns = new Map<number, ConnStats>();
  private connSeq = 0;
  private running = false;
  /** Global evidence counters (read by the validation harness). */
  public readonly counters = {
    connectionsTotal: 0,
    netgaugeSessions: 0,
    httpRequests: 0,
    wsSessions: 0,
    udpReceived: 0,
    udpAnswered: 0,
    bytesDown: 0,
    bytesUp: 0,
  };

  constructor(opts: ServerCoreOptions) {
    this.opts = opts;
    if (opts.evidenceLogPath) {
      this.evidence = fs.createWriteStream(opts.evidenceLogPath, { flags: 'w' });
    }
    const handler = createRequestHandler({
      versionString: opts.versionString,
      pool: this.pool,
      crossDomainPorts: opts.crossDomainPorts,
      maxBodyBytes: 512 * 1024 * 1024,
      onEvent: (k, d) => {
        this.counters.httpRequests++;
        this.ev(k, d);
      },
    });
    this.httpServer = http.createServer(handler);
    this.httpsServer = opts.tls
      ? httpsServerWith(handler, opts.tls)
      : this.httpServer; // no TLS configured: plain only
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 5 * 1024 * 1024 });
    this.wss.on('connection', (ws, req) => this.handleWsConnection(ws, req));
    for (const srv of [this.httpServer, this.httpsServer]) {
      srv.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as net.Socket, head));
      srv.on('clientError', (err, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      });
    }
    const gc = setInterval(() => this.loss.gc(300000), 60000);
    gc.unref();
  }

  private ev(kind: string, detail: Record<string, unknown>): void {
    this.opts.onEvent?.(kind, detail);
    if (this.evidence) {
      this.evidence.write(JSON.stringify({ ts: Date.now(), k: kind, ...detail }) + '\n');
    }
  }

  async start(): Promise<void> {
    if (this.running) throw new Error('ServerCore already running');
    const binds: Promise<void>[] = [];
    for (const port of this.opts.tcpPorts) {
      binds.push(
        new Promise<void>((resolve, reject) => {
          const srv = net.createServer({ noDelay: true }, (sock) => this.onRawConnection(sock));
          srv.once('error', reject); // fail closed: bind errors are fatal (P0.1 fix)
          srv.listen(port, '::', () => {
            this.ev('listen_tcp', { port, family: 'dual-stack' });
            resolve();
          });
          this.listeners.push(srv);
        }),
      );
    }
    await Promise.all(binds); // rejects (and propagates) on ANY bind failure
    this.udp = new UdpLossEngine({
      ports: this.opts.udpPorts,
      loss: this.loss,
      maxDatagramBytes: 2048,
      onEvent: (k, d) => this.ev(k, d),
    });
    this.udp.start();
    for (const p of this.opts.udpPorts) this.ev('listen_udp', { port: p });
    this.running = true;
    this.ev('started', {
      tcpPorts: this.opts.tcpPorts,
      udpPorts: this.opts.udpPorts,
      version: this.opts.versionString,
      instance: this.instanceUuid,
      pid: process.pid,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.udp?.stop();
    await Promise.all(
      this.listeners.map(
        (l) => new Promise<void>((resolve) => l.close(() => resolve())),
      ),
    );
    this.listeners = [];
    this.wss.close();
    this.ev('stopped', { connections: this.counters.connectionsTotal });
    this.evidence?.end();
  }

  stats(): Record<string, unknown> {
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      instanceUuid: this.instanceUuid,
      version: this.opts.versionString,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      activeConnections: this.conns.size,
      counters: this.counters,
      lossSessions: this.loss.latest() ? 1 : 0,
    };
  }

  /* ---------------- TCP: protocol multiplexing ---------------- */

  private onRawConnection(sock: net.Socket): void {
    const id = ++this.connSeq;
    const peer = `${sock.remoteAddress || '?'}:${sock.remotePort || '?'}`;
    const peerIp = sock.remoteAddress || '?';
    this.counters.connectionsTotal++;
    if (this.conns.size >= this.opts.maxConnections) {
      this.ev('conn_rejected_max', { peer });
      sock.destroy();
      return;
    }
    const perIp = [...this.conns.values()].filter((c) => c.peer.startsWith(hostOf(peer))).length;
    if (perIp >= this.opts.maxConnectionsPerIp) {
      this.ev('conn_rejected_per_ip', { peer });
      sock.destroy();
      return;
    }
    sock.setNoDelay(true);
    sock.setTimeout(this.opts.idleTimeoutMs, () => {
      this.ev('conn_timeout', { id, peer });
      sock.destroy();
    });
    const onFirst = (chunk: Buffer): void => {
      sock.removeListener('data', onFirst);
      if (this.opts.tls && chunk.length > 0 && chunk[0] === 0x16) {
        this.startTls(sock, chunk, id, peer, peerIp);
        return;
      }
      if (isHttpHead(chunk)) {
        this.conns.set(id, { peer, openedAt: Date.now(), transport: 'tcp', bytesDown: 0, bytesUp: 0, commands: 0 });
        sock.unshift(chunk);
        this.httpServer.emit('connection', sock);
        this.ev('conn_http', { id, peer });
        return;
      }
      this.startNetGauge(sock, chunk, id, peer, peerIp, 'tcp');
    };
    sock.once('data', onFirst);
    sock.on('error', () => {
      /* teardown via close */
    });
    sock.on('close', () => {
      const c = this.conns.get(id);
      this.conns.delete(id);
      this.ev('conn_close', { id, peer, stats: c });
    });
  }

  private startTls(sock: net.Socket, firstChunk: Buffer, id: number, peer: string, peerIp: string): void {
    const tlsSock = new tls.TLSSocket(sock, {
      isServer: true,
      cert: this.opts.tls!.cert,
      key: this.opts.tls!.key,
      minVersion: 'TLSv1.2', // daemon parity: minimumTLSProtocol = 1.2
    });
    sock.unshift(firstChunk); // let the TLSSocket consume the ClientHello
    const onPlain = (chunk: Buffer): void => {
      tlsSock.removeListener('data', onPlain);
      if (isHttpHead(chunk)) {
        this.conns.set(id, { peer, openedAt: Date.now(), transport: 'tls', bytesDown: 0, bytesUp: 0, commands: 0 });
        tlsSock.unshift(chunk);
        this.httpsServer.emit('connection', tlsSock);
        this.ev('conn_https', { id, peer });
        return;
      }
      this.startNetGauge(tlsSock, chunk, id, peer, peerIp, 'tls');
    };
    tlsSock.once('data', onPlain);
    tlsSock.on('error', (e) => this.ev('tls_error', { id, peer, error: String(e) }));
  }

  /* ---------------- native NetGauge over a byte stream ---------------- */

  private startNetGauge(stream: Duplex, firstChunk: Buffer, id: number, peer: string, peerIp: string, transport: 'tcp' | 'tls'): void {
    this.counters.netgaugeSessions++;
    this.conns.set(id, { peer, openedAt: Date.now(), transport, bytesDown: 0, bytesUp: 0, commands: 0 });
    const connStats = this.conns.get(id)!;
    let closed = false;
    const hooks: NetGaugeSessionHooks = {
      write: (data) => {
        connStats.bytesDown += data.length;
        this.counters.bytesDown += data.length;
        return stream.write(data);
      },
      writeLine: (line) => {
        connStats.bytesDown += line.length + 1;
        this.counters.bytesDown += line.length + 1;
        return stream.write(line + '\n');
      },
      peerIp: () => peerIp,
      close: () => stream.end(),
      onEvent: (kind, detail) => this.ev('ng_' + kind, { id, peer, ...detail }),
    };
    const engine = new NetGaugeEngine(hooks, {
      versionString: this.opts.versionString,
      instanceUuid: this.instanceUuid,
      maxLineBytes: 1024 * 1024,
      maxDownloadBytes: 0x7fffffff,
      maxUploadBytes: 0x7fffffff,
      pool: this.pool,
      loss: this.loss,
      startedAt: this.startedAt,
    });
    stream.on('data', (c: Buffer) => {
      connStats.bytesUp += c.length;
      this.counters.bytesUp += c.length;
      connStats.commands = engine.counters.commands;
      engine.feed(c);
    });
    stream.on('drain', () => engine.notifyWritable());
    stream.on('close', () => {
      if (!closed) {
        closed = true;
        engine.destroy();
      }
    });
    stream.on('error', () => {
      if (!closed) {
        closed = true;
        engine.destroy();
      }
    });
    this.ev('conn_netgauge', { id, peer, transport });
    engine.feed(firstChunk);
  }

  /* ---------------- WebSocket upgrade ---------------- */

  private handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const path = (req.url || '/').split('?')[0];
    if (path === '/ws') {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
      return;
    }
    // Daemon parity: upgrade attempts on / are answered like a normal GET
    // (200 page); every other path 404s and closes.
    if (path === '/') {
      socket.write(
        'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n' +
          '<html><head><title>OoklaServer</title></head><body><h1>OoklaServer</h1><p>It worked!<br /></p></body></html>\n',
      );
      socket.end();
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.end();
    }
  }

  private handleWsConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const id = ++this.connSeq;
    const peer = `${req.socket.remoteAddress || '?'}:${req.socket.remotePort || '?'}`;
    const peerIp = req.socket.remoteAddress || '?';
    const secure = (req.socket as tls.TLSSocket).encrypted === true;
    this.counters.connectionsTotal++;
    this.counters.wsSessions++;
    this.conns.set(id, { peer, openedAt: Date.now(), transport: secure ? 'wss' : 'ws', bytesDown: 0, bytesUp: 0, commands: 0 });
    const connStats = this.conns.get(id)!;
    let closed = false;
    const send = (data: Buffer | string): boolean => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(data, { binary: typeof data !== 'string' });
      return true;
    };
    const hooks: NetGaugeSessionHooks = {
      write: (data) => {
        connStats.bytesDown += data.length;
        this.counters.bytesDown += data.length;
        return send(data);
      },
      writeLine: (line, noNewline) => {
        connStats.bytesDown += line.length + 1;
        this.counters.bytesDown += line.length + 1;
        // Observed daemon quirk (2026-11-03 z.ai capture, re-verified in our
        // lab): over WS the HELLO reply carries no trailing newline; other
        // replies do.
        const payload = line.startsWith('HELLO ') || noNewline ? line : line + '\n';
        return send(payload);
      },
      peerIp: () => peerIp,
      close: () => ws.close(),
      onEvent: (kind, detail) => this.ev('ng_' + kind, { id, peer, ws: true, ...detail }),
    };
    const engine = new NetGaugeEngine(hooks, {
      versionString: this.opts.versionString,
      instanceUuid: this.instanceUuid,
      maxLineBytes: 1024 * 1024,
      maxDownloadBytes: 0x7fffffff,
      maxUploadBytes: 0x7fffffff,
      pool: this.pool,
      loss: this.loss,
      startedAt: this.startedAt,
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      const buf = isBinary ? data : Buffer.from(data.toString('utf8'), 'utf8');
      connStats.bytesUp += buf.length;
      this.counters.bytesUp += buf.length;
      engine.feed(buf);
    });
    ws.on('close', () => {
      closed = true;
      engine.destroy();
      this.conns.delete(id);
      this.ev('conn_close', { id, peer, ws: true, stats: connStats });
    });
    ws.on('error', () => {
      closed = true;
      engine.destroy();
    });
    this.ev('conn_ws', { id, peer, secure });
  }
}

function hostOf(peer: string): string {
  return peer.replace(/:\d+$/, '');
}

import { ServerResponse } from 'node:http';
function httpsServerWith(
  handler: (req: http.IncomingMessage, res: ServerResponse) => void,
  tlsOpts: { cert: Buffer; key: Buffer },
): http.Server {
  // https.Server with the same handler; sockets are injected by the
  // multiplexer after TLS termination, so this server never binds.
  const srv = http.createServer(handler); // plaintext parser; TLS already terminated
  (srv as unknown as { tlsOpts?: unknown }).tlsOpts = tlsOpts;
  return srv;
}

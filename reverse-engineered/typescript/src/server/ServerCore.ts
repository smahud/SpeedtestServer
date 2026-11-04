/**
 * ServerCore — canonical listener architecture for SpeedtestServer.
 *
 * Fixes the P0 defects of the previous implementation:
 *   - ONE listener per TCP port with per-connection protocol multiplexing
 *     (TLS / HTTP / WebSocket / native NetGauge), exactly like the reference
 *     daemon's deployment model. No competing HTTP-vs-HTTPS listeners on the
 *     same port.
 *   - Bind failures are FATAL (fail closed) — TCP *and* UDP. The old code
 *     resolved the EADDRINUSE promise and logged "All servers started
 *     successfully"; UDP bind errors were silently swallowed.
 *   - Runs unprivileged (no /var/lock, /etc/ooklaserver requirements).
 *
 * Transport detection per connection (first bytes):
 *   0x16 0x03 ...          → TLS (then HTTP/WSS or TLS-wrapped NetGauge)
 *   GET/POST/HEAD/... SP   → HTTP (incl. WebSocket upgrade on /ws)
 *   anything else          → native NetGauge (plaintext), including the
 *                            official CLI's encrypted-binary hello which we
 *                            answer with ERROR to trigger its documented
 *                            plaintext fallback.
 *
 * Revision-3 verified behaviors:
 *   - instanceUuid is LOWER-CASE (daemon parity, F-8).
 *   - the download pool is printable ASCII [0x20..0x7F] (daemon charset, F-9).
 *   - per-IP connection limits use exact IP matching (the old prefix string
 *     match counted 1.2.3.45 against the 1.2.3.4 limit).
 *   - the evidence WriteStream is error-watched and fully flushed on stop().
 *   - WebSocket sessions process ONE command per frame and answer QUIT with
 *     ERROR (daemon parity, F-13/F-14).
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

export interface TlsHostInfo {
  /** Certificate SAN hostnames — the HTTP Host allow-list (F-16). */
  allowedHosts: string[];
  /** Certificate CN — the 307 redirect target host. */
  certPrimaryHost: string;
}

export interface ServerCoreOptions {
  tcpPorts: number[];
  udpPorts: number[];
  versionString: string; // NetGauge/HTTP version banner (interop profile default)
  tls?: { cert: Buffer | string; key: Buffer | string } | null;
  /** Minimum TLS protocol ('TLSv1'|'TLSv1.1'|'TLSv1.2'|'TLSv1.3'); maps
   *  openSSL.server.minimumTLSProtocol (daemon default: 1.2). */
  tlsMinVersion?: tls.SecureVersion;
  crossDomainPorts: string;
  evidenceLogPath?: string;
  maxConnections: number;
  maxConnectionsPerIp: number;
  idleTimeoutMs: number;
  /** OoklaServer.allowedDomains — drives the CSP connect-src header. */
  allowedDomains: string[];
  /** OoklaServer.excludeDefaultDomains. */
  excludeDefaultDomains: boolean;
  onEvent?: (kind: string, detail: Record<string, unknown>) => void;
}

interface ConnStats {
  peer: string;
  peerIp: string;
  openedAt: number;
  transport: 'tcp' | 'tls' | 'ws' | 'wss';
  bytesDown: number;
  bytesUp: number;
  commands: number;
}

/** Parse certificate hostnames for the Host-validation allow-list (F-16). */
export function parseTlsHostInfo(cert: Buffer | string): TlsHostInfo {
  const allowedHosts: string[] = [];
  let certPrimaryHost = 'localhost';
  try {
    const x509 = new crypto.X509Certificate(
      typeof cert === 'string' ? cert : Buffer.from(cert).toString('utf8'),
    );
    // CN from the subject ("CN=x\nO=y" — take the CN entry).
    const cnMatch = x509.subject.match(/(?:^|\n)CN=([^\n]+)/);
    if (cnMatch) certPrimaryHost = cnMatch[1].trim();
    // SANs: Node renders "DNS: a, IP Address: b" (also "IP: b" on some lines).
    const san = x509.subjectAltName || '';
    for (const part of san.split(',')) {
      const entry = part.trim();
      const dns = entry.match(/^DNS:\s*(.+)$/i);
      const ip = entry.match(/^IP(?:\s*Address)?:\s*(.+)$/i);
      if (dns) allowedHosts.push(dns[1].trim());
      else if (ip) allowedHosts.push(ip[1].trim());
    }
  } catch {
    // Unparseable material: fall back to the dev defaults.
  }
  if (allowedHosts.length === 0) allowedHosts.push('localhost', '127.0.0.1');
  return { allowedHosts, certPrimaryHost };
}

/** 2 MiB download pool of printable-ASCII random data [0x20..0x7F]
 *  (daemon charset, verified F-9). */
export function generateAsciiPool(size: number): Buffer {
  const pool = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) {
    pool[i] = 0x20 + (Math.random() * 96) | 0; // 0x20..0x7F inclusive
  }
  return pool;
}

export class ServerCore {
  private opts: ServerCoreOptions;
  /** Current TLS material — swappable at runtime via reloadTls (§9.7). */
  private tlsMaterial: { cert: Buffer | string; key: Buffer | string } | null;
  /** Certificate host info (mutable: refreshed by reloadTls). */
  public readonly hostInfo: TlsHostInfo;
  private loss = new LossRegistry();
  private pool = generateAsciiPool(2 * 1024 * 1024); // 2 MiB ASCII pool (daemon parity)
  private instanceUuid = crypto.randomUUID(); // LOWER-CASE (daemon parity, F-8)
  private startedAt = Date.now();
  private listeners: net.Server[] = [];
  private udp: UdpLossEngine | null = null;
  private httpServer: http.Server;
  private httpsServer: http.Server;
  private wss: WebSocketServer;
  private evidence: fs.WriteStream | null = null;
  private conns = new Map<number, ConnStats>();
  /** Exact per-IP connection counts (fixes the old string-prefix match). */
  private perIp = new Map<string, number>();
  private connSeq = 0;
  private running = false;
  private gcTimer: NodeJS.Timeout | null = null;
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
    this.tlsMaterial = opts.tls ?? null;
    this.hostInfo = parseTlsHostInfo(opts.tls ? opts.tls.cert : 'localhost');
    if (opts.evidenceLogPath) {
      this.evidence = fs.createWriteStream(opts.evidenceLogPath, { flags: 'w' });
      // Fail fast + loudly: an unusable evidence sink must not crash the
      // process mid-run as an unhandled 'error' event (audit channel).
      this.evidence.on('error', (err) => {
        process.stderr.write(
          `evidence log write failed (${opts.evidenceLogPath}): ${err instanceof Error ? err.message : String(err)}\n`,
        );
        this.evidence?.destroy();
        this.evidence = null; // degrade gracefully: keep serving, stop logging
      });
    }
    const handler = createRequestHandler({
      versionString: opts.versionString,
      pool: this.pool,
      crossDomainPorts: opts.crossDomainPorts,
      maxBodyBytes: 512 * 1024 * 1024,
      hostInfo: this.hostInfo, // mutable: reloadTls refreshes the allow-list
      allowedDomains: opts.allowedDomains,
      excludeDefaultDomains: opts.excludeDefaultDomains,
      onEvent: (k, d) => {
        this.counters.httpRequests++;
        this.ev(k, d);
      },
    });
    this.httpServer = http.createServer(handler);
    this.httpsServer = opts.tls
      ? httpsServerWith(handler, opts.tls)
      : this.httpServer; // no TLS configured: plain only
    for (const srv of [this.httpServer, this.httpsServer]) {
      srv.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as net.Socket, head));
      srv.on('clientError', (err, socket) => {
        // Daemon parity: parser-level rejections (e.g. a missing Host header
        // on HTTP/1.1) produce the minimal 500, not Node's default 400.
        void err;
        if (socket.writable) socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: Close\r\n\r\n');
        socket.destroy();
      });
    }
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 5 * 1024 * 1024 });
    this.wss.on('connection', (ws, req) => this.handleWsConnection(ws, req));
    this.gcTimer = setInterval(() => this.loss.gc(300000), 60000);
    this.gcTimer.unref();
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
    // UDP binds are equally fatal (fail closed — the old code swallowed them).
    this.udp = new UdpLossEngine({
      ports: this.opts.udpPorts,
      loss: this.loss,
      maxDatagramBytes: 2048,
      onEvent: (k, d) => this.ev(k, d),
    });
    await this.udp.start();
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
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    this.udp?.stop();
    await Promise.all(
      this.listeners.map(
        (l) => new Promise<void>((resolve) => l.close(() => resolve())),
      ),
    );
    this.listeners = [];
    this.wss.close();
    // Close the injected-socket HTTP servers too (they never bind, but
    // closing them waits for in-flight requests and releases the handles).
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
    if (this.httpsServer !== this.httpServer) {
      await new Promise<void>((resolve) => this.httpsServer.close(() => resolve()));
    }
    this.ev('stopped', { connections: this.counters.connectionsTotal });
    // Fully flush the evidence log before the caller exits the process —
    // the old fire-and-forget end() lost the final buffered records.
    if (this.evidence) {
      const stream = this.evidence;
      this.evidence = null;
      await new Promise<void>((resolve) => {
        stream.end(() => resolve());
        stream.on('close', () => resolve());
      });
    }
  }

  /**
   * §9.7 — hot certificate reload. Validates the new pair (createSecureContext)
   * BEFORE swapping; on failure keeps the last valid material (never serves a
   * broken certificate). New connections use the new material; established
   * connections are unaffected. No restart, no port re-bind. The Host
   * validation allow-list is refreshed from the new certificate (F-16).
   */
  reloadTls(cert: Buffer | string, key: Buffer | string): { ok: boolean; error?: string } {
    if (!this.tlsMaterial) {
      return { ok: false, error: 'TLS not enabled on this server' };
    }
    try {
      tls.createSecureContext({ cert: cert.toString(), key: key.toString() });
    } catch (error) {
      const msg = `TLS reload rejected (keeping last valid certificate): ${error instanceof Error ? error.message : String(error)}`;
      this.ev('tls_reload_failed', { error: msg });
      return { ok: false, error: msg };
    }
    this.tlsMaterial = { cert, key };
    const info = parseTlsHostInfo(cert);
    this.hostInfo.allowedHosts.splice(0, this.hostInfo.allowedHosts.length, ...info.allowedHosts);
    this.hostInfo.certPrimaryHost = info.certPrimaryHost;
    this.ev('tls_reloaded', {
      fingerprint: new crypto.X509Certificate(cert.toString()).fingerprint256,
    });
    return { ok: true };
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
    // Exact per-IP accounting (fixes the prefix-string match that counted
    // 1.2.3.45 against the 1.2.3.4 limit).
    const ipKey = peerIp;
    const perIpCount = this.perIp.get(ipKey) ?? 0;
    if (perIpCount >= this.opts.maxConnectionsPerIp) {
      this.ev('conn_rejected_per_ip', { peer, ip: ipKey, count: perIpCount });
      sock.destroy();
      return;
    }
    this.perIp.set(ipKey, perIpCount + 1);
    sock.setNoDelay(true);
    sock.setTimeout(this.opts.idleTimeoutMs, () => {
      this.ev('conn_timeout', { id, peer });
      sock.destroy();
    });
    const onFirst = (chunk: Buffer): void => {
      sock.removeListener('data', onFirst);
      if (this.tlsMaterial && chunk.length > 0 && chunk[0] === 0x16) {
        this.startTls(sock, chunk, id, peer, peerIp);
        return;
      }
      if (isHttpHead(chunk)) {
        this.routeHttp(this.httpServer, sock, chunk, id, peer, peerIp, 'tcp');
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
      const n = this.perIp.get(ipKey) ?? 1;
      if (n <= 1) this.perIp.delete(ipKey);
      else this.perIp.set(ipKey, n - 1);
      this.ev('conn_close', { id, peer, stats: c });
    });
  }

  private startTls(sock: net.Socket, firstChunk: Buffer, id: number, peer: string, peerIp: string): void {
    const tlsSock = new tls.TLSSocket(sock, {
      isServer: true,
      cert: this.tlsMaterial ? this.tlsMaterial.cert : undefined,
      key: this.tlsMaterial ? this.tlsMaterial.key : undefined,
      // daemon parity: openSSL.server.minimumTLSProtocol (default 1.2)
      minVersion: this.opts.tlsMinVersion || ("TLSv1.2" as tls.SecureVersion),
    });
    sock.unshift(firstChunk); // let the TLSSocket consume the ClientHello
    const onPlain = (chunk: Buffer): void => {
      tlsSock.removeListener('data', onPlain);
      if (isHttpHead(chunk)) {
        this.routeHttp(this.httpsServer, tlsSock, chunk, id, peer, peerIp, 'tls');
        return;
      }
      this.startNetGauge(tlsSock, chunk, id, peer, peerIp, 'tls');
    };
    tlsSock.once('data', onPlain);
    tlsSock.on('error', (e) => this.ev('tls_error', { id, peer, error: String(e) }));
  }

  /* ---------------- HTTP routing with Host-header enforcement ---------------- */

  /**
   * Route a detected HTTP connection into the parser — with the daemon's
   * missing-Host rejection (verified F-17). Node's own parser answers a
   * Host-less HTTP/1.1 request with its own 400 BEFORE any handler runs, so
   * the multiplexer buffers until the header block is complete and enforces
   * the daemon's minimal 500 itself.
   */
  private routeHttp(
    server: http.Server,
    sock: Duplex,
    firstChunk: Buffer,
    id: number,
    peer: string,
    peerIp: string,
    transport: 'tcp' | 'tls',
  ): void {
    this.conns.set(id, { peer, peerIp, openedAt: Date.now(), transport, bytesDown: 0, bytesUp: 0, commands: 0 });
    const chunks: Buffer[] = [firstChunk];
    let total = firstChunk.length;
    const CAP = 65536;
    const attempt = (): 'route' | 'wait' | 'reject' => {
      const buf = Buffer.concat(chunks);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) {
        return total > CAP ? 'route' : 'wait'; // let Node enforce its own limits
      }
      const firstLineEnd = buf.indexOf('\r\n');
      const headerRegion = buf.subarray(firstLineEnd + 2, end + 2);
      if (!/^Host:/im.test(headerRegion.toString('latin1'))) {
        this.ev('http_reject', { reason: 'missing_host', id, peer });
        sock.write('HTTP/1.1 500 Internal Server Error\r\nConnection: Close\r\n\r\n');
        sock.destroy();
        return 'reject';
      }
      sock.unshift(buf);
      server.emit('connection', sock);
      this.ev(transport === 'tcp' ? 'conn_http' : 'conn_https', { id, peer });
      return 'route';
    };
    const first = attempt();
    if (first !== 'wait') return;
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      total += chunk.length;
      const r = attempt();
      if (r === 'wait') return;
      sock.removeListener('data', onData);
    };
    sock.on('data', onData);
  }

  /* ---------------- native NetGauge over a byte stream ---------------- */

  private startNetGauge(stream: Duplex, firstChunk: Buffer, id: number, peer: string, peerIp: string, transport: 'tcp' | 'tls'): void {
    this.counters.netgaugeSessions++;
    this.conns.set(id, { peer, peerIp, openedAt: Date.now(), transport, bytesDown: 0, bytesUp: 0, commands: 0 });
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
      quitMode: 'close',
      errorStrikeLimit: 3, // verified F-24: TCP "three strikes" closes the connection
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
    this.conns.set(id, { peer, peerIp, openedAt: Date.now(), transport: secure ? 'wss' : 'ws', bytesDown: 0, bytesUp: 0, commands: 0 });
    const connStats = this.conns.get(id)!;
    const perIpCount = this.perIp.get(peerIp) ?? 0;
    this.perIp.set(peerIp, perIpCount + 1);
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
      quitMode: 'error', // verified F-14: QUIT over WS answers ERROR (no close)
      errorStrikeLimit: 0, // verified F-24: the "three strikes" rule does NOT apply over WebSocket
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      const buf = isBinary ? data : Buffer.from(data.toString('utf8'), 'utf8');
      connStats.bytesUp += buf.length;
      this.counters.bytesUp += buf.length;
      // Verified F-13: the daemon processes (at most) the FIRST command of
      // each WS frame and discards the rest — e.g. a "HI\nGETIP\n" frame
      // yields exactly one HELLO. Upload payload frames are exempt.
      const payload = engine.isIdle ? firstCommandLine(buf) : buf;
      engine.feed(payload);
    });
    ws.on('close', () => {
      engine.destroy();
      this.conns.delete(id);
      const n = this.perIp.get(peerIp) ?? 1;
      if (n <= 1) this.perIp.delete(peerIp);
      else this.perIp.set(peerIp, n - 1);
      this.ev('conn_close', { id, peer, ws: true, stats: connStats });
    });
    ws.on('error', () => {
      engine.destroy();
    });
    this.ev('conn_ws', { id, peer, secure });
  }
}

/** First command line of a WS frame (inclusive newline). Frames with NO
 *  newline are still one complete command (verified F-13: a bare "HI" frame
 *  gets its HELLO), so a newline is synthesized for the line-based engine. */
function firstCommandLine(buf: Buffer): Buffer {
  const nl = buf.indexOf(0x0a);
  if (nl === -1) return Buffer.concat([buf, Buffer.from('\n')]);
  return buf.subarray(0, nl + 1);
}

import { ServerResponse } from 'node:http';
function httpsServerWith(
  handler: (req: http.IncomingMessage, res: ServerResponse) => void,
  tlsOpts: { cert: Buffer | string; key: Buffer | string },
): http.Server {
  // https.Server with the same handler; sockets are injected by the
  // multiplexer after TLS termination, so this server never binds.
  const srv = http.createServer(handler); // plaintext parser; TLS already terminated
  (srv as unknown as { tlsOpts?: unknown }).tlsOpts = tlsOpts;
  return srv;
}

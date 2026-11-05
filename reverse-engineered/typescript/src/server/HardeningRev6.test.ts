/**
 * HardeningRev6 — regression tests for the revision-6 security/reliability
 * fixes (master prompt v8.0 §6 audit, verified by bounded reproduction
 * probes on 2026-11-05; see validation/FINDINGS.md F-31…F-36):
 *
 *   F-31 global connection limit must count pre-protocol (silent),
 *        mid-TLS and mid-upgrade sockets — not just routed connections
 *   F-32 a WebSocket session is ONE TCP connection: one conns entry, one
 *        per-IP slot, one connectionsTotal tick (no double counting)
 *   F-33 LossRegistry bounds: per-source-IP cap (64) + global cap (2048)
 *        with least-recently-seen eviction; CLI LOSS/RECV contract intact
 *   F-34 a rejected start() (EADDRINUSE on one port) leaves NO orphaned
 *        listeners on the other ports
 *   F-35 stop() is bounded (shutdownGraceMs): in-flight uploads get the
 *        grace window, then everything is force-destroyed
 *   F-36 a stalled evidence sink degrades evidence logging to OFF past the
 *        backlog cap; the measurement service keeps serving
 *   §6.7 malformed request lines and partial TLS handshakes leave the
 *        server responsive with correct accounting
 */
import * as net from 'node:net';
import * as dgram from 'node:dgram';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { ServerCore } from './ServerCore';
import { LossRegistry } from './NetGaugeEngine';
import { WebSocket } from 'ws';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
jest.setTimeout(25000);

/** Random high port. */
function freePort(): number {
  return 25000 + Math.floor(Math.random() * 20000);
}

function coreOpts(port: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tcpPorts: [port],
    udpPorts: [] as number[],
    versionString: '2.11 (2.11.5) 2026-06-04.1737.7d0993d',
    tls: null,
    crossDomainPorts: String(port),
    maxConnections: 100,
    maxConnectionsPerIp: 50,
    idleTimeoutMs: 30000,
    allowedDomains: ['*'],
    excludeDefaultDomains: false,
    ...extra,
  };
}

/** Connect and stay silent; resolves once connection state settles. */
function silentConnect(port: number, settleMs = 250): Promise<{ alive: boolean; sock: net.Socket }> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let alive = true;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve({ alive, sock });
    };
    const t = setTimeout(finish, settleMs);
    sock.on('close', () => { alive = false; finish(); });
    sock.on('error', () => { alive = false; finish(); });
  });
}

/** One request/response round trip; destroys the socket afterwards. */
function rawRequest(port: number, req: string, waitMs = 900): Promise<{ data: Buffer; closed: boolean; error?: Error }> {
  return new Promise((resolve) => {
    let data = Buffer.alloc(0);
    let closed = false;
    let lastError: Error | undefined;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try { sock.destroy(); } catch { /* noop */ }
      resolve({ data, closed, error: lastError });
    };
    let t: NodeJS.Timeout;
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.write(req);
      t = setTimeout(finish, waitMs);
    });
    sock.on('data', (d) => (data = Buffer.concat([data, d])));
    sock.on('close', () => { closed = true; finish(); });
    sock.on('error', (e) => { lastError = e; finish(); });
  });
}

/** Attempt to connect; resolves whether the port was accepting. */
function portAccepting(port: number, timeoutMs = 600): Promise<{ accepted: boolean; refused: boolean }> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let accepted = false;
    let refused = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try { sock.destroy(); } catch { /* noop */ }
      resolve({ accepted, refused });
    };
    const t = setTimeout(finish, timeoutMs);
    sock.on('connect', () => { accepted = true; finish(); });
    sock.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ECONNREFUSED') refused = true;
      finish();
    });
  });
}

const uuid = (i: number): string =>
  `${i.toString(16).padStart(8, '0')}-1111-4222-8333-444455556666`.slice(0, 36);

/* ================= F-31: global limit counts silent sockets ================= */

describe('F-31 — global connection limit counts pre-protocol sockets', () => {
  test('silent sockets consume the global limit; data connection refused past it', async () => {
    const port = freePort();
    const core = new ServerCore(coreOpts(port, { maxConnections: 3, maxConnectionsPerIp: 100 }) as never);
    await core.start();
    try {
      const silent: net.Socket[] = [];
      for (let i = 0; i < 6; i++) {
        const { alive, sock } = await silentConnect(port);
        expect(alive).toBe(i < 3); // sockets 4..6 must be rejected immediately
        if (alive) silent.push(sock);
        else sock.destroy();
      }
      expect(core.stats().activeConnections).toBe(3);
      // a NEW data-sending connection is refused: no PONG (limit full)
      const r = await rawRequest(port, 'PING 1\n', 600);
      expect(r.data.toString('latin1')).not.toMatch(/^PONG/);
      // release capacity → a fresh connection is served again
      silent.forEach((s) => s.destroy());
      await sleep(300);
      expect(core.stats().activeConnections).toBe(0);
      const ok = await rawRequest(port, 'PING 1\n');
      expect(ok.data.toString('latin1')).toMatch(/^PONG \d+\n$/);
    } finally {
      await core.stop();
    }
  });
});

/* ================= F-32: WS sessions are not double counted ================= */

describe('F-32 — WebSocket sessions count once (no double accounting)', () => {
  test('one live WS session → 1 active connection, 1 connectionsTotal, 1 wsSession', async () => {
    const port = freePort();
    const core = new ServerCore(coreOpts(port) as never);
    await core.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    try {
      await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej); });
      ws.send('HI');
      await sleep(300);
      const st = core.stats();
      expect(st.activeConnections).toBe(1);
      expect((st.counters as Record<string, number>).connectionsTotal).toBe(1);
      expect((st.counters as Record<string, number>).wsSessions).toBe(1);
      // closing releases the single slot
      await new Promise<void>((res) => { ws.once('close', res); ws.close(); });
      await sleep(300);
      expect(core.stats().activeConnections).toBe(0);
    } finally {
      ws.terminate();
      await core.stop();
    }
  });

  test('two WS sessions fit under maxConnections=2 (pre-fix the first alone exhausted it)', async () => {
    const port = freePort();
    const core = new ServerCore(coreOpts(port, { maxConnections: 2, maxConnectionsPerIp: 10 }) as never);
    await core.start();
    const wss: WebSocket[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej); });
        ws.send('HI');
        wss.push(ws);
      }
      await sleep(400);
      // both sessions got their HELLO and both are served
      expect(core.stats().activeConnections).toBe(2);
      const third = await new Promise<WebSocket | null>((res) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        const t = setTimeout(() => res(ws), 1500);
        ws.on('error', () => { clearTimeout(t); res(null); });
        ws.on('close', () => { clearTimeout(t); res(null); });
      });
      expect(third).toBeNull(); // limit reached — upgrade path refused
    } finally {
      wss.forEach((w) => w.terminate());
      await core.stop();
    }
  });
});

/* ================= F-33: LossRegistry bounds ================= */

describe('F-33 — LossRegistry bounded session management', () => {
  test('distinct-UUID flood from one IP is capped per-IP and globally', () => {
    const reg = new LossRegistry();
    for (let i = 0; i < 5000; i++) reg.ensure(uuid(i), '203.0.113.9');
    expect(reg.size()).toBeLessThanOrEqual(2048); // global cap
    expect(reg.sizeForIp('203.0.113.9')).toBeLessThanOrEqual(64); // per-IP cap
  });

  test('a flood from one IP does not crowd out other clients (fairness)', () => {
    const reg = new LossRegistry();
    for (let i = 0; i < 3000; i++) reg.ensure(uuid(i), '203.0.113.9');
    // a DIFFERENT client registers after the flood and stays queryable
    const fresh = 'aaaaaaaa-1111-4222-8333-444455556666';
    reg.ensure(fresh, '198.51.100.7');
    expect(reg.get(fresh)).toBeDefined();
    expect(reg.sizeForIp('198.51.100.7')).toBe(1);
    // and its packet-loss accounting works (CLI contract preserved)
    const reply = reg.recordLoss(fresh, '198.51.100.7', 1, '1234');
    expect(reply).toBe('RECV 1 1234 [1 1 0]');
    expect(reg.recordLoss(fresh, '198.51.100.7', 1, '1235')).toBe('RECV 1 1235 [2 1 1]'); // dupe counted
    // anti-spoof preserved: datagrams from a different IP for a known UUID are dropped
    expect(reg.recordLoss(fresh, '203.0.113.9', 2, '9')).toBeNull();
    // 4-field init form: counted, not answered
    expect(reg.recordLoss('bbbbbbbb-1111-4222-8333-444455556666', '198.51.100.8', 5)).toBeNull();
  });

  test('gc() removes idle sessions and keeps per-IP bookkeeping consistent', async () => {
    const reg = new LossRegistry();
    reg.ensure(uuid(1), '203.0.113.10');
    reg.ensure(uuid(2), '203.0.113.10');
    expect(reg.sizeForIp('203.0.113.10')).toBe(2);
    await sleep(5); // lastSeen is millisecond-resolution
    reg.gc(1); // everything is now idle longer than 1ms
    expect(reg.size()).toBe(0);
    expect(reg.sizeForIp('203.0.113.10')).toBe(0);
  });

  test('UDP LOSS burst through the engine stays bounded (integration)', async () => {
    const port = freePort();
    const core = new ServerCore(coreOpts(port, { udpPorts: [port] }) as never);
    await core.start();
    try {
      const sock = dgram.createSocket('udp4');
      const line = (u: string, seq: number) => Buffer.from(`LOSS 12345 ${seq} ${u}\n`);
      for (let i = 0; i < 5000; i++) {
        sock.send(line(uuid(i), 1), port, '127.0.0.1');
        if (i % 500 === 499) await sleep(10); // let the socket breathe
      }
      await sleep(400);
      sock.close();
      const reg = (core as unknown as { loss: LossRegistry }).loss;
      expect(reg.size()).toBeLessThanOrEqual(2048);
      // a legitimate measurement still works after the flood (5-field
      // loaded-latency form: LOSS <timer> <seq> <uuid> <timer>)
      const cli = 'cccccccc-1111-4222-8333-444455556666';
      const c2 = dgram.createSocket('udp4');
      const reply = await new Promise<string>((res) => {
        c2.once('message', (m) => res(m.toString('latin1')));
        c2.send(Buffer.from(`LOSS 100 111 ${cli} 2222\n`), port, '127.0.0.1');
        setTimeout(() => res(''), 1500);
      });
      c2.close();
      expect(reply).toMatch(/^RECV 111 2222 \[\d+ 111 0\]/);
    } finally {
      await core.stop();
    }
  });
});

/* ================= F-34: failed startup leaves no orphans ================= */

describe('F-34 — failed startup closes every partially-bound listener', () => {
  test('EADDRINUSE on one port → start() rejects AND the other port is closed', async () => {
    const portA = freePort();
    const portB = freePort();
    const squatter = net.createServer();
    await new Promise<void>((res) => squatter.listen(portA, '127.0.0.1', res));
    try {
      const core = new ServerCore(coreOpts(portA, { tcpPorts: [portA, portB] }) as never);
      await expect(core.start()).rejects.toThrow();
      const b = await portAccepting(portB);
      expect(b.accepted).toBe(false); // no orphaned listener on the OTHER port
      // the core is reusable after a failed start (no stale state)
      const portC = freePort();
      (core as unknown as { opts: { tcpPorts: number[] } }).opts.tcpPorts = [portC];
      await core.start();
      const r = await rawRequest(portC, 'PING 1\n');
      expect(r.data.toString('latin1')).toMatch(/^PONG \d+\n$/);
      await core.stop();
    } finally {
      squatter.close();
    }
  });

  test('UDP bind failure after successful TCP binds leaves no TCP orphans', async () => {
    const portA = freePort();
    const udpTaken = freePort();
    const squatter: dgram.Socket = await new Promise((res) => {
      const s = dgram.createSocket('udp4');
      s.bind(udpTaken, '127.0.0.1', () => res(s));
    });
    try {
      const core = new ServerCore(coreOpts(portA, { tcpPorts: [portA], udpPorts: [udpTaken] }) as never);
      await expect(core.start()).rejects.toThrow();
      const a = await portAccepting(portA);
      expect(a.accepted).toBe(false); // TCP listener closed after the UDP failure
    } finally {
      squatter.close();
    }
  });
});

/* ================= F-35: bounded graceful shutdown ================= */

describe('F-35 — stop() completes within the shutdown grace bound', () => {
  test('in-flight trickle upload: stop() resolves at the bound and destroys the socket', async () => {
    const port = freePort();
    const core = new ServerCore(coreOpts(port, { shutdownGraceMs: 1200 }) as never);
    await core.start();
    const up = net.connect({ host: '127.0.0.1', port }, () => {
      up.write(`POST /speedtest/upload.php HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\nContent-Length: 1000000\r\n\r\n`);
      up.write('1234567890'); // trickled — request never completes
    });
    let upClosed = false;
    up.on('close', () => { upClosed = true; });
    await sleep(300);
    const t0 = Date.now();
    await core.stop(); // must resolve ≈ grace, not hang
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(5000);
    expect(elapsed).toBeGreaterThanOrEqual(1000); // it really waited the grace window
    await sleep(200);
    expect(upClosed).toBe(true); // lingering in-flight connection force-destroyed
    const after = await portAccepting(port);
    expect(after.accepted).toBe(false); // no longer accepting
  });

  test('idle NetGauge connection and open WS session are closed by stop()', async () => {
    const port = freePort();
    const core = new ServerCore(coreOpts(port, { shutdownGraceMs: 1200 }) as never);
    await core.start();
    const ng = net.connect({ host: '127.0.0.1', port }, () => ng.write('PING 1\n'));
    // consume the PONG: without a data listener the socket stays paused, the
    // server's FIN is never read and 'close' would never fire client-side.
    ng.on('data', () => { /* drain */ });
    let ngClosed = false;
    ng.on('close', () => { ngClosed = true; });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.send('HI');
    await sleep(300);
    await core.stop();
    await sleep(300);
    expect(ngClosed).toBe(true);
    expect(core.stats().activeConnections).toBe(0);
    ws.terminate();
  });
});

/* ================= F-36: evidence backlog cap ================= */

describe('F-36 — stalled evidence sink degrades to OFF past the backlog cap', () => {
  test('unread FIFO sink: cap reached → evidence off, server keeps serving', async () => {
    const fifo = path.join(os.tmpdir(), `f36evi-${process.pid}.fifo`);
    try { fs.unlinkSync(fifo); } catch { /* not present */ }
    execSync(`mkfifo ${JSON.stringify(fifo)}`);
    const port = freePort();
    const core = new ServerCore(coreOpts(port, { evidenceLogPath: fifo, evidenceMaxBacklogBytes: 64 * 1024 }) as never);
    await core.start();
    try {
      const sock = net.connect({ host: '127.0.0.1', port });
      sock.on('error', () => { /* ignore */ });
      await sleep(150);
      for (let i = 0; i < 1500; i++) sock.write(`PING ${i}\n`); // ~130KB of evidence lines
      await sleep(800);
      const ev = (core as unknown as { evidence: fs.WriteStream | null }).evidence;
      expect(ev).toBeNull(); // degraded to OFF past the 64KB cap
      const alive = await rawRequest(port, 'PING 1\n');
      expect(alive.data.toString('latin1')).toMatch(/^PONG \d+\n$/); // service unaffected
      sock.destroy();
    } finally {
      await core.stop();
      // Unblock the kernel: a pending open(2) on an unread FIFO parks a
      // threadpool worker and keeps the whole process from exiting (Node
      // runtime behavior, verified — not a server defect). Briefly opening
      // the read end releases it.
      try { const rfd = fs.openSync(fifo, 'r'); fs.closeSync(rfd); } catch { /* gone */ }
      try { fs.unlinkSync(fifo); } catch { /* gone */ }
    }
  });
});

/* ================= F-37: Origin "null" under default wildcard ================= */

describe('F-37 — Origin "null" is never reflected, even under allowedDomains=["*"]', () => {
  test('unit: originAllowed("null", ["*"]) is false; real origins still allowed', async () => {
    const { originAllowed } = await import('./HttpApi');
    expect(originAllowed('null', ['*'], false)).toBe(false); // daemon parity: never reflect "null"
    expect(originAllowed('null', ['*.example.org'], false)).toBe(false);
    expect(originAllowed('https://example.com', ['*'], false)).toBe(true); // wildcard still allows real origins
    expect(originAllowed('https://foo.example.org', ['*.example.org'], false)).toBe(true);
  });

  test('wire: GET /hi with Origin: null carries NO Access-Control-Allow-Origin (default config)', async () => {
    const port = freePort();
    const core = new ServerCore(coreOpts(port) as never);
    await core.start();
    try {
      const r = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: localhost\r\nUser-Agent: t\r\nOrigin: null\r\nConnection: close\r\n\r\n`);
      const s = r.data.toString('latin1');
      expect(s).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
      expect(s).not.toContain('Access-Control-Allow-Origin');
      // and a REAL origin IS reflected under the default wildcard
      const r2 = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: localhost\r\nUser-Agent: t\r\nOrigin: https://example.com\r\nConnection: close\r\n\r\n`);
      expect(r2.data.toString('latin1')).toContain('Access-Control-Allow-Origin: https://example.com');
    } finally {
      await core.stop();
    }
  });
});

/* ================= §6.7: malformed input hardening ================= */

describe('§6.7 — malformed request line / partial TLS handshake leave the server responsive', () => {
  test('unparseable HTTP version → parser rejection (minimal 500), server alive', async () => {
    const port = freePort();
    const core = new ServerCore(coreOpts(port) as never);
    await core.start();
    try {
      // HTTP-shaped (method+space) but invalid protocol version: routes to
      // Node's HTTP parser, which rejects it → clientError → minimal 500.
      const r = await rawRequest(port, 'GET /hi FAKEPROTO/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\n\r\n');
      expect(r.data.toString('latin1')).toBe('HTTP/1.1 500 Internal Server Error\r\nConnection: Close\r\n\r\n');
      const alive = await rawRequest(port, 'PING 0\n');
      expect(alive.data.toString('latin1')).toMatch(/^PONG \d+\n$/);
      await sleep(200);
      expect(core.stats().activeConnections).toBe(0); // accounting cleaned up
    } finally {
      await core.stop();
    }
  });

  test('non-HTTP garbage line → NetGauge ERROR replies (daemon-parity routing), server alive', async () => {
    const port = freePort();
    const core = new ServerCore(coreOpts(port) as never);
    await core.start();
    try {
      // A first line that is NOT an HTTP method goes to the NetGauge engine
      // (verified multiplexer contract — same as the reference daemon).
      const r = await rawRequest(port, 'NONSENSE\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\n\r\n');
      expect(r.data.toString('latin1')).toMatch(/^ERROR\n/);
      const alive = await rawRequest(port, 'PING 0\n');
      expect(alive.data.toString('latin1')).toMatch(/^PONG \d+\n$/);
    } finally {
      await core.stop();
    }
  });

  test('partial TLS ClientHello then abrupt close: no crash, accounting released', async () => {
    const port = freePort();
    const core = new ServerCore(coreOpts(port) as never);
    await core.start();
    try {
      const sock = net.connect({ host: '127.0.0.1', port }, () => {
        // TLS record header + truncated handshake body
        sock.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x55, 0x01, 0x00, 0x00]));
      });
      await sleep(300);
      expect(core.stats().activeConnections).toBe(1); // mid-handshake socket counted (F-31)
      sock.destroy();
      await sleep(250);
      expect(core.stats().activeConnections).toBe(0);
      const alive = await rawRequest(port, 'PING 0\n');
      expect(alive.data.toString('latin1')).toMatch(/^PONG \d+\n$/);
    } finally {
      await core.stop();
    }
  });
});

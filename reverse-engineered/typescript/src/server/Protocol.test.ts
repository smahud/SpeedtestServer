/**
 * Protocol conformance tests for the canonical implementation.
 * Contract source: authorized observations of OoklaServer 2.11.5.2
 * (2026-06-04.1737.7d0993d), captured 2026-11-04 — see validation/PROTOCOL_CONTRACT.md.
 */

import net from 'node:net';
import dgram from 'node:dgram';
import http from 'node:http';
import crypto from 'node:crypto';
import { NetGaugeEngine, LossRegistry, NetGaugeSessionHooks } from '../server/NetGaugeEngine';
import { ServerCore } from '../server/ServerCore';

/* ---------------- helpers ---------------- */

function makeHooks(lines: string[], peerIp = '127.0.0.1') {
  const writes: Buffer[] = [];
  const hooks: NetGaugeSessionHooks = {
    write: (d) => {
      writes.push(d);
      return true;
    },
    writeLine: (l) => {
      writes.push(Buffer.from(l + '\n'));
      return true;
    },
    peerIp: () => peerIp,
    close: () => undefined,
  };
  return { hooks, writes, text: () => writes.map((w) => w.toString('latin1')).join('') };
}

function makeEngine(peerIp = '127.0.0.1', versionString = '2.11 (2.11.5) 2026-06-04.1737.7d0993d') {
  const { hooks, writes, text } = makeHooks([], peerIp);
  const loss = new LossRegistry();
  const engine = new NetGaugeEngine(hooks, {
    versionString,
    instanceUuid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEFFFF0000',
    maxLineBytes: 1024 * 1024,
    maxDownloadBytes: 0x7fffffff,
    maxUploadBytes: 0x7fffffff,
    pool: crypto.randomBytes(2 * 1024 * 1024),
    loss,
    startedAt: Date.now() - 5000,
  });
  return { engine, writes, text, loss };
}

/* ---------------- NetGauge command contract ---------------- */

describe('NetGaugeEngine command contract', () => {
  test('HI (bare) → HELLO <version>', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('HI\n'));
    expect(t.text()).toBe('HELLO 2.11 (2.11.5) 2026-06-04.1737.7d0993d\n');
  });

  test('HI <uuid> → HELLO (session registered)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('HI 11111111-2222-3333-4444-555566667777\n'));
    expect(t.text()).toContain('HELLO ');
    expect(t.loss.get('11111111-2222-3333-4444-555566667777')).toBeDefined();
  });

  test('HI <non-uuid> → ERROR (daemon parity)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('HI NOT-A-UUID\n'));
    expect(t.text()).toBe('ERROR\n');
  });

  test('GETIP → YOURIP <peer>', () => {
    const t = makeEngine('::ffff:127.0.0.1');
    t.engine.feed(Buffer.from('GETIP\n'));
    expect(t.text()).toBe('YOURIP 127.0.0.1\n');
  });

  test('CAPABILITIES → daemon-exact string', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('CAPABILITIES\n'));
    expect(t.text()).toBe('CAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS\n');
  });

  test('PING → PONG <server-epoch-ms>', () => {
    const t = makeEngine();
    const before = Date.now();
    t.engine.feed(Buffer.from('PING 1234567890123\n'));
    const m = t.text().match(/^PONG (\d{13})\n$/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(before);
  });

  test('INITPLOSS → OK; PLOSS default → PLOSS 0 0 0', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('INITPLOSS\nPLOSS\n'));
    expect(t.text()).toBe('OK\nPLOSS 0 0 0\n');
  });

  test('UPLOAD_STATS → ERROR (daemon parity)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('UPLOAD_STATS\n'));
    expect(t.text()).toBe('ERROR\n');
  });

  test('unknown command → ERROR', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('GARBAGE_COMMAND\n'));
    expect(t.text()).toBe('ERROR\n');
  });

  test("official CLI's encrypted-binary hello → ERROR (triggers fallback)", () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('86959a638d56222f05fb918d33d87274fddb5faeb49518b19d4073b6aff4260a', 'hex'));
    expect(t.text()).toBe('ERROR\n');
  });

  test('DOWNLOAD 100000 → exactly 100000 bytes incl. 9-byte ASCII prefix', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('DOWNLOAD 100000\n'));
    const all = Buffer.concat(t.writes);
    expect(all.length).toBe(100000);
    expect(all.subarray(0, 9).toString('latin1')).toBe('DOWNLOAD ');
  });

  test('DOWNLOAD small (n < 9) → partial prefix only', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('DOWNLOAD 5\n'));
    const all = Buffer.concat(t.writes);
    expect(all.length).toBe(5);
    expect(all.toString('latin1')).toBe('DOWNL');
  });

  test('UPLOAD inclusive byte counting (command line counts toward n)', () => {
    const t = makeEngine();
    // "UPLOAD 100\n" is 11 bytes; client sends 89 more → total 100 → OK 100 <ms>
    t.engine.feed(Buffer.from('UPLOAD 100 15000 4\n'));
    const cmdLen = 'UPLOAD 100 15000 4'.length + 1;
    t.engine.feed(Buffer.alloc(100 - cmdLen, 0x42));
    const m = t.text().match(/^OK 100 (\d{13})\n$/);
    expect(m).not.toBeNull();
  });

  test('UPLOAD waits until n total bytes have arrived', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('UPLOAD 50\n')); // 10 bytes, counted toward n
    t.engine.feed(Buffer.alloc(10, 0x42));
    expect(t.text()).toBe('');
    t.engine.feed(Buffer.alloc(30, 0x42)); // 10 + 10 + 30 = 50 total
    expect(t.text()).toMatch(/^OK 50 \d+\n$/);
  });

  test('multiple commands on one connection (single feed)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('HI\nPING 1\nCAPABILITIES\n'));
    expect(t.text()).toBe(
      'HELLO 2.11 (2.11.5) 2026-06-04.1737.7d0993d\nPONG ' + t.text().match(/PONG (\d+)/)![1] + '\nCAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS\n',
    );
  });
});

/* ---------------- UDP packet-loss registry ---------------- */

describe('LossRegistry (UDP LOSS/RECV contract)', () => {
  test('4-field LOSS: counted, NOT answered', () => {
    const loss = new LossRegistry();
    expect(loss.recordLoss('11111111-2222-3333-4444-555566667777', '127.0.0.1', 0)).toBeNull();
    expect(loss.recordLoss('11111111-2222-3333-4444-555566667777', '127.0.0.1', 1)).toBeNull();
    expect(loss.statsLine()).toBe('PLOSS 2 0 1');
  });

  test('5-field LOSS: counted AND answered with RECV', () => {
    const loss = new LossRegistry();
    const r = loss.recordLoss('11111111-2222-3333-4444-555566667777', '127.0.0.1', 3, '987654');
    expect(r).toBe('RECV 3 987654 [1 3 0]');
  });

  test('IP mismatch → ignored (anti-spoof)', () => {
    const loss = new LossRegistry();
    loss.recordLoss('11111111-2222-3333-4444-555566667777', '127.0.0.1', 0);
    expect(loss.recordLoss('11111111-2222-3333-4444-555566667777', '192.0.2.9', 1, '1')).toBeNull();
    expect(loss.statsLine()).toBe('PLOSS 1 0 0');
  });

  test('dupes counted for re-ordered seq', () => {
    const loss = new LossRegistry();
    loss.recordLoss('11111111-2222-3333-4444-555566667777', '127.0.0.1', 5);
    loss.recordLoss('11111111-2222-3333-4444-555566667777', '127.0.0.1', 5);
    expect(loss.statsLine()).toBe('PLOSS 2 1 5');
  });
});

/* ---------------- Multiplexed server integration ---------------- */

describe('ServerCore single-port multiplexing (integration)', () => {
  let core: ServerCore;
  let port: number;

  beforeAll(async () => {
    port = 30000 + Math.floor(Math.random() * 10000);
    core = new ServerCore({
      tcpPorts: [port],
      udpPorts: [],
      versionString: '2.11 (2.11.5) 2026-06-04.1737.7d0993d',
      tls: null,
      crossDomainPorts: String(port),
      maxConnections: 100,
      maxConnectionsPerIp: 50,
      idleTimeoutMs: 30000,
    });
    await core.start();
  });

  afterAll(async () => {
    await core.stop();
  });

  test('HTTP and netgauge on the SAME port', async () => {
    const hi = await new Promise<string>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/hi', headers: { 'User-Agent': 'test' } }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve(b));
        })
        .on('error', reject);
    });
    expect(hi).toBe('hello 2.11 (2.11.5) 2026-06-04.1737.7d0993d\n');

    const ng = await new Promise<string>((resolve, reject) => {
      const c = net.connect(port, '127.0.0.1', () => c.write('HI\n'));
      let b = '';
      c.on('data', (d) => {
        b += d.toString();
        c.end();
      });
      c.on('close', () => resolve(b));
      c.on('error', reject);
    });
    expect(ng).toBe('HELLO 2.11 (2.11.5) 2026-06-04.1737.7d0993d\n');
  });

  test('UA-less request → 500 (daemon core behavior)', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/hi' }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode || 0));
        })
        .on('error', reject);
    });
    expect(status).toBe(500);
  });

  test('upload.php counts exact body bytes', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/speedtest/upload.php', method: 'POST', headers: { 'User-Agent': 'test', 'Content-Length': '1009' } },
        (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve(b));
        },
      );
      req.on('error', reject);
      req.write(Buffer.alloc(1009, 0x41));
      req.end();
    });
    expect(body).toBe('size=1009\n');
  });

  test('random350x350.jpg → exact fingerprint size', async () => {
    const len = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/speedtest/random350x350.jpg', headers: { 'User-Agent': 'test' } }, (res) => {
          let n = 0;
          res.on('data', (c) => (n += c.length));
          res.on('end', () => resolve(n));
        })
        .on('error', reject);
    });
    expect(len).toBe(245388);
  });

  test('non-canonical image size → 404', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/speedtest/random600x600.jpg', headers: { 'User-Agent': 'test' } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode || 0));
        })
        .on('error', reject);
    });
    expect(status).toBe(404);
  });
});

/* ---------------- UDP engine integration ---------------- */

describe('UdpLossEngine (integration)', () => {
  test('LOSS → RECV over real socket', async () => {
    const port = 31000 + Math.floor(Math.random() * 5000);
    const loss = new LossRegistry();
    const { UdpLossEngine } = await import('../server/UdpLossEngine');
    const udp = new UdpLossEngine({ ports: [port], loss, maxDatagramBytes: 2048 });
    udp.start();
    const reply = await new Promise<string>((resolve, reject) => {
      const s = dgram.createSocket('udp4');
      s.bind(() => s.send(Buffer.from('LOSS 111 7 ABCDEF12-3456-7890-ABCD-EF1234567890 222\n'), port, '127.0.0.1'));
      s.on('message', (m) => {
        s.close();
        resolve(m.toString());
      });
      s.on('error', reject);
      setTimeout(() => reject(new Error('udp timeout')), 3000);
    });
    expect(reply).toBe('RECV 7 222 [1 7 0]\n');
    udp.stop();
  });
});

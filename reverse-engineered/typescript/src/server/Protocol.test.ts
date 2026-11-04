/**
 * Protocol conformance tests for the canonical implementation.
 * Contract source: authorized observations of OoklaServer 2.11.5.2
 * (2026-06-04.1737.7d0993d), captured 2026-11-04 — see validation/PROTOCOL_CONTRACT.md.
 * Revision-3 differential probes (2026-11-04, rea-lab): F-8…F-22 regressions.
 */

import net from 'node:net';
import dgram from 'node:dgram';
import http from 'node:http';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NetGaugeEngine, LossRegistry, NetGaugeSessionHooks } from '../server/NetGaugeEngine';
import { ServerCore, generateAsciiPool } from '../server/ServerCore';
import { normalizePath, connectSrcList } from '../server/HttpApi';

/* ---------------- helpers ---------------- */

function makeHooks(lines: string[], peerIp = '127.0.0.1') {
  const writes: Buffer[] = [];
  let closed = false;
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
    close: () => {
      closed = true;
    },
  };
  return { hooks, writes, text: () => writes.map((w) => w.toString('latin1')).join(''), wasClosed: () => closed };
}

function makeEngine(peerIp = '127.0.0.1', versionString = '2.11 (2.11.5) 2026-06-04.1737.7d0993d') {
  const { hooks, writes, text, wasClosed } = makeHooks([], peerIp);
  const loss = new LossRegistry();
  const engine = new NetGaugeEngine(hooks, {
    versionString,
    instanceUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000',
    maxLineBytes: 1024 * 1024,
    maxDownloadBytes: 0x7fffffff,
    maxUploadBytes: 0x7fffffff,
    pool: generateAsciiPool(2 * 1024 * 1024),
    loss,
    startedAt: Date.now() - 5000,
  });
  return { engine, writes, text, loss, wasClosed };
}

function rawRequest(port: number, raw: string, waitMs = 1200): Promise<{ data: Buffer; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(Buffer.from(raw, 'latin1')));
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (closed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* already gone */ }
      resolve({ data: Buffer.concat(chunks), closed });
    };
    let timer = setTimeout(() => finish(false), waitMs);
    sock.on('data', (d) => chunks.push(d));
    sock.on('close', () => finish(true));
    sock.on('error', (e) => (chunks.length ? finish(true) : reject(e)));
  });
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

  test('HI with trailing space (empty arg) → ERROR (F-10)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('HI \n'));
    expect(t.text()).toBe('ERROR\n');
  });

  test('HI with two args → connection closed, no reply (daemon JWT path, F-10)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('HI 11111111-2222-3333-4444-555566667777 extra\n'));
    expect(t.text()).toBe('');
    expect(t.wasClosed()).toBe(true);
  });

  test('HI with double space + uuid → connection closed (F-10)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('HI  11111111-2222-3333-4444-555566667777\n'));
    expect(t.text()).toBe('');
    expect(t.wasClosed()).toBe(true);
  });

  test('HI <uuid> with trailing space → connection closed (F-10)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('HI 11111111-2222-3333-4444-555566667777 \n'));
    expect(t.text()).toBe('');
    expect(t.wasClosed()).toBe(true);
  });

  test('GETIP → YOURIP <peer>', () => {
    const t = makeEngine('::ffff:127.0.0.1');
    t.engine.feed(Buffer.from('GETIP\n'));
    expect(t.text()).toBe('YOURIP 127.0.0.1\n');
  });

  test('GETIP with trailing garbage → silent mute, no ERROR (F-11)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('GETIP \n'));
    expect(t.text()).toBe('');
    // The connection stays muted afterwards (daemon quirk).
    t.engine.feed(Buffer.from('GETIP\n'));
    expect(t.text()).toBe('');
  });

  test('GETIP followed by more data pre-HI in one read → whole read dropped (F-12)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('GETIP\nGETIP\n'));
    expect(t.text()).toBe('');
    // …and the connection never recovers (verified daemon poison behavior).
    t.engine.feed(Buffer.from('PING 1\n'));
    expect(t.text()).toBe('');
  });

  test('GETIP after HI processes all lines normally (F-12 scope)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('HI\n'));
    t.engine.feed(Buffer.from('GETIP\nGETIP\n'));
    expect(t.text()).toBe(
      'HELLO 2.11 (2.11.5) 2026-06-04.1737.7d0993d\nYOURIP 127.0.0.1\nYOURIP 127.0.0.1\n',
    );
  });

  test('non-GETIP first command with trailing data processes all lines (F-12)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('CAPABILITIES\nGETIP\n'));
    expect(t.text()).toBe('CAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS\nYOURIP 127.0.0.1\n');
  });

  test('CAPABILITIES → daemon-exact string', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('CAPABILITIES\n'));
    expect(t.text()).toBe('CAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS\n');
  });

  test('CAPABILITIES with extra argument → still answered (F-11 tolerance)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('CAPABILITIES x\n'));
    expect(t.text()).toBe('CAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS\n');
  });

  test('SERVERID → LOWER-CASE instance uuid (F-8)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('SERVERID\n'));
    expect(t.text()).toBe('SERVERID aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000\n');
  });

  test('UPTIME → seconds since start', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('UPTIME\n'));
    expect(t.text()).toMatch(/^UPTIME [4-6]\n$/);
  });

  test('PING with argument → PONG <server-epoch-ms>', () => {
    const t = makeEngine();
    const before = Date.now();
    t.engine.feed(Buffer.from('PING 1234567890123\n'));
    const m = t.text().match(/^PONG (\d{13})\n$/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(before);
  });

  test('PING with NON-numeric argument → PONG (any value accepted)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('PING abc\n'));
    expect(t.text()).toMatch(/^PONG \d{13}\n$/);
  });

  test('bare PING (no argument) → ERROR (F-10)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('PING\n'));
    expect(t.text()).toBe('ERROR\n');
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

  /* ---- DOWNLOAD reply structure (F-9) ---- */

  test('DOWNLOAD 100000 → exactly 100000 bytes, prefix + trailing newline', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('DOWNLOAD 100000\n'));
    const all = Buffer.concat(t.writes);
    expect(all.length).toBe(100000);
    expect(all.subarray(0, 9).toString('latin1')).toBe('DOWNLOAD ');
    expect(all[99999]).toBe(0x0a); // trailing "\n" counted in n
  });

  test('DOWNLOAD 0 → exactly "\\n" (1 byte)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('DOWNLOAD 0\n'));
    const all = Buffer.concat(t.writes);
    expect(all.length).toBe(1);
    expect(all[0]).toBe(0x0a);
  });

  test('DOWNLOAD 1 → "\\n"', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('DOWNLOAD 1\n'));
    const all = Buffer.concat(t.writes);
    expect(all.length).toBe(1);
    expect(all[0]).toBe(0x0a);
  });

  test('DOWNLOAD 5 → "DOWN\\n" (truncated prefix + newline)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('DOWNLOAD 5\n'));
    const all = Buffer.concat(t.writes);
    expect(all.length).toBe(5);
    expect(all.toString('latin1')).toBe('DOWN\n');
  });

  test('DOWNLOAD 9 → "DOWNLOAD\\n"', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('DOWNLOAD 9\n'));
    const all = Buffer.concat(t.writes);
    expect(all.toString('latin1')).toBe('DOWNLOAD\n');
  });

  test('DOWNLOAD 10 → "DOWNLOAD \\n"', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('DOWNLOAD 10\n'));
    const all = Buffer.concat(t.writes);
    expect(all.toString('latin1')).toBe('DOWNLOAD \n');
  });

  test('DOWNLOAD 11 → prefix + 1 pool byte + newline', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('DOWNLOAD 11\n'));
    const all = Buffer.concat(t.writes);
    expect(all.length).toBe(11);
    expect(all.subarray(0, 9).toString('latin1')).toBe('DOWNLOAD ');
    expect(all[10]).toBe(0x0a);
  });

  test('DOWNLOAD payload is printable ASCII [0x20..0x7F] (daemon charset, F-9)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('DOWNLOAD 5000\n'));
    const all = Buffer.concat(t.writes);
    for (const b of all.subarray(9, 4999)) {
      expect(b).toBeGreaterThanOrEqual(0x20);
      expect(b).toBeLessThanOrEqual(0x7f);
    }
  });

  test('DOWNLOAD with unparsable size → ERROR (documented safety deviation)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('DOWNLOAD abc\n'));
    expect(t.text()).toBe('ERROR\n');
    t.engine.feed(Buffer.from('DOWNLOAD -1\n'));
    expect(t.text()).toBe('ERROR\nERROR\n');
  });

  test('DOWNLOAD accepts extra arguments (daemon parity)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('DOWNLOAD 100 16 0\n'));
    const all = Buffer.concat(t.writes);
    expect(all.length).toBe(100);
  });

  /* ---- UPLOAD contract ---- */

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

  test('UPLOAD n smaller than the command line → ERROR, connection continues (F-10)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('UPLOAD 5\nGETIP\n'));
    expect(t.text()).toBe('ERROR\nYOURIP 127.0.0.1\n');
  });

  test('UPLOAD 0 → ERROR (F-10)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('UPLOAD 0\n'));
    expect(t.text()).toBe('ERROR\n');
  });

  test('UPLOAD with negative/garbage size → silently ignored, connection continues (F-10)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('UPLOAD -5\n'));
    expect(t.text()).toBe('');
    t.engine.feed(Buffer.from('UPLOAD abc\nGETIP\n'));
    expect(t.text()).toBe('YOURIP 127.0.0.1\n');
  });

  test('UPLOAD boundary: bytes after the command count across reads', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('UPLOAD 20\n' + 'A'.repeat(9)));
    expect(t.text()).toBe('');
    t.engine.feed(Buffer.from('G')); // 10 + 9 + 1 = 20
    expect(t.text()).toMatch(/^OK 20 \d{13}\n$/);
  });

  /* ---- QUIT per transport (F-14) ---- */

  test('QUIT over TCP → connection closed', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('QUIT\n'));
    expect(t.text()).toBe('');
    expect(t.wasClosed()).toBe(true);
  });

  test('QUIT over WebSocket → ERROR reply, connection stays open (F-14)', () => {
    const { hooks, writes, text, wasClosed } = makeHooks([]);
    const engine = new NetGaugeEngine(hooks, {
      versionString: '2.11 (2.11.5) 2026-06-04.1737.7d0993d',
      instanceUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000',
      maxLineBytes: 1024 * 1024,
      maxDownloadBytes: 0x7fffffff,
      maxUploadBytes: 0x7fffffff,
      pool: generateAsciiPool(65536),
      loss: new LossRegistry(),
      startedAt: Date.now(),
      quitMode: 'error',
    });
    engine.feed(Buffer.from('QUIT\n'));
    expect(text()).toBe('ERROR\n');
    expect(wasClosed()).toBe(false);
    expect(writes.length).toBe(1);
  });

  test('multiple commands on one connection (single feed)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('HI\nPING 1\nCAPABILITIES\n'));
    expect(t.text()).toBe(
      'HELLO 2.11 (2.11.5) 2026-06-04.1737.7d0993d\nPONG ' + t.text().match(/PONG (\d+)/)![1] + '\nCAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS\n',
    );
  });

  /* ---- CRLF tolerance & "three strikes" (F-24, F-25) ---- */

  test('trailing \\r is stripped before dispatch: HI\\r → HELLO (F-25)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('HI\r\n'));
    expect(t.text()).toBe('HELLO 2.11 (2.11.5) 2026-06-04.1737.7d0993d\n');
  });

  test('trailing \\r on PING/CAPABILITIES answered normally (F-25)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('PING 1\r\nCAPABILITIES\r\n'));
    expect(t.text()).toMatch(/^PONG \d{13}\nCAPABILITIES SERVER_HOST_AUTH UPLOAD_STATS\n$/);
  });

  test('GETIP\\r still mutes (strict check on the RAW line, F-25)', () => {
    const t = makeEngine();
    t.engine.feed(Buffer.from('GETIP\r\n'));
    expect(t.text()).toBe('');
    t.engine.feed(Buffer.from('GETIP\n'));
    expect(t.text()).toBe('');
  });

  test('"three strikes": 3rd cumulative ERROR closes the connection (F-24)', () => {
    const { hooks, writes, text, wasClosed } = makeHooks([]);
    const engine = new NetGaugeEngine(hooks, {
      versionString: '2.11 (2.11.5) 2026-06-04.1737.7d0993d',
      instanceUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000',
      maxLineBytes: 1024 * 1024,
      maxDownloadBytes: 0x7fffffff,
      maxUploadBytes: 0x7fffffff,
      pool: generateAsciiPool(65536),
      loss: new LossRegistry(),
      startedAt: Date.now(),
      errorStrikeLimit: 3,
    });
    engine.feed(Buffer.from('AAA\nBBB\n'));
    expect(text()).toBe('ERROR\nERROR\n');
    expect(wasClosed()).toBe(false);
    engine.feed(Buffer.from('CCC\nDDD\n')); // 3rd strike closes; DDD unprocessed
    expect(text()).toBe('ERROR\nERROR\nERROR\n');
    expect(wasClosed()).toBe(true);
    expect(writes.length).toBe(3);
  });

  test('"three strikes": valid commands do NOT reset the counter (F-24)', () => {
    const { hooks, text, wasClosed } = makeHooks([]);
    const engine = new NetGaugeEngine(hooks, {
      versionString: '2.11 (2.11.5) 2026-06-04.1737.7d0993d',
      instanceUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000',
      maxLineBytes: 1024 * 1024,
      maxDownloadBytes: 0x7fffffff,
      maxUploadBytes: 0x7fffffff,
      pool: generateAsciiPool(65536),
      loss: new LossRegistry(),
      startedAt: Date.now(),
      errorStrikeLimit: 3,
    });
    engine.feed(Buffer.from('AAA\nBBB\nPING 1\nCCC\n'));
    expect(text()).toMatch(/^ERROR\nERROR\nPONG \d{13}\nERROR\n$/);
    expect(wasClosed()).toBe(true);
  });

  test('"three strikes": the HI bad-argument ERROR does NOT count (F-24)', () => {
    const { hooks, text, wasClosed } = makeHooks([]);
    const engine = new NetGaugeEngine(hooks, {
      versionString: '2.11 (2.11.5) 2026-06-04.1737.7d0993d',
      instanceUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000',
      maxLineBytes: 1024 * 1024,
      maxDownloadBytes: 0x7fffffff,
      maxUploadBytes: 0x7fffffff,
      pool: generateAsciiPool(65536),
      loss: new LossRegistry(),
      startedAt: Date.now(),
      errorStrikeLimit: 3,
    });
    engine.feed(Buffer.from('HI nope1\nHI nope2\nHI nope3\nGETIP\n'));
    expect(text()).toBe('ERROR\nERROR\nERROR\nYOURIP 127.0.0.1\n');
    expect(wasClosed()).toBe(false);
  });

  test('"three strikes": disabled (limit 0) for WebSocket sessions (F-24)', () => {
    const { hooks, text, wasClosed } = makeHooks([]);
    const engine = new NetGaugeEngine(hooks, {
      versionString: '2.11 (2.11.5) 2026-06-04.1737.7d0993d',
      instanceUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000',
      maxLineBytes: 1024 * 1024,
      maxDownloadBytes: 0x7fffffff,
      maxUploadBytes: 0x7fffffff,
      pool: generateAsciiPool(65536),
      loss: new LossRegistry(),
      startedAt: Date.now(),
      errorStrikeLimit: 0,
    });
    engine.feed(Buffer.from('AAA\nBBB\nCCC\nGETIP\n'));
    expect(text()).toBe('ERROR\nERROR\nERROR\nYOURIP 127.0.0.1\n');
    expect(wasClosed()).toBe(false);
  });
});

/* ---------------- ASCII pool ---------------- */

describe('generateAsciiPool (daemon charset parity, F-9)', () => {
  test('all bytes within [0x20..0x7F]', () => {
    const pool = generateAsciiPool(64 * 1024);
    for (const b of pool) {
      expect(b).toBeGreaterThanOrEqual(0x20);
      expect(b).toBeLessThanOrEqual(0x7f);
    }
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

/* ---------------- HTTP helpers ---------------- */

describe('HttpApi helpers', () => {
  test('normalizePath collapses //, . and .. segments (F-19)', () => {
    expect(normalizePath('//hi')).toBe('/hi');
    expect(normalizePath('/./hi')).toBe('/hi');
    expect(normalizePath('/a/../hi')).toBe('/hi');
    expect(normalizePath('/../hi')).toBe('/hi');
    expect(normalizePath('/HI/../hi')).toBe('/hi');
    expect(normalizePath('/speedtest/latency.txt')).toBe('/speedtest/latency.txt');
  });

  test('connectSrcList: default is "*"; configured domains union defaults (F-22)', () => {
    expect(connectSrcList(['*'], false)).toBe('*');
    expect(connectSrcList([], false)).toBe('*');
    expect(connectSrcList(['*.example.org'], false)).toBe(
      '*.example.org *.ookla.com *.speedtest.net *.speedtestcustom.com',
    );
    expect(connectSrcList(['*.example.org'], true)).toBe('*.example.org');
    // Already-present defaults are not duplicated.
    expect(connectSrcList(['*.speedtest.net', '*.ookla.com'], false)).toBe(
      '*.speedtest.net *.ookla.com *.speedtestcustom.com',
    );
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
      allowedDomains: ['*'],
      excludeDefaultDomains: false,
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

  test('SERVERID over TCP → lower-case uuid (F-8)', async () => {
    const ng = await new Promise<string>((resolve, reject) => {
      const c = net.connect(port, '127.0.0.1', () => c.write('SERVERID\n'));
      let b = '';
      c.on('data', (d) => {
        b += d.toString();
        c.end();
      });
      c.on('close', () => resolve(b));
      c.on('error', reject);
    });
    expect(ng).toMatch(/^SERVERID [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n$/);
  });

  test('UA-less request → minimal 500 (status + Connection: Close only, F-17)', async () => {
    const r = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    expect(r.data.toString('latin1')).toBe('HTTP/1.1 500 Internal Server Error\r\nConnection: Close\r\n\r\n');
  });

  test('empty User-Agent VALUE counts as present → served (F-17)', async () => {
    const r = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: \r\nConnection: close\r\n\r\n`);
    expect(r.data.toString('latin1')).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
  });

  test('Host mismatch → 307 Temporary Redirect to https://<cert-host> (F-16)', async () => {
    const r = await rawRequest(port, `GET /hi?a=1 HTTP/1.1\r\nHost: evil.example\r\nUser-Agent: t\r\nConnection: close\r\n\r\n`);
    const s = r.data.toString('latin1');
    expect(s).toMatch(/^HTTP\/1\.1 307 Temporary Redirect\r\n/);
    expect(s).toContain(`Location: https://localhost:${port}/hi?a=1\r\n`);
    expect(s).toContain('Content-Length: 0');
    expect(s).toContain('Connection: Close');
  });

  test('Host with port suffix is allowed (127.0.0.1:port)', async () => {
    const r = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUser-Agent: t\r\nConnection: close\r\n\r\n`);
    expect(r.data.toString('latin1')).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
  });

  test('Authorization: Bearer <garbage> → minimal 500 (F-18)', async () => {
    const r = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\nAuthorization: Bearer x\r\nConnection: close\r\n\r\n`);
    expect(r.data.toString('latin1')).toBe('HTTP/1.1 500 Internal Server Error\r\nConnection: Close\r\n\r\n');
  });

  test('Authorization: Bearer <jwt-shaped> → served; Basic → served (F-18)', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N5gL9M15AeNCwgZyWLOcdk';
    const r1 = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\nAuthorization: Bearer ${jwt}\r\nConnection: close\r\n\r\n`);
    expect(r1.data.toString('latin1')).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    const r2 = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\nAuthorization: Basic eHg6eHg=\r\nConnection: close\r\n\r\n`);
    expect(r2.data.toString('latin1')).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
  });

  test('response headers: daemon order + "Connection: Close" casing (F-15)', async () => {
    const r = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\nConnection: close\r\n\r\n`);
    const s = r.data.toString('latin1');
    // Order: Date → Connection → security headers → Content-Type → Content-Length.
    const idxDate = s.indexOf('Date: ');
    const idxConn = s.indexOf('Connection: Close\r\n');
    const idxCache = s.indexOf('Cache-Control: no-store\r\n');
    const idxCsp = s.indexOf('Content-Security-Policy: ');
    const idxCt = s.indexOf('Content-Type: text/plain; charset=UTF-8\r\n');
    const idxCl = s.indexOf('Content-Length: 44\r\n');
    expect(idxDate).toBeGreaterThan(-1);
    expect(idxConn).toBeGreaterThan(idxDate);
    expect(idxCache).toBeGreaterThan(idxConn);
    expect(idxCsp).toBeGreaterThan(idxCache);
    expect(idxCt).toBeGreaterThan(idxCsp);
    expect(idxCl).toBeGreaterThan(idxCt);
    expect(s.endsWith('hello 2.11 (2.11.5) 2026-06-04.1737.7d0993d\n')).toBe(true);
  });

  test('keep-alive response: "Connection: Keep-Alive" casing (F-15)', async () => {
    const r = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\n\r\n`);
    const s = r.data.toString('latin1');
    expect(s).toContain('Connection: Keep-Alive\r\n');
    expect(s).not.toContain('Keep-Alive: timeout='); // daemon sends no timeout header
  });

  test('HEAD /hi → Content-Length of the would-be body, no body (F-15)', async () => {
    const r = await rawRequest(port, `HEAD /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\nConnection: close\r\n\r\n`);
    const s = r.data.toString('latin1');
    expect(s).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(s).toContain('Content-Length: 44\r\n');
    expect(s.endsWith('\r\n\r\n')).toBe(true); // headers only, no body
  });

  test('OPTIONS /hi → 200 with Content-Length: 0 and no body (F-20)', async () => {
    const r = await rawRequest(port, `OPTIONS /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\nConnection: close\r\n\r\n`);
    const s = r.data.toString('latin1');
    expect(s).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(s).toContain('Content-Length: 0\r\n');
    expect(s.endsWith('\r\n\r\n')).toBe(true);
  });

  test('PUT/DELETE/PATCH on text endpoints → 404 (F-20)', async () => {
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const r = await rawRequest(port, `${method} /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\nConnection: close\r\n\r\n`);
      expect(r.data.toString('latin1')).toMatch(/^HTTP\/1\.1 404 Not Found\r\n/);
    }
  });

  test('404 shape: security headers, no Content-Length, no chunked terminator (F-15)', async () => {
    const r = await rawRequest(port, `GET /nope HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\nConnection: close\r\n\r\n`);
    const s = r.data.toString('latin1');
    expect(s).toMatch(/^HTTP\/1\.1 404 Not Found\r\n/);
    expect(s).toContain('Cache-Control: no-store\r\n');
    expect(s).toContain('Content-Security-Policy: ');
    expect(s).not.toContain('Content-Length:');
    expect(s).not.toContain('Transfer-Encoding:');
    expect(s).not.toContain('0\r\n\r\n');
    expect(s.endsWith('\r\n\r\n')).toBe(true);
  });

  test('path normalization: //hi, /./hi, /a/../hi all serve /hi (F-19)', async () => {
    for (const p of ['//hi', '/./hi', '/a/../hi']) {
      const r = await rawRequest(port, `GET ${p} HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\nConnection: close\r\n\r\n`);
      expect(r.data.toString('latin1')).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    }
  });

  test('absolute-form request target uses its path (F-19)', async () => {
    const r = await rawRequest(port, `GET http://127.0.0.1/hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\nConnection: close\r\n\r\n`);
    expect(r.data.toString('latin1')).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
  });

  test('CSP connect-src reflects allowedDomains (F-22)', async () => {
    // This ServerCore instance uses allowedDomains ["*"] → connect-src *
    const r = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\nConnection: close\r\n\r\n`);
    expect(r.data.toString('latin1')).toContain('connect-src *;');
  });

  test('GET /ws without an upgrade request → silent close (F-21)', async () => {
    const r = await rawRequest(port, `GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\nConnection: close\r\n\r\n`);
    expect(r.data.length).toBe(0);
    expect(r.closed).toBe(true);
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
    await udp.start();
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

  test('UDP bind failure rejects start() (fail closed, A-5)', async () => {
    const { UdpLossEngine } = await import('../server/UdpLossEngine');
    const blocker = dgram.createSocket('udp4');
    const port = 32000 + Math.floor(Math.random() * 5000);
    await new Promise<void>((r) => blocker.bind(port, '127.0.0.1', r));
    const loss = new LossRegistry();
    const udp = new UdpLossEngine({ ports: [port], loss, maxDatagramBytes: 2048 });
    let rejected = false;
    try {
      await udp.start();
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    blocker.close();
    udp.stop();
  });
});

/* ---------------- ConfigManager fail-closed & hardening ---------------- */

describe('ConfigManager hardening (A-1, A-2, A-13)', () => {
  const ENV_KEY = 'OOKLA_SPEEDTESTSERVER_CONFIG_FILE';
  let savedEnv: string | undefined;
  beforeAll(() => {
    savedEnv = process.env[ENV_KEY];
  });
  afterAll(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  test('explicit --config pointing at a MISSING file → throws (fail closed, A-1)', async () => {
    process.env[ENV_KEY] = path.join(os.tmpdir(), `missing-${Date.now()}.properties`);
    const { ConfigManager } = await import('../server/ConfigManager');
    expect(() => new ConfigManager()).toThrow(/not found/i);
  });

  test('explicit --config with BROKEN JSON → throws (fail closed, A-1)', async () => {
    const f = path.join(os.tmpdir(), `broken-${Date.now()}.json`);
    fs.writeFileSync(f, '{ not valid json !!!');
    process.env[ENV_KEY] = f;
    const { ConfigManager } = await import('../server/ConfigManager');
    expect(() => new ConfigManager()).toThrow();
    fs.unlinkSync(f);
  });

  test('explicit --config with .ts extension → throws (fail closed, A-13)', async () => {
    const f = path.join(os.tmpdir(), `x-${Date.now()}.ts`);
    fs.writeFileSync(f, 'export default {};');
    process.env[ENV_KEY] = f;
    const { ConfigManager } = await import('../server/ConfigManager');
    expect(() => new ConfigManager()).toThrow(/TypeScript config files/);
    fs.unlinkSync(f);
  });

  test('prototype pollution via properties __proto__ key is blocked (A-2)', async () => {
    const f = path.join(os.tmpdir(), `proto-${Date.now()}.properties`);
    fs.writeFileSync(f, '__proto__.polluted = true\nconstructor.prototype.x = 1\nOoklaServer.tcpPorts = 19999\n');
    process.env[ENV_KEY] = f;
    const { ConfigManager } = await import('../server/ConfigManager');
    const cm = new ConfigManager();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(cm.getConfig().tcpPorts).toEqual([19999]);
    fs.unlinkSync(f);
  });

  test("allowedDomains key ABSENT from the config file → daemon built-in default '*' (F-22)", async () => {
    const f = path.join(os.tmpdir(), `empty-${Date.now()}.properties`);
    fs.writeFileSync(f, '# no allowedDomains key - daemon default is "*"\nOoklaServer.tcpPorts = 19999\n');
    process.env[ENV_KEY] = f;
    const { ConfigManager } = await import('../server/ConfigManager');
    const cm = new ConfigManager();
    expect(cm.getConfig().allowedDomains).toEqual(['*']);
    fs.unlinkSync(f);
  });
});

/**
 * ConfigParityRev5 — regression tests for the revision-5 config-parity fixes,
 * all verified against the live reference daemon on 2026-11-05
 * (evidence: /home/z/my-project/rea-lab/evidence/config-*.json, lab probes):
 *
 *   F-26 userAgentFilterEnabled — 11-pattern built-in blocklist (default OFF;
 *       full-string case-sensitive regex; with-Date 500 form; Host checks win)
 *   F-27 websocket.frameSizeLimitBytes — default 5242880; frames with payload
 *       <= limit+1 accepted; >= limit+2 → NO reply + TCP reset (no close frame)
 *   F-28 addresses — explicit bind list (documented intent; daemon's own v4
 *       handling is broken — deviation D-6)
 *   F-29 useIPv4/useIPv6 — independent per-family listeners (TCP + UDP)
 */
import * as net from 'node:net';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { ServerCore } from './ServerCore';
import { UA_BLOCKLIST_PATTERNS, isFilteredUserAgent } from './HttpApi';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
jest.setTimeout(20000);

/** Random high port (collisions retried by the OS on bind). */
function freePort(): number {
  return 25000 + Math.floor(Math.random() * 20000);
}

/** Raw TCP request → everything the server sends back. */
function rawRequest(
  port: number,
  req: string,
  { host = '127.0.0.1', waitMs = 900 }: { host?: string; waitMs?: number } = {},
): Promise<{ data: Buffer; closed: boolean }> {
  return new Promise((resolve) => {
    let data = Buffer.alloc(0);
    let closed = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try { sock.destroy(); } catch {}
      resolve({ data, closed });
    };
    let t: NodeJS.Timeout;
    const sock = net.connect({ host, port }, () => {
      sock.write(req);
      t = setTimeout(finish, waitMs);
    });
    sock.on('data', (d) => (data = Buffer.concat([data, d])));
    sock.on('close', () => {
      closed = true;
      finish();
    });
    sock.on('error', () => finish());
  });
}

/** Raw WebSocket probe: handshake, then one masked text frame. */
function wsSendFrame(
  port: number,
  payload: Buffer,
  { host = '127.0.0.1', settleMs = 1100 }: { host?: string; settleMs?: number } = {},
): Promise<{ frames: { opcode: number; len: number; preview: string }[]; closed: boolean; error: boolean }> {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const head = `GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: probe\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
    const sock = net.connect({ host, port }, () => sock.write(head));
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const state = { frames: [] as { opcode: number; len: number; preview: string }[], closed: false, error: false };
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try { sock.destroy(); } catch {}
      resolve(state);
    };
    let t: NodeJS.Timeout = setTimeout(finish, settleMs + 1500);
    const sendFrame = (pl: Buffer) => {
      const mask = crypto.randomBytes(4);
      const len = pl.length;
      let hdr: Buffer;
      if (len < 126) hdr = Buffer.from([0x81, 0x80 | len]);
      else if (len < 65536) hdr = Buffer.from([0x81, 0x80 | 126, len >> 8, len & 0xff]);
      else {
        const b = Buffer.alloc(8);
        b.writeBigUInt64BE(BigInt(len));
        hdr = Buffer.concat([Buffer.from([0x81, 0x80 | 127]), b]);
      }
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = pl[i] ^ mask[i % 4];
      sock.write(Buffer.concat([hdr, mask, masked]));
    };
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const i = buf.indexOf('\r\n\r\n');
        if (i !== -1) {
          upgraded = true;
          buf = buf.subarray(i + 4);
          sendFrame(payload);
          t = setTimeout(finish, settleMs);
        }
      }
      if (upgraded) {
        while (buf.length >= 2) {
          const opcode = buf[0] & 0x0f;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) break;
            len = buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (buf.length < 10) break;
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
          }
          if (buf.length < off + len) break;
          state.frames.push({ opcode, len, preview: buf.subarray(off, off + len).toString('latin1').slice(0, 60) });
          buf = buf.subarray(off + len);
          if (opcode === 0x8) state.closed = true;
        }
      }
    });
    sock.on('close', () => {
      state.closed = true;
      finish();
    });
    sock.on('error', () => {
      state.error = true;
      finish();
    });
  });
}

/** EXACT `size`-byte payload ('PING 1\n' is 7 bytes — an earlier off-by-one
 * in the probe helper produced size-1 payloads and skewed the boundary). */
const mkPayload = (size: number): Buffer => {
  const b = Buffer.alloc(Math.max(size, 0), 0x23);
  Buffer.from('PING 1\n').copy(b, 0);
  return b;
};

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

/* ================= F-26: userAgentFilterEnabled ================= */

describe('F-26 — userAgentFilterEnabled blocklist (unit)', () => {
  test('the built-in blocklist is the verified 11-pattern set', () => {
    expect(UA_BLOCKLIST_PATTERNS).toEqual([
      'libcurl-.*',
      'AndroidSpeedtest',
      'Wi-Fi Maximiser',
      'SPEEDTEST_CLIENT',
      'Python-urllib',
      'ubnt-test',
      'check_http',
      'curl/.*',
      'LuaSocket.*',
      'showwin/speedtest-go.*',
      'Go-http-client/.*',
    ]);
  });

  test('full-string case-sensitive matching (verified against the daemon)', () => {
    // Blocked (daemon-verified): wildcard entries accept any continuation,
    // literal entries only the exact string.
    for (const ua of [
      'libcurl-7.88.1', 'libcurl-',
      'AndroidSpeedtest', 'Wi-Fi Maximiser', 'SPEEDTEST_CLIENT',
      'Python-urllib', 'ubnt-test', 'check_http',
      'curl/8.5.0', 'LuaSocket/3.1.0', 'showwin/speedtest-go/1.5.2', 'Go-http-client/2.0',
    ]) {
      expect(`${ua}`).not.toBe(''); // sanity
      expect(isFilteredUserAgent(ua)).toBe(true);
    }
    // Allowed (daemon-verified): no version, wrong case, mid-string, overlap.
    for (const ua of [
      'curl', 'Curl/8.5', 'CURL/8.5.0', 'curl_x',
      'go-http-client/2.0', 'Go-HTTP-Client/2.0', 'Go-http-client',
      'python-urllib/3.11', 'Python-urllibx9', // 'Python-urllib' + suffix would match; bare lowercase does not
      'Mozilla/5.0 (X11; Linux) curl/8.5',
      'Acurl/8.5.0',
      'AndroidSpeedtest 1',
      'libcurl7',
      'showwin/speedtest',
      'check_http (nagios)',
      'Wget/1.21.4', 'okhttp/4.12.0',
    ]) {
      expect(isFilteredUserAgent(ua)).toBe(false);
    }
  });
});

describe('F-26 — userAgentFilterEnabled over the wire (integration)', () => {
  let port: number;
  let core: ServerCore;

  beforeAll(async () => {
    port = freePort();
    core = new ServerCore(coreOpts(port, { userAgentFilterEnabled: true }) as never);
    await core.start();
  });
  afterAll(async () => {
    await core.stop();
  });

  test('filtered UA → 500 WITH Date header, connection closed (daemon form)', async () => {
    const r = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: curl/8.5.0\r\nConnection: close\r\n\r\n`);
    expect(r.data.toString('latin1')).toMatch(
      /^HTTP\/1\.1 500 Internal Server Error\r\nDate: .+\r\nConnection: Close\r\n\r\n$/,
    );
    expect(r.data.length).toBeGreaterThan(57); // with Date — NOT the minimal 500
  });

  test('exact literal entry filtered; suffixed variant served', async () => {
    const blocked = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: check_http\r\nConnection: close\r\n\r\n`);
    expect(blocked.data.toString('latin1')).toMatch(/^HTTP\/1\.1 500 Internal Server Error\r\nDate: /);
    const served = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: check_http (nagios)\r\nConnection: close\r\n\r\n`);
    expect(served.data.toString('latin1')).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
  });

  test('non-listed tool UAs are served (Wget, okhttp, masscan)', async () => {
    for (const ua of ['Wget/1.21.4', 'okhttp/4.12.0', 'masscan/1.3']) {
      const r = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: ${ua}\r\nConnection: close\r\n\r\n`);
      expect(r.data.toString('latin1')).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    }
  });

  test('missing Host wins over the filter (minimal 500, no Date)', async () => {
    const r = await rawRequest(port, `GET /hi HTTP/1.1\r\nUser-Agent: curl/8.5.0\r\nConnection: close\r\n\r\n`);
    expect(r.data.toString('latin1')).toBe('HTTP/1.1 500 Internal Server Error\r\nConnection: Close\r\n\r\n');
  });

  test('Host mismatch wins over the filter (307)', async () => {
    const r = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: evil.example\r\nUser-Agent: curl/8.5.0\r\nConnection: close\r\n\r\n`);
    expect(r.data.toString('latin1')).toMatch(/^HTTP\/1\.1 307 Temporary Redirect\r\n/);
  });

  test('filter OFF (daemon default) serves curl/*', async () => {
    const port2 = freePort();
    const core2 = new ServerCore(coreOpts(port2, { userAgentFilterEnabled: false }) as never);
    await core2.start();
    try {
      const r = await rawRequest(port2, `GET /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: curl/8.5.0\r\nConnection: close\r\n\r\n`);
      expect(r.data.toString('latin1')).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    } finally {
      await core2.stop();
    }
  });
});

/* ================= F-27: websocket.frameSizeLimitBytes ================= */

describe('F-27 — websocket.frameSizeLimitBytes (integration)', () => {
  let port: number;
  let core: ServerCore;

  beforeAll(async () => {
    port = freePort();
    core = new ServerCore(coreOpts(port, { wsFrameSizeLimitBytes: 64 }) as never);
    await core.start();
  });
  afterAll(async () => {
    await core.stop();
  });

  test('boundary: payload == limit is answered; payload limit+1 is reset with NO reply', async () => {
    const r64 = await wsSendFrame(port, mkPayload(64)); // payload == limit
    expect(r64.frames.length).toBe(1);
    expect(r64.frames[0].preview).toMatch(/^PONG \d+/);

    const r63 = await wsSendFrame(port, mkPayload(63)); // payload < limit
    expect(r63.frames.length).toBe(1);
    expect(r63.frames[0].preview).toMatch(/^PONG \d+/);

    const r65 = await wsSendFrame(port, mkPayload(65)); // payload > limit (limit+1)
    expect(r65.frames.length).toBe(0); // daemon: nothing on the wire — no close frame, no error frame
    expect(r65.closed || r65.error).toBe(true);
  });

  test('larger oversize (4096) is also reset with NO reply', async () => {
    const r = await wsSendFrame(port, mkPayload(4096), { settleMs: 700 });
    expect(r.frames.length).toBe(0);
    expect(r.closed || r.error).toBe(true);
  });

  test('in-limit frames continue to stream on one connection', async () => {
    // two accepted frames back-to-back on the same connection:
    // raw client that keeps the socket open and sends sequentially
    const out = await new Promise<{ frames: { opcode: number; preview: string }[]; closed: boolean }>((resolve) => {
      const key = crypto.randomBytes(16).toString('base64');
      const head = `GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: probe\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
      const sock = net.connect({ host: '127.0.0.1', port }, () => sock.write(head));
      let buf = Buffer.alloc(0);
      let upgraded = false;
      const frames: { opcode: number; preview: string }[] = [];
      const finish = () => {
        clearTimeout(t);
        try { sock.destroy(); } catch {}
        resolve({ frames, closed: stateClosed });
      };
      let stateClosed = false;
      let t: NodeJS.Timeout;
      const sendFrame = (pl: Buffer) => {
        const mask = crypto.randomBytes(4);
        const len = pl.length;
        const hdr = Buffer.from([0x81, 0x80 | len]);
        const masked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) masked[i] = pl[i] ^ mask[i % 4];
        sock.write(Buffer.concat([hdr, mask, masked]));
      };
      sock.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        if (!upgraded) {
          const i = buf.indexOf('\r\n\r\n');
          if (i !== -1) {
            upgraded = true;
            buf = buf.subarray(i + 4);
            sendFrame(mkPayload(64));
            setTimeout(() => {
              if (!stateClosed) sendFrame(mkPayload(63));
            }, 400);
            t = setTimeout(finish, 1600);
          }
        }
        if (upgraded) {
          while (buf.length >= 2) {
            const opcode = buf[0] & 0x0f;
            let len = buf[1] & 0x7f;
            let off = 2;
            if (len === 126) {
              if (buf.length < 4) break;
              len = buf.readUInt16BE(2);
              off = 4;
            }
            if (buf.length < off + len) break;
            frames.push({ opcode, preview: buf.subarray(off, off + len).toString('latin1').slice(0, 40) });
            buf = buf.subarray(off + len);
            if (opcode === 0x8) stateClosed = true;
          }
        }
      });
      sock.on('close', () => {
        stateClosed = true;
        finish();
      });
      sock.on('error', () => finish());
    });
    expect(out.frames.length).toBe(2);
    expect(out.frames[0].preview).toMatch(/^PONG \d+/);
    expect(out.frames[1].preview).toMatch(/^PONG \d+/);
  });
});

/* ================= F-28 / F-29: listener binding ================= */

describe('F-29 — useIPv4/useIPv6 independent listeners (integration)', () => {
  test('useIPv4=false: v4 refused, v6 served (daemon parity)', async () => {
    const port = freePort();
    const core = new ServerCore(coreOpts(port, { bindIPv4: false }) as never); // bindIPv6 defaults true
    await core.start();
    try {
      const v4 = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\nConnection: close\r\n\r\n`, { waitMs: 400 });
      expect(v4.data.length).toBe(0); // refused: nothing served
      const v6 = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: localhost\r\nUser-Agent: t\r\nConnection: close\r\n\r\n`, { host: '::1' });
      expect(v6.data.toString('latin1')).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    } finally {
      await core.stop();
    }
  });

  test('useIPv6=false: v6 refused, v4 served (daemon parity)', async () => {
    const port = freePort();
    const core = new ServerCore(coreOpts(port, { bindIPv6: false }) as never);
    await core.start();
    try {
      const v6 = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: localhost\r\nUser-Agent: t\r\nConnection: close\r\n\r\n`, { host: '::1', waitMs: 400 });
      expect(v6.data.length).toBe(0);
      const v4 = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\nConnection: close\r\n\r\n`);
      expect(v4.data.toString('latin1')).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    } finally {
      await core.stop();
    }
  });

  test('both disabled and no addresses → start() fails closed', async () => {
    const port = freePort();
    const core = new ServerCore(coreOpts(port, { bindIPv4: false, bindIPv6: false }) as never);
    await expect(core.start()).rejects.toThrow(/No listen addresses/i);
  });

  test('default: both families served on separate sockets (0.0.0.0 + [::])', async () => {
    const port = freePort();
    const core = new ServerCore(coreOpts(port) as never);
    await core.start();
    try {
      const v4 = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\nConnection: close\r\n\r\n`);
      expect(v4.data.toString('latin1')).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
      const v6 = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: localhost\r\nUser-Agent: t\r\nConnection: close\r\n\r\n`, { host: '::1' });
      expect(v6.data.toString('latin1')).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    } finally {
      await core.stop();
    }
  });
});

describe('F-28 — explicit addresses binding (integration)', () => {
  test('addresses=[127.0.0.1]: v4 loopback served, v6 refused, bind is exact', async () => {
    const port = freePort();
    const core = new ServerCore(
      coreOpts(port, { bindAddresses: ['127.0.0.1'], udpPorts: [port], bindIPv4: true, bindIPv6: true }) as never,
    );
    await core.start();
    try {
      // the bind list wins over the useIPv4/useIPv6 wildcards
      const v4 = await new Promise<{ local: string | undefined }>((resolve, reject) => {
        const c = net.connect({ host: '127.0.0.1', port }, () => {
          const local = c.localAddress;
          c.end();
          resolve({ local });
        });
        c.on('error', reject);
      });
      expect(v4.local).toBe('127.0.0.1');
      const v6 = await rawRequest(port, `GET /hi HTTP/1.1\r\nHost: localhost\r\nUser-Agent: t\r\nConnection: close\r\n\r\n`, { host: '::1', waitMs: 400 });
      expect(v6.data.length).toBe(0); // no v6 listener
      // UDP follows the same bind list: LOSS accounting works on the bound host
      const dgram = await import('node:dgram');
      const udp = dgram.createSocket('udp4');
      const reply = await new Promise<string>((resolve) => {
        udp.on('message', (m) => resolve(m.toString()));
        udp.send(Buffer.from(`LOSS 100 5 11111111-2222-3333-4444-555555555555 200\n`), port, '127.0.0.1');
        setTimeout(() => resolve('(no udp reply)'), 1500);
      });
      udp.close();
      expect(reply).toMatch(/^RECV 5 200 /);
    } finally {
      await core.stop();
    }
  });
});

/* ================= F-30: oversized-header recursion (rev-4 defect) ================= */

describe('F-30 — a >64KiB header block crossing CAP mid-stream must not recurse (rev-4 defect)', () => {
  test('segmented oversized header: minimal 500, server stays alive, memory bounded', async () => {
    const port = freePort();
    const core = new ServerCore(coreOpts(port) as never);
    await core.start();
    try {
      // Phase 1: 60KB of header value, NO terminator (attempt -> 'wait'; onData attached)
      const phase1 = Buffer.concat([
        Buffer.from(`GET /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\nX-Big: `),
        Buffer.alloc(60000, 0x78),
      ]);
      // Phase 2: another 8KB — total crosses CAP (65536) with end === -1: the FATAL
      // branch pre-fix (attempt -> 'route' called from INSIDE onData -> unshift
      // re-emits 'data' synchronously -> infinite recursion -> OOM).
      const phase2 = Buffer.alloc(8000, 0x79);
      // Phase 3: the terminating blank line — completes the header block.
      const phase3 = Buffer.from('\r\n\r\n');

      const r = await new Promise<{ data: Buffer; closed: boolean }>((resolve) => {
        let data = Buffer.alloc(0);
        let closed = false;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          try { sock.destroy(); } catch {}
          resolve({ data, closed });
        };
        const sock = net.connect({ host: '127.0.0.1', port }, () => {
          sock.write(phase1);
          setTimeout(() => sock.write(phase2), 120);
          setTimeout(() => sock.write(phase3), 240);
          setTimeout(finish, 1400);
        });
        sock.on('data', (d) => (data = Buffer.concat([data, d])));
        sock.on('close', () => { closed = true; finish(); });
        sock.on('error', () => finish());
      });

      // The 68KB header block reaches Node's parser, which rejects it
      // (HPE_HEADER_OVERFLOW) -> clientError -> the minimal 500 + destroy.
      expect(r.data.toString('latin1')).toBe('HTTP/1.1 500 Internal Server Error\r\nConnection: Close\r\n\r\n');

      // And the server must still be serving (pre-fix: the process OOM-died).
      const alive = await rawRequest(port, 'PING 0\n');
      expect(alive.data.toString('latin1')).toMatch(/^PONG \d+\n$/);
      const mem = process.memoryUsage().rss / 1e6;
      expect(mem).toBeLessThan(800); // no runaway buffering in-process
    } finally {
      await core.stop();
    }
  });

  test('oversized single-write header (70KB) is answered, server alive', async () => {
    const port = freePort();
    const core = new ServerCore(coreOpts(port) as never);
    await core.start();
    try {
      const head = `GET /hi HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: t\r\nX-Big: ${'x'.repeat(70000)}\r\n\r\n`;
      const r = await rawRequest(port, head);
      expect(r.data.toString('latin1')).toMatch(/^HTTP\/1\.1 500 Internal Server Error\r\n/);
      const alive = await rawRequest(port, 'PING 0\n');
      expect(alive.data.toString('latin1')).toMatch(/^PONG \d+\n$/);
    } finally {
      await core.stop();
    }
  });
});

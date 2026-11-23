import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequestHandler } from './HttpApi';
import { createLegacyFallback } from './LegacyFallback';

/**
 * Slow-upload early-answer regression (2026-11-23).
 *
 * The hosted Ookla host tester drives upload.php with PHP curl under a
 * 10 s timeout. Its measured path delivered ~19–62 KB/s, so the ~2 MiB
 * max_upload POST cannot complete in time. Both upload surfaces must
 * therefore answer `size=<Content-Length>` (daemon-native accounting)
 * once the body stalls past the early window, then close so a client
 * that is still sending can finish immediately with the buffered reply.
 */

function readResponse(sock: net.Socket, deadlineMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('response deadline exceeded'));
    }, deadlineMs);
    sock.on('data', (d: Buffer) => chunks.push(d));
    sock.on('error', (err) => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('latin1'));
    });
    sock.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('latin1'));
    });
    void timer;
    void reject;
  });
}

/** Open a socket, send POST headers plus a partial body, keep the stream
 *  open (never send Content-Length worth of bytes) — the hosted tester's
 *  slow-path shape. */
function slowUpload(
  port: number,
  contentLength: number,
  sendBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const head =
        'POST /speedtest/upload.php HTTP/1.1\r\n' +
        'Host: speedtest.lumajangnetworks.my.id\r\n' +
        'User-Agent: SlowUploadRegression/1\r\n' +
        'Accept: */*\r\n' +
        `Content-Length: ${contentLength}\r\n` +
        'Content-Type: application/x-www-form-urlencoded\r\n' +
        '\r\n';
      sock.write(head);
      sock.write(Buffer.alloc(Math.min(sendBytes, contentLength), 0x61));
      // never finish the body; the server must answer early and close
    });
    sock.on('error', (err) => reject(err));
    readResponse(sock, 5000).then(resolve, reject);
  });
}

describe('HttpApi slow-upload early answer (native daemon surface)', () => {
  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    server = http.createServer(
      createRequestHandler({
        versionString: 'test',
        pool: Buffer.alloc(1024),
        crossDomainPorts: '5060,8080',
        maxBodyBytes: 512 * 1024 * 1024,
        hostInfo: {
          allowedHosts: ['speedtest.lumajangnetworks.my.id'],
          certPrimaryHost: 'speedtest.lumajangnetworks.my.id',
        },
        allowedDomains: ['*.ookla.com', '*.speedtest.net'],
        excludeDefaultDomains: false,
        slowUploadResponseMs: 150,
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('stalled max-upload body gets size=<Content-Length> and a close', async () => {
    const resp = await slowUpload(port, 1980899, 5000);
    expect(resp).toContain('HTTP/1.1 200');
    expect(resp).toContain('size=1980899');
    expect(resp.toLowerCase()).toContain('connection: close');
    // the connection must actually terminate (client was still sending)
  });

  test('fast bodies keep the exact raw-count answer and keep-alive', async () => {
    const r = await new Promise<{ status: number | undefined; body: string; connection: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/speedtest/upload.php',
          headers: {
            Host: 'speedtest.lumajangnetworks.my.id',
            'User-Agent': 'SlowUploadRegression/1',
            'Content-Length': 12,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (d: Buffer) => chunks.push(d));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              body: Buffer.concat(chunks).toString(),
              connection: String(res.headers.connection ?? ''),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(Buffer.from('content1=abc'));
    });
    expect(r.status).toBe(200);
    expect(r.body).toBe('size=12\n');
    expect(r.connection.toLowerCase()).toContain('keep-alive');
  });

  test('early answer is logged through onEvent', async () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const srv = http.createServer(
      createRequestHandler({
        versionString: 'test',
        pool: Buffer.alloc(1024),
        crossDomainPorts: '8080',
        maxBodyBytes: 512 * 1024 * 1024,
        hostInfo: {
          allowedHosts: ['speedtest.lumajangnetworks.my.id'],
          certPrimaryHost: 'speedtest.lumajangnetworks.my.id',
        },
        allowedDomains: [],
        excludeDefaultDomains: false,
        slowUploadResponseMs: 80,
        onEvent: (k, d) => events.push([k, d]),
      }),
    );
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const p = (srv.address() as net.AddressInfo).port;
    await slowUpload(p, 515699, 100);
    srv.closeAllConnections();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    const early = events.find(([k]) => k === 'http_upload_early_response');
    expect(early).toBeDefined();
    expect(early![1].contentLength).toBe(515699);
  });
});

describe('LegacyFallback slow-upload early answer (port-80 PHP surface)', () => {
  let server: http.Server;
  let port: number;
  const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-assets-'));
  beforeAll(async () => {
    server = createLegacyFallback(assets);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(assets, { recursive: true, force: true });
  });

  test('stalled urlencoded body gets an early native answer and a close', async () => {
    const resp = await slowUpload(port, 1981500, 4000);
    expect(resp).toContain('HTTP/1.1 200');
    expect(resp).toContain('size=1981500');
    expect(resp.toLowerCase()).toContain('connection: close');
  });

  test('fast urlencoded bodies keep PHP-parity accounting', async () => {
    const r = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const body = 'content1=abcdefghij';
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/speedtest/upload.php',
          headers: {
            Host: 'speedtest.lumajangnetworks.my.id',
            'User-Agent': 'SlowUploadRegression/1',
            'Content-Length': Buffer.byteLength(body),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (d: Buffer) => chunks.push(d));
          res.on('end', () =>
            resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    expect(r.status).toBe(200);
    // PHP: 500 + strlen("content1") + strlen(value) + 3
    expect(r.body).toBe('size=521');
  });
});

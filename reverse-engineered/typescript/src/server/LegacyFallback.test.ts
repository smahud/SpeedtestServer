import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLegacyFallback } from './LegacyFallback';

describe('port-80 legacy fallback (separate from native daemon)', () => {
  let server: http.Server;
  let dir: string;
  let port: number;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-test-'));
    fs.mkdirSync(path.join(dir, 'speedtest'));
    fs.writeFileSync(path.join(dir, 'speedtest/random350x350.jpg'), Buffer.from([255,216,255,217]));
    server = createLegacyFallback(dir);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as import('node:net').AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true });
  });
  const request = (target: string, body?: Buffer, method?: string) => new Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: target, method: method ?? (body ? 'POST' : 'GET'), headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length } : {} }, res => {
      const chunks: Buffer[] = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks), headers: res.headers }));
    });
    r.on('error', reject);
    r.end(body);
  });
  test.each([[515798,516300],[1980998,1981500]])('legacy upload of %i bytes reports %i', async (size, expected) => {
    const body = Buffer.from('content1=' + 'a'.repeat(size - 9));
    const result = await request('/speedtest/upload.php', body);
    expect(result.status).toBe(200);
    expect(result.body.toString()).toBe(`size=${expected}`);
  });
  test('counts decoded byte lengths and last duplicate form value', async () => {
    const result = await request('/speedtest/upload.php', Buffer.from('a=old&a=%C3%A9&b=hello+world'));
    expect(result.body.toString()).toBe('size=521');
  });
  test('rejects upload beyond configured cap', async () => {
    const result = await request('/speedtest/upload.php', Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(result.status).toBe(413);
  });
  test('counts percent-decoded bytes exactly like PHP strlen, including invalid UTF-8', async () => {
    expect((await request('/speedtest/upload.php', Buffer.from('content1=a%FF'))).body.toString()).toBe('size=513');
  });
  test('percent-encoded maximum upload is accepted without UTF-8 expansion', async () => {
    const result = await request('/speedtest/upload.php', Buffer.from('content1=' + '%FF'.repeat(1980989)));
    expect(result.status).toBe(200);
    expect(result.body.toString()).toBe('size=1981500');
  });
  test('oversized form key with a trailing percent escape returns 400 without crashing', async () => {
    const result = await request('/speedtest/upload.php', Buffer.from('a'.repeat(1024) + '%'));
    expect(result.status).toBe(400);
    expect((await request('/speedtest/latency.txt')).status).toBe(200);
  });
  test('serves actual JPEG bytes with HEAD metadata', async () => {
    const result = await request('/speedtest/random350x350.jpg');
    expect(result.body).toEqual(Buffer.from([255,216,255,217]));
    expect(result.headers['content-type']).toBe('image/jpeg');
    const head = await request('/speedtest/random350x350.jpg', undefined, 'HEAD');
    expect(head.body.length).toBe(0);
    expect(head.headers['content-length']).toBe('4');
  });
  test('latency, crossdomain and unknown paths', async () => {
    expect((await request('/speedtest/latency.txt')).body.toString()).toBe('test=test\n');
    expect((await request('/crossdomain.xml')).body.toString()).toContain('*.speedtest.net');
    expect((await request('/etc/passwd')).status).toBe(404);
    expect((await request('/speedtest/../secret.jpg')).status).toBe(404);
  });
});

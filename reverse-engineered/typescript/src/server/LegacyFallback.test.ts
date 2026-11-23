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
  const request = (target: string, body?: Buffer, method?: string, headers?: Record<string, string>) => new Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const defaultHeaders: Record<string, string> = body !== undefined
      ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(body.length) }
      : {};
    const r = http.request({ host: '127.0.0.1', port, path: target, method: method ?? (body !== undefined ? 'POST' : 'GET'), headers: { ...defaultHeaders, ...(headers ?? {}) } }, res => {
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
  test('body beyond post_max_size still returns 200 with GET-only accounting (PHP semantics)', async () => {
    const result = await request('/speedtest/upload.php', Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(result.status).toBe(200);
    expect(result.body.toString()).toBe('size=500');
  });
  test('counts percent-decoded bytes exactly like PHP strlen, including invalid UTF-8', async () => {
    expect((await request('/speedtest/upload.php', Buffer.from('content1=a%FF'))).body.toString()).toBe('size=513');
  });
  test('percent-encoded maximum upload is accepted without UTF-8 expansion', async () => {
    const result = await request('/speedtest/upload.php', Buffer.from('content1=' + '%FF'.repeat(1980989)));
    expect(result.status).toBe(200);
    expect(result.body.toString()).toBe('size=1981500');
  });
  test('oversized form name is counted in full (no PHP name-length limit)', async () => {
    const result = await request('/speedtest/upload.php', Buffer.from('a'.repeat(1024) + '%'));
    expect(result.status).toBe(200);
    expect(result.body.toString()).toBe(`size=${500 + 1025 + 3}`);
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

  // ---- oracle-verified $_REQUEST semantics (PHP 8.4 + official script) ----
  test('query parameters count toward $_REQUEST (POST body + query merge)', async () => {
    const result = await request('/speedtest/upload.php?abc=def&x=1', Buffer.from('content1=hello'));
    expect(result.body.toString()).toBe('size=530');
  });
  test('POST overrides GET on key collision; other GET fields survive', async () => {
    const result = await request('/speedtest/upload.php?content1=GETVAL&z=9', Buffer.from('content1=POSTVAL'));
    expect(result.body.toString()).toBe('size=523');
  });
  test('non-form content types leave $_POST empty (PHP answers, never 415)', async () => {
    expect((await request('/speedtest/upload.php', Buffer.from('content1=hello'), 'POST', { 'Content-Type': 'text/plain' })).body.toString()).toBe('size=500');
    const noCt = await request('/speedtest/upload.php', Buffer.from('content1=hello'), 'POST', { 'Content-Type': '' });
    expect(noCt.body.toString()).toBe('size=500');
    expect((await request('/speedtest/upload.php?abc=def', Buffer.from('raw'), 'POST', { 'Content-Type': 'application/octet-stream' })).body.toString()).toBe('size=509');
  });
  test('content-type parameters and case do not disable parsing', async () => {
    expect((await request('/speedtest/upload.php', Buffer.from('content1=hello'), 'POST', { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' })).body.toString()).toBe('size=516');
    expect((await request('/speedtest/upload.php', Buffer.from('content1=hello'), 'POST', { 'Content-Type': 'APPLICATION/X-WWW-FORM-URLENCODED' })).body.toString()).toBe('size=516');
  });
  test('multipart scalar fields count; file parts belong to $_FILES and do not', async () => {
    const boundary = '----X';
    const scalar = `--${boundary}\r\nContent-Disposition: form-data; name="content1"\r\n\r\nhello\r\n--${boundary}--\r\n`;
    expect((await request('/speedtest/upload.php', Buffer.from(scalar), 'POST', { 'Content-Type': `multipart/form-data; boundary=${boundary}` })).body.toString()).toBe('size=516');
    const withFile = `--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="x"\r\n\r\nFILECONT\r\n--${boundary}\r\nContent-Disposition: form-data; name="content1"\r\n\r\nhello\r\n--${boundary}--\r\n`;
    expect((await request('/speedtest/upload.php', Buffer.from(withFile), 'POST', { 'Content-Type': `multipart/form-data; boundary=${boundary}` })).body.toString()).toBe('size=516');
  });
  test('the script runs for GET: query fields count, bare GET answers size=500', async () => {
    expect((await request('/speedtest/upload.php?abc=def')).body.toString()).toBe('size=509');
    expect((await request('/speedtest/upload.php')).body.toString()).toBe('size=500');
  });
  test('HEAD on the script returns headers without a body', async () => {
    const head = await request('/speedtest/upload.php?abc=def', undefined, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
  });
  test('array-valued variables reproduce the PHP 8 strlen() fatal as HTTP 500', async () => {
    expect((await request('/speedtest/upload.php', Buffer.from('a[x][y]=1'))).status).toBe(500);
    expect((await request('/speedtest/upload.php?a[b]=1', Buffer.from('b=2'))).status).toBe(500);
  });
  test('non-POST methods parse only the query (PUT/OPTIONS/DELETE run the script)', async () => {
    expect((await request('/speedtest/upload.php?z=9', Buffer.from('content1=hello'), 'PUT')).body.toString()).toBe('size=505');
    expect((await request('/speedtest/upload.php?k=v', undefined, 'DELETE')).body.toString()).toBe('size=505');
  });
  test('100-field hosted-tester payloads return the published verdict values', async () => {
    const build = (wire: number): Buffer => {
      const parts: string[] = [];
      let budget = wire - 199 - (8 * 9 + 9 * 90 + 10);
      for (let i = 1; i <= 100; i++) {
        const vlen = Math.floor(budget / (101 - i));
        budget -= vlen;
        parts.push(`content${i}=` + 'a'.repeat(vlen));
      }
      return Buffer.from(parts.join('&'));
    };
    const upload = build(515699);
    expect(upload.length).toBe(515699);
    expect((await request('/speedtest/upload.php', upload)).body.toString()).toBe('size=516300');
    const max = build(1980899);
    expect(max.length).toBe(1980899);
    expect((await request('/speedtest/upload.php', max)).body.toString()).toBe('size=1981500');
  });
});

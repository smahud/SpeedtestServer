import http from 'node:http';
import { createRequestHandler } from './HttpApi';

/** Fresh original-binary observations: validation/evidence/http-repair-20261123. */
describe('original daemon crossdomain and upload routing', () => {
  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    server = http.createServer(createRequestHandler({
      versionString: 'test', pool: Buffer.alloc(1024), crossDomainPorts: '5060,8080', maxBodyBytes: 4 * 1024 * 1024,
      hostInfo: { allowedHosts: ['speedtest.lumajangnetworks.my.id'], certPrimaryHost: 'speedtest.lumajangnetworks.my.id' },
      allowedDomains: ['*.ookla.com', '*.speedtest.net'], excludeDefaultDomains: false,
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as import('node:net').AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  function request(method: string, target: string, body?: Buffer): Promise<{status: number; body: string; headers: http.IncomingHttpHeaders}> {
    return new Promise((resolve, reject) => {
      const headers: Record<string,string|number> = {Host:'speedtest.lumajangnetworks.my.id', 'User-Agent':'OfficialParityRegression/1', Connection:'close', Origin:'https://www.speedtest.net'};
      if (body) { headers['Content-Length'] = body.length; headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
      const req = http.request({host:'127.0.0.1', port, method, path:target, headers}, res => {
        const chunks: Buffer[] = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => resolve({status:res.statusCode!,body:Buffer.concat(chunks).toString(),headers:res.headers}));
      });
      req.on('error',reject); req.end(body);
    });
  }
  test.each(['/crossdomain.xml','/speedtest/crossdomain.xml','/foo/crossdomain.xml'])('advertises every configured TCP port at %s',async target => {
    const r = await request('GET',target);
    expect(r.status).toBe(200);
    expect(r.body).toContain('to-ports="5060,8080"');
    expect(r.body).not.toContain(`to-ports="${port}"`);
    expect(r.headers['access-control-allow-origin']).toBe('https://www.speedtest.net');
  });
  test.each(['/upload','/speedtest/upload','/foo/upload','/upload.php','/speedtest/upload.php','/foo/upload.php'])('accepts the native upload alias %s', async target => {
    const r = await request('POST',target,Buffer.from('content1=abc'));
    expect(r.status).toBe(200);
    expect(r.body).toBe('size=12\n');
  });
  test.each(['/upload','/speedtest/upload.php','/foo/upload.php'])('OPTIONS on %s is a bodyless 200', async target => {
    const r = await request('OPTIONS',target);
    expect(r.status).toBe(200);
    expect(r.body).toBe('');
    expect(r.headers['content-length']).toBe('0');
  });
  test.each(['/upload.php/','/upload.asp','/not-upload','/CROSSDOMAIN.XML'])('unrecognized route stays 404: %s', async target => {
    expect((await request('POST',target,Buffer.from('x'))).status).toBe(404);
  });
});

/** Web-client (speedtest.net JS engine) surface — verified 2026-11-27 against
 *  PRODUCTION OoklaServer 2.11.5 (XL) & 2.11.7 (Tuxsindo) plus captured real
 *  web runs. See docs/WEB_CLIENT_REVERSE_ENGINEERING_2026-11-26.md. */
describe('web client XHR surface (production-verified 2026-11-27)', () => {
  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    server = http.createServer(createRequestHandler({
      versionString: '2.11 (2.11.5) 2026-06-04.1737.7d0993d', pool: Buffer.alloc(4096),
      crossDomainPorts: '8080', maxBodyBytes: 4 * 1024 * 1024,
      hostInfo: { allowedHosts: ['speedtest.lumajangnetworks.my.id'], certPrimaryHost: 'speedtest.lumajangnetworks.my.id' },
      allowedDomains: ['*.ookla.com', '*.speedtest.net'], excludeDefaultDomains: false,
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as import('node:net').AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  function request(method: string, target: string, body?: Buffer): Promise<{status: number; body: Buffer; headers: http.IncomingHttpHeaders}> {
    return new Promise((resolve, reject) => {
      const headers: Record<string,string|number> = {Host:'speedtest.lumajangnetworks.my.id', 'User-Agent':'OfficialParityRegression/1', Connection:'close', Origin:'https://www.speedtest.net'};
      if (body) { headers['Content-Length'] = body.length; headers['Content-Type'] = 'application/octet-stream'; }
      const req = http.request({host:'127.0.0.1', port, method, path:target, headers}, res => {
        const chunks: Buffer[] = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => resolve({status:res.statusCode!,body:Buffer.concat(chunks),headers:res.headers}));
      });
      req.on('error',reject); req.end(body);
    });
  }

  test('GET /hello is an exact alias of /hi (hello banner + CORS + no-store)', async () => {
    const r = await request('GET','/hello?guid=abc&nocache=def');
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('hello 2.11 (2.11.5) 2026-06-04.1737.7d0993d\n');
    expect(r.headers['content-type']).toBe('text/plain; charset=UTF-8');
    expect(r.headers['content-length']).toBe('44');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['access-control-allow-origin']).toBe('https://www.speedtest.net');
    expect(r.headers['vary']).toBe('Origin');
  });

  test('GET /getip → peer ip line', async () => {
    const r = await request('GET','/getip');
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('127.0.0.1\n');
    expect(r.headers['content-type']).toBe('text/plain; charset=UTF-8');
  });

  test('GET /capabilities → daemon capabilities line (43 bytes)', async () => {
    const r = await request('GET','/capabilities');
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('capabilities SERVER_HOST_AUTH UPLOAD_STATS\n');
    expect(r.headers['content-length']).toBe('43');
  });

  test('GET /ping → lowercase "pong" (5 bytes, no timestamp)', async () => {
    const r = await request('GET','/ping?nocache=x');
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('pong\n');
    expect(r.headers['content-length']).toBe('5');
  });

  test('GET /download?size=N → exactly N octet-stream bytes, exact CL, no-store, CORS', async () => {
    const r = await request('GET','/download?size=2000&guid=g&nocache=n');
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(2000);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['content-length']).toBe('2000');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['access-control-allow-origin']).toBe('https://www.speedtest.net');
  });

  test.each(['/download','/download?size=abc','/download?size=-5'])('missing/unparsable size → Content-Length 0 (documented deviation from the daemon 10 GiB default): %s', async target => {
    const r = await request('GET',target);
    expect(r.status).toBe(200);
    expect(r.headers['content-length']).toBe('0');
    expect(r.body.length).toBe(0);
  });

  test('GET /upload-stats → 400 Bad Request (production-verified; the web client measures via the WS UPLOAD_STATS command)', async () => {
    const r = await request('GET','/upload-stats?testDurationMillis=500&updatePeriodMillis=50&index=0');
    expect(r.status).toBe(400);
    expect(r.body.length).toBe(0);
  });

  test('POST /upload with ?guid= attributes body bytes to the upload session', async () => {
    const { UploadSessionRegistry } = await import('./NetGaugeEngine');
    const sessions = new UploadSessionRegistry();
    const srv = http.createServer(createRequestHandler({
      versionString: 'v', pool: Buffer.alloc(64), crossDomainPorts: '8080', maxBodyBytes: 1024 * 1024,
      hostInfo: { allowedHosts: ['h'], certPrimaryHost: 'h' }, allowedDomains: ['*'], excludeDefaultDomains: false,
      uploadSessions: sessions,
    }));
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
    const p = (srv.address() as import('node:net').AddressInfo).port;
    const guid = '12345678-1234-5678-1234-567812345678';
    const body = Buffer.alloc(700, 0x41);
    const reply = await new Promise<string>((resolve, reject) => {
      const req = http.request({host:'127.0.0.1', port:p, method:'POST', path:`/upload?guid=${guid}&nocache=x`, headers:{Host:'h','User-Agent':'t','Content-Length':String(body.length),'Content-Type':'application/octet-stream'}}, res => {
        let b=''; res.on('data', c=>b+=c); res.on('end',()=>resolve(b));
      });
      req.on('error',reject); req.end(body);
    });
    expect(reply).toBe('size=700\n');
    expect(sessions.get(guid)).toBe(700);
    srv.closeAllConnections();
    await new Promise<void>(resolve => srv.close(() => resolve()));
  });
});

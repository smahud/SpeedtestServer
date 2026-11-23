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

import http from 'node:http';
import { createRequestHandler } from './HttpApi';

describe('HTTP Host validation with wildcard certificate SANs', () => {
  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    server = http.createServer(createRequestHandler({
      versionString: 'lab', pool: Buffer.alloc(1024), crossDomainPorts: '8080', maxBodyBytes: 4 * 1024 * 1024,
      hostInfo: { allowedHosts: ['*.lumajangnetworks.my.id', 'lumajangnetworks.my.id'], certPrimaryHost: '*.lumajangnetworks.my.id' },
      allowedDomains: ['*.ookla.com'], excludeDefaultDomains: false,
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as import('node:net').AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  function request(host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/hi', headers: { Host: host, 'User-Agent': 'HostWildcardRegression/1', Connection: 'close' } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode!));
      });
      req.on('error', reject);
    });
  }
  test.each(['speedtest.lumajangnetworks.my.id', 'speedtest.lumajangnetworks.my.id:8080', 'SPEEDTEST.LUMAJANGNETWORKS.MY.ID', 'lumajangnetworks.my.id'])('serves valid certificate host %s', async host => {
    expect(await request(host)).toBe(200);
  });
  test.each(['x.y.lumajangnetworks.my.id', 'evil-lumajangnetworks.my.id', 'lumajangnetworks.my.id.evil.example', 'totally-unrelated.example'])('does not expand wildcard trust to %s', async host => {
    expect(await request(host)).toBe(307);
  });
});

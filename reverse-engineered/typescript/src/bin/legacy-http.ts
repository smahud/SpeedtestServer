#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createLegacyFallback } from '../server/LegacyFallback';
const assets = process.env.SPEEDTEST_LEGACY_ASSETS ?? '/var/lib/speedtestserver/legacy';
const port = Number(process.env.SPEEDTEST_LEGACY_PORT ?? '80');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid legacy port');
// Fail before binding when the deployment omitted its reference JPEG bundle.
for (const dimension of [350,500,750,1000,1500,2000,2500,3000,3500,4000]) {
  const file = path.join(assets, `speedtest/random${dimension}x${dimension}.jpg`);
  const fd = fs.openSync(file, 'r');
  const header = Buffer.alloc(2);
  try { fs.readSync(fd, header, 0, 2, 0); } finally { fs.closeSync(fd); }
  if (!header.equals(Buffer.from([255,216]))) throw new Error(`Not a JPEG: ${file}`);
}
const server = createLegacyFallback(assets);
server.on('error', err => { console.error(err); process.exitCode = 1; });
server.listen(port, () => console.log(`Legacy fallback listening on ${port}; assets=${assets}`));
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, () => {
  server.close(() => process.exit(0));
  setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5000).unref();
});

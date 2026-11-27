#!/usr/bin/env node
// Isolate: direct worker fetch (no redirect) vs 307 redirect chain.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/z/.npm-global/lib/node_modules/playwright');

const mockHost = 'speedtest.tuxsnet.id.prod.hosts.ooklaserver.net';
const worker = 'https://speedtest-hybrid-worker-test.lumajangnetworks.workers.dev';

const browser = await chromium.launch({
  headless: true,
  args: ['--ignore-certificate-errors', `--host-resolver-rules=MAP ${mockHost} 21.0.9.118`, '--no-sandbox'],
});
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });
await page.goto('https://www.speedtest.net/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
const r = await page.evaluate(async ({ worker, mockHost }) => {
  const out = {};
  // 1. direct to worker (no redirect)
  try {
    const res = await fetch(`${worker}/download?size=1000&guid=diag`, { mode: 'cors' });
    out.workerDirect = { status: res.status, len: res.headers.get('content-length'), acao: res.headers.get('access-control-allow-origin') };
  } catch (e) { out.workerDirect = { error: String(e).slice(0, 150) }; }
  // 2. redirect chain from mock
  try {
    const res = await fetch(`https://${mockHost}:8080/download?size=1000&guid=diag`, { mode: 'cors' });
    out.via307 = { status: res.status, redirected: res.redirected, finalUrl: res.url.slice(0, 140) };
  } catch (e) { out.via307 = { error: String(e).slice(0, 150) }; }
  // 3. redirect with manual redirect mode to see the 307 itself
  try {
    const res = await fetch(`https://${mockHost}:8080/download?size=1000&guid=diag`, { mode: 'cors', redirect: 'manual' });
    out.manual307 = { status: res.status, type: res.type, loc: res.headers.get('location')?.slice(0, 120) };
  } catch (e) { out.manual307 = { error: String(e).slice(0, 150) }; }
  return out;
}, { worker, mockHost });
console.log(JSON.stringify(r, null, 2));
await ctx.close(); await browser.close();

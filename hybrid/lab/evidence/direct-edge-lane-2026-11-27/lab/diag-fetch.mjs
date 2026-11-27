#!/usr/bin/env node
// Quick diagnostic: can a PUBLIC https page XHR-fetch the mock when it maps
// to a PUBLIC IP (PNA-safe) vs loopback (PNA-blocked)?
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/z/.npm-global/lib/node_modules/playwright');

const target = process.argv[2] || '21.0.9.118';
const mockHost = 'speedtest.tuxsnet.id.prod.hosts.ooklaserver.net';

const browser = await chromium.launch({
  headless: true,
  args: [
    '--ignore-certificate-errors',
    `--host-resolver-rules=MAP ${mockHost} ${target}`,
    '--no-sandbox',
  ],
});
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
await page.goto('https://www.speedtest.net/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
const r = await page.evaluate(async (host) => {
  const out = {};
  for (const [name, path] of [['hello', '/hello?guid=diag'], ['ping', '/ping'], ['dl307', '/download?size=1000&guid=diag']]) {
    try {
      const res = await fetch(`https://${host}:8080${path}`, { mode: 'cors' });
      const len = res.headers.get('content-length');
      let body = '';
      try { body = (await res.text()).slice(0, 60); } catch {}
      out[name] = { ok: res.ok, status: res.status, redirected: res.redirected, finalUrl: res.url.slice(0, 120), len, body };
    } catch (e) { out[name] = { error: String(e).slice(0, 120) }; }
  }
  return out;
}, mockHost);
console.log('MAP target:', target);
console.log(JSON.stringify(r, null, 2));
await ctx.close(); await browser.close();

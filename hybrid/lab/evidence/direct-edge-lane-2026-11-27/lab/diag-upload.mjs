#!/usr/bin/env node
// Isolate the upload POST failure: simple POST vs octet-stream POST (preflight)
// vs 307-redirected POST, all from the public speedtest.net page.
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
// trace every :8080 request with its final status
const trace = [];
page.on('request', (r) => { if (r.url().includes(':8080')) trace.push({ ev: 'req', m: r.method(), u: r.url().slice(60, 160) }); });
page.on('requestfailed', (r) => { if (r.url().includes(':8080')) trace.push({ ev: 'FAIL', m: r.method(), u: r.url().slice(60, 160), err: r.failure()?.errorText }); });
page.on('response', (res) => {
  if (res.url().includes(':8080') || res.url().includes('workers.dev')) {
    trace.push({ ev: 'res', m: res.request().method(), u: res.url().slice(60, 160), status: res.status(), redirected: res.url() !== res.request().url() });
  }
});
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300)); });
await page.goto('https://www.speedtest.net/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
const r = await page.evaluate(async ({ mockHost, worker }) => {
  const out = {};
  const blob = new Blob([new Uint8Array(1000).fill(65)], { type: 'application/octet-stream' });
  // 1. simple POST (text/plain, no preflight)
  try {
    const res = await fetch(`https://${mockHost}:8080/upload?guid=diag1`, { method: 'POST', body: 'hello=1', mode: 'cors' });
    out.simplePost = { status: res.status, body: (await res.text()).slice(0, 40) };
  } catch (e) { out.simplePost = { error: String(e).slice(0, 120) }; }
  // 2. octet-stream POST (preflight) — the SDK's exact shape
  try {
    const res = await fetch(`https://${mockHost}:8080/upload?guid=diag2`, { method: 'POST', body: blob, mode: 'cors' });
    out.octetPost = { status: res.status, body: (await res.text()).slice(0, 40), redirected: res.redirected, finalUrl: res.url.slice(0, 120) };
  } catch (e) { out.octetPost = { error: String(e).slice(0, 120) }; }
  // 3. direct octet-stream POST to the worker (no redirect)
  try {
    const res = await fetch(`${worker}/upload?guid=diag3`, { method: 'POST', body: blob, mode: 'cors' });
    out.workerPost = { status: res.status, body: (await res.text()).slice(0, 40) };
  } catch (e) { out.workerPost = { error: String(e).slice(0, 120) }; }
  // 4. XHR-style (the SDK uses XHR, not fetch)
  out.xhrPost = await new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://${mockHost}:8080/upload?guid=diag4`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.responseType = 'text';
    xhr.onload = () => resolve({ status: xhr.status, body: String(xhr.responseText).slice(0, 40) });
    xhr.onerror = () => resolve({ error: 'XHR onerror' });
    xhr.send(blob);
  });
  return out;
}, { mockHost, worker });
console.log(JSON.stringify(r, null, 2));
console.log("=== TRACE ==="); for (const t of trace) console.log(JSON.stringify(t)); await ctx.close(); await browser.close();

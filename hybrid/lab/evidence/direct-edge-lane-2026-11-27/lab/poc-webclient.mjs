#!/usr/bin/env node
/**
 * poc-webclient.mjs — E2E proof of the DIRECT LANE with the OFFICIAL
 * speedtest.net web client (unmodified Ookla page + engine, real browser).
 *
 * Method (equivalent of the CLI lab's hosts-mock, adapted for the browser):
 *   - Chromium --host-resolver-rules maps the PUBLISHED Ookla server host
 *     (speedtest.tuxsnet.id.prod.hosts.ooklaserver.net, server 66281) to
 *     127.0.0.1 where poc-vps-role.mjs plays the VPS role.
 *   - --ignore-certificate-errors: the mock's self-signed cert is accepted
 *     (lab-only, exactly like the CLI lab's namespace+bind-mount hosts).
 *   - Discovery/API stay 100% authentic (www.speedtest.net untouched).
 *   - The heavy XHRs are 307-handed-off to the real Cloudflare Worker.
 *
 * Captured evidence:
 *   - every request/response (final URL after redirects + redirect chain),
 *     byte sizes per host, WebSocket frames,
 *   - the SDK's result payload (POST /api/results.php) with the official
 *     measured download/upload speeds,
 *   - the VPS-role's SIGUSR2 summary (control-plane bytes only).
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/z/.npm-global/lib/node_modules/playwright');

const OUT = process.argv[2] || '/home/z/my-project/lab/poc-run.jsonl';
const MOCK_HOST = process.env.MOCK_HOST || 'speedtest.tuxsnet.id.prod.hosts.ooklaserver.net';
const MOCK_IP = process.env.MOCK_IP || '21.0.9.118'; // PUBLIC sandbox IP — Chromium PNA blocks public→loopback XHRs
const SERVER_URL = process.env.SERVER_URL || 'https://www.speedtest.net/server/66281';
const WAIT_MS = Number(process.env.WAIT_MS || 100_000);

const fs = await import('fs');
const out = fs.createWriteStream(OUT);
const t0 = Date.now();
const log = (obj) => out.write(JSON.stringify({ ms: Date.now() - t0, ...obj }) + '\n');

// ---- per-host byte accounting (browser side) ------------------------------
const perHost = {}; // host -> { reqs, dlBytes, ulBytes, redirects }
function bump(host, key, n) {
  perHost[host] = perHost[host] || { reqs: 0, dlBytes: 0, ulBytes: 0, redirects: 0, wsFrames: 0, wsBytesIn: 0, wsBytesOut: 0 };
  perHost[host][key] += n;
}
const hostOf = (u) => { try { return new URL(u).host; } catch { return '?'; } };

let resultPayload = null;

function attach(page) {
  page.on('request', (r) => {
    const h = hostOf(r.url());
    bump(h, 'reqs', 1);
    if (r.method() === 'POST' && r.url().includes('api/results.php')) {
      try { resultPayload = r.postData(); } catch { /* streaming */ }
      log({ t: 'results_post', bytes: resultPayload ? resultPayload.length : null });
    }
    if (r.method() === 'POST') {
      const cl = Number(r.headers()['content-length'] || 0);
      if (cl) bump(h, 'ulBytes', cl);
    }
    if (r.url().includes(':8080')) log({ t: 'req', method: r.method(), url: r.url().slice(0, 200) });
  });
  page.on('requestfailed', (r) => {
    if (r.url().includes(':8080') || r.url().includes('workers.dev'))
      log({ t: 'reqfail', url: r.url().slice(0, 200), err: r.failure()?.errorText });
  });
  page.on('response', async (res) => {
    const h = hostOf(res.url());
    const req = res.request();
    // count the DOWNLOAD direction by content-length of the final response
    const cl = Number(res.headers()['content-length'] || 0);
    if ((req.method() === 'GET' || req.method() === 'HEAD') && cl > 1000) bump(h, 'dlBytes', cl);
    if (res.url().includes(':8080') || res.url().includes('workers.dev')) {
      const redirected = res.url() !== req.url() || !!req.redirectedFrom();
      if (redirected) bump(h, 'redirects', 1);
      log({
        t: 'res', status: res.status(), host: h, path: new URL(res.url()).pathname,
        cl, redirected,
        loc: (res.headers()['location'] || '').slice(0, 140),
        acao: res.headers()['access-control-allow-origin'] || '',
      });
    }
  });
  page.on('websocket', (ws) => {
    const h = hostOf(ws.url());
    log({ t: 'ws-open', url: ws.url().slice(0, 160) });
    ws.on('framesent', (f) => {
      bump(h, 'wsFrames', 1); bump(h, 'wsBytesOut', f.payload.length);
      const s = f.payload.toString('latin1').slice(0, 40);
      log({ t: 'ws-tx', host: h, bin: f.payload instanceof Buffer, head: s.replace(/[^\x20-\x7e]/g, '.') });
    });
    ws.on('framereceived', (f) => {
      bump(h, 'wsFrames', 1); bump(h, 'wsBytesIn', f.payload.length);
      const s = f.payload.toString('latin1').slice(0, 40);
      log({ t: 'ws-rx', host: h, bin: f.payload instanceof Buffer, head: s.replace(/[^\x20-\x7e]/g, '.') });
    });
    ws.on('close', () => log({ t: 'ws-close', host: h }));
  });
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--ignore-certificate-errors',
    `--host-resolver-rules=MAP ${MOCK_HOST} ${MOCK_IP}, MAP speedtest.tuxsnet.id ${MOCK_IP}`,
    '--no-sandbox',
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1366, height: 900 },
  locale: 'en-US',
  ignoreHTTPSErrors: true,
});
const page = await ctx.newPage();
attach(page);

try {
  log({ t: 'step', msg: 'navigating ' + SERVER_URL });
  await page.goto(SERVER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  // consent overlay
  for (const sel of ['button:has-text("ACCEPT")', 'button:has-text("I ACCEPT")', '#onetrust-accept-btn-handler']) {
    const btn = page.locator(sel).first();
    if (await btn.count() && await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      log({ t: 'step', msg: 'consent clicked' });
      await page.waitForTimeout(1500);
      break;
    }
  }

  // GO
  const go = page.locator('button[aria-label^="start speed test"], .start-btn a, a[aria-label*="start" i]').first();
  await go.waitFor({ state: 'visible', timeout: 40000 });
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(800);
  try { await go.click({ timeout: 8000 }); }
  catch { await go.click({ force: true, timeout: 8000 }); }
  log({ t: 'step', msg: 'GO clicked' });

  // wait for the run to complete (result payload posted)
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && !resultPayload) await page.waitForTimeout(2000);
  await page.waitForTimeout(4000);

  const state = await page.evaluate(() => ({
    url: location.href,
    gauge: (document.querySelector('.speed-container, .gauge-speed-container, .result-data')?.textContent || '')
      .replace(/\s+/g, ' ').trim().slice(0, 300),
  })).catch(() => ({}));
  log({ t: 'final_state', state, gotResultPayload: !!resultPayload });
} catch (e) {
  log({ t: 'fatal', msg: String(e.message).slice(0, 400) });
}

// ask the VPS-role for its summary
try { process.kill(Number(process.env.VPS_ROLE_PID || 0), 'SIGUSR2'); } catch {}

const hosts = Object.fromEntries(
  Object.entries(perHost).map(([h, v]) => [h, v]).sort((a, b) => b[1].dlBytes + b[1].ulBytes - (a[1].dlBytes + a[1].ulBytes)),
);
log({ t: 'per_host_summary', hosts });

if (resultPayload) fs.writeFileSync(OUT.replace(/\.jsonl$/, '') + '.result-payload.json', resultPayload);

await ctx.close();
await browser.close();
out.end();

// console summary
console.log('=== PER-HOST (browser side) ===');
for (const [h, v] of Object.entries(hosts)) {
  console.log(`${h}  reqs=${v.reqs} dl=${(v.dlBytes / 1e6).toFixed(1)}MB ul=${(v.ulBytes / 1e6).toFixed(1)}MB wsFrames=${v.wsFrames} redirects=${v.redirects}`);
}
console.log('result payload captured:', !!resultPayload);
console.log('done →', OUT);

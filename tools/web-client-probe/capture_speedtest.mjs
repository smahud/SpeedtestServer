// Capture speedtest.net end-to-end network behavior (auto + manual server selection).
// Usage: node capture_speedtest.mjs <phase: auto|manual> <outfile> [manual_server_name]
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/z/.npm-global/lib/node_modules/playwright');

const phase = process.argv[2] || 'auto';
const outfile = process.argv[3];
const manualName = process.argv[4] || '';
const fs = await import('fs');
const out = fs.createWriteStream(outfile);
const t0 = Date.now();
const log = (obj) => out.write(JSON.stringify({ ms: Date.now() - t0, ...obj }) + '\n');
const trunc = (s, n = 400) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) + `…(${s.length}B)` : s) : s);

const SMALL_BODY_HOSTS = /:8080|speedtest\.net/;
const HEADER_KEYS = ['x-cors-token', 'access-control-allow-origin', 'access-control-allow-headers',
  'content-type', 'content-length', 'server', 'location', 'x-ookla', 'cache-control'];

function attach(page, tag) {
  page.on('console', m => log({ t: 'console', tag, level: m.type(), text: trunc(m.text(), 300) }));
  page.on('request', r => {
    const entry = { t: 'req', tag, method: r.method(), url: trunc(r.url(), 600) };
    if (r.method() === 'POST') {
      try {
        const pd = r.postData();
        if (pd !== null) {
          if (r.url().includes('results.php')) {
            entry.postData = pd; // full payload — this is the result record
          } else if (pd.length > 600) {
            entry.postData = trunc(pd, 500) + `…(${pd.length}B total)`;
          } else {
            entry.postData = pd;
          }
        }
        entry.hasPostData = r.hasPostData?.() ?? undefined;
      } catch { /* postData unavailable for streaming bodies */ }
    }
    log(entry);
  });
  page.on('requestfailed', r => log({ t: 'reqfail', tag, url: trunc(r.url(), 400), err: r.failure()?.errorText }));
  page.on('response', async (res) => {
    const url = res.url();
    const headers = {};
    for (const [k, v] of Object.entries(res.headers())) {
      if (HEADER_KEYS.includes(k)) headers[k] = trunc(v, 200);
    }
    const entry = { t: 'res', tag, status: res.status(), url: trunc(url, 600), headers };
    // small text bodies only (protocol-level responses)
    if (/api\/js\/(config-sdk|servers)|results\.php|:8080\/(hello|getip|capabilities|ping|upload-stats)(\?|$)/.test(url)) {
      const ct = (headers['content-type'] || '') + '';
      if (/text|json|application\/x/.test(ct) || !ct) {
        try {
          const body = await res.text();
          entry.body = trunc(body, 400);
        } catch { /* body unavailable */ }
      }
    }
    log(entry);
  });
  page.on('websocket', ws => {
    log({ t: 'ws-open', tag, url: trunc(ws.url(), 400) });
    ws.on('framesent', f => log({ t: 'ws-tx', tag, url: trunc(ws.url(), 200), bin: f.payload instanceof Buffer, payload: trunc(f.payload?.toString?.('utf-8') ?? String(f.payload), 300) }));
    ws.on('framereceived', f => log({ t: 'ws-rx', tag, url: trunc(ws.url(), 200), bin: f.payload instanceof Buffer, payload: trunc(f.payload?.toString?.('utf-8') ?? String(f.payload), 300) }));
    ws.on('close', () => log({ t: 'ws-close', tag, url: trunc(ws.url(), 200) }));
  });
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-US' });
const page = await ctx.newPage();
attach(page, phase);

try {
  await page.goto('https://www.speedtest.net/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  log({ t: 'step', msg: 'page loaded' });
  await page.waitForTimeout(4000);

  // consent overlay (Ziff Davis) — click accept if present
  for (const sel of ['button:has-text("ACCEPT")', 'button:has-text("I ACCEPT")', '#onetrust-accept-btn-handler']) {
    const btn = page.locator(sel).first();
    if (await btn.count() && await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      log({ t: 'step', msg: 'consent clicked', sel });
      await page.waitForTimeout(1500);
      break;
    }
  }

  if (phase === 'manual' || phase === 'manualui') {
    // UI flow: open "Change Server" popup, search Surabaya
    const change = page.locator('button:has-text("Change Server")').locator('visible=true').first();
    await change.waitFor({ state: 'visible', timeout: 30000 });
    await change.click();
    log({ t: 'step', msg: 'change-server clicked (UI)' });
    await page.waitForTimeout(2500);
    const input = page.locator('input[placeholder*="earch"], input[type="search"], .server-search input').first();
    if (await input.isVisible().catch(() => false)) {
      await input.fill('Surabaya');
      log({ t: 'step', msg: 'searched Surabaya in popup' });
      await page.waitForTimeout(4000);
    } else {
      log({ t: 'err', msg: 'popup search input not found' });
    }
    if (phase === 'manual') {
      // pick the target server row, then GO (normal click — same as a real user)
      const target = manualName || 'somedigit.net';
      const row = page.locator(`div.MuiListItemButton-root:has-text("${target}")`).first();
      let picked = false;
      if (await row.count()) {
        picked = await row.click({ timeout: 10000 }).then(() => true).catch(() => false);
      }
      if (!picked) {
        log({ t: 'err', msg: `row ${target} not clickable; trying XLSMART` });
        const alt = page.locator('div.MuiListItemButton-root:has-text("PT XLSMART")').first();
        if (await alt.count()) picked = await alt.click({ timeout: 10000 }).then(() => true).catch(() => false);
      }
      log({ t: 'step', msg: picked ? 'server row picked: ' + target : 'server row pick FAILED', });
      await page.waitForTimeout(2500);
    } else {
      const close = page.locator('[aria-label="Close"], button:has-text("Close")').first();
      if (await close.isVisible().catch(() => false)) { await close.click().catch(() => {}); log({ t: 'step', msg: 'popup closed (no GO — light probe)' }); }
    }
  }

  if (phase === 'manualui') {
    await page.waitForTimeout(3000);
  } else {
    // click GO
    const go = page.locator('button[aria-label^="start speed test"], .start-btn a, a[aria-label*="start" i]').locator('visible=true').first();
    await go.waitFor({ state: 'visible', timeout: 30000 });
    log({ t: 'step', msg: 'GO visible' });
    // dismiss any overlay (consent/modal) that might intercept the click
    await page.keyboard.press('Escape').catch(() => {});
    for (const sel of ['button:has-text("ACCEPT")', 'button:has-text("I ACCEPT")', '#onetrust-accept-btn-handler']) {
      const btn = page.locator(sel).first();
      if (await btn.count() && await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        log({ t: 'step', msg: 'consent clicked (2nd)', sel });
        break;
      }
    }
    await page.waitForTimeout(800);
    try {
      await go.click({ timeout: 8000 });
    } catch {
      await go.click({ force: true, timeout: 8000 }).catch(e => log({ t: 'err', msg: 'GO force click failed: ' + e.message.slice(0, 120) }));
      log({ t: 'step', msg: 'GO force-clicked' });
    }
    log({ t: 'step', msg: 'GO clicked' });

    // watch progress: run to completion for the manual phase (need results.php payload)
    const waitMs = phase === 'manual' ? 75000 : 25000;
    await page.waitForTimeout(waitMs);
  }
  const state = await page.evaluate(() => ({
    title: document.title,
    bodyHasSpeed: /Mbps|ms|ping/i.test(document.body.innerText.slice(0, 4000)),
    gaugeText: (document.querySelector('.speed-container, .gauge-speed-container, .result-data')?.textContent || '').trim().slice(0, 200),
  })).catch(e => ({ err: e.message }));
  log({ t: 'step', msg: 'state after 25s', state });
  await page.waitForTimeout(10000);
} catch (e) {
  log({ t: 'fatal', msg: e.message.slice(0, 500) });
}
await ctx.close();
await browser.close();
out.end();
console.log('done', phase, outfile);

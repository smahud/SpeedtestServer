#!/usr/bin/env node
/**
 * measure-real-edge.mjs — B2 real-edge CPU/invocation measurement battery.
 *
 * Runs a labelled sequence of load points against a deployed hybrid Worker
 * (test env: open mode, caps 32 MiB) and then aggregates per-invocation CPU
 * time quantiles from the Workers Analytics GraphQL API for each time window.
 *
 * Env:
 *   MEASURE_BASE     base URL of the worker (default: test worker on workers.dev)
 *   MEASURE_SCRIPT   script name in analytics (default speedtest-hybrid-worker-test)
 *   MEASURE_OUT      output dir (default hybrid/lab/evidence/e-j-real-edge)
 *   CLOUDFLARE_API_TOKEN   token with Workers Analytics read
 *   CF_ACCOUNT_TAG   account id
 *
 * Output: <MEASURE_OUT>/measure-real-edge-<UTC stamp>.json (+ prints summary)
 * No secrets are written to the output.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const BASE = process.env.MEASURE_BASE || 'https://speedtest-hybrid-worker-test.lumajangnetworks.workers.dev';
const SCRIPT = process.env.MEASURE_SCRIPT || 'speedtest-hybrid-worker-test';
const OUT = process.env.MEASURE_OUT || '/opt/SpeedtestServer-src/hybrid/lab/evidence/e-j-real-edge';
const TOK = process.env.CLOUDFLARE_API_TOKEN || '';
const ACCT = process.env.CF_ACCOUNT_TAG || '';
const WS_BASE = BASE.replace(/^http/, 'ws');

if (!TOK || !ACCT) {
  console.error('need CLOUDFLARE_API_TOKEN and CF_ACCOUNT_TAG');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const MiB = (n) => n * 1048576;

/** ws session helper (same pattern as test/conformance.mjs). */
function wsSession() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_BASE + '/ws');
    ws.binaryType = 'arraybuffer';
    const queue = [];
    const waiters = [];
    ws.addEventListener('message', (ev) => {
      const item = typeof ev.data === 'string' ? { type: 'text', data: ev.data } : { type: 'binary', data: new Uint8Array(ev.data) };
      if (waiters.length) waiters.shift()(item);
      else queue.push(item);
    });
    ws.addEventListener('open', () =>
      resolve({
        ws,
        sendText: (s) => ws.send(s),
        sendBinary: (b) => ws.send(b),
        next: (timeoutMs = 30000) =>
          new Promise((res, rej) => {
            if (queue.length) return res(queue.shift());
            const t = setTimeout(() => rej(new Error('timeout waiting for ws message')), timeoutMs);
            waiters.push((item) => {
              clearTimeout(t);
              res(item);
            });
          }),
      }),
    );
    ws.addEventListener('error', () => reject(new Error('ws error')));
    setTimeout(() => reject(new Error('ws open timeout')), 15000);
  });
}
async function textMessage(sess, timeoutMs = 30000) {
  const m = await sess.next(timeoutMs);
  if (m.type !== 'text') throw new Error('expected text message, got binary');
  return m.data.endsWith('\n') ? m.data.slice(0, -1) : m.data;
}

/** One HTTP GET __down invocation. */
async function httpDown(bytes) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/__down?bytes=${bytes}`);
  let got = 0;
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
  }
  return { wallMs: Date.now() - t0, status: r.status, bytes: got, ok: r.status === 200 && got === bytes };
}

/** One HTTP POST __up invocation with a K-byte random body. */
async function httpUp(bytes) {
  const t0 = Date.now();
  const body = Buffer.allocUnsafe(bytes);
  for (let off = 0; off < bytes; off += 65536) randomBytes(Math.min(65536, bytes - off)).copy(body, off);
  const r = await fetch(`${BASE}/__up`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body });
  const txt = await r.text();
  let receipt = null;
  try { receipt = JSON.parse(txt); } catch {}
  return { wallMs: Date.now() - t0, status: r.status, bytes: receipt ? receipt.bytes : -1, ok: r.status === 200 && receipt && receipt.bytes === bytes, body: r.status === 200 ? undefined : txt.slice(0, 120) };
}

/** One WS DOWNLOAD invocation (HI then DOWNLOAD N). */
async function wsDown(bytes, timeoutMs = 120000) {
  const t0 = Date.now();
  const s = await wsSession();
  s.sendText('HI\n');
  await textMessage(s, 15000);
  s.sendText(`DOWNLOAD ${bytes}\n`);
  let total = 0;
  while (total < bytes) {
    const m = await s.next(timeoutMs);
    if (m.type !== 'binary') throw new Error('expected binary frame, got ' + m.type);
    total += m.data.length;
  }
  s.ws.close();
  return { wallMs: Date.now() - t0, status: 200, bytes: total, ok: total === bytes };
}

/** One WS UPLOAD invocation (UPLOAD N then payload, expect OK N <ms>). */
async function wsUp(bytes, timeoutMs = 120000) {
  const t0 = Date.now();
  const s = await wsSession();
  s.sendText('HI\n');
  await textMessage(s, 15000);
  const cmd = `UPLOAD ${bytes}\n`;
  s.sendText(cmd);
  let sent = cmd.length;
  const chunk = Buffer.alloc(65536, 0x61);
  while (sent < bytes) {
    const n = Math.min(65536, bytes - sent);
    s.sendBinary(n === 65536 ? chunk : chunk.subarray(0, n));
    sent += n;
    if (sent % (4 * 1048576) < 65536) await sleep(5); // light pacing, avoid burst drops
  }
  const ok = await textMessage(s, timeoutMs);
  s.ws.close();
  const m = /^OK (\d+) (\d+)$/.exec(ok);
  return { wallMs: Date.now() - t0, status: m ? 200 : 0, bytes: m ? Number(m[1]) : -1, ok: !!m && Number(m[1]) === bytes, body: m ? undefined : ok.slice(0, 120) };
}

/** Run one labelled test point: k invocations of fn. */
async function runPoint(label, k, fn, gapMs = 400) {
  const invocations = [];
  const start = nowIso();
  for (let i = 0; i < k; i++) {
    try {
      const r = await fn();
      invocations.push({ i, ...r });
      console.log(`  ${label} #${i + 1}/${k} ${r.ok ? 'OK' : 'FAIL'} ${r.wallMs}ms status=${r.status} bytes=${r.bytes}${r.body ? ' body=' + r.body : ''}`);
    } catch (e) {
      invocations.push({ i, error: String(e && e.message || e).slice(0, 160) });
      console.log(`  ${label} #${i + 1}/${k} ERROR ${invocations[invocations.length - 1].error}`);
    }
    if (i < k - 1) await sleep(gapMs);
  }
  const end = nowIso();
  return { label, start, end, invocations, clientOk: invocations.filter((x) => x.ok).length, clientTotal: k };
}

async function graphql(query) {
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOK}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (j.errors) throw new Error('graphql: ' + JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

/** Aggregate analytics rows per test window. */
async function analyticsFor(rangeStart, rangeEnd) {
  const q = `query {
    viewer {
      accounts(filter: {accountTag: "${ACCT}"}) {
        workersInvocationsAdaptive(limit: 2000,
          filter: {datetime_geq: "${rangeStart}", datetime_leq: "${rangeEnd}", scriptName: "${SCRIPT}"},
          orderBy: [datetime_ASC]) {
          dimensions { datetime status }
          quantiles { cpuTimeP50 cpuTimeP99 }
          sum { requests errors }
        }
      }
    }
  }`;
  const data = await graphql(q);
  return data.viewer.accounts[0].workersInvocationsAdaptive;
}

const batteryStart = nowIso();
console.log(`measure-real-edge start ${batteryStart} target=${BASE} script=${SCRIPT}`);

const tests = [];
// 1. cold-start probe: small downloads spaced out to catch isolate spins.
tests.push(await runPoint('cold-small', 10, () => httpDown(1000), 11000));
// 2. HTTP __down 1/4/16/25 MiB
tests.push(await runPoint('http-down-1mib', 5, () => httpDown(MiB(1))));
tests.push(await runPoint('http-down-4mib', 5, () => httpDown(MiB(4))));
tests.push(await runPoint('http-down-16mib', 3, () => httpDown(MiB(16))));
tests.push(await runPoint('http-down-25mib', 3, () => httpDown(MiB(25))));
// 3. HTTP __up 4/16/25 MiB
tests.push(await runPoint('http-up-4mib', 3, () => httpUp(MiB(4))));
tests.push(await runPoint('http-up-16mib', 3, () => httpUp(MiB(16))));
tests.push(await runPoint('http-up-25mib', 3, () => httpUp(MiB(25))));
// 4. WS DOWNLOAD 4/8/32 MiB
tests.push(await runPoint('ws-down-4mib', 3, () => wsDown(MiB(4))));
tests.push(await runPoint('ws-down-8mib', 3, () => wsDown(MiB(8))));
tests.push(await runPoint('ws-down-32mib', 2, () => wsDown(MiB(32))));
// 5. WS UPLOAD 4/16/25 MiB
tests.push(await runPoint('ws-up-4mib', 3, () => wsUp(MiB(4))));
tests.push(await runPoint('ws-up-16mib', 2, () => wsUp(MiB(16))));
tests.push(await runPoint('ws-up-25mib', 2, () => wsUp(MiB(25))));

const batteryEnd = nowIso();
console.log(`battery done ${batteryEnd}; waiting 90s for analytics ingestion...`);
await sleep(90000);

const rows = await analyticsFor(new Date(Date.parse(batteryStart) - 4000).toISOString(), new Date(Date.parse(batteryEnd) + 4000).toISOString());
console.log(`analytics rows: ${rows.length}`);

// map each row to the test whose window contains it
for (const t of tests) {
  const s = Date.parse(t.start) - 500;
  const e = Date.parse(t.end) + 500;
  t.analytics = rows
    .filter((r) => { const d = Date.parse(r.dimensions.datetime); return d >= s && d <= e; })
    .map((r) => ({
      second: r.dimensions.datetime,
      status: r.dimensions.status,
      requests: r.sum.requests,
      errors: r.sum.errors,
      cpuP50us: r.quantiles.cpuTimeP50,
      cpuP99us: r.quantiles.cpuTimeP99,
    }));
  t.analyticsSummary = {
    requests: t.analytics.reduce((a, r) => a + r.requests, 0),
    errors: t.analytics.reduce((a, r) => a + r.errors, 0),
    statuses: [...new Set(t.analytics.map((r) => r.status))],
    cpuP50us_max: Math.max(0, ...t.analytics.map((r) => r.cpuP50us ?? 0)),
    cpuP99us_max: Math.max(0, ...t.analytics.map((r) => r.cpuP99us ?? 0)),
  };
}

const result = {
  meta: {
    measuredAt: batteryStart,
    base: BASE,
    script: SCRIPT,
    coloHint: 'client VPS 45.126.249.250 (SIN edge)',
    analyticsSource: 'Workers Analytics GraphQL workersInvocationsAdaptive',
    note: 'cpuP50/P99 in microseconds, per-second quantiles aggregated per window (max taken)',
  },
  tests,
};
const stamp = batteryStart.replace(/[:.]/g, '-');
const outFile = `${OUT}/measure-real-edge-${stamp}.json`;
writeFileSync(outFile, JSON.stringify(result, null, 2));

// summary table
console.log('\n=== SUMMARY (client | analytics) ===');
console.log('label              clientOK  reqs  errs  cpuP50max(us)  cpuP99max(us)  statuses');
for (const t of tests) {
  const a = t.analyticsSummary;
  console.log(
    `${t.label.padEnd(18)} ${String(t.clientOk).padStart(4)}/${String(t.clientTotal).padStart(2)} ${String(a.requests).padStart(5)} ${String(a.errors).padStart(5)} ${String(a.cpuP50us_max).padStart(14)} ${String(a.cpuP99us_max).padStart(14)}  ${a.statuses.join(',')}`,
  );
}
console.log(`\nwritten: ${outFile}`);

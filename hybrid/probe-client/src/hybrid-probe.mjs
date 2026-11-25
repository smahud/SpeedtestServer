#!/usr/bin/env node
/**
 * hybrid-probe.mjs — the hybrid session instrument (E-I/E-J).
 *
 * Executes ONE complete hybrid speedtest session and accounts every byte
 * per endpoint class, proving where the payload actually flows:
 *
 *   1. GET  {gateway}/api/servers     (VPS: discovery)          → vpsBytes
 *   2. POST {gateway}/api/sessions    (VPS: session token)      → vpsBytes
 *   3. ping {gateway}/api/ping ×N     (VPS: latency TTFB)       → vpsBytes
 *   4. ping {worker}/__down?bytes=0   (edge: comparative TTFB)  → edgeBytes
 *   5. transfer phase — mode-dependent (G-11):
 *        PROBE_MODE=ws   (default) N parallel WS NetGauge sessions
 *                        HI <uuid> → DOWNLOAD <size> / UPLOAD <n> loops
 *        PROBE_MODE=http N parallel HTTP chunk requests
 *                        GET __down?bytes=K (Bearer) / POST __up (K-byte body)
 *   6. POST {gateway}/api/results     (VPS: result intake)      → vpsBytes
 *
 * Worker RECEIPTS are captured (G-11): every `__up` response body
 * (`{bytes:N}`) and every WS UPLOAD ack (`OK n <ts>`) is kept in the
 * evidence JSON under `receipts`, alongside per-phase byte accounting.
 *
 * Output: JSON evidence with per-phase byte accounting, durations,
 * throughput per phase, and the offload ratio.
 *
 * Env:
 *   HYBRID_GATEWAY_BASE   default http://127.0.0.1:8090
 *   HYBRID_WORKER_BASE    default http://127.0.0.1:8790
 *   PROBE_MODE            ws | http | both   (default ws)
 *   PROBE_DL_CONNS        default 6      (CLI-observed: 4–32 dynamic)
 *   PROBE_DL_BYTES        default 8388608 (8 MiB per connection)
 *   PROBE_UL_CONNS        default 4      (CLI-observed: 6–8)
 *   PROBE_UL_BYTES        default 2097152 (2 MiB per connection)
 *   PROBE_HTTP_CHUNK      default 16777216 (16 MiB per HTTP chunk request)
 *   PROBE_PINGS           default 10
 *   PROBE_LABEL           label for the evidence record
 */

const GATEWAY = process.env.HYBRID_GATEWAY_BASE || 'http://127.0.0.1:8090';
const WORKER = process.env.HYBRID_WORKER_BASE || 'http://127.0.0.1:8790';
const MODE = (process.env.PROBE_MODE || 'ws').toLowerCase();
const DL_CONNS = Number(process.env.PROBE_DL_CONNS || 6);
const DL_BYTES = Number(process.env.PROBE_DL_BYTES || 8 * 1024 * 1024);
const UL_CONNS = Number(process.env.PROBE_UL_CONNS || 4);
const UL_BYTES = Number(process.env.PROBE_UL_BYTES || 2 * 1024 * 1024);
const HTTP_CHUNK = Number(process.env.PROBE_HTTP_CHUNK || 16 * 1024 * 1024);
const PINGS = Number(process.env.PROBE_PINGS || 10);
const LABEL = process.env.PROBE_LABEL || 'hybrid-session';

const accounting = {
  vps: { requests: 0, bytesIn: 0, bytesOut: 0 },
  edge: { requests: 0, bytesIn: 0, bytesOut: 0, wsSessions: 0 },
};

/** G-11: worker receipts — authoritative edge-side byte confirmations. */
const receipts = { up: [], downMeta: [], wsAcks: [] };

const phases = [];

async function httpJson(base, path, opts = {}) {
  const t0 = performance.now();
  const r = await fetch(base + path, opts);
  const text = await r.text();
  const bucket = base === GATEWAY ? accounting.vps : accounting.edge;
  bucket.requests++;
  bucket.bytesIn += text.length;
  bucket.bytesOut += (opts.body ? String(opts.body).length : 0) + path.length + 128;
  return { status: r.status, json: JSON.parse(text), ms: performance.now() - t0 };
}

function wsSession(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const queue = [];
    const waiters = [];
    // BUG FIX (2026-11-25): a timed-out waiter used to stay in the list and
    // swallow the NEXT message into the dead promise — desyncing the whole
    // session. Timeouts now remove their waiter before rejecting.
    ws.addEventListener('message', (ev) => {
      const item = typeof ev.data === 'string' ? { text: ev.data } : { bin: new Uint8Array(ev.data) };
      if (waiters.length) waiters.shift()(item);
      else queue.push(item);
    });
    // BUG FIX: the open-timeout timer kept firing into a settled promise —
    // cleared on open/error now.
    let settled = false;
    let openTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('probe: ws open timeout'));
      }
    }, 8000);
    const clearOpenTimer = () => {
      if (openTimer) {
        clearTimeout(openTimer);
        openTimer = null;
      }
    };
    ws.addEventListener('open', () => {
      clearOpenTimer();
      if (settled) return;
      settled = true;
      resolve({
        ws,
        sendText: (s) => ws.send(s),
        sendBinary: (b) => ws.send(b),
        next: (timeoutMs = 15000) =>
          new Promise((res, rej) => {
            if (queue.length) return res(queue.shift());
            let waiter = null;
            const t = setTimeout(() => {
              const idx = waiter ? waiters.indexOf(waiter) : -1;
              if (idx !== -1) waiters.splice(idx, 1); // remove the stale waiter
              rej(new Error('probe: ws message timeout'));
            }, timeoutMs);
            waiter = (item) => {
              clearTimeout(t);
              res(item);
            };
            waiters.push(waiter);
          }),
        close: () => ws.close(),
      });
    });
    ws.addEventListener('error', () => {
      clearOpenTimer();
      if (!settled) {
        settled = true;
        reject(new Error('probe: ws error'));
      }
    });
  });
}

/** One download worker (WS): HI <uuid> then DOWNLOAD loops until target bytes. */
async function downloadWorkerWs(url, token, uuid, targetBytes, result) {
  const s = await wsSession(url);
  accounting.edge.wsSessions++;
  s.sendText(`HI ${uuid}\n`);
  const hello = (await s.next()).text;
  if (!hello.startsWith('HELLO')) throw new Error('no HELLO: ' + hello);
  let received = 0;
  const CMD = 4 * 1024 * 1024;
  while (received < targetBytes) {
    const want = Math.min(CMD, targetBytes - received);
    s.sendText(`DOWNLOAD ${want}\n`);
    let got = 0;
    while (got < want) {
      const m = await s.next(30000);
      if (m.bin === undefined) throw new Error('expected binary frame');
      got += m.bin.length;
      received += m.bin.length;
    }
  }
  accounting.edge.bytesIn += received;
  result.bytes = received;
  s.sendText('QUIT\n');
  await s.next(2000).catch(() => null);
  s.close();
}

/** One upload worker (WS): HI <uuid> then UPLOAD frames until target bytes. */
async function uploadWorkerWs(url, token, uuid, targetBytes, result) {
  const s = await wsSession(url);
  accounting.edge.wsSessions++;
  s.sendText(`HI ${uuid}\n`);
  const hello = (await s.next()).text;
  if (!hello.startsWith('HELLO')) throw new Error('no HELLO: ' + hello);
  let sent = 0;
  const CMD = 1024 * 1024; // 1 MiB per UPLOAD command (≤25 MB guidance)
  const FRAME = 64 * 1024;
  const payload = new Uint8Array(FRAME);
  crypto.getRandomValues(payload);
  while (sent < targetBytes) {
    const want = Math.min(CMD, targetBytes - sent);
    const cmd = `UPLOAD ${want}\n`;
    s.sendText(cmd);
    let payloadRemaining = want - cmd.length; // inclusive counting
    while (payloadRemaining > 0) {
      const n = Math.min(FRAME, payloadRemaining);
      s.sendBinary(payload.subarray(0, n));
      payloadRemaining -= n;
    }
    const ok = await s.next(30000);
    if (!ok.text || !ok.text.startsWith(`OK ${want}`)) throw new Error('upload not acked: ' + JSON.stringify(ok.text));
    receipts.wsAcks.push({ declared: want, ack: ok.text.trim() }); // G-11 receipt
    sent += want;
  }
  accounting.edge.bytesOut += sent;
  result.bytes = sent;
  s.close();
}

/** HTTP-chunk download: GET __down?bytes=K with Bearer, count exact bytes. */
async function downloadHttp(token, targetBytes, result) {
  let received = 0;
  const chunk = Math.min(HTTP_CHUNK, targetBytes);
  while (received < targetBytes) {
    const want = Math.min(chunk, targetBytes - received);
    const r = await fetch(`${WORKER}/__down?bytes=${want}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (r.status !== 200) throw new Error(`__down ${r.status}: ${await r.text()}`);
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
    }
    accounting.edge.requests++;
  }
  accounting.edge.bytesIn += received;
  result.bytes = received;
  result.chunks = Math.ceil(targetBytes / chunk);
}

/** HTTP-chunk upload: POST __up with K-byte random bodies; keep receipts. */
async function uploadHttp(token, targetBytes, result) {
  const chunk = Math.min(HTTP_CHUNK, targetBytes);
  const payload = new Uint8Array(chunk);
  for (let off = 0; off < chunk; off += 65536) {
    crypto.getRandomValues(payload.subarray(off, Math.min(off + 65536, chunk))); // 64 KiB getRandomValues cap
  }
  let sent = 0;
  let chunkId = 0;
  while (sent < targetBytes) {
    const n = Math.min(chunk, targetBytes - sent);
    const body = n === chunk ? payload : payload.subarray(0, n);
    const r = await fetch(`${WORKER}/__up`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body,
    });
    if (r.status !== 200) throw new Error(`__up ${r.status}: ${await r.text()}`);
    const j = await r.json();
    receipts.up.push({ chunkId, sent: n, receiptBytes: j.bytes, status: r.status }); // G-11 receipt
    if (j.bytes !== n) throw new Error(`receipt mismatch: sent ${n} got ${j.bytes}`);
    sent += n;
    chunkId++;
    accounting.edge.requests++;
  }
  accounting.edge.bytesOut += sent;
  result.bytes = sent;
  result.chunks = chunkId;
}

async function main() {
  const t0 = performance.now();
  const report = { label: LABEL, mode: MODE, startedAt: new Date().toISOString(), gateway: GATEWAY, worker: WORKER };

  // 1. discovery
  let phase = { phase: 'discovery-vps' };
  {
    const t = performance.now();
    const r = await httpJson(GATEWAY, '/api/servers');
    phase.ms = Math.round(performance.now() - t);
    phase.status = r.status;
    phase.roles = Object.keys(r.json.roles || {});
    phase.hasFallback = Boolean(r.json.roles?.throughput?.fallback); // G-3: must be absent
  }
  phases.push(phase);

  // 2. session token
  phase = { phase: 'session-token-vps' };
  let token = null;
  let guid = null;
  {
    const t = performance.now();
    const r = await httpJson(GATEWAY, '/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client: 'hybrid-probe/1.1', label: LABEL }),
    });
    phase.ms = Math.round(performance.now() - t);
    phase.status = r.status;
    token = r.json.token || null;
    guid = r.json.guid || null;
  }
  phases.push(phase);
  if (!token) {
    console.error('no session token — is the gateway started with HYBRID_SHARED_SECRET?');
    process.exit(2);
  }

  // 3. VPS latency (TTFB)
  phase = { phase: 'latency-vps' };
  {
    const t = performance.now();
    const samples = [];
    for (let i = 0; i < PINGS; i++) {
      const pt = performance.now();
      const r = await fetch(GATEWAY + '/api/ping', { cache: 'no-store' });
      await r.text();
      samples.push(performance.now() - pt);
    }
    phase.ms = Math.round(performance.now() - t);
    phase.samples = samples.map((x) => +x.toFixed(2));
    phase.min = +Math.min(...samples).toFixed(2);
    phase.median = +samples.slice().sort((a, b) => a - b)[Math.floor(samples.length / 2)].toFixed(2);
    accounting.vps.requests += PINGS;
    accounting.vps.bytesIn += PINGS * 16;
  }
  phases.push(phase);

  // 4. edge TTFB (comparative) — bytes=0 with Bearer
  phase = { phase: 'latency-edge-ttfb' };
  {
    const t = performance.now();
    const samples = [];
    for (let i = 0; i < PINGS; i++) {
      const pt = performance.now();
      const r = await fetch(WORKER + '/__down?bytes=0', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      await r.arrayBuffer();
      samples.push(performance.now() - pt);
    }
    phase.ms = Math.round(performance.now() - t);
    phase.samples = samples.map((x) => +x.toFixed(2));
    phase.min = +Math.min(...samples).toFixed(2);
    accounting.edge.requests += PINGS;
  }
  phases.push(phase);

  // 5+6. transfer phases per mode
  if (MODE === 'ws' || MODE === 'both') {
    {
      const p = { phase: 'download-edge-ws', connections: DL_CONNS, perConnection: DL_BYTES };
      const t = performance.now();
      const results = Array.from({ length: DL_CONNS }, () => ({}));
      const uuid = guid || crypto.randomUUID();
      await Promise.all(
        Array.from({ length: DL_CONNS }, (_, i) =>
          downloadWorkerWs(`${WORKER}/ws?token=${encodeURIComponent(token)}`, token, uuid, DL_BYTES, results[i]),
        ),
      );
      p.ms = Math.round(performance.now() - t);
      p.bytes = results.reduce((a, r) => a + (r.bytes || 0), 0);
      p.throughputMBps = +(p.bytes / 1048576 / (p.ms / 1000)).toFixed(2);
      p.throughputMbps = +((p.bytes * 8) / 1e6 / (p.ms / 1000)).toFixed(1);
      phases.push(p);
    }
    {
      const p = { phase: 'upload-edge-ws', connections: UL_CONNS, perConnection: UL_BYTES };
      const t = performance.now();
      const results = Array.from({ length: UL_CONNS }, () => ({}));
      const uuid = guid || crypto.randomUUID();
      await Promise.all(
        Array.from({ length: UL_CONNS }, (_, i) =>
          uploadWorkerWs(`${WORKER}/ws?token=${encodeURIComponent(token)}`, token, uuid, UL_BYTES, results[i]),
        ),
      );
      p.ms = Math.round(performance.now() - t);
      p.bytes = results.reduce((a, r) => a + (r.bytes || 0), 0);
      p.throughputMBps = +(p.bytes / 1048576 / (p.ms / 1000)).toFixed(2);
      p.throughputMbps = +((p.bytes * 8) / 1e6 / (p.ms / 1000)).toFixed(1);
      phases.push(p);
    }
  }
  if (MODE === 'http' || MODE === 'both') {
    {
      const p = { phase: 'download-edge-http', perRequest: HTTP_CHUNK };
      const t = performance.now();
      const result = {};
      await downloadHttp(token, DL_BYTES * DL_CONNS, result);
      p.ms = Math.round(performance.now() - t);
      p.bytes = result.bytes;
      p.chunks = result.chunks;
      p.throughputMBps = +(p.bytes / 1048576 / (p.ms / 1000)).toFixed(2);
      p.throughputMbps = +((p.bytes * 8) / 1e6 / (p.ms / 1000)).toFixed(1);
      phases.push(p);
    }
    {
      const p = { phase: 'upload-edge-http', perRequest: HTTP_CHUNK };
      const t = performance.now();
      const result = {};
      await uploadHttp(token, UL_BYTES * UL_CONNS, result);
      p.ms = Math.round(performance.now() - t);
      p.bytes = result.bytes;
      p.chunks = result.chunks;
      p.throughputMBps = +(p.bytes / 1048576 / (p.ms / 1000)).toFixed(2);
      p.throughputMbps = +((p.bytes * 8) / 1e6 / (p.ms / 1000)).toFixed(1);
      phases.push(p);
    }
  }

  // 7. result intake on the VPS
  phase = { phase: 'result-intake-vps' };
  {
    const t = performance.now();
    const r = await httpJson(GATEWAY, '/api/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        guid,
        metrics: {
          vpsLatencyMs: phases.find((p) => p.phase === 'latency-vps')?.median,
          edgeTtfbMs: phases.find((p) => p.phase === 'latency-edge-ttfb')?.min,
          downloadMbps: phases.find((p) => p.phase === 'download-edge-ws')?.throughputMbps ?? phases.find((p) => p.phase === 'download-edge-http')?.throughputMbps,
          uploadMbps: phases.find((p) => p.phase === 'upload-edge-ws')?.throughputMbps ?? phases.find((p) => p.phase === 'upload-edge-http')?.throughputMbps,
        },
        accounting,
        receipts: { upCount: receipts.up.length, wsAckCount: receipts.wsAcks.length, upBytesConfirmed: receipts.up.reduce((a, r) => a + r.receiptBytes, 0) },
        client: { name: 'hybrid-probe/1.1', label: LABEL, mode: MODE },
      }),
    });
    phase.ms = Math.round(performance.now() - t);
    phase.status = r.status;
    phase.ok = r.json.ok;
  }
  phases.push(phase);

  // G-9: replay the same result → same response, not re-persisted
  const replay = await httpJson(GATEWAY, '/api/results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, guid, metrics: { replay: true }, client: { name: 'hybrid-probe/1.1-replay' } }),
  });
  phases.push({ phase: 'result-replay-vps', status: replay.status, ok: replay.json.ok, sameGuid: replay.json.guid === guid });

  const totalMs = Math.round(performance.now() - t0);
  const vpsBytes = accounting.vps.bytesIn + accounting.vps.bytesOut;
  const edgeBytes = accounting.edge.bytesIn + accounting.edge.bytesOut;
  const payloadBytes =
    (phases.find((p) => p.phase === 'download-edge-ws')?.bytes || 0) +
    (phases.find((p) => p.phase === 'upload-edge-ws')?.bytes || 0) +
    (phases.find((p) => p.phase === 'download-edge-http')?.bytes || 0) +
    (phases.find((p) => p.phase === 'upload-edge-http')?.bytes || 0);

  const evidence = {
    ...report,
    totalMs,
    phases,
    accounting,
    receipts,
    summary: {
      vpsBytes,
      edgeBytes,
      payloadBytes,
      receiptConfirmedUploadBytes: receipts.up.reduce((a, r) => a + r.receiptBytes, 0) || null,
      vpsShareOfPayload: +(vpsBytes / (vpsBytes + edgeBytes)).toFixed(6),
      offloadRatio: +(payloadBytes / Math.max(1, vpsBytes)).toFixed(1),
      interpretation:
        'payloadBytes flowed client↔edge (Worker); the VPS served only the control plane ' +
        `(discovery+token+pings+results = ${vpsBytes} B). Offload ratio: 1:${(payloadBytes / Math.max(1, vpsBytes)).toFixed(0)} (payload/control bytes).`,
    },
  };

  const out = process.env.PROBE_OUT || `e-i-hybrid-session-${Date.now()}.json`;
  const fs = await import('node:fs');
  fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence.summary, null, 2));
  console.error(`phases: ${phases.map((p) => `${p.phase}=${p.ms ?? '-'}ms`).join(' · ')}`);
  console.error(`evidence → ${out}`);
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});

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
 *   5. N parallel WS NetGauge sessions to {worker}/ws:
 *        HI <uuid> → DOWNLOAD <size> loops                      → edgeBytes
 *   6. M parallel WS NetGauge upload sessions:
 *        HI <uuid> → UPLOAD <n> + payload frames                → edgeBytes
 *   7. POST {gateway}/api/results     (VPS: result intake)      → vpsBytes
 *
 * Output: JSON evidence with per-phase byte accounting, durations,
 * throughput per phase, and the offload ratio.
 *
 * Env:
 *   HYBRID_GATEWAY_BASE   default http://127.0.0.1:8090
 *   HYBRID_WORKER_BASE    default http://127.0.0.1:8790
 *   PROBE_DL_CONNS        default 6      (CLI-observed: 4–32 dynamic)
 *   PROBE_DL_BYTES        default 8388608 (8 MiB per connection)
 *   PROBE_UL_CONNS        default 4      (CLI-observed: 6–8)
 *   PROBE_UL_BYTES        default 2097152 (2 MiB per connection)
 *   PROBE_PINGS           default 10
 *   PROBE_LABEL           label for the evidence record
 */

const GATEWAY = process.env.HYBRID_GATEWAY_BASE || 'http://127.0.0.1:8090';
const WORKER = process.env.HYBRID_WORKER_BASE || 'http://127.0.0.1:8790';
const DL_CONNS = Number(process.env.PROBE_DL_CONNS || 6);
const DL_BYTES = Number(process.env.PROBE_DL_BYTES || 8 * 1024 * 1024);
const UL_CONNS = Number(process.env.PROBE_UL_CONNS || 4);
const UL_BYTES = Number(process.env.PROBE_UL_BYTES || 2 * 1024 * 1024);
const PINGS = Number(process.env.PROBE_PINGS || 10);
const LABEL = process.env.PROBE_LABEL || 'hybrid-session';

const accounting = {
  vps: { requests: 0, bytesIn: 0, bytesOut: 0 },
  edge: { requests: 0, bytesIn: 0, bytesOut: 0, wsSessions: 0 },
};

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
    ws.addEventListener('message', (ev) => {
      const item = typeof ev.data === 'string' ? { text: ev.data } : { bin: new Uint8Array(ev.data) };
      if (waiters.length) waiters.shift()(item);
      else queue.push(item);
    });
    ws.addEventListener('open', () =>
      resolve({
        ws,
        sendText: (s) => ws.send(s),
        sendBinary: (b) => ws.send(b),
        next: (timeoutMs = 15000) =>
          new Promise((res, rej) => {
            if (queue.length) return res(queue.shift());
            const t = setTimeout(() => rej(new Error('probe: ws message timeout')), timeoutMs);
            waiters.push((item) => {
              clearTimeout(t);
              res(item);
            });
          }),
        close: () => ws.close(),
      }),
    );
    ws.addEventListener('error', () => reject(new Error('probe: ws error')));
    setTimeout(() => reject(new Error('probe: ws open timeout')), 8000);
  });
}

/** One download worker: HI <uuid> then DOWNLOAD loops until target bytes. */
async function downloadWorker(url, token, uuid, targetBytes, result) {
  const s = await wsSession(url);
  accounting.edge.wsSessions++;
  s.sendText(`HI ${uuid}\n`);
  const hello = (await s.next()).text;
  if (!hello.startsWith('HELLO')) throw new Error('no HELLO: ' + hello);
  let received = 0;
  // Chunked DOWNLOAD commands like the CLI (~32 MB per command cap; we use
  // smaller chunks so progress is granular).
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

/** One upload worker: HI <uuid> then UPLOAD frames until target bytes. */
async function uploadWorker(url, token, uuid, targetBytes, result) {
  const s = await wsSession(url);
  accounting.edge.wsSessions++;
  s.sendText(`HI ${uuid}\n`);
  const hello = (await s.next()).text;
  if (!hello.startsWith('HELLO')) throw new Error('no HELLO: ' + hello);
  let sent = 0;
  const CMD = 1024 * 1024; // 1 MiB per UPLOAD command (chunked, ≤25 MB guidance)
  const FRAME = 64 * 1024;
  const payload = new Uint8Array(FRAME);
  crypto.getRandomValues(payload);
  while (sent < targetBytes) {
    const want = Math.min(CMD, targetBytes - sent);
    const cmd = `UPLOAD ${want}\n`;
    s.sendText(cmd);
    // command line counts toward the declared total (inclusive counting)
    let payloadRemaining = want - cmd.length;
    while (payloadRemaining > 0) {
      const n = Math.min(FRAME, payloadRemaining);
      s.sendBinary(payload.subarray(0, n));
      payloadRemaining -= n;
    }
    const ok = await s.next(30000);
    if (!ok.text || !ok.text.startsWith(`OK ${want}`)) throw new Error('upload not acked: ' + JSON.stringify(ok.text));
    sent += want;
  }
  accounting.edge.bytesOut += sent;
  result.bytes = sent;
  s.close();
}

async function main() {
  const t0 = performance.now();
  const report = { label: LABEL, startedAt: new Date().toISOString(), gateway: GATEWAY, worker: WORKER };

  // 1. discovery
  let phase = { phase: 'discovery-vps' };
  {
    const t = performance.now();
    const r = await httpJson(GATEWAY, '/api/servers');
    phase.ms = Math.round(performance.now() - t);
    phase.status = r.status;
    phase.roles = Object.keys(r.json.roles || {});
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
      body: JSON.stringify({ client: 'hybrid-probe/1.0', label: LABEL }),
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

  // 4. edge TTFB (comparative)
  phase = { phase: 'latency-edge-ttfb' };
  {
    const t = performance.now();
    const samples = [];
    for (let i = 0; i < PINGS; i++) {
      const pt = performance.now();
      const r = await fetch(WORKER + '/__down?bytes=0&token=' + encodeURIComponent(token), { cache: 'no-store' });
      await r.arrayBuffer();
      samples.push(performance.now() - pt);
    }
    phase.ms = Math.round(performance.now() - t);
    phase.samples = samples.map((x) => +x.toFixed(2));
    phase.min = +Math.min(...samples).toFixed(2);
    accounting.edge.requests += PINGS;
  }
  phases.push(phase);

  // 5. download via WS NetGauge at the edge
  phase = { phase: 'download-edge-ws', connections: DL_CONNS, perConnection: DL_BYTES };
  {
    const t = performance.now();
    const results = Array.from({ length: DL_CONNS }, () => ({}));
    const dlUuid = guid || crypto.randomUUID();
    await Promise.all(
      Array.from({ length: DL_CONNS }, (_, i) =>
        downloadWorker(`${WORKER}/ws?token=${encodeURIComponent(token)}`, token, dlUuid, DL_BYTES, results[i]),
      ),
    );
    phase.ms = Math.round(performance.now() - t);
    phase.bytes = results.reduce((a, r) => a + (r.bytes || 0), 0);
    phase.throughputMBps = +(phase.bytes / 1048576 / (phase.ms / 1000)).toFixed(2);
    phase.throughputMbps = +((phase.bytes * 8) / 1e6 / (phase.ms / 1000)).toFixed(1);
  }
  phases.push(phase);

  // 6. upload via WS NetGauge at the edge
  phase = { phase: 'upload-edge-ws', connections: UL_CONNS, perConnection: UL_BYTES };
  {
    const t = performance.now();
    const results = Array.from({ length: UL_CONNS }, () => ({}));
    const ulUuid = guid || crypto.randomUUID();
    await Promise.all(
      Array.from({ length: UL_CONNS }, (_, i) =>
        uploadWorker(`${WORKER}/ws?token=${encodeURIComponent(token)}`, token, ulUuid, UL_BYTES, results[i]),
      ),
    );
    phase.ms = Math.round(performance.now() - t);
    phase.bytes = results.reduce((a, r) => a + (r.bytes || 0), 0);
    phase.throughputMBps = +(phase.bytes / 1048576 / (phase.ms / 1000)).toFixed(2);
    phase.throughputMbps = +((phase.bytes * 8) / 1e6 / (phase.ms / 1000)).toFixed(1);
  }
  phases.push(phase);

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
          downloadMbps: phases.find((p) => p.phase === 'download-edge-ws')?.throughputMbps,
          uploadMbps: phases.find((p) => p.phase === 'upload-edge-ws')?.throughputMbps,
        },
        accounting,
        client: { name: 'hybrid-probe/1.0', label: LABEL },
      }),
    });
    phase.ms = Math.round(performance.now() - t);
    phase.status = r.status;
    phase.ok = r.json.ok;
  }
  phases.push(phase);

  const totalMs = Math.round(performance.now() - t0);
  const vpsBytes = accounting.vps.bytesIn + accounting.vps.bytesOut;
  const edgeBytes = accounting.edge.bytesIn + accounting.edge.bytesOut;
  const payloadBytes = phases.find((p) => p.phase === 'download-edge-ws')?.bytes + phases.find((p) => p.phase === 'upload-edge-ws')?.bytes;

  const evidence = {
    ...report,
    totalMs,
    phases,
    accounting,
    summary: {
      vpsBytes,
      edgeBytes,
      payloadBytes,
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
  console.error(`phases: ${phases.map((p) => `${p.phase}=${p.ms}ms`).join(' · ')}`);
  console.error(`evidence → ${out}`);
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});

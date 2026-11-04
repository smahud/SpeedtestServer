#!/usr/bin/env node
/**
 * analyze-run.mjs — atribusi pasca-run untuk satu eksperimen diversion.
 *
 * Input  : dir evidence berisi diverter.jsonl, proxy.jsonl, cli.json, cli.stderr,
 *          sts-evidence.jsonl (opsional), daemon-access.log (opsional)
 * Output : analysis.txt (manusia) + analysis.json (mesin) di dir yang sama.
 *
 * Menjawab, dengan bukti per baris log:
 *   - Apakah CLI menyelesaikan semua fase? (exit code, latency/download/upload/loss)
 *   - Koneksi mana yang dilayani backend mana? (routing + alasan + byte)
 *   - Fase mana (seleksi/loss/ping/download/upload/UDP) dilayani siapa?
 *   - Apakah volume byte backend konsisten dengan volume yang dilaporkan CLI?
 *   - Apakah jaminan non-publishing terpenuhi? (persisted=false + blocked)
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const rd = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } };
const jl = (f) => (rd(f) || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const div = jl('diverter.jsonl');
const proxy = jl('proxy.jsonl');
const sts = jl('sts-evidence.jsonl');
let cli = null; try { cli = JSON.parse(rd('cli.json')); } catch {}
const stderr = rd('cli.stderr') || '';

// ---------- CLI outcome
const outcome = { exit: null, type: null, latency: null, jitter: null, download: null, upload: null, packetLoss: null, persisted: null, server: null };
{
  const m = stderr.match(/exit=(\d+)/); outcome.exit = m ? +m[1] : null;
  if (cli) {
    outcome.type = cli.type || null;
    if (cli.type === 'log') outcome.isLogOnly = true;
    const l = cli.ping || cli.latency || {}; const d = cli.download || {}; const u = cli.upload || {}; const pl = cli.packetLoss ?? cli.packet_loss ?? null;
    outcome.latency = l.latency ?? (Object.keys(l).length ? l : null);
    outcome.jitter = l.jitter ?? null;
    outcome.download = Object.prototype.hasOwnProperty.call(d, 'bandwidth') ? d : (Object.keys(d).length ? d : null);
    outcome.upload = Object.prototype.hasOwnProperty.call(u, 'bandwidth') ? u : (Object.keys(u).length ? u : null);
    outcome.packetLoss = pl;
    outcome.persisted = cli.result ? cli.result.persisted : null;
    outcome.server = cli.server ? `${cli.server.host}:${cli.server.port} id=${cli.server.id} name=${cli.server.name || ''}` : null;
  }
}
const phasesPresent = {
  latency: !!(outcome.latency),
  download: !!(outcome.download && (outcome.download.bandwidth || outcome.download.bytes)),
  upload: !!(outcome.upload && (outcome.upload.bandwidth || outcome.upload.bytes)),
  packetLoss: outcome.packetLoss !== null && outcome.packetLoss !== undefined,
};

// ---------- proxy facts
const proxyFacts = {
  configServed: proxy.filter((e) => e.k === 'config_served').length,
  blocked: proxy.filter((e) => e.k === 'blocked').map((e) => e.target),
  tunnels: [...new Set(proxy.filter((e) => e.k === 'tunnel').map((e) => e.target))],
  rewritten: proxy.find((e) => e.k === 'config_served')?.rewritten?.map((r) => r.id) || [],
};

// ---------- diverter connection map
const conns = new Map();
for (const e of div) {
  if (e.k === 'conn_open') conns.set(e.id, { id: e.id, peer: e.peer, openRt: e.rt, closeRt: null, backend: null, reason: null, bytesC2B: null, bytesB2C: null, cmds: [], replayed: null });
  const c = conns.get(e.id); if (!c) continue;
  if (e.k === 'conn_route') { c.backend = e.backend; c.reason = e.reason; c.replayed = e.replayed; c.prefixBackend = e.prefix_backend; }
  else if (e.k === 'conn_cmd') c.cmds.push(e.line);
  else if (e.k === 'conn_close') { c.closeRt = e.rt; c.bytesC2B = e.bytesCli2Be; c.bytesB2C = e.bytesBe2Cli; }
}
const connList = [...conns.values()].sort((x, y) => x.openRt - y.openRt);
for (const c of connList) {
  const first = c.cmds.find((x) => !x.startsWith('«BIN'));
  c.encHello = c.cmds.some((x) => x.startsWith('«BIN'));
  c.uuid = (c.cmds.find((x) => /^HI [0-9a-f-]{36}/i.test(x)) || '').slice(3) || null;
  const has = (p) => c.cmds.some((x) => x.startsWith(p));
  // perintah fase menang atas deteksi biner (payload UPLOAD acak juga ter-log «BIN»)
  if (has('INITPLOSS') || has('PLOSS')) c.phase = 'loss';
  else if (has('DOWNLOAD')) c.phase = 'download';
  else if (has('UPLOAD')) c.phase = has('UPLOAD_STATS') ? 'upload-control' : 'upload';
  else if (has('UPLOAD_STATS') || has('CAPABILITIES')) c.phase = 'upload-control';
  else if (c.encHello) c.phase = 'selection-probe(encrypted)';
  else if (has('PING')) c.phase = c.closeRt !== null && (c.closeRt - c.openRt) < 500 ? 'selection-probe(plaintext)' : 'ping-monitor';
  else if (first && first.startsWith('HI')) c.phase = c.closeRt !== null && (c.closeRt - c.openRt) < 500 ? 'selection-probe(plaintext)' : 'handshake-only';
  else if ((c.bytesC2B || 0) === 0 && (c.bytesB2C || 0) === 0) c.phase = 'zero-byte';
  else c.phase = 'other';
}

// ---------- phase attribution (dari peta koneksi)
const phaseAttr = {};
const addPhase = (name, c) => { (phaseAttr[name] = phaseAttr[name] || []).push({ conn: c.id, backend: c.backend, bytesC2B: c.bytesC2B, bytesB2C: c.bytesB2C }); };
for (const c of connList) addPhase(c.phase, c);

// ---------- UDP attribution
const udpMaps = div.filter((e) => e.k === 'udp_map');
const udpCliToBe = div.filter((e) => e.k === 'udp_datagram' && (e.dir === 'cli→be' || e.dir === 'drop')).length;
const udpBeToCli = div.filter((e) => e.k === 'udp_datagram' && e.dir === 'be→cli').length;
const udpHeads = div.filter((e) => e.k === 'udp_datagram' && e.dir === 'cli→be').slice(0, 3).map((e) => e.head.slice(0, 40));
const udpFacts = { clients: udpMaps.map((e) => ({ client: e.client, backend: e.backend })), cliToBe: udpCliToBe, beToCli: udpBeToCli, sampleHeads: udpHeads };

// ---------- backend B (STS) corroboration
const stsFacts = sts.length ? {
  netgaugeConns: sts.filter((e) => e.k === 'conn_netgauge').length,
  commands: sts.filter((e) => e.k === 'ng_cmd').length,
  downloadsDone: sts.filter((e) => e.k === 'ng_download_done').length,
  uploadsDone: sts.filter((e) => e.k === 'ng_upload_done').length,
  udpRecv: sts.filter((e) => e.k === 'udp_recv').length,
  udpCount: sts.filter((e) => e.k === 'udp_count').length,
  bytesSent: sts.filter((e) => e.k === 'ng_download_done').reduce((s, e) => s + (e.bytes || 0), 0),
} : { note: 'tidak ada evidence STS (backend B tidak menerima koneksi / tidak dijalankan)' };

// ---------- backend A (daemon) corroboration
const dlog = rd('daemon-access.log') || '';
const daemonFacts = dlog ? {
  tcpUptimeLines: (dlog.match(/TCP uptime/g) || []).length,
  lastCounts: (dlog.match(/TCP uptime: \d+ - total current: \d+, queued: \d+, blocked: \d+, queueFull: \d+, concurrent: (\d+), currentThreads: (\d+)/g) || []).slice(-3),
  mismatchUdp: (dlog.match(/Mismatch address[^\n]*/g) || []).length,
  disconnectExceptions: (dlog.match(/Disconnect Exception[^\n]*/g) || []).slice(0, 3),
} : { note: 'log daemon tidak tersedia' };

// ---------- volume consistency
const vol = { diverterBytes: { A: 0, B: 0 } };
for (const c of connList) if (c.backend === 'A' || c.backend === 'B') vol.diverterBytes[c.backend] += (c.bytesB2C || 0); // be→cli = payload yang diterima client
if (cli) {
  vol.cliDownloadBytes = cli.download?.bytes ?? null;
  vol.cliUploadBytes = cli.upload?.bytes ?? null;
}

// ---------- verdict
const allPhases = phasesPresent.latency && phasesPresent.download && phasesPresent.upload && phasesPresent.packetLoss;
const nonPublishing = outcome.persisted === false && proxyFacts.blocked.length > 0;
const backendsUsed = [...new Set(connList.map((c) => c.backend))];
const verdict = {
  cli_exit: outcome.exit,
  complete: outcome.exit === 0 && allPhases,
  non_publishing: nonPublishing,
  backends_used: backendsUsed,
  diverted: backendsUsed.length > 1 || (udpFacts.clients[0] && udpFacts.clients.some((u) => u.backend !== backendsUsed[0])),
};

// ---------- output
const A = { outcome, phasesPresent, proxyFacts, connections: connList.map((c) => ({ id: c.id, phase: c.phase, backend: c.backend, reason: c.reason, encHello: c.encHello, uuid: !!c.uuid, bytesC2B: c.bytesC2B, bytesB2C: c.bytesB2C, durMs: c.closeRt !== null ? c.closeRt - c.openRt : null })), phaseAttribution: phaseAttr, udpFacts, stsFacts, daemonFacts, volume: vol, verdict };
fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify(A, null, 2));

const W = process.stdout;
W.write(`# analysis — ${path.basename(dir)}\n`);
W.write(`CLI exit=${outcome.exit} type=${outcome.type} | server: ${outcome.server || '?'}\n`);
W.write(`fase: latency=${phasesPresent.latency} download=${phasesPresent.download}(${(vol.cliDownloadBytes / 1e9).toFixed(2) || '?'}GB) upload=${phasesPresent.upload}(${(vol.cliUploadBytes / 1e9).toFixed(2) || '?'}GB) loss=${phasesPresent.packetLoss}(${outcome.packetLoss})\n`);
W.write(`persisted=${outcome.persisted} | proxy blocked=${JSON.stringify(proxyFacts.blocked)} configServed=${proxyFacts.configServed} rewriteIds=${proxyFacts.rewritten.join(',') || '-'}\n`);
W.write(`\n== koneksi (${connList.length}) ==\n`);
W.write('id | fase                         | backend | alasan routing        | c2b(B)      | b2c(B)      | dur(ms)\n');
W.write('---|------------------------------|---------|-----------------------|-------------|-------------|--------\n');
for (const c of connList) {
  W.write(`${String(c.id).padStart(2)} | ${c.phase.padEnd(28)} | ${(c.backend || '?').padEnd(7)} | ${(c.reason || '').padEnd(21)} | ${String(c.bytesC2B ?? '-').padStart(11)} | ${String(c.bytesB2C ?? '-').padStart(11)} | ${c.closeRt !== null ? c.closeRt - c.openRt : 'open'}\n`);
}
W.write(`\n== atribusi fase ==\n`);
for (const [ph, list] of Object.entries(phaseAttr)) {
  const bes = [...new Set(list.map((x) => x.backend))];
  const bytes = list.reduce((s, x) => s + (x.bytesB2C || 0), 0);
  W.write(`${ph.padEnd(30)} → ${bes.join('+')}  (${list.length} conn, ${(bytes / 1e9).toFixed(2)} GB be→cli)\n`);
}
W.write(`\n== UDP ==\n`);
W.write(`clients=${JSON.stringify(udpFacts.clients)} cli→be=${udpCliToBe} be→cli=${udpBeToCli} contoh=${JSON.stringify(udpFacts.sampleHeads)}\n`);
W.write(`\n== krobosrasi backend ==\n`);
W.write(`B(STS): ${JSON.stringify(stsFacts)}\n`);
W.write(`A(daemon): ${JSON.stringify(daemonFacts)}\n`);
W.write(`\n== volume diverter (be→cli) == A=${(vol.diverterBytes.A / 1e9).toFixed(2)} GB  B=${(vol.diverterBytes.B / 1e9).toFixed(2)} GB\n`);
W.write(`\n== VERDICT == ${JSON.stringify(verdict)}\n`);

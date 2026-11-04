#!/usr/bin/env node
/**
 * analyze-conn-flows.mjs — rekonstruksi urutan perintah NetGauge per koneksi
 * dari evidence log SpeedtestServer (JSONL).
 *
 * Baris biner (hello terenkripsi) ditandai «ENC», perintah plaintext apa adanya,
 * event fase (download/upload/loss) dari event ng_*_done / udp_*.
 *
 * Pemakaian: node analyze-conn-flows.mjs <evidence.jsonl> [--full]
 */
import fs from 'node:fs';

const file = process.argv[2];
const full = process.argv.includes('--full');
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const t0 = lines[0]?.ts ?? 0;

const printable = (s) => /^[\x20-\x7E]*$/.test(s);
const conns = new Map(); // id -> {open, close, cmds: [{dt, kind, text}], downloads, uploads, bytes }
for (const e of lines) {
  if (!conns.has(e.id) && (e.k === 'conn_netgauge' || e.k === 'conn_close' || e.k === 'ng_cmd' || e.k === 'ng_download_done' || e.k === 'ng_upload_start' || e.k === 'ng_upload_done')) {
    conns.set(e.id, { id: e.id, peer: e.peer, open: null, close: null, cmds: [], dn: 0, up: 0 });
  }
  const c = conns.get(e.id);
  if (!c) continue;
  if (e.k === 'conn_netgauge') c.open = e.ts - t0;
  else if (e.k === 'conn_close') c.close = e.ts - t0;
  else if (e.k === 'ng_cmd') c.cmds.push({ dt: e.ts - t0, kind: printable(e.line) ? 'txt' : 'enc', text: e.line });
  else if (e.k === 'ng_download_done') c.dn++;
  else if (e.k === 'ng_upload_done') c.up++;
}

const summary = [];
for (const c of [...conns.values()].sort((a, b) => (a.open ?? 9e15) - (b.open ?? 9e15))) {
  const phase = [];
  const has = (s) => c.cmds.some((x) => x.kind === 'txt' && x.text.startsWith(s));
  if (has('PING')) phase.push('PING');
  if (has('DOWNLOAD')) phase.push('DOWNLOAD');
  if (has('UPLOAD')) phase.push('UPLOAD');
  if (has('INITPLOSS')) phase.push('INITPLOSS');
  if (has('PLOSS')) phase.push('PLOSS');
  const encCount = c.cmds.filter((x) => x.kind === 'enc').length;
  summary.push({
    id: c.id, peer: c.peer, open_ms: c.open, close_ms: c.close,
    encHellos: encCount, txtCmds: c.cmds.filter((x) => x.kind === 'txt').length,
    downloads: c.dn, uploads: c.up, phases: phase.join('+'),
  });
}

console.log(`# analisis koneksi dari ${file}`);
console.log(`# total koneksi TCP NetGauge: ${summary.length}`);
console.log('');
console.log('id | peer        | open_ms | close_ms | encHello | txtCmd | D   | U   | fase');
console.log('---|-------------|---------|----------|----------|--------|-----|-----|-----');
for (const s of summary) {
  console.log(`${String(s.id).padStart(2)} | ${String(s.peer).padEnd(11)} | ${String(s.open_ms).padStart(7)} | ${String(s.close_ms ?? '-').padStart(8)} | ${String(s.encHellos).padStart(8)} | ${String(s.txtCmds).padStart(6)} | ${String(s.downloads).padStart(3)} | ${String(s.uploads).padStart(3)} | ${s.phases}`);
}

if (full) {
  console.log('\n# alur lengkap per koneksi (dt_ms | jenis | teks):');
  for (const c of [...conns.values()].sort((a, b) => (a.open ?? 9e15) - (b.open ?? 9e15))) {
    console.log(`\n== conn ${c.id} (${c.peer}) ==`);
    for (const x of c.cmds.slice(0, 60)) {
      console.log(`  ${String(x.dt).padStart(6)}ms ${x.kind === 'enc' ? '«ENC ' + Buffer.from(x.text, 'latin1').length + 'B»' : x.text.slice(0, 70)}`);
    }
  }
}

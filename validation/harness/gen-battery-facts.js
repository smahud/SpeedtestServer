#!/usr/bin/env node
/**
 * gen-battery-facts.js — derive the human-readable facts table from a
 * battery-summary.json + per-run evidence (validation/evidence/published*).
 * Usage: node gen-battery-facts.js <battery-dir>
 */
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const summary = fs.readFileSync(path.join(dir, 'battery-summary.json'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l));
const runs = summary.filter((r) => r.k === 'run');
const facts = [];

for (const run of runs) {
  const jsonFile = path.join(dir, `run-${run.tag}.json`);
  let cli = null;
  try { cli = JSON.parse(fs.readFileSync(jsonFile, 'utf8')); } catch { /* human run */ }
  let serverSent = 0;
  let serverRecv = 0;
  let ngConns = 0;
  let ngCommands = 0;
  let udpSessions = 0;
  try {
    const lines = fs.readFileSync(path.join(dir, `run-${run.tag}-sts-evidence.jsonl`), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    for (const e of lines) {
      if (e.k === 'ng_download_done') serverSent += e.n || 0;
      if (e.k === 'ng_upload_done') serverRecv += e.counted || 0;
      if (e.k === 'conn_netgauge') ngConns++;
      if (e.k === 'ng_udp_session') udpSessions++;
      if (e.k === 'ng_command') ngCommands++;
    }
  } catch { /* no evidence */ }
  facts.push({
    tag: run.tag,
    serverId: run.id,
    status: run.status,
    exit: run.exit,
    resultUrl: run.resultUrl || '',
    packetLoss: run.packetLoss === undefined ? '' : String(run.packetLoss),
    dlMbps: cli ? +(cli.download.bandwidth / 125000).toFixed(2) : null,
    ulMbps: cli ? +(cli.upload.bandwidth / 125000).toFixed(2) : null,
    idleLatencyMs: cli ? cli.ping.latency : null,
    persisted: cli ? cli.result.persisted : null,
    serverSentGiB: +(serverSent / 2 ** 30).toFixed(1),
    serverRecvGiB: +(serverRecv / 2 ** 30).toFixed(1),
    netgaugeConns: ngConns,
    netgaugeCommands: ngCommands,
    udpSessions,
  });
}

fs.writeFileSync(path.join(dir, 'battery-facts.json'), JSON.stringify(facts, null, 2));
console.log(JSON.stringify(facts, null, 2));

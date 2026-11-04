#!/usr/bin/env bash
# run-differential-suite.sh — four-way differential validation (MASTER PROMPT §5).
# Requires: reference daemon on REF_PORT (18080), SpeedtestServer on STS_PORT (8080),
# lab PKI (gen-pki.sh), probe battery probe-protocol.mjs (from SpeedtestHost-Tester).
set -euo pipefail
cd "$(dirname "$0")"
REF_PORT="${REF_PORT:-18080}"
STS_PORT="${STS_PORT:-8080}"
OUT="${OUT:-./out/differential}"
mkdir -p "$OUT"

PROBE="${PROBE:-../../SpeedtestHost-Tester/z.ai/lab/scripts/probe-protocol.mjs}"
[ -f "$PROBE" ] || { echo "probe battery not found: $PROBE (clone SpeedtestHost-Tester read-only)"; exit 2; }

echo "== 1/4 probe battery: official daemon =:${REF_PORT}"
node "$PROBE" 127.0.0.1 "$REF_PORT" > "$OUT/probe-daemon.json" 2>/dev/null || true
echo "== 2/4 probe battery: SpeedtestServer =:${STS_PORT}"
node "$PROBE" 127.0.0.1 "$STS_PORT" > "$OUT/probe-sts.json" 2>/dev/null || true

echo "== 3/4 differential comparison =="
node - "$OUT" <<'EOF'
const fs = require('fs');
const out = process.argv[2];
const d = JSON.parse(fs.readFileSync(`${out}/probe-daemon.json`, 'utf8'));
const s = JSON.parse(fs.readFileSync(`${out}/probe-sts.json`, 'utf8'));
let same = 0, diff = 0;
for (let i = 0; i < d.results.length; i++) {
  const a = d.results[i], b = s.results[i] || {};
  const eq = a.result === b.result && String(a.detail || '') === String(b.detail || '');
  if (eq) same++;
  else { diff++; console.log(`[DIFF ${a.group}] ${a.name}\n  daemon: ${a.result} | ${a.detail}\n  STS:    ${b.result} | ${b.detail}`); }
}
console.log(`differential: ${same}/${d.results.length} identical, ${diff} differing`);
fs.writeFileSync(`${out}/differential-summary.json`, JSON.stringify({ same, diff, total: d.results.length }));
process.exit(0);
EOF

echo "== 4/4 done — see $OUT =="

#!/usr/bin/env bash
# run-diversion.sh — orkestrator satu eksperimen diversion backend (lab terisolasi).
#
# Satu invocation = satu siklus lengkap (sandbox ini mendaur ulang proses
# antar sesi, jadi SEMUAnya — backend, diverter, proxy, run CLI, pengumpulan
# evidence — terjadi di dalam satu invocation ini):
#
#   1. preflight   : inventaris proses, pastikan tidak ada proses lab liar
#   2. backend A   : daemon OoklaServer resmi di-refresh  (TCP+UDP :18080)
#   3. backend B   : SpeedtestServer TS di-refresh        (TCP+UDP :8080)
#   4. diverter    : gateway diversion :9090 dengan POLICY eksperimen
#   5. config proxy: LIVE fetch via curl saat CLI meminta (default; licenseKey
#                    berumur detik — snapshot offline hanya untuk smoke test),
#                    semua servers[] → localhost:9090,
#                    results.speedtest.net DITOLAK (non-publishing)
#   6. run CLI resmi (unmodified) via ALL_PROXY + --ca-certificate bundle
#   7. post-run    : atribusi (analisis diverter+STS+proxy+CLI) → analysis.json
#
# Pemakaian:
#   EXP_ID=f2a POLICY="phase:pre=A,enc=A,sel=A,ping=B,loss=B,dn=B,up=B,upctl=B" \
#   UDP=B ./run-diversion.sh
#
# Env:
#   EXP_ID   (wajib)  id eksperimen, dipakai sebagai nama dir evidence
#   POLICY   (wajib)  policy diverter (lihat diverter.mjs)
#   UDP      (opt)    backend UDP: A|B|drop   (default A)
#   CLI_ARGS (opt)    argumen tambahan untuk CLI
#   DIV_PORT (opt)    port diverter (default 9090)
#   SKIP_A / SKIP_B   (opt)  jangan jalankan backend A/B (failure injection:
#                         backend sengaja tidak ada / matikan di tengah run)
#   KILL_A_AT_MS / KILL_B_AT_MS (opt)  matikan backend di tengah run (ms setelah CLI start)
set -uo pipefail
cd "$(dirname "$0")"

EXP_ID="${EXP_ID:-}"
POLICY="${POLICY:-}"
UDP="${UDP:-A}"
DIV_PORT="${DIV_PORT:-9090}"
[ -n "$EXP_ID" ] && [ -n "$POLICY" ] || { echo "usage: EXP_ID=... POLICY=... [UDP=A|B|drop] ./run-diversion.sh"; exit 2; }

REPO_ROOT="../../.."                # validation/diversion-lab/harness → repo root
LAB_ROOT="/home/z/my-project/lab"   # direktori kerja lab (di luar repo; binari proprietary tidak pernah di-commit)
OUT="../evidence/$EXP_ID"
rm -rf "$OUT"; mkdir -p "$OUT"
ABS_OUT="$(cd "$OUT" && pwd)"      # path absolut — subshell backend melakukan cd ke dir lain
ms_to_s() { printf '%d.%03d' $(( $1 / 1000 )) $(( $1 % 1000 )); }
CLI="$LAB_ROOT/clients/speedtest/speedtest"
CERTS="./certs"

log()  { echo "[run-diversion:$EXP_ID] $*"; }

# ---------------------------------------------------------------- 1. preflight
log "preflight"
{
  date -u; uname -a
  echo "repo HEAD: $(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null)"
  echo "policy: $POLICY | udp: $UDP | diverter port: $DIV_PORT"
  echo "backend A: official OoklaServer 2.11.5.2 (sha ce180aa3…) :18080"
  echo "backend B: SpeedtestServer TS ($(git -C "$REPO_ROOT" rev-parse --short HEAD)) :8080"
  echo "CLI: $($CLI --version 2>/dev/null | head -1)"
  echo "--- listeners before:"
  ss -tlnp 2>/dev/null | grep -E ":(18080|8080|9090|8888) " || echo "(none)"
} > "$OUT/process-inventory.txt" 2>&1

# bersihkan proses lab lama (jika ada)
pkill -f 'lab/daemon/OoklaServer' 2>/dev/null || true
pkill -f 'dist/bin/ooklaserver.js' 2>/dev/null || true
pkill -f 'diverter.mjs' 2>/dev/null || true
pkill -f 'offline-config-proxy.mjs' 2>/dev/null || true
sleep 1

BACKEND_PIDS=()
cleanup() {
  for p in "${BACKEND_PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  [ -n "${DIV_PID:-}" ] && kill "$DIV_PID" 2>/dev/null || true
  [ -n "${PROXY_PID:-}" ] && kill "$PROXY_PID" 2>/dev/null || true
  # tunggu diverter menulis summary
  sleep 1
  [ -n "${DIV_PID:-}" ] && kill -9 "$DIV_PID" 2>/dev/null || true
  # snapshot log daemon untuk evidence
  [ -f "$LAB_ROOT/lab/daemon/daemon-access.log" ] && cp "$LAB_ROOT/lab/daemon/daemon-access.log" "$OUT/daemon-access.log"
}
trap cleanup EXIT

# ---------------------------------------------------------------- 2. backend A (daemon resmi)
ready_probe() { # ready_probe <port> — kirim HI, tunggu HELLO (readiness fungsional)
  node -e "
const net=require('net');
const s=net.connect({host:'127.0.0.1',port:+process.argv[1]});
let out='';
s.on('connect',()=>s.write('HI\n'));
s.on('data',d=>{out+=d.toString();});
s.on('close',()=>process.exit(out.includes('HELLO')?0:1));
s.on('error',()=>process.exit(1));
setTimeout(()=>{process.exit(out.includes('HELLO')?0:1)},2500);" "$1" 2>/dev/null
}
if [ -z "${SKIP_A:-}" ]; then
  log "start backend A (official daemon :18080)"
  (cd "$LAB_ROOT/lab/daemon" && rm -f daemon-access.log && nohup ./OoklaServer >> daemon-console.log 2>&1 & echo $! > /tmp/div_pid_a)
  BACKEND_PIDS+=("$(cat /tmp/div_pid_a)")
  for i in $(seq 1 40); do ready_probe 18080 && break; sleep 0.5; done
  ready_probe 18080 && log "backend A READY" || log "WARN: backend A tidak merespons HI"
else
  log "SKIP_A aktif — backend A TIDAK dijalankan"
fi

# ---------------------------------------------------------------- 3. backend B (SpeedtestServer TS)
if [ -z "${SKIP_B:-}" ]; then
  log "start backend B (SpeedtestServer :8080)"
  (cd "$LAB_ROOT/SpeedtestServer/reverse-engineered/typescript" && nohup node dist/bin/ooklaserver.js \
      --ports 8080 --udp-ports 8080 --evidence-log "$ABS_OUT/sts-evidence.jsonl" \
      > "$ABS_OUT/sts-console.log" 2>&1 & echo $! > /tmp/div_pid_b)
  BACKEND_PIDS+=("$(cat /tmp/div_pid_b)")
  for i in $(seq 1 40); do ready_probe 8080 && break; sleep 0.5; done
  ready_probe 8080 && log "backend B READY" || log "WARN: backend B tidak merespons HI"
else
  log "SKIP_B aktif — backend B TIDAK dijalankan"
fi

# ---------------------------------------------------------------- 4. diverter
log "start diverter :$DIV_PORT policy=$POLICY udp=$UDP"
node diverter.mjs --port "$DIV_PORT" --a 127.0.0.1:18080 --b 127.0.0.1:8080 \
  --policy "$POLICY" --udp "$UDP" --log "$OUT/diverter.jsonl" > "$OUT/diverter-console.log" 2>&1 &
DIV_PID=$!
for i in $(seq 1 20); do grep -q '\[diverter\] udp' "$OUT/diverter-console.log" 2>/dev/null && break; sleep 0.3; done

# ---------------------------------------------------------------- 5. config proxy
log "start config proxy :8888 → target localhost:$DIV_PORT (mode: ${CONFIG_PROXY:-live})"
if [ "${CONFIG_PROXY:-live}" = "offline" ]; then
  node offline-config-proxy.mjs --port 8888 --target "localhost:$DIV_PORT" \
    --snapshot ../evidence/config-snapshot.json --log "$OUT/proxy.jsonl" > "$OUT/proxy-console.log" 2>&1 &
else
  node live-config-proxy.mjs --port 8888 --target "localhost:$DIV_PORT" \
    --log "$OUT/proxy.jsonl" > "$OUT/proxy-console.log" 2>&1 &
fi
PROXY_PID=$!
sleep 1

{
  echo "--- listeners at run start:"
  ss -tlnp 2>/dev/null | grep -E ":(18080|8080|9090|8888) "
  echo "--- udp:"
  ss -ulnp 2>/dev/null | grep -E ":(18080|8080|9090) "
} >> "$OUT/process-inventory.txt" 2>&1

# ---------------------------------------------------------------- 6. run CLI resmi
log "run official CLI (unmodified) — non-publishing"
if [ -n "${KILL_A_AT_MS:-}" ]; then
  ( sleep "$(ms_to_s "$KILL_A_AT_MS")" ; pkill -f 'lab/daemon/OoklaServer' && log "backend A dimatikan (KILL_A_AT_MS=$KILL_A_AT_MS)" ) &
  KILL_PID=$!
fi
if [ -n "${KILL_B_AT_MS:-}" ]; then
  ( sleep "$(ms_to_s "$KILL_B_AT_MS")" ; pkill -f 'dist/bin/ooklaserver.js' && log "backend B dimatikan (KILL_B_AT_MS=$KILL_B_AT_MS)" ) &
  KILL_PID2=$!
fi

START_TS=$(date +%s)
set +e
ALL_PROXY=http://127.0.0.1:8888 HTTPS_PROXY=http://127.0.0.1:8888 HTTP_PROXY=http://127.0.0.1:8888 \
  timeout 240 "$CLI" --ca-certificate="$CERTS/cli-ca-bundle.pem" --accept-license --accept-gdpr \
  --selection-details -f json-pretty ${CLI_ARGS:-} > "$OUT/cli.json" 2> "$OUT/cli.stderr"
EXIT=$?
set -e
END_TS=$(date +%s)
echo "exit=$EXIT" >> "$OUT/cli.stderr"
log "CLI exit=$EXIT durasi=$((END_TS-START_TS))s"
[ -n "${KILL_PID:-}" ] && kill "$KILL_PID" 2>/dev/null || true
[ -n "${KILL_PID2:-}" ] && kill "$KILL_PID2" 2>/dev/null || true

# ---------------------------------------------------------------- 7. atribusi & analisis
sleep 1
node analyze-run.mjs "$OUT" > "$OUT/analysis.txt" 2> "$OUT/analysis.err" || true
cp "$OUT/analysis.txt" /dev/stdout || true

exit $EXIT

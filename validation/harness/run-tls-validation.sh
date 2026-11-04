#!/usr/bin/env bash
# run-tls-validation.sh — STRICT TLS validation battery (MASTER PROMPT v6.0
# §9/§10) against the ACTUAL SpeedtestServer listener (single multiplexed
# port incl. HTTPS), not a reverse proxy.
#
# Positive:
#   T1  custom lab-CA-signed certificate  → strict HTTPS PASS (trust chain,
#       hostname/SAN, validity, key match, TLS>=1.2, HTTP 200 on /hi)
#   T2  certificate obtained AFTER startup activates on the live listener
#       (§9.7 delayed activation / hot reload); broken replacement is
#       rejected and the LAST VALID certificate keeps being served
#   T3  minimumTLSProtocol=1.3 → TLSv1.2 client rejected, TLSv1.3 accepted
#
# Negative (must FAIL or abort — never silently degrade):
#   N1  self-signed certificate (dev quick start)   → strict HTTPS FAIL
#   N2  EXPIRED certificate                          → strict HTTPS FAIL
#   N3  WRONG-HOSTNAME certificate                   → strict HTTPS FAIL
#   N4  cert/key MISMATCH                             → server refuses to start
#   N5  incomplete custom pair (cert only)            → server refuses to start
#   N6  useLetsEncrypt=true without acme.*           → server refuses to start
#   N7  useLetsEncrypt=true + dead ACME directory     → server refuses to start
#
# Evidence: out/tls-validation/tls-validation.json (+ per-scenario logs).
set -u
cd "$(dirname "$0")"
TS_BIN="${TS_BIN:-../../reverse-engineered/typescript/dist/bin/ooklaserver.js}"
PORT="${TLS_PORT:-8443}"
OUT="${OUT:-./out/tls-validation}"
mkdir -p "$OUT"
[ -f "$TS_BIN" ] || { echo "SpeedtestServer build missing ($TS_BIN)"; exit 2; }
[ -f tls-cases/server-a.pem ] || { echo "TLS cases missing (run ./gen-tls-cases.sh)"; exit 2; }
[ -f certs/lab-ca.pem ] || { echo "Lab CA missing (run ./gen-pki.sh)"; exit 2; }

RESULTS="$OUT/tls-validation.json"
SCRATCH="$OUT/scratch"
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH"
NODE_BIN="$(command -v node)"

# ---------- helpers ----------
record() { # $1=id $2=verdict $3=expected $4=observed [$5=detail-file]
  local EVID="${5:-}"
  EVID="${EVID##*/}"
  printf '{"id":"%s","verdict":"%s","expected":"%s","observed":"%s","evidence":"%s"}\n' \
    "$1" "$2" "$3" "$4" "$EVID" >> "$RESULTS"
  printf '%-4s %-6s expected=%s observed=%s\n' "$1" "$2" "$3" "$4"
}

start_server() { # $1=config $2=tag  → STS_PID; stdout captured in $OUT/$2-console.txt
  # Fail-closed preflight: the port must be FREE before we start (a stale
  # listener would silently serve the wrong scenario's certificate).
  if ss -tln 2>/dev/null | grep -q ":${PORT} "; then
    echo "FATAL: port $PORT already in use — stale server?" >&2
    return 1
  fi
  node "$TS_BIN" --config "$1" --ports "$PORT" --udp-ports "$PORT" \
    > "$OUT/$2-console.txt" 2>&1 &
  STS_PID=$!
  for _ in $(seq 1 20); do
    ss -tlnp 2>/dev/null | grep -q "pid=${STS_PID}," && return 0
    kill -0 "$STS_PID" 2>/dev/null || return 1
    sleep 0.5
  done
  return 1
}

stop_server() {
  [ -n "${STS_PID:-}" ] || return 0
  kill "$STS_PID" 2>/dev/null; sleep 1; kill -9 "$STS_PID" 2>/dev/null
  STS_PID=""
}

strict() { # → prints tls-strict-check JSON
  node tls-strict-check.mjs --host 127.0.0.1 --port "$PORT" --servername localhost \
    --ca certs/lab-ca.pem "$@"
}

probe_fp() { strict --path /hi | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).fingerprint||'')}catch{console.log('')}})"
}

expect_server_start_fails() { # $1=config $2=tag $3=id — server must EXIT non-zero
  local CFG="$1" TAG="$2" ID="$3" EXITCODE
  timeout 25 node "$TS_BIN" --config "$CFG" --ports "$PORT" --udp-ports "$PORT" \
    > "$OUT/$TAG-console.txt" 2>&1
  EXITCODE=$?
  if [ "$EXITCODE" -ne 0 ] && [ "$EXITCODE" -ne 124 ]; then
    record "$ID" PASS "server exits non-zero" "exit=$EXITCODE $(grep -oE '(TLS_[A-Z_]+|refuses to fall back|Refusing to fall back)' "$OUT/$TAG-console.txt" | head -1 | tr -d '\n')"
  else
    record "$ID" FAIL "server exits non-zero" "exit=$EXITCODE"
  fi
}

: > "$RESULTS"
printf '{"k":"battery","startedUtc":"%s","port":%s,"node":"%s","gitSha":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PORT" "$("$NODE_BIN" --version)" \
  "$(git -C ../.. rev-parse HEAD 2>/dev/null || echo unknown)" >> "$RESULTS"

# ---------- T1: trusted custom certificate → strict HTTPS PASS ----------
cat > "$SCRATCH/t1.properties" <<EOF
OoklaServer.tcpPorts = $PORT
OoklaServer.udpPorts = $PORT
openSSL.server.certificateFile = $PWD/tls-cases/server-a.pem
openSSL.server.privateKeyFile = $PWD/tls-cases/server-a.key
EOF
if start_server "$SCRATCH/t1.properties" t1; then
  T1=$(strict --path /hi)
  echo "$T1" > "$OUT/t1.json"
  T1_OK=$(echo "$T1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.ok&&r.code==='HTTP_200'&&r.subject==='localhost'?'PASS':'FAIL')})")
  record T1 "$T1_OK" "strict HTTPS 200, CN=localhost" "$(echo "$T1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.ok?r.code+' '+r.protocol+' '+r.subject:r.code)})")"
else
  record T1 FAIL "server starts" "no listener"
fi
stop_server

# ---------- T2: §9.7 delayed activation / hot reload ----------
cp tls-cases/server-a.pem "$SCRATCH/live.pem"; cp tls-cases/server-a.key "$SCRATCH/live.key"
cat > "$SCRATCH/t2.properties" <<EOF
OoklaServer.tcpPorts = $PORT
OoklaServer.udpPorts = $PORT
openSSL.server.certificateFile = $SCRATCH/live.pem
openSSL.server.privateKeyFile = $SCRATCH/live.key
EOF
if start_server "$SCRATCH/t2.properties" t2; then
  FP_A=$(probe_fp)
  cp tls-cases/server-b.pem "$SCRATCH/live.pem"; cp tls-cases/server-b.key "$SCRATCH/live.key"
  sleep 2.5
  FP_B=$(probe_fp)
  printf 'not a certificate\n' > "$SCRATCH/live.pem"
  sleep 2.5
  FP_STILL_B=$(probe_fp)
  {
    echo "fingerprintA(start)=$FP_A"
    echo "fingerprintB(after swap)=$FP_B"
    echo "fingerprintStillB(after broken write)=$FP_STILL_B"
    grep -E 'reloaded|reload failed|TLS reload' "$OUT/t2-console.txt" || true
  } > "$OUT/t2-summary.txt"
  if [ -n "$FP_A" ] && [ -n "$FP_B" ] && [ "$FP_A" != "$FP_B" ] && [ "$FP_B" = "$FP_STILL_B" ]; then
    record T2 PASS "A→B swap serves B; broken write keeps B" "A=${FP_A:0:16}… B=${FP_B:0:16}… after-broken=${FP_STILL_B:0:16}…"
  else
    record T2 FAIL "A→B swap serves B; broken write keeps B" "A=${FP_A:0:16} B=${FP_B:0:16} still=${FP_STILL_B:0:16}"
  fi
else
  record T2 FAIL "server starts" "no listener"
fi
stop_server

# ---------- T3: minimumTLSProtocol = 1.3 ----------
cat > "$SCRATCH/t3.properties" <<EOF
OoklaServer.tcpPorts = $PORT
OoklaServer.udpPorts = $PORT
openSSL.server.minimumTLSProtocol = 1.3
openSSL.server.certificateFile = $PWD/tls-cases/server-a.pem
openSSL.server.privateKeyFile = $PWD/tls-cases/server-a.key
EOF
if start_server "$SCRATCH/t3.properties" t3; then
  T3_12=$(strict --tls-only --min TLSv1.2 --max TLSv1.2)
  T3_13=$(strict --tls-only --min TLSv1.3)
  echo "$T3_12" > "$OUT/t3-tls12.json"; echo "$T3_13" > "$OUT/t3-tls13.json"
  OK12=$(echo "$T3_12" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).ok===false?'rejected':'accepted')})")
  OK13=$(echo "$T3_13" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.ok&&r.protocol==='TLSv1.3'?'accepted-tls13':'failed')})")
  if [ "$OK12" = "rejected" ] && [ "$OK13" = "accepted-tls13" ]; then
    record T3 PASS "TLSv1.2 rejected; TLSv1.3 accepted" "12=$OK12 13=$OK13"
  else
    record T3 FAIL "TLSv1.2 rejected; TLSv1.3 accepted" "12=$OK12 13=$OK13"
  fi
else
  record T3 FAIL "server starts" "no listener"
fi
stop_server

# ---------- N1: self-signed (dev quick start) → strict FAIL ----------
cat > "$SCRATCH/n1.properties" <<EOF
OoklaServer.tcpPorts = $PORT
OoklaServer.udpPorts = $PORT
EOF
if start_server "$SCRATCH/n1.properties" n1; then
  N1=$(strict --path /hi)
  echo "$N1" > "$OUT/n1.json"
  N1_OK=$(echo "$N1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).ok===false?'PASS':'FAIL')})")
  record N1 "$N1_OK" "strict HTTPS FAIL (self-signed)" "$(echo "$N1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).code)})")"
else
  record N1 FAIL "server starts" "no listener"
fi
stop_server

# ---------- N2: expired certificate → strict FAIL ----------
cat > "$SCRATCH/n2.properties" <<EOF
OoklaServer.tcpPorts = $PORT
OoklaServer.udpPorts = $PORT
openSSL.server.certificateFile = $PWD/tls-cases/expired.pem
openSSL.server.privateKeyFile = $PWD/tls-cases/expired.key
EOF
if start_server "$SCRATCH/n2.properties" n2; then
  N2=$(strict --path /hi)
  echo "$N2" > "$OUT/n2.json"
  N2_OK=$(echo "$N2" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(!r.ok&&r.code==='CERT_HAS_EXPIRED'?'PASS':'FAIL')})")
  record N2 "$N2_OK" "CERT_HAS_EXPIRED" "$(echo "$N2" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).code)})")"
else
  record N2 FAIL "server starts" "no listener"
fi
stop_server

# ---------- N3: wrong hostname → strict FAIL ----------
cat > "$SCRATCH/n3.properties" <<EOF
OoklaServer.tcpPorts = $PORT
OoklaServer.udpPorts = $PORT
openSSL.server.certificateFile = $PWD/tls-cases/wrongname.pem
openSSL.server.privateKeyFile = $PWD/tls-cases/wrongname.key
EOF
if start_server "$SCRATCH/n3.properties" n3; then
  N3=$(strict --path /hi)
  echo "$N3" > "$OUT/n3.json"
  N3_OK=$(echo "$N3" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(!r.ok&&/ALTNAME|HOSTNAME/i.test(r.code||'')?'PASS':'FAIL')})")
  record N3 "$N3_OK" "CERT_ALTNAME/hostname mismatch" "$(echo "$N3" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).code)})")"
else
  record N3 FAIL "server starts" "no listener"
fi
stop_server

# ---------- N4: cert/key mismatch → server refuses to start ----------
cat > "$SCRATCH/n4.properties" <<EOF
OoklaServer.tcpPorts = $PORT
OoklaServer.udpPorts = $PORT
openSSL.server.certificateFile = $PWD/tls-cases/server-a.pem
openSSL.server.privateKeyFile = $PWD/tls-cases/server-b.key
EOF
expect_server_start_fails "$SCRATCH/n4.properties" n4 N4

# ---------- N5: incomplete pair → server refuses to start ----------
cat > "$SCRATCH/n5.properties" <<EOF
OoklaServer.tcpPorts = $PORT
OoklaServer.udpPorts = $PORT
openSSL.server.certificateFile = $PWD/tls-cases/server-a.pem
EOF
expect_server_start_fails "$SCRATCH/n5.properties" n5 N5

# ---------- N6: useLetsEncrypt=true without acme → refuses to start ----------
cat > "$SCRATCH/n6.properties" <<EOF
OoklaServer.tcpPorts = $PORT
OoklaServer.udpPorts = $PORT
OoklaServer.ssl.useLetsEncrypt = true
EOF
expect_server_start_fails "$SCRATCH/n6.properties" n6 N6

# ---------- N7: useLetsEncrypt=true + dead ACME directory → refuses to start ----------
cat > "$SCRATCH/n7.properties" <<EOF
OoklaServer.tcpPorts = $PORT
OoklaServer.udpPorts = $PORT
OoklaServer.ssl.useLetsEncrypt = true
OoklaServer.ssl.acme.domains = speed.example.org
OoklaServer.ssl.acme.email = ops@example.org
OoklaServer.ssl.acme.directoryUrl = http://127.0.0.1:9/dir
OoklaServer.ssl.acme.http01Port = 8081
EOF
expect_server_start_fails "$SCRATCH/n7.properties" n7 N7

printf '{"k":"battery","finishedUtc":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$RESULTS"

echo ""
PASS_N=$(grep -c '"verdict":"PASS"' "$RESULTS" || true)
TOTAL_N=$(grep -c '"id":' "$RESULTS" || true)
echo "=== TLS validation: ${PASS_N}/${TOTAL_N} PASS ($RESULTS) ==="
cat "$RESULTS"
[ "$PASS_N" = "$TOTAL_N" ]

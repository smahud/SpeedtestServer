#!/usr/bin/env bash
# run-matrix.sh — jalankan serangkaian eksperimen diversion dengan backoff otomatis
# saat config API kena 429 (token kuota ~1 fetch per beberapa menit).
#
# Pemakaian (dari harness/): argumen = tripel  <exp_id> <policy> <udp>  [env-extra]
# Contoh:
#   ./run-matrix.sh f0-all-a 'all:A' A "f2a phase:pre=A,enc=A,sel=A,dn=B,up=B B"
# atau lebih sederhana lewat run-core-matrix.sh yang memanggil fungsi ini.
set -uo pipefail
cd "$(dirname "$0")"

run_exp() { # $1=id $2=policy $3=udp $4=extra-env (opsional)
  local id="$1" policy="$2" udp="$3" extra="${4:-}" attempt dir
  for attempt in 1 2 3 4 5; do
    echo "=========== EXP $id (percobaan $attempt) ==========="
    if [ -n "$extra" ]; then
      eval "EXP_ID='$id' POLICY='$policy' UDP='$udp' $extra timeout 300 ./run-diversion.sh" 2>&1 | grep -E "CLI exit|VERDICT|fase:|READY|config proxy" | head -8
    else
      EXP_ID="$id" POLICY="$policy" UDP="$udp" timeout 300 ./run-diversion.sh 2>&1 | grep -E "CLI exit|VERDICT|fase:|READY|config proxy" | head -8
    fi
    dir="../evidence/$id"
    if grep -q '"config_served"' "$dir/proxy.jsonl" 2>/dev/null; then
      echo ">>> $id: config tersaji — run dihitung ✓"; return 0
    fi
    echo ">>> $id: config fetch gagal (429?) — tunggu 100 dtk lalu retry"
    sleep 240
  done
  echo ">>> $id: GAGAL setelah 5 percobaan"; return 1
}

# ---- tripel eksperimen dikirim sebagai argumen: id|policy|udp|extra ----
for spec in "$@"; do
  IFS='|' read -r id pol udp extra <<< "$spec"
  run_exp "$id" "$pol" "$udp" "$extra"
done

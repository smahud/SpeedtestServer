#!/usr/bin/env bash
# gen-tls-cases.sh — TLS validation certificate cases (MASTER PROMPT v6.0 §10).
#
# Reuses the Lab Root CA from gen-pki.sh (run that first) and mints:
#   tls-cases/server-a.pem/.key   valid cert, CN=localhost, SAN localhost +
#                                 lab.ookla.test + loopback IPs  (case "A")
#   tls-cases/server-b.pem/.key   valid cert with a DIFFERENT key    (case "B")
#   tls-cases/expired.pem/.key    expired 10 days ago (notBefore -60d)
#   tls-cases/wrongname.pem/.key  CN/SAN = other.example.test (hostname mismatch)
# A "mismatched pair" scenario is built by cross-pairing A's cert with B's key.
set -euo pipefail
cd "$(dirname "$0")"
[ -f certs/lab-ca.pem ] || { echo "Run ./gen-pki.sh first (lab CA missing)"; exit 2; }
mkdir -p tls-cases

if [ -f tls-cases/server-a.pem ] && [ "${1:-}" != "--force" ]; then
  echo "TLS cases already exist (use --force to regenerate)"; exit 0
fi
rm -f tls-cases/*.pem tls-cases/*.key tls-cases/*.csr tls-cases/*.ext

CA_CERT=certs/lab-ca.pem
CA_KEY=certs/lab-ca.key

mkext() { # $1=file $2=san
  printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n' "$2" > "$1"
}

issue() { # $1=basename $2=CN $3=san $4=days
  openssl req -newkey rsa:2048 -keyout "tls-cases/$1.key" -out "tls-cases/$1.csr" -nodes \
    -subj "/CN=$2" 2>/dev/null
  mkext "tls-cases/$1.ext" "$3"
  openssl x509 -req -in "tls-cases/$1.csr" -CA "$CA_CERT" -CAkey "$CA_KEY" \
    -CAcreateserial -out "tls-cases/$1.pem" -days "$4" -extfile "tls-cases/$1.ext" 2>/dev/null
}

LOCALHOST_SAN='DNS:localhost,DNS:lab.ookla.test,IP:127.0.0.1,IP:0:0:0:0:0:0:0:1'

# Case A + Case B: valid, distinct key pairs (reload A→B test).
issue server-a localhost "$LOCALHOST_SAN" 825
issue server-b localhost "$LOCALHOST_SAN" 825

# Expired certificate (openssl >= 3.0 supports explicit dates on x509 -req;
# this build requires absolute ASN.1 times, not relative offsets).
NB="$(date -u -d '-60 days' +%Y%m%d%H%M%SZ)"
NA="$(date -u -d '-10 days' +%Y%m%d%H%M%SZ)"
openssl req -newkey rsa:2048 -keyout tls-cases/expired.key -out tls-cases/expired.csr -nodes \
  -subj "/CN=localhost" 2>/dev/null
mkext tls-cases/expired.ext "$LOCALHOST_SAN"
openssl x509 -req -in tls-cases/expired.csr -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial \
  -out tls-cases/expired.pem -not_before "$NB" -not_after "$NA" \
  -extfile tls-cases/expired.ext 2>/dev/null

# Wrong-hostname certificate.
issue wrongname other.example.test "DNS:other.example.test" 825

chmod 600 tls-cases/*.key
echo "== TLS cases =="
for c in server-a server-b expired wrongname; do
  printf '%-10s ' "$c"; openssl x509 -in "tls-cases/$c.pem" -noout -subject -enddate
done

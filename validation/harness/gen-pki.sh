#!/usr/bin/env bash
# Lab PKI for SpeedtestServer interoperability testing.
# Generates: Lab Root CA, daemon/server cert (localhost + loopback IPs),
# MITM cert for cli.speedtest.net (config-API TLS termination in the lab),
# and a CLI trust bundle (system store + lab CA) for --ca-certificate.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p certs

if [ -f certs/lab-ca.pem ] && [ "${1:-}" != "--force" ]; then
  echo "PKI already exists (use --force to regenerate)"; exit 0
fi
rm -f certs/*.pem certs/*.key certs/*.csr certs/*.srl certs/*.ext

# 1) Lab Root CA
openssl req -x509 -newkey rsa:2048 -keyout certs/lab-ca.key -out certs/lab-ca.pem \
  -days 3650 -nodes -subj "/CN=SpeedtestServer Lab Root CA/O=SpeedtestServer Lab" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

# 2) Daemon / SpeedtestServer TLS cert
cat > certs/server.ext <<'EOF'
subjectAltName=DNS:localhost,DNS:lab.ookla.test,IP:127.0.0.1,IP:0:0:0:0:0:0:0:1
extendedKeyUsage=serverAuth
keyUsage=digitalSignature,keyEncipherment
EOF
openssl req -newkey rsa:2048 -keyout certs/server.key -out certs/server.csr -nodes \
  -subj "/CN=localhost" 2>/dev/null
openssl x509 -req -in certs/server.csr -CA certs/lab-ca.pem -CAkey certs/lab-ca.key \
  -CAcreateserial -out certs/server.pem -days 825 -extfile certs/server.ext 2>/dev/null

# 3) MITM cert (lab config-API termination only)
cat > certs/mitm.ext <<'EOF'
subjectAltName=DNS:cli.speedtest.net,DNS:www.speedtest.net,DNS:c.speedtest.net,DNS:results.speedtest.net
extendedKeyUsage=serverAuth
keyUsage=digitalSignature,keyEncipherment
EOF
openssl req -newkey rsa:2048 -keyout certs/mitm.key -out certs/mitm.csr -nodes \
  -subj "/CN=cli.speedtest.net" 2>/dev/null
openssl x509 -req -in certs/mitm.csr -CA certs/lab-ca.pem -CAkey certs/lab-ca.key \
  -CAcreateserial -out certs/mitm.pem -days 825 -extfile certs/mitm.ext 2>/dev/null

# 4) CLI trust bundle: system store + lab CA (--ca-certificate REPLACES the store)
cat /etc/ssl/certs/ca-certificates.crt certs/lab-ca.pem > certs/cli-ca-bundle.pem

chmod 600 certs/*.key
echo "== Lab PKI =="
openssl x509 -in certs/lab-ca.pem -noout -subject -fingerprint -sha256
openssl x509 -in certs/server.pem -noout -subject -ext subjectAltName
openssl x509 -in certs/mitm.pem  -noout -subject -ext subjectAltName
ls -la certs/

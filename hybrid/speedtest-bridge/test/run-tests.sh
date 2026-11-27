#!/usr/bin/env bash
# run-tests.sh — speedtest-bridge test battery (three backends + TLS mux +
# per-IP rate limit + PORT-AUTHORITY wiring (multi-port front from
# OoklaServer.properties + gateway over a UNIX socket) + concurrency smoke,
# all vs a local mock worker and mock gateway upstreams). Zero npm deps.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node test/speedtest-bridge.test.mjs "$@"

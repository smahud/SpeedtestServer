#!/usr/bin/env bash
# run-tests.sh — speedtest-bridge test battery (three backends + TLS mux +
# per-IP rate limit + concurrency smoke, all vs a local mock worker and a
# mock gateway upstream). Zero npm dependencies.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node test/speedtest-bridge.test.mjs "$@"

#!/usr/bin/env bash
# run-tests.sh — cli-bridge test battery (three backends vs a local mock
# worker + concurrency smoke). Zero npm dependencies.
set -euo pipefail
cd "$(dirname "$0")/.."
node test/cli-bridge.test.mjs

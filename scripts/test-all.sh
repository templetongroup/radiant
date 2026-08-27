#!/usr/bin/env bash
# Every gate, in one command. Run this before any iPhone build.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
run () { printf '\n=== %s ===\n' "$1"; shift; "$@" || fail=1; }
run "download math"  bash scripts/test-download-math.sh
run "fit verdicts"   node scripts/test-fit.mjs
run "slash commands" node scripts/test-slash.mjs
run "keyboard offset" node scripts/test-keyboard-offset.mjs
run "cloud repair"   node scripts/test-cloud-repair.mjs
run "model catalog"  node scripts/test-catalog.mjs
run "catalog vs HF"  node scripts/test-catalog-live.mjs
run "read me"        node scripts/test-readme.mjs
run "plugin bridge"  node scripts/test-bridge.mjs
run "cloud model"    node scripts/test-cloud-model.mjs
run "electron-safe"  node scripts/test-electron-safe.mjs
run "the running app" bash scripts/test-ui.sh
printf '\n'
if [ "$fail" -ne 0 ]; then echo "SOME GATES FAILED"; exit 1; fi
echo "ALL GATES GREEN"

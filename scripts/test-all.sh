#!/usr/bin/env bash
# Every gate, in one command. Run this before any iPhone build.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
run () { printf '\n=== %s ===\n' "$1"; shift; "$@" || fail=1; }
run "download math"  bash scripts/test-download-math.sh
run "cloud repair"   node scripts/test-cloud-repair.mjs
run "catalog vs HF"  node scripts/test-catalog-live.mjs
run "published list" bash scripts/test-remote-catalog.sh
run "window drag"    node scripts/test-drag.mjs
run "cross-origin"   node scripts/test-origin.mjs
run "command risk"   node scripts/test-command-risk.mjs
run "update asset"   node scripts/test-update-asset.mjs
run "desktop keys"   node scripts/test-desktop-keys.mjs
run "memory"         node scripts/test-memory.mjs
run "electron-safe"  node scripts/test-electron-safe.mjs
run "agents"          node scripts/test-agents.mjs
run "the task board"  node scripts/test-tasks.mjs
run "loops"          node scripts/test-loops.mjs
run "the loop runner" node scripts/test-loop-run.mjs
run "stop"           node scripts/test-stop.mjs
run "round limits"   node scripts/test-rounds.mjs
run "caching"        node scripts/test-caching.mjs
run "chat isolation" node scripts/test-chat-isolation.mjs
run "session writes" node scripts/test-session-write.mjs
run "folder lock"    node scripts/test-lock.mjs
run "phone link"     node scripts/test-phone-link.mjs
run "extension status" node scripts/test-extension-status.mjs
run "turn context"   node scripts/test-turn-context.mjs
run "api & css"      node scripts/test-api.mjs
run "voice"          node scripts/test-voice.mjs
run "gemini voice"   node scripts/test-voice-gemini.mjs
run "decisions"      node scripts/test-decide.mjs
run "what the model saw" node scripts/test-model-saw.mjs
run "fast lane"       node scripts/test-fastlane.mjs
run "preview"         node scripts/test-preview.mjs
run "checkpoints"     node scripts/test-checkpoints.mjs
run "asked and answered" node scripts/test-asked.mjs
run "packaged imports" node scripts/test-packaged-imports.mjs
run "two macs"       node scripts/test-two-macs.mjs
run "install location" node scripts/test-install-location.mjs
run "app layout"     node scripts/test-app-layout.mjs
run "tool bounds"    node scripts/test-tool-bounds.mjs
run "graph rules"    node scripts/test-graph.mjs
run "the graph runner" node scripts/test-graph-run.mjs
run "research helpers" node scripts/test-research-live.mjs
run "fusion and recall" node scripts/test-fusion-recall-live.mjs
run "thrash breaker" node scripts/test-thrash-live.mjs
run "project rules" node scripts/test-project-rules-live.mjs
run "pr status" node scripts/test-pr-status.mjs
run "extension ports" node scripts/test-ext-ports.mjs
run "one turn per chat" node scripts/test-chat-claim-live.mjs
run "token refresh"  node scripts/test-oauth-refresh.mjs
run "sessions"       node scripts/test-sessions.mjs
printf '\n'
if [ "$fail" -ne 0 ]; then echo "SOME GATES FAILED"; exit 1; fi
echo "ALL GATES GREEN"

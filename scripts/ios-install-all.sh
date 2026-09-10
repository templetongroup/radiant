#!/usr/bin/env bash
# Build the iPhone/iPad app once and put it on EVERY paired device that is
# reachable right now.
#
# Standing instruction from Tony (2026-09-10): "when you create new builds to
# the ios version, i want you to update it on all devices." A dev install only
# changes when someone pushes a new one to that device, so a build that lands
# on the iPhone and not the iPads leaves two devices running last week's code
# with no way to tell. This is the whole job in one command.
#
# ⚠️ npx cap sync REWRITES CapApp-SPM/Package.swift and drops the MLX and
# HuggingFace packages (TG-221). The build then fails with "unable to resolve
# module dependency: 'Cmlx'". So the sync is followed by restoring that file
# from git. Do not remove that line.
#
# Devices that are off, asleep, or not on this network are listed at the end as
# skipped — they are not an error, but they are not updated either.
set -euo pipefail
cd "$(dirname "$0")/.."

TEAM=5VY66S6G3M
BUNDLE=com.templetongroup.radiant
PROJ=apps/ios/ios/App/App.xcodeproj

echo "== web bundle + sync"
npm run build >/dev/null
( cd apps/ios && npx cap sync ios >/dev/null )
git checkout -- apps/ios/ios/App/CapApp-SPM/Package.swift

echo "== devices"
# Every paired device is a candidate: tunnelState is "connected" only over USB,
# and a device on Wi-Fi shows "disconnected" right up until devicectl opens a
# tunnel to it for the install. So try them all and report the ones that did
# not answer. The USB one, if any, is the build destination.
xcrun devicectl list devices --timeout 20 --json-output /tmp/radiant-devices.json >/dev/null
DEVICES=$(python3 - <<'PY'
import json
d = json.load(open('/tmp/radiant-devices.json'))
rows = []
for dev in d['result']['devices']:
    cp = dev['connectionProperties']
    if cp.get('pairingState') != 'paired': continue
    rows.append((cp.get('tunnelState') == 'connected', dev['identifier'], dev['deviceProperties']['name']))
for usb, udid, name in sorted(rows, key=lambda r: not r[0]):
    print(f"{udid}\t{'usb' if usb else 'wifi'}\t{name}")
PY
)
echo "$DEVICES" | sed 's/^/   /'

FIRST=$(echo "$DEVICES" | awk -F'\t' '{print $1; exit}')
if [ -z "$FIRST" ]; then echo "no paired device — nothing installed"; exit 1; fi

echo "== build (against $FIRST; one arm64 binary serves every device)"
LOG=/tmp/radiant-ios-build.log
xcodebuild -project "$PROJ" -scheme App -destination "id=$FIRST" -configuration Debug \
  DEVELOPMENT_TEAM=$TEAM -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  -skipPackagePluginValidation -skipMacroValidation build > "$LOG" 2>&1 \
  || { grep "error:" "$LOG" | sed 's/.*error: //' | sort -u | head -5; echo "build failed — see $LOG"; exit 1; }
APP=$(grep -o "/Users/[^ ]*Debug-iphoneos/App.app" "$LOG" | tail -1)
[ -d "$APP" ] || { echo "built, but no App.app in the log"; exit 1; }
echo "   $APP"

echo "== install"
skipped=()
while IFS=$'\t' read -r udid state name; do
  if xcrun devicectl device install app --device "$udid" --timeout 90 "$APP" >/dev/null 2>&1; then
    xcrun devicectl device process launch --device "$udid" $BUNDLE >/dev/null 2>&1 || true
    echo "   ✓ $name"
  else
    echo "   ✗ $name — did not answer"; skipped+=("$name")
  fi
done <<< "$DEVICES"

if [ ${#skipped[@]} -gt 0 ]; then
  echo
  echo "not updated (unreachable): ${skipped[*]}"
  echo "run this again when they are on and awake."
fi

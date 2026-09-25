#!/usr/bin/env bash
# Put the iPhone app on TestFlight from the command line — no Xcode sign-in.
#
# ⚠️ WHY NOT xcodebuild's OWN UPLOAD. Every build up to 28 was signed by Apple's
# cloud signing through the Apple ID signed in to Xcode. With nobody signed in
# (2026-09-25, Tony away from the Mac) that fails with "Failed to Use Accounts",
# and the App Store Connect API key is not allowed cloud signing. So signing is
# LOCAL: an Apple Distribution certificate made with the API key, its key in
# ~/Library/Keychains/radiant-signing.keychain-db (password in
# ~/.appstoreconnect/radiant-signing.keychain-password, so codesign never
# prompts), and the "Radiant App Store (command line)" profile. The upload is
# altool with the same API key.
#
# Usage: scripts/ios-testflight.sh [--no-upload]
# Bump CURRENT_PROJECT_VERSION first: Apple refuses a build number it has seen.
set -euo pipefail
cd "$(dirname "$0")/.."
KC=~/Library/Keychains/radiant-signing.keychain-db
PW=~/.appstoreconnect/radiant-signing.keychain-password
[ -f "$KC" ] && [ -f "$PW" ] || { echo "no signing keychain — see AGENTS.md, TestFlight from the command line"; exit 1; }
set -a; . ~/.appstoreconnect/radiant.env; set +a
PBX=apps/ios/ios/App/App.xcodeproj/project.pbxproj
BUILD=$(grep -m1 'CURRENT_PROJECT_VERSION = ' $PBX | tr -dc '0-9')
VER=$(grep -m1 'MARKETING_VERSION = ' $PBX | sed 's/.*= \(.*\);/\1/')
echo "== Radiant $VER ($BUILD)"

npm run build >/dev/null
( cd apps/ios && npx cap sync ios >/dev/null )
git checkout -- apps/ios/ios/App/CapApp-SPM/Package.swift   # cap sync drops MLX (TG-221)

A=~/Library/Developer/Xcode/Archives/$(date +%F)/Radiant-$VER-build$BUILD.xcarchive
OUT=$(mktemp -d)
rm -rf "$A"
security unlock-keychain -p "$(cat $PW)" "$KC"
echo "== archive"
( cd apps/ios && xcodebuild archive -project ios/App/App.xcodeproj -scheme App -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "$A" DEVELOPMENT_TEAM=5VY66S6G3M \
    -allowProvisioningUpdates -skipPackagePluginValidation -skipMacroValidation >/tmp/radiant-archive.log 2>&1 ) \
  || { tail -20 /tmp/radiant-archive.log; exit 1; }
echo "== sign (Apple Distribution, local)"
xcodebuild -exportArchive -archivePath "$A" -exportOptionsPlist apps/ios/exportOptions-manual.plist \
  -exportPath "$OUT" >/tmp/radiant-export.log 2>&1 || { grep -E "error" /tmp/radiant-export.log | head; exit 1; }
codesign -dvv "$A/Products/Applications/App.app" >/dev/null 2>&1
echo "   $OUT/App.ipa"
[ "${1:-}" = "--no-upload" ] && { echo "== not uploaded (--no-upload)"; exit 0; }
echo "== upload"
xcrun altool --upload-app -f "$OUT/App.ipa" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" 2>&1 | grep -E "UPLOAD|ERROR|error" | head
echo "== uploaded. Apple processes it in 10–20 min; the Internal group gets every build."

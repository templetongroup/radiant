# Radiant — read this first, every turn

## ⚠️ THE iPHONE APP IS WITH APPLE RIGHT NOW — v1.0, build 2

Submitted 2026-08-24 from `~/Library/Developer/Xcode/Archives/2026-08-24/`.
Apple has this binary; the App Store is the one place Radiant ships where a
push to `master` does NOT reach the user.

**That build carries a known defect.** Its catalogue points Gemma 4 E4B and E2B
at `mlx-community/gemma-4-E*B-it-qat-mobile`, whose weights are packed 4-bit
while their config.json declares no quantization. MLX builds a dense model, the
tensor shapes disagree, and the user gets `mismatched parameters` — but only
after downloading 3.5 GB. Fixed on `master` in `e3595d1` (both entries now use
`LLMRegistry.gemma4_e{4,2}b_it_4bit`); the fix is NOT in the build under review.
A reviewer who taps Google's newest model hits it.

**To iterate on what Apple has:** a submitted binary cannot be edited. Raise
`CURRENT_PROJECT_VERSION` (currently 2 — the next upload must be 3 or higher,
App Store Connect rejects a repeat), archive, upload, then in App Store Connect
attach the new build to the submission. While the state is *Waiting for Review*
or *In Review*, use **Remove this version from review** first, swap the build,
and submit again — that keeps the same version 1.0 listing. Once it is
*Pending Developer Release* or on sale, the new build becomes an update instead.
Only Tony can drive App Store Connect; prepare the archive, never assume the
upload happened.

**Before any future submission, run `scripts/catalog-verify.py`.** It now fails
any repo under ~1.2 bytes per parameter that declares no quantization — the
exact defect above, which shipped because the old check only asked whether MLX
implemented the architecture.


Radiant is Tony's own coding harness: an Electron app wrapping a local node
server (`server/index.js`, port 5834) and a React UI (`src/`). It is a public,
MIT-licensed repo, signed and notarized, and it auto-updates from GitHub
Releases. Work on `master`.

## Written is not shipped

**Every change closes all three of these, in the same turn:**

1. **Git** — committed with a real message, and pushed. Tony runs the packaged
   app, not the dev server, and other agents work from other checkouts. An
   uncommitted fix looks exactly like no fix: on 2026-08-22 six corrected files
   sat in the working tree while he tested the release and reported the bug as
   still broken.
2. **The in-app Read me** — the `GUIDE` array in `src/components/Settings.jsx`
   (Settings → "Read me"). Standing rule from Tony: *"you MUST update that
   readme when features are added or changed. end users deserve that."* Write it
   for someone using the app: what they can now do, plain language, US spelling.
3. **Linear** — team **The Templeton Group** (TG), project **Radiant**. Ship
   something → its issue goes to Done, or create one already Done. Spot a
   problem you are not fixing → file it.

**This is automatic, not a question to ask.** Tony has standing authorization:
run the `ship-sync` agent at the end of any turn that changed behavior.

Run the objective half and fix whatever it flags:

```bash
node scripts/ship-check.mjs
```

It verifies committed / pushed / Read-me-kept-current / tagged. Or hand the
whole job to the **`ship-sync`** agent (runs on Haiku, cheap) — it loops until
all three are actually verified rather than merely attempted.

## Releasing

A fix Tony cannot run is not shipped. When a change is user-facing:

```bash
npm version <next> --no-git-tag-version && npm run build
git add -A && git commit -F <message-file>
npx electron-builder --mac          # signs + notarizes; takes a few minutes
git tag v<next> && git push origin master --tags
gh release create v<next> release/Radiant-<next>-arm64.dmg \
  release/Radiant-<next>-arm64.dmg.blockmap \
  release/Radiant-<next>-arm64-mac.zip \
  release/Radiant-<next>-arm64-mac.zip.blockmap \
  release/latest-mac.yml --title "v<next>" --notes-file <notes>
```

All five assets matter — `latest-mac.yml` is what the in-app updater reads.
Confirm with `spctl -a -vv -t install release/mac-arm64/Radiant.app` ("accepted,
Notarized Developer ID"). Commit messages and release notes with apostrophes or
backticks break shell heredocs — write them to a file and use `-F` / `--notes-file`.

## Every release also updates the website

The download page is part of shipping, not a follow-up:

```bash
cp release/Radiant-<v>-arm64.dmg /tmp/radiant.dmg
gh release upload v<v> /tmp/radiant.dmg --clobber      # stable-named asset
```

Then in `~/Projects/templeton-group-dev-website`: set
`showcase/radiant/version.json` to the new version and size, and update the
`js-version` / `js-size` fallbacks in `showcase/radiant/index.html` so a failed
fetch cannot show a stale number. Push to `main` (auto-deploys in ~10s) and
verify the live URL.

⚠️ The DMG is gitignored — 124 MB, past GitHub's file limit — so it never
travels through git. The page links to
`releases/latest/download/radiant.dmg`, which is why that stable-named asset
has to be uploaded on every release. Skipping it is how the site once
advertised 0.6.74 while 0.6.100 was current.

## Sharp edges

- **Two icons, not one.** `build/icon.png` + `build/icon.icns` is the Mac Dock
  icon and copies AiOS's geometry (body 0.896 of canvas, swirl 0.678, measured
  off `~/Projects/aios-claude/mac/icon-1024.png`). The web/iOS set —
  `public/favicon.png`, `public/apple-touch-icon.png`, `public/icon-{192,512}.png`,
  `src/assets/logo-mark.png` — is **full-bleed and signed off; do not change it.**
  `scripts/make-icon.py` writes only the Mac icon unless you pass `--web`.
- **Colors live under `:root[data-mode=…]`**, applied from the config. A device
  that has not signed in never gets a config, so anything that renders before
  auth must work with the mode restored from localStorage in `index.html`.
- **Remote devices** authenticate with a token (Settings → Devices & sharing),
  held in an httpOnly cookie so a phone stays signed in. Loopback is always
  allowed, so test the gate over the Tailscale address, never `127.0.0.1`.
- **`~/.radiant/config.json` has one writer, the server.** Window geometry lives
  in `~/.radiant/window-state.json` precisely to avoid racing it.
- The updater stages a download in `~/Library/Caches/radiant-updater/pending`
  and installs it on quit. It must always hold the newest release or the user
  gets walked up one version at a time.

## The iPhone app

`apps/ios` is a real Capacitor shell around a **separate** UI in `src/mobile`.
It shares no styling with the desktop build: `App.jsx` lazy-imports
`mobile/Phone.jsx` only when `window.Capacitor.isNativePlatform()` is true, so
`mobile.css` and the whole tree stay out of the Mac bundle's entry chunk. Keep
it that way — check `vite build` still emits a separate `Phone-*.js` chunk.

**Building it takes two non-obvious flags.** Plain `xcodebuild` fails twice:

```bash
cd apps/ios && xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -configuration Debug CODE_SIGNING_ALLOWED=NO \
  -skipPackagePluginValidation -skipMacroValidation build
```

- Without `-skipPackagePluginValidation`, it dies on "Validate plug-in CudaBuild
  in package mlx-swift" — an unapproved build-tool plugin, normally a GUI trust
  prompt.
- Do **not** pass `-sdk iphonesimulator`. It forces the host toolchain to that
  SDK and MLX's macro target then cannot resolve SwiftSyntax.

**A Debug build's code is not in `App.app/App`.** That is a 40 KB launcher stub;
the real binary is `App.app/App.debug.dylib` (~79 MB). Verify a Swift change
landed by checking the dylib, not the stub:

```bash
strings -a "$APP/App.debug.dylib" | grep -c downloadProgress
```

### Before you touch the download path

```bash
./scripts/test-download-math.sh
```

Download progress broke FOUR times in production — flatlining at 2%, starting at
100%, showing no number at all, and reporting a stopped download as a finished
model. Every one was pure arithmetic or a folder name. None of it needed MLX, a
simulator, or a phone. But it lived inside a plugin that cannot even initialise
in the Simulator, so the only way to run it was to install a build on Tony's
phone and ask him to watch — which is how he ended up being the test harness for
two lines of division.

That logic now lives in `apps/ios/…/plugins/DownloadMath.swift`, which is pure:
values in, values out, no filesystem, no network, no UIKit. `LocalModels.swift`
calls it and holds no copy. Each shipped bug has a named case in
`scripts/test-download-math.swift`.

Run it before and after any change to downloading, and add a case the moment
something breaks again — before fixing it. If a change to the download path
cannot be expressed as a failing case there, that is a signal the logic is in the
wrong place, not that the test is unnecessary.

**MLX cannot run in the iOS Simulator — the app aborts.** Anything that touches
the model engine (download, generate) dies in `mlx::core::metal::Device::Device()`
with SIGABRT the moment it initialises Metal; the simulator has no GPU MLX will
accept. The app then vanishes and the simulator falls back to whatever was
behind it, which looks like a UI bug and is not one. Read the real reason in
`~/Library/Logs/DiagnosticReports/App-*.ips`.

So the simulator is good for **layout, navigation, first run and accessibility
only**. Any claim about downloading or generating has to be made on a physical
iPhone — build with `-destination 'id=<udid>'`, `DEVELOPMENT_TEAM=5VY66S6G3M`,
`-allowProvisioningUpdates`, then `xcrun devicectl device install app`. Do not
write "verified in the Simulator" about a model actually running.

**Previewing the phone UI without a device.** The native gate means a browser
shows the desktop app. Serve `dist/` with a script that defines
`window.Capacitor` — `isNativePlatform`, `getPlatform`, `nativePromise`,
`addListener` — before the bundle loads, and the phone UI renders at 375×812.
Match the real contracts or you will chase ghosts: sizes are **`sizeGB`** (not
bytes), disk comes from `Device.getInfo().realDiskTotal/realDiskFree`, and the
download events are **`downloadStarted` / `downloadProgress` / `downloadDone` /
`downloadFailed`**. Note a hidden browser pane suspends rAF and clamps
`setTimeout` to ~1s, so screen-push animations never settle and stubbed
progress loops crawl — neither is an app bug.

- **Type on the phone: two rules that have each cost a whole review cycle.**
  1. `-apple-system` and `ui-monospace` are system-font **keywords**. Declare
     them literally — the stack lives on `.is-native body` and everything else
     inherits it. Never put one behind a custom property; `grep -r -- '--rx-font'
     src/mobile` must come back with only the comment that says so.
  2. **`-apple-system-body` is 17px in the app and 16px in mobile Safari** on the
     same simulator — Safari steps web system text down one notch. So the
     `--rx-dt` Dynamic Type probe divides by **17**, and any measurement taken in
     the browser preview above will be one notch small and wrong for the build.
     Body-scale roles use the `font: -apple-system-*` shorthands directly (they
     resolve to UIKit's real 17/17/15/13/12/11 here, which is free Dynamic Type);
     large title, title 2, title 3 and the mono readouts are typed out and scaled
     by `--rx-dt`.

- **Every control in `src/mobile` is a `div`**, so `usePress` carries the
  semantics: `role`, `tabIndex`, `aria-label`, and Enter/Space. Use it for
  anything tappable and pass `label` for an icon-only control. Do not
  reintroduce `outline: none` on `:focus-visible` — it never matches a tap, and
  a phone can have a keyboard, Full Keyboard Access or Switch Control.

## Rating work — the star system

`.claude/skills/star-system/` is vendored from
https://github.com/templetongroup/star-system. Run it when Tony says "rate this"
or "run the star system" after a deliverable, and follow it exactly: ask for the
1–5 rating, never assign one yourself, never argue with it, ask fewer questions
the higher it is, log the round in `ratings.md`, and loop until it reaches 4+.

`ratings.md` at the repo root is the record. Read its **Gold Standards** section
before building anything in an area that already has one — that is the bar for
that area, set by Tony, and new work is measured against it.

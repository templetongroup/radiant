# Radiant for iPhone — read this before touching `apps/ios` or `src/mobile`

The repo's root `AGENTS.md` still applies; `src/mobile/AGENTS.md` adds the
rules for the web screens. Radiant loads this file first and the root one only
partly, so the root's shipping rule, in short: **every change is committed and
pushed, gets a phone Read me entry (`src/mobile/ReadMeScreen.jsx`), and a
Linear issue in TG / Radiant — then `node scripts/ship-check.mjs`.** A phone
change also needs a new build on TestFlight (`scripts/ios-testflight.sh`) and
on every device (`scripts/ios-install-all.sh`).

## App Store status

⚠️ **STILL READ APP STORE CONNECT BEFORE YOU TRUST THIS.** `node
scripts/asc.mjs get 6804891721` prints the live state in one line; this
heading has gone stale three times. 1.0 (build 7) was approved 2026-09-16; 1.1
(build 21) was submitted 2026-09-17 from the command line (`asc.mjs submit`)
and approved the next morning with no questions.

**1.1 carried:** Hugging Face search with a run/won't-run verdict (unfiltered
— TG-454, do not reinstate a word filter), Archive on chats, the keyboard fix,
the unsent-message fix (TG-467), the byline link to templetontech.com, and an
age rating of 17+ — answered honestly for an open model list.

**1.2 is being prepared** (PREPARE_FOR_SUBMISSION on 2026-09-27): the native
SwiftUI rebuild (TG-567), subscription sign-in (TG-570), Jev Router (TG-571),
builds 29–38 on TestFlight. It waits on Tony testing on his phone. Read
`CURRENT_PROJECT_VERSION` in the project file — every upload must be higher.

**Each version is its own review:** a version number in App Store Connect
(`asc.mjs new-version` made 1.2), its own what's new, its own review. Screenshots are
still 1.0's — replace them with the next submission (`asc.mjs shots` counts
them). `scripts/asc.mjs` can do everything short of signing in.

**TestFlight from the command line: `scripts/ios-testflight.sh`** (bump
`CURRENT_PROJECT_VERSION` first). It signs LOCALLY — an Apple Distribution
certificate created with the API key on 2026-09-25 (expires 2027-09-25), its key
in `~/Library/Keychains/radiant-signing.keychain-db`, profile "Radiant App Store
(command line)" — and uploads with `altool`, so it works with nobody signed in
to Xcode. Xcode's own upload needs an Apple ID in Settings → Accounts; the API
key is refused cloud signing. The Internal TestFlight group gets every build.

**Anything to do with the submission: use the `app-store-review` skill**
(`.claude/skills/app-store-review/`, also installed at `~/.claude/skills`;
published at https://github.com/templetongroup/app-store-review — the repo is
the copy people install, so a change here goes there too). It is the whole
adventure — both rejections, the TestFlight false alarm, the privacy Publish
button, the two-button resubmit — turned into a protocol.

**The catalogue is published, not only compiled in.** `apps/ios/catalog.json` is
fetched at launch and applied over the built-in Swift array, so a broken row can
be corrected in minutes instead of a review cycle. It is GENERATED from that
array (`npm run catalog:export`), so the two cannot drift, and every failure
falls back to what shipped.

⚠️ **That also means a bad publish reaches every phone at once.** `npm run
catalog:publish` runs the export, then `scripts/catalog-check.py`, which probes
every repo and refuses on undeclared quantization, a size more than 10% off the
real blob total, or a 404. Do not copy catalog.json to the website by hand.
**Before any future submission, run `npm run catalog:check`.** It fails any repo
under ~1.2 bytes per parameter that declares no quantization — the Gemma 4
defect, which shipped because the old check only asked whether MLX implemented
the architecture. It also builds every row's real config.json with the phone's
engine (the pinned one, and for main-list rows the oldest one still on phones —
App Store 1.1's), which is what would have stopped Nemotron 3 Nano 4B shipping.

## The app, the build and the devices

`apps/ios` is a real Capacitor shell around a **separate** UI in `src/mobile`.
It shares no styling with the desktop build: `App.jsx` lazy-imports
`mobile/Phone.jsx` only when `window.Capacitor.isNativePlatform()` is true, so
`mobile.css` and the whole tree stay out of the Mac bundle's entry chunk. Keep
it that way — check `vite build` still emits a separate `Phone-*.js` chunk.

**Every iOS build goes to every device.** Standing instruction from Tony
(2026-09-10): *"when you create new builds to the ios version, i want you to
update it on all devices."* A dev install only changes when someone pushes a
new one to that device, so a build that lands on one phone leaves the others
on last week's code with no way to tell. One command does the whole job —
web bundle, sync, build once, install on every paired device that answers:

```bash
scripts/ios-install-all.sh
```

It lists the devices that did not answer (off, asleep, not on this network)
at the end; run it again when they are. Devices today: iPhone 17 Pro Max,
iPad Pro 11, iPad mini (A17 Pro). All are on the paid team's profile, which
lasts a year — not the seven days a free Apple ID gets.

⚠️ **The phone app is being rebuilt natively (SwiftUI), Minis-style — Tony, 2026-09-25.**
The native screens live in `apps/ios/ios/App/App/Native/` and are what the app
opens in (build 33+). They do NOT have their own store yet: the web app hands
them a snapshot of every `radiant.phone.*` / `rx.*` localStorage key at launch
(`src/mobile/nativePreview.js` → `NativePreview.open`), they read and write
those keys in the web's exact shapes (`Native/Stores.swift` mirrors chats.js,
skills.js, drafts.js, providers.js, consent.js), and every write goes back as a
`kv` event. So both designs share one set of data and either can be used.
Screens not rebuilt yet open in the web design (`app.openWeb(route)` →
reload onto that route) and returning to Home reopens native. "Use the current
design" sets `radiant.phone.nativeUI` = "0". Rules ported, not reinvented:
themes (NativeKit.swift, same OKLCH values), fit (fit.js), Hugging Face checks
(hf.js), prompt budget and thinking (ChatLogic.swift). The full list of what
the web screens do is `docs/ios-native-inventory.md`. New Swift files must be
registered: `python3 scripts/ios-add-swift.py App/Native/Foo.swift`.

⚠️ **The MLX engine is OUR FORK, pinned to one commit.** `CapApp-SPM/Package.swift`
takes `mlx-swift-lm` from `templetongroup/mlx-swift-lm` at `a57f40f` — Apple's
`14414441` plus one fix: dense Nemotron-H checkpoints (Nemotron 3 Nano 4B) failed
with "Failed to parse config.json" because the reader required MoE keys they do
not have. Sent upstream as ml-explore/mlx-swift-lm#635. When that merges, move
the pin back to ml-explore at a revision that contains it — never to `branch:
"main"` unpinned — and run `npm run catalog:check`, which builds its engine check
from whatever Package.resolved pins.

⚠️ **Before build 28 no phone ever used the published model list.** The shipped
reader (Swift's synthesized decoder) required `vision`/`video` on every row, the
exporter wrote them only when true, and the whole document was rejected. The
exporter now writes every key, build 28's reader tolerates missing ones, and
`scripts/test-remote-catalog.sh` decodes the published list with BOTH the frozen
old reader (`scripts/fixtures/RemoteCatalog-shipped.swift`) and the current one.
A row that needs a newer app goes in `gated` with `minBuild` (set `minBuild:` on
its Swift `Entry`); builds before 28 never read `gated`.

⚠️ `npx cap sync ios` REWRITES `CapApp-SPM/Package.swift` and drops the MLX and
HuggingFace packages (TG-221); the next build fails with "unable to resolve
module dependency: 'Cmlx'". The script restores the file from git after every
sync. If you sync by hand, `git checkout -- apps/ios/ios/App/CapApp-SPM/Package.swift`.

⚠️ **iOS 27 SDK refuses the old app lifecycle.** Build 23 (2026-09-18) was the
first compiled after Xcode moved to the iOS 27 SDK, and it died at launch on
Tony's iPhone with SIGTRAP in
`__UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`. Capacitor's
template has no scene; `App/SceneDelegate.swift` plus the
`UIApplicationSceneManifest` in `Info.plist` are what keep it launching. Do not
let a `cap sync` or a template refresh remove either. Crash reports come off
the phone with `xcrun devicectl device copy from --domain-type systemCrashLogs`.

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

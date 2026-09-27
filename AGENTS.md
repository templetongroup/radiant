# Radiant — read this first, every turn

Radiant is Tony's own coding harness: an Electron app wrapping a local node
server (`server/index.js`, port 5834) and a React UI (`src/`). It is a public,
MIT-licensed repo, signed and notarized, and it auto-updates from GitHub
Releases. Work on `master`.

## Where things are — read the one that matches your work

- **iPhone / iPad app** (`apps/ios`, Swift, TestFlight, App Store, the model
  catalogue): **read `apps/ios/AGENTS.md` first.** It holds the engine fork,
  the build flags, why `npx cap sync ios` breaks the build, the iOS 27 launch
  crash, the download-math test, and the App Store status.
  Standing rule: every iOS build goes to every device
  (`scripts/ios-install-all.sh`).
- **The phone's web screens** (`src/mobile`): `src/mobile/AGENTS.md`, plus the
  iPhone file above.
- **Mac app** (`server/`, `src/`, Electron): this file.
- **Ratings and the bar for each area:** `ratings.md` (Gold Standards).

⚠️ **KEEP THIS FILE UNDER 12,000 CHARACTERS.** Radiant loads a project's
rules file into every chat and stops at 12,000 characters
(`RULES_CAP` in `server/config.js`). At 20,526 this file lost its whole
second half — every iPhone warning — whenever Radiant worked on itself. Add a
topic file and a line here instead of growing this one.

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

It verifies committed / pushed / Read-me-kept-current / tagged — and, fifth,
**judged**: `scripts/ship-judge.mjs` has Jev (a decision model, see
`server/decide.js`) read the commit message and any new Read me entries and
answer whether they say *why* and whether they are written for a person using
the app. On its first run it failed two entries that talked about prompt
caches and tool schemas to users. Below 50% fails the check; unreachable, it
passes and says so. Rewrite in plain words, commit again. Since 2026-09-19 it
also reads the DIFF, per source file: a likely bug or a security hole at
≥ 70% fails; "users would notice, message is silent" and "logic with no test"
print as ⚠ warnings for a person to weigh.

New GitHub issues are sorted the moment they land (`scripts/triage.mjs`, run by
`.github/workflows/triage.yml`): app, kind, severity, possible duplicate — as
labels, with the probability, and nothing under 60% (90% for duplicate) is
applied. `node scripts/triage.mjs --closed --dry-run` shows what it would say. Or hand the
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

Then prune: `scripts/prune-releases.sh`. It deletes every local artifact
except the version just shipped (GitHub Releases is the copy that matters)
and all but the two newest iOS archives. `release/` reached 70 GB — 1,025
files — before anyone looked.

⚠️ The DMG is gitignored — 124 MB, past GitHub's file limit — so it never
travels through git. The page links to
`releases/latest/download/radiant.dmg`, which is why that stable-named asset
has to be uploaded on every release. Skipping it is how the site once
advertised 0.6.74 while 0.6.100 was current.

## Sharp edges

- **Model calls go through `server/net.js` (`modelFetch`), never bare `fetch`.**
  Node's fetch is undici with 300 s headers/body timeouts; a local 27B can be
  silent longer than that while it loads and reads a prompt, and the round
  died with `TypeError: terminated`. `scripts/test-slow-model.mjs` refuses a
  bare fetch on a provider round. Cancellation is the turn's AbortSignal.
- **An empty round is nudged once, then halted with a reason** (providers.js,
  `emptyRounds`); `finish_reason: length` is announced; `<tool_call>` written
  as text is parsed. `scripts/test-empty-turn-live.mjs` drives all four shapes
  through the real server against a scripted provider.

- **Voice conversations are opt-in and the key is server-side.** `src/voice.js`
  (WebRTC to GPT-Live from the renderer) and `server/voice.js` (creates the
  session with an OpenAI *API key* — a ChatGPT sign-in cannot; `voiceKey()`
  takes any key on the OpenAI roster). Client delegation only: the thinking is
  always Radiant's own turn. Nothing runs unless `settings.voice.enabled`.
  `scripts/test-voice.mjs` covers everything short of a microphone; the
  in-app Browser pane blocks the mic, so an end-to-end check needs the
  packaged app.

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

## Rating work — the star system

`.claude/skills/star-system/` is vendored from
https://github.com/templetongroup/star-system. Run it when Tony says "rate this"
or "run the star system" after a deliverable, and follow it exactly: ask for the
1–5 rating, never assign one yourself, never argue with it, ask fewer questions
the higher it is, log the round in `ratings.md`, and loop until it reaches 4+.

`ratings.md` at the repo root is the record. Read its **Gold Standards** section
before building anything in an area that already has one — that is the bar for
that area, set by Tony, and new work is measured against it.

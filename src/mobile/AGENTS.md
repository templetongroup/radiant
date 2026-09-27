# The phone's web screens (`src/mobile`) — read with `apps/ios/AGENTS.md`

These screens run inside the iPhone app (`apps/ios`), so everything in
`apps/ios/AGENTS.md` applies too. Since build 33 the app opens in the native
SwiftUI design; these screens still serve "Use the current design" and any
route the native app hands back (`app.openWeb`).

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

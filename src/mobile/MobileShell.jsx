/**
 * MobileShell — the phone app's chrome: the nav stack, the nav bars, the sheet
 * host, the first-run cover, and the native lifecycle wiring (status bar,
 * Dynamic Type, keyboard metrics).
 *
 * This file owns everything that is NOT a screen. The screens are separate
 * modules; the shell renders each one inside a layer it provides.
 *
 * ── WHY THE SHELL OWNS THE SCROLLER AND THE TITLE ───────────────────────────
 * On iOS a large title is not a header — it is the first thing inside the
 * scroll view, and the bar's inline title crossfades in as the large title
 * slides under it. That only works if one component owns both the bar and the
 * scroller, so for scrolling screens the shell renders the scroll container and
 * the screen renders content into it. A screen that owns its own layout (Chat:
 * transcript scroller plus a pinned composer) opts out — see SCREENS below.
 *
 * ── CONTRACT WITH THE SIBLING SCREENS ───────────────────────────────────────
 * Every screen receives:
 *   nav        { push, pop, replace, presentSheet, dismissSheet, openChat,
 *                depth }
 *   local      the whole useLocalModels() value, so a screen can use whatever
 *              shape that hook ended up with without the shell re-deriving it
 *   models     local.models normalized to an array
 *   setChrome  (patch) => void — updates this screen's nav bar at runtime:
 *              { title, subtitle, subtitleMono, scrolled, menu }
 *              Chat uses it for the "18 tok/s" subtitle while generating.
 * Plus per-screen props, listed at each render site below.
 *
 * Screen modules are pulled in as namespace imports and resolved through
 * pick(): these files are being written in parallel, and a namespace import
 * links whether the module ends up with a default export, a named one, or
 * (briefly) neither. A missing screen renders a placeholder rather than taking
 * the whole app down — which is what you want while the siblings land.
 *
 * ── THE ONE RULE ────────────────────────────────────────────────────────────
 * Nothing here is imported by the desktop app, and src/styles.css is never
 * loaded on the phone. So this file assumes only the --rx-* tokens from
 * mobile.css, and carries a fallback for every single one of them.
 */
import React, {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState
} from 'react'

import * as ModelsScreenMod from './ModelsScreen.jsx'
import * as ChatScreenMod from './ChatScreen.jsx'
import * as GetModelSheetMod from './GetModelSheet.jsx'
import * as FirstRunMod from './FirstRun.jsx'
import SettingsScreen from './SettingsScreen.jsx'
import HomeScreen from './HomeScreen.jsx'
import { listChats, newChatId } from './chats.js'
import ReadMeScreen from './ReadMeScreen.jsx'
import ProvidersScreen from './ProvidersScreen.jsx'
import SkillsScreen from './SkillsScreen.jsx'
import { appleAsModel, checkApple, onAppleChecked, appleState, APPLE_ID } from './appleModel.js'
import { loadAppearance, applyAppearance } from './theme.js'
import * as useLocalModelsMod from './useLocalModels.js'
import * as hapticsMod from './haptics.js'

import { chosenAsModel, onChosenChanged, saveChosen } from './providers.js'

// ── module resolution ───────────────────────────────────────────────────────

const pick = (mod, ...names) => {
  if (!mod) return null
  if (typeof mod.default === 'function') return mod.default
  for (const n of names) if (typeof mod[n] === 'function') return mod[n]
  return null
}

const Missing = (name) => function MissingScreen () {
  return (
    <div style={{ padding: 16, color: 'var(--rx-label-2, rgba(60,60,67,0.6))', fontSize: 'calc(17px * var(--rx-dt, 1))', lineHeight: 1.294, fontWeight: 400 }}>
      {name} has not landed yet.
    </div>
  )
}

const ModelsScreen = pick(ModelsScreenMod, 'ModelsScreen') || Missing('ModelsScreen')
const ChatScreen = pick(ChatScreenMod, 'ChatScreen') || Missing('ChatScreen')
const GetModelSheet = pick(GetModelSheetMod, 'GetModelSheet') || null
const FirstRun = pick(FirstRunMod, 'FirstRun') || null
// a hook has to be resolved once, at module scope — resolving it per render
// would make the hook call conditional on another module's load order
const useLocalModels = pick(useLocalModelsMod, 'useLocalModels') || (() => ({ models: [] }))

// haptics.js is the only place the Haptics plugin is touched, but its export
// shape is a sibling's call. Try the module first, then the plugin, then no-op:
// a haptic is feedback, and feedback must never be able to throw.
const haptic = (kind, arg) => {
  try {
    const h = hapticsMod.default || hapticsMod
    if (h && typeof h[kind] === 'function') { h[kind](arg); return }
    const P = window.Capacitor?.Plugins
    if (kind === 'selection') P?.Haptics?.selectionStart?.()
    else if (kind === 'notification') P?.Haptics?.notification?.({ type: arg || 'SUCCESS' })
    else P?.Haptics?.impact?.({ style: arg || 'LIGHT' })
  } catch { /* never let a buzz break a tap */ }
}

// ── the bits of styling inline styles cannot express ────────────────────────
// Scoped to .rx-shell-*, so mobile.css remains the owner of everything else and
// can override any of this on specificity alone.

const SHELL_CSS = `
.rx-shell-root, .rx-shell-root * { -webkit-tap-highlight-color: transparent; }
.rx-shell-scroll::-webkit-scrollbar, .rx-shell-menu::-webkit-scrollbar { display: none; }
/* At rest an iOS bar is not a bar: it is the page, with the large title in the
   scroller under it. The material and the hairline arrive together, the moment
   content slides underneath. A permanently frosted bar reads as a web header
   before anyone has read a word. */
.rx-shell-bar { background: transparent; }
.rx-shell-bar[data-solid="true"] {
  -webkit-backdrop-filter: blur(30px) saturate(180%);
  backdrop-filter: blur(30px) saturate(180%);
  background: rgba(255,255,255,0.72);
}
.rx-shell-menu {
  -webkit-backdrop-filter: blur(50px) saturate(180%);
  backdrop-filter: blur(50px) saturate(180%);
  background: rgba(242,242,247,0.86);
}
/* Keyed off the app's mode, NOT the phone's — see data-rx-dark in theme.js.
   This is the FOURTH stylesheet in src/mobile and the one that draws the nav
   bar; a previous pass converted the other three and left this, so Settings
   kept a light bar over dark content. */
.is-native[data-rx-dark='true'] .rx-shell-bar[data-solid="true"] { background: rgba(30,30,30,0.72); }
.is-native[data-rx-dark='true'] .rx-shell-menu { background: rgba(28,28,30,0.90); }
/* vibrancy off: go fully opaque plus a hairline, rather than leaving a flat
   translucent-looking fill behind */
@media (prefers-reduced-transparency: reduce) {
  .rx-shell-bar[data-solid="true"] { -webkit-backdrop-filter: none; backdrop-filter: none; background: var(--rx-bg, #fff); }
  .rx-shell-menu { -webkit-backdrop-filter: none; backdrop-filter: none; background: var(--rx-bg-grouped, #F2F2F7); }
}
@media (prefers-reduced-transparency: reduce) {
  .is-native[data-rx-dark='true'] .rx-shell-bar[data-solid="true"], .rx-shell-menu { background: #1C1C1E; }
}
/* Press states are JS-driven with a 10pt slop cancel. There is not one :hover
   rule in this file: on iOS a :hover sticks after the tap and the control stays
   lit, which is the fastest way to be caught out as a web view. */
.rx-shell-barbtn { opacity: 1; transition: opacity var(--rx-dur-press, 322ms) var(--rx-press, ease-out); }
.rx-shell-barbtn[data-pressed="true"] { opacity: .35; transition: none; }
.rx-shell-row { transition: background-color 250ms linear; }
.rx-shell-row[data-pressed="true"] { background-color: var(--rx-fill-1, rgba(120,120,128,0.2)); transition: none; }
@keyframes rx-shell-menu-in { from { opacity: 0; transform: scale(.92); } to { opacity: 1; transform: scale(1); } }
`

// ── environment hooks ───────────────────────────────────────────────────────

function useMedia (query) {
  const [on, setOn] = useState(() => window.matchMedia?.(query).matches ?? false)
  useEffect(() => {
    const mq = window.matchMedia?.(query)
    if (!mq) return
    const fn = (e) => setOn(e.matches)
    mq.addEventListener('change', fn)
    setOn(mq.matches)
    return () => mq.removeEventListener('change', fn)
  }, [query])
  return on
}

/**
 * Dynamic Type. WebKit's `-apple-system-body` and friends already track the
 * user's Text Size setting, but there is no system shorthand for a large title
 * or a mono readout — so measure the scale once from a probe and publish it as
 * --rx-dt for the hand-set sizes. Re-measure on resize and on return from the
 * background: the setting can change while we are not running.
 */
function useDynamicType () {
  useEffect(() => {
    const measure = () => {
      const p = document.createElement('span')
      p.style.font = '-apple-system-body'
      p.style.position = 'fixed'
      p.style.visibility = 'hidden'
      p.textContent = 'M'
      document.body.appendChild(p)
      // ⚠️ 17, AND THE MEASUREMENT IS ON RECORD SO NOBODY RE-LITIGATES IT.
      // `-apple-system-body` does NOT resolve the same everywhere: measured from
      // inside this app's WKWebView on iPhone 17 Pro / iOS 26 it is 17px, which
      // is UIKit's real Body size, while MOBILE SAFARI on the same simulator
      // reports 16px for the identical declaration — Safari steps web system
      // text down one notch and the app does not. So a probe run in Safari (or
      // in any browser preview of this UI) will tell you 16 and be wrong for the
      // shipping app. 17 puts the factor at exactly 1.0 at the default Text Size
      // and it still tracks Dynamic Type proportionally above that.
      const dt = parseFloat(getComputedStyle(p).fontSize) / 17
      p.remove()
      // The SYSTEM's factor, times the user's own multiplier from Settings.
      // Both, in one number, because --rx-dt is what every hand-set role
      // actually reads — Settings used to write a separate variable that no
      // rule consumed, so Text size moved nothing.
      const user = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--rx-user-scale')
      ) || 1
      const v = Math.min(Math.max((dt || 1) * user, 0.82), 2.0)
      // On the ROOT, not the shell element: mobile.css keys accessibility
      // reflow off `.is-native[data-ax]`, and several rules that read --rx-dt
      // live on overlays (the sheet, the menu) that are not inside the shell.
      const root = document.documentElement
      root.style.setProperty('--rx-dt', String(v))
      if (v > 1.2) root.setAttribute('data-ax', 'true')
      else root.removeAttribute('data-ax')
    }
    measure()
    window.addEventListener('resize', measure)
    document.addEventListener('visibilitychange', measure)
    // re-measure when the user changes the size in Settings, and when iOS
    // changes it under us — the review found a live change left this frozen
    window.addEventListener('rx:text-scale', measure)
    const ro = new ResizeObserver(measure)
    try { ro.observe(document.body) } catch {}
    return () => {
      window.removeEventListener('resize', measure)
      document.removeEventListener('visibilitychange', measure)
      window.removeEventListener('rx:text-scale', measure)
      ro.disconnect()
    }
  }, [])
}

/* The status bar is written by theme.js:syncNativeChrome() and by NOTHING
   ELSE. There used to be a useStatusBar() here as well, keyed off
   prefers-color-scheme and with the opposite polarity, and because its effect
   ran last it won — so with the phone in Dark the clock and battery rendered as
   dark glyphs on a dark bar at 1.02:1, invisible, for the app's own default
   audience. Two owners of one piece of native chrome is the bug; deleting one
   is the fix. */

/**
 * Keyboard metrics, published as --rx-kb (px) and --rx-kb-dur (ms) on the shell
 * root so the composer can ride the keyboard exactly rather than approximately.
 * Height comes from visualViewport because Keyboard.resize is 'none'; the
 * duration comes from the plugin's will-show event, because guessing 250ms is
 * visible in slow motion and somebody always films it in slow motion.
 */
function useKeyboardMetrics (rootRef) {
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const vv = window.visualViewport
    let raf = 0
    const sync = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const inset = vv ? Math.max(0, window.innerHeight - (vv.height + vv.offsetTop)) : 0
        el.style.setProperty('--rx-kb', `${Math.round(inset)}px`)
        el.classList.toggle('rx-kb-open', inset > 60)
      })
    }
    sync()
    vv?.addEventListener('resize', sync)
    vv?.addEventListener('scroll', sync)

    const P = window.Capacitor?.Plugins?.Keyboard
    const subs = []
    const readCurve = (info) => {
      const secs = typeof info?.duration === 'number' && info.duration > 0 ? info.duration : 0.25
      el.style.setProperty('--rx-kb-dur', `${Math.round(secs * 1000)}ms`)
    }
    P?.addListener?.('keyboardWillShow', readCurve)?.then?.(h => subs.push(h))
    P?.addListener?.('keyboardWillHide', readCurve)?.then?.(h => subs.push(h))

    return () => {
      cancelAnimationFrame(raf)
      vv?.removeEventListener('resize', sync)
      vv?.removeEventListener('scroll', sync)
      subs.forEach(h => h?.remove?.())
    }
  }, [rootRef])
}

// ── press handling ──────────────────────────────────────────────────────────

const SLOP = 10 // pt — past this the finger has become a scroll, not a tap

function usePress (onPress, { kind = 'impact', arg = 'LIGHT' } = {}) {
  const state = useRef({ x: 0, y: 0, live: false })
  const mark = (e, v) => { e.currentTarget.dataset.pressed = v ? 'true' : 'false' }
  return {
    onPointerDown (e) { state.current = { x: e.clientX, y: e.clientY, live: true }; mark(e, true) },
    onPointerMove (e) {
      if (!state.current.live) return
      if (Math.hypot(e.clientX - state.current.x, e.clientY - state.current.y) > SLOP) {
        state.current.live = false
        mark(e, false)
      }
    },
    onPointerUp (e) {
      const live = state.current.live
      state.current.live = false
      mark(e, false)
      // commit on touch-up inside the bounds, the way UIKit does. A tap that
      // commits on touch-down feels twitchy and cannot be cancelled.
      if (live) { haptic(kind, arg); onPress?.(e) }
    },
    onPointerCancel (e) { state.current.live = false; mark(e, false) }
  }
}

// ── icons: SF Symbols geometry, drawn rather than imported ──────────────────
// Icons.jsx is styled by styles.css, which is not loaded here.

const Chevron = ({ size = 17 }) => (
  <svg width={size * 0.62} height={size} viewBox="0 0 11 18" fill="none" aria-hidden="true">
    <path d="M9 1.5 1.8 9 9 16.5" stroke="currentColor" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/**
 * gearshape. ⚠️ IT IS ONE CONTINUOUS OUTLINE, NOT A RING WITH THINGS AROUND IT.
 * Two earlier attempts drew the teeth as separate marks over a circle — first
 * eight radial strokes (a sun with uneven rays), then eight small rects over a
 * ring at r 6.6 with a second ring at r 2.5 inside it, which reads as chunky
 * triangular teeth around an oversized centre dot. The SF Symbol is a single
 * closed path that alternates between an outer and an inner radius, stroked at
 * a constant weight with round joins, plus one hollow centre. The path below is
 * generated from Ro 10.1 / Ri 7.4 on a 22 box: 8 teeth, each 22° of outer arc,
 * 6° flanks and a 23° valley, so the teeth are as wide as the gaps the way the
 * symbol's are. The round joins are what make the corners read as Apple's, and
 * the centre is a hole at r 3.55, not a dot.
 */
const GEAR_PATH = 'M9.07 1.09 L12.93 1.09 L13.16 3.92 L14.47 4.47 L16.65 2.63 L19.37 5.35 '
  + 'L17.53 7.53 L18.08 8.84 L20.91 9.07 L20.91 12.93 L18.08 13.16 L17.53 14.47 L19.37 16.65 '
  + 'L16.65 19.37 L14.47 17.53 L13.16 18.08 L12.93 20.91 L9.07 20.91 L8.84 18.08 L7.53 17.53 '
  + 'L5.35 19.37 L2.63 16.65 L4.47 14.47 L3.92 13.16 L1.09 12.93 L1.09 9.07 L3.92 8.84 '
  + 'L4.47 7.53 L2.63 5.35 L5.35 2.63 L7.53 4.47 L8.84 3.92 Z'

const Gearshape = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 22 22" fill="none" aria-hidden="true">
    <path d={GEAR_PATH} stroke="currentColor" strokeWidth="1.6"
      strokeLinejoin="round" strokeLinecap="round" />
    <circle cx="11" cy="11" r="3.55" stroke="currentColor" strokeWidth="1.6" />
  </svg>
)

const EllipsisCircle = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="10.1" stroke="currentColor" strokeWidth="1.7" />
    <circle cx="7.4" cy="12" r="1.25" fill="currentColor" />
    <circle cx="12" cy="12" r="1.25" fill="currentColor" />
    <circle cx="16.6" cy="12" r="1.25" fill="currentColor" />
  </svg>
)

// ── route table ─────────────────────────────────────────────────────────────
// `scroll: false` means the screen owns its own layout and scrolling; the shell
// still draws the bar but leaves the body alone. Chat needs that — a pinned
// composer cannot live inside somebody else's scroll view.

const SCREENS = {
  // Home is the root. Models used to be, which is why the app opened onto an
  // inventory of files to install rather than somewhere to arrive.
  // no large title: Home's own lockup is its header, and 'Radiant' set in
  // the bar above a RADIANT wordmark would be the name twice.
  home: { title: '', large: false, scroll: true, bg: 'grouped' },
  models: { title: 'Models', large: true, scroll: true, bg: 'grouped' },
  // `bare` means the screen draws its own nav bar too. Chat does: its title,
  // its composer and its transcript scroller are one layout, and splitting the
  // bar off would put a pinned composer inside somebody else's scroll view.
  chat: { title: '', large: false, scroll: false, bg: 'plain', bare: true },
  settings: { title: 'Settings', large: true, scroll: true, bg: 'grouped' },
  readme: { title: 'Read me', large: false, scroll: true, bg: 'grouped' },
  providers: { title: 'Providers', large: false, scroll: true, bg: 'grouped' },
  skills: { title: 'Skills', large: false, scroll: true, bg: 'grouped' }
}

const BG = {
  grouped: 'var(--rx-bg-grouped, #F2F2F7)',
  plain: 'var(--rx-bg, #FFFFFF)'
}

const BAR_H = 44

// ⚠️ THE TRAILING BAR BUTTON IS A CIRCULAR CHIP, NOT A BARE GLYPH.
// Measured off Settings on this simulator (iPhone 17 Pro / iOS 26): its back
// control is a 44pt circle filled rgb(251,251,255) — very slightly lighter than
// the grouped background it sits on — with a soft ambient shadow and no border.
// A glyph floating bare in the bar is a previous OS era, and on the root screen
// it is the only piece of chrome there is, so it carries the whole first
// impression. The button is the chip: 44pt of hit area IS the visible circle.
const barButtonStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 44, height: 44, padding: 0,
  appearance: 'none', border: 0,
  borderRadius: 999,
  background: 'var(--rx-bar-chip)',
  boxShadow: 'var(--rx-bar-chip-shadow)',
  color: 'var(--rx-tint, #3F69A7)',
  touchAction: 'manipulation'
}
// the bar's own 16pt optical margin, now that the chip owns the 44
const barButtonSlot = { display: 'flex', alignItems: 'center', padding: '0 16px' }

// ── the nav bar ─────────────────────────────────────────────────────────────

function NavBar ({ config, chrome, title, subtitle, backTitle, onBack, trailing, hairlineRef }) {
  const barRef = useRef(null)
  const back = usePress(onBack)

  // The hairline appears only once content is under the bar, and it is driven
  // from an IntersectionObserver sentinel rather than a scroll handler. This is
  // the single most-missed detail in iOS-styled web UI: a permanently bordered
  // header reads as a web page before anyone has read a word.
  const paint = useCallback((on) => {
    const el = barRef.current
    if (el) {
      el.style.borderBottomColor = on
        ? 'var(--rx-hairline, rgba(60,60,67,0.12))'
        : 'transparent'
      el.dataset.solid = on ? 'true' : 'false'
    }
  }, [])

  useEffect(() => {
    if (!hairlineRef) return
    hairlineRef.current = paint
    return () => { hairlineRef.current = null }
  }, [hairlineRef, paint])

  // a screen that owns its own scroller (Chat) drives the same hairline through
  // setChrome({ scrolled }) instead of the shell reaching into its DOM
  useEffect(() => {
    if (chrome.scrolled == null) return
    paint(chrome.scrolled)
  }, [chrome.scrolled, paint])

  return (
    <div
      ref={barRef}
      className="rx-shell-bar"
      style={{
        position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20,
        paddingTop: 'env(safe-area-inset-top)',
        // 1px of --rx-hairline. The spec's 0.5px was a guess that measured
        // wrong: on this simulator it renders as TWO device pixels, and at the
        // 0.29-alpha separator that is twice the ink of Apple's own hairline,
        // which is 1pt of #E8E8E8. See the token in mobile.css.
        borderBottom: '1px solid transparent',
        transition: 'border-bottom-color 180ms linear'
      }}
    >
      <div style={{ height: BAR_H, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {onBack && (
          <button
            type="button" className="rx-shell-barbtn" {...back}
            /* ⚠️ WITHOUT THIS VOICEOVER SAYS ONLY "button". The label text
               beside the chevron can be empty — it is elided at narrow widths
               and absent on some routes — so the button's name cannot depend on
               it. Caught by the runtime gauntlet, which reads what is actually
               rendered rather than what the source implies. */
            aria-label={backTitle ? `Back to ${backTitle}` : "Back"}
            style={{
              position: 'absolute', left: 0, top: 0, bottom: 0,
              display: 'flex', alignItems: 'center', gap: 4,
              minWidth: 44, padding: '0 8px',
              appearance: 'none', border: 0, background: 'none',
              color: 'var(--rx-tint, #3F69A7)',
              fontSize: 'calc(17px * var(--rx-dt, 1))', lineHeight: 1.294, fontWeight: 400,
              touchAction: 'manipulation'
            }}
          >
            <Chevron />
            <span style={{ maxWidth: '9em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {backTitle}
            </span>
          </button>
        )}

        {/* The inline title. On a large-title screen it starts invisible and is
            crossfaded in by the scroll handler — continuously, not flipped at a
            threshold, because a threshold flip is visible as a pop. */}
        <div
          data-rx-inline-title=""
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            lineHeight: 1.05, maxWidth: '56%', pointerEvents: 'none',
            opacity: config.large ? 0 : 1,
            transform: config.large ? 'translateY(4px)' : 'none'
          }}
        >
          <span style={{
            fontSize: 'calc(17px * var(--rx-dt, 1))', lineHeight: 1.294, fontWeight: 600,
            color: 'var(--rx-label, #000)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%'
          }}>{title}</span>
          {subtitle && (
            <span style={{
              fontSize: 'calc(11px * var(--rx-dt, 1))', lineHeight: 1.2, marginTop: 1,
              color: 'var(--rx-label-2, rgba(60,60,67,0.6))',
              // tok/s changes in place, and a figure that jitters as it counts
              // is a small failure people feel without being able to name it
              fontFamily: chrome.subtitleMono
                ? 'ui-monospace, "SF Mono", Menlo, monospace'
                : 'inherit',
              fontVariantNumeric: 'tabular-nums'
            }}>{subtitle}</span>
          )}
        </div>

        {trailing && (
          <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, ...barButtonSlot }}>
            {trailing}
          </div>
        )}
      </div>
    </div>
  )
}

// ── one screen in the stack ─────────────────────────────────────────────────

function Layer ({
  route, chrome, title, subtitle, backTitle, onBack, trailing,
  children, layerRef, dimRef, inert
}) {
  const config = SCREENS[route] || SCREENS.models
  const scrollRef = useRef(null)
  const largeRef = useRef(null)
  const sentinelRef = useRef(null)
  const hairlineRef = useRef(null)

  // Large title → inline title, driven continuously off the scroll offset and
  // written straight to the DOM inside a rAF. A setState per scroll frame would
  // drop the app off 120Hz on a ProMotion phone, and that is felt rather than
  // seen.
  useEffect(() => {
    if (!config.scroll || !config.large) return
    const sc = scrollRef.current
    const large = largeRef.current
    if (!sc || !large) return
    const inline = sc.parentNode?.querySelector('[data-rx-inline-title]')
    let raf = 0
    const apply = () => {
      raf = 0
      const h = Math.max(1, large.offsetHeight - 12)
      const p = Math.min(1, Math.max(0, sc.scrollTop / h))
      large.style.opacity = String(1 - p)
      if (inline) {
        inline.style.opacity = String(p)
        inline.style.transform = `translateY(${(1 - p) * 4}px)`
      }
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(apply) }
    apply()
    sc.addEventListener('scroll', onScroll, { passive: true })
    return () => { sc.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf) }
  }, [config.scroll, config.large])

  // The hairline sentinel sits at the top of the content, which the bar covers.
  // The observer root therefore has to be inset by the scroller's own top
  // padding — otherwise the sentinel stays "visible" while sliding under the
  // bar and the hairline never appears.
  useEffect(() => {
    if (!config.scroll) return
    let io = null
    const attach = () => {
      io?.disconnect()
      const sc = scrollRef.current
      const sn = sentinelRef.current
      if (!sc || !sn) return
      const padTop = parseFloat(getComputedStyle(sc).paddingTop) || 0
      io = new IntersectionObserver(
        ([e]) => hairlineRef.current?.(!e.isIntersecting),
        { root: sc, rootMargin: `-${padTop}px 0px 0px 0px`, threshold: 0 }
      )
      io.observe(sn)
    }
    attach()
    // rotation changes the safe-area inset, and therefore the padding we just
    // measured
    window.addEventListener('resize', attach)
    return () => { window.removeEventListener('resize', attach); io?.disconnect() }
  }, [config.scroll])

  const body = config.bare ? (
    <div style={{ position: 'absolute', inset: 0 }}>{children}</div>
  ) : config.scroll ? (
    <div
      ref={scrollRef}
      className="rx-shell-scroll"
      style={{
        position: 'absolute', inset: 0,
        overflowY: 'auto', overflowX: 'hidden',
        // rubber band stays ON inside scrollers — a list that cannot bounce
        // feels dead. It is killed on the shell root instead.
        overscrollBehaviorY: 'contain',
        scrollbarWidth: 'none',
        paddingTop: `calc(${BAR_H}px + env(safe-area-inset-top))`,
        paddingBottom: 'max(8px, env(safe-area-inset-bottom))'
      }}
    >
      <div ref={sentinelRef} style={{ height: 1, marginBottom: -1 }} aria-hidden="true" />
      {config.large && (
        <h1
          ref={largeRef}
          style={{
            // no bottom padding: a 34px line box already carries ~9pt of empty
            // descender space under a word with no descenders, and the block
            // below adds its own 16. Padding here on top of both measured 71pt
            // of dead air on the launch screen — Settings runs about 10.
            // 20, not 16: the large title shares the layout margin with the
            // cards below it, and Settings on this simulator puts both at 20.
            margin: 0, padding: '4px 20px 0',
            fontSize: 'calc(34px * var(--rx-dt, 1))',
            lineHeight: 1.21, fontWeight: 700,
            // the only place tracking is set by hand; SF's optical tracking is
            // already right at every other size and overriding it is a tell
            letterSpacing: '-0.4px',
            color: 'var(--rx-label, #000)'
          }}
        >{title}</h1>
      )}
      {children}
    </div>
  ) : (
    <div style={{ position: 'absolute', inset: 0, paddingTop: `calc(${BAR_H}px + env(safe-area-inset-top))` }}>
      {children}
    </div>
  )

  return (
    <div
      ref={layerRef}
      className="rx-shell-layer"
      aria-hidden={inert ? 'true' : undefined}
      // ⚠️ `inert`, not just aria-hidden + pointer-events. Those two hide a
      // buried layer from the eye and the finger and leave every control on it
      // FOCUSABLE: with Settings open, ten controls on the Models screen
      // underneath were still reachable by keyboard, and Enter on one started an
      // 0.8 GB download on a screen the user cannot see. aria-hidden over a
      // focusable control is also a straight WCAG 4.1.2 failure. `inert` removes
      // a subtree from focus, hit-testing and the accessibility tree at once.
      inert={inert ? '' : undefined}
      style={{
        position: 'absolute', inset: 0,
        background: BG[config.bg],
        willChange: 'transform',
        pointerEvents: inert ? 'none' : 'auto',
        overflow: 'hidden'
      }}
    >
      {body}
      {!config.bare && <NavBar
        config={config}
        chrome={chrome}
        title={title}
        subtitle={subtitle}
        backTitle={backTitle}
        onBack={onBack}
        trailing={trailing}
        hairlineRef={hairlineRef}
      />}
      {/* The wash the outgoing view takes during a push. A full-width slide over
          a static background is the clearest Android/web fingerprint in mobile
          motion; the −30% parallax plus this 0.12 dim is what makes it read as
          UIKit. */}
      <div
        ref={dimRef}
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, background: '#000', opacity: 0, pointerEvents: 'none' }}
      />
    </div>
  )
}

// ── the context menu behind Chat's ellipsis ─────────────────────────────────

function ContextMenu ({ items, onClose, reduce }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60 }} onPointerDown={onClose}>
      <div
        className="rx-shell-menu"
        onPointerDown={e => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 'calc(env(safe-area-inset-top) + 46px)',
          right: 12, minWidth: 250,
          borderRadius: 13, overflow: 'hidden',
          boxShadow: '0 12px 34px rgba(0,0,0,0.22)',
          transformOrigin: 'top right',
          animation: reduce ? 'none' : 'rx-shell-menu-in var(--rx-dur-pop, 316ms) var(--rx-pop, ease-out) both'
        }}
      >
        {items.map((it, i) => (
          <MenuRow key={it.key || i} item={it} first={i === 0} onClose={onClose} />
        ))}
      </div>
    </div>
  )
}

function MenuRow ({ item, first, onClose }) {
  const press = usePress(() => { onClose(); item.run?.() })
  return (
    <button
      type="button" className="rx-shell-row" {...press}
      style={{
        display: 'flex', alignItems: 'center', width: '100%',
        minHeight: 44, padding: '0 16px',
        appearance: 'none', border: 0, background: 'transparent', textAlign: 'left',
        borderTop: first ? 'none' : '1px solid var(--rx-hairline, rgba(60,60,67,0.12))',
        color: item.destructive ? 'var(--rx-red-text, #D70015)' : 'var(--rx-label, #000)',
        fontSize: 'calc(17px * var(--rx-dt, 1))', lineHeight: 1.294, fontWeight: 400, touchAction: 'manipulation'
      }}
    >{item.label}</button>
  )
}

// ── shell state helpers ─────────────────────────────────────────────────────

const ACTIVE_MODEL_KEY = 'rx.activeModel'
const FIRSTRUN_KEY = 'rx.firstRunDone'

/**
 * Launch behavior: a returning user lands back in the conversation, so Back
 * always reads "Models" and nobody arrives at a list they did not ask for. The
 * shell only needs to know a transcript exists, not what is in it — so it looks
 * for any persisted conversation key rather than owning Chat's storage format.
 */
function hasSavedConversation () {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !/^(rx|radiant)\..*(chat|conversation|transcript)/i.test(k)) continue
      const v = localStorage.getItem(k)
      if (v && v.length > 8 && v !== '[]' && v !== '{}' && v !== 'null') return true
    }
  } catch { /* private mode: treat it as a first launch */ }
  return false
}

// ChatScreen owns what "new conversation" and "delete conversation" mean; the
// shell only owns the bar button that offers them.
function emitChatAction (action) {
  window.dispatchEvent(new CustomEvent('rx:chat-action', { detail: { action } }))
}

// ── the shell ───────────────────────────────────────────────────────────────

export default function MobileShell () {
  const rootRef = useRef(null)
  const dark = useMedia('(prefers-color-scheme: dark)')
  const reduce = useMedia('(prefers-reduced-motion: reduce)')

  useDynamicType()
  useKeyboardMetrics(rootRef)

  useEffect(() => { document.documentElement.classList.add('is-native') }, [])

  const local = useLocalModels() || {}
  const models = useMemo(() => (
    Array.isArray(local.models) ? local.models
      : Array.isArray(local.catalog) ? local.catalog
        : []
  ), [local.models, local.catalog])
  const downloaded = useMemo(() => models.filter(m => m?.downloaded), [models])

  // Which model Chat is pointed at. Persisted because the shell, not Chat, is
  // what decides where the app opens.
  const [activeModelId, setActiveModelId] = useState(() => {
    try { return localStorage.getItem(ACTIVE_MODEL_KEY) || null } catch { return null }
  })
  // ⚠️ A CHOSEN CLOUD MODEL IS THE ACTIVE MODEL. MobileChat already sends to it
  // instead of the on-device one; before this, every screen still named a local
  // model, so the app told the user one thing and did another.
  const [cloudModel, setCloudModel] = useState(() => chosenAsModel())
  useEffect(() => onChosenChanged(() => setCloudModel(chosenAsModel())), [])

  // ⚠️ APPLE'S MODEL IS THE FLOOR, NOT A CATALOGUE ENTRY. It is never
  // downloaded and never removed, so it does not belong in `models`; it is
  // appended to what the phone can actually run. Asked once per launch.
  const [apple, setApple] = useState(() => appleState())
  useEffect(() => { checkApple(); return onAppleChecked(setApple) }, [])
  const appleModel = useMemo(() => (apple?.available ? appleAsModel() : null), [apple])

  // ⚠️ SEARCH `downloaded`, NOT `models`. This read the whole 44-model catalogue,
  // so a model the user had REMOVED still matched by id — it is still in the
  // catalogue, just with downloaded:false. Tony removed every model and Home
  // went on saying "Current model: Qwen 3 1.7B", New chat stayed enabled, and
  // the chat it opened was titled Qwen: a conversation pointed at weights that
  // were no longer on the phone. Falling through to downloaded[0], or to null,
  // is the honest answer — Home already handles null by offering the model list
  // and disabling New chat.
  const activeModel = useMemo(
    () => cloudModel
      || downloaded.find(m => m.id === activeModelId)
      // ⚠️ APPLE ONLY WINS WHEN IT WAS CHOSEN, OR WHEN THERE IS NOTHING ELSE.
      // It must not quietly displace a model the user went and downloaded.
      || (activeModelId === APPLE_ID ? appleModel : null)
      || downloaded[0]
      || appleModel
      || null,
    [cloudModel, activeModelId, downloaded, appleModel]
  )

  // What the switcher offers: everything on the phone, plus the cloud model
  // when one is set, so there is always a way back to on-device.
  const switchable = useMemo(
    () => [cloudModel, ...downloaded, appleModel].filter(Boolean),
    [cloudModel, downloaded, appleModel]
  )

  const [stack, setStack] = useState(() => {
    const base = [{ key: 'root', route: 'home', props: {} }]
    // "Open to" in Settings: Home, or straight back into the last conversation.
    if (loadAppearance().openTo === 'chat' && listChats()[0]) {
      base.push({ key: 'k1', route: 'chat', props: { chatId: listChats()[0].id } })
    }
    return base
  })
  const [popping, setPopping] = useState(null)
  const [sheet, setSheet] = useState(null)
  // One context menu, and the bar button that opens it says which one. `chat`
  // is the ellipsis on Chat; `models` is the gear on the root screen.
  const [menuOpen, setMenuOpen] = useState(null)
  const [chromeMap, setChromeMap] = useState({})

  const stackRef = useRef(stack); stackRef.current = stack
  const keySeq = useRef(2)
  const busy = useRef(false)              // an animation owns the layers right now
  const layerEls = useRef(new Map())      // key -> { el, dim }
  const perKey = useRef(new Map())        // key -> stable callbacks
  const stackWrapRef = useRef(null)

  // Stable per-layer callbacks. If these were rebuilt each render React would
  // detach and reattach every ref on every render, and the detach would clear
  // the element we need for the transform.
  const bindings = (key) => {
    let b = perKey.current.get(key)
    if (!b) {
      b = {
        layerRef: (el) => {
          const rec = layerEls.current.get(key) || {}
          rec.el = el
          layerEls.current.set(key, rec)
        },
        dimRef: (el) => {
          const rec = layerEls.current.get(key) || {}
          rec.dim = el
          layerEls.current.set(key, rec)
        },
        setChrome: (patch) => setChromeMap(m => {
          const cur = m[key] || {}
          let same = true
          for (const k in patch) if (cur[k] !== patch[k]) { same = false; break }
          return same ? m : { ...m, [key]: { ...cur, ...patch } }
        })
      }
      perKey.current.set(key, b)
    }
    return b
  }

  // ── first run ─────────────────────────────────────────────────────────────
  // No model on the phone and no Mac configured. It is a cover, not a screen —
  // there is nothing behind it worth showing.

  const [appearance, setAppearance] = useState(() => {
    const a = loadAppearance()
    applyAppearance(a)
    return a
  })

  const [firstRunDone, setFirstRunDone] = useState(() => {
    try { return localStorage.getItem(FIRSTRUN_KEY) === '1' } catch { return true }
  })
  const hasServer = false
  // wait for the catalog before judging: flashing the cover for one frame on
  // every cold launch would be worse than never showing it
  const catalogKnown = models.length > 0 || local.ready === true || local.loaded === true
  const showFirstRun = !!FirstRun && !firstRunDone && catalogKnown && downloaded.length === 0 && !cloudModel

  const finishFirstRun = useCallback(() => {
    setFirstRunDone(true)
    try { localStorage.setItem(FIRSTRUN_KEY, '1') } catch { /* private mode */ }
  }, [])

  // ── navigation ────────────────────────────────────────────────────────────

  const durNav = reduce ? 200 : 350

  // One writer for every layer transform, so the push animation, the pop
  // animation and the back gesture cannot disagree about where a layer is.
  const setX = useCallback((key, x, { animate = false, dim = null, fade = false } = {}) => {
    const rec = layerEls.current.get(key)
    if (!rec?.el) return
    if (fade) {
      // reduced motion: a 200ms cross-dissolve, no travel
      rec.el.style.transition = animate ? `opacity ${durNav}ms linear` : 'none'
      rec.el.style.transform = 'none'
      rec.el.style.opacity = x === 0 ? '1' : '0'
    } else {
      rec.el.style.transition = animate
        ? `transform ${durNav}ms var(--rx-nav, cubic-bezier(.2,0,0,1))`
        : 'none'
      rec.el.style.transform = `translate3d(${typeof x === 'number' ? `${x}px` : x},0,0)`
      rec.el.style.opacity = '1'
    }
    if (dim != null && rec.dim) {
      rec.dim.style.transition = animate ? `opacity ${durNav}ms var(--rx-nav, linear)` : 'none'
      rec.dim.style.opacity = String(dim)
    }
  }, [durNav])

  const push = useCallback((route, props = {}) => {
    if (busy.current) return
    const key = `k${keySeq.current++}`
    setStack(s => [...s, { key, route, props }])
  }, [])

  const pop = useCallback(() => {
    if (busy.current) return
    const s = stackRef.current
    if (s.length < 2) return
    setPopping(s[s.length - 1])
    setStack(s.slice(0, -1))
  }, [])

  const replace = useCallback((route, props = {}) => {
    const key = `k${keySeq.current++}`
    setStack(s => [...s.slice(0, -1), { key, route, props }])
  }, [])

  // Drive the push/pop animation once React has committed the new layers.
  // useLayoutEffect, not useEffect: the incoming layer has to be parked
  // off-screen before the browser paints, or it flashes at its final position
  // for one frame first.
  const prevRef = useRef({ stack, popping })
  useLayoutEffect(() => {
    const prev = prevRef.current
    prevRef.current = { stack, popping }
    if (prev.stack === stack && prev.popping === popping) return

    const w = stackWrapRef.current?.offsetWidth || window.innerWidth

    if (stack.length > prev.stack.length) {
      const incoming = stack[stack.length - 1].key
      const outgoing = prev.stack[prev.stack.length - 1]?.key
      setX(incoming, w, { fade: reduce })
      if (outgoing) setX(outgoing, 0, { dim: 0 })
      busy.current = true
      requestAnimationFrame(() => requestAnimationFrame(() => {
        setX(incoming, 0, { animate: true, fade: reduce })
        // −30% and a 0.12 wash: the outgoing view is pushed back in space, not
        // merely covered up
        if (outgoing && !reduce) setX(outgoing, -0.3 * w, { animate: true, dim: 0.12 })
        setTimeout(() => { busy.current = false }, durNav)
      }))
      return
    }

    if (popping && !prev.popping) {
      const leaving = popping.key
      const arriving = stack[stack.length - 1]?.key
      busy.current = true
      requestAnimationFrame(() => {
        setX(leaving, w, { animate: true, fade: reduce })
        if (arriving) setX(arriving, 0, { animate: true, dim: 0 })
        setTimeout(() => { busy.current = false; setPopping(null) }, durNav)
      })
    }
  }, [stack, popping, durNav, reduce, setX])

  // forget the bookkeeping for layers that are gone, so a later layer cannot
  // inherit a stale title or a dead element
  useEffect(() => {
    const live = new Set([...stack.map(e => e.key), popping?.key].filter(Boolean))
    for (const k of [...layerEls.current.keys()]) if (!live.has(k)) layerEls.current.delete(k)
    for (const k of [...perKey.current.keys()]) if (!live.has(k)) perKey.current.delete(k)
    setChromeMap(m => {
      const next = {}
      let changed = false
      for (const k in m) { if (live.has(k)) next[k] = m[k]; else changed = true }
      return changed ? next : m
    })
  }, [stack, popping])

  // ── interactive edge-swipe back ───────────────────────────────────────────
  // Both views track the finger 1:1 and the decision comes from projected
  // velocity, not from wherever the finger happened to stop. A back gesture
  // that only animates on release is caught in the first second of real use.

  const gesture = useRef(null)

  const onPointerDown = (e) => {
    if (busy.current || stackRef.current.length < 2 || sheet || menuOpen) return
    if (e.clientX > 20) return
    const s = stackRef.current
    gesture.current = {
      x0: e.clientX, y0: e.clientY,
      w: stackWrapRef.current?.offsetWidth || window.innerWidth,
      top: s[s.length - 1].key,
      under: s[s.length - 2].key,
      last: e.clientX, lastT: performance.now(), v: 0,
      live: false, id: e.pointerId
    }
  }

  const onPointerMove = (e) => {
    const g = gesture.current
    if (!g || e.pointerId !== g.id) return
    const dx = e.clientX - g.x0
    if (!g.live) {
      // a mostly-vertical drag is a scroll, not a back gesture
      if (Math.abs(e.clientY - g.y0) > Math.abs(dx)) { gesture.current = null; return }
      if (dx < 6) return
      g.live = true
      e.currentTarget.setPointerCapture?.(e.pointerId)
    }
    const now = performance.now()
    const dt = Math.max(1, now - g.lastT)
    g.v = ((e.clientX - g.last) / dt) * 1000 // pt/s
    g.last = e.clientX; g.lastT = now
    const t = Math.max(0, Math.min(g.w, dx))
    const p = t / g.w
    setX(g.top, t)
    setX(g.under, -0.3 * g.w * (1 - p), { dim: 0.12 * (1 - p) })
  }

  const endGesture = (e) => {
    const g = gesture.current
    if (!g) return
    gesture.current = null
    if (!g.live) return
    const dx = Math.max(0, Math.min(g.w, e.clientX - g.x0))
    const projected = dx + g.v * 0.15 // where the finger would be in 150ms
    const commit = projected > g.w * 0.5 || g.v > 300
    busy.current = true
    if (commit) {
      haptic('impact', 'LIGHT')
      setX(g.top, g.w, { animate: true })
      setX(g.under, 0, { animate: true, dim: 0 })
      setTimeout(() => {
        busy.current = false
        // the layer is already off-screen; drop it without a second animation
        const next = stackRef.current.slice(0, -1)
        prevRef.current = { stack: next, popping: null }
        setStack(next)
      }, durNav)
    } else {
      // rubber-band home
      setX(g.top, 0, { animate: true })
      setX(g.under, -0.3 * g.w, { animate: true, dim: 0.12 })
      setTimeout(() => { busy.current = false }, durNav)
    }
  }

  // ── actions handed to the screens ─────────────────────────────────────────

  const openChat = useCallback((modelId, opts = {}) => {
    if (modelId) {
      setActiveModelId(modelId)
      try { localStorage.setItem(ACTIVE_MODEL_KEY, modelId) } catch { /* private mode */ }
    }
    if (stackRef.current[stackRef.current.length - 1]?.route === 'chat') return
    // "New chat" means a NEW conversation, not the last one reopened — the
    // whole point of keeping history is that starting again does not overwrite.
    push('chat', opts.fresh ? { chatId: newChatId() } : {})
  }, [push])

  const presentSheet = useCallback((modelId) => {
    haptic('impact', 'MEDIUM')
    setSheet({ modelId: typeof modelId === 'string' ? modelId : null })
  }, [])

  const dismissSheet = useCallback(() => setSheet(null), [])

  // The Mac path is real and one tap away, and its demotion — one plain row two
  // sections down on Models, plus the gear — IS the argument that on-device is
  // the product. It never gets a card, an icon treatment or equal billing.

  const nav = useMemo(() => ({
    push, pop, replace, presentSheet, dismissSheet, openChat, depth: stack.length
  }), [push, pop, replace, presentSheet, dismissSheet, openChat, stack.length])

  const menuPress = usePress(() => setMenuOpen('chat'))
  // The gear used to open a three-item menu, which is why Tony reported the
  // app had no settings at all. It pushes a real screen now.
  const gearPress = usePress(() => push('settings', {}), { label: 'Settings' })

  // ── render ────────────────────────────────────────────────────────────────

  const layers = popping ? [...stack, popping] : stack
  const topKey = stack[stack.length - 1]?.key

  // Chat's bar carries WHERE THE ANSWER COMES FROM, in the quietest place in
  // the app: a two-line title, model name over its origin. ChatScreen replaces
  // the subtitle with a tok/s readout while it is generating.
  //
  // ⚠️ IT USED TO SAY "On device" WHATEVER WAS ANSWERING — including a cloud
  // model reached over the network with the user's own key. A privacy claim
  // that is hard-coded is a privacy claim that will eventually be false.
  const titleFor = (entry) => {
    const chrome = chromeMap[entry.key] || {}
    if (chrome.title != null) return chrome.title
    if (entry.route === 'chat') return activeModel?.name || 'Chat'
    return (SCREENS[entry.route] || SCREENS.models).title
  }
  const subtitleFor = (entry) => {
    const chrome = chromeMap[entry.key] || {}
    if (chrome.subtitle != null) return chrome.subtitle
    if (entry.route !== 'chat') return null
    return activeModel?.cloud ? (activeModel.maker || 'Cloud') : 'On device'
  }

  const renderScreen = (entry) => {
    const { setChrome } = bindings(entry.key)
    // `isTop` is how a screen knows it has been RETURNED to. A pushed layer
    // does not unmount the one beneath it, so a screen that loads a list on
    // mount will still be showing that list minutes later — which is why a chat
    // started and left did not appear on Home. Anything that reads storage
    // needs to re-read when this flips back to true.
    const common = {
      nav, local, models, setChrome,
      isTop: entry.key === topKey && !popping,
      ...entry.props
    }
    switch (entry.route) {
      case 'chat':
        return (
          <ChatScreen
            {...common}
            // ⚠️ NO `|| activeModelId` FALLBACK. That is the same bug one layer
            // down: with nothing downloaded, activeModel is null and this
            // handed Chat the id of a model that had been removed.
            modelId={activeModel?.id || null}
            model={activeModel}
            downloadedModels={switchable}
            onModelInfo={() => presentSheet(activeModel?.id)}
            onSwitchModel={(id) => {
              // Switching mid-conversation KEEPS the conversation: the messages
              // belong to the chat, not to the model that answered them.
              // ⚠️ CHOOSING A LOCAL MODEL MUST CLEAR THE CLOUD ONE. The chat
              // checks the cloud choice FIRST, so leaving it set would send to
              // the cloud while the title named a local model — the exact lie
              // this change exists to end.
              if (String(id).startsWith('cloud:')) return
              saveChosen(null)
              setActiveModelId(id)
              try { localStorage.setItem(ACTIVE_MODEL_KEY, id) } catch { /* private mode */ }
            }}
          />
        )
      case 'home':
        return (
          <HomeScreen
            {...common}
            activeModel={activeModel}
            onStartChat={() => openChat(activeModel?.id, { fresh: true })}
            onOpenChat={(chatId) => push('chat', { chatId })}
            onChooseModel={() => push('models', {})}
          />
        )
      case 'readme':
        return <ReadMeScreen {...common} />
      case 'skills':
        return <SkillsScreen {...common} />
      case 'providers':
        return <ProvidersScreen {...common} onStartChat={() => openChat(null, { fresh: true })} />
      case 'settings':
        return (
          <SettingsScreen
            {...common}
            appearance={appearance}
            onAppearance={setAppearance}
            onReadMe={() => push('readme', {})}
            onProviders={() => push('providers', {})}
            onSkills={() => push('skills', {})}
            onGetModels={() => push('models', {})}
            version={typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null}
          />
        )
      case 'models':
      default:
        return (
          <ModelsScreen
            {...common}
            activeModelId={activeModel?.id || null}
            activeModel={activeModel}
            onOpenChat={openChat}
            onGetModel={presentSheet}
          />
        )
    }
  }

  const trailingFor = (entry) => {
    if (entry.key !== topKey) return null
    if (entry.route === 'chat') {
      return (
        <button type="button" className="rx-shell-barbtn" {...menuPress}
          aria-label="More" style={barButtonStyle}><EllipsisCircle /></button>
      )
    }
    if (entry.route === 'home') {
      return (
        <button type="button" className="rx-shell-barbtn" {...gearPress}
          aria-label="Settings" style={barButtonStyle}><Gearshape /></button>
      )
    }
    return null
  }

  // A screen can replace the menu wholesale with setChrome({ menu: [...] }).
  // Until it does, the shell's items fire a window event, so ChatScreen owns
  // the behavior without having to own the bar.
  const chatMenu = chromeMap[topKey]?.menu || [
    { key: 'new', label: 'New conversation', run: () => emitChatAction('new') },
    { key: 'info', label: 'Model info', run: () => presentSheet(activeModel?.id) },
    { key: 'delete', label: 'Delete conversation', destructive: true, run: () => emitChatAction('delete') }
  ]

  // The gear's menu. Both items are real work the root screen cannot do inline:
  // the Mac path (which also has its own row, because that row IS the argument
  // that on-device is the product) and reclaiming the disk in one move.
  const modelsMenu = [
    ...(local.downloaded?.length
      ? [{
          key: 'purge',
          label: `Remove all models · ${(local.usedBytes / 1e9).toFixed(1)} GB`,
          destructive: true,
          run: () => { local.downloaded.forEach(m => local.remove?.(m.id)) }
        }]
      : [])
  ]

  const sheetOpen = !!sheet && !!GetModelSheet

  return (
    <div
      ref={rootRef}
      className="rx-shell-root"
      style={{
        position: 'fixed', inset: 0, height: '100dvh',
        // The shell itself must not rubber-band: dragging the whole app reveals
        // the web view underneath and the illusion is over. The bounce lives
        // inside the scrollers, where iOS puts it.
        overscrollBehavior: 'none',
        background: 'var(--rx-bg, #FFFFFF)',
        color: 'var(--rx-label, #000)',
        // literal, never behind a custom property: `-apple-system` is a
        // system-font KEYWORD and a var() round trip is one engine change away
        // from turning the whole app into Helvetica. See mobile.css.
        fontFamily: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
        // the shared body sets −0.01em, which over-tightens SF at 17pt; SF's
        // own optical tracking is already correct
        letterSpacing: 'normal',
        WebkitUserSelect: 'none', userSelect: 'none',
        WebkitTouchCallout: 'none',
        touchAction: 'manipulation',
        overflow: 'hidden'
      }}
    >
      <style>{SHELL_CSS}</style>

      <div
        ref={stackWrapRef}
        className="rx-shell-stack"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={() => { gesture.current = null }}
        style={{
          position: 'absolute', inset: 0,
          // pan-y so the edge gesture never fights a list's vertical scroll
          touchAction: 'pan-y',
          // The sheet's card-stack effect: the presenting view shrinks, rounds
          // and dims. Its absence is the giveaway that a modal is just a div.
          transform: sheetOpen && !reduce ? 'scale(0.92)' : 'none',
          transformOrigin: '50% 0%',
          borderRadius: sheetOpen ? 10 : 0,
          overflow: 'hidden',
          transition: 'transform var(--rx-dur-sheet, 414ms) var(--rx-sheet, ease-out),' +
            ' border-radius var(--rx-dur-sheet, 414ms) var(--rx-sheet, ease-out)'
        }}
      >
        {layers.map((entry, i) => {
          const under = layers[i - 1]
          const b = bindings(entry.key)
          return (
            <Layer
              key={entry.key}
              route={entry.route}
              chrome={chromeMap[entry.key] || {}}
              title={titleFor(entry)}
              subtitle={subtitleFor(entry)}
              backTitle={under ? titleFor(under) : null}
              onBack={i > 0 ? pop : null}
              trailing={trailingFor(entry)}
              layerRef={b.layerRef}
              dimRef={b.dimRef}
              // A presented sheet makes EVERY layer inert, not just the ones
              // buried under another layer. The sheet is an overlay sibling
              // rather than a pushed layer, so without this the whole Models
              // screen stays keyboard-reachable behind it — thirteen controls,
              // including the ones that start a multi-gigabyte download.
              inert={sheetOpen || (entry.key !== topKey && !popping)}
            >
              {renderScreen(entry)}
            </Layer>
          )
        })}

        {/* the presenting view's dim, the other half of the card-stack effect */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute', inset: 0, background: '#000',
            opacity: sheetOpen ? 0.35 : 0, pointerEvents: 'none',
            transition: 'opacity var(--rx-dur-sheet, 414ms) var(--rx-sheet, ease-out)'
          }}
        />
      </div>

      {menuOpen && (
        <ContextMenu
          items={menuOpen === 'models' ? modelsMenu : chatMenu}
          reduce={reduce}
          onClose={() => setMenuOpen(null)}
        />
      )}

      {sheetOpen && (
        <GetModelSheet
          nav={nav}
          local={local}
          models={models}
          modelId={sheet.modelId}
          onDismiss={dismissSheet}
          onStartChat={(id) => { dismissSheet(); openChat(id) }}
        />
      )}

      {showFirstRun && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'var(--rx-bg-grouped, #F2F2F7)' }}>
          <FirstRun
            nav={nav}
            local={local}
            models={models}
            onChooseModel={() => { finishFirstRun(); presentSheet(null) }}
            onStartChat={() => { finishFirstRun(); openChat(activeModel?.id || downloaded[0]?.id || appleModel?.id) }}
            hasModel={downloaded.length > 0}
            appleReady={Boolean(appleModel)}
          />
        </div>
      )}
    </div>
  )
}

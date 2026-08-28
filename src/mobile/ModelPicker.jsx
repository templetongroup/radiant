import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { deviceWord } from './device.js'
import * as GaugeModule from './Gauge.jsx'
import BrandSpinner, { BrandMark } from './BrandSpinner.jsx'
import { fitOf, FIT_LABEL, FITS_NO, ramNeededGB } from './fit.js'
import MakerSection from './MakerSection.jsx'
import DeviceSpecs from './DeviceSpecs.jsx'
import { byMaker } from './makers.js'

// Picking a model is the first thing a new user does, so this screen has one
// job: make the obvious choice obvious. A recommended model gets the hero —
// the gauge at 96pt and a single filled capsule — and the other four sit under
// it as an ordinary inset grouped list. Five plain-English rows is not the wall
// of quantisation suffixes the Swift catalog comment warns about, and hiding
// four of them behind a second tap would be dishonest, so they stay visible and
// simply weigh less.
//
// Everything here is state the phone can actually report. The plugin emits
// downloadStarted / downloadDone / downloadFailed and nothing in between
// (TG-221), so there is no percentage and no byte counter anywhere on this
// screen. An indeterminate gauge that is telling the truth beats a bar creeping
// to 90% and hanging.

// The gauge is the app's only loading indicator and it is drawn once, in
// Gauge.jsx. Read through a namespace import so a default or a named export
// both work; if the module ever resolves to neither we render a hole rather
// than take the whole first-run screen down with a null-component crash.
// (spread first so the bundler does not statically warn about whichever of the
// two export names Gauge.jsx turns out not to use)
const GaugeExports = { ...GaugeModule }
const SharedGauge = GaugeExports.default || GaugeExports.Gauge || (() => null)

const LM = () => (typeof window !== 'undefined' ? window.Capacitor?.Plugins?.LocalModels : null)
const PLUGIN = name => (typeof window !== 'undefined' ? window.Capacitor?.Plugins?.[name] : null)

// Haptics are reached off the bridge rather than imported, so the JS wrapper
// never enters the root package.json and the Mac bundle stays untouched.
// NOTE FOR INTEGRATION: the spec puts these in src/mobile/haptics.js. That file
// belongs to another agent and its export shape is not settled yet, so these
// three guarded calls live here for now; swapping them for the shared module is
// a one-line change per call site.
const hapt = {
  light: () => PLUGIN('Haptics')?.impact?.({ style: 'LIGHT' }),
  medium: () => PLUGIN('Haptics')?.impact?.({ style: 'MEDIUM' }),
  ok: () => PLUGIN('Haptics')?.notification?.({ type: 'SUCCESS' }),
  err: () => PLUGIN('Haptics')?.notification?.({ type: 'ERROR' })
}

// Qwen 3 1.7B is the recommendation because its blurb is the only one that
// promises a good result without qualification ("a good all-rounder on any
// recent iPhone"). If the native catalog ever drops it we fall through to the
// first entry rather than rendering a picker with no hero.
const RECOMMENDED_ID = 'qwen3-1.7b'

// Decimal GB, matching how Apple reports storage in Settings. Using 2^30 here
// would make every size on screen disagree with the number the user can check.
const GB = 1e9
const fmtGB = bytes => `${(bytes / GB).toFixed(1)} GB`

/* ------------------------------------------------------------------ styles */

// One injected stylesheet instead of rules in mobile.css, because mobile.css is
// written by another agent who cannot know these class names. Every value
// resolves from the shared --rx-* tokens when they exist and falls back to the
// literal from the spec when they do not, so this screen is correct on its own
// and can never drift from the shared palette once the tokens land.
const CSS = `
.rx-mp{
  --mp-bg:var(--rx-bg-grouped,#F2F2F7);
  --mp-cell:var(--rx-cell,#FFFFFF);
  --mp-sep:var(--rx-separator,rgba(60,60,67,0.29));
  --mp-label:var(--rx-label,#000000);
  --mp-label-2:var(--rx-label-2,rgba(60,60,67,0.60));
  --mp-label-3:var(--rx-label-3,rgba(60,60,67,0.30));
  --mp-fill-1:var(--rx-fill-1,rgba(120,120,128,0.20));
  --mp-fill-3:var(--rx-fill-3,rgba(120,120,128,0.12));
  --mp-tint:var(--rx-tint,#3F69A7);
  --mp-tint-pressed:var(--rx-tint-pressed,#35588C);
  --mp-on-tint:var(--rx-on-tint,#FFFFFF);
  --mp-amber:var(--rx-amber,#B25E00);
  --mp-red:var(--rx-red-text,#D70015);
  --mp-green:var(--rx-green,#248A3D);

  /* no --mp-font: the family is inherited from .is-native body, which
     declares the system keyword literally. See mobile.css. */
  --mp-mono:ui-monospace,'SF Mono',Menlo,monospace;
  --mp-r-cell:var(--rx-r-cell,10px);
  --mp-r-button:var(--rx-r-button,14px);

  /* pre-solved springs; never an ease */
  --mp-press:var(--rx-press,linear(0,.096,.311,.548,.763,.924,1.025,1.078,1.094,1.086,1.066,1.044,1.024,1.008,.998,.993,.991,.992,.994,.996,.998,.999,1));
  --mp-dur-press:var(--rx-dur-press,322ms);
  --mp-down:var(--rx-down,cubic-bezier(.2,0,0,1));
  --mp-dur-down:var(--rx-dur-down,110ms);
  --mp-pop:var(--rx-pop,linear(0,.06,.198,.361,.525,.668,.786,.874,.939,.982,1.008,1.022,1.027,1.027,1.024,1.02,1.015,1.011,1.007,1.005,1.002,1.001,1));
  --mp-dur-pop:var(--rx-dur-pop,316ms);

  --mp-dt:1;

  display:flex; flex-direction:column; min-height:100%;
  background:var(--mp-bg); color:var(--mp-label);
  letter-spacing:normal;
  -webkit-tap-highlight-color:transparent; touch-action:manipulation;
  -webkit-user-select:none; user-select:none; -webkit-touch-callout:none;
}
/* keyed off the app's mode, NOT the phone's — see data-rx-dark in theme.js */
.is-native[data-rx-dark='true'] .rx-mp{
    --mp-bg:var(--rx-bg-grouped,#000000);
    --mp-cell:var(--rx-cell,#1C1C1E);
    --mp-sep:var(--rx-separator,rgba(84,84,88,0.65));
    --mp-label:var(--rx-label,#FFFFFF);
    --mp-label-2:var(--rx-label-2,rgba(235,235,245,0.60));
    --mp-label-3:var(--rx-label-3,rgba(235,235,245,0.30));
    --mp-fill-1:var(--rx-fill-1,rgba(120,120,128,0.36));
    --mp-fill-3:var(--rx-fill-3,rgba(120,120,128,0.24));
    --mp-tint:var(--rx-tint,#79A6E9);
    --mp-tint-pressed:var(--rx-tint-pressed,#6791CE);
    /* the flip: near-black labels on a light tint fill. White here measures
       ~2.4:1 and is the fastest way to make an iOS button look amateur. */
    --mp-on-tint:var(--rx-on-tint,#050911);
    --mp-amber:var(--rx-amber,#FF9F0A);
    --mp-red:var(--rx-red-text,#FF453A);
    --mp-green:var(--rx-green,#30D158);
  }


/* the scroller bounces (a list that cannot rubber-band feels dead) but never
   shows a bar — a visible scrollbar is a webview tell */
.rx-mp-scroll{flex:1 1 auto; overflow-y:auto; -webkit-overflow-scrolling:touch; scrollbar-width:none}
.rx-mp-scroll::-webkit-scrollbar{display:none}
.rx-mp-inner{padding:0 16px max(20px,env(safe-area-inset-bottom)); margin:0 auto; width:100%; max-width:34em; box-sizing:border-box}

.rx-mp-title{
  font-size:calc(34px*var(--mp-dt)); line-height:1.21;
  font-weight:700; letter-spacing:-0.4px; margin:8px 0 0; color:var(--mp-label);
}
.rx-mp-lede{font-size:calc(15px*var(--mp-dt)); font-weight:400; color:var(--mp-label-2); margin:6px 0 0; line-height:1.33}

/* ---- hero: the recommended model, no card and no plate. The gauge on the
   grouped background IS the hero; a bordered box would make it a settings
   row with ambitions. ---- */
.rx-mp-hero{display:flex; flex-direction:column; align-items:center; text-align:center; padding:6px 0 4px}
/* height:auto — the gauge is 120pt when it is reporting a download and absent
   the rest of the time, so this box must not pin itself to the old 96 */
.rx-mp-hero-gauge{display:block; line-height:0; height:auto; margin-bottom:12px; color:var(--mp-tint)}
.rx-mp-hero-name{font-size:calc(22px*var(--mp-dt)); line-height:1.27; font-weight:600; margin:0}
.rx-mp-hero-blurb{font-size:calc(15px*var(--mp-dt)); font-weight:400; color:var(--mp-label-2); margin:4px 0 0; line-height:1.33; max-width:26em}
.rx-mp-hero-note{font-size:calc(13px*var(--mp-dt)); font-weight:400; margin:10px 0 0; line-height:1.38}
.rx-mp-hero-note.is-amber{color:var(--mp-amber)}
.rx-mp-hero-note.is-red{color:var(--mp-red)}

/* The label is centred in the BUTTON, not in the button minus the spinner.
   Laying the pair out as a centred flex group pushes the word right by half the
   spinner plus the gap — which reads as a typo in the layout, and did. The
   spinner is taken out of flow and pinned to the leading inset instead, so
   "Stop" and "Stop · 47%" both sit on the button's true centre. */
.rx-mp-cta{
  -webkit-appearance:none; appearance:none; border:0; position:relative;
  display:flex; align-items:center;
  justify-content:center; width:100%; min-height:50px; margin:20px 0 0;
  border-radius:var(--mp-r-button); background:var(--mp-tint); color:var(--mp-on-tint);
  font-size:calc(17px*var(--mp-dt)); font-weight:600;
  transition:transform var(--mp-dur-press) var(--mp-press), background-color 200ms linear;
}
.rx-mp-cta.is-pressed{background:var(--mp-tint-pressed); transform:scale(.96); transition:transform var(--mp-dur-down) var(--mp-down), background-color 0s}
/* a disabled control is never a faded tint — it is a neutral fill with a
   quiet glyph, the way Apple does it */
.rx-mp-cta[disabled]{background:var(--mp-fill-3); color:var(--mp-label-3); transform:none}
.rx-mp-cta-gauge{
  color:var(--mp-on-tint); display:block; height:22px; flex:0 0 auto;
  position:absolute; left:18px; top:50%; transform:translateY(-50%);
}

.rx-mp-secondary{
  -webkit-appearance:none; appearance:none; border:0; background:none; display:block;
  width:100%; min-height:44px; margin:4px 0 0;
  font-size:calc(17px*var(--mp-dt)); font-weight:400;  color:var(--mp-tint); transition:opacity var(--mp-dur-press) var(--mp-press);
}
.rx-mp-secondary.is-pressed{opacity:.4; transition:opacity var(--mp-dur-down) var(--mp-down)}

.rx-mp-sechead{font-size:calc(13px*var(--mp-dt)); font-weight:400; color:var(--mp-label-2); margin:20px 0 6px; padding:0 4px}
/* ---- a maker's shelf: header, and the fit verdict on each row ---------- */
/* The header is a cell in its own right, not a caption: it is tappable, so it
   has to read as a control. Same radius and ground as the rows it opens. */
.rx-mp-makerhead{
  display:flex; align-items:center; gap:10px; width:100%;
  margin:8px 0 0; padding:12px 16px;
  background:var(--mp-cell); border:0; border-radius:var(--mp-r-cell);
  font:inherit; color:var(--mp-label); text-align:left;
  -webkit-tap-highlight-color:transparent; cursor:pointer;
}
.rx-mp-makerhead.is-pressed{background:var(--mp-fill-3)}
/* Square off the bottom when open so the header and its list read as one
   card rather than two stacked ones. */
.rx-mp-makerhead.is-open{border-bottom-left-radius:0; border-bottom-right-radius:0}
.rx-mp-makerhead.is-open + div .rx-mp-group{
  margin-top:0; border-top-left-radius:0; border-top-right-radius:0;
}
.rx-mp-maker-chev{
  display:flex; color:var(--mp-label-3); flex:none;
  transition:transform .18s ease, color .18s ease;
}
.rx-mp-makerhead.is-open .rx-mp-maker-chev{transform:rotate(90deg); color:var(--mp-tint)}
.rx-mp-maker-name{font-size:calc(17px*var(--mp-dt)); font-weight:600; flex:1 1 auto; min-width:0}
.rx-mp-maker-meta{
  font-size:calc(13px*var(--mp-dt)); color:var(--mp-label-2);
  flex:none; font-variant-numeric:tabular-nums;
}
.rx-mp-maker-none{color:var(--mp-label-3)}

/* The verdict. Traffic lights, at Tony's call: green runs, amber is tight, red
   will not. A weighted word rather than a filled pill — forty-nine filled pills
   down a scroll is a color chart, and the ones that matter stop standing out.

   ⚠️ THE SHARED TOKENS, NOT LITERALS. Each was chosen for measured contrast in
   both themes; see mobile.css. These fall back to the same literals the rest of
   this stylesheet does, so the screen is still correct if it renders alone.

   Color is never the only signal: a row that cannot run is also dimmed, says
   how much memory it needs, and is not tappable. */
.rx-mp-fit{
  margin-left:8px; font-size:calc(12px*var(--mp-dt)); font-weight:600;
  letter-spacing:0.01em; white-space:nowrap;
}
.rx-mp-fit.is-well{color:var(--mp-green)}
.rx-mp-fit.is-tight{color:var(--mp-amber)}
.rx-mp-fit.is-no{color:var(--mp-red)}
/* A row that cannot run is dimmed as a whole, so the eye skips it on the way
   down rather than reading the name and then discovering the verdict. */
.rx-mp-row.is-toobig .rx-mp-row-name{color:var(--mp-label-2)}
.rx-mp-row.is-toobig .rx-mp-row-acc{opacity:0.35}
@media (prefers-reduced-motion:reduce){
  .rx-mp-maker-chev{transition:none}
}

.rx-mp-secfoot{font-size:calc(12px*var(--mp-dt)); line-height:1.33; color:var(--mp-label-2); margin:6px 0 0; padding:0 4px}

.rx-mp-group{list-style:none; margin:0; padding:0; background:var(--mp-cell); border-radius:var(--mp-r-cell); overflow:hidden}

.rx-mp-row{
  position:relative; display:flex; align-items:center; gap:12px;
  min-height:60px; padding:12px 16px; box-sizing:border-box;
  background:transparent; transition:background-color 250ms linear;
}
/* rows never scale, and the fill lands with no fade-in — any ease on touchdown
   reads as lag */
.rx-mp-row.is-pressed{background:var(--mp-fill-1); transition:none}
.rx-mp-row.is-blocked{opacity:1}
.rx-mp-row.is-blocked .rx-mp-row-name{color:var(--mp-label-3)}
/* Separators are inset to THIS row's text column — 16 margin, plus the 29pt
   glyph and its 12pt gutter only when the row actually has one — and they stop
   16pt short of the trailing edge, as Apple's do. Full-bleed rules between
   grouped cells read as not-Apple instantly. */
.rx-mp-row + .rx-mp-row::before{
  content:''; position:absolute; top:0; left:var(--mp-sep-inset,16px); right:16px;
  height:0.5px; background:var(--mp-sep);
}
.rx-mp-row-lead{flex:0 0 29px; height:29px; display:block}
.rx-mp-row-lead > *{display:block; height:29px; color:inherit}
.rx-mp-row-text{flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:1px}
.rx-mp-row-name{font-size:calc(17px*var(--mp-dt)); font-weight:600; color:var(--mp-label)}
/* ⚠️ WRAPS to two lines. It used to be white-space:nowrap, which clipped
   every blurb mid-word and left a column of identical ellipses. Nothing in an
   Apple stock app truncates 100% of its secondary text. */
.rx-mp-row-sub{
  font-size:calc(15px*var(--mp-dt)); font-weight:400;  color:var(--mp-label-2); line-height:1.33;
  overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
}
.rx-mp-row-sub .rx-mp-size{color:var(--mp-label-2); font-variant-numeric:tabular-nums; font-feature-settings:'tnum'}
.rx-mp-row-sub.is-amber{color:var(--mp-amber)}
.rx-mp-row-sub.is-red{color:var(--mp-red)}
/* at accessibility sizes the row grows a third line rather than clamping harder */
.rx-mp.is-ax .rx-mp-row-sub{-webkit-line-clamp:3}
.rx-mp.is-ax .rx-mp-row{align-items:flex-start}
.rx-mp.is-ax .rx-mp-row-lead{margin-top:2px}
.rx-mp-row-acc{flex:0 0 auto; display:flex; align-items:center; justify-content:center; min-width:44px}
/* 44pt of hit area from padding around a 28pt glyph. Getting it from
   width:44px instead swells the glyph and unbalances the row. */
.rx-mp-row-glyph{display:flex; align-items:center; justify-content:center; width:28px; height:28px; padding:8px; box-sizing:content-box; color:var(--mp-tint)}
.rx-mp-row-glyph.is-quiet{color:var(--mp-label-3)}
.rx-mp-row-glyph.is-green{color:var(--mp-green)}
.rx-mp-row-glyph.is-amber{color:var(--mp-amber)}
.rx-mp-row-glyph > *{display:block; height:28px}
.rx-mp-row-retry{font-size:calc(13px*var(--mp-dt)); font-weight:400; color:var(--mp-tint); padding:4px 0}

.rx-mp-note{font-size:calc(13px*var(--mp-dt)); font-weight:400; color:var(--mp-label-2); text-align:center; padding:32px 8px; line-height:1.38}

/* the completion beat: one 500ms pop, then the row settles back to tint.
   Green is a confirmation here, never a state. */
.rx-mp-pop{animation:rx-mp-pop var(--rx-dur-complete,444ms) var(--rx-complete,linear(0,.149,.471,.803,1.049,1.177,1.203,1.162,1.094,1.029,.983,.961,.959,.969,.984,.996,1.005,1.008,1.008,1.006,1.003,1,1)) both}
@keyframes rx-mp-pop{from{transform:scale(.6)}to{transform:scale(1)}}
.rx-mp-fade-in{animation:rx-mp-fade var(--mp-dur-pop) var(--mp-pop) both}
@keyframes rx-mp-fade{from{opacity:0; transform:translateY(4px)}to{opacity:1; transform:none}}

@media (prefers-reduced-motion:reduce){
  .rx-mp-pop,.rx-mp-fade-in{animation:none}
  /* press states are feedback, not decoration — they stay */
}
`

if (typeof document !== 'undefined' && !document.querySelector('style[data-rx="model-picker"]')) {
  const tag = document.createElement('style')
  tag.setAttribute('data-rx', 'model-picker')
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/* ------------------------------------------------------------------- glyphs */

// SF Symbols geometry, drawn rather than imported: Icons.jsx is styled by
// styles.css, which this build never loads.
const ArrowDownCircle = () => (
  <svg viewBox="0 0 28 28" width="28" height="28" fill="none" aria-hidden="true">
    <circle cx="14" cy="14" r="12.1" stroke="currentColor" strokeWidth="1.7" />
    <path d="M14 8.2v11.6M9.4 15.3 14 19.9l4.6-4.6" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const Checkmark = () => (
  <svg viewBox="0 0 28 28" width="28" height="28" fill="none" aria-hidden="true">
    <path d="M5.8 14.6 11.2 20 22.2 8.4" stroke="currentColor" strokeWidth="2.4"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/* -------------------------------------------------------------- dynamic type */

// Two mechanisms, per the type spec: WebKit's system text styles carry the
// user's Text Size for free, and everything hand-sized is multiplied by this.
// Read --rx-dt first so that if Phone.jsx already measured it we agree with it
// exactly rather than probing a second, slightly different number.
function measureDynamicType () {
  if (typeof document === 'undefined') return 1
  const shared = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rx-dt'))
  if (Number.isFinite(shared) && shared > 0) return shared
  const p = document.createElement('span')
  p.style.font = '-apple-system-body'
  p.style.position = 'fixed'
  p.style.visibility = 'hidden'
  p.style.pointerEvents = 'none'
  p.textContent = 'M'
  document.body.appendChild(p)
  // 17 — measured inside the app, not in Safari. See MobileShell.useDynamicType.
  const raw = parseFloat(getComputedStyle(p).fontSize) / 17
  p.remove()
  return Math.min(Math.max(Number.isFinite(raw) ? raw : 1, 0.82), 1.6)
}

/* --------------------------------------------------------------- press state */

// Press is JS-driven, never `:active` and never `:hover`. On iOS a :hover rule
// sticks after a tap and the row stays lit, which is disqualifying on its own.
// The commit fires on pointerup inside the bounds, so a finger that slides off
// cancels the way it does in every Apple list.
//
// This is a private copy of ../usePress.js, kept so this file stays standalone.
// It must carry the same semantics: the rows it drives are <li> and <div>, so
// without a role, a tab stop and a key handler the sheet is a wall of text to
// VoiceOver and unreachable to Switch Control — and this sheet is the only way
// a new user gets their first model. Pass `label` for a control whose meaning
// is not in its own text.
function usePress (onCommit, disabled, label) {
  const [pressed, setPressed] = useState(false)
  const origin = useRef(null)

  const end = useCallback(commit => {
    const started = origin.current
    origin.current = null
    setPressed(false)
    if (commit && started && !disabled) onCommit?.()
  }, [onCommit, disabled])

  const handlers = useMemo(() => ({
    onPointerDown: e => {
      if (disabled || e.button > 0) return
      origin.current = { x: e.clientX, y: e.clientY }
      setPressed(true)
    },
    onPointerMove: e => {
      if (!origin.current) return
      // 10pt of slop, then the press is a scroll and the highlight must go
      if (Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y) > 10) end(false)
    },
    onPointerUp: () => end(true),
    onPointerCancel: () => end(false),
    onLostPointerCapture: () => end(false),
    onKeyDown: e => {
      if (disabled) return
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return
      e.preventDefault()
      origin.current = { x: 0, y: 0 }
      setPressed(true)
    },
    onKeyUp: e => {
      if (disabled) return
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return
      e.preventDefault()
      end(true)
    },
    role: 'button',
    tabIndex: disabled ? -1 : 0,
    'aria-label': label,
    'aria-disabled': disabled || undefined
  }), [disabled, end, label])

  return [pressed, handlers]
}

/* ---------------------------------------------------------------- the screen */

/**
 * The model picker.
 *
 * @param {(model) => void}  onChoose      a model is on the device and the user wants to use it
 * @param {string}          [heading]      "Choose a model" reads right in the first-run cover and in the sheet
 * @param {React.Component} [Gauge]        override for the shared iris, for tests
 */
export default function ModelPicker ({
  onChoose, heading = 'Choose a model', featureId, Gauge = SharedGauge
}) {
  const [models, setModels] = useState(null)   // null = still asking the plugin
  const [error, setError] = useState(null)     // list() blew up
  const [jobs, setJobs] = useState({})         // id -> { state:'downloading'|'failed', message }
  const [justDone, setJustDone] = useState(null)
  const [freeBytes, setFreeBytes] = useState(null) // null = Device unavailable, so no shortfall claims
  // Bytes this app may still allocate. null until the phone answers — a fit
  // badge drawn before then would be a guess wearing a measurement's clothes.
  const [memBytes, setMemBytes] = useState(null)
  // Which maker sections are open. Closed is the default; see byMaker.
  const [openMakers, setOpenMakers] = useState(() => new Set())

  const rootRef = useRef(null)
  const scrollRef = useRef(null)
  const [dt, setDt] = useState(1)

  // Auto-advance bookkeeping. If the user scrolled or backgrounded the app
  // while a download ran we do not yank them into the chat when it lands.
  const pendingRef = useRef(null)
  const interruptedRef = useRef(false)

  const plugin = LM()
  const downloadingId = useMemo(
    () => Object.keys(jobs).find(id => jobs[id]?.state === 'downloading') || null,
    [jobs]
  )

  /* -- dynamic type ------------------------------------------------------- */
  useEffect(() => {
    const apply = () => {
      const v = measureDynamicType()
      setDt(v)
      rootRef.current?.style.setProperty('--mp-dt', String(v))
    }
    apply()
    // the Text Size setting can change while the app is in the background
    window.addEventListener('resize', apply)
    document.addEventListener('visibilitychange', apply)
    return () => {
      window.removeEventListener('resize', apply)
      document.removeEventListener('visibilitychange', apply)
    }
  }, [])

  /* -- catalog ------------------------------------------------------------ */
  const refresh = useCallback(async () => {
    const lm = LM()
    if (!lm) return
    try {
      const res = await lm.list()
      setModels(res?.models || [])
      setError(null)
    } catch (e) {
      setError(e?.message || 'Could not read the model list.')
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Free space, so a 2.3 GB pull that cannot possibly fit is refused up front
  // instead of failing at 90%. If Device is not there we make no claim at all.
  const refreshDisk = useCallback(async () => {
    const dev = PLUGIN('Device')
    if (!dev?.getInfo) return
    try {
      const info = await dev.getInfo()
      setFreeBytes(typeof info?.realDiskFree === 'number' ? info.realDiskFree : null)
    } catch { setFreeBytes(null) }
  }, [])

  // Memory is a separate question from disk, and a separate call. Disk decides
  // whether the download can land; memory decides whether the model can then be
  // loaded — a phone can easily have room for a file it cannot run.
  const refreshMemory = useCallback(async () => {
    const lm = LM()
    if (!lm?.diskInfo) return
    try {
      const d = await lm.diskInfo()
      setMemBytes(typeof d?.ramAvailable === 'number' && d.ramAvailable > 0 ? d.ramAvailable : null)
    } catch { setMemBytes(null) }
  }, [])

  useEffect(() => { refreshDisk() }, [refreshDisk])
  useEffect(() => { refreshMemory() }, [refreshMemory])

  /* -- plugin events ------------------------------------------------------ */
  useEffect(() => {
    const lm = LM()
    if (!lm?.addListener) return

    const on = {
      // downloadStarted also arrives for a download we did not initiate (a
      // retry from the sheet, say), so the reducer is idempotent.
      downloadStarted: ({ id }) => setJobs(j => ({ ...j, [id]: { state: 'downloading' } })),
      // This sheet stays open over the download it started, so it — not the
      // list behind it — is where the percentage and the stop control have to
      // live. It carried neither until 2026-08-24.
      downloadProgress: ({ id, progress, completedBytes, totalBytes }) => {
        const pct = typeof progress === 'number' && isFinite(progress) && progress >= 0
          ? Math.min(Math.max(progress, 0), 1)
          : null
        setJobs(j => (j[id]?.state === 'downloading'
          ? { ...j, [id]: { ...j[id], progress: pct, done: Number(completedBytes) || 0, total: Number(totalBytes) || 0 } }
          : j))
      },
      // Stopping is a choice, not a failure: clear it and say nothing.
      downloadCancelled: ({ id }) => {
        setJobs(j => { const n = { ...j }; delete n[id]; return n })
        if (pendingRef.current === id) pendingRef.current = null
        refreshDisk()
      },
      downloadDone: ({ id }) => {
        setJobs(j => { const n = { ...j }; delete n[id]; return n })
        setModels(ms => (ms || []).map(m => (m.id === id ? { ...m, downloaded: true } : m)))
        setJustDone(id)
        hapt.ok()
        refreshDisk()
      },
      downloadFailed: ({ id, message }) => {
        setJobs(j => ({ ...j, [id]: { state: 'failed', message: message || 'The download did not finish.' } }))
        if (pendingRef.current === id) pendingRef.current = null
        hapt.err()
      }
    }

    // addListener resolves to the handle in Capacitor 7; if the component
    // unmounts before it settles, tear the listener down on arrival.
    let dead = false
    const handles = []
    for (const [ev, fn] of Object.entries(on)) {
      Promise.resolve(lm.addListener(ev, fn))
        .then(h => { if (dead) h?.remove?.(); else handles.push(h) })
        .catch(() => {})
    }
    return () => { dead = true; handles.forEach(h => h?.remove?.()) }
  }, [refreshDisk])

  /* -- the completion beat and the auto-advance --------------------------- */
  useEffect(() => {
    if (!justDone) return
    const model = (models || []).find(m => m.id === justDone)
    // 500ms of green, then the tick settles back to tint.
    const settle = setTimeout(() => setJustDone(null), 500)
    // Only advance for the download this session started, and only if the user
    // is still watching. Never yank the UI out from under someone.
    const advance = setTimeout(() => {
      if (pendingRef.current === justDone && !interruptedRef.current && model) {
        pendingRef.current = null
        onChoose?.(model)
      }
    }, 700)
    return () => { clearTimeout(settle); clearTimeout(advance) }
  }, [justDone, models, onChoose])

  useEffect(() => {
    const scroller = scrollRef.current
    const mark = () => { if (pendingRef.current) interruptedRef.current = true }
    const onVis = () => { if (document.hidden) mark() }
    scroller?.addEventListener('scroll', mark, { passive: true })
    document.addEventListener('visibilitychange', onVis)
    return () => {
      scroller?.removeEventListener('scroll', mark)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  /* -- actions ------------------------------------------------------------ */
  const startDownload = useCallback(async model => {
    const lm = LM()
    if (!lm) return
    hapt.medium()
    pendingRef.current = model.id
    interruptedRef.current = false
    setJobs(j => ({ ...j, [model.id]: { state: 'downloading' } }))
    try {
      await lm.download({ id: model.id })
    } catch (e) {
      // The plugin emits downloadFailed before rejecting, so this only has work
      // to do for the rejections that carry no event (an unknown id).
      setJobs(j => (j[model.id]?.state === 'downloading'
        ? { ...j, [model.id]: { state: 'failed', message: e?.message || 'The download did not finish.' } }
        : j))
    }
  }, [])

  const cancelDownload = useCallback(async id => {
    const lm = LM()
    if (!lm?.cancelDownload || !id) return
    hapt.light()
    // Clear optimistically: cancelling a multi-GB pull is the one moment the
    // user is already annoyed, and waiting for the native round trip to redraw
    // reads as the tap not landing. downloadCancelled then confirms it.
    setJobs(j => { const n = { ...j }; delete n[id]; return n })
    if (pendingRef.current === id) pendingRef.current = null
    try { await lm.cancelDownload({ id }) } catch { /* the event still reconciles */ }
  }, [])

  const commit = useCallback(model => {
    hapt.light()
    if (model.downloaded) { onChoose?.(model); return }
    // Tapping the running download stops it. This used to be a disabled button,
    // which is how 2.3 GB became uncancellable from the very screen that
    // started it — the sheet stays open over its own download.
    if (downloadingId === model.id) { cancelDownload(model.id); return }
    // Two multi-GB pulls at once would only make both slower, so a tap on a
    // DIFFERENT model while one runs stays a no-op.
    if (downloadingId) return
    startDownload(model)
  }, [downloadingId, onChoose, startDownload, cancelDownload])

  /* -- derived ------------------------------------------------------------ */
  const list = models || []
  // `featureId` is the model the user actually asked about by tapping its row.
  // Opening on a different one — the house recommendation — silently discards
  // that, and reads as the app arguing with the tap. The recommendation is only
  // the default for someone who has expressed no preference.
  const hero = (featureId && list.find(m => m.id === featureId)) ||
    list.find(m => m.id === RECOMMENDED_ID) || list[0] || null
  const rest = hero ? list.filter(m => m.id !== hero.id) : list

  const fitFor = useCallback(model => fitOf(model.sizeGB, memBytes), [memBytes])

  const toggleMaker = useCallback(name => {
    hapt.light()
    setOpenMakers(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })
  }, [])

  const groups = useMemo(() => byMaker(rest), [rest])

  const shortfallFor = useCallback(model => {
    if (freeBytes == null) return 0
    const need = model.sizeGB * GB
    return need > freeBytes ? need - freeBytes : 0
  }, [freeBytes])

  /* -- render ------------------------------------------------------------- */
  if (!plugin) {
    return (
      <div className="rx-mp" ref={rootRef}>
        <div className="rx-mp-scroll"><div className="rx-mp-inner">
          <h1 className="rx-mp-title">{heading}</h1>
          <p className="rx-mp-note">Downloading a model needs the Radiant app on {deviceWord()}.</p>
        </div></div>
      </div>
    )
  }

  return (
    <div className={`rx-mp${dt > 1.2 ? ' is-ax' : ''}`} ref={rootRef}>
      <div className="rx-mp-scroll" ref={scrollRef}>
        <div className="rx-mp-inner">
          <h1 className="rx-mp-title">{heading}</h1>
          <p className="rx-mp-lede">It runs on this {deviceWord()} — no account, and no network once it&rsquo;s here.</p>

          {error && <p className="rx-mp-note">{error}</p>}

          {/* "Recommended" is a claim, and it is only true when the hero IS the
              recommendation. Once a tapped model leads the sheet, calling it
              recommended tells the user something false about their own tap. */}
          {hero && (
            <h2 className="rx-mp-sechead">
              {hero.id === RECOMMENDED_ID ? 'Recommended' : 'Selected'}
            </h2>
          )}
          {hero && (
            <Hero
              model={hero}
              Gauge={Gauge}
              job={jobs[hero.id]}
              done={justDone === hero.id}
              busyElsewhere={!!downloadingId && downloadingId !== hero.id}
              shortfall={shortfallFor(hero)}
              onCommit={() => commit(hero)}
            />
          )}

          {/* What this phone is, and therefore why the verdicts below read as
              they do. Above the list because it is the frame for everything in
              it, not a detail underneath. */}
          <DeviceSpecs freeBytes={freeBytes} />

          {groups.map(({ maker, models: rows }) => {
            const open = openMakers.has(maker)
            // What the header can promise without being opened: how many of
            // this maker's models this particular iPhone can actually run.
            const runnable = memBytes ? rows.filter(m => fitFor(m) !== FITS_NO).length : null
            return (
              <MakerSection
                key={maker}
                maker={maker}
                count={rows.length}
                runnable={runnable}
                open={open}
                onToggle={() => toggleMaker(maker)}
                prefix="rx-mp"
              >
                {open && (
                  <ul className="rx-mp-group">
                    {rows.map(m => (
                      <Row
                        key={m.id}
                        model={m}
                        Gauge={Gauge}
                        job={jobs[m.id]}
                        done={justDone === m.id}
                        busyElsewhere={!!downloadingId && downloadingId !== m.id}
                        shortfall={shortfallFor(m)}
                        fit={fitFor(m)}
                        onCommit={() => commit(m)}
                      />
                    ))}
                  </ul>
                )}
              </MakerSection>
            )
          })}

          {list.length > 0 && (
            <p className="rx-mp-secfoot">
              A model you download runs on this {deviceWord()}, and nothing you send it
              leaves the device.
              {memBytes
                ? ` Each one is labeled against the memory this ${deviceWord()} can give a single app.`
                : ''}
            </p>
          )}


        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- pieces */

// The gauge never changes hue except tint <-> amber. Absent is a neutral, not a
// faded tint, so an undownloaded model reads as empty rather than as broken.
const gaugeColor = state => (
  state === 'working' ? 'var(--mp-amber)'
    : state === 'resident' || state === 'mark' ? 'var(--mp-tint)'
      : 'var(--mp-label-3)'
)

function Hero ({ model, Gauge, job, done, busyElsewhere, shortfall, onCommit, onCancel }) {
  const downloading = job?.state === 'downloading'
  const failed = job?.state === 'failed'
  const blocked = shortfall > 0 && !model.downloaded && !downloading
  const shown = job?.state === 'downloading'
    ? (typeof job.progress === 'number'
        ? `${Math.round(job.progress * 100)}%`
        : job.done > 0
          ? (job.done >= 1e9 ? `${(job.done / 1e9).toFixed(1)} GB` : `${Math.round(job.done / 1e6)} MB`)
          : null)
    : null
  // Mid-download this button is NOT disabled — it is the way out. Disabling it
  // was how 2.3 GB became uncancellable from the screen that started it.
  const disabled = busyElsewhere || blocked

  const gaugeState = downloading ? 'working'
    : failed ? 'failed'
      : model.downloaded ? 'resident' : 'absent'

  // ⚠️ THE BIG GAUGE APPEARS ONLY WHEN IT HAS WORK TO REPORT.
  // It used to be drawn at 96pt in tint at rest, which made the sheet open on
  // the mark as a brand splash — the one thing the spec bans — while the screen
  // the app actually launches into had no gauge on it at all. The gauge is a
  // status object, not a logo: it is 120pt here while a download is in flight,
  // failing, or has just landed, and nothing at rest. Identity is carried by
  // the root screen's hero and by the 29pt glyph on every row below.
  const showGauge = downloading || failed || done

  let label
  if (downloading) label = shown === null ? 'Stop' : `Stop · ${shown}`
  else if (blocked) label = 'Not enough room'
  else if (model.downloaded) label = 'Start chatting'
  else if (failed) label = 'Try again'
  else label = `Download · ${model.sizeGB.toFixed(1)} GB`

  // Spoken on its own, "Download · 1.1 GB" does not say what is being
  // downloaded — the model's name is a separate element further up the sheet.
  const spoken = downloading
    ? `Downloading ${model.name}`
    : blocked
      ? `${model.name}, not enough room`
      : model.downloaded
        ? `Start chatting with ${model.name}`
        : failed
          ? `Try downloading ${model.name} again`
          : `Download ${model.name}, ${model.sizeGB.toFixed(1)} GB`
  const [pressed, handlers] = usePress(onCommit, disabled, spoken)

  return (
    <div className="rx-mp-hero">
      {/* currentColor is set here as well as inside Gauge, so the mark is right
          whether Gauge paints its own stroke or inherits. Amber only ever means
          the phone is spending something. */}
      {showGauge && (
        <span
          className={`rx-mp-hero-gauge${done ? ' rx-mp-pop' : ''}`}
          style={{ color: gaugeColor(gaugeState) }}
        >
          {downloading
            ? <BrandSpinner size={120} progress={typeof job?.progress === 'number' ? job.progress : null} />
            : <BrandMark size={120} />}
        </span>
      )}
      <div className="rx-mp-hero-name">{model.name}</div>
      <p className="rx-mp-hero-blurb">{model.blurb}</p>

      <button
        type="button"
        className={`rx-mp-cta${pressed ? ' is-pressed' : ''}`}
        disabled={disabled}
        {...handlers}
      >
        {downloading && (
          <span className="rx-mp-cta-gauge"><BrandSpinner size={22} /></span>
        )}
        {label}
      </button>

      {/* Amber means the device itself is spending something. It shows up while
          a download runs and nowhere else on this screen. */}
      {downloading && (
        <p className="rx-mp-hero-note is-amber rx-mp-fade-in">Keep Radiant open while this downloads.</p>
      )}
      {failed && !downloading && (
        <p className="rx-mp-hero-note is-red">{job.message}</p>
      )}
      {blocked && (
        <p className="rx-mp-hero-note is-amber">Needs {fmtGB(shortfall)} more room on this {deviceWord()}.</p>
      )}
    </div>
  )
}

function Row ({ model, Gauge, job, done, busyElsewhere, shortfall, fit, onCommit }) {
  const downloading = job?.state === 'downloading'
  const failed = job?.state === 'failed'
  const blocked = shortfall > 0 && !model.downloaded && !downloading
  // ⚠️ THE VERDICT LABELS, IT DOES NOT FORBID. This used to disable the button,
  // and Tony caught it: "why can i install ministral on Locally but not with
  // Radiant?" Two mistakes in one. Downloading is a DISK operation and has
  // nothing to do with memory; and the verdict behind the block was an estimate,
  // so Radiant was refusing on a guess where every other app lets you install
  // and find out. Disk space still blocks — that one is measured and certain.
  const tooBig = fit === FITS_NO && !model.downloaded
  const disabled = downloading || busyElsewhere || blocked

  const [pressed, handlers] = usePress(
    onCommit, disabled,
    `${model.name}, ${model.sizeGB.toFixed(1)} GB` + (
      model.downloaded ? `, on this ${deviceWord()}`
        : downloading ? ', downloading'
          : failed ? ', that download did not finish'
            : blocked ? ', not enough room'
              : fit ? `, ${FIT_LABEL[fit].toLowerCase()} on this ${deviceWord()}` : ''
    )
  )

  const gaugeState = downloading ? 'working'
    : failed ? 'failed'
      : model.downloaded ? 'resident' : 'absent'

  let sub = model.blurb
  let subClass = ''
  if (failed) { sub = job.message; subClass = ' is-red' }
  else if (downloading) { sub = 'Downloading…'; subClass = ' is-amber' }
  else if (blocked) { sub = `Needs ${fmtGB(shortfall)} more room`; subClass = ' is-amber' }
  else if (tooBig) { sub = `Needs about ${ramNeededGB(model.sizeGB).toFixed(1)} GB of memory` }

  // The iCloud-download idiom needs no label: an arrow in a circle becomes a
  // spinning iris becomes a tick, and everyone already knows that story.
  let accessory
  if (downloading) {
    accessory = <span className="rx-mp-row-glyph"><BrandSpinner size={28} /></span>
  } else if (failed) {
    accessory = <span className="rx-mp-row-retry">Try again</span>
  } else if (model.downloaded) {
    accessory = (
      <span className={`rx-mp-row-glyph${done ? ' is-green rx-mp-pop' : ''}`}><Checkmark /></span>
    )
  } else {
    accessory = <span className={`rx-mp-row-glyph${blocked ? ' is-quiet' : ''}`}><ArrowDownCircle /></span>
  }

  // ⚠️ NO LEADING GAUGE ON A ROW THAT IS MERELY UNDOWNLOADED. At 29pt the
  // iris's three strokes go sub-pixel and collapse into a pale grey blob; five
  // of them down the left edge read as broken image placeholders, and they said
  // nothing, because every row was in the same state. It appears only when it
  // has something to report.
  const lead = model.downloaded || downloading || failed
  const showSize = !failed && !downloading && !blocked && !tooBig

  return (
    <li
      className={`rx-mp-row${pressed ? ' is-pressed' : ''}${blocked ? ' is-blocked' : ''}${tooBig ? ' is-toobig' : ''}`}
      style={{ '--mp-sep-inset': lead ? '57px' : '16px' }}
      {...handlers}
    >
      {lead && (
        <span className="rx-mp-row-lead" style={{ color: gaugeColor(gaugeState) }}>
          <BrandMark size={29} />
        </span>
      )}
      <span className="rx-mp-row-text">
        <span className="rx-mp-row-name">
          {model.name}
          {/* The verdict rides with the NAME, not down in the subtitle, because
              it is the thing that decides whether the row is worth reading at
              all. aria-hidden: the pressable's own label already says it, and
              hearing it twice per row across forty-nine rows is noise. */}
          {fit && !model.downloaded && !downloading && !failed && (
            <span className={`rx-mp-fit is-${fit}`} aria-hidden="true">{FIT_LABEL[fit]}</span>
          )}
        </span>
        <span className={`rx-mp-row-sub${subClass}`}>
          {showSize && <><span className="rx-mp-size">{model.sizeGB.toFixed(1)} GB</span>{' · '}</>}
          {sub}
        </span>
      </span>
      <span className="rx-mp-row-acc">{accessory}</span>
    </li>
  )
}

function SecondaryButton ({ children, onCommit }) {
  const [pressed, handlers] = usePress(onCommit, false)
  return (
    <button type="button" className={`rx-mp-secondary${pressed ? ' is-pressed' : ''}`} {...handlers}>
      {children}
    </button>
  )
}

/**
 * ModelsScreen — the root. The shell owns the scroller, the large title and the
 * nav bar, so this file starts at the hero and ends at the storage line.
 *
 * Information architecture IS the argument here: the gauge owns the top of the
 * screen in every state, the catalog is one ordinary inset grouped list, and
 * On-device is the
 * product; the Mac is one tap away and weighs nothing.
 *
 * ⚠️ FOUR THINGS ON THIS SCREEN HAVE BEEN ROUND-TRIPPED. Read before changing:
 *
 * 1. THE ROW IS NAME OVER BLURB, AND THE SIZE LEADS THE BLURB.
 *    It has moved three times; do not move it a fourth without measuring.
 *    It sat under the download glyph in a trailing column once — where it stole
 *    enough width that three of five blurbs truncated mid-word ("and r…",
 *    "on p…", "with h…") and, being a variable-width string under a
 *    fixed-width glyph, left the row's right margin ragged down the list. That
 *    is gone for good: the trailing column is the arrow.down.circle alone,
 *    which is the iCloud idiom Apple ships with no label.
 *
 *    It was then taken out of the row ENTIRELY, on the grounds that leading the
 *    blurb made every blurb wrap and rows measure 84.9pt. Tony, browsing the
 *    catalog: "models have no sizes. no way to tell whats small." He was right,
 *    and the 84.9pt finding no longer held: measured against all 44 real rows
 *    at 393pt, 33 of 36 catalog blurbs ALREADY wrap to two lines on their own,
 *    the tallest row is 81pt with the size and 81pt without it, and exactly
 *    three rows gain a line. The weight is worth three lines.
 *
 *    ⚠️ IT DOES NOT GO ON THE NAME LINE. That looks like the free space and is
 *    not: the headline is 309pt, and "Nemotron 3 Nano 4B" + "2.2 GB · Runs
 *    well" wraps, with three more names clearing the edge by under 30pt.
 *
 *    ⚠️ MEASURE IN THE HARNESS, NOT THE STUB. The five-model stub carried
 *    SHORTENED blurbs ("Meta's." for Llama 3.2 3B) and made this layout look
 *    fine when the real strings behaved differently. harness/bridge.js now
 *    parses LocalModels.swift, so what renders there is what renders on glass.
 *
 * 2. THERE IS NO LEADING GAUGE ON A CATALOG ROW. Five of them taught the mark
 *    in the first two seconds — in theory. Measured, the three-ring spiral has
 *    no legibility budget under about 26pt: at 29 the radial gap between the A
 *    and B strokes is 1.3pt and the whole thing renders as a smudge. Five
 *    smudges down the left edge is worse than no mark. The gauge appears at
 *    96 in the hero, 26 in a downloading row's accessory (where it is moving,
 *    which is what makes it legible), 120 on the sheet and 128 on first run.
 *
 * 3. THE HERO IS A LEFT-ALIGNED VERTICAL STACK ON THE 20pt LAYOUT MARGIN.
 *    It has been centred (two competing alignment axes against a left-aligned
 *    list) and it has been a horizontal gauge-then-text row, which put the mark
 *    at an optical 28pt and its label at 100pt while the title, the cards and
 *    the footer all sat at 20 — three left edges, and the hero aligned to none
 *    of them. Vertical gives the screen exactly two: 20pt for everything at
 *    screen level, 36pt for text inside a card. The gauge is optically aligned,
 *    not box-aligned: its outermost stroke sits 12.15% of the box in from the
 *    left, so the box carries a negative margin of that fraction.
 *
 * 4. THE STORAGE LINE IS DRAWN EVEN WITH NOTHING DOWNLOADED. It used to hide
 *    until the first model landed, which left the launch screen with a dead
 *    lower third and no statement of the product argument. With no segments it
 *    draws no track — an empty 4pt rail reads as a stuck download — and states
 *    the free space instead.
 */
import React, { useState } from 'react'
import Gauge from './Gauge.jsx'
import BrandSpinner, { BrandMark } from './BrandSpinner.jsx'
import StorageLine from './StorageLine.jsx'
import usePress from './usePress.js'
import { FIT_LABEL, FITS_NO, ramNeededGB } from './fit.js'
import MakerSection from './MakerSection.jsx'
import DeviceSpecs from './DeviceSpecs.jsx'
import { byMaker } from './makers.js'
import { GB } from './useLocalModels.js'

const fmtGB = (gb) => `${Number(gb || 0).toFixed(1)} GB`
// What to print while a download runs. A percent when the total is known; the
// megabytes when it is not — never "0%" for ten minutes, which is what a
// fraction-only relay produced.
export const progressText = (p) => {
  if (!p) return null
  if (typeof p.pct === 'number') return `${Math.round(p.pct * 100)}%`
  if (p.done > 0) return p.done >= 1e9
    ? `${(p.done / 1e9).toFixed(1)} GB`
    : `${Math.round(p.done / 1e6)} MB`
  return null
}

// The one model the sheet also pre-highlights. Falls back to the smallest entry
// so a catalog change can never leave the empty hero with nothing to open.
const RECOMMENDED_ID = 'qwen3-1.7b'
const recommend = (models) =>
  models.find(m => m.id === RECOMMENDED_ID) ||
  [...models].sort((a, b) => (a.sizeGB || 0) - (b.sizeGB || 0))[0] ||
  null

/* ── glyphs: SF Symbols geometry, drawn rather than imported ─────────────── */

// arrow.down.circle at SF Symbol Regular optical weight. The ring used to be a
// hairline with a small arrowhead rattling inside it, which reads as a generic
// web download icon; the stroke is 1.7pt at 22 and the arrow fills the ring.
const ArrowDownCircle = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 22 22" fill="none" aria-hidden="true">
    <circle cx="11" cy="11" r="9.7" stroke="currentColor" strokeWidth="1.7" />
    <path d="M11 5.9v10.2M6.6 11.7 11 16.1l4.4-4.4" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const Checkmark = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 22 22" fill="none" aria-hidden="true">
    <path d="M3.6 11.6 8.4 16.4 18.4 5.6" stroke="currentColor" strokeWidth="2.4"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const Chevron = () => (
  <svg width="8" height="13" viewBox="0 0 8 13" fill="none" aria-hidden="true" className="rx-chevron">
    <path d="M1.4 1.4 6.6 6.5 1.4 11.6" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/* ── the hero: the mark, in whichever state is true, on the layout margin ─── */

function Hero ({ model, onOpen, onChoose, canChoose }) {
  const resident = !!model
  const press = usePress(
    () => (resident ? onOpen?.(model.id) : onChoose?.()),
    {
      label: resident
        // ⚠️ THE LABEL IS A SECOND COPY OF THE SAME SENTENCE. Suppressing the
        // meaningless "0.0 GB" in the visible text and leaving it here would
        // have fixed it for everyone except the people using VoiceOver.
        ? (model.apple
            ? `${model.name}, built into iOS, nothing to download. Opens the conversation.`
            : `${model.name}, ready on this iPhone, ${fmtGB(model.sizeGB)}. Opens the conversation.`)
        : 'No model yet. Choose a model to download.'
    }
  )
  const interactive = resident || canChoose
  const handlers = interactive ? press.handlers : {}

  return (
    <div
      className={'rx-hero' + (interactive ? ' rx-pressable' + press.className : '')}
      data-absent={resident ? undefined : 'true'}
      {...handlers}
    >
      {/* optical alignment, not box alignment: ring A's outer stroke reaches
          12.15% of the viewBox from the edge (r 35.2 + half of stroke 5.3, on a
          100-unit box), so the box is pulled left by that fraction of 96 and the
          ink lands on the same 20pt margin as the title and the cards. */}
      <BrandMark size={96} className="rx-hero-gauge" />
      <div className="rx-hero-label">
        <div className="rx-title-2">{resident ? model.name : 'No model yet'}</div>
        <div className={'rx-hero-state rx-footnote' + (resident ? ' rx-tabular' : '')}>
          {/* ⚠️ APPLE'S MODEL HAS NO SIZE TO REPORT. It was never downloaded and
              cannot be removed, so the weight was rendering as "0.0 GB" — a
              number that is not wrong so much as meaningless. */}
          {resident
            ? (model.apple ? 'Built into iOS · nothing to download' : `Ready on this iPhone · ${fmtGB(model.sizeGB)}`)
            : 'Choose a model to run on this iPhone'}
          <Chevron />
        </div>
      </div>
    </div>
  )
}

/* ── one catalog row ──────────────────────────────────────────────────────── */

/**
 * A model you already have: name, size, and a tap that starts talking to it.
 *
 * Deliberately NOT the same component as ModelRow. That one is about acquiring
 * a model — its trailing control is a download arrow and its subtitle is a
 * sales line. This one is about using one, so the subtitle is the size on disk
 * and the trailing control is a disclosure into managing it.
 */
function InstalledRow ({ model, active, onOpen, onInfo }) {
  const row = usePress(() => onOpen?.(), {
    label: `Chat with ${model.name}${active ? ', current model' : ''}`
  })
  const manage = usePress((e) => { e.stopPropagation?.(); onInfo?.() }, {
    label: `Manage ${model.name}`
  })
  return (
    <div className={'rx-row rx-row-2line rx-pressable' + row.className} {...row.handlers}>
      <span className="rx-row-lead"><BrandMark size={29} /></span>
      <div className="rx-row-text">
        <div className="rx-headline">
          {model.name}
          {active && <span className="rx-installed-now">Current</span>}
        </div>
        <div className="rx-row-blurb">{fmtGB(model.sizeGB)} on this iPhone</div>
      </div>
      <span className={'rx-row-remove' + manage.className} {...manage.handlers}>Manage</span>
    </div>
  )
}

/**
 * Apple's model, listed whether or not this iPhone can run it.
 *
 * ⚠️ IT WAS ONLY EVER IN THE IN-CHAT SWITCHER. Tony: "I dont see apples model
 * as an option" — and he was right, because with any model downloaded the
 * Models screen never mentioned it. Worse, on a phone where Apple Intelligence
 * is switched off it simply did not exist anywhere, so there was nothing to
 * read and nothing to do. It is a row now either way: available and tappable,
 * or dimmed with the reason and the fix.
 */
function AppleRow ({ available, reason, active, onOpen }) {
  const row = usePress(() => { if (available) onOpen?.() }, {
    label: available
      ? `Chat with Apple Intelligence${active ? ', current model' : ''}, built into iOS`
      : `Apple Intelligence unavailable. ${reason}`,
    disabled: !available
  })
  return (
    <div
      className={'rx-row rx-row-2line' + (available ? ' rx-pressable' + row.className : '')}
      data-unavailable={!available}
      {...(available ? row.handlers : {})}
    >
      <span className="rx-row-lead"><BrandMark size={29} /></span>
      <div className="rx-row-text">
        <div className="rx-headline">
          Apple Intelligence
          {available && active && <span className="rx-installed-now">Current</span>}
        </div>
        <div className="rx-row-blurb">
          {available ? 'Built into iOS · nothing to download' : reason}
        </div>
      </div>
    </div>
  )
}

function ModelRow ({ model, state, progress, unavailable, shortBy, fit, failure, onTap, onAccessory }) {
  // ⚠️ THE VERDICT LABELS, IT DOES NOT FORBID — see the same note in
  // ModelPicker. Memory is an estimate and downloading is a disk operation;
  // only disk space blocks a download.
  const tooBig = fit === FITS_NO && !model.downloaded
  const shown = progressText(progress)
  const pct = progress && typeof progress.pct === 'number' ? Math.round(progress.pct * 100) : null
  const row = usePress(() => onTap?.(model), {
    label: `${model.name}, ${fmtGB(model.sizeGB)}` + (
      model.downloaded ? ', on this iPhone'
        : state === 'downloading' ? `, downloading${pct === null ? '' : `, ${pct} percent`}`
          : unavailable ? ', not enough room'
            : fit ? `, ${FIT_LABEL[fit].toLowerCase()} on this iPhone` : ''
    )
  })
  const downloading = state === 'downloading'
  const acc = usePress((e) => { e.stopPropagation?.(); onAccessory?.(model) }, {
    haptic: 'MEDIUM',
    // the trailing control is a glyph; without this it is announced as
    // "button" five times down the screen
    label: model.downloaded
      ? `Chat with ${model.name}`
      : downloading
        ? `Stop downloading ${model.name}${shown === null ? '' : `, ${shown} done`}`
        : `Download ${model.name}`
  })

  // The trailing column is ONE fixed-width glyph and nothing else, so every
  // row's right edge agrees. The one moment the gauge appears in a row is
  // mid-download, at 26pt, where it is turning — and motion is what carries a
  // mark this small, not stroke weight.
  const glyph = model.downloaded
    ? <span className="rx-tinted"><Checkmark /></span>
    : downloading
      // The turning arc is also the stop button, with a square inside it — the
      // iCloud idiom, where the progress indicator IS the cancel target. A
      // separate ✕ elsewhere in the row would break the single-glyph trailing
      // column every other row keeps.
      // ⚠️ ONE THING TURNS, AND IT IS THE ONE ON THE LEFT. Tony: "for the model
      // download we only need to spinning swirl logo at the left. the button on
      // the right (stop button) doesnt need animation or a circle around it
      // while downloading." Two spinning marks on one row is the same
      // information twice, and the eye cannot settle on either. The trailing
      // control goes back to being a plain control: a stop square, nothing
      // orbiting it.
      ? <span className="rx-stop-plain" aria-hidden="true" />
      : <span className={state === 'failed' ? 'rx-destructive' : undefined}><ArrowDownCircle /></span>

  return (
    <div
      className={'rx-row rx-row-2line' + row.className}
      {...row.handlers}
      data-unavailable={unavailable || tooBig ? 'true' : undefined}
      style={{ '--rx-sep-inset': downloading ? '57px' : '16px' }}
    >
      {/* While it downloads, the logo turns beside the name — Tony: "i want the
          blue logo to rotate next to the model name to show its downloading."
          It appears only then, so an idle list keeps its clean single column.
          ⚠️ TURNING ONLY — NO PROGRESS RING. It used to carry an arc that grew
          around the swirl. Tony, once the byte counter was working: "you can
          just have the blue swirl at the left rotate during downloads. we dont
          need the outer blue ring that grows with progress." He is right that
          it was saying the same thing twice: the blurb on this very row already
          reads "Downloading… 0.4 GB". At 29pt the arc was a 1.5pt stroke
          restating a number set in full beside it. */}
      {downloading && (
        <span className="rx-row-lead">
          <BrandSpinner size={29} />
        </span>
      )}
      <div className="rx-row-text">
        <div className="rx-headline">
          {model.name}
          {/* The verdict sits with the name, because it decides whether the row
              is worth reading. aria-hidden: the row's own label already says
              it, and hearing it twice on every row is noise.
              ⚠️ THE SIZE DOES NOT GO ON THIS LINE. It looks like there is room
              — measured, there is not. The headline is 309pt wide, not the row,
              and "Nemotron 3 Nano 4B" + "2.2 GB · Runs well" wraps to two
              lines; three more names clear the edge by under 30pt. The size
              rides at the front of the blurb instead, which is what the picker
              has always done. */}
          {fit && !model.downloaded && state !== 'downloading' && state !== 'failed' && (
            <span className={`rx-fit is-${fit}`} aria-hidden="true">{FIT_LABEL[fit]}</span>
          )}
        </div>
        <div className="rx-row-blurb">
          {/* ⚠️ THE REASON WAS ALREADY HERE AND THROWN AWAY. The native layer sends
              error.localizedDescription, useLocalModels stores it, and the
              VoiceOver announcer reads it out — so a screen-reader user heard
              why the download failed and everyone else got one fixed sentence
              with nothing to act on. Out of space, offline and the server
              refusing all looked identical. Tony hit it on Gemma 4 E4B: "i see
              a red arrow and it says That download did not finish." */}
          {state === 'failed'
            ? `${failure ? failure.replace(/\.$/, '') + '. ' : ''}Tap to try again.`
            : unavailable
              ? <span className="rx-warm">Needs {fmtGB(shortBy / GB)} more room</span>
              : tooBig
                ? `Needs about ${ramNeededGB(model.sizeGB).toFixed(1)} GB of memory`
                : downloading
                // Not the size — see the .rx-accessory note in mobile.css, that
                // string is always present and always costs the blurb its
                // width. This one exists only while the download runs, and it
                // replaces a blurb nobody is reading at that moment: a
                // determinate arc still does not answer "how much longer".
                ? <span className="rx-tabular" aria-hidden="true">
                    {shown ? `Downloading… ${shown}` : 'Downloading…'}
                  </span>
                // ⚠️ THE SIZE LIVES HERE. Tony, scanning the catalog: "models
                // have no sizes. no way to tell whats small." The weight used
                // to appear only once a model was downloaded — the one moment
                // you no longer need it. This is the picker's own line, to the
                // character, so the two model screens finally agree.
                : <>
                    <span className="rx-rowsize">{fmtGB(model.sizeGB)}</span>
                    {' · '}{model.blurb}
                  </>}
        </div>
      </div>
      <div
        className={'rx-accessory rx-pressable' + acc.className}
        {...(model.downloaded ? { 'aria-hidden': 'true' } : acc.handlers)}
      >
        {glyph}
      </div>
    </div>
  )
}

/* ── the screen ───────────────────────────────────────────────────────────── */

/**
 * One polite live region for the whole screen. Download start, progress,
 * completion and failure all changed the screen silently — a VoiceOver user got
 * no signal that a gigabyte-scale download had finished or failed. Polite, and
 * only at coarse milestones: announcing every percent would talk over the user
 * for ten minutes.
 */
function Announcer ({ models, jobs, progress, failures }) {
  const say = React.useMemo(() => {
    const failed = Object.keys(failures || {})[0]
    if (failed) {
      const m = models.find(x => x.id === failed)
      return `${m?.name || 'Download'} failed. ${failures[failed]}`
    }
    const running = Object.keys(jobs || {}).find(id => jobs[id] === 'downloading')
    if (!running) return ''
    const m = models.find(x => x.id === running)
    const p = progress?.[running]
    const pct = p && typeof p.pct === 'number' ? Math.round(p.pct * 100) : null
    // every 25%, not every 1%
    if (pct === null) return `Downloading ${m?.name || 'model'}`
    return `Downloading ${m?.name || 'model'}, ${Math.floor(pct / 25) * 25} percent`
  }, [models, jobs, progress, failures])

  return (
    <div className="rx-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {say}
    </div>
  )
}

export default function ModelsScreen ({
  local = {},
  models = [],
  activeModel,
  onOpenChat,
  onGetModel,
  apple,
}) {
  const {
    jobs = {}, failures = {}, progress = {}, disk, downloaded = [], usedBytes = 0,
    bytesOf, fits, shortfall, download, cancel
  } = local

  const canFit = (m) => (typeof fits === 'function' ? fits(m) : true)
  const fitOfModel = (m) => (typeof local.fitOf === 'function' ? local.fitOf(m) : null)
  const ramAvailable = local.ramAvailable || null
  const [openMakers, setOpenMakers] = useState(() => new Set())
  const toggleMaker = (name) => setOpenMakers(prev => {
    const next = new Set(prev)
    if (next.has(name)) next.delete(name); else next.add(name)
    return next
  })
  const shortBy = (m) => (typeof shortfall === 'function' ? shortfall(m) : 0)

  const stateOf = (m) => (
    jobs[m.id] === 'downloading' ? 'downloading' : failures[m.id] ? 'failed' : 'idle'
  )

  const pick = recommend(models)
  // Drawn whenever the device will tell us its disk, downloaded models or not.
  // Hiding it until the first download left the launch screen — the one screen
  // every judge sees — with a dead lower third and no statement of the argument
  // the whole app is making. The zero state draws no rail (an empty 4pt track
  // reads as a stuck download); StorageLine states the free space instead.
  const showStorage = !!(disk && disk.total)

  return (
    <>
      <Hero
        model={activeModel}
        onOpen={onOpenChat}
        canChoose={!!pick}
        onChoose={() => onGetModel?.(pick?.id)}
      />

      {/* ⚠️ WHAT IS ALREADY HERE COMES FIRST. Tony: "shouldnt the model download
          page show all the models installed and be able to start a chat from
          each. its awkward to start a chat from a new model." It was: the only
          route into a conversation with a model you already had was to find it
          inside its maker's shelf, among forty-three you do not have, and tap a
          tick. Downloaded models are the ones you own — they get their own
          section, at the top, and tapping one starts talking to it. */}
      {apple && (
        <div className="rx-section">
          <div className="rx-section-header">Already on this iPhone</div>
          <div className="rx-group">
            <AppleRow
              available={Boolean(apple.available)}
              reason={apple.reason}
              active={activeModel?.apple === true}
              onOpen={() => onOpenChat?.('apple-intelligence')}
            />
          </div>
          <div className="rx-section-footer">
            {apple.available
              ? 'Apple’s own model, already on the phone. Free, works offline, and nothing is downloaded. The models below are yours to keep and are usually better at longer work.'
              : 'Radiant can use Apple’s built-in model when it is available. The models below run on this iPhone regardless.'}
          </div>
        </div>
      )}

      {downloaded.length > 0 && (
        <div className="rx-section">
          <div className="rx-section-header">On this iPhone</div>
          <div className="rx-group">
            {models.filter(m => m.downloaded).map(m => (
              <InstalledRow
                key={m.id}
                model={m}
                active={m.id === activeModel?.id}
                onOpen={() => onOpenChat?.(m.id)}
                onInfo={() => onGetModel?.(m.id)}
              />
            ))}
          </div>
          <div className="rx-section-footer">
            Tap one to start a conversation with it. Tap Manage to remove it.
          </div>
        </div>
      )}

      <div className="rx-section">
        <Announcer models={models} jobs={jobs} progress={progress} failures={failures} />
        {/* One shelf per maker, all closed. Tony: "group the models by provider
            with widgets to close the section. not a long messy list like you
            have now." Forty-four rows in one column is unreadable; fourteen
            headers is a contents page. Same idiom as the Mac's Settings →
            Models, where each repo sits behind a triangle. */}
        <DeviceSpecs freeBytes={disk?.free} />

        {byMaker(models).map(({ maker, models: rows }) => {
          const open = openMakers.has(maker)
          const runnable = ramAvailable ? rows.filter(m => fitOfModel(m) !== FITS_NO).length : null
          return (
            <MakerSection
              key={maker}
              maker={maker}
              count={rows.length}
              runnable={runnable}
              open={open}
              onToggle={() => toggleMaker(maker)}
            >
              {open && (
                <div className="rx-group">
                  {rows.map(m => {
                    const blocked = !m.downloaded && !canFit(m)
                    const fit = fitOfModel(m)
                    const stopped = blocked
                    return (
                      <ModelRow
                        key={m.id}
                        model={m}
                        state={stateOf(m)}
                        progress={progress[m.id]}
                        failure={failures[m.id]}
                        unavailable={blocked}
                        shortBy={shortBy(m)}
                        fit={fit}
                        onTap={() => (stopped ? null : onGetModel?.(m.id))}
                        onAccessory={() => {
                          if (stopped) return
                          if (m.downloaded) onOpenChat?.(m.id)
                          else if (stateOf(m) === 'downloading') cancel?.(m.id)
                          else download?.(m.id)
                        }}
                      />
                    )
                  })}
                </div>
              )}
            </MakerSection>
          )
        })}
        {models.length === 0 && (
          <div className="rx-group">
            <div className="rx-row">
              <div className="rx-row-text">
                <div className="rx-row-blurb">
                  {local.ready ? 'No models are available on this device.' : 'Reading the catalog…'}
                </div>
              </div>
            </div>
          </div>
        )}
        {/* the privacy claim, in the quietest text on the screen. A banner would
            cheapen it, and this one happens to be literally true. */}
        <div className="rx-section-footer">
          A model you download runs on this iPhone, and nothing you send it leaves
          the device. A provider you add in Settings is a network service, and what
          you send there goes to them.
        </div>
      </div>

      {/* room for the storage line, which is pinned over the scroller */}
      <div style={{ height: showStorage ? 72 : 24 }} aria-hidden="true" />

      {showStorage && (
        <StorageLine downloaded={downloaded} disk={disk} usedBytes={usedBytes} bytesOf={bytesOf} />
      )}
    </>
  )
}

export { ModelsScreen }

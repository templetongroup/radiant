/**
 * GetModelSheet — the sheet behind "choose a model" and behind a tap on any
 * catalog row.
 *
 * Two faces, one container:
 *   · a model that is not on the phone yet → the picker (large detent), which
 *     owns the download flow, the indeterminate gauge and the honest absence of
 *     a percentage. The plugin emits started/done/failed and nothing between
 *     (TG-221), so there is no byte counter here and inventing one is the one
 *     thing that would make the app dishonest.
 *   · a model already on the phone → a detail view (medium detent): the gauge
 *     at rest, a SIZE / SPEED / NEEDS strip, "Start chatting", and Remove at
 *     the very bottom where a destructive action belongs.
 *
 * Interactive drag-to-dismiss uses the same velocity projection as the back
 * gesture, because a sheet that only animates on release is caught instantly
 * under a real thumb.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { deviceWord } from './device.js'
import ModelPicker from './ModelPicker.jsx'
import Gauge from './Gauge.jsx'
import usePress from './usePress.js'
import * as haptics from './haptics.js'
import { BrandMark } from './BrandSpinner.jsx'

const SPEED = {
  'llama3.2-1b': 'Fastest',
  'qwen3-1.7b': 'Fast',
  'gemma3-1b': 'Fast',
  'lfm2-1.2b': 'Fastest',
  'qwen3-4b': 'Steady'
}
const NEEDS = {
  'llama3.2-1b': `Any ${deviceWord()}`,
  'qwen3-1.7b': 'Recent',
  'gemma3-1b': `Any ${deviceWord()}`,
  'lfm2-1.2b': `Any ${deviceWord()}`,
  'qwen3-4b': 'Pro'
}

export default function GetModelSheet ({ local = {}, models = [], modelId, onDismiss, onStartChat }) {
  const model = useMemo(() => models.find(m => m.id === modelId) || null, [models, modelId])
  const detail = !!model?.downloaded

  const [p, setP] = useState(1)        // 1 = fully off-screen, 0 = presented
  const [dragging, setDragging] = useState(false)
  const sheetRef = useRef(null)
  const drag = useRef(null)

  // present on the next frame so the transform has something to animate from
  useEffect(() => {
    const r = requestAnimationFrame(() => setP(0))
    return () => cancelAnimationFrame(r)
  }, [])


  const close = useCallback(() => {
    setP(1)
    setTimeout(() => onDismiss?.(), 300)
  }, [onDismiss])

  // Modal behaviour: move focus in, keep it in, put it back, and answer Escape.
  useEffect(() => {
    const opener = document.activeElement
    const focusables = () => Array.from(
      sheetRef.current?.querySelectorAll(
        'button:not([disabled]), [role="button"]:not([aria-disabled="true"]), input, textarea, [tabindex]:not([tabindex="-1"])'
      ) || []
    )
    // first frame: the sheet is on screen but its content may not be laid out
    const t = setTimeout(() => (focusables()[0] || sheetRef.current)?.focus?.(), 60)

    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      // wrap, so Tab cannot walk out of the sheet into the screen behind it
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      clearTimeout(t)
      document.removeEventListener('keydown', onKey, true)
      // put focus back where it came from, so the list does not jump to the top
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus()
    }
  }, [close])

  const onPointerDown = (e) => {
    drag.current = { y0: e.clientY, last: e.clientY, lastT: performance.now(), v: 0, h: sheetRef.current?.offsetHeight || 400 }
    setDragging(true)
  }
  const onPointerMove = (e) => {
    const g = drag.current
    if (!g) return
    const now = performance.now()
    g.v = ((e.clientY - g.last) / Math.max(1, now - g.lastT)) * 1000
    g.last = e.clientY; g.lastT = now
    setP(Math.max(0, (e.clientY - g.y0) / g.h))
  }
  const onPointerUp = (e) => {
    const g = drag.current
    drag.current = null
    setDragging(false)
    if (!g) return
    const travelled = Math.max(0, e.clientY - g.y0)
    const projected = travelled + g.v * 0.15
    if (projected > g.h * 0.4 || g.v > 300) { haptics.impact('RIGID'); close() } else setP(0)
  }

  const start = usePress(() => { onStartChat?.(model.id) })
  const remove = usePress(() => { local.remove?.(model.id); close() })

  return (
    <>
      <div
        className="rx-sheet-scrim"
        style={{ '--rx-sheet-p': p }}
        onPointerDown={close}
      />
      <div
        ref={sheetRef}
        className="rx-sheet"
        // A sheet is a modal, and it was not announced as one: no role, no
        // aria-modal, focus never entered it, twelve controls behind it stayed
        // tabbable, and Escape did nothing — leaving a keyboard or Switch
        // Control user unable to close the app's central screen.
        role="dialog"
        aria-modal="true"
        aria-label={detail ? model?.name : 'Choose a model'}
        data-dragging={dragging ? 'true' : undefined}
        style={{ '--rx-sheet-p': p, '--rx-sheet-h': detail ? '55dvh' : '92dvh' }}
      >
        <div
          className="rx-grabber"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{ padding: 0, touchAction: 'none' }}
        />

        {detail ? (
          <div style={{ padding: '24px 20px 0', display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <BrandMark size={120} />
              <div className="rx-title-2">{model.name}</div>
            </div>

            <div className="rx-stat-strip">
              <div className="rx-stat">
                <div className="rx-stat-key">Size</div>
                <div className="rx-stat-value">{Number(model.sizeGB).toFixed(1)} GB</div>
              </div>
              <div className="rx-stat">
                <div className="rx-stat-key">Speed</div>
                <div className="rx-stat-value">{SPEED[model.id] || 'Fast'}</div>
              </div>
              <div className="rx-stat">
                <div className="rx-stat-key">Needs</div>
                <div className="rx-stat-value">{NEEDS[model.id] || 'Recent'}</div>
              </div>
            </div>

            <div style={{ marginTop: 24 }}>
              <button type="button" className={'rx-primary rx-pressable' + start.className} {...start.handlers}>
                Start chatting
              </button>
            </div>

            <div style={{ marginTop: 'auto', paddingTop: 20 }}>
              <button
                type="button"
                className={'rx-plain-button' + remove.className}
                data-destructive="true"
                {...remove.handlers}
              >
                Remove model
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }}>
            <ModelPicker
              heading="Choose a model"
              Gauge={Gauge}
              // The row that opened this sheet leads it. Without this the sheet
              // always opened on the recommendation, so tapping "Gemma 3 1B"
              // presented Qwen — the tap's whole meaning thrown away.
              featureId={modelId || undefined}
              onChoose={(m) => onStartChat?.(m.id)}
            />
          </div>
        )}
      </div>
    </>
  )
}

export { GetModelSheet }

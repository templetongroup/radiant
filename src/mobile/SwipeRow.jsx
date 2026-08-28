/**
 * A list row that hides its destructive action behind a leftward swipe.
 *
 * ⚠️ THE DELETE BUTTON STAYS IN THE DOM. iOS hides delete behind a gesture, and
 * a gesture is invisible and unreachable to anyone driving the screen with
 * VoiceOver — which is why this list showed a red Delete on every row in the
 * first place. So the button is always present and always focusable; the swipe
 * only decides whether it is on screen. Removing it to tidy the markup would
 * take the feature away from the people who need it most.
 *
 * ⚠️ THE HORIZONTAL LISTENER IS NOT PASSIVE, AND IS ADDED BY HAND. React
 * attaches touchmove at the root where the browser treats it as passive, so
 * preventDefault() there is ignored and the list scrolls diagonally under the
 * finger. The listener has to be bound to this element with { passive: false }.
 */
import React, { useEffect, useRef, useState } from 'react'
import haptics from './haptics.js'

// 88 is two 44pt targets' worth of travel: far enough that a scroll never
// trips it, short enough to reach with a thumb.
const ACTION_W = 88
const LOCK_SLOP = 6      // movement before we decide the gesture's direction
const OPEN_AT = ACTION_W / 2

export default function SwipeRow ({ children, onDelete, deleteLabel, isOpen, onOpenChange, className = '', rowProps = {} }) {
  const ref = useRef(null)
  const [dx, setDx] = useState(0)
  const dxRef = useRef(0)
  const set = (v) => { dxRef.current = v; setDx(v) }

  // Another row opening closes this one.
  useEffect(() => { if (!isOpen && dxRef.current !== 0) set(0) }, [isOpen])
  useEffect(() => { if (isOpen && dxRef.current === 0) set(-ACTION_W) }, [isOpen])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let s = null

    const onStart = (e) => {
      const t = e.touches[0]
      s = { x: t.clientX, y: t.clientY, base: dxRef.current, axis: null }
    }
    const onMove = (e) => {
      if (!s) return
      const t = e.touches[0]
      const mx = t.clientX - s.x
      const my = t.clientY - s.y
      if (s.axis === null) {
        if (Math.abs(mx) < LOCK_SLOP && Math.abs(my) < LOCK_SLOP) return
        // ⚠️ DECIDE ONCE. Re-deciding mid-gesture makes a diagonal drag flicker
        // between scrolling and swiping.
        s.axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y'
      }
      if (s.axis !== 'x') return
      e.preventDefault()
      // Rubber-band past the stop rather than letting it slide off.
      let next = s.base + mx
      if (next < -ACTION_W) next = -ACTION_W - ((-ACTION_W - next) * 0.35)
      set(Math.min(0, Math.max(-ACTION_W - 24, next)))
    }
    const onEnd = () => {
      if (!s) return
      const wasX = s.axis === 'x'
      s = null
      if (!wasX) return
      const open = dxRef.current < -OPEN_AT
      set(open ? -ACTION_W : 0)
      if (open !== isOpen) {
        haptics.selection?.()
        onOpenChange?.(open)
      }
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [isOpen, onOpenChange])

  return (
    <div className="rx-swipe" ref={ref}>
      <button
        className="rx-swipe-action"
        aria-label={deleteLabel}
        onClick={(e) => { e.stopPropagation(); haptics.impact?.('MEDIUM'); onDelete() }}
      >
        Delete
      </button>
      <div
        className={'rx-swipe-face ' + className}
        /* ⚠️ NO TRANSFORM AT REST. translate3d(0,0,0) plus will-change promotes
           the face to its own compositing layer, which rasterizes on its own
           pixel grid — at fractional row offsets that left a one-pixel seam and
           the red Delete underneath bled through the bottom of rows nobody had
           touched. At rest there is nothing to move, so there is no layer. */
        style={{
          transform: dx === 0 ? undefined : `translate3d(${dx}px,0,0)`,
          willChange: dx === 0 ? undefined : 'transform',
          transition: dx === 0 || dx === -ACTION_W ? 'transform 220ms cubic-bezier(.32,.72,0,1)' : 'none'
        }}
        {...rowProps}
      >
        {children}
      </div>
    </div>
  )
}

import React, { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A button you have to hold, for the things that cannot be undone.
 *
 * ⚠️ THE REASON IS THE SECOND CLICK, NOT A BROKEN CONFIRM. An earlier note here
 * said window.confirm is a no-op in these windows. IT IS NOT — probed against the
 * packaged app on 2026-09-02: it is the native implementation, it shows a real
 * dialog, and it returns true when accepted. The belief came from window.prompt,
 * which genuinely is unimplemented, and from an agent-removal bug whose real cause
 * turned out to be a stale config write.
 *
 * The hold still earns its place on its own merits: a two-click arm puts the
 * second click on a button whose meaning changed under the pointer, and Tony has
 * twice reported one that "did nothing" when it had in fact re-armed. A hold has
 * no second click to miss, and letting go means nothing happened.
 *
 * ⚠️ IT MUST WORK FROM A KEYBOARD. Holding Enter or Space fills it exactly as a
 * press does — keydown repeats while held, keyup cancels. A control that can only
 * be operated by holding a mouse button is a control some people cannot operate
 * at all, and every session row here is reachable by tab.
 *
 * ⚠️ AND UNDER REDUCE MOTION IT IS STILL A HOLD. The ring stops animating, but
 * the duration does not change — the delay is the safety mechanism, not the
 * decoration. Removing it because someone dislikes motion would quietly remove
 * the confirmation.
 */
export default function HoldButton ({
  onConfirm,
  ms = 650,
  className = '',
  label,           // aria-label at rest
  holdLabel,       // what it means while held
  children,
  ...rest
}) {
  const [held, setHeld] = useState(false)
  const raf = useRef(0)
  const started = useRef(0)
  const done = useRef(false)
  const el = useRef(null)

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current)
    raf.current = 0
    setHeld(false)
    if (el.current) el.current.style.setProperty('--hold', '0')
  }, [])

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const tick = useCallback(() => {
    const p = Math.min(1, (Date.now() - started.current) / ms)
    if (el.current) el.current.style.setProperty('--hold', String(p))
    if (p >= 1) {
      if (!done.current) { done.current = true; stop(); onConfirm?.() }
      return
    }
    raf.current = requestAnimationFrame(tick)
  }, [ms, onConfirm, stop])

  const begin = e => {
    e.stopPropagation()
    if (raf.current) return
    done.current = false
    started.current = Date.now()
    setHeld(true)
    raf.current = requestAnimationFrame(tick)
  }

  return (
    <button
      ref={el}
      className={'hold-btn' + (held ? ' is-holding' : '') + (className ? ' ' + className : '')}
      aria-label={held ? (holdLabel || label) : label}
      title={held ? (holdLabel || label) : label}
      onPointerDown={begin}
      onPointerUp={e => { e.stopPropagation(); stop() }}
      onPointerLeave={stop}
      onPointerCancel={stop}
      // A click would otherwise reach the row underneath and open the chat.
      onClick={e => { e.stopPropagation(); e.preventDefault() }}
      onKeyDown={e => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()   // Space scrolls, Enter would click
        begin(e)
      }}
      onKeyUp={e => { if (e.key === 'Enter' || e.key === ' ') stop() }}
      onBlur={stop}
      {...rest}
    >
      {/* ⚠️ A REAL ELEMENT, NOT ::after. Every one of these buttons also carries
          data-tip, and the CSS tooltip IS ::after — so a ring drawn there is
          simply never painted. The first version did exactly that: the state was
          right, --hold counted up, and nothing appeared on screen. */}
      <span className='hold-ring' aria-hidden />
      {children}
    </button>
  )
}

import React, { useEffect, useRef, useState } from 'react'

/**
 * A button that says it worked, by drawing a check where its label was.
 *
 * ⚠️ SAVING USED TO LOOK IDENTICAL TO NOT SAVING. Press Save on an API key or an
 * agent and the button stays exactly as it was — the only evidence is that the
 * screen did not complain. That is the same hole the Copy buttons had.
 *
 * ⚠️ IT CONFIRMS THE PROMISE, NOT THE PRESS. onClick is awaited, and the check
 * only draws if it resolves; a rejection leaves the button alone and rethrows so
 * the caller still shows its own error. A confirmation that fires on click rather
 * than on success is worse than none, because it teaches you to trust it.
 */
export default function ConfirmButton ({
  onClick,
  children,
  doneLabel = 'Saved',
  ms = 1400,
  className = 'small-btn primary',
  ...rest
}) {
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const timer = useRef(0)
  const alive = useRef(true)

  // ⚠️ RE-ARM ON MOUNT, NOT JUST DISARM ON UNMOUNT. React 18 StrictMode mounts,
  // unmounts and mounts again, so a cleanup that only sets this false leaves it
  // false forever — and every confirmation is then thrown away by the guard that
  // is supposed to protect against setting state after unmount. This shipped that
  // way for one build: the click ran, the clipboard was written, and the button
  // never changed.
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; clearTimeout(timer.current) }
  }, [])

  const run = async e => {
    if (busy) return
    setBusy(true)
    try {
      await onClick?.(e)
      if (!alive.current) return
      setDone(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => { if (alive.current) setDone(false) }, ms)
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return (
    <button
      className={className + (done ? ' is-confirmed' : '')}
      onClick={run}
      // ⚠️ NO SEPARATE LIVE REGION. An sr-only "Copied" beside a visible "Copied"
      // is announced twice — the button's accessible name is the concatenation of
      // both. The visible label IS the announcement: the accessible name changes
      // from "Copy" to "Copied" on the element that still has focus, which is the
      // same thing GitHub's copy buttons do.
      {...rest}
    >
      {done
        ? <span className='confirm-done'>
            <svg viewBox='0 0 16 16' width='13' height='13' aria-hidden>
              <path className='confirm-tick' d='M3.5 8.5 L6.5 11.5 L12.5 4.5'
                    fill='none' stroke='currentColor' strokeWidth='2'
                    strokeLinecap='round' strokeLinejoin='round' />
            </svg>
            {doneLabel}
          </span>
        : children}
    </button>
  )
}

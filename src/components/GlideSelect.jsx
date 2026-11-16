import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './Icons.jsx'

// ⚠️ ONE HIGHLIGHT THAT TRAVELS, the same idiom as the answer cards' Focus
// Relay and the sidebar's pill: a single element glides between rows as the
// pointer or the arrow keys move, so the menu reads as one thing choosing.
// After reactbits.dev/micro/glide-select, which Tony asked for on the right
// panel's menu; written here in Radiant's tokens rather than imported (theirs
// carries an icon package; ours has the symbols already). Also: pops from
// its trigger, flips above when there is no room below, a tick on the
// current row, a tag at the right of each row, typeahead, Home/End, Escape,
// and stillness under prefers-reduced-motion (in CSS).
//
//   <GlideSelect value={tab} onChange={setTab} ariaLabel='Panel section'
//     options={[{ value: 'activity', label: 'Activity' }, { value: 'foryou', label: 'For you', tag: '⇧⌘I', badge: 3 }]} />

const ROW = 30, GAP = 1, PAD = 4

export default function GlideSelect ({ options = [], value, onChange, ariaLabel = 'Select', placeholder = 'Select…', menuWidth = 190, className = '', triggerIcon = null }) {
  const items = options
  const selected = items.findIndex(it => it.value === value)
  const [phase, setPhase] = useState('closed')       // closed | open | closing
  const [active, setActive] = useState(null)         // row under the pointer / keyboard
  const [side, setSide] = useState('bottom')
  const root = useRef(null), trigger = useRef(null), menu = useRef(null), pill = useRef(null)
  const instant = useRef(false)
  const closeTimer = useRef(null)
  const id = useId()
  const step = ROW + GAP

  // pop the menu from the trigger, with the pill parked on the current row
  useLayoutEffect(() => {
    if (phase !== 'open') return
    const el = menu.current, r = root.current?.getBoundingClientRect()
    if (!el || !r) return
    setSide(r.bottom + el.offsetHeight + 8 > window.innerHeight ? 'top' : 'bottom')
    el.dataset.state = 'closed'
    void el.offsetHeight
    el.dataset.state = 'open'
    const p = pill.current
    if (p) { p.style.transition = 'none'; p.style.transform = `translateY(${Math.max(0, selected) * step}px)`; p.style.opacity = '0'; void p.offsetHeight; p.style.transition = '' }
  }, [phase])

  // the pill follows `active`; the first move after opening jumps, the rest glide
  useLayoutEffect(() => {
    const p = pill.current
    if (!p || phase !== 'open') return
    if (active === null) { p.style.opacity = '0'; return }
    const jump = instant.current || p.style.opacity !== '1'
    p.style.transitionDuration = jump ? '0ms, 150ms' : ''
    p.style.transform = `translateY(${active * step}px)`
    p.style.opacity = '1'
    instant.current = false
  }, [active, phase, step])

  const open = viaKey => { clearTimeout(closeTimer.current); instant.current = true; setActive(selected >= 0 ? selected : viaKey ? 0 : null); setPhase('open') }
  const close = mode => {
    setActive(null); clearTimeout(closeTimer.current)
    const el = menu.current
    if (mode === 'instant' || !el) { setPhase('closed'); return }
    el.dataset.state = 'closed'; setPhase('closing')
    closeTimer.current = setTimeout(() => setPhase('closed'), 140)
  }
  const pick = i => {
    const it = items[i]
    if (it && it.value !== value) onChange?.(it.value, it)
    close('instant')
    trigger.current?.focus({ preventScroll: true })
  }

  const onKey = e => {
    const k = e.key, n = items.length
    const cur = active ?? Math.max(0, selected)
    if (phase !== 'open') {
      if (k === 'Enter' || k === ' ' || k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); open(true) }
      return
    }
    const go = i => { e.preventDefault(); instant.current = false; setActive(Math.min(n - 1, Math.max(0, i))) }
    if (k === 'ArrowDown' || k === 'ArrowUp') go(active === null ? cur : cur + (k === 'ArrowDown' ? 1 : -1))
    else if (k === 'Home' || k === 'End') go(k === 'Home' ? 0 : n - 1)
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); pick(cur) }
    else if (k === 'Escape' || k === 'Tab') { if (k === 'Escape') e.preventDefault(); close('instant') }
    else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const c = k.toLowerCase()
      for (let j = 1; j <= n; j++) { const i = (cur + j) % n; if (String(items[i].label).toLowerCase().startsWith(c)) { go(i); break } }
    }
  }

  useEffect(() => {
    if (phase === 'closed') return
    const down = e => { if (root.current && !root.current.contains(e.target)) close('pop') }
    document.addEventListener('pointerdown', down, true)
    return () => document.removeEventListener('pointerdown', down, true)
  }, [phase])
  useEffect(() => () => clearTimeout(closeTimer.current), [])

  const current = items[selected]
  const totalBadge = items.reduce((a, it) => a + (it.badge || 0), 0)
  return (
    <div ref={root} className={('glide ' + className).trim()} data-side={side}>
      <button
        ref={trigger}
        type='button'
        className='glide-trigger'
        aria-haspopup='listbox'
        aria-expanded={phase === 'open'}
        aria-label={ariaLabel}
        aria-controls={id}
        onClick={() => (phase === 'open' ? close('pop') : open(false))}
        onKeyDown={onKey}
      >
        {(current?.icon || triggerIcon) && <span className='glide-ico' aria-hidden>{current?.icon || triggerIcon}</span>}
        <span className='glide-value'>{current ? (current.short || current.label) : placeholder}</span>
        {!current?.badge && totalBadge ? <span className='glide-badge'>{totalBadge}</span> : null}
        <span className='glide-chevron'><Icon.chevronDown size={8} /></span>
      </button>
      {phase !== 'closed' && (
        <div ref={menu} id={id} className='glide-menu' role='listbox' aria-label={ariaLabel} style={{ width: menuWidth, padding: PAD }} data-state='closed'
          onMouseLeave={() => setActive(null)}>
          <div ref={pill} className='glide-pill' style={{ height: ROW, top: PAD, left: PAD, right: PAD }} aria-hidden />
          {items.map((it, i) => (
            <button
              key={it.value}
              type='button'
              role='option'
              aria-selected={i === selected}
              className={'glide-row' + (i === selected ? ' is-selected' : '') + (i === active ? ' is-active' : '')}
              style={{ height: ROW, marginBottom: i < items.length - 1 ? GAP : 0 }}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(i)}
            >
              {it.icon && <span className='glide-ico' aria-hidden>{it.icon}</span>}
              <span className='glide-label'>{it.label}</span>
              {it.badge ? <span className='glide-badge'>{it.badge}</span> : null}
              {it.tag && <span className='glide-tag'>{it.tag}</span>}
              {i === selected && <span className='glide-tick'><Icon.check size={11} /></span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

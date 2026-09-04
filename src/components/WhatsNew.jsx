import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api.js'
import { whatsNewSince } from '../whatsnew.js'

const KEY = 'radiant.seenVersion'

/**
 * What arrived while you were not looking.
 *
 * ⚠️ IT RECORDS THE VERSION EVEN WHEN IT SHOWS NOTHING. A fresh install is shown
 * nothing — but if it did not write the version down, the NEXT update would replay
 * the entire history at somebody who had used the app once.
 *
 * ⚠️ PER DEVICE, NOT PER ACCOUNT. localStorage, not the config: the config is
 * shared between the Macs pointed at one Radiant, so storing it there would mean
 * reading the release notes on the laptop and never seeing them on the desktop that
 * also updated. It also has to work before any config arrives.
 *
 * ⚠️ AND IT IS DISMISSED BY ONE OBVIOUS CONTROL. This appears unbidden, in front of
 * whatever you sat down to do, so Escape, the backdrop and the button all close it,
 * and it never comes back for that version.
 */
export default function WhatsNew () {
  const [items, setItems] = useState(null)

  useEffect(() => {
    let alive = true
    api.getVersion().then(({ version }) => {
      if (!alive || !version) return
      let seen = null
      try { seen = localStorage.getItem(KEY) } catch {}
      const list = whatsNewSince(seen, version)
      try { localStorage.setItem(KEY, version) } catch {}
      if (list.length) setItems(list)
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!items) return
    const onKey = e => { if (e.key === 'Escape') setItems(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items])

  if (!items) return null
  const newest = items[0].version

  // ⚠️ A PORTAL, NOT A CHILD OF .app. Rendered inside the app tree this became a
  // FLEX ITEM: styles.css has `.app > *:not(.motion-bg) { position: relative }`,
  // two classes to this rule's one, so `position: fixed` lost and the backdrop
  // took a column of its own. The sidebar was shoved from x 0 to x 1152 while the
  // dialog was open and snapped back when it closed, and the dialog centred itself
  // in the leftover space rather than the window — 124px off. Tony: "the read me
  // looks clumsy on the left. when i click got it. the nav bar shifts over to the
  // right. looks bad."
  //
  // Raising specificity would have fixed this one modal and left the trap set for
  // the next. An overlay belongs outside the layout it covers.
  return createPortal((
    <div className='wn-backdrop' onClick={() => setItems(null)}>
      <div className='wn' role='dialog' aria-modal='true' aria-labelledby='wn-title' onClick={e => e.stopPropagation()}>
        <div className='wn-head'>
          <div className='logo-mark wn-mark' aria-hidden />
          <div>
            <div id='wn-title' className='wn-title'>What’s new in Radiant</div>
            <div className='wn-ver'>You’re now on {newest}</div>
          </div>
        </div>
        <div className='wn-body'>
          {items.map(rel => (
            <div key={rel.version} className='wn-rel'>
              {items.length > 1 && <div className='wn-relver'>{rel.version}</div>}
              {rel.items.map(([title, body]) => (
                <div key={title} className='wn-item'>
                  <div className='wn-item-title'>{title}</div>
                  <div className='wn-item-body'>{body}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className='wn-foot'>
          <span className='wn-hint'>Settings › Read me has the rest.</span>
          <button className='small-btn primary' onClick={() => setItems(null)} autoFocus>Got it</button>
        </div>
      </div>
    </div>
  ), document.body)
}

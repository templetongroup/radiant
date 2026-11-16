import React from 'react'
import { SF_SYMBOLS } from '../sf-symbols-mac.js'

// ⚠️ THESE ARE APPLE'S SF SYMBOLS, NOT DRAWN HERE. Until 2026-09-18 every icon
// in the Mac app was a hand-drawn line icon, and this file was a history of the
// ones that went wrong: a gear that mushed to a blob at 16px, a brain that read
// as a book, two people that read as a smudge, five emoji that rendered
// differently per OS. Tony bought the SF Symbols pack, saw the two side by side
// and chose these. scripts/sf-symbols.sh mac renders each one with macOS
// itself at medium weight (the old line icons were a 2px stroke on a 24 grid;
// SF's regular reads thinner beside text at 16px) into a mask that is tinted
// with currentColor, so an icon on a pill takes the pill's state colour the
// way text does. To add one: put its name in the script's list, rerun it, add
// a line to SF_NAME.
//
// ⚠️ LICENCE. Apple allows the symbols in apps for Apple platforms only. This
// module is never imported by the website or the Chrome extension.
const SF_NAME = {
  download: 'arrow.down.to.line', panel: 'sidebar.left', settings: 'gearshape', sun: 'sun.max', moon: 'moon',
  contrast: 'circle.lefthalf.filled', plus: 'plus', arrowUp: 'arrow.up', sparkle: 'sparkles', stop: 'stop.fill',
  close: 'xmark', monitor: 'desktopcomputer', clipboard: 'list.clipboard', unlock: 'lock.open', zap: 'bolt',
  bulb: 'lightbulb', hand: 'hand.raised', wrench: 'wrench', users: 'person.2', file: 'doc.text',
  branch: 'arrow.triangle.branch', folder: 'folder', archive: 'archivebox', unarchive: 'tray.and.arrow.up',
  trash: 'trash', mic: 'mic', target: 'scope', waves: 'waveform', bot: 'cpu', chevronDown: 'chevron.down', check: 'checkmark', chat: 'bubble.left.and.bubble.right', checklist: 'checklist', repeat: 'repeat', graph: 'point.3.connected.trianglepath.dotted', whiteboard: 'scribble.variable'
}
function Sf ({ name, size = 16 }) {
  const s = SF_SYMBOLS[name]
  if (!s) return null
  // the symbol's layout box is wider than tall; fit it in the same square the line icon used
  const h = size, w = Math.round((size * s.w / s.h) * 100) / 100
  return <span aria-hidden style={{ display: 'inline-block', width: w, height: h, flex: 'none', verticalAlign: 'middle', backgroundColor: 'currentColor', WebkitMaskImage: `url(${s.src})`, maskImage: `url(${s.src})`, WebkitMaskSize: 'contain', maskSize: 'contain', WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat', WebkitMaskPosition: 'center', maskPosition: 'center' }} />
}

export const Icon = Object.fromEntries(Object.entries(SF_NAME).map(([k, name]) => [k, p => <Sf name={name} size={p?.size} />]))

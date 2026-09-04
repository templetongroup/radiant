#!/usr/bin/env node
// Contrast gate for pinned theme palettes.
//
// ⚠️ THE MOBILE THEME SYSTEM DELIBERATELY FORBIDS THEMING LIGHTNESS, because a
// theme that can darken the surface can make the app unreadable. Nous Classic
// is the one palette allowed to break that rule, so the protection the rule
// provided has to come from somewhere — here.
const hex = h => {
  const m = /^#([0-9a-f]{6})$/i.exec(h.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const lum = rgb => {
  const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (fg, bg) => {
  const a = lum(hex(fg)), b = lum(hex(bg))
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const { THEMES: DESKTOP } = await import('../src/theme.js')
const { THEMES: MOBILE } = await import('../src/mobile/theme.js')

const cases = []
for (const t of DESKTOP.filter(t => t.vars)) {
  for (const [mode, v] of Object.entries(t.vars)) {
    cases.push([`mac ${t.id}/${mode}: text on bg`, v['--text'], v['--bg'], 4.5])
    cases.push([`mac ${t.id}/${mode}: text on panel`, v['--text'], v['--bg-panel'], 4.5])
    cases.push([`mac ${t.id}/${mode}: muted on bg`, v['--text-muted'], v['--bg'], 4.5])
      // ⚠️ AND ON A PANEL, WHICH IS WHERE THE COMPOSER SITS. The controls there are
      // plain text now — no outline to lean on — so the label carries the control
      // by itself and has to be readable as text, not as decoration.
      cases.push([`mac ${t.id}/${mode}: muted on panel`, v['--text-muted'], v['--bg-panel'], 4.5])
    cases.push([`mac ${t.id}/${mode}: on-accent on accent`, v['--on-accent'], v['--accent'], 4.5])
    // ⚠️ THE SELECTED TAB MUST BE VISIBLE ON ITS OWN TRACK. Chats/Agents/Tasks is
    // a segmented control: the only thing marking the current view is the pill's
    // fill against the strip behind it. --bg-raised on --bg-input measured
    // 1.08:1 in the light themes — a white chip on a white strip. Tony: "the
    // active tab is barely visible." The track now mixes 10% --text, which is
    // what this checks; 1.4 is the bar the iOS separator already uses.
    cases.push([`mac ${t.id}/${mode}: selected tab on its track`,
                v['--accent'], v['--bg-input'], 1.4])
  }
}
for (const t of MOBILE.filter(t => t.vars)) {
  const v = t.vars
  cases.push([`ios ${t.id}: label on bg`, v['--rx-label'], v['--rx-bg'], 4.5])
  cases.push([`ios ${t.id}: label on cell`, v['--rx-label'], v['--rx-cell'], 4.5])
  cases.push([`ios ${t.id}: on-tint on tint`, v['--rx-on-tint'], v['--rx-tint'], 4.5])
  // ⚠️ THE TINT IS ALSO TEXT — section headers, the back chevron, every .rx-tinted
  // control. Checking it only as a FILL (on-tint on tint, above) passed Templeton
  // with its section headers at 1.97:1 against its own background: a theme on a
  // light background can contrast against the label sitting ON the tint and still
  // vanish against the surface BEHIND it. Measured on the lightest surface tinted
  // text ever lands on, which is the one that governs.
  cases.push([`ios ${t.id}: tinted text on bg`, v['--rx-tint-text'] || v['--rx-tint'], v['--rx-bg'], 4.5])
  cases.push([`ios ${t.id}: tinted text on cell-2`, v['--rx-tint-text'] || v['--rx-tint'], v['--rx-cell-2'], 4.5])
  cases.push([`ios ${t.id}: separator-opaque on bg`, v['--rx-separator-opaque'], v['--rx-bg'], 1.4])
}

// ⚠️ A PINNED THEME'S DECLARED hue/chroma MUST DESCRIBE ITS PINNED ACCENT.
// CSS falls back to oklch(... var(--ah, 258)) and JS to var(--accent) for items
// with no colour of their own; if the declared numbers drift from the real
// accent, project folders and agent glyphs land in a different colour family
// from the accent beside them — which is exactly what shipped in 0.6.154.
const { hexToOklch, glyphColor } = await import('../src/theme.js')
let structural = 0
for (const t of DESKTOP.filter(t => t.vars)) {
  const o = hexToOklch(t.vars.dark['--accent'])
  const ok = Math.abs(o.H - t.hue) < 1.5 && Math.abs(o.C - t.chroma) < 0.01
  if (!ok) structural++
  console.log(`  ${ok ? '✓' : '✗'} ${t.name}: declared hue/chroma matches its pinned accent (${o.H.toFixed(1)}, ${o.C.toFixed(3)})`)
}
{
  const ok = glyphColor(null) === 'var(--accent)' && glyphColor(320).includes('320')
  if (!ok) structural++
  console.log(`  ${ok ? '✓' : '✗'} an item with no hue of its own uses the accent itself`)
}

let bad = structural
for (const [name, fg, bg, min] of cases) {
  if (!hex(fg) || !hex(bg)) { console.log(`  ? ${name} — not a plain hex, skipped`); continue }
  const r = ratio(fg, bg)
  const pass = r >= min
  if (!pass) bad++
  console.log(`  ${pass ? '✓' : '✗'} ${name}: ${r.toFixed(2)}:1 (needs ${min})`)
}
console.log(`\n${cases.length - (bad - structural)}/${cases.length} contrast checks passed` + (structural ? `, ${structural} structural check(s) FAILED` : ', structural checks passed'))
process.exit(bad ? 1 : 0)

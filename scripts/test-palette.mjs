/**
 * A palette built from a background and a foreground the user picked.
 *
 * ⚠️ THIS IS THE ONE PLACE A USER CAN MAKE THE APP UNREADABLE. Every other colour
 * in Radiant is derived from a curated accent, so contrast is guaranteed by
 * construction and scripts/test-contrast.mjs proves it. Here the user supplies two
 * arbitrary colours, and the derivation has to stay legible across whatever they
 * choose — or say plainly that it cannot. Nothing here needs a browser: it is
 * colour arithmetic, which is exactly the kind that fails silently on someone
 * else's screen.
 */
import { derivePalette, paletteWarnings, contrastRatio, luminance } from '../src/palette.js'

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL ' + msg) } }

// ── the contrast maths itself, against known values ────────────────────────
ok(Math.abs(contrastRatio('#000000', '#FFFFFF') - 21) < 0.01, 'black on white is 21:1')
ok(Math.abs(contrastRatio('#FFFFFF', '#FFFFFF') - 1) < 0.01, 'a colour on itself is 1:1')
ok(Math.abs(contrastRatio('#767676', '#FFFFFF') - 4.54) < 0.05,
   '#767676 on white is 4.54:1 — the classic AA boundary grey')
ok(contrastRatio('#000', '#FFF') === contrastRatio('#FFF', '#000'), 'the ratio is symmetric')
ok(Math.abs(luminance('#FFFFFF') - 1) < 0.001 && luminance('#000000') === 0, 'luminance spans 0 to 1')

// ── the ramp has to know which way is up ───────────────────────────────────
const dark = derivePalette({ bg: '#141517', fg: '#F2F4F8' })
const light = derivePalette({ bg: '#FDF6E3', fg: '#3C3836' })
ok(luminance(dark['--bg-panel']) > luminance(dark['--bg']),
   'on a dark ground, panels step LIGHTER')
ok(luminance(light['--bg-panel']) < luminance(light['--bg']),
   'on a light ground, panels step DARKER — the direction flips, and getting it wrong hides every panel')
ok(luminance(dark['--bg-input']) < luminance(dark['--bg']),
   'inputs recede on dark, the opposite way from panels')
ok(luminance(light['--bg-input']) > luminance(light['--bg']), 'and recede the other way on light')

for (const [name, p] of [['dark', dark], ['light', light]]) {
  const order = ['--bg-input', '--bg', '--bg-panel', '--bg-raised', '--bg-hover'].map(k => luminance(p[k]))
  const mono = order.every((v, i) => i === 0 || (name === 'dark' ? v > order[i - 1] : v < order[i - 1]))
  ok(mono, `${name}: the surface ramp is monotonic, so raised is never below panel`)
}

// ── readability across real backgrounds, which is the whole point ──────────
const REAL = [
  ['#4F5B4C', '#FFFFFF', 'the green ground Tony sent from Codex'],
  ['#141517', '#F2F4F8', 'near-black on near-white'],
  ['#FDF6E3', '#3C3836', 'cream light mode'],
  ['#1B2430', '#D8E1EC', 'navy'],
  ['#2D353B', '#D3C6AA', 'Everforest'],
  ['#FFFFFF', '#000000', 'the extreme'],
]
for (const [bg, fg, name] of REAL) {
  const p = derivePalette({ bg, fg })
  ok(contrastRatio(bg, p['--text']) >= 4.5, `${name}: body text clears 4.5:1`)
  ok(contrastRatio(bg, p['--text-muted']) >= 4.5,
     `${name}: MUTED text clears 4.5:1 — it carries every secondary label (got ${contrastRatio(bg, p['--text-muted']).toFixed(2)})`)
  ok(contrastRatio(bg, p['--text-faint']) >= 3,
     `${name}: faint text is at least visible at 3:1`)
  ok(contrastRatio(p['--bg'], p['--bg-panel']) > 1.03, `${name}: panels are distinguishable from the page`)
}

// ── the contrast dial ──────────────────────────────────────────────────────
const flat = derivePalette({ bg: '#141517', fg: '#F2F4F8', contrast: 40 })
const loud = derivePalette({ bg: '#141517', fg: '#F2F4F8', contrast: 160 })
ok(luminance(loud['--bg-hover']) > luminance(flat['--bg-hover']),
   'raising contrast separates the surfaces further')
ok(contrastRatio('#141517', loud['--text-muted']) > contrastRatio('#141517', flat['--text-muted']),
   'and pulls muted text away from the background rather than toward it')
ok(derivePalette({ bg: '#141517', fg: '#F2F4F8', contrast: 0 })['--bg-panel'] === '#141517',
   'contrast 0 flattens the surfaces onto the background instead of producing nonsense')

// ⚠️ NEVER OUT OF RANGE. Lightness is clamped, so an extreme choice bottoms out
// rather than wrapping around to a colour nobody asked for.
for (const c of [0, 200, -50, 1000]) {
  const p = derivePalette({ bg: '#000000', fg: '#FFFFFF', contrast: c })
  ok(Object.values(p).every(v => !v.startsWith('#') || /^#[0-9a-f]{6}$/i.test(v)),
     `contrast ${c} still produces valid colours`)
}

// ── the warnings, which must fire rather than silently correcting ─────────
const bad = paletteWarnings({ bg: '#3A3A3A', fg: '#4A4A4A' })
ok(bad.warnings.length > 0, 'a grey-on-grey pair is reported, not quietly fixed')
ok(bad.ratio < 4.5 && /below the 4.5:1/.test(bad.warnings[0]),
   'and the warning names the actual ratio and the standard')
const good = paletteWarnings({ bg: '#141517', fg: '#F2F4F8' })
ok(good.warnings.length === 0, 'a sound pair produces no noise')
ok(derivePalette({ bg: '#3A3A3A', fg: '#4A4A4A' })['--text'] === '#4a4a4a',
   'a bad choice is still APPLIED — the picker warns, it does not overrule you')

console.log(`  ${pass}/${pass + fail} passed  ·  two colours you chose, still readable`)
process.exit(fail ? 1 : 0)

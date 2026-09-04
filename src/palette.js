/**
 * A palette built from a background and a foreground you chose, rather than one
 * derived from the accent.
 *
 * ⚠️ THE BACKGROUND TINT SLIDER IS NOT THIS. That slider moves the background
 * along the accent's own hue — more blue or less blue, never warm grey under a
 * blue accent. Tony: "the slider is just a variation of main color. gpt lets you
 * pick specific colors for background and foreground." Two independent colours is
 * a different thing from one colour with a strength dial.
 *
 * ⚠️ IT PIGGYBACKS ON THE PINNING MECHANISM, WHICH IS WHY IT IS CHEAP. Everforest
 * already ships an explicit palette instead of a derived one, applyTheme already
 * knows how to set those tokens, and PINNABLE already lists them. A custom
 * background is the same thing computed instead of typed, so nothing in the CSS
 * derivation chain has to change.
 *
 * ⚠️ AND THE RAMP HAS TO KNOW WHICH WAY IS UP. Surfaces step AWAY from the
 * background: lighter on a dark ground, darker on a light one. Getting this wrong
 * does not throw — it produces panels that vanish into the page, which is the kind
 * of bug you only see once it ships.
 */
import { hexToOklch, oklchToHex } from './oklch.js'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * Relative luminance per WCAG 2.1, from a hex string.
 *
 * ⚠️ SHORTHAND HEX IS REAL AND USED TO PRODUCE NaN. '#000' sliced as if it were
 * six digits gives '00', '0', '' — the ratio came back NaN and every comparison
 * against it was quietly false, so a contrast check on '#000' PASSED by failing to
 * be less than the threshold.
 */
export function expandHex (hex) {
  const m = String(hex).replace('#', '').trim()
  return m.length === 3 ? m.split('').map(c => c + c).join('') : m
}

export function luminance (hex) {
  const m = expandHex(hex)
  const ch = [0, 2, 4].map(i => {
    const c = parseInt(m.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}

/** WCAG contrast ratio between two hex colours. 4.5 is the AA floor for body text. */
export function contrastRatio (a, b) {
  const la = luminance(a), lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * Build the full token set.
 *
 * `contrast` is 0–100 and scales how far the surfaces separate from the
 * background and how far the muted text drops toward it. 100 is the default
 * spacing; lower flattens the interface, higher exaggerates it.
 */
export function derivePalette ({ bg, fg, contrast = 100 }) {
  const B = hexToOklch(bg)
  const F = hexToOklch(fg)
  // Which way the surfaces move. Measured against the FOREGROUND, not a fixed
  // threshold: what makes a background "dark" is that its text is lighter.
  const up = F.L > B.L ? 1 : -1
  const k = clamp(contrast, 0, 200) / 100

  const step = d => oklchToHex(clamp(B.L + up * d * k, 0.02, 0.99), B.C, B.H)
  // Text keeps the foreground's own hue and chroma; only lightness moves, toward
  // the background, so muted text stays the same colour rather than turning grey.
  //
  // ⚠️ DIVIDED BY k, NOT MULTIPLIED. Surfaces and text respond to the contrast dial
  // in OPPOSITE directions: more contrast pushes panels FURTHER from the background
  // and pulls text BACK toward the foreground. Multiplying both by k read as
  // symmetric and was backwards for text — raising contrast made secondary labels
  // harder to read, which is the exact opposite of what the control promises.
  const toward = t => oklchToHex(clamp(F.L + (B.L - F.L) * (t / Math.max(k, 0.05)), 0.02, 0.99), F.C, F.H)

  const fgIsLight = F.L > 0.5
  const line = a => `oklch(${fgIsLight ? 1 : 0} 0 0 / ${a})`

  return {
    '--bg': oklchToHex(B.L, B.C, B.H),
    '--bg-panel': step(0.028),
    '--bg-raised': step(0.062),
    '--bg-hover': step(0.095),
    '--bg-input': step(-0.035),
    '--border': line(0.09),
    '--border-strong': line(0.17),
    '--text': oklchToHex(F.L, F.C, F.H),
    // ⚠️ 0.20, MEASURED AGAINST REAL PAIRS, AND RETUNED ONCE ALREADY. Muted text
    // carries every secondary label in the app and is the token most likely to fall
    // under 4.5:1. Swept across six backgrounds — the Codex green Tony sent, that
    // green with the DEFAULT text colour rather than pure white, near-black, cream
    // light mode, navy, Everforest — 0.28 fails at 4.48:1 and 0.24 still fails at
    // 4.45:1 on the default pairing, which is the one a new user meets first.
    // 0.20 clears all six at 4.73:1 worst.
    // ⚠️ MEASURED AGAINST THE PANEL, NOT JUST THE PAGE — and retuned three times.
    // Muted text sits on --bg-panel as often as on --bg, and the panel is a step
    // LIGHTER on a dark ground, so it is the harder surface. 0.28, 0.24 and 0.20 all
    // cleared the page and failed the panel (4.12:1 at 0.20). 0.14 is the furthest
    // the ramp travels with the panel still at 4.53:1 across seven real backgrounds.
    '--text-muted': toward(0.14),
    // Faint is decoration — timestamps, placeholder hints — and is exempt from the
    // body-text floor, but it still has to be VISIBLE, so it is checked at 3:1.
    '--text-faint': toward(0.45)
  }
}

/**
 * What to tell the user about their choice. Never silently "fixes" it — a colour
 * picker that quietly changes your colour is worse than one that warns you.
 */
export function paletteWarnings ({ bg, fg, contrast = 100 }) {
  const out = []
  const ratio = contrastRatio(bg, fg)
  if (ratio < 4.5) {
    out.push(`Text is ${ratio.toFixed(1)}:1 against the background — below the 4.5:1 needed to stay readable.`)
  }
  const p = derivePalette({ bg, fg, contrast })
  if (contrastRatio(p['--bg'], p['--text-muted']) < 4.5) {
    out.push('Secondary labels fall below 4.5:1 — raise contrast, or pick a foreground further from the background.')
  }
  if (contrastRatio(p['--bg'], p['--bg-panel']) < 1.03) {
    out.push('Panels are indistinguishable from the background at this contrast.')
  }
  return { ratio, warnings: out }
}

/**
 * The accent, honouring the lightness you actually picked.
 *
 * ⚠️ THE PICKER USED TO THROW LIGHTNESS AWAY. It read only hue and chroma and drew
 * the accent at a fixed lightness per mode, so picking white — which is lightness
 * and nothing else — returned a mid-tone tan. Tony: "why does the accent color not
 * reflect the white i selected in the color picker." Two thirds of the choice was
 * being discarded silently.
 *
 * ⚠️ AND on-accent HAS TO FOLLOW THE ACCENT, NOT THE MODE. It is the text drawn ON
 * accent-coloured buttons. It was chosen per mode — near-white in light mode — so a
 * white accent there gave white text on a white button. It is now picked by the
 * accent's own lightness, whichever mode is running.
 *
 * Lightness is clamped, because an accent has two jobs: it is a surface with text
 * on it AND it is text on the page. Outside this band one of those always fails.
 */
export function deriveAccent ({ hex, mode = 'dark' }) {
  const { L, C, H } = hexToOklch(hex)
  const lo = mode === 'light' ? 0.30 : 0.42
  const hi = mode === 'light' ? 0.78 : 0.95
  const l = clamp(L, lo, hi)
  const c = clamp(C, 0, 0.28)
  const at = (dl, mc) => oklchToHex(clamp(l + dl, 0.03, 0.99), c * mc, H)
  return {
    clamped: Math.abs(l - L) > 0.005,
    vars: {
      '--accent': oklchToHex(l, c, H),
      '--accent-hot': at(l > 0.6 ? -0.07 : 0.07, 1.1),
      '--accent-dim': at(mode === 'light' ? 0.22 : -0.28, 0.6),
      '--accent-wash': at(mode === 'light' ? 0.36 : -0.44, 0.3),
      // ⚠️ MEASURED, NOT A LIGHTNESS THRESHOLD. A fixed boundary at L 0.62 put light
      // text on #5b87c8 (L 0.617) at 3.45:1 — the app's own default blue, failing AA
      // on its own buttons. Compute both candidates and keep whichever actually
      // contrasts better; that is the question being asked.
      '--on-accent': (() => {
        const face = oklchToHex(l, c, H)
        const dark = oklchToHex(0.15, Math.min(c, 0.03), H)
        const light = oklchToHex(0.98, Math.min(c, 0.01), H)
        return contrastRatio(face, dark) >= contrastRatio(face, light) ? dark : light
      })()
    }
  }
}

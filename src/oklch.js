/**
 * sRGB ⇄ OKLCH, and nothing else.
 *
 * ⚠️ EXTRACTED TO BREAK AN IMPORT CYCLE. These lived in theme.js. palette.js needs
 * them, and theme.js needs palette.js to apply a custom background — so the two
 * files would have imported each other. ES modules tolerate that only as long as
 * nothing runs at module load; it is a trap waiting for the first person who adds
 * a top-level constant. A leaf module both can import has no such edge.
 */
const srgbToLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const linearToSrgb = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)

export function hexToOklch (hex) {
  const m = hex.replace('#', '')
  const r = srgbToLinear(parseInt(m.slice(0, 2), 16) / 255)
  const g = srgbToLinear(parseInt(m.slice(2, 4), 16) / 255)
  const b = srgbToLinear(parseInt(m.slice(4, 6), 16) / 255)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.7936177850 * mm - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.4285922050 * mm + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * mm - 0.8086757660 * s
  let H = Math.atan2(B, A) * 180 / Math.PI
  if (H < 0) H += 360
  return { L, C: Math.sqrt(A * A + B * B), H }
}

export function oklchToHex (L, C, H) {
  const h = H * Math.PI / 180
  const A = Math.cos(h) * C
  const B = Math.sin(h) * C
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  ].map(x => Math.round(Math.max(0, Math.min(1, linearToSrgb(x))) * 255).toString(16).padStart(2, '0'))
  return '#' + rgb.join('')
}

/**
 * Will this model actually run on THIS iPhone?
 *
 * The Mac app has answered this for years, in Settings → Models: every row
 * carries "runs well" / "tight fit" / "too big" measured against the Mac's
 * unified memory, and the Download button is disabled on the ones that cannot
 * work. The phone had nothing — it listed sizes and let you find out the hard
 * way, which on iOS means the app disappearing mid-load.
 *
 * The thresholds here are deliberately the SAME ONES as the Mac's
 * (Settings.jsx `fitClass`), so the two apps never disagree about a model that
 * would run on both. What differs is the budget they are measured against.
 *
 * ⚠️ THE BUDGET IS NOT THE PHONE'S RAM. iOS never gives one app the whole
 * device; it kills a process that crosses a per-app limit well below the spec
 * sheet — on a 12 GB iPhone an app may get roughly half. Planning against
 * `physicalMemory` would promise loads that jetsam ends, and a jetsam kill does
 * not look like a memory limit to the user, it looks like Radiant crashing. The
 * native side reports `os_proc_available_memory()` instead: the bytes this
 * process may still allocate. It is a live number, so fit is computed when the
 * list is drawn rather than baked into the catalogue.
 */

/**
 * Memory a model needs while running, from its download size.
 *
 * ⚠️ THIS IS NOT THE MAC'S FORMULA, AND COPYING IT WAS A BUG. The Mac uses
 * `size * 1.15 + 1.5`, and neither term transfers:
 *
 *  · the 1.15 exists because the Mac downloads GGUF and Ollama expands it. MLX
 *    maps quantized safetensors straight into this process — the weights ARE
 *    the download, so the multiplier is ~1, not 1.15;
 *  · the 1.5 GB covers Ollama's separate server process, which does not exist
 *    on a phone.
 *
 * Carrying both over made every model look ~0.4 GB heavier than it is, which
 * is how Ministral 3 3B — 2.78 GB of weights, and demonstrably runnable on an
 * iPhone 17 Pro Max — was reported as too big for a 3.54 GB ceiling.
 *
 * What actually sits alongside the weights is the KV cache, which grows with
 * the conversation, plus activations and MLX's own working set. For a 3B model
 * at a few thousand tokens that is a few hundred megabytes, so: the weights,
 * a small allowance that scales, and a fixed floor.
 *
 * It remains an ESTIMATE. It is deliberately not used to forbid anything — see
 * the note on FITS_NO.
 */
export const ramNeededGB = (downloadGB) => downloadGB * 1.05 + 0.35

// ⚠️ The words, the tones and the thresholds come from ../fit.js and are shared
// with the Mac app. Do not redefine them here; that is how they drifted before.
export { FITS_WELL, FITS_TIGHT, FITS_NO, FIT_LABEL, FIT_TONE } from '../fit.js'
import { verdict, FITS_WELL, FITS_TIGHT, FITS_NO } from '../fit.js'
import { deviceWord } from './device.js'

/**
 * Runs well / runs tight / won't run, for a model of this download size on a
 * machine with this many bytes to spare. The thresholds are in ../fit.js and
 * are the same ones the Mac applies.
 */
export function fitOf (downloadGB, budgetBytes) {
  if (!budgetBytes || !downloadGB) return null
  return verdict(ramNeededGB(downloadGB), budgetBytes / 1e9)
}

/**
 * ⚠️ FITS_NO IS ADVICE, NOT A LOCK. It used to disable the Download button, and
 * that was wrong twice over: downloading is a DISK operation and has nothing to
 * do with memory, and the verdict behind it is an estimate. Tony: "why can i
 * install ministral on Locally but not with Radiant?" — because Radiant was
 * refusing on a guess where every other app on the phone simply lets you
 * install and find out. Disk space still blocks a download, because that one is
 * measured and certain.
 */

/** The explanation under a row, when someone wants to know why. */
export const FIT_WHY = {
  [FITS_WELL]: `Comfortable on this ${deviceWord()}.`,
  [FITS_TIGHT]: 'Fits, but close to the limit — expect it to be slow, and to reload if you switch apps.',
  [FITS_NO]: `Needs more memory than this ${deviceWord()} can give one app.`
}

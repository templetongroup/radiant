/**
 * Turning a stream of speech results into the text in the message box.
 *
 * ⚠️ A RECOGNITION RESULT IS THE WHOLE UTTERANCE SO FAR, NOT THE NEW WORDS.
 * SFSpeechRecognizer sends "hello", then "hello there", then "hello there world".
 * Appending those spells "hello hello there hello there world". Every one of these
 * cases is a way that has actually gone wrong in shipped dictation somewhere, and
 * none of them needs a microphone to test — so none of them is allowed to live in
 * a component, behind a permission prompt, where the only way to check is to talk
 * to a laptop and squint.
 *
 * The shape: `base` is whatever you had typed before dictating (never touched),
 * `committed` is utterances the recognizer has finished with, `current` is the
 * one still being revised.
 */

export function emptyDictation (base = '') {
  return { base, committed: '', current: '' }
}

export function applyDictationEvent (state, ev) {
  if (!ev || !ev.type) return state
  if (ev.type === 'partial') return { ...state, current: ev.text || '' }
  if (ev.type === 'final') {
    const done = (ev.text || '').trim()
    if (!done) return { ...state, current: '' }
    return { ...state, committed: state.committed ? state.committed + ' ' + done : done, current: '' }
  }
  // ready / stopped / error change no text. A partial that never became final is
  // still a thing you said out loud, so stopping keeps it.
  return state
}

/** What the message box should show for this state. */
export function dictationText ({ base = '', committed = '', current = '' }) {
  const spoken = [committed, current].filter(Boolean).join(' ').trim()
  if (!spoken) return base
  if (!base) return spoken
  return /\s$/.test(base) ? base + spoken : base + ' ' + spoken
}

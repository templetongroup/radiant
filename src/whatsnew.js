/**
 * What changed, shown once, on the version it changed in.
 *
 * ⚠️ RADIANT UPDATES ITSELF, WHICH MEANS FEATURES ARRIVE WITH NO ANNOUNCEMENT AT
 * ALL. The app downloads a release in the background and installs it on quit, so
 * the next launch is simply a different program — dictation, a browser extension
 * and a rewritten status badge all appeared this way in one afternoon and the only
 * place that said so was a Read me nobody opens unprompted. Tony: "there should be
 * a splash screen after an update with new features so users are aware what's new."
 *
 * ⚠️ THIS IS A SECOND LIST THAT CAN DRIFT FROM THE CODE, exactly like the Read me,
 * so it is checked the same way: scripts/test-whatsnew.mjs fails when the version in
 * package.json has no entry here. A release that adds a feature and forgets to say
 * so does not build.
 *
 * Newest first. Keep each item to a sentence someone would actually read while
 * waiting to get on with their work — the Read me is where the detail lives.
 */
export const WHATS_NEW = [
  {
    version: '0.6.232',
    items: [
      ['Pick your own background and text color', 'Settings › Appearance. Two color wells, independent of the accent — a warm grey page under a blue accent is now possible. It warns you if a pairing would be hard to read, and still applies it.']
    ]
  },
  {
    version: '0.6.231',
    items: [
      ['Radiant says what is new', 'After it updates itself, the first launch shows a short list of what changed — once, and never on a fresh install.'],
      ['Updating shows real progress', 'The progress bar was being sent to a different window than the one you were watching, so it sat at 0% and looked frozen.']
    ]
  },
  {
    version: '0.6.227',
    items: [
      ['The agent can work in your own Chrome', 'A small extension, installed once from Settings › Automation. The agent can then see your open tabs, read and photograph the page you are on, click things by name and fill in fields — signed in as you.']
    ]
  },
  {
    version: '0.6.225',
    items: [
      ['You can tell working from stuck', 'The badge beside the agent’s name says what it is doing and for how long, and turns red if nothing has happened for 25 seconds.'],
      ['A turn that ends with nothing says so', 'Instead of leaving blank space that looked like Radiant had lost your message.']
    ]
  },
  {
    version: '0.6.223',
    items: [
      ['Dictate instead of typing', 'A Dictate button under the message box. It uses your Mac’s own speech recognition and never sends audio anywhere.']
    ]
  },
  {
    version: '0.6.221',
    items: [
      ['Follow-ups go to the chat you typed them in', 'Typing while an agent worked and then switching chats used to deliver the message to the wrong conversation.'],
      ['Turns say why they stopped', 'A turn that hit its limit of 30 rounds of tool use said so, then erased it. That note now stays.']
    ]
  }
]

/**
 * Which entries to show, given what this device last saw.
 *
 * ⚠️ A FRESH INSTALL MUST SHOW NOTHING. Greeting somebody who has never used
 * Radiant with four releases of changes to features they have not met is worse than
 * silence — so no record of a previous version means "remember this one and say
 * nothing".
 *
 * ⚠️ AND IT IS EVERYTHING SINCE, NOT JUST THE NEWEST. Updates install on quit and
 * several can pass while a laptop is shut, so jumping 0.6.221 → 0.6.227 must show
 * all four, not only the last one.
 */
export function whatsNewSince (seen, current, entries = WHATS_NEW) {
  if (!current) return []
  if (!seen) return []                          // first run on this device
  if (cmpVersion(seen, current) >= 0) return [] // same version, or an older build
  return entries.filter(e =>
    cmpVersion(e.version, seen) > 0 && cmpVersion(e.version, current) <= 0)
}

/** Compares 1.2.3-style versions numerically: 0.6.9 is older than 0.6.10. */
export function cmpVersion (a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

import { listSkills, getSkill, slashMatches as matchSlash, parseSlash } from './skills.js'
import { sendApple, stopApple } from './appleModel.js'
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Gauge from './Gauge.jsx'
import * as haptics from './haptics.js'
import BrandSpinner, { BrandMark } from './BrandSpinner.jsx'
import { loadChosen, providerById } from './providers.js'

// The conversation, running on this phone.
//
// Everything here is built to the plugin we actually have, not the one we wish
// we had (apps/ios/ios/App/App/plugins/LocalModels.swift):
//
//   · generate({ id, prompt }) builds a FRESH ChatSession every call, so the
//     native side has no memory of the conversation. The transcript is
//     serialized into `prompt` on every send — see buildPrompt.
//   · `token` events carry incremental chunks. Append, never replace.
//   · stop() cancels the Swift Task and the plugin may then emit either `done`
//     or `failed`. Whichever lands first is terminal, and a `failed` that lands
//     just after a user-initiated stop is a cancel, not an error.
//   · loading a model evicts the previous one, so the first send after a model
//     switch has real dead air. The gauge shows it rather than pretending.
//
// Gauge is the app's only loading indicator — there is no spinner anywhere in
// here. Every haptics call is optional-chained: the wrapper no-ops when the
// plugin is absent, and this screen must still run in a plain browser.

// ─────────────────────────────────────────────────────────────────────────────
// prompt serialization

const PROMPT_TURNS = 6
const PROMPT_CHARS = 4000

// The native side has no conversation memory, so multi-turn is a string we
// rebuild on every send. Last six turns, hard-capped, ending on the bare
// "Assistant:" the model is meant to complete.
export function buildPrompt (messages, next, skill) {
  // ⚠️ A SKILL COSTS PROMPT BUDGET AND MUST BE PAID FOR, NOT ADDED ON TOP.
  // PROMPT_CHARS is the whole budget the phone has; appending instructions
  // without reserving room for them would push the cap over silently and the
  // conversation would be trimmed to pay for it. The skill is reserved first,
  // the transcript gets what is left, and the instructions sit at the front
  // where a small model is most likely to still be following them.
  const head = skill?.body ? `Instructions: ${String(skill.body).trim()}\n\n` : ''
  const budget = PROMPT_CHARS - head.length
  const turns = [...messages, { role: 'user', text: next }].slice(-PROMPT_TURNS)
  // A window that opens on a reply reads as a fragment; open on the question
  // that prompted it, or on nothing.
  while (turns.length > 1 && turns[0].role === 'assistant') turns.shift()
  const blocks = turns.map(m => (m.role === 'user' ? 'User: ' : 'Assistant: ') + m.text)
  const tail = '\n\nAssistant:'
  const fits = () => blocks.join('\n\n').length + tail.length <= budget
  while (blocks.length > 1 && !fits()) blocks.shift()
  // One turn on its own can still blow the cap. Keep its END: the question the
  // user just asked matters more than how the paragraph started.
  if (!fits()) blocks[0] = blocks[0].slice(-(budget - tail.length))
  return head + blocks.join('\n\n') + tail
}

// ─────────────────────────────────────────────────────────────────────────────
// code fences
//
// Split committed assistant text into prose and code. Deliberately not
// highlight.js: its stylesheet is not loaded on the phone and syntax color
// would break the one-tint rule. Code is one weight in --rx-label.
function segments (text) {
  const out = []
  const re = /```[^\n]*\n?([\s\S]*?)(?:```|$)/g
  let at = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > at) out.push({ type: 'text', text: text.slice(at, m.index) })
    out.push({ type: 'code', text: m[1].replace(/\n$/, '') })
    at = re.lastIndex
  }
  if (at < text.length) out.push({ type: 'text', text: text.slice(at) })
  return out.filter(s => s.text.trim().length)
}

/**
 * The inline markdown a model actually emits, rendered.
 *
 * ⚠️ IT WAS SHOWING THE ASTERISKS. Tony's own App Store screenshot has
 * "1. **Time**: How much time do you have" in it — literal stars, because
 * segments() only ever handled ``` fences and everything else fell through as
 * plain text. Bold is the single most common thing a model emits, and every
 * reply that used it looked unfinished.
 *
 * ⚠️ NEVER dangerouslySetInnerHTML HERE. This text comes from a language model,
 * which means it is untrusted input that can contain anything — a model can be
 * talked into emitting a <script> tag or an onerror attribute. React elements
 * are built instead, so nothing it produces can ever become markup.
 *
 * Deliberately small: bold, italic, inline code. Headings and lists already read
 * correctly as plain text on a phone, and a full markdown engine is weight this
 * screen does not need.
 */
const INLINE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_)/g

function inline (text, keyBase) {
  const parts = String(text).split(INLINE)
  return parts.map((part, i) => {
    if (!part) return null
    const k = `${keyBase}-${i}`
    if (/^\*\*[^*\n]+\*\*$/.test(part) || /^__[^_\n]+__$/.test(part)) {
      return <strong key={k}>{part.slice(2, -2)}</strong>
    }
    if (/^`[^`\n]+`$/.test(part)) {
      return <code className='rx-chat-inlinecode' key={k}>{part.slice(1, -1)}</code>
    }
    if (/^\*[^*\n]+\*$/.test(part) || /^_[^_\n]+_$/.test(part)) {
      return <em key={k}>{part.slice(1, -1)}</em>
    }
    return part
  })
}

/** A text block, line by line, so headings and list markers keep their shape. */
function richText (text, keyBase) {
  return String(text).split('\n').map((line, i) => {
    // "### Heading" reads as a heading without a heading element: the marker is
    // noise, the emphasis is the point.
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/)
    const body = h ? <strong>{inline(h[2], `${keyBase}-h${i}`)}</strong> : inline(line, `${keyBase}-l${i}`)
    return <span key={`${keyBase}-r${i}`}>{body}{'\n'}</span>
  })
}

async function copyText (s) {
  try {
    await navigator.clipboard.writeText(s)
    return true
  } catch {
    // WKWebView can refuse the async clipboard when the gesture is not
    // recognized as a user activation; the old path still works there.
    const ta = document.createElement('textarea')
    ta.value = s
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

const plugins = () => (typeof window !== 'undefined' && window.Capacitor?.Plugins) || {}

// addListener resolves to a handle in Capacitor 7 but returned one directly in
// older bridges. Accept both so removal never throws on unmount.
function listen (plugin, event, fn) {
  if (!plugin?.addListener) return () => {}
  const h = plugin.addListener(event, fn)
  return () => { Promise.resolve(h).then(x => x?.remove?.()).catch(() => {}) }
}

// ─────────────────────────────────────────────────────────────────────────────
// press
//
// iOS has two press behaviors and mixing them is a tell: rows light instantly
// and never scale, prominent controls scale and never light. Both are driven
// from JS with a 10pt slop cancel — :active alone cannot cancel on a drag, and
// there is not one :hover rule in this file.
function usePress (onPress, { haptic = null } = {}) {
  const [pressed, setPressed] = useState(false)
  const from = useRef(null)
  const touched = useRef(false)
  const fire = () => {
    if (haptic === 'selection') haptics.selection?.()
    else if (haptic) haptics.impact?.(haptic)
    onPress?.()
  }
  return {
    pressed,
    handlers: {
      onTouchStart: e => {
        touched.current = true
        const t = e.touches[0]
        from.current = { x: t.clientX, y: t.clientY }
        setPressed(true)
      },
      onTouchMove: e => {
        if (!from.current) return
        const t = e.touches[0]
        if (Math.hypot(t.clientX - from.current.x, t.clientY - from.current.y) > 10) {
          from.current = null
          setPressed(false)
        }
      },
      onTouchEnd: e => {
        setPressed(false)
        if (!from.current) return
        from.current = null
        // Commit on touchend inside the bounds, never on touchdown: a tap you
        // can still slide out of is what makes iOS feel forgiving.
        e.preventDefault()
        fire()
      },
      onTouchCancel: () => { from.current = null; setPressed(false) },
      // Only for a desktop browser during development; on device the touch
      // path above has already fired and swallowed the click.
      onClick: () => { if (!touched.current) fire() }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// glyphs — SF Symbols geometry, stroked at the weights iOS uses

const Chevron = () => (
  <svg width='12' height='20' viewBox='0 0 12 20' fill='none' aria-hidden='true'>
    <path d='M10 2L2.5 10L10 18' stroke='currentColor' strokeWidth='2.4' strokeLinecap='round' strokeLinejoin='round' />
  </svg>
)
const Ellipsis = () => (
  <svg width='24' height='24' viewBox='0 0 24 24' fill='none' aria-hidden='true'>
    <circle cx='12' cy='12' r='10.1' stroke='currentColor' strokeWidth='1.8' />
    <circle cx='7.4' cy='12' r='1.35' fill='currentColor' />
    <circle cx='12' cy='12' r='1.35' fill='currentColor' />
    <circle cx='16.6' cy='12' r='1.35' fill='currentColor' />
  </svg>
)
const ArrowUp = () => (
  <svg width='16' height='16' viewBox='0 0 16 16' fill='none' aria-hidden='true'>
    <path d='M8 13.5V3.2M8 2.6L2.9 7.9M8 2.6L13.1 7.9' stroke='currentColor' strokeWidth='2.1' strokeLinecap='round' strokeLinejoin='round' />
  </svg>
)
const StopSquare = () => (
  <svg width='12' height='12' viewBox='0 0 12 12' aria-hidden='true'>
    <rect x='0' y='0' width='12' height='12' rx='2.2' fill='currentColor' />
  </svg>
)
const NewChatGlyph = () => (
  <svg width='18' height='18' viewBox='0 0 18 18' fill='none' aria-hidden='true'>
    <path d='M15.2 8.6V14a1.8 1.8 0 0 1-1.8 1.8H4A1.8 1.8 0 0 1 2.2 14V4.6A1.8 1.8 0 0 1 4 2.8h5.3' stroke='currentColor' strokeWidth='1.5' strokeLinecap='round' />
    <path d='M12.6 2.2l3.2 3.2-5.6 5.6-3.8.6.6-3.8 5.6-5.6z' stroke='currentColor' strokeWidth='1.5' strokeLinejoin='round' />
  </svg>
)
const TickGlyph = () => (
  <svg viewBox='0 0 16 16' width='16' height='16' aria-hidden='true'>
    <path d='M3.5 8.5l3 3 6-7' fill='none' stroke='currentColor' strokeWidth='1.8'
          strokeLinecap='round' strokeLinejoin='round' />
  </svg>
)

const InfoGlyph = () => (
  <svg width='18' height='18' viewBox='0 0 18 18' fill='none' aria-hidden='true'>
    <circle cx='9' cy='9' r='7.4' stroke='currentColor' strokeWidth='1.5' />
    <path d='M9 8v4.6' stroke='currentColor' strokeWidth='1.7' strokeLinecap='round' />
    <circle cx='9' cy='5.4' r='1' fill='currentColor' />
  </svg>
)
const TrashGlyph = () => (
  <svg width='18' height='18' viewBox='0 0 18 18' fill='none' aria-hidden='true'>
    <path d='M3.4 4.6h11.2M7.4 4.6V3.2h3.2v1.4M4.8 4.6l.7 9.7a1.4 1.4 0 0 0 1.4 1.3h4.2a1.4 1.4 0 0 0 1.4-1.3l.7-9.7' stroke='currentColor' strokeWidth='1.5' strokeLinecap='round' strokeLinejoin='round' />
  </svg>
)

// ─────────────────────────────────────────────────────────────────────────────
// pieces

function CodeBlock ({ code }) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    copyText(code).then(ok => {
      if (!ok) return
      haptics.selection?.()
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }, [code])
  const { pressed, handlers } = usePress(copy)
  return (
    <div className='rx-chat-codewell'>
      <button className={'rx-chat-copy' + (pressed ? ' is-pressed' : '')} {...handlers}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      {/* overflow is contained here so a wide line scrolls the block, never the page */}
      <pre className='rx-chat-code'><code>{code}</code></pre>
    </div>
  )
}

// Left-aligned plain text on the page background, not a bubble. Two facing
// columns of bubbles is the generic-AI-chat cliché; a document reads like the
// model wrote something rather than like a wrapper sent a message.
function AssistantTurn ({ model, children, marker }) {
  return (
    <div className='rx-chat-turn rx-chat-turn-model'>
      <div className='rx-chat-byline'>
        <span className='rx-chat-marker'><BrandSpinner size={22} /></span>
        <span className='rx-chat-byname'>{model?.name || 'No model'}</span>
      </div>
      {children}
    </div>
  )
}

// No haptic of its own — tapping one sends, and send already fires the light
// impact. Two taps for one action is exactly the chatty profile to avoid.
function Suggestion ({ text, onPick }) {
  const { pressed, handlers } = usePress(() => onPick(text))
  return (
    <button className={'rx-chat-suggestion' + (pressed ? ' is-pressed' : '')} {...handlers}>{text}</button>
  )
}

/** One row in the slash list. usePress so it reacts on touch, like MenuRow. */
function SlashRow ({ cmd, name, onPick }) {
  const { pressed, handlers } = usePress(onPick, { haptic: 'LIGHT' })
  return (
    <div className={'rx-chat-slashrow' + (pressed ? ' is-pressed' : '')} role='option' {...handlers}>
      <span className='rx-chat-slashcmd'>{cmd}</span>
      <span className='rx-chat-slashname'>{name}</span>
    </div>
  )
}

function MenuRow ({ label, glyph, destructive, onPick }) {
  const { pressed, handlers } = usePress(onPick, { haptic: 'LIGHT' })
  return (
    <button
      className={'rx-chat-menurow' + (destructive ? ' is-destructive' : '') + (pressed ? ' is-pressed' : '')}
      role='menuitem'
      {...handlers}
    >
      <span>{label}</span>
      {glyph}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export default function MobileChat ({
  model,
  onBack,
  onModelInfo,
  downloadedModels = [],
  onSwitchModel,
  initialMessages = [],
  onMessagesChange,
  onDeleteConversation, skillId = null, onSkillChange, onManageSkills}) {
  const [messages, setMessages] = useState(initialMessages)
  const [draft, setDraft] = useState('')
  const [live, setLive] = useState(null) // { marker, error } for the turn being generated
  const [scrolled, setScrolled] = useState(false)
  const [showJump, setShowJump] = useState(false)
  const [menu, setMenu] = useState(false)
  const [pickModel, setPickModel] = useState(false)
  const [pickSkill, setPickSkill] = useState(false)
  const skill = getSkill(skillId)

  /**
   * Slash commands, same convention as the Mac and as Hermes and Claude Code:
   * type `/`, pick from the list, the COMMAND goes in the box, and it resolves
   * when you send.
   *
   * ⚠️ THIS IS NOT THE SKILL BUTTON. The button beside the composer sets a
   * skill for the whole conversation; a slash applies one to a single message
   * and leaves the conversation alone. Both exist because both are useful, and
   * the phone shipped with only the first — which is why `/plain-english` did
   * nothing here while it worked on the Mac. The parsing lives in skills.js so
   * it can be tested without a phone.
   */
  const slashList = matchSlash(draft).slice(0, 6)
  const [rate, setRate] = useState(null) // tok/s, or null when we cannot say honestly

  const rootRef = useRef(null)
  const navRef = useRef(null)
  const scrollRef = useRef(null)
  const sentinelRef = useRef(null)
  const composerRef = useRef(null)
  const skillbarRef = useRef(null)
  const taRef = useRef(null)
  const liveNode = useRef(null)
  const bufRef = useRef('')
  const run = useRef(null)
  const follow = useRef(true)
  const multiline = useRef(false)
  const [navH, setNavH] = useState(0)

  const generating = live !== null && !live.error
  const modelRef = useRef(model)
  modelRef.current = model

  // Report the transcript up, but only when it actually changed: the parent
  // may hand us a fresh callback on every render and this must not loop.
  const reported = useRef(initialMessages)
  useEffect(() => {
    if (reported.current === messages) return
    reported.current = messages
    onMessagesChange?.(messages)
  }, [messages, onMessagesChange])

  // ── scrolling ─────────────────────────────────────────────────────────────
  // ⚠️ AUTOSCROLL MUST NOT OUTVOTE THE FINGER. stick() moves the scroller,
  // which fires onScroll, which measures "am I near the bottom" — and because
  // stick() just put us there, the answer is yes, so follow stays on. During a
  // fast stream that loop re-arms every frame: the user scrolls up, the next
  // token yanks them back, and the screen reads as frozen. Tony: "i cant scroll
  // up to read it... screen is frozen."
  //
  // The flag tells onScroll to ignore scrolls WE caused, so only the user's own
  // scrolling decides whether to keep following.
  // ⚠️ MY FIRST FIX FOR THIS WAS ALSO WRONG, and the runtime gauntlet caught it.
  // Ignoring scroll events for two frames after a stick() meant a REAL scroll
  // landing in that window was thrown away too — so during a fast stream the
  // user could still be dragged back. A time window cannot tell who scrolled.
  //
  // Intent is observable, so observe it: a finger or a wheel on the transcript
  // means the user is driving, and from then on only their position decides
  // whether to keep following.
  const userDriving = useRef(false)
  const stick = useCallback((smooth = false) => {
    const el = scrollRef.current
    if (!el || userDriving.current) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  // ── layout metrics ────────────────────────────────────────────────────────
  // The bars overlay the scroller so content tints the material as it passes
  // under. Their real heights (which move with Dynamic Type) become the
  // scroller's padding.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const n = navRef.current?.offsetHeight || 0
      const c = composerRef.current?.offsetHeight || 0
      // The skill bar rides above the composer, so it is chrome too — its
      // height has to reach the scroller's padding or the last message sits
      // underneath it.
      const b = skillbarRef.current?.offsetHeight || 0
      root.style.setProperty('--rx-chat-navh', n + 'px')
      root.style.setProperty('--rx-chat-composerh', c + 'px')
      root.style.setProperty('--rx-chat-barh', b + 'px')
      setNavH(n)
    }
    const ro = new ResizeObserver(measure)
    if (navRef.current) ro.observe(navRef.current)
    if (composerRef.current) ro.observe(composerRef.current)
    if (skillbarRef.current) ro.observe(skillbarRef.current)
    measure()
    return () => ro.disconnect()
  }, [])

  // ── the nav hairline ──────────────────────────────────────────────────────
  // It exists only once content is actually under the bar. A permanently
  // bordered header is the single most common webview tell.
  useEffect(() => {
    const el = sentinelRef.current
    const rootEl = scrollRef.current
    if (!el || !rootEl || !navH) return
    const io = new IntersectionObserver(
      ([e]) => setScrolled(!e.isIntersecting),
      { root: rootEl, rootMargin: `-${navH + 1}px 0px 0px 0px`, threshold: 0 }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [navH])

  // ── the keyboard ──────────────────────────────────────────────────────────
  // Keyboard plugin resize is 'none', so the webview never changes size and the
  // composer rides visualViewport instead. Heights are dvh; a 100vh layout puts
  // the composer behind the keyboard and ends the illusion on the first tap.
  useEffect(() => {
    const root = rootRef.current
    const vv = window.visualViewport
    if (!root || !vv) return
    const update = () => {
      const kb = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop))
      root.style.setProperty('--rx-kb', kb + 'px')
      if (follow.current) stick()
    }
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    update()
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])

  useEffect(() => {
    const root = rootRef.current
    const kb = plugins().Keyboard
    if (!root || !kb) return
    // Use the keyboard's OWN duration for this one transition. Guessing 250ms is
    // visible; iOS reports seconds on some versions and milliseconds on others.
    const dur = e => {
      const raw = Number(e?.duration)
      if (!raw || Number.isNaN(raw)) return 250
      return raw < 10 ? Math.round(raw * 1000) : Math.round(raw)
    }
    const offShow = listen(kb, 'keyboardWillShow', e => {
      root.style.setProperty('--rx-kb-dur', dur(e) + 'ms')
      // Move with the keyboard rather than after it: visualViewport only
      // reports the final height, and often only once the animation ends.
      if (e?.keyboardHeight) root.style.setProperty('--rx-kb', e.keyboardHeight + 'px')
      if (follow.current) stick()
    })
    const offHide = listen(kb, 'keyboardWillHide', e => {
      root.style.setProperty('--rx-kb-dur', dur(e) + 'ms')
      root.style.setProperty('--rx-kb', '0px')
    })
    return () => { offShow(); offHide() }
  }, [])

  // Resuming a conversation lands at the bottom, where you left it — not at the
  // top of a transcript you have already read.
  useLayoutEffect(() => { stick() }, [stick])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // 40pt of slack: auto-follow while you are effectively at the bottom, and
    // stop the instant you scroll up. Yanking someone back down mid-read is the
    // most-hated behavior in every chat app ever shipped.
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    follow.current = near
    // Back at the bottom by their own hand: hand control back to autoscroll.
    if (near) userDriving.current = false
    setShowJump(prev => (near ? false : prev || Boolean(run.current)))
  }, [])

  // Drag down over the transcript dismisses the keyboard. A webview cannot
  // track the system keyboard 1:1 with the finger, so this commits to the
  // dismissal on a clear downward drag and lets iOS animate it.
  // ⚠️ THIS WAS THE SAME GESTURE AS SCROLLING UP. Reading back through the
  // transcript means dragging your finger DOWN, and this dismissed the keyboard
  // after 16px of exactly that — so the one thing you do to read history fought
  // the one thing that closes the keyboard.
  //
  // It now only fires when the transcript CANNOT scroll any further up, which
  // is the moment a downward drag has no other meaning. Same idea as UIKit's
  // interactive dismissal, and 48px so a stray flick does not trigger it.
  const dragStart = useRef(0)
  const onTranscriptTouchStart = e => {
    dragStart.current = e.touches[0].clientY
    userDriving.current = true   // a finger on the transcript outranks autoscroll
  }
  const onTranscriptTouchMove = e => {
    if (document.activeElement !== taRef.current) return
    const el = scrollRef.current
    if (el && el.scrollTop > 0) return          // still scrollable — this is a scroll
    if (e.touches[0].clientY - dragStart.current > 48) taRef.current.blur()
  }

  // ── the composer ──────────────────────────────────────────────────────────
  const grow = useCallback(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    const cs = getComputedStyle(el)
    const lh = parseFloat(cs.lineHeight) || 22
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    const max = lh * 6 + pad // six lines, then it scrolls internally
    const next = Math.min(el.scrollHeight, max)
    el.style.height = next + 'px'
    el.style.overflowY = el.scrollHeight > max + 1 ? 'auto' : 'hidden'
    const multi = next > lh + pad + 1
    if (multi !== multiline.current) {
      multiline.current = multi
      haptics.selection?.()
    }
  }, [])

  useLayoutEffect(grow, [draft, grow])

  // ── generation ────────────────────────────────────────────────────────────
  useEffect(() => {
    const lm = plugins().LocalModels
    if (!lm) return

    const finish = (text, error) => {
      const r = run.current
      if (!r || r.done) return
      r.done = true
      run.current = null
      setLive(null)
      setRate(null)
      setMessages(prev => [...prev, { id: r.turnId, role: 'assistant', text, error }])
      if (follow.current) requestAnimationFrame(() => stick())
    }

    const onToken = e => {
      const r = run.current
      if (!r || r.done) return
      const chunk = e?.text
      if (!chunk) return
      bufRef.current += chunk
      r.chunks += 1
      if (!r.firstAt) {
        r.firstAt = performance.now()
        setLive(l => (l ? { ...l, marker: 'generating' } : l))
      }
      // One text node, appended in place. A span per token drops a ProMotion
      // phone off 120Hz inside a hundred tokens, and per-token fades jitter.
      const node = liveNode.current?.firstChild
      if (node) node.appendData(chunk)
      // tok/s only if a chunk really is a token. If the stream turns out to be
      // chunked by sentence, print nothing rather than a wrong number.
      const secs = (performance.now() - r.firstAt) / 1000
      if (r.chunks >= 8 && secs > 0.5 && bufRef.current.length / r.chunks <= 12) {
        setRate(Math.round(r.chunks / secs))
      }
      if (follow.current) {
        if (!r.raf) {
          r.raf = requestAnimationFrame(() => { r.raf = 0; if (follow.current) stick() })
        }
      }
    }

    const onDone = () => finish(bufRef.current.trim(), null)

    const onFailed = e => {
      const r = run.current
      if (!r || r.done) return
      // A deliberate cancel comes back as a cancelled Task and must never
      // surface as an error. Any terminal event after a stop belongs to that
      // stop — the run is over by the user's choice and run.current is cleared
      // on the first one, so there is no later real failure to miss. Deliberately
      // not a wall-clock window: a busy bridge can easily miss 400ms, and the
      // whole point of the rule is that a cancel never turns red.
      if (r.stoppedAt) return finish(bufRef.current.trim(), null)
      haptics.notification?.('ERROR')
      finish(bufRef.current.trim(), e?.message || 'Generation failed.')
    }

    // Both sources, one set of handlers — the transcript does not care whether
    // the text came from the model on this phone or from a provider.
    const pc = plugins().ProviderChat
    const am = plugins().AppleModel
    const offs = [
      listen(lm, 'token', onToken),
      listen(lm, 'done', onDone),
      listen(lm, 'failed', onFailed),
      listen(pc, 'cloudToken', onToken),
      listen(pc, 'cloudDone', onDone),
      listen(pc, 'cloudFailed', onFailed),
      // Apple's framework streams the whole answer so far each time; the plugin
      // sends only the new part, so from here it is the same shape as the rest.
      listen(am, 'appleToken', onToken),
      listen(am, 'appleDone', onDone),
      listen(am, 'appleFailed', onFailed)
    ]

    return () => offs.forEach(off => off())
  }, [stick])

  const send = useCallback(text => {
    let body = (text ?? draft).trim()
    if (!body || run.current || !model) return
    const lm = plugins().LocalModels
    if (!lm) return

    // ⚠️ RESOLVE THE COMMAND AT SEND, NOT AT PICK — same as the Mac. The `/slug`
    // is stripped from what the model reads, because the skill's instructions
    // reach it properly at the head of the prompt rather than as a bare word.
    // A slash beats the conversation's sticky skill for this one message only.
    const parsed = parseSlash(body)
    const turnSkill = parsed.skill
    body = parsed.text

    haptics.impact?.('LIGHT')
    const prompt = buildPrompt(messages, body, turnSkill || skill)
    const stamp = Date.now()
    setMessages(prev => [...prev, { id: 'u' + stamp, role: 'user', text: body }])
    setDraft('')
    multiline.current = false
    bufRef.current = ''
    run.current = { turnId: 'a' + stamp, chunks: 0, firstAt: 0, stoppedAt: 0, done: false, raf: 0 }
    // Rest coverage until the wait is real: the gauge animates only for
    // operations longer than 400ms, so dead air below that shows nothing.
    setLive({ marker: 'resident', error: null })
    setTimeout(() => {
      setLive(l => (l && l.marker === 'resident' ? { ...l, marker: 'working' } : l))
    }, 400)
    follow.current = true
    setShowJump(false)
    requestAnimationFrame(() => stick())

    // A chosen cloud model wins over the on-device one. The request is made
    // NATIVELY — see ProviderChat.swift — so the API key never enters this web
    // layer; from here the two paths are identical, because the cloud plugin
    // emits the same token / done / failed shape LocalModels does.
    const cloud = loadChosen()
    const pc = typeof window !== 'undefined' ? window.Capacitor?.Plugins?.ProviderChat : null
    if (cloud && pc?.send) {
      const provider = providerById(cloud.providerId)
      if (provider) {
        pc.send({
          provider: provider.id,
          baseUrl: provider.baseUrl,
          model: cloud.model,
          // the transcript, not a flattened prompt: a cloud model has real
          // multi-turn memory and flattening it away would throw that out
          messages: [
            ...messages.slice(-12).map(m => ({
              role: m.role === 'user' ? 'user' : 'assistant',
              content: m.text
            })),
            { role: 'user', content: body }
          ]
        }).catch(() => { /* cloudFailed carries the message */ })
        return
      }
    }

    // ⚠️ APPLE'S MODEL IS NOT ONE OF LocalModels' WEIGHTS. Handing its id to
    // lm.generate would look for a download that does not exist and fail with a
    // message about missing weights.
    if (model?.apple) {
      sendApple({ prompt, instructions: (turnSkill || skill)?.body || '' })
        .catch(() => { /* appleFailed carries the message */ })
      return
    }

    lm.generate({ id: model.id, prompt }).catch(() => {
      // The rejection and the `failed` event describe the same failure; the
      // event carries the message, so let it do the talking and only clean up
      // here if it never arrives.
      setTimeout(() => {
        if (run.current && !run.current.done) {
          run.current.done = true
          const r = run.current
          run.current = null
          setLive(null)
          setMessages(prev => [...prev, {
            id: r.turnId, role: 'assistant', text: bufRef.current.trim(), error: 'Generation failed.'
          }])
        }
      }, 250)
    })
  }, [draft, messages, model, stick])

  // ⚠️ STOP EVERY ENGINE, NOT THE LOCAL ONE. This only ever called
  // LocalModels.stop, so Stop did nothing at all to a cloud answer — it just
  // kept arriving — and Apple's would have had the same hole. Which engine is
  // running is not knowable here after the fact, and stopping one that is idle
  // is free.
  const stopAll = () => {
    const p = plugins()
    p.LocalModels?.stop?.().catch(() => {})
    p.ProviderChat?.stop?.().catch(() => {})
    stopApple().catch(() => {})
  }

  const stop = useCallback(() => {
    const r = run.current
    if (!r) return
    r.stoppedAt = Date.now()
    haptics.impact?.('RIGID')
    stopAll()
  }, [])

  // Leaving the screen mid-stream must not leave the phone generating into a
  // component that no longer exists.
  useEffect(() => () => { if (run.current) stopAll() }, [])

  const back = usePress(() => onBack?.(), { haptic: 'LIGHT' })
  const menuBtn = usePress(() => { haptics.selection?.(); setMenu(m => !m) })
  const jump = usePress(() => { follow.current = true; setShowJump(false); stick(true) })
  const sendBtn = usePress(() => (generating ? stop() : send()))

  const clear = () => {
    if (run.current) stop()
    bufRef.current = ''
    setMessages([])
    setLive(null)
    setMenu(false)
  }

  const empty = messages.length === 0 && !live
  const canSend = draft.trim().length > 0

  return (
    <>
      <style>{CSS}</style>
      <div className='rx-chat' ref={rootRef}>
        <header ref={navRef} className={'rx-chat-nav' + (scrolled ? ' is-scrolled' : '')}>
          <button
            className={'rx-chat-back' + (back.pressed ? ' is-pressed' : '')}
            aria-label='Back to Models'
            {...back.handlers}
          >
            <Chevron />
            <span>Models</span>
          </button>
          {/* ⚠️ THE TITLE IS THE MODEL SWITCHER. Tony: "while inside a chat,
              there should be a way to switch models on the fly." Putting it
              behind the ⋯ menu would hide the one control people reach for
              most; a tappable title with a chevron is what every chat app of
              this shape does, and it needs no new chrome. It is only a control
              when there is something to switch TO. */}
          <div
            className={'rx-chat-title' + (downloadedModels.length > 1 ? ' is-switch' : '')}
            {...(downloadedModels.length > 1
              ? {
                  role: 'button',
                  tabIndex: 0,
                  'aria-haspopup': 'menu',
                  'aria-label': `Model: ${model?.name || 'none'}. Change model.`,
                  onClick: () => setPickModel(true)
                }
              : {})}
          >
            <div className='rx-chat-title-1'>
              {model?.name || 'No model'}
              {downloadedModels.length > 1 && (
                <svg className='rx-chat-title-chev' viewBox='0 0 10 6' width='9' height='6' aria-hidden='true'>
                  <path d='M1 1l4 4 4-4' fill='none' stroke='currentColor' strokeWidth='1.6' strokeLinecap='round' strokeLinejoin='round' />
                </svg>
              )}
            </div>
            {/* ⚠️ THIS LINE IS A CLAIM, SO IT HAS TO BE TRUE. It said "On
                device" unconditionally — under the name of an OpenRouter model,
                on a request that had already left the phone. The privacy
                promise is the most damaging thing in the app to get wrong, and
                it was hard-coded. It now names where the answer actually comes
                from. */}
            <div className={'rx-chat-title-2' + (rate ? ' is-mono' : '')}>
              {rate ? rate + ' tok/s' : (model?.cloud ? (model.maker || 'Cloud') : 'On device')}
            </div>
          </div>
          <button className={'rx-chat-more' + (menuBtn.pressed ? ' is-pressed' : '')} {...menuBtn.handlers} aria-label='More'>
            <Ellipsis />
          </button>
        </header>

        <div
          className='rx-chat-scroll'
          ref={scrollRef}
          onScroll={onScroll}
          onTouchStart={onTranscriptTouchStart}
          onTouchMove={onTranscriptTouchMove}
        >
          <div ref={sentinelRef} className='rx-chat-sentinel' />

          {empty && (
            <div className='rx-chat-empty'>
              <BrandMark size={64} />
              <div className='rx-chat-empty-name'>{model?.name || 'No model'}</div>
              <div className='rx-chat-empty-sub'>Running on this iPhone. Nothing leaves the device.</div>
              <div className='rx-chat-suggestions'>
                <Suggestion text='Rewrite this paragraph' onPick={send} />
                <Suggestion text='Explain a shell command' onPick={send} />
                <Suggestion text='Draft a reply' onPick={send} />
              </div>
            </div>
          )}

          {messages.map((m, i) => {
            const same = i > 0 && messages[i - 1].role === m.role
            if (m.role === 'user') {
              return (
                <div key={m.id} className={'rx-chat-turn rx-chat-turn-user' + (same ? ' is-same' : '')}>
                  <div className='rx-chat-bubble'>{m.text}</div>
                </div>
              )
            }
            return (
              <AssistantTurn key={m.id} model={model} marker={m.error ? 'failed' : 'resident'}>
                {segments(m.text).map((s, j) => (
                  s.type === 'code'
                    ? <CodeBlock key={j} code={s.text} />
                    : <p key={j} className='rx-chat-body'>{richText(s.text.trim(), `m${m.id}-${j}`)}</p>
                ))}
                {m.error && <p className='rx-chat-error'>{m.error}</p>}
              </AssistantTurn>
            )
          })}

          {live && (
            <AssistantTurn model={model} marker={live.marker}>
              {/* React never owns this node's contents: tokens are appended to
                  the single text node inside it, and the finished turn replaces
                  it in one commit. */}
              <p
                className='rx-chat-body rx-chat-live'
                ref={node => {
                  liveNode.current = node
                  // Seeded from the buffer, not empty. This <p> only mounts once
                  // the first token has ALREADY been counted — the token handler
                  // is what flips the marker that renders it — so an empty text
                  // node silently drops the opening word of every reply until
                  // the finished turn replaces it. Seeding also self-heals if
                  // this node is ever remounted mid-stream.
                  if (node && !node.firstChild) {
                    node.appendChild(document.createTextNode(bufRef.current))
                  }
                }}
              />
            </AssistantTurn>
          )}
        </div>

        {showJump && (
          <button className={'rx-chat-jump' + (jump.pressed ? ' is-pressed' : '')} {...jump.handlers}>
            Jump to latest
          </button>
        )}

        {/* ⚠️ AN ACTIVE SKILL HAS TO BE VISIBLE. It changes every reply in this
            conversation, and a setting you cannot see is one you cannot trust
            or undo. The button says the skill's name when one is on, and the
            same tap is how you clear it. */}
        <div className='rx-chat-skillbar' ref={skillbarRef} hidden={slashList.length > 0}>
          <span
            className={'rx-chat-skillpick' + (skillId ? ' is-on' : '')}
            role='button'
            tabIndex={0}
            onClick={() => setPickSkill(true)}
          >
            {skill ? skill.name : 'Skill'}
          </span>
        </div>
        {/* The list a `/` brings up. Sits directly above the composer so the
            thumb travels the shortest distance from the keyboard, and taps on
            touchstart because a menu that waits for click feels broken here. */}
        {slashList.length > 0 && (
          <div className='rx-chat-slash' role='listbox'>
            {slashList.map(c => (
              <SlashRow
                key={c.id}
                cmd={c.cmd}
                name={c.name}
                onPick={() => {
                  setDraft(c.cmd + ' ')
                  requestAnimationFrame(() => taRef.current?.focus())
                }}
              />
            ))}
          </div>
        )}
        <div className='rx-chat-composer' ref={composerRef}>
          <textarea
            ref={taRef}
            className='rx-chat-field'
            value={draft}
            rows={1}
            placeholder={'Message ' + (model?.name?.replace(/\s+\S+B$/i, '') || 'the model')}
            // 17px minimum, never reduced: below 16px iOS zooms the page on
            // focus and the illusion is over in one tap.
            onChange={e => setDraft(e.target.value)}
            onFocus={() => { if (follow.current) setTimeout(() => stick(), 60) }}
            autoCapitalize='sentences'
            autoCorrect='on'
            autoComplete='off'
            spellCheck
            enterKeyHint='enter'
          />
          {/* aria-disabled, not `disabled`: WebKit stops dispatching touch
              events to a disabled control, which kills the press state too */}
          <button
            className={'rx-chat-send' + (generating ? ' is-stop' : '') + (!canSend && !generating ? ' is-off' : '') + (sendBtn.pressed ? ' is-pressed' : '')}
            {...sendBtn.handlers}
            aria-disabled={!canSend && !generating}
            aria-label={generating ? 'Stop' : 'Send'}
          >
            {generating ? <StopSquare /> : <ArrowUp />}
          </button>
        </div>

        {pickSkill && (
          <div className='rx-chat-menulayer' onTouchStart={() => setPickSkill(false)} onClick={() => setPickSkill(false)}>
            <div className='rx-chat-menu rx-chat-models' role='menu' onTouchStart={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
              <MenuRow
                label='No skill'
                glyph={!skillId ? <TickGlyph /> : <span style={{ width: 16 }} />}
                onPick={() => { setPickSkill(false); onSkillChange?.(null) }}
              />
              {listSkills().length > 0 && <div className='rx-chat-menusep' />}
              {[...listSkills()].sort((a, b) => a.name.localeCompare(b.name)).map(sk => (
                <MenuRow
                  key={sk.id}
                  label={sk.name}
                  glyph={sk.id === skillId ? <TickGlyph /> : <span style={{ width: 16 }} />}
                  onPick={() => { setPickSkill(false); onSkillChange?.(sk.id) }}
                />
              ))}
              {onManageSkills && <>
                <div className='rx-chat-menusep' />
                <MenuRow
                  label='Edit skills…'
                  glyph={<span style={{ width: 16 }} />}
                  onPick={() => { setPickSkill(false); onManageSkills() }}
                />
              </>}
            </div>
          </div>
        )}

        {pickModel && (
          <div className='rx-chat-menulayer' onTouchStart={() => setPickModel(false)} onClick={() => setPickModel(false)}>
            <div className='rx-chat-menu rx-chat-models' role='menu' onTouchStart={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
              {downloadedModels.map(m => (
                <MenuRow
                  key={m.id}
                  label={m.name}
                  glyph={m.id === model?.id ? <TickGlyph /> : <span style={{ width: 16 }} />}
                  onPick={() => { setPickModel(false); if (m.id !== model?.id) onSwitchModel?.(m.id) }}
                />
              ))}
            </div>
          </div>
        )}

        {menu && (
          <div className='rx-chat-menulayer' onTouchStart={() => setMenu(false)} onClick={() => setMenu(false)}>
            <div className='rx-chat-menu' role='menu' onTouchStart={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
              <MenuRow label='New conversation' glyph={<NewChatGlyph />} onPick={clear} />
              <div className='rx-chat-menusep' />
              <MenuRow label='Model info' glyph={<InfoGlyph />} onPick={() => { setMenu(false); onModelInfo?.(model) }} />
              <div className='rx-chat-menusep' />
              <MenuRow
                label='Delete conversation'
                glyph={<TrashGlyph />}
                destructive
                onPick={() => { clear(); onDeleteConversation?.() }}
              />
            </div>
          </div>
        )}
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat-screen rules only. Tokens, the reset and the solved springs come from
// mobile.css; nothing here is defined that another screen might also want.
// Every color is an --rx-* token so this screen can never drift from the rest
// of the app, and there is not one :hover rule in the file.
const CSS = `
.rx-chat {
  --rx-mat: rgba(255,255,255,0.72);
  --rx-kb: 0px;
  --rx-kb-dur: 250ms;
  /* absolute, not fixed: this screen lives inside a nav-stack layer that takes
     a transform during a push, and a fixed child of a transformed ancestor is
     laid out against that ancestor anyway — absolute says so honestly and
     cannot escape the layer mid-animation. */
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  height: 100%;
  background: var(--rx-bg); color: var(--rx-label);
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; letter-spacing: normal;
  overscroll-behavior: none;
  -webkit-tap-highlight-color: transparent;
  -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
  touch-action: manipulation;
}
/* keyed off the app's mode, NOT the phone's — see data-rx-dark in theme.js */
.is-native[data-rx-dark='true'] .rx-chat { --rx-mat: rgba(30,30,30,0.72); }
/* :where() so the reset carries zero specificity and any single class below
   beats it — otherwise \`.rx-chat button\` quietly out-ranks \`.rx-chat-back\`
   and every tinted control comes out black. */
:where(.rx-chat) :where(button) { font-family: inherit; color: inherit; background: none; border: 0; margin: 0; padding: 0; }
/* Invisible to a finger, visible to a keyboard. This selector out-specifies the
   global .is-native :focus-visible ring, so suppressing it here quietly undid
   that ring for every control on this screen — including the composer, where
   losing the caret's focus outline is worst. :focus-visible never matches a
   tap, so there is nothing to hide from a finger. */
/* Buttons only — NOT the composer. A textarea matches :focus-visible on a plain
   tap (spec: any keyboard-editable element does), so ringing it drew a blue web
   outline around the composer every time someone went to type. */
.rx-chat button:focus-visible {
  outline: 3px solid var(--rx-tint);
  outline-offset: 2px;
  border-radius: 8px;
}
/* The \`font: -apple-system-body\` shorthands below are how Dynamic Type gets in
   for free, but they are WebKit-only: anywhere else the whole declaration is
   dropped at parse time and the control falls back to its UA font — a textarea
   lands on monospace. Zero-specificity, so it only fills the gap and never
   overrides the real system font on device. */
:where(.rx-chat) :where(*) { font-family: inherit; }

/* ── nav ── */
.rx-chat-nav {
  position: absolute; top: 0; left: 0; right: 0; z-index: 3;
  display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 8px;
  padding: 6px 8px 8px; padding-top: calc(env(safe-area-inset-top) + 6px);
  background: var(--rx-mat);
  -webkit-backdrop-filter: blur(30px) saturate(180%);
  backdrop-filter: blur(30px) saturate(180%);
  border-bottom: 0.5px solid transparent;
  transition: border-color 180ms var(--rx-down);
}
.rx-chat-nav.is-scrolled { border-bottom-color: var(--rx-separator); }
.rx-chat-back {
  display: flex; align-items: center; gap: 2px; justify-self: start;
  min-height: 44px; padding-right: 10px; color: var(--rx-tint);
  font-size: calc(17px * var(--rx-dt)); line-height: 1.294; font-weight: 400; min-width: 0;
}
.rx-chat-back span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rx-chat-back.is-pressed { opacity: 0.35; }
.rx-chat-title { text-align: center; min-width: 0; }
.rx-chat-title-1 { font-size: calc(17px * var(--rx-dt)); line-height: 1.294; font-weight: 600; color: var(--rx-label); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rx-chat-title-2 {
  font-size: calc(11px * var(--rx-dt, 1)); line-height: 13px;
  color: var(--rx-label-2); margin-top: 1px;
}
.rx-chat-title-2.is-mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-variant-numeric: tabular-nums; }
.rx-chat-more {
  justify-self: end; display: grid; place-items: center;
  width: 44px; height: 44px; color: var(--rx-tint);
}
.rx-chat-more.is-pressed { opacity: 0.35; }

/* ── transcript ── */
.rx-chat-scroll {
  flex: 1; min-height: 0; overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain; /* keeps the rubber band, stops the page dragging */
  scrollbar-width: none;
  display: flex; flex-direction: column;
  padding: calc(var(--rx-chat-navh, 96px) + 8px) 16px
           calc(var(--rx-chat-composerh, 64px) + var(--rx-chat-barh, 0px) + var(--rx-kb) + 16px);
}
.rx-chat-scroll::-webkit-scrollbar { display: none; }
.rx-chat-sentinel { height: 1px; flex: none; margin-bottom: -1px; }

.rx-chat-turn { margin-top: 16px; }
.rx-chat-turn.is-same { margin-top: 4px; }
.rx-chat-turn-user { align-self: flex-end; max-width: 78%; }
.rx-chat-bubble {
  font-size: calc(17px * var(--rx-dt)); line-height: 1.294; font-weight: 400;
  background: var(--rx-tint); color: var(--rx-on-tint);
  border-radius: var(--rx-r-bubble, 20px); padding: 10px 14px;
  white-space: pre-wrap; overflow-wrap: anywhere;
  -webkit-user-select: text; user-select: text; -webkit-touch-callout: default;
}
.rx-chat-turn-model { align-self: stretch; max-width: 34em; }
.rx-chat-byline { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; color: var(--rx-label-2); }
.rx-chat-marker { display: block; width: 22px; height: 22px; flex: none; }
.rx-chat-byname { font-size: calc(13px * var(--rx-dt)); line-height: 1.385; font-weight: 400; font-weight: 600; color: var(--rx-label-2); }
.rx-chat-inlinecode {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.92em;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--rx-fill-3);
}
.rx-chat-body {
  /* richText emits real newlines so headings and list lines keep their shape */
  white-space: pre-wrap;
  font-size: calc(17px * var(--rx-dt)); line-height: 1.294; font-weight: 400; line-height: 1.53; /* 400 words needs air a bubble does not give */
  color: var(--rx-label); margin: 0 0 10px; white-space: pre-wrap; overflow-wrap: anywhere;
  -webkit-user-select: text; user-select: text; -webkit-touch-callout: default;
}
.rx-chat-body:last-child { margin-bottom: 0; }
.rx-chat-error { font-size: calc(13px * var(--rx-dt)); line-height: 1.385; font-weight: 400; color: var(--rx-red-text); margin: 4px 0 0; }

/* the only motion in the transcript, and it is amber because the phone is
   burning current */
.rx-chat-live::after {
  content: ''; display: inline-block; width: 2px; height: 20px;
  vertical-align: -4px; margin-left: 2px; border-radius: 1px;
  background: var(--rx-amber-glyph);
  animation: rx-chat-caret 900ms steps(1, end) infinite alternate;
}
@keyframes rx-chat-caret { from { opacity: 0.25 } to { opacity: 1 } }

.rx-chat-codewell { position: relative; margin: 0 0 10px; }
.rx-chat-code {
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; line-height: 18px;
  background: var(--rx-cell-2); color: var(--rx-label);
  border-radius: var(--rx-r-code, 10px); padding: 12px; margin: 0;
  overflow-x: auto; overscroll-behavior-x: contain; /* never scrolls the page */
  scrollbar-width: none;
  -webkit-user-select: text; user-select: text; -webkit-touch-callout: default;
}
.rx-chat-code::-webkit-scrollbar { display: none; }
.rx-chat-copy {
  position: absolute; top: 4px; right: 4px; z-index: 1;
  font-size: calc(13px * var(--rx-dt)); line-height: 1.385; font-weight: 400; color: var(--rx-tint);
  padding: 8px 10px; min-height: 32px;
}
.rx-chat-copy.is-pressed { opacity: 0.35; }

/* ── empty state ── */
.rx-chat-empty {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; padding: 24px 0 32px; text-align: center;
}
.rx-chat-empty-name { font-size: calc(20px * var(--rx-dt, 1)); line-height: 25px; font-weight: 600; margin-top: 12px; }
.rx-chat-empty-sub { font-size: calc(15px * var(--rx-dt, 1)); line-height: 20px; color: var(--rx-label-2); max-width: 22em; }
.rx-chat-suggestions { display: flex; flex-direction: column; align-items: center; gap: 8px; margin-top: 24px; }
.rx-chat-suggestion {
  font-size: calc(16px * var(--rx-dt, 1)); line-height: 21px;
  color: var(--rx-tint); background: var(--rx-fill-4);
  border-radius: var(--rx-r-capsule, 999px); padding: 11px 18px; min-height: 44px;
  transition: transform var(--rx-dur-press, 322ms) var(--rx-press);
}
.rx-chat-suggestion.is-pressed { transform: scale(0.96); transition: transform var(--rx-dur-down, 110ms) var(--rx-down); }

/* ── jump to latest ── */
.rx-chat-jump {
  position: absolute; z-index: 2; left: 50%;
  bottom: calc(var(--rx-chat-composerh, 64px) + var(--rx-kb) + 10px);
  font-size: calc(13px * var(--rx-dt)); line-height: 1.385; font-weight: 400; color: var(--rx-tint);
  background: var(--rx-mat);
  -webkit-backdrop-filter: blur(30px) saturate(180%);
  backdrop-filter: blur(30px) saturate(180%);
  border: 0.5px solid var(--rx-separator);
  border-radius: var(--rx-r-capsule, 999px);
  padding: 8px 14px; min-height: 34px;
  transform: translateX(-50%);
  animation: rx-chat-jumpin var(--rx-dur-pop, 316ms) var(--rx-pop) both;
}
.rx-chat-jump.is-pressed { opacity: 0.6; }
@keyframes rx-chat-jumpin {
  from { transform: translate(-50%, 20px); opacity: 0 }
  to   { transform: translate(-50%, 0); opacity: 1 }
}

/* ── the slash list ──
   ⚠️ ABSOLUTE, ABOVE THE COMPOSER, AND ABOVE IT IN THE STACK. In normal flow
   this sat at the same height as the composer, which is position:absolute at
   z-index 3 — so the rows were visible but every tap landed in the text field
   instead. It rides on the same bottom offset as the jump button, which is
   already correct for the keyboard. */
.rx-chat-slash {
  position: absolute; z-index: 4; left: 14px; right: 14px;
  bottom: calc(var(--rx-chat-composerh, 64px) + var(--rx-kb) + 8px);
  max-height: 42dvh; overflow-y: auto; -webkit-overflow-scrolling: touch;
  background: var(--rx-mat);
  -webkit-backdrop-filter: blur(30px) saturate(180%);
  backdrop-filter: blur(30px) saturate(180%);
  border: 0.5px solid var(--rx-separator);
  border-radius: var(--rx-r-card, 12px);
  animation: rx-chat-slashin var(--rx-dur-pop, 316ms) var(--rx-pop) both;
}
@keyframes rx-chat-slashin {
  from { transform: translateY(12px); opacity: 0 }
  to   { transform: translateY(0); opacity: 1 }
}
.rx-chat-slashrow {
  display: flex; align-items: baseline; gap: 10px;
  padding: 11px 14px; min-height: 44px; box-sizing: border-box;
  border-bottom: 0.5px solid var(--rx-separator);
}
.rx-chat-slashrow:last-child { border-bottom: none; }
.rx-chat-slashrow.is-pressed { background: var(--rx-fill-2); }
.rx-chat-slashcmd {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: calc(15px * var(--rx-dt)); color: var(--rx-tint); flex-shrink: 0;
}
.rx-chat-slashname {
  font-size: calc(15px * var(--rx-dt)); color: var(--rx-label-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ── composer ── */
.rx-chat-composer {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 3;
  display: flex; align-items: flex-end; gap: 8px;
  padding: 8px 8px 8px 16px;
  padding-bottom: max(8px, env(safe-area-inset-bottom));
  background: var(--rx-mat);
  -webkit-backdrop-filter: blur(30px) saturate(180%);
  backdrop-filter: blur(30px) saturate(180%);
  border-top: 0.5px solid var(--rx-separator);
  transform: translate3d(0, calc(-1 * var(--rx-kb)), 0);
  transition: transform var(--rx-kb-dur) var(--rx-down);
}
.rx-chat-field {
  flex: 1; min-width: 0; resize: none; border: 0; appearance: none;
  font-size: calc(17px * var(--rx-dt)); line-height: 1.294; font-weight: 400; /* 17px floor — anything smaller zooms on focus */
  color: var(--rx-label); background: var(--rx-fill-2);
  border-radius: var(--rx-r-field, 18px);
  padding: 7px 12px; min-height: 36px; max-height: 45dvh;
  -webkit-user-select: text; user-select: text; -webkit-touch-callout: default;
  scrollbar-width: none;
}
.rx-chat-field::-webkit-scrollbar { display: none; }
.rx-chat-field::placeholder { color: var(--rx-label-3); }
.rx-chat-send {
  position: relative; flex: none; display: grid; place-items: center;
  width: 44px; height: 44px; /* 44pt hit area around a 30pt circle, never a 44pt circle */
  color: var(--rx-on-tint);
  transition: transform var(--rx-dur-press, 322ms) var(--rx-press);
}
.rx-chat-send::before {
  content: ''; position: absolute; width: 30px; height: 30px; border-radius: 999px;
  background: var(--rx-tint);
  transition: background-color 240ms var(--rx-down);
}
.rx-chat-send > * { position: relative; }
.rx-chat-send.is-off { color: var(--rx-label-3); }
.rx-chat-send.is-off::before { background: var(--rx-fill-3); }
.rx-chat-send.is-stop { color: var(--rx-on-tint); }
.rx-chat-send.is-stop::before { background: var(--rx-amber-glyph); }
.rx-chat-send.is-pressed { transform: scale(0.96); transition: transform var(--rx-dur-down, 110ms) var(--rx-down); }

/* ── menu ── */
.rx-chat-menulayer { position: absolute; inset: 0; z-index: 5; }
.rx-chat-menu {
  position: absolute; right: 8px; top: calc(env(safe-area-inset-top) + 50px);
  width: 250px; transform-origin: 100% 0;
  background: var(--rx-cell);
  border-radius: 13px; overflow: hidden;
  box-shadow: 0 10px 40px rgba(0,0,0,0.22);
  animation: rx-chat-menuin var(--rx-dur-pop, 316ms) var(--rx-pop) both;
}
@keyframes rx-chat-menuin {
  from { transform: scale(0.86); opacity: 0 }
  to   { transform: scale(1); opacity: 1 }
}
.rx-chat-menurow {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  width: 100%; min-height: 44px; padding: 11px 16px; text-align: left;
  font-size: calc(17px * var(--rx-dt)); line-height: 1.294; font-weight: 400; color: var(--rx-label);
}
.rx-chat-menurow.is-destructive { color: var(--rx-red-text); }
.rx-chat-menurow.is-pressed { background: var(--rx-fill-1); }
.rx-chat-menusep { height: 0.5px; background: var(--rx-separator); }

@media (prefers-reduced-transparency: reduce) {
  .rx-chat-nav, .rx-chat-composer, .rx-chat-jump {
    -webkit-backdrop-filter: none; backdrop-filter: none; background: var(--rx-bg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .rx-chat-live::after { animation: none; opacity: 1; }
  .rx-chat-jump, .rx-chat-menu { animation-duration: 1ms; }
}
`

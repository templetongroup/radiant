import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Markdown from './Markdown.jsx'
import { Icon } from './Icons.jsx'
import { glyphColor } from '../theme.js'
import { AgentGlyph } from './AgentIcons.jsx'
import { api, getServer } from '../api.js'
import { shouldDrainQueue } from '../queue.js'

// An agent brought in from another app on this Mac (Hermes, OpenClaw). They sit
// apart from your own agents and keep their icon's own color rather than taking
// a hue tint. `relay` is checked too so agents imported before `source` was
// stored are still recognized.
export const isImported = a => Boolean(a?.source || a?.relay)

// short one-line blurb shown under an agent on the splash screen
const AGENT_BLURBS = {
  'agent-radiant': 'General-purpose coding assistant',
  'agent-reviewer': 'Finds bugs, edge cases & security issues',
  'agent-architect': 'Designs the structure before writing code',
  'agent-explainer': 'Explains code in plain language',
  'agent-pair': 'Writes and ships working code',
  'agent-security': 'Audits for vulnerabilities & unsafe code',
  'agent-sales': 'Drafts outreach, proposals & sales copy',
  'agent-design': 'Shapes UI, layout & visual polish',
  'agent-education': 'Teaches concepts step by step',
  'agent-finance': 'Models numbers, budgets & forecasts',
  'agent-devops': 'Handles CI, deploys & infrastructure',
  'agent-data': 'Wrangles, queries & analyzes data',
  'agent-docs': 'Writes clear docs & references'
}
// strip a leading "You are (a|an|the) …" so descriptions read as a role, not a command
function cleanDesc (s) {
  let t = (s || '').trim().replace(/^you(?:'re| are)\s+(?:an?|the)?\s*/i, '')
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t
}
function agentBlurb (a) {
  if (AGENT_BLURBS[a.id]) return AGENT_BLURBS[a.id]
  const p = cleanDesc(a.persona)
  if (!p) return 'General assistant'
  const first = p.split(/(?<=[.!?])\s/)[0]
  return first.length > 64 ? first.slice(0, 61).trimEnd() + '…' : first
}

// agent task checklist (from the todo_write tool)
function TodoChecklist ({ todos }) {
  const [collapsed, setCollapsed] = useState(false)
  const done = (todos || []).filter(t => t.status === 'done').length
  const all = todos?.length ? done === todos.length : false

  // ⚠️ A FINISHED LIST GETS OUT OF THE WAY BY ITSELF. It earns its place while the
  // agent works through it, then sits open above the composer for the rest of the
  // conversation, five struck-through lines deep. Tony: "why does this tasks
  // window stay open during the whole reast of the chat if its complete."
  //
  // ⚠️ ON THE TRANSITION, NOT ON THE STATE. Collapsing whenever `all` is true would
  // slam it shut again on every render after you opened it to look — so this fires
  // once, as the last item lands, and your click wins from then on.
  const wasAll = useRef(false)
  useEffect(() => {
    if (all && !wasAll.current) setCollapsed(true)
    wasAll.current = all
  }, [all])

  // ⚠️ AFTER THE HOOKS, NEVER BEFORE. Returning early on an empty list above a
  // useEffect changes the hook count between renders, which React rejects outright.
  if (!todos?.length) return null
  return (
    <div className={'todo-panel' + (all ? ' complete' : '')}>
      <button className='todo-head' onClick={() => setCollapsed(c => !c)}>
        <span className='todo-caret'>{collapsed ? '▸' : '▾'}</span>
        Tasks <span className='todo-count'>{all ? `✓ ${done}/${todos.length}` : `${done}/${todos.length}`}</span>
      </button>
      {!collapsed && todos.map((t, i) => (
        <div key={i} className={'todo-item ' + t.status}>
          <span className='todo-box' aria-hidden>{t.status === 'done' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}</span>
          <span className='todo-text'>{t.text}</span>
        </div>
      ))}
    </div>
  )
}

// files this turn created or edited, as clickable chips
function Deliverables ({ parts }) {
  const files = []
  const seen = new Set()
  for (const p of parts) {
    if (p.type === 'tool' && (p.name === 'write_file' || p.name === 'edit_file') && !p.denied && p.result && !/^Error/i.test(String(p.result))) {
      const fp = p.args?.path
      if (fp && !seen.has(fp)) { seen.add(fp); files.push(fp) }
    }
  }
  if (!files.length) return null
  return (
    <div className='deliverables'>
      <span className='deliverables-label'>Files changed</span>
      {files.map(f => (
        <button key={f} className='deliverable' title={f} onClick={() => api.openFile(f).catch(() => {})}>
          <span className='deliverable-ico' aria-hidden>✎</span>{f.split('/').pop()}
        </button>
      ))}
    </div>
  )
}

// ⚠️ THESE WERE THREE SOLID ACCENT BUTTONS. Each option is a sentence, so the
// answers arrived as fat wrapping blue pills that shouted over the question they
// belonged to. Tony: "these selection cards are awful. ugly.. use this instead.
// use Focus Relay."
//
// Focus Relay: the options are quiet rows, and ONE ring travels between them.
// The ring is a single element that measures its target and moves, which is what
// makes it read as one thing choosing rather than four things lit at once — a
// per-row highlight cannot travel, the same reason the sidebar pill had to move
// off the button and onto the track.
function ChoiceRelay ({ options, onPick }) {
  const wrap = useRef(null)
  const [at, setAt] = useState(0)
  const [ring, setRing] = useState(null)

  // ⚠️ MEASURE AFTER LAYOUT, NOT DURING RENDER. The rows wrap to their text, so
  // their height is not known until the browser has laid them out; reading it in
  // render gives the ring a stale box on the first paint.
  useLayoutEffect(() => {
    const el = wrap.current?.children?.[at + 1]   // +1: the ring itself is first
    if (!el) return setRing(null)
    setRing({ top: el.offsetTop, left: el.offsetLeft, width: el.offsetWidth, height: el.offsetHeight })
  }, [at, options])

  const onKey = e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); setAt(i => Math.min(options.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); setAt(i => Math.max(0, i - 1)) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(options[at]) }
  }

  return (
    <div
      className='relay' ref={wrap} role='listbox' tabIndex={0}
      aria-label='Choose an answer' aria-activedescendant={`relay-opt-${at}`}
      onKeyDown={onKey}
    >
      <span className='relay-ring' aria-hidden style={ring ? { transform: `translate(${ring.left}px, ${ring.top}px)`, width: ring.width, height: ring.height, opacity: 1 } : { opacity: 0 }} />
      {options.map((o, i) => (
        <button
          key={i}
          id={`relay-opt-${i}`}
          role="option"
          aria-selected={i === at}
          tabIndex={-1}
          className={'relay-opt' + (i === at ? ' is-at' : '')}
          onMouseEnter={() => setAt(i)}
          onFocus={() => setAt(i)}
          onClick={() => onPick(o)}
        >{o}</button>
      ))}
    </div>
  )
}

// the agent paused to ask the user something (ask_user / plan approval)
function QuestionCard ({ question, onAnswer }) {
  const [other, setOther] = useState('')
  return (
    <div className='question-card'>
      <div className='q'>{question.question}</div>
      <ChoiceRelay options={question.options || []} onPick={onAnswer} />
      <div className='question-other'>
        <input placeholder='Or type your own answer…' value={other} onChange={e => setOther(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && other.trim()) onAnswer(other.trim()) }} />
        <button className='small-btn' onClick={() => other.trim() && onAnswer(other.trim())} disabled={!other.trim()}>Send</button>
      </div>
    </div>
  )
}

// a collapsed marker for auto-compacted (summarized) earlier history
function CompactedMarker ({ text }) {
  const [open, setOpen] = useState(false)
  return (
    <div className='compacted-marker'>
      <button className='compacted-head' onClick={() => setOpen(o => !o)}>
        <span className='compacted-line' /> ⋯ earlier conversation summarized {open ? '▾' : '▸'} <span className='compacted-line' />
      </button>
      {open && <div className='compacted-body'><Markdown text={text} /></div>}
    </div>
  )
}

const TOOL_ICONS = {
  run_command: '⌘',
  read_file: '≡',
  write_file: '✎',
  edit_file: '✎',
  list_dir: '▤'
}

function argSummary (name, args) {
  if (!args) return ''
  if (name === 'run_command') return args.command || ''
  if (name === 'edit_file' || name === 'read_file' || name === 'write_file') return args.path || ''
  if (name === 'list_dir') return args.path || '.'
  return JSON.stringify(args)
}

function ToolChip ({ part, compact = false }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className={'tool-chip' + (part.denied ? ' denied' : '') + (compact ? ' compact' : '')} onClick={() => setOpen(o => !o)}>
        {!compact && <span className='tool-ico' aria-hidden>{TOOL_ICONS[part.name] || '·'}</span>}
        {!compact && <span className='tool-name'>{part.name.replace('_', ' ')}</span>}
        <span className='tool-arg'>{argSummary(part.name, part.args)}</span>
        <span className={'tool-status' + (part.pending ? ' pending' : '')}>
          {part.pending ? '⋯' : part.denied ? '✕ denied' : '✓'}
        </span>
      </button>
      {open && (
        <div className='tool-detail'>
          {JSON.stringify(part.args, null, 2)}
          {part.result != null && '\n\n— result —\n' + part.result}
        </div>
      )}
    </>
  )
}

// ⚠️ ONE PILL PER TOOL CALL BURIES THE ANSWER. A stretch of work is normally a
// run of commands, and each one rendered as its own full-width row repeating the
// words "run command", with the command itself truncated — so the transcript
// became a column of near-identical bars you cannot read, between the sentences
// that actually say something. Tony: "it makes the chat very cluttered and hard
// to follow."
//
// Consecutive calls now collapse into one line. What must survive collapsing is
// anything that went wrong: a failure or a denial is named in the summary and
// the group opens itself, because a hidden failure is worse than a cluttered
// one. A single call still renders as a single chip.
function ToolRun ({ parts }) {
  // ⚠️ "FAILED" WAS COUNTING THREE UNRELATED THINGS, and two of them are normal.
  // Tony: "whenever i ask agents to do something there are ALWAYS tool failures.
  // why?" Because a probe into a folder that does not exist, a URL that 404s, and
  // a tool YOU declined all matched /^Error/ and rendered as a red failure count.
  // An agent looking for a file and not finding it is how searching works; being
  // told you said no is not a fault at all. Only the rest is worth alarming about.
  const declined = parts.filter(p => p.denied)
  const errored = parts.filter(p => !p.denied && p.result != null && /^Error/i.test(String(p.result)))
  const NOTHING_THERE = /ENOENT|no such file|not found|404|does not exist|no matches|old_string not found/i
  const empty = errored.filter(p => NOTHING_THERE.test(String(p.result)))
  const failed = errored.filter(p => !NOTHING_THERE.test(String(p.result)))
  const pending = parts.some(p => p.pending)
  const [open, setOpen] = useState(failed.length > 0)
  const names = [...new Set(parts.map(p => p.name))]
  const label = names.length === 1
    ? `${parts.length} ${names[0].replace('_', ' ')}${parts.length === 1 ? '' : 's'}`
    : `${parts.length} tool calls`
  return (
    <div className={'tool-run' + (open ? ' is-open' : '') + (failed.length ? ' has-fail' : '')}>
      <button className='tool-run-head' onClick={() => setOpen(o => !o)}>
        <span className='tool-run-caret' aria-hidden>{open ? '▾' : '▸'}</span>
        <span className='tool-ico' aria-hidden>{TOOL_ICONS[names[0]] || '·'}</span>
        <span className='tool-run-label'>{label}</span>
        <span className={'tool-status' + (pending ? ' pending' : '')}>
          {pending
            ? '⋯'
            : failed.length ? `✕ ${failed.length} failed`
              : empty.length ? `${empty.length} found nothing`
                : declined.length ? `${declined.length} declined`
                  : '✓'}
        </span>
      </button>
      {open && (
        <div className='tool-run-body'>
          {parts.map((p, i) => <ToolChip key={p.id || i} part={p} compact={names.length === 1} />)}
        </div>
      )}
    </div>
  )
}

function ThinkingTrace ({ thinking, active, seconds }) {
  const [open, setOpen] = useState(false)
  const bodyRef = useRef(null)
  const show = open || active
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [thinking])
  return (
    <div className='thinking-trace'>
      <button className={'thinking-head' + (show ? ' open' : '')} onClick={() => setOpen(o => !o)}>
        <span className='chev' aria-hidden>▶</span>
        {active
          ? <span className='shimmer'>Thinking…</span>
          : <span>Thought{seconds ? ` for ${seconds}s` : ''}</span>}
      </button>
      {show && <div className='thinking-body' ref={bodyRef}>{thinking}</div>}
    </div>
  )
}

// a rich inline widget the agent chose to render (show_widget tool)
function AgentWidget ({ spec, onChoose }) {
  if (!spec || !spec.kind) return null
  const toneClass = t => t ? ' tone-' + t : ''
  return (
    <div className='agent-widget'>
      {spec.title && <div className='agent-widget-title'>{spec.title}</div>}
      {spec.kind === 'stats' && (
        <div className='widget-stats'>
          {(spec.stats || []).map((s, i) => (
            <div key={i} className={'widget-stat' + toneClass(s.tone)}>
              <div className='widget-stat-value'>{s.value}</div>
              <div className='widget-stat-label'>{s.label}</div>
              {s.delta && <div className='widget-stat-delta'>{s.delta}</div>}
            </div>
          ))}
        </div>
      )}
      {spec.kind === 'table' && (
        <div className='widget-table-wrap'>
          <table className='widget-table'>
            {spec.columns?.length ? <thead><tr>{spec.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead> : null}
            <tbody>
              {(spec.rows || []).map((row, i) => <tr key={i}>{(row || []).map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}
            </tbody>
          </table>
        </div>
      )}
      {spec.kind === 'diff' && (
        <div className='widget-diff'>
          <div className='widget-diff-col'>
            <div className='widget-diff-head before'>− before</div>
            <pre><code>{spec.before || ''}</code></pre>
          </div>
          <div className='widget-diff-col'>
            <div className='widget-diff-head after'>+ after</div>
            <pre><code>{spec.after || ''}</code></pre>
          </div>
        </div>
      )}
      {spec.kind === 'choices' && (
        <div className='widget-choices'>
          {spec.question && <div className='widget-choices-q'>{spec.question}</div>}
          <div className='widget-choices-list'>
            {(spec.options || []).map((o, i) => (
              <button key={i} className={'widget-choice' + toneClass(o.tone)} onClick={() => onChoose && onChoose(o.label)}>
                <span className='widget-choice-label'>{o.label}</span>
                {o.detail && <span className='widget-choice-detail'>{o.detail}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ⚠️ "WORKING" WAS FOUR GREY CHARACTERS THAT NEVER MOVED. A turn can run for
// minutes on tool calls with nothing else on screen, and the only sign of life was
// a static "· working" beside the model name. Tony: "id also like some sort of
// indicator that an agent is working. there's nothing like that in the chat."
//
// So: a dot that pulses, a clock that counts, and the CURRENT activity named —
// thinking, the tool it is running, or writing. Motion says alive; the clock says
// how long it has been; the verb says what it is doing. A spinner alone says only
// the first of those, which is the part you can already guess.
function WorkingBadge ({ parts, thinkingActive }) {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const t0 = Date.now()
    const id = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(id)
  }, [])

  // The last tool with no result yet is the one running right now.
  const running = [...(parts || [])].reverse().find(p => p.type === 'tool' && p.result == null && !p.denied)
  const what = thinkingActive ? 'thinking'
    : running ? (running.name || 'running a tool').replace(/_/g, ' ')
      : 'writing'
  const clock = secs >= 60 ? `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s` : `${secs}s`

  return (
    <span className='working-badge' role='status'>
      <span className='working-dot' aria-hidden />
      <span className='working-what'>{what}</span>
      <span className='working-clock'>{clock}</span>
    </span>
  )
}

function AssistantMessage ({ parts, thinking, thinkingActive, thinkingSecs, streaming, model, agent, local, onChoose }) {
  const waiting = streaming && !parts.length && !thinking
  // A local model that isn't resident cold-loads its weights before the first token.
  // Reveal the note only after a beat, so a warm model (fast first token) never shows it.
  const [slowWait, setSlowWait] = useState(false)
  useEffect(() => {
    if (!(waiting && local)) { setSlowWait(false); return }
    const t = setTimeout(() => setSlowWait(true), 1000)
    return () => clearTimeout(t)
  }, [waiting, local])
  return (
    <div className='msg msg-assistant'>
      <div className='who'>
        {agent
          ? <><span className='who-agent-emoji' style={isImported(agent) ? undefined : { '--ah': agent.hue ?? 'var(--accent-h)', color: glyphColor(agent.hue, 0.7, 0.16) }}><AgentGlyph agent={agent} size={14} /></span><span className='who-word'>{agent.name}</span></>
          : <><span className='logo-mark' aria-hidden /><span className='wordmark who-word'>Radiant</span></>}
        {model && <span className='who-model'>{model}</span>}
        {streaming && <WorkingBadge parts={parts} thinkingActive={thinkingActive} />}
      </div>
      {thinking ? <ThinkingTrace thinking={thinking} active={Boolean(thinkingActive)} seconds={thinkingSecs} /> : null}
      {(() => {
        // Walk the parts, gathering consecutive tool chips so a run of them can
        // be shown as one line. Anything that is not a chip — a sentence, a
        // widget, a notice — ends the run, because that is where the agent
        // actually said something and the grouping should not swallow it.
        const out = []
        let run = []
        const flush = () => {
          if (!run.length) return
          out.push(run.length === 1
            ? <ToolChip key={run[0].id || 'c' + out.length} part={run[0]} />
            : <ToolRun key={'run' + out.length} parts={run} />)
          run = []
        }
        parts.forEach((p, i) => {
          if (p.type === 'tool' && !p.widget && p.name !== 'show_widget' && p.name !== 'todo_write' && !p.hidden) {
            run.push(p)
            return
          }
          flush()
          if (p.type === 'text') out.push(<Markdown key={i} text={p.text} />)
          else if (p.type === 'tool' && (p.widget || p.name === 'show_widget')) out.push(<AgentWidget key={p.id || i} spec={p.widget || p.args} onChoose={onChoose} />)
          else if (p.type === 'notice') out.push(<div key={i} className='notice'>{p.text}</div>)
        })
        flush()
        return out
      })()}
      {!streaming && <Deliverables parts={parts} />}
      {waiting && (slowWait
        ? <div className='notice loading-note'>
            <span className='shimmer'>Loading the model into memory…</span>
            <span className='loading-sub'>first reply after switching a local model can take a moment</span>
          </div>
        : <div className='notice'>…</div>)}
    </div>
  )
}

/**
 * ⚠️ PINS ARE PER-MAC, AND DELIBERATELY NOT SYNCED. Which models you reach for
 * depends on what this Mac can actually run — a 27B local model pinned on the
 * desktop is noise on the laptop that cannot load it. Same reasoning as
 * rule 15, and localStorage keeps it out of the synced config entirely
 * (rule 16), the same way the activity panel remembers itself.
 */
const PINS_KEY = 'radiant.pinnedModels'
const pinId = m => `${m.provider}::${m.id}`
const readPins = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(PINS_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter(x => typeof x === 'string') : []
  } catch { return [] }
}

// ⚠️ EXPORTED SO THE BOARD USES THIS ONE, not a second picker. Tasks first
// shipped with a plain <select> holding every model — Tony: "that model list is
// overwhelming. it needs to have the same collapsible list as the model list in
// the chat window." Two pickers would also mean two behaviours to keep in step.
// `session` is only read for the current model/provider, so any { model,
// provider } shape works — the board passes the task's own choice.
// ⚠️ ONE PICKER, EVERYWHERE THERE IS A MODEL LIST. Radiant ships hundreds of
// models, so a flat <select> is unusable — Tony, on the agent editor: "the model
// list is again endless. anywhere there's a model list we need to be able to
// collapse it by provider." Grouped, collapsed by default except the provider
// you are on, and searchable. The two optional props are what let a form field
// use it: `placeholder` for the resting label, and `clearLabel` for the "none"
// row a <select> got for free from an empty <option>. Without that second one,
// swapping a select for this picker would quietly delete the ability to say
// "no model" — which is what "Session default" and "No default" mean.
// ⚠️ FOUR STOPS, AND "AUTO" IS ONE OF THEM. Radiant never asked for a thinking
// level, so every model ran at its provider's default and there was nothing to
// show. Tony: "when i pick a model like gpt 5.6 sol how do i know what thinking
// level it is. can we make a slider?"
//
// Auto sends NOTHING, which is exactly today's behaviour — so a model that does
// not reason, or a provider that rejects the parameter, is untouched until you
// deliberately ask for a level. The three APIs each spell it differently; the
// server maps this one word onto whichever shape the provider wants.
const EFFORT_STOPS = [
  ['auto', 'Auto', "The provider's own default"],
  ['low', 'Low', 'Answer quickly, think briefly'],
  ['medium', 'Medium', 'A balance of speed and care'],
  ['high', 'High', 'Think hard before answering']
]

function ThinkRail ({ value, onPick }) {
  const at = Math.max(0, EFFORT_STOPS.findIndex(([id]) => id === (value || 'auto')))
  const rail = useRef(null)
  const [box, setBox] = useState(null)

  // ⚠️ THE PILL HAS TO MEASURE THE STOP, NOT ASSUME A QUARTER OF THE RAIL. The
  // labels are different lengths — "Auto" against "Medium" — so four equal
  // quarters never line up with them: the pill sat off-centre on Low and clipped
  // Medium. Tony: "you didnt fix the spacing of low medium and high text in the
  // thinking window." Measured, it fits whatever the words happen to be, in any
  // language.
  useLayoutEffect(() => {
    const el = rail.current?.children?.[at + 1]   // +1: the pill itself is first
    if (el) setBox({ left: el.offsetLeft, width: el.offsetWidth })
  }, [at, value])

  return (
    <div className='think-rail' ref={rail} role='group' aria-label='Thinking level'>
      <span
        className='think-pill'
        aria-hidden
        style={box ? { transform: `translateX(${box.left}px)`, width: box.width } : { opacity: 0 }}
      />
      {EFFORT_STOPS.map(([id, label, hint], n) => (
        <button
          key={id}
          className={'think-stop' + (n === at ? ' is-on' : '')}
          aria-pressed={n === at}
          data-tip={hint}
          data-tip-below
          title={hint}
          onClick={() => onPick(id)}
        >{label}</button>
      ))}
    </div>
  )
}

export function ModelPicker ({ session, models, onPick, onRefresh, placeholder, clearLabel, effort, onSetEffort }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState({}) // providerName -> explicit collapse override
  const [pins, setPins] = useState(readPins)
  const ref = useRef(null)

  const togglePin = (m, e) => {
    e.stopPropagation()   // pinning is not picking
    const id = pinId(m)
    setPins(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
      try { localStorage.setItem(PINS_KEY, JSON.stringify(next)) } catch { /* private mode */ }
      return next
    })
  }

  useEffect(() => {
    const close = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    // ⚠️ ESCAPE, NOT ONLY AN OUTSIDE CLICK. A panel you can only dismiss by
    // clicking elsewhere is one a keyboard cannot dismiss at all.
    const esc = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [])

  const filtered = models.filter(m => (m.id + m.providerName).toLowerCase().includes(q.toLowerCase()))
  const groups = {}
  for (const m of filtered) (groups[m.providerName] = groups[m.providerName] || []).push(m)
  const current = models.find(m => m.id === session?.model && m.provider === session?.provider)
  const currentProvider = current?.providerName || session?.provider
  const searching = q.trim().length > 0
  // Pins keep the order they were added in, and a pin for a model this Mac can
  // no longer see simply does not render — it is not an error, and the pin
  // stays put in case the provider comes back.
  const pinned = pins.map(id => filtered.find(m => pinId(m) === id)).filter(Boolean)
  // collapsed by default except the current provider; search expands everything
  const isCollapsed = g => !searching && (g in collapsed ? collapsed[g] : g !== currentProvider)
  const toggleGroup = g => setCollapsed(c => ({ ...c, [g]: !(g in c ? c[g] : g !== currentProvider) }))

  return (
    <div ref={ref} style={{ display: 'contents' }}>
      <button
        className='model-btn'
        aria-expanded={open}
        aria-haspopup='listbox'
        aria-controls='model-bloom'
        onClick={() => { setOpen(o => !o); onRefresh() }}
      >
        {session?.model
          ? <>
              <span className='provider-tag'>{current?.providerName || session.provider}</span>
              <span className='model-name'>{session.model}</span>
            </>
          : (placeholder || 'Pick a model')}
        <span aria-hidden style={{ fontSize: 9 }}>▲</span>
      </button>
      {open && (
        <div className='model-menu' id='model-bloom' role='listbox'>
          <input autoFocus placeholder='Search models…' value={q} onChange={e => setQ(e.target.value)} />
          <div className='model-groups'>
            {clearLabel && !searching && (
              <button
                className={'model-option is-clear' + (session?.model ? '' : ' selected')}
                onClick={() => { onPick(null); setOpen(false) }}
              >
                <span className='mo-name'>{clearLabel}</span>
              </button>
            )}
            {pinned.length > 0 && (
              <div>
                <div className='model-group-label is-static'>
                  <span className='mg-name'>Pinned</span>
                  <span className='mg-count'>{pinned.length}</span>
                </div>
                {pinned.map(m => (
                  <button
                    key={'pin' + pinId(m)}
                    className={'model-option' + (m.id === session?.model && m.provider === session?.provider ? ' selected' : '')}
                    onClick={() => { onPick(m); setOpen(false) }}
                  >
                    <span className='mo-name'>{m.id}</span>
                    <span className='mo-provider'>{m.providerName}</span>
                    <span className='mo-pin is-on' role='button' title='Unpin' onClick={e => togglePin(m, e)}>★</span>
                  </button>
                ))}
              </div>
            )}
            {Object.entries(groups).map(([g, ms]) => {
              const col = isCollapsed(g)
              return (
                <div key={g}>
                  <button className='model-group-label' onClick={() => toggleGroup(g)}>
                    <span className='mg-caret'>{col ? '▸' : '▾'}</span>
                    <span className='mg-name'>{g}</span>
                    <span className='mg-count'>{ms.length}</span>
                  </button>
                  {!col && ms.map(m => (
                    <button
                      key={m.provider + m.id}
                      className={'model-option' + (m.id === session?.model && m.provider === session?.provider ? ' selected' : '')}
                      onClick={() => { onPick(m); setOpen(false) }}
                    >
                      <span className='mo-name'>{m.id}</span>
                      <span
                        className={'mo-pin' + (pins.includes(pinId(m)) ? ' is-on' : '')}
                        role='button'
                        title={pins.includes(pinId(m)) ? 'Unpin' : 'Pin to the top'}
                        onClick={e => togglePin(m, e)}
                      >{pins.includes(pinId(m)) ? '★' : '☆'}</span>
                    </button>
                  ))}
                </div>
              )
            })}
            {!filtered.length && (
              <div className='empty'>
                No models. Add an API key in Settings, or start Ollama / LM Studio for local models.
              </div>
            )}
          </div>
          {/* ⚠️ THE THINKING LEVEL BELONGS TO THE MODEL, so it lives where the model
              is chosen. It sat at the far end of the composer's pill row, four
              controls away from the thing it applies to. Tony: "thinking should be
              under the model selector." Only rendered where a session owns one —
              the task board, the agent editor and Compare pass no handler. */}
          {onSetEffort && (
            <div className='model-menu-think'>
              <span className='model-menu-think-label'>Thinking</span>
              <ThinkRail value={effort} onPick={onSetEffort} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const SLASH_COMMANDS = [
  { cmd: '/explain', desc: 'Explain how the code works', prompt: 'Explain how this code works, starting from the entry point. Read the files you need.' },
  { cmd: '/review', desc: 'Review for bugs & improvements', prompt: 'Review the code in this workspace for bugs, edge cases, and improvements. Be specific and cite files.' },
  { cmd: '/fix', desc: 'Find and fix a bug', prompt: 'Find and fix the bug: ' },
  { cmd: '/test', desc: 'Write and run tests', prompt: 'Write tests for the recent changes and run them.' },
  { cmd: '/refactor', desc: 'Refactor for clarity', prompt: 'Refactor this code for clarity without changing behavior: ' },
  { cmd: '/commit', desc: 'Commit current changes', prompt: 'Stage and commit the current changes with a clear, conventional commit message.' },
  { cmd: '/doc', desc: 'Document the code', prompt: 'Add clear documentation and comments to: ' }
]

function exportSessionMarkdown (session) {
  const lines = [`# ${session.title}`, '', `_${session.model || 'model'} · exported from Radiant_`, '']
  for (const m of session.messages) {
    if (m.role === 'user') {
      lines.push('## You', '', m.text || '', '')
    } else {
      lines.push(`## Radiant${m.model ? ` (${m.model})` : ''}`, '')
      for (const p of m.parts || []) {
        if (p.type === 'text') lines.push(p.text, '')
        else if (p.type === 'tool') lines.push(`> **tool** \`${p.name}\` ${p.args?.command || p.args?.path || ''}`.trim(), '')
      }
    }
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = (session.title || 'session').replace(/[^\w-]+/g, '-').slice(0, 40) + '.md'
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

function readFileAsAttachment (file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataB64 = String(reader.result).split(',')[1]
      const isImage = IMAGE_TYPES.includes(file.type)
      resolve({
        name: file.name,
        mime: file.type || 'application/octet-stream',
        kind: isImage ? 'image' : 'text',
        dataB64
      })
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

const MenuIcon = () => <svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round'><path d='M4 6h16M4 12h16M4 18h16' /></svg>

const fmtTok = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n || 0)

// ⚠️ NEVER INVENT THE DENOMINATOR. The input count on the last turn IS the
// context that request consumed — system prompt, history, tools, everything —
// so no estimating is needed for the numerator. The window size is the part we
// may not know: a model we have no entry for gets the number and no bar, rather
// than a percentage of a guess. A long chat degrading quietly as it overflows
// is the failure this exists to prevent; a confidently wrong gauge would be
// worse than none.
const CONTEXT_WINDOWS = [
  [/claude.*(opus|sonnet|haiku)/i, 200_000],
  [/gpt-5|gpt-4\.1|o[34]/i, 400_000],
  [/gpt-4o|gpt-4-turbo/i, 128_000],
  [/gemini.*(pro|flash)/i, 1_000_000],
  [/grok/i, 131_072],
  [/deepseek/i, 65_536],
  [/qwen.*(2\.5|3)/i, 32_768],
  [/llama.*3\.[123]/i, 128_000],
  [/mistral|mixtral/i, 32_768]
]
function contextWindow (model) {
  for (const [re, n] of CONTEXT_WINDOWS) if (re.test(model || '')) return n
  return null
}
const kfmt = n => n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)

function ContextGauge ({ usage, model }) {
  // ⚠️ A COUNT THAT CHANGES SHOULD REGISTER AS HAVING CHANGED. This number moves
  // once per turn and sits in the corner of a busy composer, so it updates without
  // anyone noticing — which matters most as it approaches the context limit, the
  // one moment the number is worth reading. A short bump on change, nothing more.
  const [bump, setBump] = useState(false)
  const lastIn = useRef(null)
  useEffect(() => {
    const v = usage?.input ?? null
    if (v !== null && lastIn.current !== null && v !== lastIn.current) {
      setBump(true)
      const t = setTimeout(() => setBump(false), 340)
      lastIn.current = v
      return () => clearTimeout(t)
    }
    lastIn.current = v
  }, [usage?.input])
  const bumped = bump ? ' is-bumped' : ''
  const used = usage?.input
  if (!used) return <span className={'usage-note' + bumped}>{usage?.output ?? '–'} out</span>
  const win = contextWindow(model)
  if (!win) return <span className={'usage-note' + bumped}>{kfmt(used)} in · {usage.output ?? '–'} out</span>
  const pct = Math.min(100, Math.round((used / win) * 100))
  const level = pct >= 90 ? ' is-full' : pct >= 70 ? ' is-high' : ''
  return (
    <span className={'ctx-gauge' + level} data-tip={`Context: ${used.toLocaleString()} of about ${win.toLocaleString()} tokens used on the last turn.\nWhen this fills, the oldest messages stop being sent.`}>
      <span className='ctx-bar'><span style={{ width: pct + '%' }} /></span>
      <span className={'usage-note' + bumped}>{pct}% of {kfmt(win)} · {usage.output ?? '–'} out</span>
    </span>
  )
}

function StatsChip ({ stats }) {
  if (!stats || !stats.turns) return null
  const secs = Math.round((stats.llmMs + stats.toolMs) / 1000)
  return (
    <span className='stats-chip' title={`This session\n${stats.turns} turn(s)\n${stats.inTokens} in / ${stats.outTokens} out tokens\nLLM: ${(stats.llmMs / 1000).toFixed(1)}s · tools: ${(stats.toolMs / 1000).toFixed(1)}s`}>
      {stats.turns}⟳ · {fmtTok(stats.inTokens + stats.outTokens)} tok · {secs}s
    </span>
  )
}

// reusable parameterized task templates, from the composer
function RecipeMenu ({ recipes, onUse }) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(null)
  const [vals, setVals] = useState({})
  const ref = useRef(null)
  useEffect(() => {
    const close = e => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setActive(null) } }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  if (!recipes?.length) return null
  const render = r => r.template.replace(/\{(\w+)\}/g, (_, k) => vals[k] || `{${k}}`)
  const use = r => {
    if (r.params?.length && r.params.some(p => !(vals[p.name] || '').trim())) return
    onUse(r.params?.length ? render(r) : r.template); setOpen(false); setActive(null); setVals({})
  }
  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex' }}>
      
              <button className='attach-btn' title='Recipes' data-tip={'Recipes — insert a reusable\ntask template into the message'} onClick={() => { setOpen(o => !o); setActive(null) }}><Icon.sparkle size={16} /></button>
      {open && (
        <div className='recipe-menu'>
          {!active ? recipes.map(r => (
            <button key={r.id} className='recipe-item' onClick={() => { if (r.params?.length) { setActive(r); setVals({}) } else { onUse(r.template); setOpen(false) } }}>
              <span className='recipe-name'>{r.name}</span>
              <span className='recipe-desc'>{r.desc}</span>
            </button>
          )) : (
            <div className='recipe-form'>
              <div className='recipe-form-title'>{active.name}</div>
              {active.params.map((p, i) => (
                <label key={p.name} className='recipe-field'>{p.label}
                  <input autoFocus={i === 0} placeholder={p.placeholder} value={vals[p.name] || ''} onChange={e => setVals(v => ({ ...v, [p.name]: e.target.value }))} onKeyDown={e => e.key === 'Enter' && use(active)} />
                </label>
              ))}
              <div className='row' style={{ marginTop: 8 }}>
                <button className='small-btn primary' onClick={() => use(active)}>Use</button>
                <button className='small-btn' onClick={() => setActive(null)}>Back</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function GroupPicker ({ agents, onStart, onCancel }) {
  const [sel, setSel] = useState([])
  const toggle = id => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])
  return (
    <div className='group-picker'>
      <div className='group-picker-title'>Pick 2 or more agents for a group chat</div>
      <div className='group-picker-list'>
        {agents.map(a => (
          <label key={a.id} className={'group-pick' + (sel.includes(a.id) ? ' on' : '')} style={{ '--ah': a.hue ?? 'var(--accent-h)' }}>
            <input type='checkbox' checked={sel.includes(a.id)} onChange={() => toggle(a.id)} />
            <span className='agent-avatar' style={{ color: glyphColor(a.hue, 0.68, 0.16) }}><AgentGlyph agent={a} size={16} /></span>
            {a.name}
          </label>
        ))}
      </div>
      <div className='row' style={{ justifyContent: 'center', marginTop: 12 }}>
        <button className='small-btn primary' disabled={sel.length < 2} onClick={() => onStart(sel)}>Start group chat</button>
        <button className='small-btn' onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

export default function Chat ({ session, live, todos = [], stats, approval, question, onAnswer, usage, error, models, agents = [], recipes = [], onSend, onStop, onApproval, onPickModel, onToggleTools, onToggleComputer, onTogglePlan, onSetCwd, onNew, onNewGroup, onTruncate, onRefreshModels, skillSuggestion, onReviewSkill, onDismissSuggestion, onOpenLibrary, rightOpen, onToggleRight, onMenu, approvalMode = 'ask', onCycleApproval, onFork, skills = [], onAddSkill, onRemoveSkill, serverHost, onSetEffort }) {
  // ⚠️ TOOLS RUN ON THE SERVER'S MAC. Computer control is the one where that is
  // dangerous rather than merely surprising: the mouse that moves, the keys that
  // get typed and the screen that is captured all belong to the machine running
  // Radiant — which you may not be sitting at, or able to see. Tony: "if the
  // devmbp is the host machine and im working on another Mac and i want to use
  // computer control will it act on the devmbp or the machine im typing into?"
  const onAnotherMac = Boolean(getServer().base)
  const [groupPicker, setGroupPicker] = useState(false)
  const [pickAgent, setPickAgent] = useState(false) // splash: reveal the agent picker
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState([])
  const [queued, setQueued] = useState([]) // messages typed mid-turn, sent as one follow-up when the turn settles
  const [designCapture, setDesignCapture] = useState(null) // {tag, outerHTML, css, screenshot, url} from Design Mode
  const [designBusy, setDesignBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef(null)
  const textareaRef = useRef(null)
  const scrollRef = useRef(null)
  const streaming = Boolean(live?.streaming)

  // grow the composer to fit what's typed or pasted (up to a cap, then it
  // scrolls internally) — no more hunting for a big block below a 2-row box
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 320) + 'px'
  }, [draft])

  // drain the mid-turn queue once the agent's turn settles (finished OR stopped)
  const wasStreaming = useRef(streaming)
  const streamedFor = useRef(null)   // which chat the settling turn belonged to
  useEffect(() => {
    if (shouldDrainQueue({
      wasStreaming: wasStreaming.current,
      streaming,
      streamedFor: streamedFor.current,
      sessionId: session?.id,
      queuedCount: queued.length
    })) {
      const text = queued.map(q => q.text).filter(Boolean).join('\n\n')
      const attachments = queued.flatMap(q => q.attachments || []).slice(0, 8)
      setQueued([])
      onSend({ text, attachments })
    }
    wasStreaming.current = streaming
    if (streaming) streamedFor.current = session?.id
  }, [streaming, queued, session])

  // a session switch abandons anything still queued for the old turn
  useEffect(() => { setQueued([]) }, [session?.id])

  // ⚠️ SKILLS HAD NO WAY IN. A skill was either on for every conversation or
  // bound to an agent, so one you want occasionally sat in every chat's system
  // prompt or nowhere. Slash already existed as the affordance and listed seven
  // fixed prompt templates instead. Skills come first now; picking one adds it
  // to THIS chat and it stays until removed.
  //
  // Disabled skills are listed deliberately: being invocable on demand is the
  // point, and it lets someone switch a skill off globally without losing it.
  const slashQuery = /^\/[\w-]*$/.test(draft) ? draft : null
  const slug = name => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const activeSkillIds = session?.skillIds || []   // session is null on the welcome screen
  const slashSkills = slashQuery
    ? skills
        .filter(sk => !activeSkillIds.includes(sk.id))
        .map(sk => ({ kind: 'skill', id: sk.id, cmd: '/' + slug(sk.name), desc: sk.description || 'Skill', enabled: sk.enabled }))
        .filter(c => c.cmd.startsWith(slashQuery))
        // ⚠️ ALPHABETICAL, NOT CONFIG ORDER. The list used to come out in
        // whatever order the skills happened to be stored in, which is no order
        // at all once there are more than a few. Tony: "i dont know what order
        // they are in now."
        .sort((a, b) => a.cmd.localeCompare(b.cmd))
    : []
  const slashPrompts = slashQuery
    ? SLASH_COMMANDS.filter(c => c.cmd.startsWith(slashQuery)).map(c => ({ ...c, kind: 'prompt' })).sort((a, b) => a.cmd.localeCompare(b.cmd))
    : []
  const slashMatches = [...slashSkills, ...slashPrompts]
  const applySlash = c => {
    // ⚠️ THE COMMAND GOES IN THE BOX. Hermes and Claude Code both work this way,
    // and Radiant's own /explain and /review already did — so silently attaching
    // the skill to the whole chat instead broke the one convention the user
    // already knew. Tony: "I assumed that when I picked it from the list, it
    // would insert it into the chat, and then I can send it to the agent."
    // Now it reads as a command you can see, edit and send.
    setDraft(c.kind === 'skill' ? c.cmd + ' ' : c.prompt)
    setTimeout(() => textareaRef.current?.focus(), 0)
  }

  // @-mention workspace files
  const atMatch = draft.match(/@([\w./-]*)$/)
  const [fileMatches, setFileMatches] = useState([])
  useEffect(() => {
    if (!atMatch || !session?.cwd) { setFileMatches([]); return }
    const t = setTimeout(() => api.searchFiles(session.cwd, atMatch[1]).then(setFileMatches).catch(() => setFileMatches([])), 150)
    return () => clearTimeout(t)
  }, [draft, session?.cwd])
  const applyFile = path => {
    setDraft(d => d.replace(/@[\w./-]*$/, '@' + path + ' '))
    setFileMatches([])
    setTimeout(() => textareaRef.current?.focus(), 0)
  }

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [session?.messages?.length, live, approval])

  const addFiles = async fileList => {
    const files = Array.from(fileList).slice(0, 8)
    const next = await Promise.all(files.map(readFileAsAttachment))
    setAttachments(a => [...a, ...next].slice(0, 8))
  }

  const submit = () => {
    let text = draft.trim()
    let atts = attachments
    // a Design-Mode capture rides along as context + a screenshot attachment
    if (designCapture) {
      const cssLines = Object.entries(designCapture.css || {}).map(([k, v]) => `  ${k}: ${v};`).join('\n')
      const ctx = `[Design capture from ${designCapture.url}]\nElement: <${designCapture.tag}>${designCapture.text ? `  — “${designCapture.text.trim().slice(0, 80)}”` : ''}\n\nHTML:\n\`\`\`html\n${designCapture.outerHTML}\n\`\`\`\n\nComputed styles:\n${cssLines}`
      text = text ? `${ctx}\n\n${text}` : `${ctx}\n\nRebuild this element in my project (match the styles above).`
      if (designCapture.screenshot) atts = [...atts, { kind: 'image', mime: designCapture.screenshot.mime, dataB64: designCapture.screenshot.dataB64, name: 'design-capture.png' }].slice(0, 8)
    }
    // ⚠️ RESOLVE THE COMMAND AT SEND, NOT AT PICK. A leading /slug is how the
    // user says which skill this message uses. It is stripped from what the
    // model reads — the skill's instructions arrive properly, in the briefing,
    // rather than as a bare word at the top of the request.
    let turnSkills = []
    const lead = /^\/([\w-]+)\s*/.exec(text)
    if (lead) {
      const hit = skills.find(sk => slug(sk.name) === lead[1])
      if (hit) {
        turnSkills = [hit.id]
        text = text.slice(lead[0].length).trim()
        if (!text) text = `Use the ${hit.name} skill.`
      }
    }
    if ((!text && !atts.length) || !session) return
    // mid-turn: park the message instead of blocking; it sends when the turn settles
    if (streaming) {
      setQueued(q => [...q, { text, attachments: atts, skillIds: turnSkills }])
      setDraft(''); setAttachments([]); setDesignCapture(null)
      return
    }
    setDraft('')
    onSend({ text, attachments: atts, skillIds: turnSkills })
    setAttachments([]); setDesignCapture(null)
  }

  // Design Mode: open a page in the controlled browser, then let the user click an element
  // ⚠️ NOT window.prompt — Electron throws "prompt() is not supported", so this
  // whole feature was inert in the packaged app while working in a browser.
  // The URL is asked for with an inline field in the composer instead.
  const [designAsk, setDesignAsk] = useState(null)   // the draft URL, or null
  const startDesign = () => setDesignAsk(designCapture?.url || 'https://')
  const runDesign = async (url) => {
    setDesignAsk(null)
    if (!url || !url.trim()) return
    setDesignBusy(true)
    try {
      await api.designOpen(url.trim())
      const { capture } = await api.designPick() // blocks until the user clicks an element
      if (capture) setDesignCapture(capture)
    } catch (e) { window.alert('Design capture failed: ' + e.message) }
    setDesignBusy(false)
  }

  // clicking an option in a decision-card widget sends it as the answer
  const onWidgetChoice = label => {
    if (!label || !session) return
    if (streaming) { setQueued(q => [...q, { text: label, attachments: [] }]); return }
    onSend({ text: label, attachments: [] })
  }

  if (!session) {
    return (
      <main className='main'>
        <button className='menu-btn' onClick={onMenu} title='Menu' aria-label='Open menu'><MenuIcon /></button>
        <div className='float-toggle'>
          <button className={'icon-btn' + (rightOpen ? ' on' : '')} onClick={onToggleRight} title='Show activity & terminal panel' data-tip={'Activity & terminal panel'} data-tip-below data-tip-end><Icon.panel /></button>
        </div>
        <div className='chat-scroll'>
          <div className='welcome'>
            <div className='logo-mark big-mark' aria-hidden />
            <div className='wordmark welcome-word'>Radiant</div>
            <div className='welcome-tagline'>A Templeton Technologies Product</div>
            {agents.length === 0
              ? <p style={{ marginTop: 26 }}><button className='small-btn primary' onClick={() => onNew()}>Start a session</button></p>
              : !pickAgent
                ? <div className='welcome-choices'>
                    <button className='welcome-choice' onClick={() => onNew(agents.find(a => a.id === 'agent-radiant') ? 'agent-radiant' : undefined)}>
                      <span className='welcome-choice-ico'><AgentGlyph agent={agents.find(a => a.id === 'agent-radiant') || agents[0]} size={22} /></span>
                      <span className='welcome-choice-title'>Start a quick chat</span>
                      <span className='welcome-choice-sub'>Jump straight in with Radiant, your all-purpose assistant.</span>
                    </button>
                    <button className='welcome-choice' onClick={() => setPickAgent(true)}>
                      <span className='welcome-choice-ico'><Icon.target size={22} /></span>
                      <span className='welcome-choice-title'>Work with an agent</span>
                      <span className='welcome-choice-sub'>Pick a ready-made specialist, start a group chat, or build your own.</span>
                    </button>
                  </div>
                : <>
                    <div className='welcome-pick-head'>
                      <button className='back-link' onClick={() => { setPickAgent(false); setGroupPicker(false) }}>← Back</button>
                      <span className='hint'>Choose an agent</span>
                    </div>
                    <div className='welcome-agents'>
                      {agents.filter(a => !isImported(a)).map(a => (
                        <button key={a.id} className='welcome-agent' style={{ '--ah': a.hue ?? 'var(--accent-h)' }} onClick={() => onNew(a.id)} title={a.persona || a.name}>
                          <span className='agent-avatar' style={{ color: glyphColor(a.hue, 0.68, 0.16) }}><AgentGlyph agent={a} size={18} /></span>
                          <span className='welcome-agent-text'>
                            <span className='welcome-agent-name'>{a.name}</span>
                            <span className='welcome-agent-desc'>{agentBlurb(a)}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                    {agents.some(isImported) && (
                      <div className='agent-divider'><span>Imported from other apps</span></div>
                    )}
                    <div className='welcome-agents'>
                      {agents.filter(isImported).map(a => (
                        <button key={a.id} className='welcome-agent welcome-agent-imported' onClick={() => onNew(a.id)} title={a.persona || a.name}>
                          <span className='agent-avatar'><AgentGlyph agent={a} size={18} /></span>
                          <span className='welcome-agent-text'>
                            <span className='welcome-agent-name'>{a.name}</span>
                            <span className='welcome-agent-desc'>{agentBlurb(a)}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                    <div className='welcome-pick-actions'>
                      {agents.length >= 2 && (groupPicker
                        ? <GroupPicker agents={agents} onStart={ids => { setGroupPicker(false); onNewGroup(ids) }} onCancel={() => setGroupPicker(false)} />
                        : <button className='group-chat-btn' onClick={() => setGroupPicker(true)}><Icon.users size={13} /> Start a group chat</button>)}
                      {!groupPicker && onOpenLibrary && <button className='group-chat-btn' onClick={onOpenLibrary}>◎ Browse the agent library</button>}
                    </div>
                  </>}
          </div>
        </div>
      </main>
    )
  }

  const toolsOn = session.useTools !== false
  const sessionAgent = agents.find(a => a.id === session.agentId) || null

  return (
    <main className='main'>
      <div className='topbar'>
        <button className='menu-btn' onClick={onMenu} title='Menu' aria-label='Open menu'><MenuIcon /></button>
        <div className='title'>{session.title}</div>
        <div className='spacer' />
        <StatsChip stats={stats} />
        <button
          className='cwd-chip'
          title={session.cwd}
          data-tip={'Workspace folder — the agent reads &\nwrites here. Click to change.'} data-tip-below data-tip-end
          onClick={async () => {
            const next = window.radiantNative?.pickFolder
              ? await window.radiantNative.pickFolder(session.cwd)
              : window.prompt('Workspace folder for this session:', session.cwd)
            if (next) onSetCwd(next)
          }}
        >
          <Icon.folder size={13} />
          <span className='cwd-path'>{session.cwd?.replace(/^\/Users\/[^/]+/, '~')}</span>
        </button>
        <button className='icon-btn' onClick={() => exportSessionMarkdown(session)} title='Export this conversation as a Markdown file' data-tip='Export chat as Markdown' data-tip-below data-tip-end><Icon.download /></button>
        <button className={'icon-btn' + (rightOpen ? ' on' : '')} onClick={onToggleRight} title='Show activity & terminal panel' data-tip={'Activity & terminal panel\n(tool runs, output, terminal)'} data-tip-below data-tip-end><Icon.panel /></button>
      </div>

      {session.group && Array.isArray(session.participants) && session.participants.length > 0 && (
        <div className='group-roster' title='Agents in this group chat'>
          <span className='group-roster-label'><Icon.users size={13} /> Group</span>
          {session.participants.map(id => {
            const a = agents.find(x => x.id === id)
            if (!a) return null
            return (
              <span key={id} className='group-roster-chip'>
                <span className='group-roster-ico' style={{ color: glyphColor(a.hue, 0.7, 0.16) }}><AgentGlyph agent={a} size={13} /></span>
                {a.name}
              </span>
            )
          })}
        </div>
      )}

      <div className='chat-scroll' ref={scrollRef}>
        <div className='chat-inner'>
          {session.messages.map((m, i) =>
            m.compacted
              ? <CompactedMarker key={i} text={m.text} />
              : m.role === 'user'
              ? <div key={i} className='msg msg-user'>
                  <div className='bubble'>
                    {(m.attachments || []).length > 0 && (
                      <div className='msg-attach'>
                        {m.attachments.map((a, j) => a.kind === 'image'
                          ? <img key={j} src={`data:${a.mime};base64,${a.dataB64}`} alt={a.name} />
                          : <span key={j} className='msg-attach-file'><Icon.file size={13} /> {a.name}</span>)}
                      </div>
                    )}
                    {m.text}
                  </div>
                  {(onFork || onTruncate) && !live && (
                    <div className='msg-tools'>
                      {onFork && (
                        <button className='rewind-btn branch-btn' title='Branch — copy this chat up to here into a new one, leaving this one alone'
                          onClick={() => onFork(i)}>
                          <Icon.branch size={12} /> branch
                        </button>
                      )}
                      {onTruncate && (
                        <button className='rewind-btn' title='Rewind — edit this and retry (removes messages after it)' onClick={async () => {
                          if (!window.confirm('Rewind to here? This removes the messages after this point so you can edit and retry.')) return
                          await onTruncate(i); setDraft(m.text); setTimeout(() => textareaRef.current?.focus(), 0)
                        }}>↺ edit &amp; retry</button>
                      )}
                    </div>
                  )}
                </div>
              : <AssistantMessage key={i} parts={m.parts || []} model={m.model} agent={m.agentId ? agents.find(a => a.id === m.agentId) || sessionAgent : sessionAgent} onChoose={onWidgetChoice} />
          )}
          {live && (
            <AssistantMessage
              agent={live.agentId ? agents.find(a => a.id === live.agentId) || sessionAgent : sessionAgent}
              model={session.model}
              local={['ollama', 'lmstudio'].includes(session.provider)}
              parts={live.parts}
              thinking={live.thinking}
              thinkingActive={live.thinkingActive}
              thinkingSecs={live.thinkingSecs}
              streaming={live.streaming}
              onChoose={onWidgetChoice}
            />
          )}
          {approval && (
            <div className='approval-card'>
              <div className='q'>Run this command in <span className='mono'>{session.cwd?.replace(/^\/Users\/[^/]+/, '~')}</span>?</div>
              <code>{approval.args?.command}</code>
              <div className='row'>
                <button className='small-btn primary' onClick={() => onApproval(approval.id, true)}>Run it</button>
                <button className='small-btn danger' onClick={() => onApproval(approval.id, false)}>Deny</button>
              </div>
            </div>
          )}
          {question && <QuestionCard question={question} onAnswer={onAnswer} />}
          {error && <div className='error-note'>⚠ {error}</div>}
        </div>
      </div>

      {skillSuggestion && (
        <div className='skill-suggest'>
          <span className='skill-suggest-ico'><Icon.sparkle size={15} /></span>
          <div className='skill-suggest-body'>
            <div className='skill-suggest-title'>Save this as a skill?</div>
            <div className='skill-suggest-text'>{skillSuggestion.rationale || `I drafted a reusable skill: “${skillSuggestion.name}”.`} It's waiting in Skills settings for you to review.</div>
          </div>
          <button className='skill-suggest-review' onClick={onReviewSkill}>Review “{skillSuggestion.name}”</button>
          <button className='skill-suggest-x' onClick={onDismissSuggestion} title='Not now'>✕</button>
        </div>
      )}
      <div className='composer'>
        <TodoChecklist todos={todos} />
        {designAsk !== null && (
          <div className='design-ask'>
            <Icon.target size={13} />
            <input
              className='inline-edit'
              autoFocus
              defaultValue={designAsk}
              placeholder='https://example.com'
              onKeyDown={e => {
                if (e.key === 'Enter') runDesign(e.currentTarget.value)
                if (e.key === 'Escape') setDesignAsk(null)
              }}
            />
            <span className='design-ask-hint'>Enter to open · Esc to cancel</span>
          </div>
        )}
        {designCapture && (
          <div className='design-capture'>
            {designCapture.screenshot && <img className='design-capture-thumb' src={`data:${designCapture.screenshot.mime};base64,${designCapture.screenshot.dataB64}`} alt='captured element' />}
            <div className='design-capture-body'>
              <div className='design-capture-title'><Icon.target size={12} /> Design capture · <span className='mono'>&lt;{designCapture.tag}&gt;</span></div>
              <div className='design-capture-sub'>{(designCapture.url || '').replace(/^https?:\/\//, '').slice(0, 60)} — sends with your next message as HTML + CSS + screenshot</div>
            </div>
            <button className='design-capture-x' onClick={() => setDesignCapture(null)} title='Discard capture'>✕</button>
          </div>
        )}
        {queued.length > 0 && (
          <div className='queued-strip' title='Sends as one follow-up when the agent finishes this turn'>
            <span className='queued-label'>↳ Queued</span>
            {queued.map((q, i) => (
              <span key={i} className='queued-chip'>
                <span className='queued-text'>{q.text || `${q.attachments?.length || 0} attachment(s)`}</span>
                <button className='queued-x' onClick={() => setQueued(list => list.filter((_, j) => j !== i))} title='Remove'>✕</button>
              </span>
            ))}
          </div>
        )}
        <div
          className={'composer-box' + (dragOver ? ' drag-over' : '') + (streaming ? ' working' : '')}
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files) }}
        >
          {attachments.length > 0 && (
            <div className='attach-strip'>
              {attachments.map((a, i) => (
                <div key={i} className='attach-chip' title={a.name}>
                  {a.kind === 'image'
                    ? <img src={`data:${a.mime};base64,${a.dataB64}`} alt={a.name} />
                    : <span className='attach-file'><Icon.file size={13} /></span>}
                  <span className='attach-name'>{a.name}</span>
                  <button className='attach-x' onClick={() => setAttachments(list => list.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
            </div>
          )}
          {slashMatches.length > 0 && (
            <div className='slash-menu'>
              {/* ⚠️ TWO SORTED RUNS LOOK LIKE ONE UNSORTED LIST. Skills and
                  built-in commands are each alphabetical, but rendered flat the
                  list ran a→w and then started again at c, which reads as no
                  order at all. Tony: "stil not alphabetical." The headings make
                  the reset visibly deliberate. */}
              {slashMatches.map((c, i) => (
                <React.Fragment key={c.kind + c.cmd}>
                  {(i === 0 || slashMatches[i - 1].kind !== c.kind) && (
                    <div className='slash-group'>{c.kind === 'skill' ? 'Skills' : 'Commands'}</div>
                  )}
                  <button className={'slash-item' + (c.kind === 'skill' ? ' is-skill' : '')} onMouseDown={e => { e.preventDefault(); applySlash(c) }}>
                    <span className='slash-cmd'>{c.cmd}</span>
                    {c.kind === 'skill' && <span className='slash-kind'>skill{c.enabled ? '' : ' · off elsewhere'}</span>}
                    <span className='slash-desc'>{c.desc}</span>
                  </button>
                </React.Fragment>
              ))}
            </div>
          )}
          {atMatch && fileMatches.length > 0 && (
            <div className='slash-menu'>
              {fileMatches.map(f => (
                <button key={f} className='slash-item' onMouseDown={e => { e.preventDefault(); applyFile(f) }}>
                  <span className='slash-cmd' style={{ minWidth: 0 }}>@</span>
                  <span className='slash-desc mono' style={{ fontSize: 12 }}>{f}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            rows={2}
            placeholder={dragOver ? 'Drop files to attach…' : streaming ? 'Type a follow-up — it queues and sends when the agent finishes…' : toolsOn ? 'Ask the agent to build, fix, or explain something…  (type / for commands)' : 'Chat (tools off)…'}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onPaste={e => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); addFiles(files) } }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                if (slashMatches.length) { e.preventDefault(); applySlash(slashMatches[0]); return }
                e.preventDefault(); submit()
              }
            }}
          />
          <div className='composer-row'>
            <div className='composer-tools'>
              <input
                ref={fileInputRef} type='file' multiple hidden
                onChange={e => { if (e.target.files.length) addFiles(e.target.files); e.target.value = '' }}
              />
              
              <button className='attach-btn' onClick={() => fileInputRef.current?.click()} title='Attach files or images' data-tip='Attach files or images'><Icon.plus size={17} /></button>
              <button className={'attach-btn' + (designBusy ? ' is-capturing' : '')} onClick={startDesign} disabled={designBusy} title='Design Mode' data-tip={'Design Mode — open a web page and click\nan element to capture its HTML, CSS &\na screenshot as context'}><Icon.target size={16} /></button>
              {activeSkillIds.length > 0 && activeSkillIds.map(id => {
                const sk = skills.find(x => x.id === id)
                return (
                  <span key={id} className='chat-skill' title={sk?.description || 'Skill active in this chat'}>
                    {sk?.name || 'skill'}
                    <button className='chat-skill-x' onClick={() => onRemoveSkill?.(id)} title='Remove from this chat'>×</button>
                  </span>
                )
              })}
              <RecipeMenu recipes={recipes} onUse={text => { setDraft(text); setTimeout(() => textareaRef.current?.focus(), 0) }} />
              <ModelPicker session={session} models={models} onPick={onPickModel} onRefresh={onRefreshModels}
                  effort={session.effort}
                  onSetEffort={onSetEffort}
                />
              <button
                className={'pill-toggle' + (toolsOn ? ' on' : '')}
                onClick={onToggleTools}
                data-tip={'Agent tools: read/write files and run\ncommands in the workspace folder.\nClick to turn ' + (toolsOn ? 'off' : 'on') + '.'}
              >
                <Icon.wrench size={13} />
                tools {toolsOn ? 'on' : 'off'}
              </button>
              <button
                className={'pill-toggle' + (session.computerControl ? ' on' : '')}
                onClick={onToggleComputer}
                data-tip={'Computer control: the model drives the browser\nand desktop of ' + (onAnotherMac ? serverHost : 'this Mac') + '.\nNeeds a vision model + macOS permissions.\nClick to turn ' + (session.computerControl ? 'off' : 'on')}
              >
                <Icon.monitor size={13} /> computer {session.computerControl ? 'on' : 'off'}
                  {onAnotherMac && session.computerControl && <span className='pill-where'> · {serverHost}</span>}
              </button>
              <button
                className={'pill-toggle' + (session.planMode ? ' on' : '')}
                onClick={onTogglePlan}
                data-tip={'Plan mode: the agent researches and proposes a\nplan for your approval before changing anything.\nClick to turn ' + (session.planMode ? 'off' : 'on') + '.'}
              >
                <Icon.clipboard size={13} /> plan {session.planMode ? 'on' : 'off'}
              </button>
                
              <button
                className={'pill-toggle' + (approvalMode === 'off' ? ' warn' : approvalMode === 'auto' ? ' on' : '')}
                onClick={onCycleApproval}
                data-tip={'Permissions — what the agent may do without asking:\n• Ask each: confirm every command (safest)\n• Auto: run low-risk commands, ask for risky ones\n• Allow all: never ask (fastest, least safe)\nClick to cycle.'}
              >
                {approvalMode === 'off' ? <><Icon.unlock size={13} /> allow all</> : approvalMode === 'auto' ? <><Icon.zap size={13} /> auto approve</> : <><Icon.hand size={13} /> ask each</>}
              </button>
            </div>
            <div className='composer-actions'>
              {usage && (usage.input || usage.output) ? (
                <ContextGauge usage={usage} model={session.model} />
              ) : null}
              {streaming
                ? <>
                    {(draft.trim() || attachments.length) ? <button className='send-btn queue' onClick={submit} title='Queue this — sends when the agent finishes'><Icon.arrowUp size={17} /></button> : null}
                    <button className='send-btn stop' onClick={onStop} title='Stop generating'><Icon.stop size={15} /></button>
                  </>
                : <button className='send-btn' onClick={submit} disabled={!draft.trim() && !attachments.length} title='Send message'><Icon.arrowUp size={17} /></button>}
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}

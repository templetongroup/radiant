import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { ModelPicker } from './Chat.jsx'
import LoopDiagram from './LoopDiagram.jsx'
import PathPicker from './PathPicker.jsx'

/**
 * A loop: one goal, several steps, and a check on each.
 *
 * ⚠️ WITHOUT THE CHECK THIS IS THE BOARD WITH A DIFFERENT ICON. A task is done
 * when the model stops talking, which is not the same as done. A loop step is
 * done when a condition you wrote in plain English is met — judged in a separate
 * turn, by a second agent if you name one — and a step that fails goes round
 * again carrying the reason it failed. That retry is the whole idea.
 *
 * ⚠️ AND IT RUNS THROUGH THE ORDINARY CHAT. The server never runs a turn for a
 * loop; it answers "here is the next turn" and this hands it to the chat view,
 * which streams it exactly as it streams anything else. Approvals, steering,
 * tools and the transcript all keep working because none of them are reimplemented
 * here. It also means you can watch it, which is most of why you would trust it.
 */

const STEP_LOOK = {
  pending: { label: 'Waiting', cls: 'is-pending' },
  working: { label: 'Working', cls: 'is-working' },
  checking: { label: 'Checking', cls: 'is-checking' },
  passed: { label: 'Passed', cls: 'is-passed' },
  failed: { label: 'Failed', cls: 'is-failed' },
  skipped: { label: 'Skipped', cls: 'is-skipped' }
}

const LOOP_LOOK = {
  idle: 'Not running',
  running: 'Running',
  blocked: 'Stuck',
  failed: 'Stopped — a step could not pass its check',
  done: 'Finished'
}

/**
 * ⚠️ A LOOP CAN NOW FAIL WITH EVERY STEP PASSED. The goal check is the whole
 * point of that: each unit was correct and the run still did not achieve
 * anything. Saying "a step could not pass its check" there sends the reader
 * hunting for a failed step, finds them all green, and reads as a bug in the app
 * rather than a verdict about the work.
 */
function loopLabel (loop) {
  if (loop.state !== 'failed') return LOOP_LOOK[loop.state]
  return loop.steps.some(s => s.state === 'failed')
    ? LOOP_LOOK.failed
    : 'Stopped — every step passed but the goal did not'
}

// Four stages, and the order is the argument: what you want, how it breaks up,
// how you will know it worked, and then a chance to read it back before anything
// exists.
const STAGES = [
  { id: 'goal', label: 'The goal' },
  { id: 'steps', label: 'The steps' },
  { id: 'finish', label: 'Done, and how often' },
  { id: 'review', label: 'Check it over' }
]

// How often a loop may start itself. `0` is the honest default: nothing runs
// until you press Run.
const EVERY = [
  { id: 0, label: 'Only when I run it' },
  { id: 15, label: 'Every 15 min' },
  { id: 60, label: 'Hourly' },
  { id: 60 * 24, label: 'Daily' }
]

// ⚠️ NARROW ON PURPOSE, AND DELIBERATELY NOT THE SERVER'S commandRisk. That one
// answers "does this need an approval prompt", and it answers by allowlist —
// which makes `npm test` high risk, so wiring it in here would fire a warning on
// the single most common check anybody writes and teach people to ignore it.
// This asks a smaller question: does the thing you are about to run unattended,
// on a timer, look like it CHANGES something? A check should only ever read.
const DESTRUCTIVE = /\brm\s+-|\bsudo\b|\bdd\s+if=|\bmkfs|\bshutdown\b|\breboot\b|\bgit\s+push\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\b|\bnpm\s+publish\b|\byarn\s+publish\b|>\s*\/(dev|etc|usr|bin|sys)\b|\|\s*(sudo\s+)?(sh|bash|zsh)\b/i

const blankStep = () => ({ title: '', prompt: '', check: '', checkCommand: '', agentId: null, model: null, provider: null, checkAgentId: null, maxAttempts: 3 })

/** Does anything at all verify this step? */
const isChecked = s => Boolean((s.check || '').trim() || (s.checkCommand || '').trim())

// "every 1 hour" is not how anyone says it. One of anything drops the number.
const everyLabel = mins => {
  const unit = (n, word) => (n === 1 ? word : `${n} ${word}s`)
  if (mins % (60 * 24) === 0) return unit(mins / (60 * 24), 'day')
  if (mins % 60 === 0) return unit(mins / 60, 'hour')
  return `${mins} min`
}

function whoLabel (step, agents) {
  if (step.agentId) {
    const a = agents.find(x => x.id === step.agentId)
    return a ? a.name : 'Missing agent'
  }
  return step.model || 'Default model'
}

/** One row of the run: what it is, who does it, and what "done" means. */
function StepRow ({ step, index, agents, running, onOpen }) {
  const look = STEP_LOOK[step.state] || STEP_LOOK.pending
  const attemptsShown = step.attempts > 1 || step.state === 'failed'
  return (
    <li className={'lp-step ' + look.cls + (running ? ' is-current' : '')}>
      <div className='lp-step-n'>{index + 1}</div>
      <div className='lp-step-main'>
        <div className='lp-step-head'>
          <h4 className='lp-step-title'>{step.title}</h4>
          <span className='lp-step-state'>{look.label}</span>
        </div>
        <div className='lp-step-who'>
          {whoLabel(step, agents)}
          {step.checkAgentId && (
            <span className='lp-step-checker'>
              · checked by {agents.find(a => a.id === step.checkAgentId)?.name || 'a missing agent'}
            </span>
          )}
          {attemptsShown && <span className='lp-step-tries'>· attempt {step.attempts} of {step.maxAttempts}</span>}
        </div>
        {/* The deterministic half first, because that is the order it runs in
            and the order it deserves to be read in. */}
        {step.checkCommand && (
          <div className='lp-step-check'><span className='lp-check-lead'>Passes when</span> <code>{step.checkCommand}</code> exits 0</div>
        )}
        {step.check && (
          <div className='lp-step-check'><span className='lp-check-lead'>{step.checkCommand ? 'and when' : 'Passes when'}</span> {step.check}</div>
        )}
        {/* ⚠️ SAY IT OUT LOUD. A step with no condition is finished the moment
            the model stops, which is exactly the weakness a loop exists to fix.
            Silently treating that as success is how the layer becomes theatre. */}
        {!isChecked(step) && (
          <div className='lp-step-check lp-step-nocheck'>No check — this step is done when the agent stops. Nothing verifies it.</div>
        )}
        {step.lastFail && step.state !== 'passed' && (
          <div className='lp-step-fail'>{step.blocked ? 'Stopped — the check says no further attempt can pass: ' : 'Last check said: '}{step.lastFail}</div>
        )}
        {step.sessionId && (
          <button className='lp-mini' onClick={() => onOpen?.(step.sessionId)}>Open its chat</button>
        )}
      </div>
    </li>
  )
}

/** The editor for one step, used both when building a loop and when changing it. */
function StepEditor ({ step, index, agents, pickable, onChange, onRemove, onRefreshModels, canRemove }) {
  const set = patch => onChange({ ...step, ...patch })
  const who = { model: step.agentId ? (agents.find(a => a.id === step.agentId)?.name || null) : step.model, provider: step.agentId ? 'agent' : step.provider }
  const checker = { model: step.checkAgentId ? (agents.find(a => a.id === step.checkAgentId)?.name || null) : null, provider: step.checkAgentId ? 'agent' : null }
  return (
    <div className='lp-edit'>
      <div className='lp-edit-head'>
        <span className='lp-edit-n'>Step {index + 1}</span>
        {canRemove && <button type='button' className='lp-mini lp-mini-quiet' onClick={() => onRemove()} aria-label={`Remove step ${index + 1}`}>Remove</button>}
      </div>
      <input
        className='lp-input'
        placeholder='What this step does'
        value={step.title}
        onChange={e => set({ title: e.target.value })}
        aria-label={`Step ${index + 1} title`}
      />
      <textarea
        className='lp-input lp-area'
        placeholder='Anything else the agent should know (optional)'
        value={step.prompt}
        onChange={e => set({ prompt: e.target.value })}
        aria-label={`Step ${index + 1} detail`}
        rows={2}
      />
      {/* ⚠️ THE COMMAND GOES ABOVE THE SENTENCE, because that is the order it
          runs in and the order it deserves. This box used to say "e.g. npm test
          exits 0" and then hand the question to a model — the app recommending a
          condition a program could evaluate and then guessing at it. */}
      <label className='lp-field'>
        <span className='lp-field-label'>This step passes when this command exits 0 <i>(optional)</i></span>
        <input
          className='lp-input lp-check-input lp-cmd-input'
          placeholder='e.g. npm test'
          value={step.checkCommand || ''}
          onChange={e => set({ checkCommand: e.target.value })}
          aria-label={`Step ${index + 1} check command`}
          spellCheck={false}
        />
        <span className='lp-field-hint'>
          {step.checkCommand.trim()
            ? 'Runs in the working folder. Exit 0 passes; anything else fails, and what it printed goes back with the retry as the evidence. It is checked before any agent is asked, so a failing command costs nothing.'
            : 'A command that exits 0 is the only kind of check that cannot be argued with. Two models agreeing is not a check.'}
        </span>
        {DESTRUCTIVE.test(step.checkCommand || '') && (
          <span className='lp-warn lp-warn-inline'>
            That looks like it changes something. A check should only read — and on a schedule it runs with nobody watching.
          </span>
        )}
      </label>
      <label className='lp-field'>
        <span className='lp-field-label'>…and when an agent agrees that <i>(optional)</i></span>
        <input
          className='lp-input lp-check-input'
          placeholder='e.g. the export handles empty rows and is covered by a test'
          value={step.check}
          onChange={e => set({ check: e.target.value })}
          aria-label={`Step ${index + 1} check`}
        />
        {/* The single most useful sentence in this whole feature, so it is next to
            the box rather than in a Read me nobody has open. */}
        <span className='lp-field-hint'>
          {step.check.trim()
            ? 'Name something checkable. "It looks right" is an opinion, and an opinion is what a loop exists to replace.'
            : step.checkCommand.trim()
              ? 'Fine to leave empty — the command above is the check, and it is the stronger of the two.'
              : 'Leave both empty and this step is done the moment the agent stops talking. Nothing will verify it.'}
        </span>
      </label>
      <div className='lp-edit-foot'>
        <label className='lp-pick'>
          <span>Does it</span>
          <ModelPicker
            session={who}
            models={pickable}
            onPick={m => (m.provider === 'agent'
              ? set({ agentId: agents.find(a => a.name === m.id)?.id || null, model: null, provider: null })
              : set({ agentId: null, model: m.id, provider: m.provider }))}
            onRefresh={() => onRefreshModels?.()}
          />
        </label>
        {/* ⚠️ THE SAME AGENT GRADING ITSELF IS THE WEAK VERSION, and it is the
            default because a second agent costs another run. Naming one here is
            the difference between a check and marking your own homework. */}
        <label className='lp-pick'>
          <span>Checks it</span>
          <ModelPicker
            session={checker}
            models={[{ id: 'The same agent', provider: 'agent', providerName: 'Agents' }, ...pickable.filter(p => p.provider === 'agent')]}
            onPick={m => set({ checkAgentId: m.id === 'The same agent' ? null : (agents.find(a => a.name === m.id)?.id || null) })}
            onRefresh={() => onRefreshModels?.()}
          />
        </label>
        <label className='lp-tries'>
          <span>Try up to</span>
          <input
            type='number' min='1' max='10'
            value={step.maxAttempts}
            onChange={e => set({ maxAttempts: Number(e.target.value) })}
            aria-label={`Step ${index + 1} maximum attempts`}
          />
        </label>
      </div>
    </div>
  )
}

export default function LoopBoard ({
  agents = [], models = [], projects = [], defaultCwd = '',
  runningLoopId = null, runningStepId = null,
  onRun, onStop, onOpenSession, onError, onRefreshModels
}) {
  const [loops, setLoops] = useState([])
  const [loading, setLoading] = useState(true)
  const [composing, setComposing] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState({ title: '', detail: '', cwd: '', steps: [blankStep()], goalCheck: '', goalCommand: '', maxPasses: 1, everyMinutes: 0 })
  // ⚠️ ONE QUESTION AT A TIME. The first version put the goal, the folder, every
  // step, every model and every check on one screen — which is a form, not an
  // explanation, and a loop is a new idea that needs one. Tony asked for a
  // walkthrough. The stages are also where the guidance lives: the sentence about
  // what makes a good check belongs beside the box you type it in, not in a
  // Read me nobody has open.
  const [stage, setStage] = useState(0)
  const titleRef = useRef(null)

  const refresh = useCallback(async () => {
    try { setLoops(await api.listLoops()) } catch (e) { onError?.(e.message) } finally { setLoading(false) }
  }, [onError])

  useEffect(() => { refresh() }, [refresh])
  // A loop's steps move while turns run in the chat view, so this has to look
  // again — the same reason the board polls.
  useEffect(() => {
    const t = setInterval(refresh, 4000)
    return () => clearInterval(t)
  }, [refresh])
  useEffect(() => { if (composing && stage === 0) titleRef.current?.focus() }, [composing, stage])

  const pickable = useMemo(() => [
    ...agents.map(a => ({ id: a.name, provider: 'agent', providerName: 'Agents', agentId: a.id })),
    ...models
  ], [agents, models])

  const startDraft = () => {
    setDraft({ title: '', detail: '', cwd: defaultCwd || '', steps: [blankStep()], goalCheck: '', goalCommand: '', maxPasses: 1, everyMinutes: 0 })
    setEditingId(null)
    setStage(0)
    setComposing(true)
  }

  const editLoop = loop => {
    setDraft({
      title: loop.title,
      detail: loop.detail || '',
      cwd: loop.cwd || '',
      steps: loop.steps.map(s => ({ ...s, checkCommand: s.checkCommand || '' })),
      goalCheck: loop.goalCheck || '',
      goalCommand: loop.goalCommand || '',
      maxPasses: loop.maxPasses || 1,
      everyMinutes: loop.schedule?.everyMinutes || 0
    })
    setEditingId(loop.id)
    // Editing an existing loop starts on the steps: you know what it is for.
    setStage(1)
    setComposing(true)
  }

  const saveDraft = async e => {
    e?.preventDefault?.()
    const steps = draft.steps.filter(s => s.title.trim())
    if (!draft.title.trim() || !steps.length) return
    const body = {
      title: draft.title.trim(),
      detail: draft.detail.trim(),
      cwd: draft.cwd.trim() || null,
      steps,
      goalCheck: draft.goalCheck.trim(),
      goalCommand: draft.goalCommand.trim(),
      // ⚠️ ONE PASS UNLESS A GOAL CHECK EXISTS TO SEND IT BACK. Passes with
      // nothing judging them is just the same work twice at twice the price.
      maxPasses: (draft.goalCheck.trim() || draft.goalCommand.trim()) ? draft.maxPasses : 1,
      schedule: draft.everyMinutes > 0 ? { everyMinutes: draft.everyMinutes } : null
    }
    try {
      if (editingId) await api.patchLoop(editingId, body)
      else await api.createLoop(body)
      setComposing(false); setEditingId(null)
      refresh()
    } catch (err) { onError?.(err.message) }
  }

  const remove = async loop => {
    try { await api.deleteLoop(loop.id); refresh() } catch (err) { onError?.(err.message) }
  }

  const setStep = (i, next) => setDraft(d => ({ ...d, steps: d.steps.map((s, j) => (j === i ? next : s)) }))
  const addStep = () => setDraft(d => ({ ...d, steps: [...d.steps, blankStep()] }))
  const removeStep = i => setDraft(d => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }))

  const uncheckedSteps = draft.steps.filter(s => s.title.trim() && !isChecked(s)).length
  const hasGoal = Boolean(draft.goalCheck.trim() || draft.goalCommand.trim())
  // ⚠️ NEXT IS DISABLED, NOT SILENTLY BROKEN. A walkthrough that lets you past a
  // stage you have not filled in and then refuses at the end is worse than a form.
  const stageReady = stage === 0
    ? Boolean(draft.title.trim())
    // Stage 2 is all optional — a loop with no goal check is the old behaviour,
    // and refusing to move past a stage that asks for nothing is a dead end.
    : stage === 2 ? true : draft.steps.some(s => s.title.trim())
  // Next, Create, and Enter in a field are all the same move.
  const advance = () => {
    if (!stageReady) return
    if (stage < STAGES.length - 1) setStage(n => n + 1)
    else saveDraft()
  }

  return (
    <section className='lp' aria-label='Loops'>
      <header className='lp-head'>
        <h2 className='lp-title'>Loops</h2>
        <p className='lp-sub'>
          A run of steps with a check on each. A step that fails its check goes
          round again with the reason attached — and a check can be a command that
          has to exit 0, which is the only kind that cannot be argued with. Steps
          run as ordinary chats, so a loop waits at an approval prompt like
          anything else does.
        </p>
      </header>
      <div className='view-actions'>
        <button className='rx-btn rx-btn-go' onClick={() => (composing ? setComposing(false) : startDraft())}>
          {composing ? 'Cancel' : 'New loop'}
        </button>
      </div>

      {/* ⚠️ REFERENCE, NOT DECORATION — so it goes away once you are working. It
          is here because "loop" is a word people think they already know; the
          picture is what makes the difference from a task list land. */}
      {!composing && <LoopDiagram />}

      {composing && (
        <form className='lp-compose' onSubmit={e => { e.preventDefault(); advance() }}>
          {/* Where you are, and how much is left. Three stages, always three. */}
          <ol className='lp-stages'>
            {STAGES.map((st, i) => (
              <li key={st.id} className={'lp-stage' + (i === stage ? ' on' : '') + (i < stage ? ' done' : '')}>
                <span className='lp-stage-n'>{i + 1}</span>
                <span className='lp-stage-label'>{st.label}</span>
              </li>
            ))}
          </ol>

          {stage === 0 && (
            <div className='lp-panel'>
              <h3 className='lp-panel-title'>What are you building?</h3>
              <p className='lp-panel-lead'>
                One sentence, the way you would say it to a person. The steps come next.
              </p>
              <input
                ref={titleRef}
                className='lp-input lp-input-lead'
                placeholder='e.g. Add CSV export to the reports page'
                value={draft.title}
                onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
                aria-label='Loop goal'
              />
              <label className='lp-field'>
                <span className='lp-field-label'>Anything every step should know <i>(optional)</i></span>
                <textarea
                  className='lp-input lp-area'
                  placeholder='e.g. The reports live in src/reports. Do not touch the API.'
                  value={draft.detail}
                  onChange={e => setDraft(d => ({ ...d, detail: e.target.value }))}
                  aria-label='Loop detail'
                  rows={2}
                />
              </label>
              <label className='lp-field'>
                <span className='lp-field-label'>Which folder should it work in?</span>
                <PathPicker
                  value={draft.cwd}
                  onChange={cwd => setDraft(d => ({ ...d, cwd }))}
                  projects={projects}
                  label='Working folder'
                />
              </label>
            </div>
          )}

          {stage === 1 && (
            <div className='lp-panel'>
              <h3 className='lp-panel-title'>Break it into steps</h3>
              <p className='lp-panel-lead'>
                Each step is one job, run in its own conversation, in order. Give every
                step a condition it has to meet — that is what makes this a loop and
                not a list.
              </p>
              {draft.steps.map((st, i) => (
                <StepEditor
                  key={st.id || i}
                  step={st}
                  index={i}
                  agents={agents}
                  pickable={pickable}
                  canRemove={draft.steps.length > 1}
                  onChange={next => setStep(i, next)}
                  onRemove={() => removeStep(i)}
                  onRefreshModels={onRefreshModels}
                />
              ))}
              <button type='button' className='rx-btn rx-btn-sm' onClick={addStep}>+ Add another step</button>
            </div>
          )}

          {stage === 2 && (
            <div className='lp-panel'>
              <h3 className='lp-panel-title'>How you will know it worked</h3>
              {/* ⚠️ THIS IS THE CEILING OF THE STEP-WISE LOOP, STATED ON THE
                  SCREEN. Each step verifying itself makes each unit correct and
                  cannot notice the units were the wrong ones — a very good agent
                  running the wrong three steps, every one of them checked. */}
              <p className='lp-panel-lead'>
                Every step passing is not the same as the goal being met. A goal check
                judges the whole run once at the end; when it fails, the loop starts
                over from step one carrying the reason. All of this is optional — leave
                it empty and the loop finishes when the last step passes.
              </p>
              <label className='lp-field'>
                <span className='lp-field-label'>The goal is met when this command exits 0 <i>(optional)</i></span>
                <input
                  className='lp-input lp-check-input lp-cmd-input'
                  placeholder='e.g. npm run build && npm test'
                  value={draft.goalCommand}
                  onChange={e => setDraft(d => ({ ...d, goalCommand: e.target.value }))}
                  aria-label='Goal check command'
                  spellCheck={false}
                />
                {DESTRUCTIVE.test(draft.goalCommand) && (
                  <span className='lp-warn lp-warn-inline'>
                    That looks like it changes something. A check should only read.
                  </span>
                )}
              </label>
              <label className='lp-field'>
                <span className='lp-field-label'>…and when an agent agrees that <i>(optional)</i></span>
                <input
                  className='lp-input lp-check-input'
                  placeholder='e.g. a user can export a report and open it in Excel'
                  value={draft.goalCheck}
                  onChange={e => setDraft(d => ({ ...d, goalCheck: e.target.value }))}
                  aria-label='Goal check'
                />
                <span className='lp-field-hint'>
                  Judged in its own conversation, reading the work rather than continuing it.
                </span>
              </label>
              {hasGoal && (
                <label className='lp-tries lp-field'>
                  <span className='lp-field-label'>If the goal is not met, run the whole loop again up to</span>
                  <input
                    type='number' min='1' max='10'
                    value={draft.maxPasses}
                    onChange={e => setDraft(d => ({ ...d, maxPasses: Number(e.target.value) }))}
                    aria-label='Maximum passes'
                  />
                  <span className='lp-field-hint'>
                    {draft.maxPasses > 1
                      ? 'times in total. Each pass is every step again, so this multiplies what the loop costs.'
                      : 'times in total — which is once, so the check reports and does not retry. Raise it and a missed goal sends the loop back to step one.'}
                  </span>
                </label>
              )}

              <h3 className='lp-panel-title lp-panel-title-2'>When should it run?</h3>
              <div className='lp-every' role='group' aria-label='How often this loop runs'>
                {EVERY.map(o => (
                  <button
                    key={o.id} type='button'
                    className={'rx-btn rx-btn-seg' + (draft.everyMinutes === o.id ? ' on' : '')}
                    onClick={() => setDraft(d => ({ ...d, everyMinutes: o.id }))}
                  >{o.label}</button>
                ))}
              </div>
              {/* ⚠️ THE HONEST SENTENCE GOES NEXT TO THE CONTROL. Turns run through
                  the chat view, so a schedule cannot fire with the app quit. A
                  timer that quietly does not fire is the worst possible version of
                  this, and burying the caveat in a Read me is how that happens. */}
              <p className='lp-field-hint'>
                {draft.everyMinutes > 0
                  ? 'Radiant has to be open — it runs the turns, which is what lets you watch and interrupt them. It will switch to the chat and run there. Two runs in a row that do not finish switch this back off rather than repeating the same failure all night.'
                  : 'Nothing starts on its own. A schedule only fires while Radiant is open, because the app runs the turns.'}
              </p>
            </div>
          )}

          {stage === 3 && (
            <div className='lp-panel'>
              <h3 className='lp-panel-title'>Here is what will run</h3>
              <p className='lp-panel-lead'>
                Read it once. Nothing has happened yet — creating a loop does not start it.
              </p>
              <div className='lp-review'>
                <div className='lp-review-goal'>{draft.title || 'Untitled'}</div>
                {draft.cwd && <div className='lp-review-cwd'>in <code>{draft.cwd}</code></div>}
                <ol className='lp-review-steps'>
                  {draft.steps.filter(st => st.title.trim()).map((st, i) => (
                    <li key={st.id || i}>
                      <b>{st.title}</b>
                      <span className='lp-review-who'>{whoLabel(st, agents)}</span>
                      {isChecked(st)
                        ? (
                          <span className='lp-review-check'>
                            Passes when {[
                              st.checkCommand.trim() && `${st.checkCommand.trim()} exits 0`,
                              st.check.trim()
                            ].filter(Boolean).join(', and when ')} · up to {st.maxAttempts} attempt{st.maxAttempts === 1 ? '' : 's'}
                          </span>
                        )
                        : <span className='lp-review-nocheck'>No check — done the moment the agent stops. Nothing verifies it.</span>}
                    </li>
                  ))}
                </ol>
              </div>
              {uncheckedSteps > 0 && (
                <p className='lp-warn'>
                  {uncheckedSteps} step{uncheckedSteps === 1 ? '' : 's'} without a check. You can create it anyway —
                  it just means {uncheckedSteps === 1 ? 'that step is' : 'those steps are'} taken on trust.
                </p>
              )}
              {hasGoal && (
                <p className='lp-review-goalcheck'>
                  Then the whole run is judged: it is done when {[
                    draft.goalCommand.trim() && `${draft.goalCommand.trim()} exits 0`,
                    draft.goalCheck.trim()
                  ].filter(Boolean).join(', and when ')}.{' '}
                  {/* ⚠️ ONE PASS MEANS IT DOES NOT RUN AGAIN, so saying "runs again, up to
                      1 pass" is a sentence that contradicts itself in its own second half.
                      A goal check at one pass is still worth having — it is the difference
                      between being told the run missed and being told it succeeded — but
                      it is a verdict, not a loop, and the review has to say which. */}
                  {draft.maxPasses > 1
                    ? `If it is not, every step runs again — up to ${draft.maxPasses} passes in total.`
                    : 'If it is not, the loop stops and tells you what is still missing. Raise the pass count to have it try again.'}
                </p>
              )}
              {draft.everyMinutes > 0 && (
                <p className='lp-review-goalcheck'>
                  It will start itself {(EVERY.find(o => o.id === draft.everyMinutes)?.label || '').toLowerCase()},
                  while Radiant is open.
                </p>
              )}
              <p className='lp-panel-lead'>
                When you run it, each step opens as an ordinary chat you can watch, interrupt
                and steer — so a loop waits at an approval prompt exactly like anything else.
              </p>
            </div>
          )}

          <div className='lp-compose-foot'>
            <button
              type='button'
              className='rx-btn rx-btn-sm'
              onClick={() => (stage === 0 ? setComposing(false) : setStage(n => n - 1))}
            >{stage === 0 ? 'Cancel' : 'Back'}</button>
            {/* ⚠️ ONE BUTTON, ALWAYS type='button'. This was a Next button and a
                submit button swapped by a ternary — and React reuses the DOM node
                for both, because they sit in the same place in the same children
                array. So the click landed on Next, the handler advanced the stage,
                React flipped that very element's type to "submit" before the
                browser got to the default action, and the browser then submitted
                the form. Clicking Next on the steps skipped the review entirely
                and created the loop. Watched twice before the cause was found: the
                element you pressed is not necessarily the element that acts. */}
            <button
              type='button'
              className='rx-btn rx-btn-go'
              disabled={!stageReady}
              onClick={advance}
            >{stage < STAGES.length - 1 ? 'Next' : editingId ? 'Save changes' : 'Create loop'}</button>
          </div>
        </form>
      )}

      {!loading && loops.length === 0 && !composing && (
        <div className='lp-blank'>
          <p className='lp-blank-lead'>Nothing running yet.</p>
          <p className='lp-blank-sub'>
            A task is one job. A loop is several, in order, each with a condition
            it has to meet before the next one starts — write the build step, then
            "passes when npm test exits 0", and it will keep going until it does
            or until it runs out of attempts.
          </p>
        </div>
      )}

      <div className='lp-list stagger'>
        {loops.map(loop => {
          const done = loop.steps.filter(s => s.state === 'passed').length
          const isRunning = loop.state === 'running'
          const mine = runningLoopId === loop.id
          return (
            <article key={loop.id} className={'lp-card is-' + loop.state}>
              <header className='lp-card-head'>
                <div>
                  <h3 className='lp-card-title'>{loop.title}</h3>
                  <div className='lp-card-state'>
                    {loopLabel(loop)} · {done} of {loop.steps.length} passed
                    {/* Which time round this is. Silent on a one-pass loop, which
                        is most of them, so it only appears when it means something. */}
                    {loop.maxPasses > 1 && <span> · pass {loop.pass || 1} of {loop.maxPasses}</span>}
                    {loop.schedule && <span className='lp-card-every'> · every {everyLabel(loop.schedule.everyMinutes)}</span>}
                    {loop.cwd && <span className='lp-card-cwd'> · {loop.cwd}</span>}
                  </div>
                </div>
                <div className='lp-card-acts'>
                  {isRunning
                    ? <button className='rx-btn rx-btn-sm' onClick={() => onStop?.(loop)}>Stop</button>
                    : <button className='rx-btn rx-btn-sm rx-btn-go' onClick={() => onRun?.(loop)}>
                        {loop.state === 'done' || loop.state === 'failed' ? 'Run again' : 'Run'}
                      </button>}
                  <button className='rx-btn rx-btn-sm' onClick={() => editLoop(loop)} disabled={isRunning}>Edit</button>
                  <button className='rx-btn rx-btn-sm' onClick={() => remove(loop)} aria-label={`Delete ${loop.title}`}>Delete</button>
                </div>
              </header>

              <div className='lp-bar'><i style={{ width: `${(done / loop.steps.length) * 100}%` }} /></div>

              {/* ⚠️ A LOOP ONLY MOVES WHILE RADIANT IS RUNNING IT. The turns go
                  through the chat view, so a loop marked Running in a window you
                  have closed is not going anywhere. Say so rather than letting it
                  sit there looking busy. */}
              {isRunning && !mine && (
                <p className='lp-note'>Marked running, but not by this window. Press Run to pick it up.</p>
              )}
              {/* ⚠️ A SCHEDULE THAT SWITCHED ITSELF OFF HAS TO SAY SO ON THE CARD.
                  Otherwise the loop simply stops happening and the only evidence
                  is an absence, which nobody notices for a week. */}
              {loop.scheduleOffReason && (
                <p className='lp-note'>Schedule off. {loop.scheduleOffReason}</p>
              )}
              {loop.schedule && !isRunning && loop.nextRunAt && (
                <p className='lp-note lp-note-quiet'>
                  Next run {new Date(loop.nextRunAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}, if Radiant is open.
                </p>
              )}
              {/* The goal check is the only thing that can stop a loop whose every
                  step passed, so its verdict is the one sentence worth surfacing. */}
              {loop.lastGoalFail && loop.state !== 'running' && (
                <p className='lp-note'>{loop.blockedReason === loop.lastGoalFail ? 'Every step passed, and the goal check says it cannot be met as set up: ' : 'Every step passed but the goal did not: '}{loop.lastGoalFail}</p>
              )}
              {/* ⚠️ "WORKING" AND "WAITING FOR YOU" LOOK THE SAME FROM HERE. A step
                  that hit an approval prompt sits in Working, because that is what
                  the run says — and nothing moves until you answer it in the chat,
                  which is on another tab. Watched live: an approval landed and the
                  card just sat there. */}
              {mine && loop.steps.some(s => s.state === 'working' || s.state === 'checking') && (
                <p className='lp-note lp-note-quiet'>
                  Running in Chat. If it stops here, look there — it may be waiting for you to approve something.
                </p>
              )}

              <ol className='lp-steps'>
                {loop.steps.map((s, i) => (
                  <StepRow
                    key={s.id}
                    step={s}
                    index={i}
                    agents={agents}
                    running={mine && runningStepId === s.id}
                    onOpen={onOpenSession}
                  />
                ))}
              </ol>
            </article>
          )
        })}
      </div>
    </section>
  )
}

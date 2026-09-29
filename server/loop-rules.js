/**
 * What a loop decides, separated from where it stores things.
 *
 * ⚠️ THESE ARE PURE ON PURPOSE. The verdict reader is the only thing standing
 * between "the model said some words" and "this step is finished", and the retry
 * prompt is the only thing that makes a second attempt different from the first.
 * Both are exactly the kind of logic that gets shipped untested because testing
 * it seems to need a model, a session and a running server. It needs a string.
 */

const STEP_ID = () => 'step-' + Math.random().toString(36).slice(2, 8)

// ⚠️ AN UNBOUNDED RETRY IS AN UNBOUNDED BILL. Three attempts is enough for the
// ordinary case (missed a file, forgot a test) and stops a step that cannot pass
// from spending the night proving it.
export const DEFAULT_ATTEMPTS = 3
export const MAX_ATTEMPTS = 10

export function normalizeStep (raw, existing) {
  const max = Number(raw.maxAttempts)
  return {
    id: existing?.id || STEP_ID(),
    title: String(raw.title || '').trim(),
    prompt: String(raw.prompt || '').trim(),
    check: String(raw.check || '').trim(),
    // The deterministic half. Runs before anybody pays for an opinion.
    checkCommand: String(raw.checkCommand || '').trim(),
    agentId: raw.agentId || null,
    model: raw.model || null,
    provider: raw.provider || null,
    // A second agent grading the first is the difference between a check and a
    // model marking its own homework. Optional, because it costs another run.
    checkAgentId: raw.checkAgentId || null,
    maxAttempts: Number.isFinite(max) ? Math.min(MAX_ATTEMPTS, Math.max(1, Math.round(max))) : DEFAULT_ATTEMPTS,
    state: existing?.state || 'pending',
    attempts: existing?.attempts || 0,
    sessionId: existing?.sessionId || null,
    checkSessionId: existing?.checkSessionId || null,
    lastFail: existing?.lastFail || null,
    startedAt: existing?.startedAt || null,
    finishedAt: existing?.finishedAt || null
  }
}

/** What to say to the agent doing the work, including why the last try failed. */
export function workPrompt (loop, step) {
  const parts = [loop.detail ? `Goal of this loop: ${loop.title}\n${loop.detail}` : `Goal of this loop: ${loop.title}`]
  parts.push(`Step ${loop.currentStep + 1} of ${loop.steps.length}: ${step.title}`)
  if (step.prompt) parts.push(step.prompt)
  if (step.checkCommand) parts.push(`This step will be checked by running: ${step.checkCommand}\nThat command has to exit 0. Nothing you say about it counts.`)
  if (step.check) parts.push(`This step is finished when: ${step.check}`)
  // ⚠️ A LATER PASS HAS TO KNOW IT IS A LATER PASS. Every step passed its own
  // check last time round and the goal still was not met, so repeating the first
  // pass exactly is the one thing guaranteed not to work.
  if (loop.pass > 1 && loop.lastGoalFail) {
    parts.push(`This is pass ${loop.pass} of ${loop.maxPasses} over the whole loop. Last time every step passed its own check but the goal was still not met: ${loop.lastGoalFail}`)
  }
  if (step.lastFail) {
    // ⚠️ THE REASON TRAVELS WITH THE RETRY. A loop that silently reruns the same
    // prompt gets the same answer; the only thing that makes the second attempt
    // different from the first is knowing what was wrong with the first.
    //
    // ⚠️ AND SO DOES A SCOPE LINE, WHICH IS THE HALF THAT WAS MISSING. A returned
    // step grows without one: the agent opens the file, notices two adjacent
    // problems, fixes those too, and a one-step correction lands as a diff
    // nobody asked for. Worse, the steps it wanders into already passed their
    // own checks — so widening the fix turns one known failure into several
    // unverified outcomes, and a run that does that twice never converges.
    parts.push([
      'A previous attempt did not pass the check.',
      `WHAT FAILED: ${step.title}`,
      `WHY: ${step.lastFail}`,
      'SCOPE: fix exactly that and nothing else. The other steps of this loop already passed their own checks — do not redo them, do not tidy them, and do not take on work this step did not ask for.'
    ].join('\n'))
  }
  return parts.join('\n\n')
}

/** What to say to whoever is grading it. */
// BLOCKED is for a wall, not a gap: nothing another attempt could change.
const VERDICT_CHOICES = missing => 'Reply with one final line, exactly one of:\nVERDICT: PASS\n' +
  `VERDICT: FAIL — <one sentence naming ${missing}>\n` +
  'VERDICT: BLOCKED — <one sentence naming why no further attempt could pass: something outside the work, like missing access or a condition that cannot be met>\n' +
  'Use BLOCKED only when retrying cannot help; if more work could get there, it is FAIL.'

export function checkPrompt (loop, step, sameSession) {
  return [
    'You are checking one step of a loop, not continuing it. Do no new work: inspect what is there and judge it.',
    sameSession
      ? 'Judge the work in this conversation.'
      : `Judge work that was just done in ${loop.cwd || 'the working folder'} by another agent. Read whatever you need to.`,
    `Step: ${step.title}`,
    `It passes only if: ${step.check}`,
    VERDICT_CHOICES('what is missing or wrong')
  ].join('\n\n')
}

// ⚠️ READ THE VERDICT FROM THE TRANSCRIPT, NOT FROM THE CLIENT. If the browser
// reported pass/fail, a loop could be made to pass by a client that lied or that
// simply lost the stream. The server reads the assistant's own last message.
//
// ⚠️ AND THE LAST VERDICT WINS. A model that restates the format it was given
// ("reply with VERDICT: PASS or VERDICT: FAIL") before answering would otherwise
// have its own instructions read back as its answer — a step that passes because
// the word PASS appeared first in the message.
// ⚠️ SPACES AND TABS, NEVER \s. `\s` matches a newline, so `\s*` after the word
// PASS ran on into the NEXT line and swallowed it: the two-line block
// "VERDICT: PASS\nVERDICT: FAIL — …" matched ONCE, as a pass, with the failing
// verdict eaten as its reason. That block is the exact thing this file tells the
// checker to choose between, so a model that quoted its instructions back would
// have passed every step it was asked to judge.
// The verdict must START a line. Allowing it mid-sentence would make "I would
// not say VERDICT: PASS here" a pass, and the whole layer rests on this one
// match. A model that buries it in a paragraph gets "did not answer", which
// costs an attempt and never costs a false pass — the prompt asks for one final
// line, and being strict is the safe direction to be wrong in. List and quote
// markers are allowed because models add them unbidden.
const VERDICT_RE = /^[ \t]*(?:[-*>][ \t]*)*(?:\*\*)?VERDICT(?:\*\*)?[ \t]*[::][ \t]*(?:\*\*)?(PASS|FAIL|BLOCKED)\b(?:\*\*)?[ \t]*[—\-–:.]*[ \t]*(.*)$/gim

export function readVerdict (text) {
  const s = String(text || '')
  // ⚠️ NOTHING AT ALL IS A DIFFERENT PROBLEM FROM THE WRONG WORDS, and saying so
  // is the difference between a user fixing it in a minute and not fixing it.
  // Watched live with a misconfigured model: every turn returned no text, so
  // every check "did not answer PASS or FAIL", and after three attempts the loop
  // stopped with a message that sends you to inspect a check condition that was
  // never the problem. Both are still a fail — only the sentence differs.
  if (!s.trim()) {
    return { pass: false, empty: true, reason: 'The model returned nothing at all, so nothing was checked. Try another model for this step.' }
  }
  let last = null, m
  VERDICT_RE.lastIndex = 0
  while ((m = VERDICT_RE.exec(s))) last = m
  // ⚠️ NO VERDICT IS A FAIL, NOT A PASS. Treating an unparseable answer as
  // success is the failure that makes the whole layer worthless: the one case
  // where the check did not actually happen is the one where it must not say
  // the step is done. It costs an attempt, which is bounded.
  if (!last) return { pass: false, reason: 'The check did not answer PASS or FAIL.' }
  if (last[1].toUpperCase() === 'PASS') return { pass: true, reason: '' }
  // ⚠️ "IT CANNOT BE DONE" IS AN ANSWER, NOT A FAIL TO RETRY. Watched in the
  // wild (a16z, 2026-08): the agent diagnosed an unreachable goal on try 5 and
  // the checker sent it back fourteen more times, each turn dearer than the
  // last. A blocked verdict ends the run with its reason instead of spending
  // the attempts that are left on work no attempt can finish.
  if (last[1].toUpperCase() === 'BLOCKED') return { pass: false, blocked: true, reason: (last[2] || '').trim() || 'The check said this cannot be done as set up.' }
  return { pass: false, reason: (last[2] || '').trim() || 'The check said this step is not done.' }
}

// ── the deterministic half of a check ───────────────────────────────────────
//
// ⚠️ TWO MODELS AGREEING IS NOT A CHECK, IT IS TWO OPTIMISTS. Until this landed
// the only verdict this file could read came out of a model — while the box in
// the UI offered `npm test exits 0` as its example of a good condition. The app
// recommended something a program could evaluate and then asked an agent to
// guess whether it had happened.
//
// So a step can now carry a command, and evidence is read in the order it
// deserves: the command runs first, costs nothing, and cannot be talked out of
// its answer. Only if it passes does anyone pay for an opinion. A command that
// fails ends the attempt without spending a model turn at all.
//
// ⚠️ AND ABSENCE OF AN ERROR IS NOT EVIDENCE OF CORRECTNESS. Exit 0 means the
// command said yes, which is only worth what the command is worth. That is a
// property of the condition the user wrote, and the screen says so; it is not
// something this function can rescue.

// How much of a failing command's output travels into the retry as evidence.
// ⚠️ THE TAIL, NOT THE HEAD. A test runner prints its banner first and its
// summary last, so truncating from the front hands the retry the copyright
// notice and drops the failure it is supposed to fix.
export const EVIDENCE_CHARS = 800

/**
 * Turn a finished command into a verdict. Pure: the caller runs the process and
 * hands over what came back, so every shape below is reachable from a test with
 * no shell, no clock and no filesystem.
 */
export function readCommandVerdict (r) {
  const raw = [r?.stdout || '', r?.stderr || ''].filter(Boolean).join('\n').trim()
  const tail = raw.length > EVIDENCE_CHARS ? '…' + raw.slice(raw.length - EVIDENCE_CHARS) : raw
  // ⚠️ COULD-NOT-RUN IS NOT DID-NOT-PASS, and saying which is the difference
  // between fixing a typo in the command and hunting a bug that is not there.
  // A missing binary exits 127 through a shell, so this catches only the cases
  // where the process never started at all.
  if (r?.spawnError) {
    return { pass: false, ran: false, reason: `The check command could not run at all: ${r.spawnError}. Fix the command itself — nothing was checked.` }
  }
  if (r?.timedOut) {
    const secs = Math.round((r.timeoutMs || 0) / 1000)
    return { pass: false, ran: true, reason: `The check command was still running after ${secs}s and was stopped.${tail ? ' It had printed:\n' + tail : ''}` }
  }
  if (Number(r?.code) === 0) return { pass: true, ran: true, reason: '' }
  return {
    pass: false,
    ran: true,
    reason: `The check command exited ${r?.code ?? '(unknown)'}${tail ? '. It printed:\n' + tail : ' and printed nothing.'}`
  }
}

// ── goals: the loop above the steps ─────────────────────────────────────────
//
// ⚠️ EVERY STEP PASSING IS NOT THE GOAL BEING MET, and that gap is the ceiling
// of a step-wise loop. It makes each unit correct and has no way to notice the
// units were the wrong ones — a very good agent running the wrong three steps,
// each one verified. Tuning the steps cannot fix that, because the fault is not
// inside any step.
//
// A goal check runs once at the end of a pass and judges the whole thing. What
// makes it a loop rather than a report is what happens when it fails: the run
// goes back to step one, carrying the reason, up to a cap.
export const DEFAULT_PASSES = 1
export const MAX_PASSES = 10

export function normalizeGoal (raw = {}) {
  const n = Number(raw.maxPasses)
  return {
    goalCheck: String(raw.goalCheck || '').trim(),
    goalCommand: String(raw.goalCommand || '').trim(),
    maxPasses: Number.isFinite(n) ? Math.min(MAX_PASSES, Math.max(1, Math.round(n))) : DEFAULT_PASSES
  }
}

export function hasGoalCheck (loop) {
  return Boolean(loop?.goalCheck || loop?.goalCommand)
}

/** What to say to whoever judges the whole run. */
export function goalPrompt (loop) {
  return [
    'You are judging whether a whole loop met its goal, not whether one step ran. Every step already passed its own check; that is not the question. Do no new work — inspect what is there and judge it.',
    `The goal was: ${loop.title}${loop.detail ? '\n' + loop.detail : ''}`,
    `It is met only if: ${loop.goalCheck}`,
    loop.cwd ? `The work was done in ${loop.cwd}. Read whatever you need to.` : '',
    VERDICT_CHOICES('what is still missing')
  ].filter(Boolean).join('\n\n')
}

/** Wipe the step states so a new pass starts clean. Keeps what was configured. */
export function resetSteps (steps) {
  return steps.map(s => ({
    ...s, state: 'pending', attempts: 0, sessionId: null, checkSessionId: null, lastFail: null, blocked: false, startedAt: null, finishedAt: null
  }))
}

// ── schedules ───────────────────────────────────────────────────────────────
//
// ⚠️ A SCHEDULE ONLY FIRES WHILE RADIANT IS OPEN, AND THE SCREEN HAS TO SAY SO.
// The client is the run engine — the decision the whole loop layer rests on, and
// what buys approvals, steering, tools and a transcript you can watch. The price
// is that nothing runs with the app quit. A timer that quietly does not fire is
// the worst possible version of this feature, so the honesty goes in the UI next
// to the control, not in a Read me.
//
// ⚠️ AND A FAILING LOOP ON A TIMER IS AN UNBOUNDED BILL. This is the same
// argument as the per-step attempt cap, one layer up and with nobody watching:
// two failed runs in a row switch the schedule off and say why, rather than
// spending the night proving the same thing every five minutes.
export const MIN_EVERY_MINUTES = 1
export const MAX_EVERY_MINUTES = 60 * 24 * 7
export const SCHEDULE_GIVE_UP = 2

export function normalizeSchedule (raw) {
  if (!raw) return null
  const n = Number(raw.everyMinutes)
  if (!Number.isFinite(n) || n <= 0) return null
  return { everyMinutes: Math.min(MAX_EVERY_MINUTES, Math.max(MIN_EVERY_MINUTES, Math.round(n))) }
}

/**
 * When this loop is next allowed to start itself.
 *
 * ⚠️ MEASURED FROM THE LAST RUN, NOT FROM CREATION. Counting from createdAt
 * means putting a schedule on a loop written last week makes it due the instant
 * you save it — the user asks for "every hour" and gets a run immediately, which
 * reads as a bug. `scheduledAt` is stamped whenever the schedule changes and is
 * the floor until something has actually run.
 */
export function nextRunAt (loop) {
  if (!loop?.schedule) return null
  const base = Date.parse(loop.lastRunAt || loop.scheduledAt || loop.createdAt || '')
  if (!Number.isFinite(base)) return null
  return new Date(base + loop.schedule.everyMinutes * 60_000).toISOString()
}

export function isDue (loop, now = Date.now()) {
  if (!loop?.schedule) return false
  // A run in flight does not want a timer starting it a second time, and a loop
  // someone stopped by hand is stopped — the timer picks it up next interval.
  if (loop.state === 'running') return false
  const next = nextRunAt(loop)
  if (!next) return false
  return Date.parse(next) <= now
}

/**
 * What a finished run does to the schedule. Pure, and separate from the runner,
 * because "give up after two" is exactly the rule that gets written once inside
 * a handler and then never exercised.
 */
export function afterRun (loop, outcome) {
  const failed = outcome === 'failed'
  const streak = failed ? (loop.consecutiveFailures || 0) + 1 : 0
  const patch = { consecutiveFailures: streak, lastRunAt: new Date().toISOString() }
  if (loop.schedule && streak >= SCHEDULE_GIVE_UP) {
    patch.schedule = null
    patch.scheduleOffReason = `Turned off after ${streak} runs in a row that did not finish. Fix what is stopping it, then switch it back on.`
  }
  return patch
}

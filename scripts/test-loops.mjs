/**
 * What makes a loop a loop: the check, and what happens when it fails.
 *
 * ⚠️ THE VERDICT READER IS THE WHOLE FEATURE. Without it a "loop" is a numbered
 * list of tasks that all report success, which is what an agent already does. So
 * every way a model can answer badly — restating the format it was given,
 * bolding it, answering twice, answering not at all — is a case here.

 */
const {
  readVerdict, workPrompt, checkPrompt, normalizeStep, DEFAULT_ATTEMPTS, MAX_ATTEMPTS,
  readCommandVerdict, EVIDENCE_CHARS, normalizeGoal, hasGoalCheck, goalPrompt, resetSteps,
  normalizeSchedule, nextRunAt, isDue, afterRun, MAX_PASSES, MAX_EVERY_MINUTES, SCHEDULE_GIVE_UP
} = await import('../server/loop-rules.js')

let pass = 0, fail = 0
const results = []
const ok = (name, cond) => { cond ? pass++ : (fail++, results.push('  FAIL ' + name)) }

// ── the verdict ─────────────────────────────────────────────────────────────
ok('a clean PASS passes', readVerdict('Looks right.\nVERDICT: PASS').pass === true)
ok('a clean FAIL fails', readVerdict('VERDICT: FAIL — the tests were never run').pass === false)
ok('and the reason survives',
   readVerdict('VERDICT: FAIL — the tests were never run').reason === 'the tests were never run')
// A wall, not a gap: "it cannot be done" ends the run instead of spending attempts.
ok('BLOCKED is read as blocked', readVerdict('VERDICT: BLOCKED — the latency is outside the code').blocked === true)
ok('and is not a pass', readVerdict('VERDICT: BLOCKED — x').pass === false)
ok('and keeps its reason', readVerdict('VERDICT: BLOCKED — the latency is outside the code').reason === 'the latency is outside the code')
ok('a FAIL is not blocked', !readVerdict('VERDICT: FAIL — no').blocked)
ok('the last verdict still wins over a quoted BLOCKED',
   readVerdict('Options: VERDICT: BLOCKED — …\nVERDICT: FAIL — tests red').blocked !== true)
ok('the check prompt offers BLOCKED', /VERDICT: BLOCKED/.test(checkPrompt({ cwd: '/x' }, { title: 't', check: 'c' }, true)))
ok('markdown bolding does not hide the verdict', readVerdict('**VERDICT: PASS**').pass === true)
ok('a hyphen works as well as an em dash',
   readVerdict('VERDICT: FAIL - no file was written').reason === 'no file was written')

// ⚠️ THIS IS THE CASE THAT MATTERS. A model that quotes its instructions back
// ("reply with VERDICT: PASS or VERDICT: FAIL") before answering would otherwise
// have the format description read as the answer — and the first word is PASS.
ok('the LAST verdict wins, not the first',
   readVerdict('I was asked to reply VERDICT: PASS or VERDICT: FAIL.\n\nVERDICT: FAIL — nothing compiled').pass === false)

// ⚠️ NO VERDICT IS A FAIL. Treating an unparseable answer as success is the one
// failure that makes the whole layer worthless.
ok('silence is not a pass', readVerdict('I think that went well.').pass === false)
ok('and it says why', /did not answer/i.test(readVerdict('I think that went well.').reason))
ok('an empty message is not a pass', readVerdict('').pass === false)
// ⚠️ AND IT SAYS SOMETHING DIFFERENT. Seen live with a misconfigured model:
// every turn returned no text, so every check "did not answer PASS or FAIL" and
// the loop stopped pointing at a check condition that was never the problem.
ok('nothing at all is reported as nothing, not as a bad answer',
   /returned nothing/i.test(readVerdict('').reason) && readVerdict('').empty === true)
ok('whitespace counts as nothing', readVerdict('   \n  ').empty === true)
ok('and a real non-verdict answer is still reported as one',
   /did not answer/i.test(readVerdict('Looks fine to me.').reason) && !readVerdict('Looks fine to me.').empty)
ok('the word pass in prose is not a verdict', readVerdict('All of the tests pass now.').pass === false)
ok('a bare FAIL still carries a reason', readVerdict('VERDICT: FAIL').reason.length > 0)
ok('a bullet in front of it is still a verdict', readVerdict('- VERDICT: PASS').pass === true)
ok('and a quote marker', readVerdict('> **VERDICT: FAIL** — nothing ran').reason === 'nothing ran')
ok('a trailing full stop does not become the reason', readVerdict('VERDICT: PASS.').pass === true)
// ⚠️ MID-SENTENCE IS NOT A VERDICT. "I would not say VERDICT: PASS here" must
// not pass a step; the anchor to the start of a line is what prevents it.
ok('a verdict buried in a sentence does not count',
   readVerdict('I would not say VERDICT: PASS about this.').pass === false)

// ── the retry has to differ from the first attempt ───────────────────────────
const loop = { title: 'Ship the parser', detail: '', currentStep: 0, steps: [{}, {}] }
const step = { title: 'Write it', prompt: 'Write the parser.', check: 'npm test passes', lastFail: null }
const first = workPrompt(loop, step)
const retry = workPrompt(loop, { ...step, lastFail: 'the tests were never run' })
ok('the first attempt states the finish condition', first.includes('npm test passes'))
ok('the first attempt says which step it is', first.includes('Step 1 of 2'))
ok('a retry is not the same prompt as the first attempt', retry !== first)
ok('a retry carries the reason the last one failed', retry.includes('the tests were never run'))

// ── the checker must be told not to keep working ─────────────────────────────
const cp = checkPrompt(loop, step, true)
ok('the check forbids doing more work', /do no new work/i.test(cp))
ok('the check states the condition', cp.includes('npm test passes'))
ok('the check demands the format it will be parsed for', readVerdict(cp).pass === false)
ok('a second-agent check is told the work is elsewhere',
   /another agent/i.test(checkPrompt({ ...loop, cwd: '/tmp/x' }, step, false)))
ok('and a same-session check is not', !/another agent/i.test(cp))

// ── attempt bounds ──────────────────────────────────────────────────────────
ok('a step defaults to a bounded number of attempts', normalizeStep({ title: 'x' }).maxAttempts === DEFAULT_ATTEMPTS)
ok('zero attempts is not allowed', normalizeStep({ title: 'x', maxAttempts: 0 }).maxAttempts === 1)
ok('an unbounded retry is capped', normalizeStep({ title: 'x', maxAttempts: 9999 }).maxAttempts === MAX_ATTEMPTS)
ok('garbage falls back to the default', normalizeStep({ title: 'x', maxAttempts: 'lots' }).maxAttempts === DEFAULT_ATTEMPTS)
// Editing a loop must not reset the run it is in the middle of.
const kept = normalizeStep({ title: 'renamed' }, { id: 'step-abc', state: 'passed', attempts: 2, sessionId: 's1' })
ok('editing a step keeps its id', kept.id === 'step-abc')
ok('editing a step keeps what the run already did', kept.state === 'passed' && kept.attempts === 2)
ok('and takes the new title', kept.title === 'renamed')

// ── the deterministic check ─────────────────────────────────────────────────
//
// ⚠️ THE THREE OUTCOMES WEAR THE SAME `err` OBJECT AND MEAN DIFFERENT THINGS,
// which is exactly the shape of bug that ships. A command that ran and said no
// is the ordinary case; one that never started is the user's typo; one that hung
// is neither. Telling the user the wrong one sends them to debug the wrong file.
ok('exit 0 passes', readCommandVerdict({ code: 0, stdout: 'ok' }).pass === true)
ok('a non-zero exit fails', readCommandVerdict({ code: 1, stdout: '1 test failed' }).pass === false)
ok('and the output travels as the evidence',
   readCommandVerdict({ code: 1, stdout: '1 test failed' }).reason.includes('1 test failed'))
ok('a command that ran counts as having run',
   readCommandVerdict({ code: 1, stdout: 'nope' }).ran === true)

// ⚠️ COULD-NOT-RUN IS NOT DID-NOT-PASS. Both fail the step, and only one of them
// means "your check is broken" — the sentence has to say which.
const broken = readCommandVerdict({ spawnError: 'spawn bash ENOENT' })
ok('a command that never started is not a failing check', broken.ran === false)
ok('and says the command itself is the problem', broken.reason.includes('could not run'))
ok('a spawn failure never reads as a pass', broken.pass === false)

const hung = readCommandVerdict({ timedOut: true, timeoutMs: 120000, stdout: 'building…' })
ok('a hung command fails', hung.pass === false)
ok('and says how long it waited', hung.reason.includes('120s'))

// ⚠️ THE TAIL, NOT THE HEAD. A test runner prints its banner first and its
// summary last. Truncating from the front hands the retry the copyright notice
// and drops the one line naming what broke — the whole point of the evidence.
const noisy = 'BANNER '.repeat(400) + 'FAILED: test_auth_redirect expected 302 got 200'
const trimmed = readCommandVerdict({ code: 1, stdout: noisy })
ok('a huge output is trimmed', trimmed.reason.length < noisy.length)
ok('and it is the END that survives', trimmed.reason.includes('test_auth_redirect expected 302 got 200'))
ok('the trim is bounded', trimmed.reason.length < EVIDENCE_CHARS + 200)

// ⚠️ NOTHING AT ALL IS STILL A PASS IF THE COMMAND SAID SO. A silent exit 0 is
// what `test -f build/out.js` looks like, and treating quiet as suspicious would
// break the simplest useful check there is.
ok('a silent exit 0 still passes', readCommandVerdict({ code: 0 }).pass === true)
// But a missing code with no error is not evidence of anything.
ok('an unknown outcome does not pass', readCommandVerdict({}).pass === false)

// ── the scope line on a return ──────────────────────────────────────────────
//
// ⚠️ WITHOUT IT A RETURNED STEP GROWS. The agent opens the file, notices two
// adjacent problems, fixes those too — and the steps it wanders into already
// passed their own checks, so one known failure becomes several unverified ones.
const gLoop = { title: 'Ship it', detail: '', currentStep: 1, pass: 1, maxPasses: 1, steps: [{}, {}] }
const scoped = workPrompt(gLoop, normalizeStep({ title: 'Write the parser', check: 'tests pass', lastFail: 'no test file' , maxAttempts: 3 }, { lastFail: 'no test file' }))
ok('a retry names what failed', scoped.includes('WHAT FAILED: Write the parser'))
ok('a retry carries the reason', scoped.includes('no test file'))
ok('a retry is scoped', scoped.includes('SCOPE:'))
ok('and says not to redo the other steps', /do not redo them/i.test(scoped))
// A first attempt has nothing to be scoped about, and saying so anyway would
// read as an accusation before any work happened.
const attempt1 = workPrompt(gLoop, normalizeStep({ title: 'Write the parser', check: 'tests pass' }))
ok('a first attempt carries no scope line', !attempt1.includes('SCOPE:'))

// The command is stated in the work prompt, so the agent knows what it is being
// held to rather than guessing from the sentence next to it.
const withCmd = workPrompt(gLoop, normalizeStep({ title: 'Build', checkCommand: 'npm test' }))
ok('the work prompt names the check command', withCmd.includes('npm test'))
ok('and says it has to exit 0', withCmd.includes('exit 0'))

// ── goals ───────────────────────────────────────────────────────────────────
ok('a step-only loop has no goal check', hasGoalCheck({ goalCheck: '', goalCommand: '' }) === false)
ok('a command alone is a goal check', hasGoalCheck({ goalCommand: 'npm run e2e' }) === true)
ok('passes default to one', normalizeGoal({}).maxPasses === 1)
ok('passes are capped', normalizeGoal({ maxPasses: 500 }).maxPasses === MAX_PASSES)
ok('zero passes is not allowed', normalizeGoal({ maxPasses: 0 }).maxPasses === 1)
ok('the goal prompt asks for a verdict', goalPrompt({ title: 'Ship', goalCheck: 'it builds' }).includes('VERDICT: PASS'))
// ⚠️ THE GOAL JUDGE MUST NOT RE-LITIGATE THE STEPS. Every step already passed;
// asking again gets a report on work that was never the question.
ok('and says the steps are not the question',
   /already passed/i.test(goalPrompt({ title: 'Ship', goalCheck: 'it builds' })))

// A later pass has to know it is one, or it repeats pass one exactly — the one
// thing guaranteed not to work.
const p2 = workPrompt({ ...gLoop, pass: 2, maxPasses: 3, lastGoalFail: 'no CSV button anywhere' }, normalizeStep({ title: 'Write it' }))
ok('a later pass says which pass it is', p2.includes('pass 2 of 3'))
ok('and carries what the goal check said', p2.includes('no CSV button anywhere'))

// resetSteps wipes the run and keeps the configuration. Losing the check on a
// second pass would silently make the loop weaker each time round.
const [r0] = resetSteps([normalizeStep({ title: 'a', check: 'c', checkCommand: 'npm test', maxAttempts: 5 }, { state: 'passed', attempts: 4, lastFail: 'x' })])
ok('a new pass clears what the last one did', r0.state === 'pending' && r0.attempts === 0 && r0.lastFail === null)
ok('and keeps the check', r0.check === 'c' && r0.checkCommand === 'npm test')
ok('and keeps the attempt cap', r0.maxAttempts === 5)

// ── schedules ───────────────────────────────────────────────────────────────
ok('no schedule is the default', normalizeSchedule(null) === null)
ok('zero minutes is not a schedule', normalizeSchedule({ everyMinutes: 0 }) === null)
ok('garbage is not a schedule', normalizeSchedule({ everyMinutes: 'often' }) === null)
ok('an interval is capped', normalizeSchedule({ everyMinutes: 99999999 }).everyMinutes === MAX_EVERY_MINUTES)

const T0 = '2026-09-08T12:00:00.000Z'
const hourly = { schedule: { everyMinutes: 60 }, createdAt: T0, scheduledAt: T0, lastRunAt: null, state: 'idle' }
ok('the first run is one interval away', nextRunAt(hourly) === '2026-09-08T13:00:00.000Z')
ok('and it is not due before then', isDue(hourly, Date.parse('2026-09-08T12:59:00Z')) === false)
ok('and is due after', isDue(hourly, Date.parse('2026-09-08T13:00:01Z')) === true)

// ⚠️ MEASURED FROM THE LAST RUN. Counting from createdAt means putting "every
// hour" on a loop written last week makes it due the instant you press Save —
// the user asked for an hour and got a run immediately, which reads as a bug.
const aged = { ...hourly, createdAt: '2026-01-01T00:00:00.000Z', scheduledAt: T0 }
ok('adding a schedule to an old loop does not fire it at once',
   isDue(aged, Date.parse('2026-09-08T12:05:00Z')) === false)
ok('a loop already running is never due',
   isDue({ ...hourly, state: 'running', lastRunAt: '2026-01-01T00:00:00.000Z' }, Date.now()) === false)
ok('a loop with no schedule is never due', isDue({ ...hourly, schedule: null }, Date.now()) === false)

// ⚠️ A FAILING LOOP ON A TIMER IS AN UNBOUNDED BILL — the same argument as the
// per-step attempt cap, one layer up and with nobody watching.
let acc = { ...hourly, consecutiveFailures: 0 }
acc = { ...acc, ...afterRun(acc, 'failed') }
ok('one failure does not switch the schedule off', acc.schedule !== null && acc.consecutiveFailures === 1)
acc = { ...acc, ...afterRun(acc, 'failed') }
ok(`${SCHEDULE_GIVE_UP} in a row does`, acc.schedule === null)
ok('and says why', typeof acc.scheduleOffReason === 'string' && acc.scheduleOffReason.length > 10)
// A run that finishes clears the streak, so an occasional failure never
// accumulates its way to switching a healthy loop off.
let good = { ...hourly, consecutiveFailures: 1 }
good = { ...good, ...afterRun(good, 'done') }
ok('a finished run clears the streak', good.consecutiveFailures === 0 && good.schedule !== null)
ok('and stamps when it ran', typeof good.lastRunAt === 'string')

console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  a step is done when a check says so`)
process.exit(fail ? 1 : 0)

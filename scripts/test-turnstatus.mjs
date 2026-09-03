import { turnStatus, clock, STALL_AFTER } from '../src/turnstatus.js'

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL ' + msg) } }
const T = 1_000_000
const at = (opts, secondsIn, quietFor) => turnStatus({
  streaming: true, startedAt: T, lastEventAt: T + (secondsIn - quietFor) * 1000, now: T + secondsIn * 1000, ...opts
})

ok(turnStatus({ streaming: false, now: T }) === null, 'nothing is shown when no turn is running')

ok(at({}, 3, 3).what === 'Waiting for the model',
   'before anything arrives it says it is waiting for the model, not "working"')

ok(at({ thinkingActive: true }, 5, 1).what === 'Thinking', 'thinking is called thinking')

ok(at({ parts: [{ type: 'tool', name: 'run_command' }] }, 5, 1).what === 'Running run command',
   'a tool with no result yet is the one running, and its name is readable')

ok(at({ parts: [{ type: 'tool', name: 'a', result: 'x' }, { type: 'tool', name: 'browser_click' }] }, 5, 1).what
     === 'Running browser click',
   'the RUNNING tool is the last one without a result, not the last one overall')

ok(at({ parts: [{ type: 'tool', name: 'a', result: 'x' }] }, 5, 1).what === 'Writing',
   'once every tool has come back it is writing')

ok(at({ parts: [{ type: 'tool', name: 'a', denied: true }] }, 5, 1).what === 'Writing',
   'a tool you denied is not still running')

// The point of the whole file.
ok(at({ thinkingActive: true }, 10, 5).stalled === false, 'a few quiet seconds is not a stall')
ok(at({ thinkingActive: true }, 60, STALL_AFTER).stalled === true,
   `${STALL_AFTER}s of unexplained silence is reported as a stall`)
ok(at({ thinkingActive: true }, 300, 1).stalled === false,
   'a long turn that is still emitting is NOT a stall — length is not silence')

ok(at({ parts: [{ type: 'tool', name: 'run_command' }] }, 600, 600).stalled === false,
   'a tool that has been running for ten minutes is NOT a stall — a build is silent by nature')
ok(at({ parts: [{ type: 'tool', name: 'run_command' }] }, 600, 600).what === 'Running run command',
   'and it still names the tool, which is the useful thing to say during that silence')
ok(at({ parts: [{ type: 'tool', name: 'a', result: 'x' }] }, 600, 600).stalled === true,
   'but silence with every tool finished IS a stall — nothing accounts for it')

ok(at({}, 90, 2).elapsed === 90, 'elapsed counts from the start of the turn')
ok(at({}, 90, 30).quiet === 30, 'quiet counts from the last event, not the start')

// A turn restored with no timestamps at all must not report a 56-year stall.
const bare = turnStatus({ streaming: true, now: T })
ok(bare.elapsed === 0 && bare.quiet === 0 && !bare.stalled,
   'missing timestamps read as "just started", never as an enormous stall')

ok(clock(9) === '9s' && clock(59) === '59s' && clock(60) === '1m 00s' && clock(125) === '2m 05s',
   'the clock reads correctly either side of a minute')

console.log(`  ${pass}/${pass + fail} passed  ·  it can say stuck, not only busy`)
process.exit(fail ? 1 : 0)

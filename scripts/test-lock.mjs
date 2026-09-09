/**
 * Two Macs on one folder: say so, and never lock anyone out.
 *
 * ⚠️ THE HAZARD WAS REAL AND ONLY EVER MENTIONED IN A HINT. Radiant's Settings
 * says "One Mac at a time. Two copies of Radiant writing to the same folder at
 * once will overwrite each other" — inside a collapsed section. Nothing detected
 * it, so the first sign was work quietly disappearing. Tony had Radiant open on
 * two Macs against one iCloud folder for a whole evening without being told.
 *
 * ⚠️ AND THE FAILURE MODE OF A LOCK IS WORSE THAN THE RACE. If being wrong means
 * "you cannot reach your own chats", the cure is worse than the disease — a
 * crash, a slow sync, or a clock skew would each lock someone out of their work.
 * So every case below asserts BOTH halves: that we noticed, and that we did not
 * block.
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const L = await import('../server/lock.js')
let pass = 0, fail = 0
const results = []
const ok = (n, c, extra = '') => { c ? pass++ : (fail++, results.push(`  FAIL ${n}${extra ? ' — ' + extra : ''}`)) }
const dir = mkdtempSync(join(tmpdir(), 'rx-lock-'))
const iso = ms => new Date(ms).toISOString()
const NOW = Date.now()

// ── an empty folder is ours ─────────────────────────────────────────────────
{
  const r = L.claimLock(dir, { host: 'mbp', pid: 1, now: NOW })
  ok('an unused folder is claimed without complaint', !r.contested && !r.holder)
  ok('and the claim is on disk', L.readLock(dir)?.host === 'mbp')
}

// ── a second Mac ────────────────────────────────────────────────────────────
{
  const r = L.claimLock(dir, { host: 'mba', pid: 2, now: NOW + 1000 })
  ok('a second Mac notices the first', r.contested && r.holder?.host === 'mbp')
  // ⚠️ THE HALF THAT MATTERS. Noticing must not turn into refusing.
  ok('...and still takes the folder rather than locking anyone out',
     L.readLock(dir)?.host === 'mba')
  ok('the message names the other Mac',
     /mbp/.test(L.describeHolder(r.holder, 'mba') || ''))
  ok('and says what to do about it',
     /quit one of them/.test(L.describeHolder(r.holder, 'mba') || ''))
  // ⚠️ THE TWO CASES MUST NOT SHARE A SENTENCE. A second window on this Mac is
  // something you close right now; a second Mac is somewhere else. Saying
  // "another copy of Radiant" for both sends someone hunting for the wrong
  // thing — which is the entire point of naming the machine.
  ok('a second copy on THIS Mac reads as this Mac, not as a mystery machine',
     /already open on this Mac/.test(L.describeHolder({ host: 'mbp' }, 'mbp') || ''))
  ok('...and does not claim to be somewhere else',
     !/also open on/.test(L.describeHolder({ host: 'mbp' }, 'mbp') || ''))
}

// ── our own restart is not a second Mac ─────────────────────────────────────
{
  // ⚠️ A CRASHED RADIANT ON THIS MAC LOOKS EXACTLY LIKE A LIVE ONE ON DISK. If
  // that counted as contention, every unclean quit would warn about a computer
  // that is not there — which teaches people to ignore the warning.
  writeFileSync(join(dir, L.LOCK_NAME), JSON.stringify(L.lockRecord('mbp', 999999, NOW)))
  const r = L.claimLock(dir, { host: 'mbp', pid: 3, now: NOW + 500 })
  ok('a dead Radiant on this Mac is not another Mac', !r.contested)
  ok('the same process re-claiming is not contention',
     !L.claimLock(dir, { host: 'mbp', pid: 3, now: NOW + 600 }).contested)
}

// ── staleness has to outlast iCloud, not the process ────────────────────────
{
  const fresh = L.lockRecord('mba', 7, NOW)
  ok('a beat from a second ago is live', !L.isStale(fresh, NOW + 1000))
  // ⚠️ A BEAT CROSSES iCLOUD BEFORE IT CROSSES A THRESHOLD. Sync is seconds and
  // sometimes much longer, so a threshold tuned to process liveness would have
  // each Mac declaring the other dead on a slow morning.
  ok('a beat from 30 seconds ago is still live — that is sync, not death',
     !L.isStale(fresh, NOW + 30_000))
  ok('the threshold is several beats, not one', L.STALE_MS >= L.BEAT_MS * 4)
  ok('a beat from three minutes ago is abandoned', L.isStale(fresh, NOW + 180_000))
  ok('a record with no beat at all is abandoned, not trusted forever',
     L.isStale({ host: 'old', pid: 1 }, NOW))
  ok('an unparseable beat is abandoned rather than believed',
     L.isStale({ host: 'x', pid: 1, beatAt: 'not a date' }, NOW))
  writeFileSync(join(dir, L.LOCK_NAME), JSON.stringify(L.lockRecord('mba', 7, NOW - 200_000)))
  ok('so an abandoned folder is taken quietly',
     !L.claimLock(dir, { host: 'mbp', pid: 4, now: NOW }).contested)
}

// ── the beat notices a takeover ─────────────────────────────────────────────
{
  L.claimLock(dir, { host: 'mbp', pid: 5, now: NOW })
  ok('a quiet folder beats quietly', !L.beatLock(dir, { host: 'mbp', pid: 5, now: NOW + BEATS(1) }).contested)
  writeFileSync(join(dir, L.LOCK_NAME), JSON.stringify(L.lockRecord('mba', 8, NOW + BEATS(1))))
  const r = L.beatLock(dir, { host: 'mbp', pid: 5, now: NOW + BEATS(2) })
  ok('a Mac that arrives after us is noticed on the next beat', r.contested && r.holder?.host === 'mba')
}
function BEATS (n) { return L.BEAT_MS * n }

// ── releasing ───────────────────────────────────────────────────────────────
{
  L.claimLock(dir, { host: 'mbp', pid: 6, now: NOW })
  ok('we can release our own claim', L.releaseLock(dir, 'mbp', 6) && L.readLock(dir) === null)
  L.claimLock(dir, { host: 'mba', pid: 9, now: NOW })
  // ⚠️ NEVER DELETE SOMEBODY ELSE'S. Quitting on this Mac must not hand the
  // folder away while the other one is mid-turn.
  ok('but never somebody else\'s', !L.releaseLock(dir, 'mbp', 6) && L.readLock(dir)?.host === 'mba')
}

// ── nothing here may throw, ever ────────────────────────────────────────────
{
  writeFileSync(join(dir, L.LOCK_NAME), 'this is not json {{{')
  ok('a corrupt lock reads as no lock', L.readLock(dir) === null)
  ok('and is claimed without complaint', !L.claimLock(dir, { host: 'mbp', pid: 10, now: NOW }).contested)
  const gone = join(dir, 'no', 'such', 'place')
  ok('an unreachable folder does not throw', L.readLock(gone) === null)
  ok('describeHolder says nothing when there is nothing to say', L.describeHolder(null) === null)
}

rmSync(dir, { recursive: true, force: true })
console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  a second Mac is named, never locked out`)
process.exit(fail ? 1 : 0)

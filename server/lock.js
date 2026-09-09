/**
 * Who else is using this folder.
 *
 * ⚠️ TWO MACS ON ONE SHARED FOLDER IS A DATA HAZARD RADIANT ONLY EVER MENTIONED
 * IN PASSING. Settings says "One Mac at a time. Two copies of Radiant writing to
 * the same folder at once will overwrite each other" — in a hint, inside a
 * collapsed section, which nobody reads before it matters. Nothing detected it,
 * so the first sign was work quietly disappearing.
 *
 * ⚠️ AND THIS DOES NOT BLOCK. Refusing to start would lock someone out of their
 * own chats to protect them from a risk they may be perfectly happy to take —
 * reading on one Mac while working on the other is fine, and a stale lock from a
 * crash would be indistinguishable from a live one. Rule 12 cuts the other way
 * here: say the true thing, name the other Mac, let the person decide. The cost
 * of being wrong about a lock must never be "you cannot reach your work".
 *
 * ⚠️ THE HEARTBEAT HAS TO OUTLAST iCLOUD, NOT THE PROCESS. A beat written on one
 * Mac is not visible on the other until iCloud carries it across, which is
 * seconds and occasionally much longer. A threshold tuned to process liveness
 * would have each Mac confidently declaring the other dead. BEAT_MS is short so
 * the record is fresh; STALE_MS is deliberately six beats, so it takes a real
 * absence rather than one slow sync to call a lock abandoned.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

export const LOCK_NAME = '.radiant-lock.json'
export const BEAT_MS = 15_000
export const STALE_MS = 90_000

const lockPath = dir => path.join(dir, LOCK_NAME)

/** What is written. Pure, so the shape is testable without a filesystem. */
export function lockRecord (host = os.hostname(), pid = process.pid, now = Date.now()) {
  return { host, pid, startedAt: new Date(now).toISOString(), beatAt: new Date(now).toISOString() }
}

/**
 * Is this record abandoned? Pure.
 *
 * A record with no beat is treated as stale rather than trusted: an older
 * Radiant that never wrote one must not lock a folder forever.
 */
export function isStale (rec, now = Date.now()) {
  if (!rec || !rec.beatAt) return true
  const beat = Date.parse(rec.beatAt)
  if (!Number.isFinite(beat)) return true
  return now - beat > STALE_MS
}

/** Is this record our own process, or a dead one of ours? Pure except for the pid probe. */
export function isOurs (rec, host = os.hostname(), pid = process.pid) {
  return Boolean(rec) && rec.host === host && rec.pid === pid
}

/**
 * ⚠️ A CRASHED RADIANT ON THIS MAC MUST NOT LOOK LIKE A SECOND MAC. Same host,
 * and the pid is gone — that is our own wreckage and taking it over is right.
 * Only ever asked about this machine's own records; a pid from another Mac means
 * nothing here, which is exactly why `host` is checked first.
 */
export function deadOnThisMac (rec, host = os.hostname()) {
  if (!rec || rec.host !== host || !rec.pid) return false
  try { process.kill(rec.pid, 0); return false } catch (e) { return e.code === 'ESRCH' }
}

export function readLock (dir) {
  try { return JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')) } catch { return null }
}

/** Write our claim. Atomic, for the same reason every other write here is. */
export function writeLock (dir, rec) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const tmp = lockPath(dir) + '.tmp-' + process.pid
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2))
    fs.renameSync(tmp, lockPath(dir))
    return true
  } catch { return false }
}

export function releaseLock (dir, host = os.hostname(), pid = process.pid) {
  const rec = readLock(dir)
  if (rec && !isOurs(rec, host, pid)) return false   // never delete somebody else's
  try { fs.unlinkSync(lockPath(dir)); return true } catch { return false }
}

/**
 * Claim the folder and say what we found. Never throws, never blocks.
 *
 * `holder` is another live Radiant we are now sharing with — the only case the
 * UI has anything to say about.
 */
export function claimLock (dir, { host = os.hostname(), pid = process.pid, now = Date.now() } = {}) {
  const prev = readLock(dir)
  const contested = Boolean(prev) && !isOurs(prev, host, pid) && !isStale(prev, now) && !deadOnThisMac(prev, host)
  writeLock(dir, lockRecord(host, pid, now))
  return { contested, holder: contested ? { host: prev.host, since: prev.startedAt, beatAt: prev.beatAt } : null }
}

/** Keep our claim fresh, and notice if somebody else has taken over. */
export function beatLock (dir, { host = os.hostname(), pid = process.pid, now = Date.now() } = {}) {
  const cur = readLock(dir)
  // Somebody else wrote over us: they are live, and we are the second Mac now.
  const contested = Boolean(cur) && !isOurs(cur, host, pid) && !isStale(cur, now)
  writeLock(dir, { ...lockRecord(host, pid, now), startedAt: (isOurs(cur, host, pid) && cur.startedAt) || new Date(now).toISOString() })
  return { contested, holder: contested ? { host: cur.host, since: cur.startedAt, beatAt: cur.beatAt } : null }
}

/**
 * One sentence for the UI, or null when there is nothing to say.
 *
 * ⚠️ NAME THE MACHINE, because the whole value of this is knowing WHICH copy to
 * go and quit. "Another copy of Radiant" sends someone hunting. The two cases
 * read differently and must not share a sentence: a second window on this Mac is
 * something you can close right now, and a second Mac is somewhere else.
 */
export function describeHolder (holder, thisHost = os.hostname()) {
  if (!holder) return null
  const elsewhere = holder.host && holder.host !== thisHost
  return elsewhere
    ? `Radiant is also open on ${holder.host}, using this same folder. Two copies writing at once can overwrite each other's work — quit one of them, or use Settings → Devices to work from the other over the network instead.`
    : 'Radiant is already open on this Mac, using this same folder. Two copies writing at once can overwrite each other\'s work — quit the other one.'
}

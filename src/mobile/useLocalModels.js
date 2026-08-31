/**
 * useLocalModels — the catalog, the download state and the disk numbers.
 *
 * This is the only place the LocalModels plugin is touched for listing,
 * downloading and removing. (Generation lives in MobileChat, which owns the
 * token stream and its terminal-event race; the split is deliberate and
 * documented there.)
 *
 * What the plugin actually gives us, and what this hook therefore refuses to
 * invent:
 *   list()      → { models: [{ id, name, blurb, sizeGB, downloaded }] }
 *   events      downloadStarted / downloadProgress { id, progress: 0..1 }
 *               / downloadDone / downloadFailed
 *   download()  is INDETERMINATE — downloadStarted / downloadDone /
 *               downloadFailed and nothing in between (TG-221). There is no
 *               percentage here because there is no percentage to have, and a
 *               bar creeping to 90% and hanging is the worst outcome available.
 *   remove()    forgets the weights.
 * Device.getInfo() supplies realDiskTotal / realDiskFree for the storage line.
 * If Device is missing we report null and the storage line hides itself rather
 * than guessing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fitOf } from './fit.js'
import * as haptics from './haptics.js'

const LM = () => (typeof window !== 'undefined' ? window.Capacitor?.Plugins?.LocalModels : null)
const DEVICE = () => (typeof window !== 'undefined' ? window.Capacitor?.Plugins?.Device : null)

// Decimal GB, matching how Apple reports storage in Settings. Using 2^30 would
// make every figure on screen disagree with the number the user can check.
export const GB = 1e9

export function useLocalModels () {
  const [models, setModels] = useState([])
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(null)
  const [jobs, setJobs] = useState({})        // id -> 'downloading' | 'failed'
  const [failures, setFailures] = useState({}) // id -> message
  const [justDone, setJustDone] = useState(null)
  const [progress, setProgress] = useState({})  // id -> 0..1 while downloading
  const [disk, setDisk] = useState(null)      // { total, free } or null

  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const refresh = useCallback(async () => {
    const lm = LM()
    if (!lm?.list) { setReady(true); return }
    try {
      const res = await lm.list()
      if (!alive.current) return
      setModels(Array.isArray(res?.models) ? res.models : [])
      setError(null)
    } catch (e) {
      if (alive.current) setError(e?.message || 'Could not read the model list.')
    } finally {
      if (alive.current) setReady(true)
    }
  }, [])

  /**
   * ⚠️ LocalModels.diskInfo() FIRST, Device second.
   *
   * @capacitor/device is not installed natively here and cannot be: adding it
   * means `npx cap sync ios`, and sync rewrites CapApp-SPM/Package.swift, where
   * the MLX dependencies are hand-added. So the storage line silently never
   * rendered — half the product argument, missing from the root screen. The
   * Swift plugin now answers the two numbers itself; the Device path stays as a
   * fallback in case that plugin build is ever older than this JS.
   */
  const refreshDisk = useCallback(async () => {
    const read = async () => {
      const lm = LM()
      if (lm?.diskInfo) {
        const d = await lm.diskInfo()
        if (typeof d?.total === 'number' && d.total > 0) {
          return {
            total: d.total,
            free: typeof d.free === 'number' ? d.free : null,
            // Bytes this app may still allocate. Disk says whether the download
            // can land; this says whether the model can then be loaded, and a
            // phone can easily have room for a file it cannot run.
            ram: typeof d.ramAvailable === 'number' && d.ramAvailable > 0 ? d.ramAvailable : null
          }
        }
      }
      const dev = DEVICE()
      if (dev?.getInfo) {
        const info = await dev.getInfo()
        const total = typeof info?.realDiskTotal === 'number' ? info.realDiskTotal : null
        const free = typeof info?.realDiskFree === 'number' ? info.realDiskFree : null
        if (total) return { total, free }
      }
      return null
    }
    try {
      const d = await read()
      if (alive.current) setDisk(d)
    } catch { if (alive.current) setDisk(null) }
  }, [])

  useEffect(() => { refresh(); refreshDisk() }, [refresh, refreshDisk])

  // the disk and the catalog can both change while we were in the background
  useEffect(() => {
    const onVis = () => { if (!document.hidden) { refresh(); refreshDisk() } }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [refresh, refreshDisk])

  // ── plugin events ─────────────────────────────────────────────────────────
  useEffect(() => {
    const lm = LM()
    if (!lm?.addListener) return
    let dead = false
    const handles = []

    const on = {
      // idempotent: downloadStarted also arrives for a retry we did not start
      downloadStarted: ({ id }) => {
        setJobs(j => ({ ...j, [id]: 'downloading' }))
        setFailures(f => { if (!(id in f)) return f; const n = { ...f }; delete n[id]; return n })
      },
      // The native side throttles to whole percents. A stale event can still
      // land just after downloadDone; harmless, because the row reads as
      // downloaded by then and only a downloading row consults this.
      // -1 means the total size is unknowable, so there is no honest percent
      // to show; the byte counts are still real and the UI prints those.
      downloadProgress: ({ id, progress: f, completedBytes, totalBytes }) => {
        const pct = typeof f === 'number' && isFinite(f) && f >= 0
          ? Math.min(Math.max(f, 0), 1)
          : null
        setProgress(p => ({ ...p, [id]: { pct, done: Number(completedBytes) || 0, total: Number(totalBytes) || 0 } }))
      },
      // The bytes are in; loadModelContainer is now reading them back off disk
      // and laying the model out, which reports nothing. On a 5 GB model that
      // silence lasts long enough that a bar parked at 99% reads as a hang —
      // Tony, 2026-08-30: "its hanging at 99%". Name the wait instead.
      downloadPreparing: ({ id }) => {
        setJobs(j => (j[id] === 'preparing' ? j : { ...j, [id]: 'preparing' }))
      },
      downloadDone: ({ id }) => {
        setJobs(j => { const n = { ...j }; delete n[id]; return n })
        setProgress(p => { if (!(id in p)) return p; const n = { ...p }; delete n[id]; return n })
        setModels(ms => ms.map(m => (m.id === id ? { ...m, downloaded: true } : m)))
        setJustDone(id)
        haptics.notification('SUCCESS')
        refreshDisk()
        setTimeout(() => { if (alive.current) setJustDone(cur => (cur === id ? null : cur)) }, 900)
      },
      // Stopping a download is a choice, not a failure: clear the job, the
      // progress and any stale error, and say nothing. Surfacing it as an error
      // would scold the user for doing exactly what they asked for.
      downloadCancelled: ({ id }) => {
        setJobs(j => { const n = { ...j }; delete n[id]; return n })
        setProgress(p => { if (!(id in p)) return p; const n = { ...p }; delete n[id]; return n })
        setFailures(f => { if (!(id in f)) return f; const n = { ...f }; delete n[id]; return n })
        refreshDisk()
      },
      downloadFailed: ({ id, message }) => {
        setJobs(j => { const n = { ...j }; delete n[id]; return n })
        setProgress(p => { if (!(id in p)) return p; const n = { ...p }; delete n[id]; return n })
        setFailures(f => ({ ...f, [id]: message || 'The download did not finish.' }))
        haptics.notification('ERROR')
      }
    }

    for (const [ev, fn] of Object.entries(on)) {
      // addListener resolves to the handle in Capacitor 7; if we unmount before
      // it settles, tear it down on arrival
      Promise.resolve(lm.addListener(ev, fn))
        .then(h => { if (dead) h?.remove?.(); else handles.push(h) })
        .catch(() => {})
    }
    return () => { dead = true; handles.forEach(h => h?.remove?.()) }
  }, [refreshDisk])

  // ── actions ───────────────────────────────────────────────────────────────

  const downloadingId = useMemo(
    () => Object.keys(jobs).find(id => jobs[id] === 'downloading') || null,
    [jobs]
  )

  const download = useCallback(async (id) => {
    const lm = LM()
    if (!lm?.download || !id) return
    // one at a time — which is also what enforces "exactly one gauge animates"
    if (Object.values(jobs).includes('downloading')) return
    setJobs(j => ({ ...j, [id]: 'downloading' }))
    setFailures(f => { if (!(id in f)) return f; const n = { ...f }; delete n[id]; return n })
    haptics.impact('MEDIUM')
    try {
      await lm.download({ id })
    } catch (e) {
      if (!alive.current) return
      setJobs(j => { const n = { ...j }; delete n[id]; return n })
      setFailures(f => ({ ...f, [id]: e?.message || 'The download did not start.' }))
      haptics.notification('ERROR')
    }
  }, [jobs])

  // Stop a running download. The optimistic clear matters: cancelling a 2.3 GB
  // transfer is the one moment the user is already annoyed, and waiting for the
  // native round trip to redraw the row reads as the tap not landing. The
  // downloadCancelled event then confirms it; if the native side says the job
  // had already finished, the next refresh reconciles.
  const cancel = useCallback(async (id) => {
    const lm = LM()
    if (!lm?.cancelDownload || !id) return
    haptics.impact('MEDIUM')
    setJobs(j => { const n = { ...j }; delete n[id]; return n })
    setProgress(p => { if (!(id in p)) return p; const n = { ...p }; delete n[id]; return n })
    try { await lm.cancelDownload({ id }) } catch { /* the event still reconciles */ }
  }, [])

  const remove = useCallback(async (id) => {
    const lm = LM()
    if (!lm?.remove || !id) return
    try { await lm.remove({ id }) } catch { /* the row below still reconciles */ }
    if (!alive.current) return
    setModels(ms => ms.map(m => (m.id === id ? { ...m, downloaded: false } : m)))
    refreshDisk()
  }, [refreshDisk])

  const bytesOf = useCallback(
    (m) => Math.round((Number(m?.sizeGB) || 0) * GB),
    []
  )

  const downloaded = useMemo(() => models.filter(m => m?.downloaded), [models])
  const usedBytes = useMemo(
    () => downloaded.reduce((n, m) => n + bytesOf(m), 0),
    [downloaded, bytesOf]
  )

  const fits = useCallback((m) => {
    if (!disk || typeof disk.free !== 'number') return true // no claim without data
    return bytesOf(m) <= disk.free
  }, [disk, bytesOf])

  const shortfall = useCallback((m) => {
    if (!disk || typeof disk.free !== 'number') return 0
    return Math.max(0, bytesOf(m) - disk.free)
  }, [disk, bytesOf])

  /**
   * Runs well / runs tight / won't run on THIS iPhone, or null before the phone
   * has said how much memory it can spare. Thresholds live in fit.js and are
   * shared with the Mac app's, so the two never disagree about a model.
   */
  const fitOfModel = useCallback((m) => fitOf(m?.sizeGB, disk?.ram || 0), [disk])

  return {
    models,
    downloaded,
    ready,
    error,
    jobs,
    failures,
    justDone,
    progress,
    downloadingId,
    disk,
    usedBytes,
    bytesOf,
    fits,
    shortfall,
    fitOf: fitOfModel,
    ramAvailable: disk?.ram || null,
    download,
    cancel,
    remove,
    refresh,
    refreshDisk
  }
}

export default useLocalModels

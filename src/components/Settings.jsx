import React, { useEffect, useRef, useState } from 'react'
import { verdict, FIT_LABEL, FITS_WELL, FITS_TIGHT, FITS_NO, COMFORTABLE } from '../fit.js'
import { api, startDownload, getDownloads, cancelDownload, streamQuantize, getServer, setServer, testServer, saveToFile } from '../api.js'
import { THEMES, MODES, FONTS, UI_SCALES, applyTheme, hexToOklch, accentHex } from '../theme.js'
import { MOTIONS } from './MotionBackground.jsx'
import { Icon } from './Icons.jsx'
import { AGENT_ICONS, AGENT_ICON_IDS, AgentGlyph } from './AgentIcons.jsx'
import { AGENT_TEMPLATES, AGENT_TEMPLATE_CATS } from '../agentTemplates.js'

// strip a leading "You are (a|an|the) …" so descriptions read as a role, not a command
function cleanDesc (s) {
  const t = (s || '').trim().replace(/^you(?:'re| are)\s+(?:an?|the)?\s*/i, '')
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t
}

// ---------- Providers ----------

function ProviderRow ({ provider, oauthInfo, onConfig }) {
  const [draft, setDraft] = useState('')
  const [signingIn, setSigningIn] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [device, setDevice] = useState(null) // { userCode, verificationUrl } for device-code sign-in
  const pollRef = useRef(null)

  const [addingKey, setAddingKey] = useState(false) // paste-a-second-key mode
  const accounts = provider.accounts || []

  const save = async (newAccount) => {
    if (!draft.trim()) return
    const cfg = await api.setKey(provider.id, draft.trim(), { newAccount })
    setDraft(''); setAddingKey(false)
    onConfig(cfg)
  }
  const clear = async () => onConfig(await api.setKey(provider.id, ''))
  const remove = async () => onConfig(await api.removeProvider(provider.id))
  const signOut = async () => onConfig(await api.oauthSignout(provider.id))
  const switchAccount = async id => onConfig(await api.activateAccount(provider.id, id))
  const removeAcct = async id => onConfig(await api.removeAccount(provider.id, id))

  const startSignIn = async (newAccount) => {
    setBusy(true)
    try {
      if (oauthInfo.mode === 'device') {
        const d = await api.oauthDeviceStart(provider.id, { newAccount })
        setDevice(d)
        window.open(d.verificationUrl, '_blank', 'noopener')
        const started = Date.now()
        pollRef.current = setInterval(async () => {
          try {
            const r = await api.oauthDevicePoll(provider.id)
            if (r.done) { clearInterval(pollRef.current); onConfig(r.config); setDevice(null); setBusy(false) }
            else if (Date.now() - started > (d.expiresIn || 600) * 1000) { clearInterval(pollRef.current); setDevice(null); setBusy(false); window.alert('Sign-in timed out — try again.') }
          } catch (e) { clearInterval(pollRef.current); setDevice(null); setBusy(false); window.alert('Sign-in failed: ' + e.message) }
        }, (d.interval || 5) * 1000)
        return
      }
      const { url, mode } = await api.oauthStart(provider.id, { newAccount })
      window.open(url, '_blank', 'noopener')
      if (mode === 'paste') {
        setSigningIn(true)
      } else {
        // loopback: poll until the vendor redirect lands on our local listener
        pollRef.current = setInterval(async () => {
          const { signedIn } = await api.oauthStatus(provider.id)
          if (signedIn) {
            clearInterval(pollRef.current)
            onConfig(await api.getConfig())
            setBusy(false)
          }
        }, 1500)
      }
    } catch (e) { window.alert('Sign-in failed to start: ' + e.message); setBusy(false) }
  }
  const finishSignIn = async () => {
    if (!code.trim()) return
    try {
      const cfg = await api.oauthComplete(provider.id, code.trim())
      onConfig(cfg)
      setSigningIn(false); setCode(''); setBusy(false)
    } catch (e) { window.alert('Sign-in failed: ' + e.message) }
  }
  useEffect(() => () => clearInterval(pollRef.current), [])

  return (
    <div className='provider-row-wrap'>
      <div className='provider-row'>
        <div className='p-name'>{provider.name}</div>
        <div className='p-url'>{provider.baseUrl}</div>
        {provider.signedIn
          ? <>
              <span className='key-ok'>✓ subscription</span>
              <button className='small-btn' onClick={signOut}>Sign out</button>
            </>
          : provider.auth === 'none'
            ? <span className='key-ok'>no key needed</span>
            : provider.auth === 'oauth'
              ? <span className='v-meta'>Sign in below ↓</span>
            : provider.hasKey
              ? <>
                  <span className='key-ok'>✓ key saved</span>
                  <button className='small-btn' onClick={clear}>Remove key</button>
                </>
              : <>
                  <input
                    type='password'
                    placeholder='Paste API key'
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && save()}
                  />
                  <button className='small-btn primary' onClick={() => save()} disabled={!draft.trim()}>Save</button>
                </>}
        {provider.removable && <button className='small-btn danger' onClick={remove}>✕</button>}
      </div>
      {(provider.hasKey || provider.signedIn) && accounts.length > 0 && (
        <div className='account-row'>
          {accounts.map(a => (
            <span key={a.id} className={'account-chip' + (a.active ? ' active' : '')}>
              <button className='account-switch' onClick={() => !a.active && switchAccount(a.id)} title={a.active ? 'Active account' : 'Switch to this account'}>
                <span className='account-dot'>{a.active ? '●' : '○'}</span>{a.label}
              </button>
              <button className='account-x' onClick={() => removeAcct(a.id)} title='Remove this account'>✕</button>
            </span>
          ))}
          {addingKey && provider.auth !== 'oauth'
            ? <span className='account-add-key'>
                <input autoFocus type='password' placeholder='Paste another key' value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && save(true)} />
                <button className='small-btn primary' onClick={() => save(true)} disabled={!draft.trim()}>Add</button>
                <button className='small-btn' onClick={() => { setAddingKey(false); setDraft('') }}>Cancel</button>
              </span>
            : !device && !signingIn && <button className='account-add' onClick={() => oauthInfo ? startSignIn(true) : setAddingKey(true)} disabled={busy}>+ Add account</button>}
        </div>
      )}
      {provider.hint && !provider.hasKey && !provider.signedIn && <div className='provider-hint'>{provider.hint}</div>}
      {oauthInfo && !provider.signedIn && !provider.hasKey && (
        <div className='provider-oauth'>
          {device
            ? <span className='oauth-device'>
                <span>Enter code <code className='device-code'>{device.userCode}</code> at the page that opened, then approve.</span>
                <button className='small-btn' onClick={() => window.open(device.verificationUrl, '_blank', 'noopener')}>Reopen page</button>
                <span className='v-meta'>Waiting for you to approve…</span>
                <button className='small-btn' onClick={() => { clearInterval(pollRef.current); setDevice(null); setBusy(false) }}>Cancel</button>
              </span>
            : !signingIn
              ? <button className='small-btn subscribe' onClick={() => startSignIn()} disabled={busy}>
                  {busy ? 'Waiting…' : `Sign in with ${oauthInfo.label} subscription`}
                </button>
              : <span className='oauth-paste'>
                  <input placeholder='Paste the code from the page' value={code} onChange={e => setCode(e.target.value)} onKeyDown={e => e.key === 'Enter' && finishSignIn()} />
                  <button className='small-btn primary' onClick={finishSignIn} disabled={!code.trim()}>Finish</button>
                  <button className='small-btn' onClick={() => { setSigningIn(false); setBusy(false) }}>Cancel</button>
                </span>}
          <span className='oauth-note'>Uses your paid plan — unofficial, may break, small account risk.</span>
        </div>
      )}
    </div>
  )
}

function ProvidersPane ({ config, onConfigChange }) {
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [oauthMap, setOauthMap] = useState({})
  useEffect(() => {
    api.oauthProviders().then(list => {
      const m = {}
      for (const o of list) m[o.id] = o
      setOauthMap(m)
    }).catch(() => {})
  }, [])
  const addProvider = async () => {
    if (!newName.trim() || !newUrl.trim()) return
    const cfg = await api.addProvider({ name: newName.trim(), baseUrl: newUrl.trim(), type: 'openai', auth: 'key' })
    setNewName(''); setNewUrl('')
    onConfigChange(cfg)
  }
  return (
    <div className='set-section'>
      <h3>Providers &amp; keys</h3>
      {config.providers.map(p => (
        <ProviderRow key={p.id} provider={p} oauthInfo={oauthMap[p.id]} onConfig={onConfigChange} />
      ))}
      <div className='add-provider'>
        <input placeholder='Name (e.g. Groq)' value={newName} onChange={e => setNewName(e.target.value)} />
        <input placeholder='Base URL (…/v1, OpenAI-compatible)' style={{ flex: 1, minWidth: 220 }} value={newUrl} onChange={e => setNewUrl(e.target.value)} />
        <button className='small-btn' onClick={addProvider}>Add provider</button>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 0 }}>
        Keys are stored locally in <span className='mono'>~/.radiant/config.json</span> and never leave this Mac except to call the provider itself.
        Any OpenAI-compatible server works — Groq, Mistral, Together, a remote Ollama box…
      </p>
    </div>
  )
}

// ---------- Models (local, via Ollama) ----------

/**
 * ⚠️ THE WORDS AND THRESHOLDS ARE IN src/fit.js, SHARED WITH THE PHONE.
 * Tony: "we should standardize the naming conventions." This file used to
 * define its own — "runs well / tight fit / too big" against the phone's
 * "Runs well / Runs tight / Won't run" — same judgement, two vocabularies.
 * Only the CSS class names stay local, because they are this stylesheet's.
 */
const FIT_CLASS = { [FITS_WELL]: 'fit-ok', [FITS_TIGHT]: 'fit-tight', [FITS_NO]: 'fit-no' }
function fitClass (ramGB, systemRam) {
  const v = verdict(ramGB, systemRam)
  return v ? FIT_CLASS[v] : ''
}
const FIT_TEXT = {
  'fit-ok': FIT_LABEL[FITS_WELL],
  'fit-tight': FIT_LABEL[FITS_TIGHT],
  'fit-no': FIT_LABEL[FITS_NO]
}

function ramNeededGB (fileSizeGB) {
  return Math.round(fileSizeGB * 1.15 + 1.5)
}

function fmtCount (n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return Math.round(n / 1e3) + 'k'
  return String(n)
}

function HFRepoRow ({ repo, installedCheck, pulls, onPull, onCancel, systemRam, diskFree }) {
  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState(null)
  const [failed, setFailed] = useState(false)
  const toggle = async () => {
    setOpen(o => !o)
    if (!files && !failed) {
      try { setFiles(await api.registryFiles(repo.id)) } catch { setFailed(true) }
    }
  }
  return (
    <div className='model-family'>
      <button className='mf-head hf-head' onClick={toggle}>
        <span className='mf-name mono' style={{ fontSize: 12.5 }}>{repo.id}</span>
        <span className='v-meta'>{fmtCount(repo.downloads)} downloads · {fmtCount(repo.likes)} likes</span>
        <span className='tool-status' style={{ color: 'var(--text-faint)' }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && !files && !failed && <div className='variant-row'><span className='v-meta'>Loading quantizations…</span></div>}
      {open && failed && <div className='variant-row'><span className='v-meta'>Could not load file list.</span></div>}
      {open && files && !files.quants.length && <div className='variant-row'><span className='v-meta'>No GGUF files in this repo.</span></div>}
      {open && files && files.quants.map(qt => {
        const model = qt.model
        const ram = ramNeededGB(qt.sizeGB)
        const fit = fitClass(ram, systemRam)
        const noDisk = diskFree != null && qt.sizeGB > diskFree - 2 // keep ~2 GB headroom
        const pull = pulls[model]
        const pct = pull && pull.total ? Math.round((pull.completed / pull.total) * 100) : null
        // Every byte is here but the model is not usable yet — see the note below.
        const importing = Boolean(pull) && pct === 100 && !pull.done && !pull.error
        return (
          <div key={qt.label} className='variant-row'>
            <span className='v-tag mono'>{qt.label.toLowerCase()}{qt.sharded ? ` · ${qt.files.length} parts` : ''}</span>
            <span className='v-meta'>{qt.sizeGB} GB download · ~{ram} GB RAM</span>
            <span className={'fit-badge ' + fit}>{FIT_TEXT[fit] || ''}</span>
            {noDisk && <span className='fit-badge fit-no' title={`Only ${diskFree} GB free on disk`}>not enough disk</span>}
            <span className='v-action'>
              {installedCheck(model)
                ? <span className='key-ok'>✓ installed</span>
                : pull
                  ? <span className='pull-progress'>
                      <span className={'pull-bar' + (importing ? ' importing' : '')}><span style={{ width: (pct ?? 5) + '%' }} /></span>
                      {/* ⚠️ 100% IS NOT DONE, AND THIS USED TO CLAIM IT WAS.
                          The bytes finishing is the halfway point: `ollama create`
                          then copies and hashes the whole file into Ollama's own
                          store, which for a 14.6 GB model is minutes. The server
                          says so — it sets status to "importing into Ollama…" —
                          but this line read `pct != null ? pct + '%' : status`,
                          and pct is never null once the total is known, so the
                          status was computed, sent, and thrown away. Tony sat on
                          "100%" with the model nowhere in the list: "i just
                          downloaded a version of qwen iq4 and it says 100% and i
                          dont see it anywhere." It was importing the whole time. */}
                      {importing ? (pull.status || 'importing…') : (pct != null ? pct + '%' : (pull.status || 'starting…'))}
                      <button className='pull-stop' title='Stop download' onClick={() => onCancel(model)}>✕</button>
                    </span>
                  : <button className='small-btn' onClick={() => onPull({ repo: repo.id, files: qt.files, model })} disabled={fit === 'fit-no' || noDisk} title={noDisk ? `Not enough free disk (${diskFree} GB free, needs ${qt.sizeGB} GB)` : ''}>Download</button>}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function QuantizeBlock ({ systemRam, onDone }) {
  const [data, setData] = useState(null) // {models, quants}
  const [source, setSource] = useState('')
  const [quant, setQuant] = useState('q4_K_M')
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState([])
  const [err, setErr] = useState(null)

  const load = () => api.quantizeCandidates().then(d => {
    setData(d)
    if (d.models?.length && !source) setSource(d.models[0].name)
  }).catch(e => setErr(e.message))
  useEffect(() => { load() }, [])

  const srcModel = data?.models?.find(m => m.name === source)
  const quantInfo = data?.quants?.find(q => q.id === quant)
  const estGB = srcModel && quantInfo ? +(srcModel.sizeGB * quantInfo.factor).toFixed(1) : null
  const targetName = source ? `${source.split(':')[0]}:${quant.toLowerCase()}` : ''

  const run = async () => {
    setRunning(true); setLog([]); setErr(null)
    try {
      await streamQuantize({ source, target: targetName, quant }, ev => {
        if (ev.error) setErr(ev.error)
        else if (ev.line) setLog(l => [...l.slice(-6), ev.line])
      })
    } catch (e) { setErr(e.message) }
    setRunning(false)
    load(); onDone()
  }

  if (data && !data.models.length) {
    return (
      <div className='quant-block'>
        <div className='quant-title'>Shrink a model (quantize)</div>
        <div className='hf-note'>
          Quantizing turns a full-precision model into a smaller one that needs less RAM.
          You don't have a full-precision model yet — download an <strong>F16</strong> or <strong>BF16</strong> GGUF
          from Hugging Face below, then come back here to shrink it.
        </div>
      </div>
    )
  }
  if (!data) return null

  return (
    <div className='quant-block'>
      <div className='quant-title'>Shrink a model (quantize)</div>
      <div className='hf-note'>Turn a full-precision model into a smaller one that runs on less RAM.</div>
      <div className='quant-row'>
        <label>Model</label>
        <select className='text-input' value={source} onChange={e => setSource(e.target.value)} disabled={running}>
          {data.models.map(m => <option key={m.name} value={m.name}>{m.name} ({m.quant}, {m.sizeGB} GB)</option>)}
        </select>
      </div>
      <div className='quant-row'>
        <label>Quant</label>
        <select className='text-input' value={quant} onChange={e => setQuant(e.target.value)} disabled={running}>
          {data.quants.map(q => <option key={q.id} value={q.id}>{q.label} — {q.note}</option>)}
        </select>
      </div>
      <div className='quant-est'>
        Result: <span className='mono'>{targetName}</span>
        {estGB != null && <> · about {estGB} GB{systemRam && <> · <span className={estGB <= systemRam * COMFORTABLE ? 'key-ok' : 'fit-badge fit-tight'}>{estGB <= systemRam * COMFORTABLE ? FIT_LABEL[FITS_WELL] : FIT_LABEL[FITS_TIGHT]}</span></>}</>}
      </div>
      <button className='small-btn primary' onClick={run} disabled={running || !source}>
        {running ? 'Quantizing…' : 'Quantize'}
      </button>
      {log.length > 0 && <pre className='quant-log'>{log.join('\n')}</pre>}
      {err && <div className='error-note'>⚠ {err}</div>}
      {!running && !err && log.length > 0 && <div className='update-none'>Done — {targetName} is ready in your model list.</div>}
    </div>
  )
}

// ⚠️ A SETTING NOBODY CAN SET IS NOT A SETTING. settings.defaultModel decided
// the model for every new chat and there was no control for it anywhere in the
// app — it could only ever be null, so every chat started on whatever the
// fallback resolved to. Tony: "we have no where to set a default model for new
// chats." It is machine-local (see MACHINE_KEYS), because the model you want by
// default depends on what is installed on the Mac you are sitting at.
function DefaultModelBlock ({ config, onSettings }) {
  const [models, setModels] = useState([])
  useEffect(() => { api.getModels().then(r => setModels(r.models || r || [])).catch(() => {}) }, [])
  const current = config?.settings?.defaultModel || ''
  return (
    <div className='set-block' style={{ marginBottom: 16 }}>
      <div className='set-block-title'>Default model for new chats</div>
      <p className='hint' style={{ marginTop: 2 }}>
        What a new chat starts on when nothing else decides — an agent's own model, or a
        project's, still wins. Set per Mac, so a Mac can default to the models it has
        downloaded rather than ones it cannot run.
      </p>
      <select
        className='text-input'
        style={{ fontFamily: 'inherit', marginTop: 8 }}
        value={current}
        onChange={e => {
          const m = models.find(x => x.id === e.target.value)
          onSettings({ defaultModel: e.target.value || null, defaultProvider: m ? m.provider : null })
        }}
      >
        <option value=''>No default — pick a model in each chat</option>
        {models.map(m => <option key={m.provider + m.id} value={m.id}>{m.providerName} · {m.id}</option>)}
      </select>
      {current && !models.some(m => m.id === current) && (
        <div className='set-hint' style={{ marginTop: 6 }}>
          <strong>{current}</strong> is set here but is not available on this Mac right now —
          new chats will fall back until it is, or until you pick another.
        </div>
      )}
    </div>
  )
}

function ModelsPane ({ onModelsChanged, config, onSettings }) {
  const [system, setSystem] = useState(null)
  const [local, setLocal] = useState({ running: true, models: [] })
  const [q, setQ] = useState('')
  const [sort, setSort] = useState('downloads')
  const [hfResults, setHfResults] = useState(null)
  const [hfError, setHfError] = useState(null)
  const [pulls, setPulls] = useState({}) // model -> {status, completed, total, error, done}
  const seenDone = useRef(new Set())
  const hfTimer = useRef(null)

  useEffect(() => {
    clearTimeout(hfTimer.current)
    hfTimer.current = setTimeout(() => {
      setHfResults(null)
      setHfError(null)
      api.registrySearch(q, sort).then(setHfResults).catch(e => setHfError(e.message))
    }, q ? 400 : 0)
    return () => clearTimeout(hfTimer.current)
  }, [q, sort])

  const refreshLocal = () => api.getLocalModels().then(setLocal).catch(() => {})
  useEffect(() => {
    api.getSystem().then(setSystem).catch(() => {})
    refreshLocal()
  }, [])

  // Downloads run detached on the server — poll their status so leaving and
  // re-opening this screen never interrupts an in-flight download.
  useEffect(() => {
    let alive = true
    const tick = async () => {
      const list = await getDownloads().catch(() => [])
      if (!alive) return
      const map = {}
      for (const d of list) {
        map[d.model] = d
        // when a download finishes, refresh the installed list once
        if ((d.done || d.error) && !seenDone.current.has(d.model)) {
          seenDone.current.add(d.model)
          if (d.error) window.alert(`Download failed: ${d.error}`)
          refreshLocal(); onModelsChanged()
        }
        if (!d.done && !d.error) seenDone.current.delete(d.model)
      }
      setPulls(map)
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const installedSet = new Set(local.models.map(m => m.name.replace(/:latest$/, '')))
  const isInstalled = tag => installedSet.has(tag) || installedSet.has(tag.replace(/:latest$/, ''))

  // item: { repo, files, model } — download exact GGUF file(s) from HF, import via Ollama
  const startPull = async item => {
    seenDone.current.delete(item.model)
    setPulls(p => ({ ...p, [item.model]: { status: 'starting', completed: 0, total: 0 } }))
    try { await startDownload(item) } catch (e) { window.alert(`Couldn't start download: ${e.message}`) }
  }

  const cancelPull = model => { cancelDownload(model); setPulls(p => { const n = { ...p }; delete n[model]; return n }) }

  const remove = async tag => {
    if (!window.confirm(`Remove ${tag} from disk?`)) return
    await api.deleteLocalModel(tag)
    refreshLocal()
    onModelsChanged()
  }

  return (
    <div className='set-section'>
      <DefaultModelBlock config={config} onSettings={onSettings} />
      <h3>Local models</h3>
      {system && (
        <div className='spec-card'>
          <div className='spec-chip-name'>{system.chip}</div>
          <div className='spec-detail'>
            {system.ramGB} GB unified memory · {system.cores} cores · macOS {system.osVersion}
            {system.diskFreeGB != null && <> · <span className={system.diskFreeGB < 20 ? 'fit-badge fit-tight' : ''}>{system.diskFreeGB} GB free on disk</span></>}
          </div>
          <div className='spec-note'>
            Badges show what fits: <span className='fit-badge fit-ok'>{FIT_LABEL[FITS_WELL]}</span> under {Math.round(system.ramGB * COMFORTABLE)} GB,
            <span className='fit-badge fit-tight'> {FIT_LABEL[FITS_TIGHT]}</span> near the limit,
            <span className='fit-badge fit-no'> {FIT_LABEL[FITS_NO]}</span> on this Mac.
          </div>
        </div>
      )}
      {!local.running && (
        <div className='error-note'>⚠ Ollama isn't running — start it to download and run local models.</div>
      )}

      {local.models.length > 0 && (
        <div className='installed-block'>
          <div className='installed-label'>On this Mac · {local.models.length} installed</div>
          {[...local.models].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map(m => (
            <div key={m.name} className='installed-row'>
              <span className='v-tag mono'>{m.name}</span>
              <span className='v-meta'>{m.sizeGB} GB</span>
              <button className='small-btn danger' title='Remove from disk' onClick={() => remove(m.name)}>✕</button>
            </div>
          ))}
        </div>
      )}

      <QuantizeBlock systemRam={system?.ramGB} onDone={() => { refreshLocal(); onModelsChanged() }} />

      <div className='model-filter-row'>
        <input
          className='text-input' style={{ fontFamily: 'inherit' }}
          placeholder='Search Hugging Face for downloadable models…'
          value={q} onChange={e => setQ(e.target.value)}
        />
      </div>
      <div className='model-filter-row'>
        <span className='sort-label'>Sort</span>
        {[['downloads', 'Most downloaded'], ['likes', 'Most liked'], ['trending', 'Trending'], ['updated', 'Recently updated'], ['created', 'Newest']].map(([id, label]) => (
          <button key={id} className={'pill-toggle' + (sort === id ? ' on' : '')} onClick={() => setSort(id)}>{label}</button>
        ))}
      </div>
      <div className='hf-note'>
        Downloads come from Hugging Face (the same source LM Studio and Unsloth use), pulled through Ollama.
        Expand a model to pick a quantization.
      </div>
      <div className='model-catalog'>
        {hfError && <div className='error-note'>⚠ Registry search failed: {hfError}</div>}
        {!hfResults && !hfError && <div className='activity-empty'>Searching Hugging Face…</div>}
        {hfResults && hfResults.map(r => (
          <HFRepoRow
            key={r.id}
            repo={r}
            installedCheck={tag => isInstalled(tag)}
            pulls={pulls}
            onPull={startPull}
            onCancel={cancelPull}
            systemRam={system?.ramGB}
            diskFree={system?.diskFreeGB}
          />
        ))}
        {hfResults && !hfResults.length && <div className='activity-empty'>No GGUF models match.</div>}
      </div>
    </div>
  )
}

// ---------- MCP ----------

function McpPane ({ config, onConfigChange }) {
  const servers = config.mcpServers || []
  const [status, setStatus] = useState([])
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')

  const loadStatus = () => api.mcpStatus().then(r => setStatus(r.servers || [])).catch(() => {})
  useEffect(() => { loadStatus() }, [servers.length])

  const add = async () => {
    if (!name.trim() || !command.trim()) return
    const [cmd, ...args] = command.trim().split(/\s+/)
    const cfg = await api.addMcp({ name: name.trim(), command: cmd, args })
    setName(''); setCommand(''); setAdding(false)
    onConfigChange(cfg); setTimeout(loadStatus, 500)
  }
  const toggle = async (id, enabled) => { onConfigChange(await api.updateMcp(id, { enabled })); setTimeout(loadStatus, 500) }
  const remove = async id => { if (window.confirm('Remove this MCP server?')) onConfigChange(await api.deleteMcp(id)) }

  const st = id => status.find(s => s.id === id)
  return (
    <div className='set-section'>
      <h3>MCP servers</h3>
      <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 0 }}>
        Model Context Protocol servers give agents extra tools — databases, APIs, file systems, and more.
        Add a server by its launch command; its tools become available to the agent (each call asks approval).
      </p>

      {servers.map(s => {
        const info = st(s.id)
        return (
          <div key={s.id} className='mcp-row'>
            <label className='skill-toggle'><input type='checkbox' checked={s.enabled !== false} onChange={e => toggle(s.id, e.target.checked)} /></label>
            <div className='skill-main'>
              <div className='skill-name'>{s.name} {info && (info.connected ? <span className='key-ok'>✓ {info.toolCount} tools</span> : <span className='fit-badge fit-no'>{info.error ? 'error' : 'off'}</span>)}</div>
              <div className='skill-body mono'>{s.url || `${s.command} ${(s.args || []).join(' ')}`}</div>
              {info?.error && <div className='error-note' style={{ fontSize: 11 }}>{info.error}</div>}
              {info?.connected && info.tools?.length > 0 && <div className='skill-body'>Tools: {info.tools.slice(0, 8).join(', ')}{info.tools.length > 8 ? '…' : ''}</div>}
            </div>
            <button className='small-btn danger' onClick={() => remove(s.id)}>✕</button>
          </div>
        )
      })}
      {!servers.length && <div className='activity-empty' style={{ marginTop: 8 }}>No MCP servers yet.</div>}

      {adding
        ? <div className='skill-add'>
            <input className='text-input' style={{ fontFamily: 'inherit', marginBottom: 8 }} placeholder='Name (e.g. Filesystem)' value={name} onChange={e => setName(e.target.value)} />
            <input className='text-input' style={{ marginBottom: 4 }} placeholder='Launch command (e.g. npx -y @modelcontextprotocol/server-filesystem ~/Projects)' value={command} onChange={e => setCommand(e.target.value)} />
            <div className='oauth-note'>Runs as a local process. Only add servers you trust.</div>
            <div className='row' style={{ marginTop: 8 }}>
              <button className='small-btn primary' onClick={add} disabled={!name.trim() || !command.trim()}>Add server</button>
              <button className='small-btn' onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        : <button className='small-btn' style={{ marginTop: 12 }} onClick={() => setAdding(true)}>+ Add MCP server</button>}
    </div>
  )
}

// ---------- Agents ----------

function AgentEditor ({ agent, skills, models, onSave, onDelete, onClose, onDuplicate }) {
  const [a, setA] = useState({ ...agent })
  const set = patch => setA(prev => ({ ...prev, ...patch }))
  const accentHue = Math.round(Number(getComputedStyle(document.documentElement).getPropertyValue('--accent-h')) || 258)
  const toggleSkill = id => set({ skills: (a.skills || []).includes(id) ? a.skills.filter(s => s !== id) : [...(a.skills || []), id] })
  return (
    <div className='agent-editor'>
      <div className='agent-editor-head'>
        <span className='agent-emoji-input' style={{ color: `oklch(0.65 0.15 ${a.hue ?? 'var(--accent-h)'})` }}><AgentGlyph agent={a} size={22} /></span>
        <input className='text-input' style={{ fontFamily: 'inherit', flex: 1 }} placeholder='Agent name' value={a.name} onChange={e => set({ name: e.target.value })} />
      </div>
      <div className='agent-field'>Icon
        <div className='icon-picker'>
          {AGENT_ICON_IDS.map(id => (
            <button key={id} type='button' className={'icon-choice' + (a.icon === id ? ' sel' : '')} style={{ '--ah': a.hue ?? 'var(--accent-h)' }} onClick={() => set({ icon: id })} title={id}>
              {AGENT_ICONS[id]({ size: 18 })}
            </button>
          ))}
        </div>
      </div>
      <label className='agent-field'>Personality / instructions
        <textarea className='text-input' style={{ fontFamily: 'inherit', minHeight: 90, resize: 'vertical' }} placeholder="e.g. You are a meticulous code reviewer…" value={a.persona || ''} onChange={e => set({ persona: e.target.value })} />
      </label>
      <label className='agent-field'>Model
        <select className='text-input' style={{ fontFamily: 'inherit' }} value={a.model || ''} onChange={e => {
          const m = models.find(x => x.id === e.target.value)
          set({ model: e.target.value || null, provider: m ? m.provider : null })
        }}>
          <option value=''>Session default (pick per chat)</option>
          {models.map(m => <option key={m.provider + m.id} value={m.id}>{m.providerName} · {m.id}</option>)}
        </select>
      </label>
      <label className='agent-field'>Planner model <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>— optional lead model that plans first, then the model above executes</span>
        <select className='text-input' style={{ fontFamily: 'inherit' }} value={a.plannerModel || ''} onChange={e => {
          const m = models.find(x => x.id === e.target.value)
          set({ plannerModel: e.target.value || null, plannerProvider: m ? m.provider : null })
        }}>
          <option value=''>None (no separate planning step)</option>
          {models.map(m => <option key={m.provider + m.id} value={m.id}>{m.providerName} · {m.id}</option>)}
        </select>
      </label>
      <label className='agent-field'>Color
        <span className='agent-color-row'>
          <input type='range' min='0' max='360' className='hue-slider' value={a.hue ?? accentHue} onChange={e => set({ hue: Number(e.target.value) })} />
          <span className='agent-color-dot' style={{ background: `oklch(0.7 0.16 ${a.hue ?? 'var(--accent-h)'})` }} />
          {a.hue == null
            ? <span className='agent-color-note'>Accent</span>
            : <button type='button' className='agent-color-reset' onClick={() => set({ hue: null })}>Use accent</button>}
        </span>
      </label>
      {skills.length > 0 && (
        <div className='agent-field'>Skills for this agent
          <span className='agent-field-hint'>Turns a skill on for just this agent. Ones tagged “all agents” are already on everywhere (from Settings → Skills).</span>
          <div className='agent-skills'>
            {skills.map(sk => (
              <label key={sk.id} className='agent-skill-chk'>
                <input type='checkbox' checked={(a.skills || []).includes(sk.id)} onChange={() => toggleSkill(sk.id)} /> {sk.name}
                {sk.enabled && <span className='skill-global-tag' title='Enabled globally in Settings → Skills'>all agents</span>}
              </label>
            ))}
          </div>
        </div>
      )}
      <div className='agent-field-row'>
        <label className='agent-skill-chk'><input type='checkbox' checked={a.useTools !== false} onChange={e => set({ useTools: e.target.checked })} /> Agent tools</label>
        <label className='agent-skill-chk'><input type='checkbox' checked={Boolean(a.computerControl)} onChange={e => set({ computerControl: e.target.checked })} /> Computer control</label>
      </div>
      <div className='row' style={{ marginTop: 10 }}>
        <button className='small-btn primary' onClick={() => onSave(a)} disabled={!a.name?.trim()}>Save</button>
        <button className='small-btn' onClick={onClose}>Cancel</button>
        {agent.id && onDuplicate && <button className='small-btn' onClick={() => onDuplicate(a)} title='Make an editable copy of this agent'>Duplicate</button>}
        {!agent.builtin && agent.id && <button className='small-btn danger' style={{ marginLeft: 'auto' }} onClick={() => onDelete(agent.id)}>Delete</button>}
      </div>
    </div>
  )
}

function AgentsPane ({ config, onConfigChange, initialView }) {
  const agents = config.agents || []
  // An agent counts as imported if it came from another app (`source`) or talks
  // to one (`relay`). Checking both adopts agents imported before `source` was
  // stored — otherwise they sit in the main grid wearing a hue tint that isn't
  // theirs.
  const isImported = a => Boolean(a.source || a.relay)
  const importedAgents = agents.filter(isImported)
  const regularAgents = agents.filter(a => !isImported(a))
  const skills = config.skills || []
  const [models, setModels] = useState([])
  const [editing, setEditing] = useState(null) // agent object or null
  const [editNonce, setEditNonce] = useState(0) // bump to remount the editor with fresh state
  const [browsing, setBrowsing] = useState(initialView === 'library') // template library open
  const [libQuery, setLibQuery] = useState('')
  const importFileRef = useRef(null)
  const [external, setExternal] = useState([])
  useEffect(() => { api.getModels().then(setModels).catch(() => {}) }, [])
  useEffect(() => { api.externalAgents().then(r => setExternal(r.agents || [])).catch(() => {}) }, [])
  const openEditor = obj => { setEditNonce(n => n + 1); setEditing(obj) }
  const fromTemplate = t => { setBrowsing(false); openEditor({ name: t.name, icon: t.icon, hue: null, persona: t.persona, model: null, provider: null, skills: [], useTools: true }) }

  const saveAgent = async a => {
    const cfg = a.id && agents.find(x => x.id === a.id)
      ? await api.updateAgent(a.id, a)
      : await api.addAgent(a)
    setEditing(null)
    onConfigChange(cfg)
  }
  const del = async id => { onConfigChange(await api.deleteAgent(id)); setEditing(null) }
  const duplicate = a => { const { id, builtin, ...copy } = a; openEditor({ ...copy, name: (a.name || 'Agent') + ' copy' }) }

  if (editing) {
    return (
      <div className='set-section'>
        <button className='back-link' onClick={() => setEditing(null)}>← All agents</button>
        <h3 style={{ marginTop: 6 }}>{editing.id ? `Edit ${editing.name || 'agent'}` : 'New agent'}</h3>
        <AgentEditor key={editNonce} agent={editing} skills={skills} models={models} onSave={saveAgent} onDelete={del} onClose={() => setEditing(null)} onDuplicate={duplicate} />
      </div>
    )
  }

  if (browsing) {
    const have = new Set(agents.map(a => a.name.toLowerCase()))
    const q = libQuery.trim().toLowerCase()
    const matches = t => !q || `${t.name} ${t.blurb} ${t.cat} ${t.persona || ''}`.toLowerCase().includes(q)
    const shownCats = AGENT_TEMPLATE_CATS.filter(cat => AGENT_TEMPLATES.some(t => t.cat === cat && matches(t)))
    const total = AGENT_TEMPLATES.filter(matches).length
    return (
      <div className='set-section'>
        <button className='back-link' onClick={() => setBrowsing(false)}>← All agents</button>
        <h3 style={{ marginTop: 6 }}>Agent library</h3>
        <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 0 }}>
          Ready-made expert agents. Pick one to review and add — you can change the model, name, and skills before saving.
        </p>
        <input className='session-search' style={{ marginBottom: 4 }} placeholder={`Filter ${AGENT_TEMPLATES.length} agents…`} value={libQuery} onChange={e => setLibQuery(e.target.value)} />
        {shownCats.map(cat => (
          <div key={cat} className='tmpl-cat'>
            <div className='tmpl-cat-label'>{cat}</div>
            <div className='tmpl-grid'>
              {AGENT_TEMPLATES.filter(t => t.cat === cat && matches(t)).map(t => (
                <button key={t.name} className='tmpl-card' onClick={() => fromTemplate(t)}>
                  <span className='tmpl-ico'>{(AGENT_ICONS[t.icon] || AGENT_ICONS.bot)({ size: 18 })}</span>
                  <span className='tmpl-body'>
                    <span className='tmpl-name'>{t.name}{have.has(t.name.toLowerCase()) && <span className='tmpl-have'>✓ added</span>}</span>
                    <span className='tmpl-blurb'>{t.blurb}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
        {!total && <p style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>No agents match “{libQuery}”.</p>}
      </div>
    )
  }

  const exportAgents = () => {
    const custom = agents.filter(a => !a.builtin).map(({ id, builtin, ...a }) => a)
    if (!custom.length) { window.alert('No custom agents to export yet. Build or add some from the library first.'); return }
    const blob = new Blob([JSON.stringify({ radiantAgents: 1, agents: custom }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'radiant-agents.json'; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const importAgents = async fileList => {
    let cfg = null; let added = 0; let skipped = 0
    const have = new Set(agents.map(a => (a.name || '').trim().toLowerCase())) // dedupe by name so re-import doesn't clone
    let found = 0
    for (const file of Array.from(fileList).slice(0, 5)) {
      try {
        const data = JSON.parse(await file.text())
        const list = Array.isArray(data) ? data : (data.agents || [])
        for (const a of list) {
          if (!a || !a.name) continue
          found++
          const key = a.name.trim().toLowerCase()
          if (have.has(key)) { skipped++; continue }
          have.add(key)
          const { id, builtin, ...clean } = a
          cfg = await api.addAgent({ ...clean, skills: clean.skills || [] }); added++
        }
      } catch {}
    }
    if (cfg) onConfigChange(cfg)
    const msg = !found
      ? 'No agents found in that file.'
      : `Imported ${added} agent${added === 1 ? '' : 's'}.` + (skipped ? ` Skipped ${skipped} already in your list (same name).` : '')
    window.alert(msg)
  }

  const importExternal = async ext => {
    const cfg = await api.addAgent({ name: ext.name, emoji: ext.emoji || '🤖', hue: ext.hue ?? null, persona: ext.persona || '', model: ext.model || null, skills: [], useTools: true, avatar: ext.avatar || null, relay: ext.relay || null, source: ext.source || null })
    onConfigChange(cfg)
  }

  return (
    <div className='set-section'>
      <h3 style={{ margin: 0 }}>Agents</h3>
      <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '8px 0 0' }}>
        Agents are named personas with their own personality, model, and skills — start a session with one to give the agent a role. <strong>Export</strong> shares your custom agents as a file; <strong>Import</strong> loads a pack.
      </p>
      <div className='row' style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button className='small-btn' onClick={exportAgents} title='Download your custom agents as a shareable file'>Export</button>
        <button className='small-btn' onClick={() => importFileRef.current?.click()} title='Import agents from a file'>Import</button>
        <input ref={importFileRef} type='file' accept='.json' multiple hidden onChange={e => { if (e.target.files.length) importAgents(e.target.files); e.target.value = '' }} />
      </div>
      {external.length > 0 && (
        <div className='ext-agents'>
          <div className='ext-agents-title'>Connected agents on this Mac</div>
          <p className='ext-agents-sub'>Radiant found other agent apps you have installed. Connect a Hermes agent to chat with the real one — its own model, skills, and memory — right inside Radiant.</p>
          {external.map(ext => {
            const already = agents.some(a => (a.name || '').trim().toLowerCase() === (ext.name || '').trim().toLowerCase())
            return (
              <div key={ext.source + ':' + ext.name} className='ext-agent'>
                <span className='ext-agent-emoji'>
                  {/* the server sends an avatar for apps that have one (Hermes);
                      fall back to the emoji for the rest */}
                  {ext.avatar
                    ? <img className='ext-agent-avatar' src={ext.avatar} alt='' width={22} height={22} />
                    : ext.emoji}
                </span>
                <span className='ext-agent-info'>
                  <span className='ext-agent-name'>{ext.name}<span className='ext-agent-src'>{ext.sourceLabel}</span></span>
                  <span className='ext-agent-note'>{ext.note}</span>
                </span>
                {ext.importable === false
                  ? <span className='ext-agent-tag'>Detected</span>
                  : already
                    ? <span className='ext-agent-tag ext-agent-tag-done'>{ext.relay ? '✓ Connected' : '✓ Imported'}</span>
                    : <button className='small-btn' onClick={() => importExternal(ext)}>{ext.relay ? 'Connect' : 'Import'}</button>}
              </div>
            )
          })}
        </div>
      )}
      <div className='agent-grid'>
        {regularAgents.map(a => (
          <button key={a.id} className='agent-card' style={{ '--ah': a.hue ?? 'var(--accent-h)' }} onClick={() => openEditor(a)}>
            <span className='agent-avatar' style={{ color: `oklch(0.68 0.16 ${a.hue ?? 'var(--accent-h)'})` }}><AgentGlyph agent={a} size={20} /></span>
            <span className='agent-card-name'>{a.name}</span>
            <span className='agent-card-desc'>{(() => { const d = cleanDesc(a.persona); return d ? d.slice(0, 70) + (d.length > 70 ? '…' : '') : 'General assistant' })()}</span>
          </button>
        ))}
        <button className='agent-card agent-card-new' onClick={() => openEditor({ name: '', emoji: '🤖', hue: null, persona: '', model: null, provider: null, skills: [], useTools: true })}>
          <span className='agent-avatar'>+</span>
          <span className='agent-card-name'>New agent</span>
        </button>
        <button className='agent-card agent-card-new' onClick={() => setBrowsing(true)}>
          <span className='agent-avatar'>◎</span>
          <span className='agent-card-name'>Browse library</span>
          <span className='agent-card-desc'>{AGENT_TEMPLATES.length} ready-made agents</span>
        </button>
      </div>
      {importedAgents.length > 0 && (
        <>
          <div className='agent-divider'><span>Imported from other apps</span></div>
          <div className='agent-grid'>
            {importedAgents.map(a => (
              <button key={a.id} className='agent-card agent-card-imported' onClick={() => openEditor(a)}>
                {a.relay && <span className='agent-card-live' title='Live-connected agent'><span className='agent-card-live-dot' />live</span>}
                <span className='agent-avatar'><AgentGlyph agent={a} size={20} /></span>
                <span className='agent-card-name'>{a.name}</span>
                <span className='agent-card-desc'>{(() => { const d = cleanDesc(a.persona); return d ? d.slice(0, 70) + (d.length > 70 ? '…' : '') : 'General assistant' })()}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ---------- Skills ----------

// parse a dropped skill file: SKILL.md-style frontmatter (name/description) + body
function parseSkillFile (filename, text) {
  let name = filename.replace(/\.(md|markdown|txt|skill)$/i, '').replace(/[-_]/g, ' ')
  let description = ''
  let content = text
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (fm) {
    const meta = fm[1]
    const nm = meta.match(/^name:\s*(.+)$/mi)
    const desc = meta.match(/^description:\s*(.+)$/mi)
    if (nm) name = nm[1].trim().replace(/^["']|["']$/g, '')
    if (desc) description = desc[1].trim().replace(/^["']|["']$/g, '')
    content = fm[2].trim()
  }
  return { name: name.trim(), description, content: content.trim() }
}

function SkillsPane ({ config, onConfigChange }) {
  const skills = config.skills || []
  const suggestions = config.skillSuggestions || []
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [expanded, setExpanded] = useState(null)
  const fileRef = useRef(null)

  const acceptSuggestion = async id => onConfigChange(await api.acceptSkillSuggestion(id))
  const rejectSuggestion = async id => onConfigChange(await api.rejectSkillSuggestion(id))
  const toggle = async (id, enabled) => onConfigChange(await api.updateSkill(id, { enabled }))
  const remove = async id => { if (window.confirm('Delete this skill?')) onConfigChange(await api.deleteSkill(id)) }
  const add = async () => {
    if (!name.trim() || !content.trim()) return
    const cfg = await api.addSkill({ name: name.trim(), content: content.trim() })
    setName(''); setContent(''); setAdding(false)
    onConfigChange(cfg)
  }

  const importFiles = async fileList => {
    let cfg = null
    for (const file of Array.from(fileList).slice(0, 10)) {
      try {
        const text = await file.text()
        const sk = parseSkillFile(file.name, text)
        if (sk.content) cfg = await api.addSkill({ ...sk, enabled: true })
      } catch {}
    }
    if (cfg) onConfigChange(cfg)
  }

  return (
    <div className='set-section'>
      <h3>Skills</h3>
      <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 0 }}>
        Skills are reusable instructions an agent follows — coding conventions, a house style, a workflow.
        Checking a skill here turns it on for <strong>every</strong> agent and session. To use one with a
        single agent only, leave it off here and enable it in that agent's settings instead.
      </p>

      {suggestions.length > 0 && (
        <div className='skill-suggestions'>
          <div className='skill-suggestions-head'><Icon.sparkle size={14} /> Suggested for you <span className='skill-suggest-count'>{suggestions.length}</span></div>
          <div className='skill-suggestions-sub'>The agent noticed these while you worked. Nothing is added until you approve it.</div>
          {suggestions.map(s => (
            <div key={s.id} className='sug-card'>
              <div className='sug-top'>
                <div className='sug-main'>
                  <div className='sug-name'>{s.name}</div>
                  <div className='sug-desc'>{s.description}</div>
                  {s.rationale && <div className='sug-why'>Why: {s.rationale}</div>}
                </div>
                <div className='sug-actions'>
                  <button className='small-btn primary' onClick={() => acceptSuggestion(s.id)}>Add skill</button>
                  <button className='small-btn' onClick={() => rejectSuggestion(s.id)}>Reject</button>
                </div>
              </div>
              <button className='sug-preview-toggle' onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                {expanded === s.id ? '▾ Hide' : '▸ Preview'} what it does
              </button>
              {expanded === s.id && <pre className='sug-preview'>{s.content}</pre>}
            </div>
          ))}
        </div>
      )}

      <div
        className={'skill-drop' + (dragOver ? ' over' : '')}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files) }}
        onClick={() => fileRef.current?.click()}
      >
        <input ref={fileRef} type='file' accept='.md,.markdown,.txt,.skill' multiple hidden onChange={e => { if (e.target.files.length) importFiles(e.target.files); e.target.value = '' }} />
        <Icon.download size={20} />
        <div>Drop a skill file here <span style={{ color: 'var(--text-faint)' }}>— or click to browse</span></div>
        <div className='skill-drop-hint'>Markdown (.md) files with optional <span className='mono'>name:</span> / <span className='mono'>description:</span> frontmatter</div>
      </div>

      {skills.length > 0 && <div className='skill-list-head'>On for all agents</div>}
      {skills.map(sk => (
        <div key={sk.id} className='skill-row'>
          <label className='skill-toggle' title='On for every agent and session'>
            <input type='checkbox' checked={Boolean(sk.enabled)} onChange={e => toggle(sk.id, e.target.checked)} />
          </label>
          <div className='skill-main'>
            <div className='skill-name'>{sk.name}</div>
            <div className='skill-body'>{sk.description || sk.content}</div>
          </div>
          <button className='small-btn danger' onClick={() => remove(sk.id)} title='Delete skill'>✕</button>
        </div>
      ))}
      {!skills.length && <div className='activity-empty' style={{ marginTop: 8 }}>No skills yet.</div>}

      {adding
        ? <div className='skill-add'>
            <input className='text-input' style={{ fontFamily: 'inherit', marginBottom: 8 }} placeholder='Skill name (e.g. House style)' value={name} onChange={e => setName(e.target.value)} />
            <textarea className='text-input' style={{ fontFamily: 'inherit', minHeight: 90, resize: 'vertical' }} placeholder='Instructions the agent should follow…' value={content} onChange={e => setContent(e.target.value)} />
            <div className='row' style={{ marginTop: 8 }}>
              <button className='small-btn primary' onClick={add} disabled={!name.trim() || !content.trim()}>Add skill</button>
              <button className='small-btn' onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        : <button className='small-btn' style={{ marginTop: 12 }} onClick={() => setAdding(true)}>+ New skill</button>}
    </div>
  )
}

// ---------- Appearance ----------

function AppearancePane ({ config, onSettings }) {
  const s = config.settings
  const isCustom = !THEMES.find(t => t.id === s.themeId)
  const preview = patch => {
    applyTheme({ ...s, ...patch })
    onSettings(patch)
  }
  const pickColor = hex => {
    const { C, H } = hexToOklch(hex)
    // clamp chroma into the range the palette expects
    preview({ themeId: 'custom', customHue: Math.round(H), customChroma: Math.min(0.25, Math.max(0.02, +C.toFixed(3))) })
  }
  const currentAccentHex = accentHex(
    isCustom ? (s.customHue ?? 258) : THEMES.find(t => t.id === s.themeId).hue,
    isCustom ? (s.customChroma ?? 0.11) : THEMES.find(t => t.id === s.themeId).chroma
  )

  return (
    <div className='set-section'>
      <h3>Appearance</h3>

      <div className='sub-label'>Mode</div>
      <div className='mode-row'>
        {MODES.map(m => (
          <button key={m.id} className={'mode-btn' + (s.mode === m.id ? ' selected' : '')} onClick={() => preview({ mode: m.id })}>
            <span className='mode-swatch' data-mode={m.id} />
            <span>{m.icon} {m.name}</span>
          </button>
        ))}
      </div>

      <div className='sub-label'>Theme</div>
      <div className='theme-grid'>
        {THEMES.map(t => (
          <button
            key={t.id}
            className={'theme-swatch' + (s.themeId === t.id ? ' selected' : '')}
            onClick={() => preview({ themeId: t.id, bgTint: t.tint })}
          >
            <span className='dot' style={{ background: accentHex(t.hue, t.chroma) }} />
            {t.name}
          </button>
        ))}
      </div>

      <div className='sub-label'>Accent color</div>
      <div className='accent-picker'>
        <label className='color-well' style={{ background: currentAccentHex }}>
          <input type='color' value={currentAccentHex} onChange={e => pickColor(e.target.value)} />
        </label>
        <div className='accent-picker-text'>
          <div className='mono' style={{ fontSize: 12 }}>{currentAccentHex}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Click the swatch to open the full palette{isCustom ? ' · custom' : ''}</div>
        </div>
        {isCustom && (
          <input
            type='range' min='0' max='0.25' step='0.005' className='chroma-slider' style={{ flex: 1 }}
            value={s.customChroma ?? 0.11}
            onChange={e => preview({ customChroma: Number(e.target.value) })}
            title='Accent vividness'
          />
        )}
      </div>

      <div className='sub-label'>Background tint</div>
      <div className='hue-row'>
        <label htmlFor='bgtint'>Amount</label>
        <input
          id='bgtint' type='range' min='0' max='5' step='0.1' className='tint-slider'
          value={s.bgTint != null ? s.bgTint : (THEMES.find(t => t.id === s.themeId)?.tint ?? 1)}
          onChange={e => preview({ bgTint: Number(e.target.value) })}
        />
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)', width: 88 }}>
          {(s.bgTint != null ? s.bgTint : (THEMES.find(t => t.id === s.themeId)?.tint ?? 1)) < 0.4 ? 'neutral' : 'how much the accent colors the background'}
        </span>
      </div>

      <div className='sub-label'>Animated background</div>
      <div className='accent-picker' style={{ gap: 10 }}>
        <select className='text-input' style={{ fontFamily: 'inherit', maxWidth: 240 }}
          value={s.motionBg || 'off'} onChange={e => preview({ motionBg: e.target.value })}>
          {MOTIONS.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Moving backdrop behind the app (respects reduced-motion)</span>
      </div>

      <div className='sub-label'>Font</div>
      <div className='theme-grid'>
        {FONTS.map(f => (
          <button
            key={f.id}
            className={'theme-swatch' + ((s.fontFamily || 'inter') === f.id ? ' selected' : '')}
            style={{ fontFamily: f.stack }}
            onClick={() => preview({ fontFamily: f.id })}
          >
            {f.name}
          </button>
        ))}
      </div>

      <div className='sub-label'>Text size</div>
      <div className='theme-grid'>
        {UI_SCALES.map(u => (
          <button
            key={u.id}
            className={'theme-swatch' + ((s.uiScale || 1) === u.id ? ' selected' : '')}
            onClick={() => preview({ uiScale: u.id })}
          >
            {u.name}
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------- Agent ----------

function AgentPane ({ config, onSettings }) {
  const s = config.settings
  const [cwdDraft, setCwdDraft] = useState(s.defaultCwd || '')
  const [comp, setComp] = useState(null)
  useEffect(() => { api.computerStatus().then(setComp).catch(() => {}) }, [])
  return (
    <div className='set-section'>
      <h3>Agent</h3>
      <div style={{ marginBottom: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>Shell command approval</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 8px' }}>File edits always run automatically. This is about <em>shell commands</em>.</div>
        <div className='seg-control'>
          {[['ask', 'Ask every time'], ['auto', 'Auto (risky only)'], ['off', 'Never ask']].map(([id, label]) => {
            const cur = s.approvalMode || (s.approveCommands === false ? 'off' : 'ask')
            return <button key={id} className={'seg-btn' + (cur === id ? ' on' : '')} onClick={() => onSettings({ approvalMode: id, approveCommands: id !== 'off' })}>{label}</button>
          })}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 6 }}>
          <strong>Auto</strong> runs safe commands (ls, grep, tests, git status…) silently and only asks before risky ones — deletes, sudo, network fetches, pushes, chmod.
        </div>
      </div>
      <label className='check-row'>
        <input
          type='checkbox'
          checked={s.autoCompact !== false}
          onChange={e => onSettings({ autoCompact: e.target.checked })}
        />
        <span>Auto-compact long conversations <span className='desc'>— when a chat fills the model's context, summarize older messages so it can keep going</span></span>
      </label>
      <label className='check-row'>
        <input
          type='checkbox'
          checked={s.suggestSkills !== false}
          onChange={e => onSettings({ suggestSkills: e.target.checked })}
        />
        <span>Suggest skills from your activity <span className='desc'>— when the agent notices a repeatable, multi-step process or a workflow you set, it drafts a skill and asks you to approve it in Settings → Skills (cloud models only)</span></span>
      </label>
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Default workspace folder for new sessions</div>
        <input
          className='text-input'
          value={cwdDraft}
          onChange={e => setCwdDraft(e.target.value)}
          onBlur={() => cwdDraft && onSettings({ defaultCwd: cwdDraft })}
        />
      </div>

      {/* ⚠️ THIS SCREEN SAID TWO CONTRADICTORY THINGS AT ONCE. The status rows
          carried fixed descriptions, so Desktop control showed a green tick and
          "needs macOS permissions granted to Radiant" side by side. And the one
          control was a checkbox labelled "Full automation" with a line beneath
          it describing the UNCHECKED state, so the label and the explanation
          were about different things. Tony: "this screen is also cluttered and
          confusing. poor layout and even poorer descriptions."

          Now: what it is, what works on this Mac, then the single decision —
          each stated once, and the status text follows the actual state. */}
      <h3 style={{ marginTop: 22 }}>Computer control</h3>
      <p className='hint' style={{ marginTop: 2 }}>
        The agent can drive a browser and your desktop — clicking, typing and opening apps.
        Switch it on for a chat with the <strong>computer</strong> button in the composer, and use a
        model that can see: Claude, GPT-4o, or a local vision model.
      </p>

      <div className='set-block' style={{ marginTop: 14 }}>
        <div className='set-block-title'>What works on this Mac</div>
        <div className='comp-stat' style={{ marginTop: 8 }}>
          <span className={comp?.browser ? 'key-ok' : 'fit-badge fit-no'}>{comp?.browser ? '✓' : '—'} Browser control</span>
          <span className='desc'>drives your system Chrome. Nothing to set up.</span>
        </div>
        <div className='comp-stat' style={{ marginTop: 4 }}>
          <span className={comp?.desktop ? 'key-ok' : 'fit-badge fit-no'}>{comp?.desktop ? '✓' : '—'} Desktop control</span>
          <span className='desc'>
            {comp?.desktop
              ? 'Screen Recording and Accessibility are granted — ready to use.'
              : 'not available yet — macOS has not granted Radiant permission.'}
          </span>
        </div>
        {!comp?.desktop && (
          <div className='spec-note' style={{ marginTop: 10 }}>
            Grant Radiant <strong>Screen Recording</strong> to see the screen and <strong>Accessibility</strong> to
            click and type, in System Settings → Privacy &amp; Security. macOS asks the first time the agent
            tries. Browser control needs neither.
          </div>
        )}
      </div>

      <div className='set-block' style={{ marginTop: 14 }}>
        <div className='set-block-title'>How much it may do without asking</div>
        <label className={'auto-choice' + (!s.fullAutomation ? ' is-on' : '')}>
          <input type='radio' name='automation' checked={!s.fullAutomation} onChange={() => onSettings({ fullAutomation: false })} />
          <span>
            <strong>Ask me first</strong> <span className='desc'>— recommended</span>
            <span className='auto-choice-sub'>Every computer action pauses and waits for you before it runs.</span>
          </span>
        </label>
        <label className={'auto-choice' + (s.fullAutomation ? ' is-on is-warn' : '')}>
          <input type='radio' name='automation' checked={Boolean(s.fullAutomation)} onChange={() => onSettings({ fullAutomation: true })} />
          <span>
            <strong>Full automation</strong>
            <span className='auto-choice-sub'>
              Clicks, types and opens apps without asking. The agent can do anything on this Mac that you
              could, including things that cannot be undone. Use it only with models and tasks you trust.
            </span>
          </span>
        </label>
      </div>
    </div>
  )
}

// ---------- About & updates ----------

function AboutPane ({ config, onSettings }) {
  const s = config.settings
  const [version, setVersion] = useState(null)
  const [status, setStatus] = useState(null) // { hasUpdate, latest, current } | { error }
  const [checking, setChecking] = useState(false)
  const [phase, setPhase] = useState('idle') // idle | downloading | ready
  const [progress, setProgress] = useState(0)
  const native = typeof window !== 'undefined' && window.radiantUpdater
  const remote = getServer()
  const remoteLabel = remote.base ? (() => { try { return new URL(remote.base).host } catch { return remote.base } })() : ''

  // ⚠️ ONE SOURCE, NOT TWO. This pane used to show the version from the server
  // and the version from Electron side by side and reconcile them in the UI.
  // They come from the same package.json in the same bundle, so any difference
  // is a bug somewhere else — and rendering it here produced a screen telling
  // Tony to restart, which never helped: "i hit resstart now and get same
  // prompt to update. you fucking failed again."
  //
  // In the installed app, Electron's own version is the answer to "what is
  // installed" and cannot go stale. The server is only asked in a browser tab,
  // where there is no Electron to ask. A genuinely damaged bundle is still
  // caught at startup in updater.cjs, which repairs it instead of reporting it.
  useEffect(() => {
    if (native) { native.check().then(r => r.current && setVersion(r.current)).catch(() => {}) }
    else api.getVersion().then(v => setVersion(v.version)).catch(() => {})
  }, [native])

  // listen to auto-updater events in the packaged app
  useEffect(() => {
    if (!native) return
    return native.onEvent(ev => {
      if (ev.type === 'progress') { setPhase('downloading'); setProgress(ev.data.percent || 0) }
      else if (ev.type === 'downloaded') setPhase('ready')
      else if (ev.type === 'error') { setStatus({ error: ev.data.message }); setPhase('idle') }
    })
  }, [native])

  const check = async () => {
    setChecking(true); setStatus(null)
    try {
      if (native) {
        const r = await native.check()
        if (r.error) setStatus({ error: r.error })
        else setStatus({ hasUpdate: r.hasUpdate, latest: r.version, current: r.current })
      } else {
        const r = await api.updateCheck()
        setStatus({ hasUpdate: r.hasUpdate, latest: r.latest, current: r.current, dmgUrl: r.dmgUrl })
      }
    } catch (e) { setStatus({ error: e.message }) }
    setChecking(false)
  }

  const startDownload = () => { setPhase('downloading'); setProgress(0); native.download() }
  const restart = () => native.install()
  const relaunch = () => native.relaunch()
  const openReleasePage = () => window.open(status?.dmgUrl || 'https://github.com/templetongroup/radiant/releases/latest', '_blank', 'noopener')

  return (
    <div className='set-section'>
      <h3>About Radiant</h3>
      <div className='about-row'>
        <div className='logo-mark' style={{ width: 40, height: 40 }} aria-hidden />
        <div>
          <div className='wordmark' style={{ fontSize: 18 }}>Radiant</div>
          <div className='about-ver'>Version {version || '…'}</div>
        </div>
      </div>

      {/* If this window is pointed at another Mac, say so here too. The number
          above is this app; everything else in the window is that Mac. */}
      {remote.base && (
        <div className='update-avail' style={{ marginTop: 12 }}>
          This window is showing Radiant on <strong>{remoteLabel}</strong>, so the chats,
          projects and models you see are that Mac's, not this one's. The version above is
          this app. To use this Mac instead, go to <strong>Devices</strong> and press
          “Use this Mac's own server”.
        </div>
      )}
      <div style={{ marginTop: 14 }}>
        <button className='small-btn primary' onClick={check} disabled={checking || phase !== 'idle'}>
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
      </div>

      {status && !status.error && (
        status.hasUpdate
          ? <div className='update-avail'>
              <div><strong>Radiant {status.latest}</strong> is available (you have {status.current}).</div>
              {native
                ? (phase === 'ready'
                    ? <div className='row' style={{ marginTop: 8, alignItems: 'center', gap: 10 }}>
                        <button className='small-btn primary' onClick={restart}>Restart &amp; install</button>
                        <span className='oauth-note'>Downloaded — Radiant will relaunch on the new version.</span>
                      </div>
                    : phase === 'downloading'
                      ? <div style={{ marginTop: 10 }}>
                          <div className='pull-bar' style={{ width: '100%' }}><span style={{ width: progress + '%' }} /></div>
                          <div className='oauth-note' style={{ marginTop: 6 }}>Downloading… {progress}%</div>
                        </div>
                      : <div className='row' style={{ marginTop: 8 }}>
                          <button className='small-btn primary' onClick={startDownload}>Download &amp; install</button>
                        </div>)
                : <div className='row' style={{ marginTop: 8 }}>
                    <button className='small-btn primary' onClick={openReleasePage}>Download</button>
                    <span className='oauth-note' style={{ marginLeft: 8 }}>Opens the release page (auto-install works in the installed app).</span>
                  </div>}
            </div>
          : (
            // ⚠️ ONE NUMBER, OR SAY THERE ARE TWO. The heading reads the running
            // version from the server's own bundle; this line used to read a
            // DIFFERENT source (Electron's app version) and present it as the
            // same fact. Tony's About pane said "Version 0.6.123" and directly
            // under it "You're on the latest version (0.6.124)" — two sources
            // disagreeing, rendered as one confident claim. Prefer the heading's
            // number, and if the two ever diverge again, show both rather than
            // quietly picking a winner.
            <div className='update-none'>You're on the latest version ({version || status.current}).</div>
          )
      )}
      {status?.error && <div className='error-note'>⚠ Couldn't check: {status.error}</div>}

      <label className='check-row' style={{ marginTop: 14 }}>
        <input
          type='checkbox'
          checked={s.autoUpdateCheck !== false}
          onChange={e => onSettings({ autoUpdateCheck: e.target.checked })}
        />
        <span>Automatically check for updates on launch</span>
      </label>
      <div className='oauth-note'>
        The desktop app also has <span className='mono'>Radiant → Check for Updates…</span> in the menu bar.
        Updates download in the background and install when you restart.
      </div>

      <div className='about-footer' style={{ marginTop: 22 }}>
        <div className='about-footer-text'>A Templeton Technologies Product</div>
        {/* Electron denies in-window navigation, so a plain href does nothing —
            window.open goes through setWindowOpenHandler and out to the browser. */}
        <a
          className='about-footer-link'
          href='https://templetontech.com'
          title='templetontech.com'
          onClick={e => { e.preventDefault(); window.open('https://templetontech.com', '_blank', 'noopener,noreferrer') }}
        >
          <img
            className='about-footer-logo'
            src='/templeton-tech.png'
            alt='Templeton Technologies'
            onError={e => { e.currentTarget.style.display = 'none' }}
          />
        </a>
      </div>
    </div>
  )
}

// ---------- shell ----------


/**
 * Where Radiant keeps everything, and therefore how it follows you between
 * Macs — without an account, a login, or a copy of your work on our disk.
 *
 * ⚠️ THIS IS THE ANSWER TO "should we add SSO and sync?". Radiant's whole claim
 * is that your keys and your work stay on your machine; the App Store privacy
 * label for the iPhone app says Data Not Collected. Routing prefs through a
 * server of ours would make that false and would mean running auth, a database
 * and a breach surface forever, to move one folder. A folder your Macs already
 * share does the same job and keeps the claim true.
 */
function DataFolderBlock () {
  const [info, setInfo] = useState(null)
  const [targets, setTargets] = useState([])
  const [choice, setChoice] = useState('')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(null)   // { dest, destModified }

  const load = () => api.getDataDir().then(setInfo).catch(() => {})
  useEffect(() => {
    load()
    api.getSyncTargets().then(r => {
      setTargets(r.targets || [])
      setChoice((r.targets || [])[0]?.path || '')
    }).catch(e => {
      // ⚠️ A SWALLOWED ERROR HERE LOOKS LIKE A DEAD CHECKBOX. iCloud is always
      // offered, so an empty target list means this call failed — and the empty
      // list then sends the user down the "pick a folder" path instead. Say so.
      setMsg({ kind: 'err', text: `Could not work out where your cloud folders are: ${e.message}. Ticking the box will ask you to choose one instead.` })
    })
  }, [])

  const send = async (body, okText) => {
    setBusy(true); setMsg(null); setConflict(null)
    try {
      const r = await api.setDataDir(body)
      await load()
      setMsg({ kind: 'restart', text: okText(r) })
    } catch (e) {
      // The server refuses to guess when both sides already have a setup.
      const c = e?.body || e?.data || null
      if (c?.needsChoice) setConflict(c)
      else setMsg({ kind: 'err', text: e.message })
    }
    setBusy(false)
  }

  // ⚠️ NEVER DEAD-END ON DETECTION. This used to disable the checkbox when no
  // cloud folder was found, which makes the feature unusable the moment the
  // guess is wrong — and it was: Tony's work Mac has iCloud Drive on and was
  // still told there was no shared folder. Detection is a convenience for the
  // common case, not a gate. With nothing detected, ticking the box asks where
  // to put it, which works no matter what the Mac's setup looks like.
  const enable = async () => {
    if (!choice) {
      if (!window.radiantNative?.pickFolder) {
        setMsg({ kind: 'err', text: 'Choosing a folder needs the Radiant app — this is the browser view.' })
        return
      }
      // Never return in silence — a checkbox that springs back with no message
      // is indistinguishable from a broken app.
      const picked = await window.radiantNative.pickFolder(info?.active)
      if (!picked) {
        setMsg({ kind: 'err', text: 'No folder chosen, so nothing changed. Pick a folder your other Macs can see — iCloud Drive, Dropbox, or any synced folder.' })
        return
      }
      return send({ path: picked }, r => r.adopted
        ? 'That folder already had a Radiant setup and it was adopted as-is. Quit and reopen Radiant.'
        : 'Copied your setup across. Your originals were left where they were. Quit and reopen Radiant.')
    }
    send({ path: choice }, r => r.adopted
      ? 'That folder already had a Radiant setup and it was adopted as-is. Quit and reopen Radiant.'
      : 'Copied your setup across. Your originals were left where they were. Quit and reopen Radiant.')
  }
  // ⚠️ TURNING SYNC OFF MUST BRING THE WORK HOME. The local folder has been
  // sitting untouched since sync was turned on — pointing back at it would
  // silently roll the user back to whatever they had that day. mode:'replace'
  // copies the live data down and moves the stale copy aside instead.
  const disable = () => send({ path: 'reset', reset: true, mode: 'replace' },
    r => `Your setup was copied back to this Mac${r.backedUp ? ' and the old local copy was kept alongside it' : ''}. Quit and reopen Radiant.`)

  if (!info) return null
  // What the user CHOSE, not what is loaded — the pointer changes now, the
  // active folder only after a restart. Reading `active` here made the box
  // spring back to unticked the instant it was ticked.
  const syncing = info.syncing
  const current = targets.find(t => t.path === (info.configured || info.active))

  return (
    <div className='data-folder'>
      <label className='set-check'>
        <input
          type='checkbox'
          checked={syncing}
          disabled={busy}
          onChange={e => (e.target.checked ? enable() : disable())}
        />
        <span>Keep my setup in {current ? current.label : (targets.find(t => t.path === choice)?.label || 'a folder my other Macs can see…')}</span>
        {/* Nobody should have to know where iCloud Drive lives on disk. */}
      </label>
      <p className='set-hint'>
        No account, and nothing of yours stored anywhere but your own cloud drive.
        Turn this on once per Mac.
      </p>

      {!syncing && targets.length > 1 && (
        <select className='text-input data-folder-pick' value={choice} onChange={e => setChoice(e.target.value)} disabled={busy}>
          {targets.map(t => <option key={t.path} value={t.path}>{t.label}</option>)}
        </select>
      )}
      {/* iCloud is always offered on a Mac, so this only appears somewhere it
          genuinely cannot be. */}
      {!syncing && !targets.length && (
        <p className='set-hint'>
          Tick the box and choose any folder your other Macs can see.
        </p>
      )}


      {conflict && (
        <div className='sync-conflict'>
          <p>
            That folder already has a Radiant setup{conflict.destModified ? `, last changed ${new Date(conflict.destModified).toLocaleString()}` : ''}.
            One of the two has to win, and nothing has been changed yet.
          </p>
          <div className='data-folder-row'>
            <button className='btn-secondary' disabled={busy} onClick={() => send({ path: conflict.dest, mode: 'adopt' }, () => 'Using the setup that was already in that folder. Quit and reopen Radiant.')}>
              Use what is in the folder
            </button>
            <button className='btn-secondary' disabled={busy} onClick={() => send({ path: conflict.dest, mode: 'replace' }, r => `Replaced it with this Mac's setup${r.backedUp ? '; the previous one was kept alongside it' : ''}. Quit and reopen Radiant.`)}>
              Use this Mac&rsquo;s setup
            </button>
            <button className='btn-secondary' disabled={busy} onClick={() => setConflict(null)}>Cancel</button>
          </div>
        </div>
      )}

      <details className='data-folder-adv'>
        <summary>Where it is now</summary>
        <div className='data-folder-row'>
          <code className='mono data-folder-path' title={info.active}>{info.active.replace(/^\/Users\/[^/]+/, '~')}</code>
          <button className='btn-secondary' disabled={busy} onClick={async () => {
            if (!window.radiantNative?.pickFolder) { setMsg({ kind: 'err', text: 'Choosing a folder needs the Radiant app.' }); return }
            const next = await window.radiantNative.pickFolder(info.active)
            if (next) send({ path: next }, r => r.adopted ? 'Adopted the setup already in that folder. Quit and reopen Radiant.' : 'Copied your setup across. Quit and reopen Radiant.')
          }}>Choose another folder…</button>
        </div>
        <p className='set-hint'>
          One Mac at a time. Two copies of Radiant writing to the same folder at
          once will overwrite each other — to work from two Macs together, share
          this one below instead.
        </p>
      </details>

      {info.unreachable && (
        <p className='set-hint is-warn'>
          The shared folder could not be reached, so Radiant is running from this
          Mac and your work is intact. Reconnect it, or turn sync off.
        </p>
      )}
      {/* ⚠️ A TICKED BOX THAT IS NOT IN EFFECT YET MUST SAY SO LOUDLY. The folder
          is chosen when Radiant starts, so ticking this writes the choice but
          changes nothing until the app is quit and reopened. That was a grey
          line under a ticked checkbox, and "Where it is now" — still reading
          ~/.radiant — was collapsed out of sight. Tony had it on three Macs and
          saw his projects on one: "home dev and work are all on with sync but i
          only see project folder on home mbp." The setting was saved on all
          three and in effect on one. */}
      {/* ⚠️ THE LOUDEST THING ON THIS SCREEN, BECAUSE IT MEANS NOTHING IS
          SYNCING. A folder at the iCloud path is not necessarily in iCloud: with
          iCloud Drive off or on another Apple ID it is just a local directory,
          and Radiant will write into it forever, sharing with nobody, while the
          checkbox above claims otherwise. Tony's dev Mac did this — two other
          Macs worked, that one stayed empty through reboots and reinstalls. */}
      {info.cloud && info.cloud.exists && !info.cloud.ubiquitous && (
        <div className='sync-broken'>
          <strong>Nothing here is syncing.</strong> Radiant is writing to this folder, but macOS
          does not treat it as an iCloud item, so nothing reaches your other Macs and nothing
          from them arrives.
          {info.cloud.icloud === true && (
            <> <br /><br /><strong>iCloud itself is working on this Mac</strong>, so this is the
              folder rather than your settings — most likely it was created at that path before
              iCloud Drive finished setting up, and iCloud never adopted it. Press
              “Choose another folder…” and pick your iCloud Drive again: Radiant will make a
              fresh folder inside the live one and copy your setup into it.</>
          )}
          {info.cloud.icloud === false && (
            <> <br /><br /><strong>iCloud is not available to Radiant on this Mac.</strong> Check
              that you are signed in and that iCloud Drive is on in System Settings → your name
              → iCloud, then quit and reopen Radiant.</>
          )}
        </div>
      )}
      {info.cloud && info.cloud.ubiquitous && info.cloud.error && (
        <div className='sync-broken'>
          <strong>iCloud reported an error uploading this folder.</strong> Your setup is not
          reaching your other Macs until that clears. Check that this Mac is online and has
          iCloud storage available.
        </div>
      )}
      {info.pendingRestart && (
        <div className='sync-pending'>
          <strong>Not in effect yet on this Mac.</strong> Radiant is still using its own
          folder (<code className='mono'>{info.active.replace(/^\/Users\/[^/]+/, '~')}</code>).
          Quit Radiant completely and reopen it — closing the window is not enough.
        </div>
      )}
      {msg && <p className={'set-hint ' + (msg.kind === 'err' ? 'is-warn' : 'is-restart')}>{msg.text}</p>}
    </div>
  )
}

/**
 * Take your chats somewhere else, or bring them back.
 *
 * ⚠️ AN IMPORT CAN ONLY EVER ADD. Every imported chat gets a fresh id on the
 * server, so a file cannot overwrite a conversation you already have — there
 * would be no undo if it could. Re-importing the same file twice gives you two
 * copies, which is the safe way round.
 */
function ChatTransfer () {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const file = useRef(null)

  const exportAll = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await api.exportAllChats()
      if (!r.count) { setMsg({ kind: 'warn', text: 'There are no chats to export yet.' }); setBusy(false); return }
      const where = await saveToFile(r.filename, r.mime, r.content)
      // null means the Save dialog was cancelled — not an error, and not a
      // success either. Saying "Saved!" there would be a lie.
      setMsg(where === null
        ? { kind: 'warn', text: 'Export cancelled.' }
        : { kind: 'ok', text: `Saved ${r.count} chat${r.count === 1 ? '' : 's'}${where ? ` to ${where.replace(/^\/Users\/[^/]+/, '~')}` : ` as ${r.filename}`}.` })
    } catch (e) { setMsg({ kind: 'warn', text: e.message }) }
    setBusy(false)
  }

  const doImport = async (f) => {
    if (!f) return
    setBusy(true); setMsg(null)
    try {
      const text = await f.text()
      let payload
      try { payload = JSON.parse(text) } catch { throw new Error('That file is not valid JSON.') }
      const r = await api.importChats(payload)
      setMsg({
        kind: r.added ? 'ok' : 'warn',
        text: r.added
          ? `Added ${r.added} chat${r.added === 1 ? '' : 's'}${r.skipped ? `, skipped ${r.skipped} that did not look like chats` : ''}. Find them in the sidebar under “${r.project}”, keeping their original dates.`
          : 'Nothing in that file looked like a Radiant chat.'
      })
    } catch (e) { setMsg({ kind: 'warn', text: e.message }) }
    setBusy(false)
    if (file.current) file.current.value = ''
  }

  return (
    <>
      <h3 style={{ marginTop: 26 }}>Move your chats</h3>
      <p className='hint' style={{ marginTop: 0 }}>
        Export everything as one file to keep a copy, move to another Mac, or
        hand a conversation to someone. Importing only ever adds — it never
        replaces a chat you already have, so the same file imported twice gives
        you two copies.
      </p>
      <div className='row' style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12, alignItems: 'center' }}>
        <button className='small-btn' disabled={busy} onClick={exportAll}>Export all chats</button>
        <button className='small-btn' disabled={busy} onClick={() => file.current?.click()}>Import chats…</button>
        <input ref={file} type='file' accept='application/json,.json' style={{ display: 'none' }}
          onChange={e => doImport(e.target.files?.[0])} />
      </div>
      <p className='hint'>
        An export contains the full text of every chat, including anything you
        pasted in. Treat the file the way you would treat the conversations.
      </p>
      {msg && <p className={'hint ' + (msg.kind === 'warn' ? 'is-warn' : 'is-restart')}>{msg.text}</p>}
    </>
  )
}

// ⚠️ THIS SCREEN HAD THREE EQUAL BOXES AND NO MODEL. Two of them — "Let my
// other Macs use this one" and "Use another Mac from this one" — are the same
// arrangement seen from its two ends, presented as if they were separate
// features. Tony, who wrote the app: "let my other macs use this one and use
// another mac from this one sounds like the same exact thing... its my app, and
// im utterly confused."
//
// There are TWO arrangements, not three. The second one has two ends, and a Mac
// is at one end or the other. The pictures carry that distinction faster than
// any wording did.
function SyncDiagram () {
  return (
    <svg className='dev-dia' viewBox='0 0 120 74' aria-hidden focusable='false'>
      <rect x='42' y='4' width='36' height='18' rx='5' className='dia-cloud' />
      <text x='60' y='16' textAnchor='middle' className='dia-label'>folder</text>
      {[14, 50, 86].map((x, i) => (
        <g key={i}>
          <path d={`M${x + 10} 48 L${x + 10} 34 L60 34 L60 24`} className='dia-line' />
          <rect x={x} y='48' width='20' height='14' rx='2.5' className='dia-mac' />
          <rect x={x + 5} y='62' width='10' height='2' rx='1' className='dia-mac' />
        </g>
      ))}
    </svg>
  )
}

function HostDiagram () {
  return (
    <svg className='dev-dia' viewBox='0 0 120 74' aria-hidden focusable='false'>
      <rect x='8' y='26' width='34' height='24' rx='3' className='dia-mac dia-host' />
      <rect x='17' y='50' width='16' height='2.5' rx='1' className='dia-mac dia-host' />
      <text x='25' y='64' textAnchor='middle' className='dia-label'>does the work</text>
      {[10, 44].map((y, i) => (
        <g key={i}>
          <path d={`M78 ${y + 9} L52 ${y + 9} L52 38 L44 38`} className='dia-line' />
          <rect x='78' y={y} width='30' height='18' rx='2.5' className='dia-mac' />
        </g>
      ))}
      <text x='93' y='38' textAnchor='middle' className='dia-label'>windows</text>
    </svg>
  )
}

function DevicesPane () {
  const [share, setShare] = useState(null)
  // The token is a credential; it starts hidden. See the note beside it.
  const [showToken, setShowToken] = useState(false)
  const server = getServer()
  const [base, setBase] = useState(server.base || '')
  const [token, setToken] = useState(server.token || '')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.getShare().then(setShare).catch(() => {}) }, [])
  const copy = t => { try { navigator.clipboard?.writeText(t) } catch {} }

  const toggleShare = async () => {
    try { const r = await api.setShare(!(share?.desired)); setShare(s => ({ ...s, ...r })) } catch (e) { setMsg(e.message) }
  }
  const connect = async () => {
    setBusy(true); setMsg(null)
    try {
      let url = base.trim(); if (url && !/^https?:\/\//i.test(url)) url = 'http://' + url
      await testServer(url, token.trim())
      setServer({ base: url, token: token.trim() }); location.reload()
    } catch (e) { setMsg(e.message); setBusy(false) }
  }
  const useLocal = () => { setServer(null); location.reload() }

  const linked = Boolean(server.base)

  // ⚠️ THIS BANNER MUST DESCRIBE BOTH ARRANGEMENTS, NOT ONE. It only ever asked
  // whether this Mac was borrowing another one's Radiant, so with syncing on it
  // still announced "using its own setup, stored on this machine" — directly
  // above a ticked "Keep my setup in iCloud Drive". Tony: "says using its own
  // setup but keep my mac in step is checked on."
  const [folder, setFolder] = useState(null)
  useEffect(() => { api.getDataDir().then(setFolder).catch(() => {}) }, [])
  const syncing = Boolean(folder?.syncing && !folder?.pendingRestart)
  const folderLabel = folder?.active ? folder.active.replace(/^\/Users\/[^/]+/, '~') : ''

  return (
    <div className='set-section'>
      <h3>Using Radiant on more than one Mac</h3>

      {/* ⚠️ SAY WHAT THIS MAC IS DOING BEFORE OFFERING TO CHANGE IT. The pane
          used to open with three unlabelled mechanisms and no statement of the
          current state — so a Mac already borrowing another one's Radiant still
          showed a sync checkbox that does nothing, with nothing on screen
          explaining why. Tony hit exactly that: connected to dev-mbp, sync
          ticked, and no way to tell those two facts were in conflict. */}
      <div className={'devices-now' + (linked ? ' is-linked' : '')}>
        {linked
          ? <>This Mac is <strong>using the Radiant on another Mac</strong> — everything you see
              (models, agents, chats) comes from <code className='mono'>{server.base}</code>, not from here.</>
          : syncing
            ? (folder?.cloud && folder.cloud.exists && !folder.cloud.ubiquitous
                ? <>This Mac is <strong>writing to a folder that is not in iCloud</strong> —
                    it looks like the right place, but macOS is not syncing it, so nothing is
                    shared with your other Macs. See below.</>
                : <>This Mac is <strong>sharing one setup with your other Macs</strong>, kept
                    in <code className='mono'>{folderLabel}</code>.</>)
            : folder?.pendingRestart
              ? <>This Mac is <strong>still using its own setup</strong> — the shared folder you
                  picked takes effect after you quit Radiant completely and reopen it.</>
              : <>This Mac is <strong>using its own setup</strong>, stored on this machine.</>}
      </div>

      <p className='hint'>
        Radiant works across Macs in two ways. They solve different problems — pick the
        one that matches how you actually work.
      </p>

      <div className='dev-option'>
        <div className='dev-option-head'>
          <SyncDiagram />
          <div>
            <div className='dev-option-title'>1 · Share one setup across your Macs</div>
            <p className='dev-option-sub'>
              Every Mac runs its own Radiant, and they all keep their projects, chats,
              agents and settings in one cloud folder. Sit down at any Mac and it has the
              same things. <b>Use one Mac at a time</b> — two of them writing at once will
              overwrite each other.
            </p>
          </div>
        </div>
        {linked
          ? <p className='hint' style={{ marginTop: 2 }}>
              Not used while this Mac is borrowing another one's Radiant — your setup is
              already coming from that Mac. Switch to this Mac's own server below if you
              want to sync instead.
            </p>
          : <DataFolderBlock />}
      </div>


      {/*
        ⚠️ THIS PANEL IS ABOUT MACS NOW. The iPhone app never implemented
        connecting to a Mac — the screen stored an address and nothing in the
        phone UI ever read it — so that feature was removed. This panel still
        said "Use this Mac from your phone" and walked the user through opening
        Radiant on their iPhone and tapping Connect to a Mac, a screen that no
        longer exists. Tony found it after the removal, which is the same
        half-a-fix pattern that has cost him all day: the feature went and its
        advertising stayed.

        Sharing itself is real and verified — another Mac connects to this one
        and uses its models, agents and sessions.
      */}
      <div className='dev-option' style={{ marginTop: 18 }}>
        <div className='dev-option-head'>
          <HostDiagram />
          <div>
            <div className='dev-option-title'>2 · Run everything on one Mac, use it from the others</div>
            <p className='dev-option-sub'>
              One Mac does the work — it runs the models and stores the chats. The others
              open a window onto it and see exactly the same screen. Good when one Mac
              stays awake, or another is too slow for local models.
              <br /><b>This is one arrangement with two ends.</b> Set the Mac that does the
              work first, then tell each other Mac to point at it.
            </p>
          </div>
        </div>

        <div className='dev-role'>
          <div className='dev-role-title'>This Mac does the work</div>
          <p className='hint' style={{ marginTop: 2 }}>
            Turn this on for the Mac that stays awake. You will get an address and a token
            to type into your other Macs.
          </p>
        <label className='agent-skill-chk'>
          <input type='checkbox' checked={Boolean(share?.desired)} onChange={toggleShare} /> Share with my other Macs
        </label>
        {share && share.desired !== share.enabled && (
          <div className='error-note' style={{ marginTop: 6 }}>
            Quit and reopen Radiant to {share.desired ? 'start' : 'stop'} sharing.
          </div>
        )}

        {share?.desired && share?.enabled && share?.token && (() => {
          const wifi = (share.addresses || []).find(a => a.wifi)
          const anywhere = share.phone?.ready ? share.phone.url : null
          // Same network is the common case and needs nothing installed; the
          // Tailscale address is what a Mac somewhere else needs.
          const best = anywhere
            ? { url: anywhere, where: 'Works from anywhere, over Tailscale.' }
            : wifi
              ? { url: `${wifi.address}:${share.port}`, where: 'Works when both Macs are on this network.' }
              : null
          if (!best) {
            return (
              <div className='hint' style={{ marginTop: 12 }}>
                No network address yet — is this Mac connected to a network?
              </div>
            )
          }
          return (
            <div style={{ marginTop: 14 }}>
              <p className='hint' style={{ marginTop: 0 }}>
                On the other Mac, open Radiant &rarr; Settings &rarr; Devices and
                enter these under <b>Connect this app to another Radiant</b>.
              </p>
              <div className='connect-field' style={{ marginTop: 10 }}>Address
                <div className='row'>
                  <code className='mono'>{best.url}</code>
                  <button className='small-btn' onClick={() => copy(best.url)}>Copy</button>
                </div>
              </div>
              <div className='connect-field' style={{ marginTop: 8 }}>Access token
                <div className='row'>
                  {/* ⚠️ A SECRET. It grants access to every model, agent and
                      session here, and it used to sit in plain text on a
                      settings screen anyone walking past could read. */}
                  <code className='mono share-token'>{showToken ? share.token : '•'.repeat(24)}</code>
                  <button className='small-btn' onClick={() => setShowToken(v => !v)}>{showToken ? 'Hide' : 'Show'}</button>
                  <button className='small-btn' onClick={() => copy(share.token)}>Copy</button>
                </div>
              </div>
              <div className='hint' style={{ marginTop: 8 }}>{best.where}</div>

              {!anywhere && (
                <div className='hint' style={{ marginTop: 10, lineHeight: 1.5 }}>
                  <b>To reach this Mac from somewhere else, both Macs need Tailscale</b>
                  {' '}— a free private network between your own machines, so this Mac is
                  reachable without being exposed to the internet. Install it on both,
                  sign in with the same account, and Radiant sets up the rest.{' '}
                  <a href='https://tailscale.com/download' target='_blank' rel='noreferrer'>tailscale.com/download</a>
                </div>
              )}
            </div>
          )
        })()}
      </div>

        <div className='dev-role'>
          <div className='dev-role-title'>This Mac is a window onto another</div>
          <p className='hint' style={{ marginTop: 2 }}>
            The other end. Paste the address and token from the Mac above, and this app
            shows that Mac's models, agents and chats instead of its own. Nothing here is
            deleted — switch back any time.
          </p>
        <label className='connect-field'>Server address
          <input className='text-input' placeholder='100.x.y.z:5834 (Tailscale) or host.local:5834' value={base} onChange={e => setBase(e.target.value)} />
        </label>
        <label className='connect-field' style={{ marginTop: 8 }}>Access token
          <input className='text-input' type='password' placeholder='Token from the host Mac' value={token} onChange={e => setToken(e.target.value)} />
        </label>
        {msg && <div className='error-note' style={{ marginTop: 6 }}>⚠ {msg}</div>}
        <div className='row' style={{ marginTop: 10 }}>
          <button className='small-btn primary' onClick={connect} disabled={busy || !base.trim()}>{busy ? 'Connecting…' : 'Connect & reload'}</button>
          {server.base && <button className='small-btn' onClick={useLocal}>Use this Mac's own server</button>}
        </div>
        {server.base
          ? <div className='v-meta' style={{ marginTop: 6 }}>Using <code className='mono'>{server.base}</code>. Press “Use this Mac's own server” to go back.</div>
          : <div className='v-meta' style={{ marginTop: 6 }}>Not connected — this Mac is using its own server.</div>}
        </div>
      </div>
    </div>
  )
}

const GUIDE = [
  {
    title: 'Chat & agents',
    items: [
      ['Shared Macs keep up on their own', 'When you point one Mac at another Radiant (Settings → Devices), the second Mac now keeps its chat list current by itself: it checks every few seconds while you are looking at it, and catches up immediately when you click back into the window. A window in the background does nothing at all, so it costs no battery. Before this it only ever updated after you did something on that Mac, so a chat started on the host could sit unseen indefinitely.'],
      ['The version is in the window', 'The build you are running now shows at the bottom of the sidebar, to the right of the light/dark button. The first question about any odd behaviour is whether you are on the current version, and answering it no longer means opening Settings.'],
      ['The agent can read the web', 'Two tools were missing and are now there: web_search finds pages, fetch_url reads one. Ask about a library version, an error message, or a changelog and the agent looks it up instead of guessing from memory. Anything it fetches is handed to the model clearly marked as untrusted content — a web page can try to give the agent instructions, and it is told to report those rather than follow them.'],
      ['Diagrams and pages render in the chat', 'A mermaid, html or svg code block gets a Preview button. Mermaid draws as a diagram in the app\u2019s own theme; html and svg open in a sandboxed frame that cannot reach your data. Bigger expands it, Save\u2026 writes it out as SVG or HTML. The bundled "Architecture map" skill pairs with this.'],
      ['Branch a chat instead of losing it', 'Every message you sent has a branch button next to rewind. Rewind removes what came after; branch copies the chat up to that point into a new one and leaves the original alone, carrying the same agent, model and folder so the two run under the same conditions.'],
      ['Bring your ChatGPT history in', 'Settings \u2192 Memory \u2192 Move your chats now accepts a ChatGPT export (conversations.json) as well as Radiant\u2019s own. It follows the thread you actually saw \u2014 ChatGPT stores every edit and regeneration as a branch \u2014 and keeps the original dates.'],
      ['See how full the context is', 'The composer shows what share of the model\u2019s context window your last turn used, from the real token count rather than an estimate. It turns amber, then red, as you approach the limit \u2014 the point where the oldest messages quietly stop being sent. Models we have no window size for show the token count and no bar rather than a percentage of a guess.'],
      ['Take your chats with you', 'Hover any chat in the sidebar and the ⤓ button saves it as Markdown — readable, and the right thing to paste into a ticket or send to someone. For everything at once, Settings → Memory → Move your chats exports every conversation as a single file you can keep as a backup or carry to another Mac, and imports one back. Imported chats arrive in their own project named for the day they came in, so you can find them as a group, and they keep their original dates instead of pretending to be today. Importing only ever adds: it can never overwrite a chat you already have, so the same file imported twice gives you two copies rather than silently replacing anything. An export holds the full text of every chat, so treat the file the way you would treat the conversations.'],
      ['Some settings stay on the Mac they belong to', 'Your theme, fonts and preferences follow you between Macs. Three things do not, because they describe the machine rather than you: the default model, the provider serving it, and the folder work starts in. A model downloaded on one Mac is not on another, so each Mac keeps its own choice \u2014 point one at a model running on a different Mac, and let another use the models it downloaded itself, without the two fighting.'],
      ['Sync across your Macs', 'Settings → Devices has one checkbox: keep my setup in iCloud Drive. Tick it and your projects, chats, agents and preferences follow you to your other Macs — no account to create, no password, and nothing of yours stored anywhere but your own cloud drive. Dropbox, Google Drive, OneDrive and Box are offered as well if you use them, and you can point it at any other folder from “Where it is now”. Radiant copies your setup across and leaves the originals alone; turning it off copies everything back. If the shared folder is ever unreachable it runs from this Mac and says so, rather than opening empty. Point a second Mac at a folder that already has a setup and Radiant asks which one wins instead of guessing. Ticking the box saves the choice but does not move you into the folder until you quit Radiant completely and open it again — closing the window is not enough, and until you do, that Mac is still on its own setup. Radiant says so plainly while it is waiting. Do this on each Mac. Use one Mac at a time — to work from two at once, share this Mac instead.'],
      ['Projects', 'Group your chats into projects in the Chats sidebar. Give a project a folder and every new chat started inside it opens in that folder, so you stop re-pointing each session at the same place. Use the + on a project to start a chat in it, the pencil to rename, and the small menu on any chat row to move it between projects. Deleting a project never deletes its chats — they move to “No project”.'],
      ['Agents', 'Named personas with their own model, personality, and skills. Pick one from the welcome screen; the Agents sidebar view groups your sessions by agent. Edit them in Settings → Agents.'],
      ['Agent library', 'Over 140 ready-made expert agents across two dozen categories — browse, filter, and add one in a click, then tweak its model, name, and skills before saving.'],
      ['Duplicate, export & import', 'Clone any agent into an editable copy, export your custom agents as a shareable file, and import a pack — so a curated set can be handed to a whole team.'],
      ['Connected agents', 'Radiant detects other agent apps installed on your Mac (Settings → Agents). Connect a Hermes agent and you chat with the real thing — its own model, skills, and memory — right inside a Radiant session. For OpenClaw, Radiant asks the gateway for the agents it hosts, so a fleet running on another Mac shows up here too; if this machine’s OpenClaw credentials are out of date it says so rather than showing an empty list.'],
      ['Imported agents stay recognizable', 'Agents brought in from another app sit below an “Imported from other apps” divider — in the sidebar, the agent picker, and Settings → Agents — and keep their own icon and color instead of taking a Radiant hue, so it is always clear which are yours and which are borrowed.'],
      ['Group chat', 'Put several agents in one conversation and let them build on each other, with a roster showing who is in the room.'],
      ['Agents consult each other', 'Any agent can call the ask_agent tool to get a second opinion from another agent (e.g. Reviewer asks Architect) and fold the answer in.'],
      ['Queue while it works', 'Type a follow-up mid-turn and it queues — the agent picks it up as soon as the current turn finishes instead of making you wait.'],
      ['The composer grows', 'Paste or type a large block and the message box expands to fit it (up to a comfortable height, then scrolls) — no more hunting for text in a two-line box.'],
      ['Generative UI', 'Agents can render results inline as widgets — stat tiles, tables, diffs, and clickable choices — not just text.'],
      ['Plan mode (📋)', 'Toggle it in the composer. The agent researches and proposes a step-by-step plan for your approval before changing anything — then builds once you approve.'],
      ['The agent can ask you', 'When a decision is genuinely yours, the agent pauses and asks a multiple-choice question (you can also type your own answer) instead of guessing.'],
      ['Task checklists', 'On multi-step work the agent keeps a live to-do list above the composer (done / in-progress / pending).'],
      ['Files changed', 'After a turn, the files the agent created or edited appear as clickable chips — click to open them.'],
      ['Auto titles', 'New chats name themselves from your first message. Rename to pin your own title.']
    ]
  },
  {
    title: 'Models & providers',
    items: [
      ['Subscriptions', 'Sign in with a subscription instead of an API key (Settings → Providers): Claude, ChatGPT, Nous Portal, xAI (Grok), Qwen, and GitHub Copilot — Copilot unlocks GPT, Claude, and Gemini models through your plan.'],
      ['Ready-to-add providers', 'One-tap presets for DeepSeek, Kimi, GLM, Mistral, Groq, Together, Fireworks, Cerebras, Perplexity, Gemini, Ollama Cloud, and Vercel AI Gateway — just paste a key.'],
      ['Multiple accounts', 'Keep more than one account or key per provider and switch the active one; the sidebar meters follow whichever is active.'],
      ['Any OpenAI-compatible provider', 'Add anything else with a name + base URL.'],
      ['Local models', 'Run models from Ollama or LM Studio with no key. Search Hugging Face and download GGUFs straight from Settings → Models, with a disk-space check before you pull. The first reply after switching to a local model shows a "loading into memory" note while its weights load; it stays warm after that.'],
      ['Compare', 'Run one prompt against two models side by side (command palette → Compare).'],
      ['Errors you can act on', 'When a provider turns a request down, Radiant explains it in plain language instead of passing along raw API text. If OpenRouter refuses a model because every provider serving it wants to log your prompts, it says so and points you at the privacy setting to change — free and experimental models are usually the ones affected. A model id OpenRouter no longer serves says that instead of a bare 404, and a restricted key, a signed-out account, or an empty balance each name themselves.']
    ]
  },
  {
    title: 'Tools the agent can use',
    items: [
      ['Files & commands', 'Read, write, and edit files and run shell commands in the workspace folder. Toggle with the “tools” pill; command runs ask for approval.'],
      ['Set the workspace folder', 'Click the folder chip at the top of a chat to choose which folder the agent works in — it opens a native folder picker.'],
      ['Permissions', 'The composer’s permissions pill sets how much the agent can do without asking — Ask each (confirm every command), Auto approve (low-risk runs silently, risky ones still ask), or Allow all (never ask). Flip it to Allow all for an unattended long build.'],
      ['Background jobs', 'Long builds, test watchers, and dev servers run in the background so the agent keeps working and checks on them.'],
      ['Terminal', 'A real terminal in the activity panel (top-right icon).'],
      ['Computer control (🖥)', 'Let a vision model drive the browser and desktop. Basic automation is on by default; full automation is an opt-in checkbox in Settings → Automation.'],
      ['Design Mode (◎)', 'Point at any element in the agent’s browser and capture its HTML, CSS, and a screenshot straight into the chat, so the agent can match or rework a design.'],
      ['Website → API', 'The agent can watch a site’s network calls and turn its hidden API into a reusable HTTP client (a built-in skill).'],
      ['MCP', 'Connect Model Context Protocol servers in Settings → MCP to give agents extra tools.'],
      ['Skills', 'Drop a skill file into Settings → Skills (or type one) to inject house rules the agent follows — globally or per agent.'],
      ['Skills that build themselves', 'When an agent notices a repeatable workflow it suggests a reusable skill; review the full description and Add or Reject it in Settings → Skills.']
    ]
  },
  {
    title: 'Your devices',
    items: [
      ['One server, all your Macs', 'Run Radiant’s server on an always-on Mac (Settings → Devices → Share with my other Macs) and connect your other Macs to it — they share the same agents, models, and sessions. It gives you an address and a token; enter them on the other Mac under “Connect this app to another Radiant”.'],
      ['Behind a proxy, the token still applies', 'Radiant skips the access token for the app talking to its own server on this Mac. If you put a reverse proxy in front — Tailscale Serve, nginx — those requests come from the proxy, so they must present the token like any other device. Nothing reaches your files or shell without it.'],
      ['Signed in for good', 'Once a device is signed in it stays signed in — the token is held in a secure cookie rather than page storage, which iOS can clear out from under a Home Screen app. If you do land on the connect screen, it only asks for the token: the address is wherever you opened it from.']
    ]
  },
  {
    title: 'Look & feel',
    items: [
      ['Themes', 'A dozen palettes plus a custom accent, in light / medium / dark (bottom-left toggle). Agents can follow the accent or carry their own color.'],
      ['Motion', 'Ten animated backgrounds in Settings → Appearance, an accent glow that pulses around the composer while an agent is working, and subtle entrance animations throughout (all respect Reduce Motion).'],
      ['Usage meters', 'Every subscription you are signed in to shows at the bottom of the sidebar, along with your OpenRouter balance. Claude and ChatGPT report how much of each window you have left and when it resets; Grok, Nous, Qwen and Copilot do not publish usage, so those read simply “signed in”.'],
      ['Command palette', 'Press ⌘K for quick actions, model switching, and jumping between sessions.'],
      ['Links open in your browser', 'Links in an agent’s reply, and the Templeton Technologies logo on the About page, open in your default browser rather than trying to navigate inside the app.'],
      ['Windows stay where you put them', 'Radiant reopens at the size and position you left it, and remembers whether it was maximized or full screen. The Settings window keeps its own size. If you unplug the monitor a window was on, it comes back on a screen you can actually see.']
    ]
  }
]

function MemoryPane ({ config, onSettings }) {
  // Clearing saved chats lives here, not on About. It is a data action — the
  // same kind of thing as forgetting a remembered fact — and nobody looks for
  // "delete my history" under a version number and a company logo.
  const [storage, setStorage] = useState(null)
  const loadStorage = () => api.getStorage().then(setStorage).catch(() => {})
  useEffect(() => { loadStorage() }, [])
  const clearOld = async days => {
    const label = days === 0 ? 'ALL saved chat sessions' : `chat sessions older than ${days} days`
    if (!window.confirm(`Delete ${label}? This can't be undone.`)) return
    const r = await api.clearSessions(days)
    api.getStorage().then(setStorage).catch(() => {})
    window.alert(`Removed ${r.removed} session${r.removed === 1 ? '' : 's'}.`)
  }
  const [facts, setFacts] = useState(null)
  const [draft, setDraft] = useState('')
  const on = config.settings.memory !== false
  const load = () => api.getMemory().then(d => setFacts(d.facts)).catch(() => setFacts([]))
  useEffect(() => { load() }, [])
  const add = async () => { if (!draft.trim()) return; setFacts((await api.addMemory(draft.trim())).facts); setDraft('') }
  const del = async id => setFacts((await api.deleteMemory(id)).facts)
  const clear = async () => { if (window.confirm('Forget everything Radiant has remembered?')) setFacts((await api.clearMemory()).facts) }
  return (
    <div className='set-section'>
      <h3>Saved chats</h3>
      <p className='oauth-note' style={{ marginTop: 0 }}>
        {storage
          ? <>Radiant is keeping <strong>{storage.sessions}</strong> chat session{storage.sessions === 1 ? '' : 's'} ({storage.sizeMB} MB) in <span className='mono'>~/.radiant</span>. Old sessions add up — clear ones you no longer need.</>
          : 'Reading local storage…'}
      </p>
      <div className='row' style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12, alignItems: 'center' }}>
        <button className='small-btn' onClick={() => clearOld(90)}>Clear older than 90 days</button>
        <button className='small-btn' onClick={() => clearOld(30)}>Older than 30 days</button>
        <button className='small-btn danger' onClick={() => clearOld(0)}>Delete all sessions</button>
      </div>

      <ChatTransfer />

      <h3 style={{ marginTop: 26 }}>Memory</h3>
      <p className='hint' style={{ marginTop: 0 }}>Radiant remembers durable facts about you and your projects across sessions, and gives the relevant ones to the agent. Everything is stored locally in <code className='mono'>~/.radiant/memory.json</code>.</p>
      <label className='check-row'>
        <input type='checkbox' checked={on} onChange={e => onSettings({ memory: e.target.checked })} />
        <span>Remember across sessions <span className='desc'>— learn from each chat and recall it later</span></span>
      </label>
      <div className='row' style={{ marginTop: 12 }}>
        <input className='text-input' style={{ flex: 1 }} placeholder='Add something to remember…' value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} />
        <button className='small-btn primary' onClick={add} disabled={!draft.trim()}>Add</button>
      </div>
      <div style={{ marginTop: 14 }}>
        {facts === null ? <div className='v-meta'>Loading…</div>
          : !facts.length ? <div className='v-meta'>Nothing remembered yet — Radiant will learn as you chat.</div>
          : <>
              <div className='row' style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                <span className='v-meta'>{facts.length} remembered</span>
                <button className='small-btn danger' onClick={clear}>Forget all</button>
              </div>
              {facts.slice().reverse().map(f => (
                <div key={f.id} className='memory-item'>
                  <span className='memory-text'>{f.text}</span>
                  <button className='memory-del' title='Forget this' onClick={() => del(f.id)}>✕</button>
                </div>
              ))}
            </>}
      </div>
    </div>
  )
}

function GuidePane () {
  return (
    <div className='set-section guide'>
      <h3>Read me — what Radiant can do</h3>
      <p className='hint' style={{ marginTop: 0 }}>A quick tour of the features. Everything here is configured in the other tabs.</p>
      {GUIDE.map(sec => (
        <div key={sec.title} className='guide-section'>
          <div className='guide-title'>{sec.title}</div>
          {sec.items.map(([name, desc]) => (
            <div key={name} className='guide-item'>
              <span className='guide-name'>{name}</span>
              <span className='guide-desc'>{desc}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

const TABS = [
  { id: 'guide', label: 'Read me' },
  { id: 'providers', label: 'Providers' },
  { id: 'models', label: 'Models' },
  { id: 'agents', label: 'Agents' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP' },
  { id: 'memory', label: 'Memory' },
  { id: 'devices', label: 'Devices' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'agent', label: 'Automation' },
  { id: 'about', label: 'About' }
]

export default function Settings ({ config, initialTab = 'providers', initialAgentView = null, embedded = false, onClose, onSettings, onConfigChange, onModelsChanged }) {
  const [tab, setTab] = useState(initialTab)
  const body = (
    <div className={'modal wide' + (embedded ? ' embedded' : '')} role='dialog' aria-label='Settings'>
      <div className='modal-head'>
        Settings
        {!embedded && <button className='icon-btn' onClick={onClose} title='Close settings'><Icon.close /></button>}
      </div>
      <div className='modal-split'>
        <nav className='set-nav'>
          {TABS.map(t => (
            <button key={t.id} className={'set-nav-item' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className='modal-body'>
          {tab === 'guide' && <GuidePane />}
          {tab === 'providers' && <ProvidersPane config={config} onConfigChange={onConfigChange} />}
          {tab === 'models' && <ModelsPane onModelsChanged={onModelsChanged} config={config} onSettings={onSettings} />}
          {tab === 'agents' && <AgentsPane config={config} onConfigChange={onConfigChange} initialView={initialAgentView} />}
          {tab === 'skills' && <SkillsPane config={config} onConfigChange={onConfigChange} />}
          {tab === 'mcp' && <McpPane config={config} onConfigChange={onConfigChange} />}
          {tab === 'memory' && <MemoryPane config={config} onSettings={onSettings} />}
          {tab === 'devices' && <DevicesPane />}
          {tab === 'appearance' && <AppearancePane config={config} onSettings={onSettings} />}
          {tab === 'agent' && <AgentPane config={config} onSettings={onSettings} />}
          {tab === 'about' && <AboutPane config={config} onSettings={onSettings} />}
        </div>
      </div>
    </div>
  )
  if (embedded) return body
  return (
    <div className='modal-backdrop' onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      {body}
    </div>
  )
}

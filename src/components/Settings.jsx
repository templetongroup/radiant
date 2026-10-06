import React, { useEffect, useRef, useState } from 'react'
import { SKILL_CATEGORIES } from '../../server/skill-categories.js'
import qrcode from 'qrcode-generator'
import { verdict, FIT_LABEL, FITS_WELL, FITS_TIGHT, FITS_NO, COMFORTABLE } from '../fit.js'
import { api, startDownload, getDownloads, cancelDownload, streamQuantize, getServer, setServer, testServer, saveToFile, deviceNoun, phoneLink, EXTENSION_STORE_URL } from '../api.js'
import { THEMES, MODES, FONTS, UI_SCALES, applyTheme, hexToOklch, accentHex, glyphColor } from '../theme.js'
import { paletteWarnings, deriveAccent } from '../palette.js'
import { MOTIONS } from './MotionBackground.jsx'
import { Icon } from './Icons.jsx'
import { AGENT_ICONS, AGENT_ICON_IDS, AgentGlyph } from './AgentIcons.jsx'
import { AGENT_TEMPLATES, AGENT_TEMPLATE_CATS } from '../agentTemplates.js'
import { ModelPicker } from './Chat.jsx'
import ConfirmButton from './ConfirmButton.jsx'

// ⚠️ A BUILT-IN'S PERSONA IS ITS INSTRUCTIONS, NOT A SUMMARY — several sentences
// of "You are a…". Its opening sentence is the description a person recognises
// the agent by, with the second person trimmed so it reads as a label.
function firstSentence (persona) {
  if (!persona) return ''
  const first = String(persona).split(/(?<=\.)\s/)[0].trim()
  return first.replace(/^You are an?\s+/i, '').replace(/^\w/, c => c.toUpperCase())
}

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
            : !device && !signingIn && <>
                {/* ⚠️ A PROVIDER WITH A SIGN-IN COULD NOT TAKE A KEY. "+ Add account"
                    started another sign-in whenever OAuth existed, so the voice
                    feature's own advice — "add a key as a second OpenAI account" —
                    pointed at a button that could not do it. Tony pasted that
                    sentence back verbatim. Both doors, side by side. */}
                <button className='account-add' onClick={() => oauthInfo ? startSignIn(true) : setAddingKey(true)} disabled={busy}>{oauthInfo ? '+ Sign in to another account' : '+ Add account'}</button>
                {oauthInfo && provider.auth !== 'oauth' && <button className='account-add' onClick={() => setAddingKey(true)} disabled={busy}>+ Add an API key</button>}
              </>}
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

/**
 * Talking to Radiant — its own page.
 *
 * ⚠️ IT WAS A BLOCK AT THE BOTTOM OF PROVIDERS, and the key it needs was a
 * "second account" on the OpenAI row above it, which the chats also use. Tony:
 * "thats messy. we should add a separate voice page on the settings page.
 * scrolling all the way to the bottom of the providers page is awkward."
 * Everything voice needs is here now, and the key has its own slot
 * (keys['openai-voice']) so it never depends on which OpenAI account the chats
 * are on. Off by default: it costs money per minute and sends the microphone
 * to OpenAI, and neither should happen because a button was in reach.
 */
const GEMINI_MODELS = [
  ['gemini-3.8-live', 'Gemini 3.8 Live — fastest'],
  ['gemini-3.8-live-extended-thinking', 'Gemini 3.8 Live, extended thinking — slower, reasons more']
]
const GEMINI_VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr']
const LIVE_VOICES = [
  ['marin', 'Marin — default'], ['gleam', 'Gleam — North American, feminine'], ['meridian', 'Meridian — North American, masculine'],
  ['quartz', 'Quartz — Australian, feminine'], ['ripple', 'Ripple — Australian, masculine'], ['vesper', 'Vesper — British, masculine'],
  ['willow', 'Willow — Irish, feminine'], ['stone', 'Stone — Irish, masculine'], ['delta', 'Delta — Southern U.S., feminine'],
  ['cinder', 'Cinder — Southern U.S., masculine'], ['beacon', 'Beacon — Filipino English, masculine']
]
function VoicePane ({ config, onSettings, onConfigChange }) {
  const v = config?.settings?.voice || {}
  const on = Boolean(v.enabled)
  const openai = config?.providers?.find(p => p.id === 'openai')
  const saved = Boolean(config?.voiceKeySaved)
  // a key the chats already use serves too — say so rather than ask for another
  const chatKey = Boolean(openai?.hasKey) || (openai?.accounts || []).some(a => a.kind === 'key')
  const ready = saved || chatKey
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const saveKey = async () => {
    if (!draft.trim()) return
    setBusy(true)
    try { onConfigChange(await api.setVoiceKey(draft.trim())); setDraft('') } catch (e) { window.alert(e.message) }
    setBusy(false)
  }
  const removeKey = async () => {
    setBusy(true)
    try { onConfigChange(await api.setVoiceKey('')) } catch (e) { window.alert(e.message) }
    setBusy(false)
  }
  // ⚠️ TWO PROVIDERS, TWO KEYS, AND THEY ARE NOT INTERCHANGEABLE. Gemini Live
  // needs a Google AI Studio key of its own; an OpenAI key does nothing for it.
  // Saying so here is the difference between "voice does not work" and a
  // person knowing exactly what to paste.
  const which = v.provider === 'gemini' ? 'gemini' : 'openai'
  const gemSaved = Boolean(config?.geminiVoiceKeySaved)
  const [gemDraft, setGemDraft] = useState('')
  const saveGem = async () => {
    if (!gemDraft.trim()) return
    setBusy(true)
    try { onConfigChange(await api.setVoiceKey(gemDraft.trim(), 'gemini')); setGemDraft('') } catch (e) { window.alert(e.message) }
    setBusy(false)
  }
  const removeGem = async () => {
    setBusy(true)
    try { onConfigChange(await api.setVoiceKey('', 'gemini')) } catch (e) { window.alert(e.message) }
    setBusy(false)
  }
  return (
    <div className='set-section'>
      <h3>Voice</h3>
      <p className='hint' style={{ marginTop: 2 }}>
        Talk to Radiant. Press <b>Talk</b> in the composer and you are in a live, two-way conversation over that
        chat — speak naturally, interrupt, ask how it is going, change your mind. OpenAI's GPT-Live listens and
        speaks; anything real is handed to the agent in the chat, on whatever model the chat uses, with the same
        tools and approvals as typing. The reply is read back in a few plain sentences; code and detail stay in the chat.
      </p>

      <div className='set-block'>
        <div className='set-block-title'>Voice conversations</div>
        <div className='comp-stat'>
          <span className={on && ready ? 'key-ok' : 'fit-badge fit-tight'}>
            {on && ready ? '✓ Ready — Talk is in the composer' : on ? '— On, but no key yet' : '— Off'}
          </span>
        </div>
        <label className={'auto-choice' + (on ? ' is-on' : '')} style={{ marginTop: 6 }}>
          <input type='checkbox' checked={on} onChange={e => onSettings({ voice: { ...v, enabled: e.target.checked } })} />
          <span>
            <strong>Enable voice conversations</strong>
            <span className='auto-choice-sub'>Adds the Talk button. Nothing is sent anywhere until you press it.</span>
          </span>
        </label>
      </div>

      <div className='set-block'>
        <div className='set-block-title'>Which voice</div>
        <p className='hint' style={{ marginTop: 2 }}>
          Both do the same job: they listen and speak, and hand every real request back to Radiant so your own
          model, tools and approvals do the work. They bill by the minute and need different keys.
        </p>
        <div className='row' style={{ marginTop: 6, alignItems: 'center', gap: 8 }}>
          <select className='text-input' style={{ width: 'auto' }} value={which} onChange={e => onSettings({ voice: { ...v, provider: e.target.value } })}>
            <option value='openai'>OpenAI GPT-Live — about 5¢ a minute</option>
            <option value='gemini'>Google Gemini 3.8 Live — about 0.5¢ a minute in, 1.8¢ out</option>
          </select>
        </div>
        {which === 'gemini' && (
          <div style={{ marginTop: 10 }}>
            <div className='row' style={{ alignItems: 'center', gap: 8 }}>
              <select className='text-input' style={{ width: 'auto' }} value={GEMINI_MODELS.some(([id]) => id === v.geminiModel) ? v.geminiModel : 'gemini-3.8-live'} onChange={e => onSettings({ voice: { ...v, geminiModel: e.target.value } })}>
                {GEMINI_MODELS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
              <select className='text-input' style={{ width: 'auto' }} value={GEMINI_VOICES.includes(v.geminiVoice) ? v.geminiVoice : 'Kore'} onChange={e => onSettings({ voice: { ...v, geminiVoice: e.target.value } })}>
                {GEMINI_VOICES.map(id => <option key={id} value={id}>{id}</option>)}
              </select>
            </div>
            <p className='hint' style={{ marginTop: 8 }}>
              Gemini needs a Google AI Studio API key of its own — an OpenAI key does not work for it. Get one at{' '}
              <span className='mono'>aistudio.google.com</span>. It stays on this Mac; the app hands the browser only a
              short-lived token that lasts one call.
            </p>
            {gemSaved
              ? <div className='row' style={{ marginTop: 6, alignItems: 'center', gap: 8 }}>
                  <span className='key-ok'>✓ Gemini key saved</span>
                  <button className='small-btn' onClick={removeGem} disabled={busy}>Remove key</button>
                </div>
              : <div className='row' style={{ marginTop: 6, gap: 8 }}>
                  <input className='text-input' type='password' placeholder='Paste Google AI Studio key' value={gemDraft} onChange={e => setGemDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && saveGem()} style={{ flex: 1, minWidth: 220 }} />
                  <button className='small-btn primary' onClick={saveGem} disabled={busy || !gemDraft.trim()}>Save</button>
                </div>}
          </div>
        )}
      </div>

      <div className='set-block' style={{ display: which === 'openai' ? undefined : 'none' }}>
        <div className='set-block-title'>OpenAI API key for voice</div>
        <p className='hint' style={{ marginTop: 2 }}>
          GPT-Live is API-only — a ChatGPT sign-in does not cover it. Paste a key from{' '}
          <span className='mono'>platform.openai.com</span>; it is kept for voice alone and does not change which
          OpenAI account your chats use.
          {!saved && chatKey && <> You already have an OpenAI key under Providers, and voice will use that one until you paste a separate key here.</>}
        </p>
        {saved
          ? <div className='row' style={{ marginTop: 6, alignItems: 'center', gap: 8 }}>
              <span className='key-ok'>✓ key saved</span>
              <button className='small-btn' onClick={removeKey} disabled={busy}>Remove key</button>
            </div>
          : <div className='row' style={{ marginTop: 6, gap: 8 }}>
              <input className='text-input' type='password' placeholder='Paste API key' value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && saveKey()} style={{ flex: 1, minWidth: 220 }} />
              <button className='small-btn primary' onClick={saveKey} disabled={busy || !draft.trim()}>Save</button>
            </div>}
      </div>

      {/* GPT-Live's own voice list. Hidden under Gemini, which picks its voice
          in the block above — leaving both on screen offers a choice that does
          nothing, which reads as a bug. */}
      <div className='set-block' style={{ display: which === 'openai' ? undefined : 'none' }}>
        <div className='set-block-title'>Voice</div>
        <div className='row' style={{ marginTop: 4, alignItems: 'center', gap: 8 }}>
          <select className='text-input' style={{ width: 'auto' }} value={LIVE_VOICES.some(([id]) => id === v.voice) ? v.voice : 'marin'} onChange={e => onSettings({ voice: { ...v, voice: e.target.value } })}>
            {LIVE_VOICES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </div>
      </div>

      <div className='set-block'>
        <div className='set-block-title'>What leaves this Mac</div>
        <p className='hint' style={{ marginTop: 2 }}>
          While a call is open, your microphone and the spoken replies go to {which === 'gemini' ? 'Google' : 'OpenAI'},
          at their rate — {which === 'gemini' ? 'about 0.5¢ a minute for what you say and 1.8¢ for what it says back' : 'about 5¢ a minute'}.
          The strip above the composer shows the running minutes and an End button; switching chats ends
          the call. The chat's own model, tools and files are untouched — the voice only carries the conversation.
          An approval or a question still waits for you in the app, and the voice says so.
        </p>
      </div>
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
      {/* ⚠️ A SKELETON, NOT THE WORD "LOADING". This list is the slowest thing on
          the screen — it is a round trip to Hugging Face — and "Loading…" gives no
          hint of what is arriving or how much. Three bars in the shape of the rows
          that are coming do. */}
      {open && !files && !failed && (
        <div className='variant-row'>
          <div className='skel-rows' style={{ flex: 1 }}>
            <div className='skel' /><div className='skel' /><div className='skel' />
          </div>
        </div>
      )}
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
            <span className='v-meta'>{qt.sizeGB == null
                ? 'size unknown — the registry did not report one'
                : `${qt.sizeGB} GB download · ~${ram} GB RAM`}</span>
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
                      {/* ⚠️ A STAGE MARK, NOT JUST A NUMBER. This flow has broken four times in
                          production and every failure looked the same from here: a number that
                          stopped meaning anything. The stage now carries its own mark — a pulsing
                          dot while bytes move, a turning square while Ollama imports — so "stuck
                          at 100%" and "importing, be patient" cannot look identical again. */}
                      <span className={'pull-stage' + (importing ? ' is-importing' : '')}>
                        <span className='pull-stage-dot' aria-hidden />
                        {importing ? (pull.status || 'importing…') : (pct != null ? pct + '%' : (pull.status || 'starting…'))}
                      </span>
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
        project's, still wins. Set per {deviceNoun(config?.platform)}, so each one can default to
        the models it has downloaded rather than ones it cannot run.
      </p>
      <div className='model-pick-field' style={{ marginTop: 8 }}>
          <ModelPicker
            session={{ model: current, provider: config?.settings?.defaultProvider }}
            models={models}
            placeholder='No default — pick a model in each chat'
            clearLabel='No default — pick a model in each chat'
            onPick={m => onSettings({ defaultModel: m ? m.id : null, defaultProvider: m ? m.provider : null })}
            onRefresh={() => {}}
          />
        </div>
      {current && !models.some(m => m.id === current) && (
        <div className='set-hint' style={{ marginTop: 6 }}>
          <strong>{current}</strong> is set here but is not available on this {deviceNoun(config?.platform)} right now —
          new chats will fall back until it is, or until you pick another.
        </div>
      )}
    </div>
  )
}

/**
 * The model a turn moves to when the chat's model is not answering. Only
 * outages — a 5xx, a rate limit, a dead connection — and only for a turn that
 * had not yet done anything; see server/fallback.js.
 */
function FallbackModelBlock ({ config, onSettings }) {
  const [models, setModels] = useState([])
  useEffect(() => { api.getModels().then(r => setModels(r.models || r || [])).catch(() => {}) }, [])
  const fb = config?.settings?.fallback || null
  return (
    <div className='set-block' style={{ marginBottom: 16 }}>
      <div className='set-block-title'>If the model is not answering</div>
      <p className='hint' style={{ marginTop: 2 }}>
        When a provider is down, rate-limiting, or unreachable, a turn that has not yet done anything
        is rerun on this model instead of stopping, and the chat says so. A turn that had already
        run tools is not redone. Pick a model on a different provider for it to be worth anything.
      </p>
      <div className='model-pick-field' style={{ marginTop: 8 }}>
        <ModelPicker
          session={{ model: fb?.model || '', provider: fb?.provider }}
          models={models}
          placeholder='No fallback — an outage stops the turn'
          clearLabel='No fallback — an outage stops the turn'
          onPick={m => onSettings({ fallback: m ? { provider: m.provider, model: m.id } : null })}
          onRefresh={() => {}}
        />
      </div>
    </div>
  )
}

/**
 * How much of a local model's context Radiant will fill, and — separately —
 * how much Ollama has actually reserved.
 *
 * ⚠️ TWO NUMBERS, AND THEY ARE NOT THE SAME KNOB. Ollama picks a model's
 * context from the machine's RAM (under 24 GiB → 4k, 24–48 → 32k, 48 GiB and
 * up → 256k) and reserves the KV cache for all of it at load: on a 48 GB Mac
 * that made Devstral take 59 GB. Radiant never asks for a size and cannot —
 * the OpenAI-compatible endpoint has no such option — but it DID treat
 * whatever Ollama reported as the point to start trimming, so a local chat
 * could grow toward a quarter-million tokens, re-sent in full every round.
 *
 * So Radiant caps its own working window, and this block says plainly which
 * number does what and where each one is changed. Tony: "yes as long as its
 * clear how to increase the context length."
 */
const LOCAL_CTX_CHOICES = [8192, 16384, 32768, 65536, 131072, 0]
const ctxLabel = n => (n === 0 ? 'Whatever Ollama loaded' : `${Math.round(n / 1024)}K tokens`)

/**
 * The model Radiant uses for its OWN housekeeping — naming a chat, extracting
 * durable facts, drafting a skill idea, summarizing for compaction.
 *
 * ⚠️ THESE RAN ON THE CHAT'S MODEL AND WERE NOT COUNTED. Three or four extra
 * calls per turn, at flagship prices, for one-line summarisation — and invisible
 * in the token counter, so it was spend nobody could see. Radiant now picks a
 * cheap model from the same provider the chat uses (so the key already works)
 * and counts what it spends. This overrides that pick.
 */
function UtilityModelBlock ({ config, onSettings }) {
  const [models, setModels] = useState([])
  useEffect(() => { api.getModels().then(r => setModels(r.models || r || [])).catch(() => {}) }, [])
  const um = config?.settings?.utilityModel || null
  return (
    <div className='set-block' style={{ marginBottom: 16 }}>
      <div className='set-block-title'>Background work</div>
      <p className='hint' style={{ marginTop: 2 }}>
        Naming a chat, remembering a fact, suggesting a skill and summarizing a long conversation are
        small jobs Radiant does for itself, a few times per turn. They run on a cheap model from the
        same provider your chat uses, and what they spend is shown in the token counter beside the
        composer. Pick one here to override that choice.
      </p>
      <div className='model-pick-field' style={{ marginTop: 8 }}>
        <ModelPicker
          session={{ model: um?.model || '', provider: um?.provider }}
          models={models}
          placeholder='Automatic — cheapest on this provider'
          clearLabel='Automatic — cheapest on this provider'
          onPick={m => onSettings({ utilityModel: m ? { provider: m.provider, model: m.id } : null })}
          onRefresh={() => {}}
        />
      </div>
      <label className='check-row' style={{ marginTop: 12 }}>
        <input
          type='checkbox'
          checked={config?.settings?.fastLane !== false}
          onChange={e => onSettings({ fastLane: e.target.checked })}
        />
        <span>Answer quick lookups instantly, without a model <span className='desc'>— “what’s uncommitted”, “last few commits”, “what’s in this folder”, “which model is this”, “what’s TG-474 about” (with a Linear server). A quick decision recognizes the question, the tool runs, and its output is the answer, in under a second. Only when it is sure; never mid-task. Needs an OpenRouter key.</span></span>
      </label>
      <label className='check-row' style={{ marginTop: 12 }}>
        <input
          type='checkbox'
          checked={config?.settings?.smartRouting !== false}
          onChange={e => onSettings({ smartRouting: e.target.checked })}
        />
        <span>Let easy messages go to that cheap model <span className='desc'>— before each message, a quick decision says whether a fast model can answer it well (a short question, a one-line edit, “thanks, now commit”). If it is sure, the fast model answers in a couple of seconds; anything harder stays on the model you chose. The reply says which model answered. Never mid-task, in plan mode or in a group chat. With an OpenRouter key the decision is Jev’s (0.3 s); without one the cheap model judges (1–2 s); with neither, nothing changes.</span></span>
      </label>
      <label className='check-row' style={{ marginTop: 12 }}>
        <input
          type='checkbox'
          checked={config?.settings?.projectRules !== false}
          onChange={e => onSettings({ projectRules: e.target.checked })}
        />
        <span>Follow a project\u2019s own rules file <span className='desc'>\u2014 when a chat is working in a folder that has an <code>AGENTS.md</code>, <code>CLAUDE.md</code>, <code>.clinerules</code> or <code>.cursorrules</code> (in the folder or up at the repo root), Radiant loads it into the agent so it follows that project\u2019s conventions without being told each time. The chat says which file it loaded. Off means the agent ignores those files.</span></span>
      </label>
      <TurnBudget config={config} onSettings={onSettings} />
    </div>
  )
}

// ⚠️ THE THING THAT LETS A BUILD ACTUALLY FINISH. Radiant used to stop a turn at
// 200 tool-rounds, which chopped real app-builds into a wall every time (Tony:
// "how can a user build anything"). A build now runs to completion; the only
// ceiling is this spend budget — the turn pauses and asks when it reaches the
// number you pick, so it is never a surprise and never an arbitrary wall. Most
// of those tokens are served from cache, so the real cost is a fraction.
function TurnBudget ({ config, onSettings }) {
  const cur = Number.isFinite(Number(config?.settings?.turnTokenBudget)) ? Number(config.settings.turnTokenBudget) : 15_000_000
  const OPTIONS = [
    { v: 5000000, label: '5M — cautious' },  // billable (real-cost) tokens
    { v: 15000000, label: '15M — default' },
    { v: 30000000, label: '30M — long builds' },
    { v: 0, label: 'No budget — run to completion' }
  ]
  const val = String(cur)
  return (
    <div style={{ marginTop: 14 }}>
      <div className='set-block-title' style={{ fontSize: 12 }}>Long builds</div>
      <p className='hint' style={{ marginTop: 2 }}>
        A turn runs until the work is done — it is not cut off at a round count. The one limit is real cost:
        it pauses to ask only when the turn spends this much in tokens that actually cost money. Cache reads
        — the bulk of a long turn — barely count, so an ordinary build finishes without ever pausing. It also
        stops on its own if it gets stuck (commands that keep failing).
      </p>
      <label className='lp-pick' style={{ marginTop: 8 }}>
        <span>Pause and ask after</span>
        <select className='lp-input' style={{ width: 'auto' }} value={OPTIONS.some(o => String(o.v) === val) ? val : '15000000'}
          onChange={e => onSettings({ turnTokenBudget: Number(e.target.value) })}>
          {OPTIONS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
      </label>
    </div>
  )
}

function LocalContextBlock ({ config, onSettings }) {
  const [loaded, setLoaded] = useState({ running: false, models: [] })
  useEffect(() => { api.getLoadedLocalModels().then(setLoaded).catch(() => {}) }, [])
  const cur = Number.isFinite(Number(config?.settings?.localContext)) ? Number(config.settings.localContext) : 32768
  const big = (loaded.models || []).filter(m => m.context && cur !== 0 && m.context > cur)
  return (
    <div className='set-block' style={{ marginBottom: 16 }}>
      <div className='set-block-title'>Local model context</div>
      <p className='hint' style={{ marginTop: 2 }}>
        How much of a local model&rsquo;s context a chat may fill before Radiant starts trimming older
        tool results. Raising this lets local chats stay longer before they are trimmed; it does not
        change how much memory the model reserves.
      </p>
      <div style={{ marginTop: 8 }}>
        {/* ⚠️ text-input, NOT set-input. set-input paints a dark field and the
            text stays dark on it — 43,49,41 on 59,59,59, which is invisible.
            Every other select on this screen uses text-input; matching it is
            also the only way this follows a theme change. */}
        <select
          className='text-input'
          value={String(cur)}
          onChange={e => onSettings({ localContext: Number(e.target.value) })}
        >
          {LOCAL_CTX_CHOICES.map(n => <option key={n} value={String(n)}>{ctxLabel(n)}</option>)}
        </select>
      </div>
      {loaded.running && (loaded.models || []).length > 0 && (
        <div className='hint' style={{ marginTop: 10 }}>
          <strong>Loaded in Ollama right now:</strong>
          {(loaded.models || []).map(m => (
            <div key={m.name} style={{ marginTop: 2 }}>
              {m.name} — {m.context ? `${Math.round(m.context / 1024)}K context` : 'context unknown'}
              {m.sizeGB ? ` · ${m.sizeGB} GB` : ''}
            </div>
          ))}
        </div>
      )}
      <p className='hint' style={{ marginTop: 10 }}>
        <strong>To change the memory a model reserves, use Ollama, not Radiant.</strong> Ollama picks a
        model&rsquo;s context from the memory it finds &mdash; under 24&nbsp;GB it loads 4K, 24&ndash;48&nbsp;GB 32K,
        and 48&nbsp;GB or more 256K &mdash; and reserves it all when the model loads, which is how a
        single model can take tens of gigabytes. Change it in <strong>Ollama&rsquo;s own Settings &rarr; Context
        length</strong>, or start the server with <code>OLLAMA_CONTEXT_LENGTH=32768 ollama serve</code>.
        {big.length > 0 && (
          <> Right now {big.map(m => m.name).join(', ')} {big.length === 1 ? 'is' : 'are'} loaded with more
          context than Radiant will use, so the extra is reserved memory you are not getting the benefit of.</>
        )}
      </p>
    </div>
  )
}

function ModelsPane ({ onModelsChanged, config, onSettings }) {
  const [system, setSystem] = useState(null)
  // ⚠️ EVERYTHING ON THIS SCREEN BELONGS TO THE SERVER'S MAC, NOT NECESSARILY
  // THIS ONE. The chip, the memory, the free disk and the installed list all come
  // from whichever machine runs Radiant — and a download starts there too,
  // detached, whether or not this window stays open. Saying "this Mac" while
  // connected to another one is simply wrong, and it is how a pull started on a
  // laptop ends up filling a Mac in another room. Tony, on where a model lands:
  // "correct. thats what confused me."
  // /api/system already describes the server's machine — hostname, chip, free
  // space — so the word for it comes from the same answer as the rest.
  const noun = deviceNoun(system?.platform)
  const onAnotherMac = Boolean(getServer().base)
  const serverMac = system?.hostname || (() => {
    try { return new URL(getServer().base).hostname } catch { return `the other ${noun}` }
  })()
  const where = onAnotherMac ? serverMac : `this ${noun}`
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
      <FallbackModelBlock config={config} onSettings={onSettings} />
      <LocalContextBlock config={config} onSettings={onSettings} />
      <UtilityModelBlock config={config} onSettings={onSettings} />
      <h3>Local models</h3>
      {onAnotherMac && (
        <div className='set-hint' style={{ marginBottom: 10 }}>
          You are using the Radiant on <strong>{serverMac}</strong>. Models download to that {noun}
          and run there — not on this one — and the memory and free space below are its own.
          A download keeps going there even if you close this window.
        </div>
      )}
      {system && (
        <div className='spec-card'>
          <div className='spec-chip-name'>{system.chip}</div>
          <div className='spec-detail'>
            {/* "unified memory" and "macOS" are both true only on a Mac. osVersion
                already names itself off one ("Ubuntu 24.04.1 LTS"), so prefixing it
                there would read "macOS Ubuntu 24.04.1 LTS". */}
            {system.ramGB} GB {system.platform === 'darwin' ? 'unified memory' : 'memory'} · {system.cores} cores
            · {system.platform === 'darwin' ? `macOS ${system.osVersion}` : system.osVersion}
            {system.diskFreeGB != null && <> · <span className={system.diskFreeGB < 20 ? 'fit-badge fit-tight' : ''}>{system.diskFreeGB} GB free on disk</span></>}
          </div>
          <div className='spec-note'>
            Badges show what fits: <span className='fit-badge fit-ok'>{FIT_LABEL[FITS_WELL]}</span> under {Math.round(system.ramGB * COMFORTABLE)} GB,
            <span className='fit-badge fit-tight'> {FIT_LABEL[FITS_TIGHT]}</span> near the limit,
            <span className='fit-badge fit-no'> {FIT_LABEL[FITS_NO]}</span> on {where}.
          </div>
        </div>
      )}
      {!local.running && (
        <div className='error-note'>⚠ Ollama isn't running — start it to download and run local models.</div>
      )}

      {local.models.length > 0 && (
        <div className='installed-block'>
          <div className='installed-label'>On {where} · {local.models.length} installed</div>
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

function McpPane ({ config, onConfigChange, onSettings }) {
  const servers = config.mcpServers || []
  const hasOpenRouter = Boolean(config.providers?.find?.(p => p.id === 'openrouter')?.hasKey ?? config.keys?.openrouter)
  const [status, setStatus] = useState([])
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [token, setToken] = useState('')

  const loadStatus = () => api.mcpStatus().then(r => setStatus(r.servers || [])).catch(() => {})
  useEffect(() => { loadStatus() }, [servers.length])

  // ⚠️ A URL IS NOT A COMMAND. The server has supported remote MCP servers all
  // along — /api/mcp accepts a url and mcp.js picks StreamableHTTPClientTransport
  // for it — but this form only ever sent { command, args }, and the field was
  // the only box on screen. So a hosted server's address went to spawn() and
  // came back "spawn http://mcp.higgsfield.ai/mcp ENOENT": the app trying to run
  // a web address as a local program. Tony hit it on his first MCP.
  const add = async () => {
    const entry = command.trim()
    if (!name.trim() || !entry) return
    const isUrl = /^https?:\/\//i.test(entry)
    const body = isUrl
      ? { name: name.trim(), url: entry, transport: 'http', token: token.trim() || null }
      : (() => { const [cmd, ...args] = entry.split(/\s+/); return { name: name.trim(), command: cmd, args } })()
    const cfg = await api.addMcp(body)
    setName(''); setCommand(''); setToken(''); setAdding(false)
    onConfigChange(cfg); setTimeout(loadStatus, 500)
  }
  const toggle = async (id, enabled) => { onConfigChange(await api.updateMcp(id, { enabled })); setTimeout(loadStatus, 500) }
  const remove = async id => { if (window.confirm('Remove this MCP server?')) onConfigChange(await api.deleteMcp(id)) }

  // ⚠️ THERE WAS NO EDIT. PATCH /api/mcp/:id has existed all along, and the
  // only thing this pane sent through it was the on/off checkbox — so a typo in
  // a launch command meant delete, re-add, repeat. iandouglas, issue #15: "I had
  // to keep adding it over and over and then manually removing all of the old
  // ones." Same fields as Add, on the row itself.
  const [editing, setEditing] = useState(null)   // { id, name, entry, token }
  const startEdit = s => setEditing({ id: s.id, name: s.name, entry: s.url || [s.command, ...(s.args || [])].join(' '), token: '' })
  const saveEdit = async () => {
    const entry = editing.entry.trim()
    if (!editing.name.trim() || !entry) return
    const isUrl = /^https?:\/\//i.test(entry)
    const patch = isUrl
      ? { name: editing.name.trim(), url: entry, command: null, args: [], ...(editing.token.trim() ? { token: editing.token.trim() } : {}) }
      : (() => { const [cmd, ...args] = entry.split(/\s+/); return { name: editing.name.trim(), url: null, command: cmd, args } })()
    onConfigChange(await api.updateMcp(editing.id, patch))
    setEditing(null); setTimeout(loadStatus, 500)
  }

  const st = id => status.find(s => s.id === id)
  return (
    <div className='set-section'>
      <h3>MCP servers</h3>
      <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 0 }}>
        Model Context Protocol servers give agents extra tools — databases, APIs, file systems, and more.
        Add one by its launch command (<span className='mono'>npx some-mcp-server</span>) or by its address if it is hosted (<span className='mono'>https://…</span>). Its tools become available to the agent, and each call asks for approval.
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
            {editing?.id !== s.id && <button className='small-btn' onClick={() => startEdit(s)}>Edit</button>}
            <button className='small-btn danger' onClick={() => remove(s.id)}>✕</button>
          </div>
        )
      })}
      {editing && (
        <div className='skill-add'>
          <div className='set-block-title'>Edit {editing.name || 'server'}</div>
          <input className='text-input' style={{ fontFamily: 'inherit', marginBottom: 8 }} placeholder='Name' value={editing.name} onChange={e => setEditing(x => ({ ...x, name: e.target.value }))} />
          <input className='text-input' style={{ marginBottom: 4 }} placeholder='Launch command or https:// address' value={editing.entry} onChange={e => setEditing(x => ({ ...x, entry: e.target.value }))} />
          {/^https?:\/\//i.test(editing.entry.trim()) && (
            <input className='text-input' style={{ marginBottom: 4 }} type='password' placeholder='New access token (leave empty to keep the current one)' value={editing.token} onChange={e => setEditing(x => ({ ...x, token: e.target.value }))} />
          )}
          <div className='oauth-note'>A command runs with the same PATH your terminal has, so <span className='mono'>npx</span>, <span className='mono'>uvx</span> and tools from your shell profile are found. A line with <span className='mono'>=</span>, a pipe or several words in the first token is run through your shell as written.</div>
          <div className='row' style={{ marginTop: 8 }}>
            <button className='small-btn primary' onClick={saveEdit} disabled={!editing.name.trim() || !editing.entry.trim()}>Save</button>
            <button className='small-btn' onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}
      {!servers.length && <div className='activity-empty' style={{ marginTop: 8 }}>No MCP servers yet.</div>}
      {servers.length > 0 && (
        <label className='check-row' style={{ marginTop: 10 }}>
          <input
            type='checkbox'
            checked={config.settings?.smartTools !== false}
            onChange={e => onSettings?.({ smartTools: e.target.checked })}
          />
          <span>Attach a server’s tools only when a message needs them <span className='desc'>— a quick, cheap decision model (Jev, through OpenRouter) reads each message first, so a Linear server is not sent along with “fix this bug”. A server already used in the conversation stays attached. Off, or without an OpenRouter key, every server’s tools go with every message.{hasOpenRouter ? '' : ' Add an OpenRouter key under Providers to enable it.'}</span></span>
        </label>
      )}

      {adding
        ? <div className='skill-add'>
            <input className='text-input' style={{ fontFamily: 'inherit', marginBottom: 8 }} placeholder='Name (e.g. Filesystem)' value={name} onChange={e => setName(e.target.value)} />
            <input className='text-input' style={{ marginBottom: 4 }} placeholder='Launch command or https:// address' value={command} onChange={e => setCommand(e.target.value)} />
            {/* Only meaningful for a hosted server, so it appears only then. */}
            {/^https?:\/\//i.test(command.trim()) && (
              <input className='text-input' style={{ marginBottom: 4 }} type='password'
                placeholder='Access token, if the server needs one (optional)'
                value={token} onChange={e => setToken(e.target.value)} />
            )}
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
  // Two clicks in our own UI, because a native confirm is swallowed here.
  //
  // ⚠️ IT DOES NOT TIME OUT. It used to disarm itself after four seconds, which
  // is less time than it takes to read the sentence it puts on screen — so the
  // prompt quietly turned back into a plain Remove button and the second click
  // re-armed it instead of removing anything. Tony: "Yes, but the second click
  // does nothing." It did do something; it did the wrong thing, invisibly.
  // Cancelling is Keep, or closing the editor. A prompt that moves while you are
  // deciding is worse than one that waits.
  const [confirmRemove, setConfirmRemove] = useState(false)
  const accentHue = Math.round(Number(getComputedStyle(document.documentElement).getPropertyValue('--accent-h')) || 258)
  const toggleSkill = id => set({ skills: (a.skills || []).includes(id) ? a.skills.filter(s => s !== id) : [...(a.skills || []), id] })
  return (
    <div className='agent-editor'>
      <div className='agent-editor-head'>
        <span className='agent-emoji-input' style={{ color: glyphColor(a.hue, 0.65, 0.15) }}><AgentGlyph agent={a} size={22} /></span>
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
        <div className='model-pick-field'>
          <ModelPicker
            session={{ model: a.model, provider: a.provider }}
            models={models}
            placeholder='Session default (pick per chat)'
            clearLabel='Session default (pick per chat)'
            onPick={m => set({ model: m ? m.id : null, provider: m ? m.provider : null })}
            onRefresh={() => {}}
          />
        </div>
      </label>
      <label className='agent-field'>Planner model <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>— optional lead model that plans first, then the model above executes</span>
        <div className='model-pick-field'>
          <ModelPicker
            session={{ model: a.plannerModel, provider: a.plannerProvider }}
            models={models}
            placeholder='None (no separate planning step)'
            clearLabel='None (no separate planning step)'
            onPick={m => set({ plannerModel: m ? m.id : null, plannerProvider: m ? m.provider : null })}
            onRefresh={() => {}}
          />
        </div>
      </label>
      <label className='agent-field'>Color
        <span className='agent-color-row'>
          <input type='range' min='0' max='360' className='hue-slider' value={a.hue ?? accentHue} onChange={e => set({ hue: Number(e.target.value) })} />
          <span className='agent-color-dot' style={{ background: glyphColor(a.hue, 0.7, 0.16) }} />
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
      {/* These two are not skills — they are what the agent is ALLOWED to do —
          so they sit apart rather than at the end of the skill grid, where they
          read as two more skills. */}
      <div className='agent-field-row agent-caps'>
        <label className='agent-skill-chk'><input type='checkbox' checked={a.useTools !== false} onChange={e => set({ useTools: e.target.checked })} /> Agent tools</label>
        <label className='agent-skill-chk'><input type='checkbox' checked={Boolean(a.computerControl)} onChange={e => set({ computerControl: e.target.checked })} /> Computer control</label>
      </div>
      <div className='row agent-editor-actions'>
        <button className='small-btn primary' onClick={() => onSave(a)} disabled={!a.name?.trim()}>Save</button>
        <button className='small-btn' onClick={onClose}>Cancel</button>
        {agent.id && onDuplicate && <button className='small-btn' onClick={() => onDuplicate(a)} title='Make an editable copy of this agent'>Duplicate</button>}
        {/* ⚠️ NO NATIVE DIALOG. This was `if (window.confirm(…)) onDelete(…)`,
            and in the packaged app the click did nothing at all — Tony, twice:
            "im removing agents in settings and nothings happening", then "agents
            are sstill not removing from the list when I click remove." Driven in
            a browser with confirm forced to true the code path is fine: 13 → 12,
            recorded, editor closed. So the dialog was the whole failure, and
            this app has been burned by a native dialog before — window.prompt is
            a no-op here, which is why the folder picker is native code.
            Two clicks in our own UI instead, which cannot be swallowed by the
            host: Remove, then Confirm. It re-arms after four seconds so a stray
            first click does not sit there armed. */}
        {agent.id && (
          confirmRemove
            ? <span className='confirm-inline'>
                <span className='confirm-inline-q'>
                  {agent.builtin ? 'Remove it? You can add it back from the library.' : 'Delete for good?'}
                </span>
                <button className='small-btn danger' onClick={() => { setConfirmRemove(false); onDelete(agent.id) }}>
                  {agent.builtin ? 'Remove' : 'Delete'}
                </button>
                <button className='small-btn' onClick={() => setConfirmRemove(false)}>Keep</button>
              </span>
            : <button
                className='small-btn danger'
                onClick={() => setConfirmRemove(true)}
              >{agent.builtin ? 'Remove' : 'Delete'}</button>
        )}
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
        {/* ⚠️ THE WAY BACK. Removing a built-in is only safe to offer because it
            can be undone, and it can only be undone if you can SEE what you
            removed. Without this, Remove is a one-way door with a reassuring
            confirm on it. */}
        {(config.removedAgentDefs || []).length > 0 && (
          <div className='tmpl-cat'>
            <div className='tmpl-cat-label'>
              Removed from your agents
              <button
                className='tmpl-restore-all'
                onClick={async () => {
                  // One request each, but a single repaint: putting thirteen
                  // agents back should not be thirteen clicks, and should not
                  // redraw the library thirteen times either.
                  let cfg = null
                  for (const d of (config.removedAgentDefs || [])) cfg = await api.restoreAgent(d.id)
                  if (cfg) onConfigChange(cfg)
                }}
              >Restore all {(config.removedAgentDefs || []).length}</button>
            </div>
            <div className='tmpl-grid stagger'>
              {(config.removedAgentDefs || []).map(def => (
                <button key={def.id} className='tmpl-card' onClick={async () => onConfigChange(await api.restoreAgent(def.id))}>
                  <span className='tmpl-ico'>{(AGENT_ICONS[def.icon] || AGENT_ICONS.bot)({ size: 18 })}</span>
                  <span className='tmpl-body'>
                    <span className='tmpl-name'>{def.name}</span>
                    <span className='tmpl-blurb'>{firstSentence(def.persona) || 'A built-in you removed.'}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        {shownCats.map(cat => (
          <div key={cat} className='tmpl-cat'>
            <div className='tmpl-cat-label'>{cat}</div>
            <div className='tmpl-grid stagger'>
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
          <div className='ext-agents-title'>Connected agents on this {deviceNoun(config?.platform)}</div>
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
            <span className='agent-avatar' style={{ color: glyphColor(a.hue, 0.68, 0.16) }}><AgentGlyph agent={a} size={20} /></span>
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

/**
 * The skill library — a shelf of ready-made skills that ship inside the app.
 *
 * ⚠️ NOTHING IS ADDED WITHOUT BEING READABLE FIRST. A skill is text that goes
 * into the model's instructions, so "Read it" fetches the whole SKILL.md and
 * shows it before "Add" is worth pressing. The same reason the server refuses
 * a skill folder containing anything runnable: a skill is read, never executed.
 *
 * Collapsed by default. Twenty-nine rows unfurled above the user's own skills
 * would bury the list that actually matters.
 */
function SkillLibrary ({ onConfigChange }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState(null)
  const [reading, setReading] = useState(null)   // { dir, doc, files, executables } | 'loading'
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [openCat, setOpenCat] = useState(null)

  useEffect(() => {
    if (!open || rows) return
    api.skillLibrary().then(r => setRows(r.skills || [])).catch(() => setRows([]))
  }, [open, rows])

  const read = async dir => {
    if (reading?.dir === dir) return setReading(null)
    setReading({ dir, loading: true })
    try { setReading({ ...(await api.skillLibraryOne(dir)), dir }) } catch { setReading(null) }
  }

  const install = async dir => {
    setBusy(dir); setErr('')
    try {
      onConfigChange(await api.installLibrarySkill(dir))
      setRows(rs => (rs || []).map(r => r.dir === dir ? { ...r, installed: true } : r))
    } catch (e) {
      setErr(String(e?.message || e).includes('executable')
        ? 'That skill folder contains a runnable file, so it was not added.'
        : 'Could not add that skill.')
    }
    setBusy(null)
  }

  // ⚠️ 270 SKILLS IS A SEARCH PROBLEM, NOT A LIST. Every category closed and a
  // box at the top: typing filters across titles, blurbs and folder names, and
  // a search opens whatever it matched so results are never hidden behind a
  // heading someone still has to click.
  const needle = q.trim().toLowerCase()
  const hits = (rows || []).filter(r => !needle ||
    (r.title + ' ' + r.blurb + ' ' + r.dir).toLowerCase().includes(needle))
  const groups = []
  for (const r of hits) {
    const g = groups.find(x => x.name === r.category)
    if (g) g.rows.push(r); else groups.push({ name: r.category, rows: [r] })
  }

  return (
    <div className='skill-library'>
      <button className='skill-lib-head' onClick={() => setOpen(o => !o)}>
        <Icon.file size={14} />
        <span className='skill-lib-title'>Skill library</span>
        <span className='skill-lib-sub'>Ready-made skills that ship with Radiant — read one before you add it</span>
        <span className='skill-lib-chev'>{open ? '▾' : '▸'}</span>
      </button>

      {open && rows === null && <div className='activity-empty' style={{ marginTop: 8 }}>Loading…</div>}
      {open && rows?.length === 0 && <div className='activity-empty' style={{ marginTop: 8 }}>The library did not load.</div>}
      {open && err && <div className='skill-lib-err'>{err}</div>}

      {open && rows?.length > 0 && (
        <div className='skill-lib-search'>
          <input
            className='text-input'
            placeholder={`Search ${rows.length} skills…`}
            value={q}
            onChange={e => setQ(e.target.value)}
          />
          {needle && <span className='skill-lib-count'>{hits.length} match{hits.length === 1 ? '' : 'es'}</span>}
          {needle && <button className='small-btn' onClick={() => setQ('')}>Clear</button>}
        </div>
      )}
      {open && needle && !hits.length && <div className='activity-empty' style={{ margin: '8px 12px' }}>Nothing matches “{q}”.</div>}

      {open && groups.map(g => {
        const shown = needle || openCat === g.name
        return (
        <div key={g.name} className='skill-lib-group'>
          <button className='skill-lib-cat' onClick={() => setOpenCat(c => c === g.name ? null : g.name)}>
            <span className='skill-lib-chev'>{shown ? '▾' : '▸'}</span>
            {g.name}
            <span className='skill-lib-catcount'>{g.rows.length}</span>
          </button>
          {shown && g.rows.map(r => (
            <div key={r.dir} className='skill-lib-row'>
              <div className='skill-main'>
                <div className='skill-name'>{r.title}</div>
                <div className='skill-body'>{r.blurb}</div>
              </div>
              <button className='small-btn' onClick={() => read(r.dir)}>
                {reading?.dir === r.dir ? 'Hide' : 'Read it'}
              </button>
              {r.installed
                ? <span className='key-ok' title='Already in your skills'>✓ Added</span>
                : <button className='small-btn primary' disabled={busy === r.dir} onClick={() => install(r.dir)}>
                    {busy === r.dir ? 'Adding…' : 'Add'}
                  </button>}
              {reading?.dir === r.dir && (
                <div className='skill-lib-doc'>
                  {reading.loading
                    ? <div className='activity-empty'>Loading…</div>
                    : <>
                        <div className='skill-lib-meta'>
                          {Math.round((reading.doc || '').length / 1024)} KB
                          {reading.files?.length ? ` · also ${reading.files.map(f => f.name).join(', ')}` : ''}
                          {r.origin ? ` · from ${r.origin}, ${r.license}` : ''}
                        </div>
                        <pre className='sug-preview'>{reading.doc}</pre>
                      </>}
                </div>
              )}
            </div>
          ))}
        </div>
        )
      })}
    </div>
  )
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
  const [upload, setUpload] = useState(null)   // { kind: 'err' | 'ok', text }

  const acceptSuggestion = async id => onConfigChange(await api.acceptSkillSuggestion(id))
  const rejectSuggestion = async id => onConfigChange(await api.rejectSkillSuggestion(id))
  const toggle = async (id, enabled) => onConfigChange(await api.updateSkill(id, { enabled }))
  const remove = async id => { if (window.confirm('Delete this skill?')) onConfigChange(await api.deleteSkill(id)) }
  // ⚠️ FORTY-FIVE SKILLS IN ONE FLAT LIST. Tony: "my skills list is already
  // starting to grow. we should have a category selector in the skills
  // settings." Each skill carries a category — guessed from its name and
  // description until the person sets one here, after which the setting wins.
  const [cat, setCat] = useState('All')
  const setCategory = async (id, category) => onConfigChange(await api.updateSkill(id, { category }))
  const counts = {}
  for (const sk of skills) counts[sk.category || 'Other'] = (counts[sk.category || 'Other'] || 0) + 1
  const shown = (cat === 'All' ? skills : skills.filter(sk => (sk.category || 'Other') === cat)).slice().sort((a, b) => a.name.localeCompare(b.name))
  const add = async () => {
    if (!name.trim() || !content.trim()) return
    const cfg = await api.addSkill({ name: name.trim(), content: content.trim() })
    setName(''); setContent(''); setAdding(false)
    onConfigChange(cfg)
  }

  /**
   * Upload a skill FOLDER — a SKILL.md with its supporting files beside it.
   *
   * The one-file drop zone below cannot express this shape, and folder skills
   * are most of what exists: a skill that says "see references/checklist.md"
   * is useless without the folder. Goes through the native picker because the
   * server needs a real path, and a browser file input never gives one.
   *
   * ⚠️ A REFUSAL MUST NAME THE FILE AND THE FIX. The server rejects a folder
   * holding anything runnable; saying only "that didn't work" would be rule 12
   * all over again.
   */
  const uploadFolder = async () => {
    setUpload(null)
    if (!window.radiantNative?.pickFolder) {
      setUpload({ kind: 'err', text: 'Uploading a folder needs the Radiant app — the browser cannot see a folder path.' })
      return
    }
    const picked = await window.radiantNative.pickFolder(null, 'Choose a skill folder')
    if (!picked) return
    setUpload({ kind: 'ok', text: 'Reading…' })
    try {
      const cfg = await api.importSkillFolder(picked)
      onConfigChange(cfg)
      setUpload({ kind: 'ok', text: 'Added. Turn it on above to use it everywhere, or pick it inside one agent.' })
    } catch (e) {
      const raw = String(e?.message || e)
      let text = 'That folder could not be added.'
      if (/executable_files/.test(raw)) {
        const named = (raw.match(/"files":\[([^\]]*)\]/) || [])[1]?.replace(/"/g, '') || ''
        text = `Not added: ${named || 'a file in there'} could be run. A skill is only ever read, so remove ${named ? 'it' : 'any scripts'} and upload the folder again.`
      } else if (/no_skill_md/.test(raw)) {
        text = 'Not added: that folder has no SKILL.md. Pick the folder that contains it, not the one above it.'
      } else if (/not_a_folder|not_found/.test(raw)) {
        text = 'Not added: that is not a folder Radiant can read.'
      }
      setUpload({ kind: 'err', text })
    }
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

      <SkillLibrary onConfigChange={onConfigChange} />

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

      {/* ⚠️ THE THREE WAYS TO ADD A SKILL BELONG TOGETHER. "New skill" used to
          sit at the very bottom, under the whole list, so the ways in were
          split by everything already added. Tony: "the new skill button should
          be next to the uploads skill button instead of the bottom." */}
      <div className='skill-upload'>
        <button className='small-btn primary' onClick={() => setAdding(a => !a)}>+ New skill</button>
        <button className='small-btn' onClick={uploadFolder}>Upload a skill folder…</button>
        <span className='skill-upload-hint'>A folder with a <span className='mono'>SKILL.md</span> inside, plus any notes or references it refers to. Anything runnable is refused.</span>
      </div>
      {upload && <div className={'skill-upload-msg' + (upload.kind === 'err' ? ' is-err' : '')}>{upload.text}</div>}
      {adding && (
        <div className='skill-add'>
          <input className='text-input' style={{ fontFamily: 'inherit', marginBottom: 8 }} placeholder='Skill name (e.g. House style)' value={name} onChange={e => setName(e.target.value)} />
          <textarea className='text-input' style={{ fontFamily: 'inherit', minHeight: 90, resize: 'vertical' }} placeholder='Instructions the agent should follow…' value={content} onChange={e => setContent(e.target.value)} />
          <div className='row' style={{ marginTop: 8 }}>
            <button className='small-btn primary' onClick={add} disabled={!name.trim() || !content.trim()}>Add skill</button>
            <button className='small-btn' onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}

      {skills.length > 0 && (
        <div className='cat-chips' role='tablist' aria-label='Skill categories'>
          {['All', ...SKILL_CATEGORIES.filter(c => counts[c])].map(c => (
            <button key={c} role='tab' aria-selected={cat === c} className={'cat-chip' + (cat === c ? ' is-on' : '')} onClick={() => setCat(c)}>
              {c} <span className='cat-count'>{c === 'All' ? skills.length : counts[c]}</span>
            </button>
          ))}
        </div>
      )}
      {skills.length > 0 && <div className='skill-list-head'>On for all agents</div>}
      {shown.map(sk => (
        <div key={sk.id} className='skill-row'>
          <label className='skill-toggle' title='On for every agent and session'>
            <input type='checkbox' checked={Boolean(sk.enabled)} onChange={e => toggle(sk.id, e.target.checked)} />
          </label>
          <div className='skill-main'>
            <div className='skill-name'>{sk.name}</div>
            <div className='skill-body'>{sk.description || sk.content}</div>
          </div>
          {/* the guess is shown faint until the person confirms or changes it */}
          <select className={'cat-select' + (sk.categoryGuessed ? ' is-guess' : '')} value={sk.category || 'Other'} onChange={e => setCategory(sk.id, e.target.value)} title={sk.categoryGuessed ? 'Category (guessed — pick to confirm)' : 'Category'}>
            {SKILL_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <button className='small-btn danger' onClick={() => remove(sk.id)} title='Delete skill'>✕</button>
        </div>
      ))}
      {!skills.length && <div className='activity-empty' style={{ marginTop: 8 }}>No skills yet.</div>}
      {skills.length > 0 && !shown.length && <div className='activity-empty' style={{ marginTop: 8 }}>No skills in {cat}.</div>}

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
      // ⚠️ KEEP THE WHOLE COLOUR, NOT JUST ITS HUE. customHue/customChroma stay for
      // everything that derives from the accent's hue; customAccentHex is what the
      // accent itself is built from, lightness included, so white gives white and
      // not a mid-tone version of white's hue.
      preview({
        themeId: 'custom',
        customAccentHex: hex,
        customHue: Math.round(H),
        customChroma: Math.min(0.25, Math.max(0.02, +C.toFixed(3)))
      })
  }
  // Live contrast reading for the custom background/text pair, so the warning is
  // about the colours actually on screen rather than the ones last saved.
  const custom = s.customBg && s.customFg
    ? paletteWarnings({ bg: s.customBg, fg: s.customFg, contrast: s.uiContrast ?? 100 })
    : null
  // The swatch shows what will actually render, so a clamped pick looks like what
  // it becomes rather than what was asked for.
  const accentPreview = s.themeId === 'custom' && s.customAccentHex
    ? deriveAccent({ hex: s.customAccentHex, mode: s.mode || 'dark' })
    : null
  const currentAccentHex = accentPreview ? accentPreview.vars['--accent'] : accentHex(
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
            // ⚠️ A THEME IS A WHOLE LOOK. With a custom background set, a theme
            // chip changed only the accent — the sage stayed sage under Ember,
            // Nord, everything — and read as the theme not changing at all.
            // Tony: "now the fucking theme isnt changing". Picking a theme now
            // clears the custom background; the block below says it overrides
            // the theme, so setting one again is a choice made knowingly.
            onClick={() => preview({ themeId: t.id, bgTint: t.tint, customBg: null, customFg: null })}
          >
            {/* ⚠️ SHOW THE THEME'S ACTUAL COLOUR. The dot was always derived from
                hue and chroma, which is right for the themes that derive
                everything — but Nous Classic pins its palette, so its swatch
                rendered as a generic blue indistinguishable from Nord and
                Tokyo Night, in a grid where you find a theme by its colour.
                A pinned theme shows its real accent over its real ground. */}
            <span
              className='dot'
              style={t.vars
                ? { background: t.vars.dark['--accent'], boxShadow: `0 0 0 3px ${t.vars.dark['--bg']}` }
                : { background: accentHex(t.hue, t.chroma) }}
            />
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
          {/* ⚠️ AN UNLABELLED SLIDER BESIDE A COLOUR SWATCH READS AS A STRAY BAR.
              It sets the accent's vividness, and nothing on screen said so. */}
          {isCustom && (
            <label style={{ fontSize: 11.5, color: 'var(--text-faint)', flexShrink: 0 }}>Vividness</label>
          )}
        {isCustom && (
          <input
            type='range' min='0' max='0.25' step='0.005' className='chroma-slider' style={{ flex: 1 }}
            value={s.customChroma ?? 0.11}
            onChange={e => preview({ customChroma: Number(e.target.value) })}
            title='Accent vividness'
          />
        )}
      </div>

      {/* ⚠️ BACKGROUND TINT IS NOT A BACKGROUND COLOUR, which is why both exist.
          The slider below moves the background along the ACCENT's hue — a bluer or
          greyer version of one colour. Tony, sending a screenshot of Codex: "the
          slider is just a variation of main color. gpt lets you pick specific
          colors for background and foreground." Two independent colours is a
          different control, so it is a different control. */}
      <div className='sub-label'>Background &amp; text</div>
      <div className='accent-picker'>
        <label className='color-well pair' style={{ background: s.customBg || 'var(--bg)' }}>
          <input type='color' value={s.customBg || '#141517'}
            onChange={e => preview({ customBg: e.target.value, customFg: s.customFg || '#F2F4F8' })} />
        </label>
        <label className='color-well pair' style={{ background: s.customFg || 'var(--text)' }}>
          <input type='color' value={s.customFg || '#F2F4F8'}
            onChange={e => preview({ customFg: e.target.value, customBg: s.customBg || '#141517' })} />
        </label>
        <div className='accent-picker-text'>
          <div className='mono' style={{ fontSize: 12 }}>
            {s.customBg ? `${s.customBg} · ${s.customFg}` : 'using the theme'}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
            {custom
              ? `Overrides the theme's background · ${custom.ratio.toFixed(1)}:1 · picking a theme clears it`
              : 'Pick a background and a text color to override the theme\u2019s'}
          </div>
        </div>
        {s.customBg && (
          <button className='small-btn' onClick={() => preview({ customBg: null, customFg: null })}>Clear</button>
        )}
      </div>
      {/* ⚠️ WARN, NEVER OVERRULE. A picker that silently changes the colour you
          chose is worse than one that tells you the truth about it — you would
          never work out why the hex came back different. */}
      {custom && custom.warnings.map(w => (
        <div key={w} className='error-note' style={{ marginTop: 6 }}>⚠ {w}</div>
      ))}

      {s.customBg && (
        <>
          <div className='sub-label'>Contrast</div>
          <div className='hue-row'>
            <label htmlFor='uicontrast'>Separation</label>
            <input
              id='uicontrast' type='range' min='40' max='160' step='5' className='tint-slider'
              value={s.uiContrast != null ? s.uiContrast : 100}
              onChange={e => preview({ uiContrast: Number(e.target.value) })}
            />
            <span style={{ fontSize: 11.5, color: 'var(--text-faint)', width: 88 }}>
              {s.uiContrast != null ? s.uiContrast : 100}
            </span>
          </div>
        </>
      )}

      {/* ⚠️ MUTUALLY EXCLUSIVE WITH THE CUSTOM BACKGROUND ABOVE, so only ever one
          on screen. This slider tints the background along the ACCENT's hue; once
          an explicit background colour is set it does nothing at all, and a dead
          slider sitting beside a live one that looks identical is what made this
          screen unreadable. Tony: "this screen is now a convoluted mess." */}
      {!s.customBg && (<>
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
      </>)}

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
          <strong>Auto</strong> runs safe commands (ls, grep, tests, git status…) silently and only asks before risky ones — deletes, sudo, network fetches, pushes, chmod. With an OpenRouter key, a quick decision model also reads each “safe” command in context and pauses it if it could destroy data, send private data out, or change the machine — the card says why. MCP tools and computer-control actions always ask in Auto, no matter how safe — only <strong>Never ask</strong> skips those too.
        </div>
      </div>
      <div style={{ margin: '14px 0 4px' }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>Sandbox commands</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 8px' }}>A fence macOS enforces around every command the agent runs, and everything those commands start.</div>
        <div className='seg-control'>
          {[['off', 'Off'], ['workspace', 'Project folder only'], ['offline', 'Project folder, no internet']].map(([id, label]) => (
            <button key={id} className={'seg-btn' + ((s.sandbox || 'off') === id ? ' on' : '')} onClick={() => onSettings({ sandbox: id })}>{label}</button>
          ))}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 6 }}>
          <strong>Project folder only</strong> lets commands write inside the chat's project folder, temporary files and package caches, and nowhere else — not your other projects, not your settings files. <strong>No internet</strong> also blocks the web, while local servers keep working. A blocked command says so, and the agent is told to ask you rather than try again. Installing things globally (Homebrew, <code>npm -g</code>) needs it off.
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
      <label className='check-row'>
        <input
          type='checkbox'
          checked={s.promptCaching !== false}
          onChange={e => onSettings({ promptCaching: e.target.checked })}
        />
        <span>Prompt caching (Claude models) <span className='desc'>— reuse the unchanged part of the system prompt across turns instead of resending it in full. Turn off if a custom Anthropic-compatible endpoint rejects it.</span></span>
      </label>
      {s.promptCaching !== false && (
        <div style={{ marginLeft: 24, marginTop: -4, marginBottom: 4 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Cache lifetime — match it to how quickly you usually reply</div>
          <div className='seg-control'>
            {[['5m', '5 minutes (default)'], ['1h', '1 hour (costs more per write, survives longer gaps)']].map(([id, label]) => (
              <button key={id} className={'seg-btn' + ((s.cacheTtl === '1h' ? '1h' : '5m') === id ? ' on' : '')} onClick={() => onSettings({ cacheTtl: id })}>{label}</button>
            ))}
          </div>
        </div>
      )}
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
      <h3 style={{ marginTop: 22 }}>Desktop control</h3>
      <p className='hint' style={{ marginTop: 2 }}>
        The agent can drive your desktop — clicking, typing and opening apps. Switch it on for a
        chat with the <strong>computer</strong> button in the composer, and use a model that can
        see: Claude, GPT-4o, or a local vision model. Chrome has its own pane — <b>Settings → Chrome</b>.
      </p>

      <div className='set-block'>
        <div className='set-block-title'>What works on {config?.serverHost || `this ${deviceNoun(config?.platform)}`}</div>
        {/* ⚠️ OFF A MAC THERE IS NOTHING TO GRANT, SO THERE IS NOTHING TO ASK FOR.
              Screen Recording and Accessibility are macOS permissions reached
              through a Swift helper that only builds and only runs there. Both
              come back false on any other platform, which read here as two
              permissions the user had neglected — under advice to open a System
              Settings pane their machine does not have. Say the true thing once
              and point at the half that does work. */}
        {comp?.platform && comp.platform !== 'darwin' ? (
          <div className='comp-stat'>
            <span className={comp.accessibility && comp.screenRecording ? 'key-ok' : 'fit-badge fit-no'}>
              {comp.accessibility && comp.screenRecording ? '✓' : '—'} Desktop control
            </span>
            {/* ⚠️ NAME WHAT IS ACTUALLY IN THE WAY. There are two different
                problems here and only one of them can be fixed: a missing
                package is an apt install away, and a Wayland session is not —
                it refuses synthetic input by design, so telling someone to
                install something would send them after a fix that does not
                exist. The helper reports which it is. */}
            <span className='desc'>
              {comp.reason === 'wayland'
                ? 'this is a Wayland session, which refuses one app typing into another by design. Log in with the X11 (Xorg) session to use it. Browser control above works either way.'
                : comp.reason === 'missing:xdotool' ? 'install xdotool (apt install xdotool) and reopen this pane.'
                  : comp.reason === 'missing:imagemagick' ? 'install ImageMagick (apt install imagemagick) and reopen this pane.'
                    : comp.reason?.startsWith('missing:') ? 'install xdotool and ImageMagick (apt install xdotool imagemagick) and reopen this pane.'
                      : comp.accessibility && comp.screenRecording ? 'the agent can see the screen, click and type.'
                        : 'not available — the helper for this platform did not answer.'}
            </span>
          </div>
        ) : (<>
          {/* ⚠️ NAME THE PERMISSION THAT IS MISSING. This said "Screen Recording and
              Accessibility are granted — ready to use" whenever the helper binary
              existed on disk, which it always does — so it claimed both while
              screencapture returned a wallpaper-only image and clicks went nowhere,
              and nobody could tell which of the two was wrong. */}
          <div className='comp-stat'>
            <span className={comp?.screenRecording ? 'key-ok' : 'fit-badge fit-no'}>
              {comp?.screenRecording ? '✓' : '—'} Screen Recording
            </span>
            <span className='desc'>
              {comp?.screenRecording === null ? 'cannot tell — the helper in this build is older than the check.'
                : comp?.screenRecording ? 'the agent can see the screen.'
                  : 'not granted — screenshots come back showing only your wallpaper.'}
            </span>
          </div>
          <div className='comp-stat'>
            <span className={comp?.accessibility ? 'key-ok' : 'fit-badge fit-no'}>
              {comp?.accessibility ? '✓' : '—'} Accessibility
            </span>
            <span className='desc'>
              {comp?.accessibility === null ? 'cannot tell — the helper in this build is older than the check.'
                : comp?.accessibility ? 'the agent can click and type.'
                  : 'not granted — clicks and keystrokes are silently discarded.'}
            </span>
          </div>
          {comp && (!comp.screenRecording || !comp.accessibility) && (
            <div className='spec-note'>
              Add <strong>Radiant</strong> under System Settings → Privacy &amp; Security →{' '}
              {!comp.screenRecording && <strong>Screen Recording</strong>}
              {!comp.screenRecording && !comp.accessibility && ' and '}
              {!comp.accessibility && <strong>Accessibility</strong>}
              , then quit and reopen Radiant — macOS only re-reads these at launch.
              Browser control needs neither.
            </div>
          )}
        </>)}
      </div>

      <div className='set-block'>
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
              Clicks, types and opens apps without asking — on {config?.serverHost || 'this Mac'}, the machine running Radiant, which may not be the one you are looking at. The agent can do anything there that you
              could, including things that cannot be undone. Use it only with models and tasks you trust.
            </span>
          </span>
        </label>
      </div>
    </div>
  )
}

// ---------- Chrome ----------

/**
 * ⚠️ THE CHROME INSTALL WAS THE SECOND-TO-LAST TAB, UNDER A HEADING ABOUT
 * SOMETHING ELSE. The store button lived in Automation, below the shell-approval
 * setting, under "Computer control" — three guesses deep for someone who just
 * wants the agent in their browser. Tony: "should it be a separate section in
 * settings?" It is now: one tab, the extension first, the fallback second, and
 * nothing else.
 */
function ChromePane () {
  return (
    <div className='set-section'>
      <h3>Chrome</h3>
      <p className='hint' style={{ marginTop: 2 }}>
        The agent can work inside a browser — read the page you are on, click, type and take
        screenshots. Switch it on for a chat with the <strong>computer</strong> button in the
        composer, and use a model that can see: Claude, GPT-4o, or a local vision model.
      </p>

      {/* ⚠️ WHOSE CHROME IS BEING DRIVEN. Radiant always launched a fresh one — no
          extensions, no tabs, signed in to nothing — so an agent asked to look at an
          open page saw an empty stranger's browser and, having no better
          explanation, blamed macOS permissions. Tony: "the agent is saying it cant
          control my active chrome because of settings but Radiant has access in
          privacy and disk access." It never was permissions. */}
      {/* No separate status block: each block above already says whether its
          Chrome is connected, and "Browser control ✓" used to mean only that
          playwright-core loaded — true on every install, so it never told anyone
          anything. */}
      <ChromeAttachBlock />
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

  // ⚠️ ASK WHAT WAS MISSED, THEN LISTEN. Events only reach a window that is open
  // when they fire, and this pane lives in the Settings window, which is opened and
  // closed constantly. Without this, a finished download showed "Download & install"
  // again and pressing it fetched the same 163 MB a second time.
  useEffect(() => {
    if (!native?.state) return
    native.state().then(st => {
      if (!st) return
      if (st.phase === 'downloading') { setPhase('downloading'); setProgress(st.percent || 0) }
      else if (st.phase === 'ready') { setPhase('ready'); setProgress(100) }
    }).catch(() => {})
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
        else setStatus({ hasUpdate: r.hasUpdate, latest: r.version, current: r.current, blocked: r.blocked || null })
      } else {
        const r = await api.updateCheck()
        setStatus({ hasUpdate: r.hasUpdate, latest: r.latest, current: r.current, downloadUrl: r.downloadUrl })
      }
    } catch (e) { setStatus({ error: e.message }) }
    setChecking(false)
  }

  const startDownload = () => { setPhase('downloading'); setProgress(0); native.download() }
  const restart = () => native.install()
  const relaunch = () => native.relaunch()
  const openReleasePage = () => window.open(status?.downloadUrl || 'https://github.com/templetongroup/radiant/releases/latest', '_blank', 'noopener')

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

      {/* A copy that cannot replace itself says so, above everything else the
          pane might say about versions — see installLocation() in updater.cjs. */}
      {status?.blocked && <div className='error-note' style={{ marginTop: 10 }}>⚠ {status.blocked}</div>}
      {status && !status.error && !status.blocked && (
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
              iCloud Drive finished setting up, and iCloud never adopted it. Radiant can fix
              that here: it stands up a fresh folder in the same place, copies your setup into
              it, and keeps the old one alongside.
              {/* ⚠️ A BUTTON, NOT AN INSTRUCTION. This used to say to press “Choose another
                  folder…” and pick iCloud Drive — which would have copied config.json,
                  projects/ and sessions/ into the TOP LEVEL of his iCloud Drive, because that
                  handler uses whatever folder you pick. Rules 9 and 12: the app repairs
                  itself, and no sentence without a button. */}
              <div className='data-folder-row' style={{ marginTop: 12 }}>
                <button className='btn-secondary' disabled={busy} onClick={async () => {
                  setBusy(true); setMsg(null)
                  try {
                    const r = await api.repairCloudFolder()
                    setInfo(r)
                    setMsg({ kind: 'ok', text: `${r.message} Quit and reopen Radiant.` })
                  } catch (e) {
                    let text = 'The repair did not run, and nothing was changed.'
                    try { text = JSON.parse(String(e.message).replace(/^[^{]*/, '')).message || text } catch {}
                    setMsg({ kind: 'err', text })
                  }
                  setBusy(false)
                }}>{busy ? 'Repairing…' : 'Fix this folder'}</button>
              </div></>
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

function ChromeAttachBlock () {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const load = () => api.browserStatus().then(setSt).catch(() => {})
  useEffect(() => {
    load()
    // ⚠️ IT HAS TO KEEP LOOKING. Chrome can be started or quit outside Radiant, and
    // the first version read this once on mount — so the panel went on insisting
    // nothing was connected long after it was.
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [])

  const enable = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await api.browserEnable()
      if (!r?.ok) setErr('Chrome opened but did not accept control. Quit that window and try again.')
      await load()
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  const on = Boolean(st?.reachable)
  return (
    <>
    <BrowserBridgeBlock />
    <div className='set-block'>
      <div className='set-block-title'>If you would rather not install the extension</div>
      <div className='comp-stat'>
        <span className={on ? 'key-ok' : 'fit-badge fit-tight'}>
          {on ? '✓ A Chrome it can drive' : '— None yet'}
        </span>
        {on && st.reachable.browser && <span className='desc'>{st.reachable.browser}</span>}
      </div>
      <p className='hint'>
        {on
          ? <>The agent works in that window — your tabs there, and whatever you are signed
              into in it. Sign in to a site once and it stays signed in.</>
          : <>Chrome only accepts being driven when it is started with its own separate profile:
              since version 136 it silently ignores the setting on your everyday one. So this opens
              a <b>second</b> Chrome window with a profile of its own and leaves your normal Chrome
              alone. Sign in to what the agent needs once, in that window, and it is remembered.</>}
      </p>
      <div className='row'>
        <button className='small-btn primary' onClick={enable} disabled={busy || !st?.installed}>
          {busy ? 'Opening Chrome…' : on ? 'Open it again' : "Open the agent's Chrome"}
        </button>
      </div>
      {st && !st.installed && <div className='error-note'>⚠ Google Chrome is not installed.</div>}
      {err && <div className='error-note'>⚠ {err}</div>}
    </div>
    </>
  )
}

/**
 * Installing the browser bridge.
 *
 * ⚠️ IT IS ONE CLICK NOW, AND THIS PANE WAS STILL TEACHING FIVE. The extension is
 * on the Chrome Web Store (published 2026-09-10), so the install is the store's
 * own Add-to-Chrome button. But for weeks after that this block went on walking
 * people through chrome://extensions, Developer mode, Load unpacked and a folder
 * path — the sideload, which was the only way in before the listing existed and
 * is the worst possible first impression after it. The store button is the
 * whole pane now; the folder route survives, folded away, for anyone running
 * Radiant from source with a build newer than the store's.
 *
 * ⚠️ CHROME WILL NOT LET RADIANT DO THE CLICK. Chrome 137 removed
 * --load-extension, and the store's Add button is a person clicking, by design —
 * the distinction Google drew after the flag was used to sideload malware. So
 * "one click" means opening the listing, and the click is theirs.
 */
function BrowserBridgeBlock () {
  const [st, setSt] = useState(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const load = () => api.browserExtension().then(setSt).catch(() => {})
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [])
  const copy = () => {
    try { navigator.clipboard?.writeText(st?.dir || '') ; setCopied(true); setTimeout(() => setCopied(false), 1600) } catch {}
  }
  const on = Boolean(st?.connected)
  // ⚠️ RADIANT CANNOT SEE INSIDE CHROME. All it knows is whether the extension is
  // talking to it right now — so this said "Not installed yet" to Tony minutes after
  // he installed it from the store, and he read it as the app asking him to install
  // it again. Three states now, each only claiming what is actually known: connected;
  // was connected earlier (so it is installed — Chrome is closed, or a different
  // profile is in front); nothing has connected since Radiant started.
  const seen = !on && st?.lastSeenAt ? new Date(st.lastSeenAt) : null
  const seenAt = seen ? seen.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
  return (
    <div className='set-block'>
      <div className='set-block-title'>The Chrome you are already signed into</div>
      <div className='comp-stat'>
        <span className={on ? 'key-ok' : 'fit-badge fit-tight'}>
          {on ? '✓ Connected' : '— Not connected'}
        </span>
        <span className='desc'>
          {on
            ? `the agent can see your tabs, read the page you are on, click, type and screenshot it${st?.version ? ` · extension ${st.version}` : ''}`
            : seen
              ? `it was connected at ${seenAt}${st?.version ? ` (extension ${st.version})` : ''}`
              : 'nothing has connected since Radiant started'}
        </span>
      </div>
      <p className='hint'>
        {on
          ? <>The agent works in your own browser now — the tabs you have open, signed in as you.
              Nothing is sent anywhere: the extension talks only to Radiant on this Mac.</>
          : seen
            ? <>So it is installed. Chrome is probably closed, or the extension is switched off in the
                profile you are using — it reconnects on its own within half a minute of Chrome opening.
                Nothing to install again.</>
            : <>If you have already installed it, open Chrome: it finds Radiant on its own within half a
                minute. Otherwise, Chrome no longer lets any app connect to your everyday browser, so
                the extension is the way in. It runs inside Chrome with your session and talks only to
                Radiant on this Mac.</>}
      </p>
      {!on && !seen && (
        <div className='row' style={{ marginTop: 8 }}>
          {/* window.open goes through shell.openExternal in the Electron shell, so
              this lands in the person's real Chrome, signed in, on the listing. */}
          <button className='small-btn primary' onClick={() => window.open(EXTENSION_STORE_URL, '_blank', 'noopener')}>
            Install from the Chrome Web Store
          </button>
          <span className='hint' style={{ margin: 0 }}>Opens the listing — press <b>Add to Chrome</b> there and come back.</span>
        </div>
      )}
      {!on && (
        <details className='hint' style={{ marginTop: 10 }}>
          <summary>Running Radiant from source? Load the folder instead</summary>
          <ol style={{ margin: '6px 0 0 18px', padding: 0 }}>
            <li>Open <span className='mono'>chrome://extensions</span></li>
            <li>Turn on <b>Developer mode</b>, top right</li>
            <li>Click <b>Load unpacked</b></li>
            <li>Press <span className='mono'>⇧⌘G</span>, paste the folder below, and choose it</li>
          </ol>
          <div className='row' style={{ marginTop: 8 }}>
            <code className='mono' style={{ fontSize: 11, opacity: .85, wordBreak: 'break-all' }}>{st?.dir || '…'}</code>
            <button className='small-btn' onClick={copy} disabled={!st?.dir}>{copied ? 'Copied' : 'Copy folder'}</button>
          </div>
        </details>
      )}
    </div>
  )
}

/**
 * The pairing link, as a picture.
 *
 * ⚠️ THIS IMAGE IS THE CREDENTIAL. The link it encodes carries the access token,
 * and the server sets a cookie good for a year — so a photograph of this square
 * is a lasting key to every chat, model and agent on this Mac. It is hidden by
 * default for exactly the reason the token beside it is: someone walking past a
 * screen should not be able to take it, and a screen-share should not give it
 * away.
 *
 * Drawn as SVG rather than a canvas so it stays sharp for a camera held at an
 * angle, and so scaling it needs no second code path.
 */

function QrCode ({ text, size = 168 }) {
  const box = React.useMemo(() => {
    // Type 0 picks the smallest version that fits. 'M' tolerates about 15%
    // damage, the usual choice for a screen: forgiving of a badly held camera,
    // while keeping the modules large enough to read.
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const n = qr.getModuleCount()
    const cells = []
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) cells.push(`M${c} ${r}h1v1h-1z`)
    // A quiet zone of 2 modules. The spec asks 4; the card's own border supplies
    // the rest, and 4 would spend a third of the width on emptiness at this size.
    return { d: cells.join(''), span: n + 4 }
  }, [text])
  return (
    <svg className='qr' width={size} height={size} viewBox={`-2 -2 ${box.span} ${box.span}`}
      role='img' aria-label='Pairing code for your phone'>
      <rect x='-2' y='-2' width={box.span} height={box.span} fill='#fff' />
      <path d={box.d} fill='#000' shapeRendering='crispEdges' />
    </svg>
  )
}

function DevicesPane ({ config }) {
  const [share, setShare] = useState(null)
  // The token is a credential; it starts hidden. See the note beside it.
  const [showToken, setShowToken] = useState(false)
  // The QR is the same secret as the token, so it defaults to hidden too.
  const [showQr, setShowQr] = useState(false)
  const server = getServer()
  const [base, setBase] = useState(server.base || '')
  const [token, setToken] = useState(server.token || '')
  const [msg, setMsg] = useState(null)
  const [hostName, setHostName] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.getShare().then(setShare).catch(() => {}) }, [])
  // ⚠️ THE NAME OF WHICHEVER MAC IS ANSWERING — which IS the other Mac when this
  // window is a client, because publicConfig comes from the server. The screen
  // could not name either machine before, which is most of why it read as
  // abstract: "this Mac" and "another" instead of two things you own.
  useEffect(() => { api.getConfig().then(c => setHostName(c.serverHost || '')).catch(() => {}) }, [])
  // ⚠️ COPY USED TO SAY NOTHING AT ALL. You press it, the label does not change,
  // and the only way to know it worked is to paste somewhere else. <ConfirmButton>
  // owns that now — it is the one action here whose button STAYS after it
  // succeeds, which is what the effect needs. Save does not: saving a key swaps
  // the row for its "key is set" state and saving an agent closes the editor, so
  // a check there would unmount before anyone saw it.
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
      {config?.sharingText && (
        <div className='devices-now' style={{ marginTop: 6 }}>{config.sharingText}</div>
      )}

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
        ⚠️ THIS SCREEN TELLS YOU WHAT IS TRUE BEFORE IT OFFERS YOU A CHOICE.
        It used to open with two headings — "This Mac does the work" and "This Mac
        is a window onto another" — both permanently expanded, both full of hints,
        and neither saying which one you were actually in. Tony: "its my product
        and i dont 100% understand how this works or how my setup is structured."

        So: one sentence naming both machines, then two cards where the one you
        are in is marked Current and is the only one carrying its controls. The
        other card says what switching would do and how to do it. Same shape as
        an onboarding fork, which is what this is — you are in one of two states,
        never both.
      */}
      <div className='dev-setup' style={{ marginTop: 18 }}>
        <div className={'dev-now' + (linked ? ' is-remote' : '')}>
          <span className='dev-now-dot' aria-hidden />
          <div className='dev-now-body'>
            <div className='dev-now-title'>
              {linked
                ? <>Right now this Mac is a <b>window onto {hostName || 'another Mac'}</b></>
                : <>Right now this Mac <b>does the work</b>, on its own</>}
            </div>
            <div className='dev-now-sub'>
              {linked
                ? <>The chats, agents and models you see all live on {hostName || 'that Mac'}. Downloads
                    land there, commands run there, and computer control drives its screen — not this one.
                    Nothing on this Mac is being used or deleted.</>
                : <>Your chats, agents and models live here, and only this Mac uses them. Nothing is
                    shared until you turn it on below.</>}
            </div>
          </div>
        </div>

        <div className='dev-choices'>
          {/* ── A ─────────────────────────────────────────────── */}
          <div className={'dev-card' + (!linked ? ' is-current' : '')}>
            <div className='dev-card-head'>
              <span className='dev-card-ico'><Icon.monitor size={16} /></span>
              <div>
                <div className='dev-card-title'>This Mac does the work</div>
                <div className='dev-card-sub'>Runs the models, keeps the chats. Other Macs can open a window onto it.</div>
              </div>
              {!linked && <span className='dev-badge'>Current</span>}
            </div>

            {linked
              ? <div className='dev-card-body'>
                  <p className='hint' style={{ marginTop: 0 }}>
                    Not this Mac at the moment — {hostName || 'the other Mac'} is doing the work.
                    Disconnect on the right to run everything here again.
                  </p>
                </div>
              : <div className='dev-card-body'>
                  <label className='agent-skill-chk'>
                    <input type='checkbox' checked={Boolean(share?.desired)} onChange={toggleShare} />
                    {' '}Let my other Macs connect to this one
                  </label>
                  {share && share.desired !== share.enabled && (
                    <div className='error-note' style={{ marginTop: 6 }}>
                      Quit and reopen Radiant to {share.desired ? 'start' : 'stop'} sharing.
                    </div>
                  )}
                  {!share?.desired && (
                    <p className='hint' style={{ marginTop: 6 }}>
                      Turn this on for the Mac that stays awake. You will get an address and a
                      token to enter on your other Macs.
                    </p>
                  )}

                  {share?.desired && share?.enabled && share?.token && (() => {
                    const wifi = (share.addresses || []).find(a => a.wifi)
                    const anywhere = share.phone?.ready ? share.phone.url : null
                    const best = anywhere
                      ? { url: anywhere, where: 'Works from anywhere, over Tailscale.' }
                      : wifi
                        ? { url: `${wifi.address}:${share.port}`, where: 'Works while both Macs are on this network.' }
                        : null
                    if (!best) {
                      return <div className='hint' style={{ marginTop: 12 }}>No network address yet — is this Mac on a network?</div>
                    }
                    return (
                      <div style={{ marginTop: 12 }}>
                        <p className='hint' style={{ marginTop: 0 }}>
                          On the other Mac: Settings &rarr; Devices &rarr; <b>Use another Mac&rsquo;s Radiant</b>.
                        </p>
                        <div className='connect-field' style={{ marginTop: 10 }}>Address
                          <div className='row'>
                            <code className='mono'>{best.url}</code>
                            <ConfirmButton className='small-btn' doneLabel='Copied' onClick={() => copy(best.url)}>Copy</ConfirmButton>
                          </div>
                        </div>
                        <div className='connect-field' style={{ marginTop: 8 }}>Access token
                          <div className='row'>
                            {/* ⚠️ A SECRET. It grants access to every model, agent and session
                                here, and it used to sit in plain text where anyone walking
                                past could read it. */}
                            <code className='mono share-token'>{showToken ? share.token : '•'.repeat(24)}</code>
                            <button className='small-btn' onClick={() => setShowToken(v => !v)}>{showToken ? 'Hide' : 'Show'}</button>
                            <ConfirmButton className='small-btn' doneLabel='Copied' onClick={() => copy(share.token)}>Copy</ConfirmButton>
                          </div>
                        </div>
                        <div className='hint' style={{ marginTop: 8 }}>{best.where}</div>

                        {/* ⚠️ THE PHONE NEEDS ONE LINK, NOT AN ADDRESS AND A TOKEN.
                            The server has always accepted `?token=…`: it signs the
                            device in, sets a cookie, and redirects with the token
                            stripped so it never lands in history or a bookmark. The
                            comment at that route describes "Copy phone link → open →
                            Add to Home Screen" as the whole setup — and the link it
                            describes was never rendered anywhere, so nobody could
                            follow it. This is that link, and a code to point a camera
                            at instead of typing it.

                            ⚠️ AND IT IS HIDDEN UNTIL ASKED FOR, because the picture IS
                            the credential — the cookie lasts a year, so a photograph
                            of it is a lasting key. Same reason the token above starts
                            as dots. */}
                        <div className='phone-pair'>
                          {/* ⚠️ THIS IS NOT THE iPHONE APP, AND IT USED TO READ AS IF IT
                              WERE. "Radiant behaves like an app" was written before there
                              was one on the App Store. The App Store app runs on its own,
                              on the phone, and never talks to this Mac; this link is the
                              opposite — your phone's browser using THIS Mac's Radiant, its
                              chats, models and agents. Tony, 2026-09-17: "why is this
                              still on the devices page?" Say which is which. */}
                          <div className='row' style={{ justifyContent: 'space-between' }}>
                            <b>This Mac&rsquo;s Radiant, from your phone&rsquo;s browser</b>
                            <button className='small-btn' onClick={() => setShowQr(v => !v)}>
                              {showQr ? 'Hide code' : 'Show code'}
                            </button>
                          </div>
                          <p className='hint' style={{ marginTop: 6 }}>
                            This is not the iPhone app. The{' '}
                            <a href='https://apps.apple.com/us/app/radiant-local-ai-chat/id6804891721' target='_blank' rel='noreferrer'>Radiant on the App&nbsp;Store</a>
                            {' '}runs models on the phone itself and never talks to this Mac. This link is the
                            other way round: your phone&rsquo;s browser opens the Radiant running <i>here</i> —
                            this Mac&rsquo;s chats, models and agents — so anything you start at your desk you
                            can carry on from the sofa. One link signs the phone in, no address or token to type;
                            Share &rarr; <b>Add to Home Screen</b> keeps it a tap away.
                          </p>
                          {showQr && (
                            <div className='phone-pair-code'>
                              <QrCode text={phoneLink(best.url, share.token)} />
                              <div>
                                <ConfirmButton className='small-btn' doneLabel='Copied'
                                  onClick={() => copy(phoneLink(best.url, share.token))}>Copy phone link</ConfirmButton>
                                <div className='hint' style={{ marginTop: 8, lineHeight: 1.5 }}>
                                  Point your phone&rsquo;s camera at this. It is a key, not just an
                                  address — anyone who photographs it gets in, so do not put it on a
                                  slide or a screen-share.
                                  {anywhere
                                    ? ' It works anywhere your phone can reach Tailscale.'
                                    : ' It only works while your phone is on this same network.'}
                                  {' '}This Mac has to be awake with Radiant running.
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                        {!anywhere && (
                          <div className='hint' style={{ marginTop: 10, lineHeight: 1.5 }}>
                            <b>To reach this Mac from somewhere else, both Macs need Tailscale</b> — a free
                            private network between your own machines, so this Mac is reachable without
                            being exposed to the internet.{' '}
                            <a href='https://tailscale.com/download' target='_blank' rel='noreferrer'>tailscale.com/download</a>
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </div>}
          </div>

          {/* ── B ─────────────────────────────────────────────── */}
          <div className={'dev-card' + (linked ? ' is-current' : '')}>
            <div className='dev-card-head'>
              <span className='dev-card-ico'><Icon.branch size={16} /></span>
              <div>
                <div className='dev-card-title'>Use another Mac&rsquo;s Radiant</div>
                <div className='dev-card-sub'>This Mac becomes a window onto that one. Its chats, its models, its agents.</div>
              </div>
              {linked && <span className='dev-badge'>Current</span>}
            </div>

            <div className='dev-card-body'>
              {linked
                ? <>
                    <div className='dev-linkline'>
                      Connected to <code className='mono'>{server.base}</code>
                      {hostName && <> — <b>{hostName}</b></>}
                    </div>
                    <p className='hint' style={{ marginTop: 6 }}>
                      Everything you do goes to that Mac. Disconnecting brings back this Mac&rsquo;s
                      own chats and models exactly as you left them.
                    </p>
                    <div className='row' style={{ marginTop: 10 }}>
                      <button className='small-btn' onClick={useLocal}>Disconnect &mdash; use this Mac</button>
                    </div>
                  </>
                : <>
                    <p className='hint' style={{ marginTop: 0 }}>
                      Enter the address and token shown on the Mac doing the work. Nothing here is
                      deleted — you can switch back any time.
                    </p>
                    <label className='connect-field' style={{ marginTop: 8 }}>Address
                      <input className='text-input' placeholder='100.x.y.z:5834 or host.local:5834' value={base} onChange={e => setBase(e.target.value)} />
                    </label>
                    <label className='connect-field' style={{ marginTop: 8 }}>Access token
                      <input className='text-input' type='password' placeholder='Token from that Mac' value={token} onChange={e => setToken(e.target.value)} />
                    </label>
                    <div className='row' style={{ marginTop: 10 }}>
                      <button className='small-btn primary' onClick={connect} disabled={busy || !base.trim()}>{busy ? 'Connecting…' : 'Connect & reload'}</button>
                    </div>
                  </>}
              {msg && <div className='error-note' style={{ marginTop: 8 }}>⚠ {msg}</div>}
            </div>
          </div>
        </div>
      </div>
      </div>
  )
}

const GUIDE = [
  {
    title: 'Chat & agents',
    items: [
      ['Models that don\u2019t think no longer fail when a thinking level is set', 'Some models, such as Grok\u2019s \u201cnon-reasoning\u201d ones, refuse any thinking level, and a chat with one used to stop with a red \u201c400 \u2026 does not support parameter reasoningEffort\u201d error. Radiant now drops the level and asks again, in the same turn, and says so in a short note. It remembers which models can\u2019t take one, so the next message goes straight through. Models that do think are unaffected and still get the level you chose.'],
      ['The model keeps its train of thought between steps', 'Models that think before they act \u2014 Claude with a thinking level set, and ChatGPT models through your ChatGPT sign-in \u2014 now get their own earlier reasoning back at every step of a task, so each tool call builds on the plan they already worked out instead of starting over. On Claude this also fixes a failure: with a thinking level set, a task stopped with an error the moment the agent used its first tool.'],
      ['A fence around the agent\u2019s commands', 'Settings \u2192 Automation \u2192 Sandbox commands puts every command the agent runs inside a fence macOS enforces. \u201cProject folder only\u201d lets commands change files only in the chat\u2019s project folder (plus temporary files and package caches) \u2014 not your other projects, not your settings files. \u201cProject folder, no internet\u201d also blocks the web, while local servers keep working. It covers anything those commands start, too. When the fence blocks something, the agent is told so and asks you instead of retrying. It is off unless you turn it on, because installing things for the whole Mac needs it off.'],
      ['A chat that gets too long sets aside, instead of summarizing', 'When a chat grows past what its model can take, Radiant used to replace the earlier conversation with a written summary \u2014 slow, and details were lost for good. Now it first asks Jev which earlier exchanges are about something other than what you are working on now \u2014 a finished side question, a request you moved on from \u2014 and stops sending those to the model. They stay in the chat, where you can still read them; nothing is deleted. Your first request and your most recent work are always kept. Only if that does not free enough room does it summarize, as before. On a real chat full of separate skill installs, this took the conversation from about 155,000 tokens to 88,000.'],
      ['Long chats keep what matters', 'When a chat passes half of what its model can hold, Radiant now asks Jev \u2014 its small, fast decision model \u2014 which earlier tool results the task no longer needs: an off-topic search, a file about something else. Those are set aside to a single line, and so is any result a later, identical call replaced (the same file read again, the same test run again). Everything the task still depends on keeps its place, the full results stay in the chat, and the agent can read one back if it turns out to matter. A note in the chat says how much was set aside. It takes under a second, costs a fraction of a cent, and needs an OpenRouter key; without one, older results are trimmed by age as before.'],
      ['One message, one reply', 'Every message you send now carries its own name, and Radiant refuses a second copy of the same message. If a message arrives twice \u2014 a connection that retried, or the voice assistant handing over the same request again \u2014 the agent runs it once, so the same edits and commands never happen twice. And when a send fails before the reply starts, Radiant now checks whether your message actually got through before telling you it did not send: if it did, it says so and shows what happened, so you do not type it again.'],
      ['Tasks is now a real kanban board', 'Click a card to open it in a two-column view. On the left: the title and description (Markdown works \u2014 lists, bold, code), and one feed of everything that happened to the task, newest first: your comments, each change, and every run the agent made. A run shows which model did it, how long it took, how it ended, the last thing it said, and its worker log \u2014 each tool it used, what it touched and what came back. Filter the feed to just comments, runs or history. On the right: status, who it is assigned to, priority, labels, a due date, and dependencies. \u201cWaits on\u201d makes a task hold until other tasks are Done \u2014 its Start button stays off until then, and when the last one finishes the task says it is ready. \u201cBlocks\u201d shows what is waiting on this one, and both are links you can click to jump between tasks. Comments you leave are read by the agent the next time the task starts, or straight away with \u201cSend your comment to the agent\u201d. Cards on the board now show the priority, labels, due date (red when overdue), whether they are waiting or ready, and how many comments they have.'],
      ['Agents can use the board themselves', 'An agent can now read the board, add tasks, comment, and make one task wait on another. Ask it to \u201csplit this into subtasks\u201d and they appear in Queued, linked in the right order and assigned to the same agent or model; ask it to leave a note and it shows up in the task\u2019s feed as a comment from the agent. New tasks it makes wait for you to start them, and only you can mark a task Done.'],
      ['A stopped task no longer says Working', 'Pressing Stop on a task, or closing the window while it ran, used to leave its card in Working forever with nothing running. It now moves to Needs you with \u201cStopped before it finished\u201d, and its run is marked Stopped. A task that hit an error also stays in Needs you now instead of drifting back to Working.'],
      ['Jev Router: let OpenRouter pick the model for each message', 'With an OpenRouter key, the first model in the OpenRouter list is now Jev Router. Choose it and every message goes to whichever model Jev judges best for it \u2014 a quick question to a fast, cheap one, a hard problem to a strong one \u2014 without you switching models. Each reply is labeled with the model that actually answered, for example \u201ctypesafe/jev-router \u2192 some-model\u201d, so you always know who wrote it. Radiant\u2019s own \u201ceasy messages get a fast answer\u201d routing stays out of the way while Jev Router is chosen, since it already does that job.'],
      ['Delete a chat without archiving it first', 'Every chat row now has a bin to the right of the Archive button, so a chat you know you do not want \u2014 a test, a false start \u2014 can go in one step instead of being archived, found in the archive and deleted there. It works like the bin inside the archive: press and hold it while a red ring fills, and let go early to cancel. It sits right next to Archive, and a delete cannot be undone, so a click that lands a little off does nothing.'],
      ['Stopping keeps what was already written, and one chat runs one reply at a time', 'Pressing Stop while the agent is mid-sentence now keeps the part it had already written \u2014 before, that text showed on screen and then disappeared the next time the chat was opened. And if the same chat gets two messages at the same moment \u2014 say from your phone and your Mac, or a send that was retried \u2014 the second is now turned away with \u201ca turn is already running\u201d instead of both running and one quietly wiping out the other\u2019s whole reply. Three quieter fixes ride along: a graph step whose model stops answering is ended after ten minutes so the rest of the graph can finish (it used to wait forever); signing in with Nous no longer drops you with \u201csession expired\u201d when several things refresh the sign-in at once; and on the iPhone, adding a model from search while the app comes back to the front can no longer lose the model from your list.'],
      ['Steer the agent with a queued message', 'When you type a message while the agent is still working, it waits in a \u201cQueued\u201d strip above the box and sends when the turn finishes. Now each queued message also has a Steer button. Press it and the agent stops what it is doing right away and takes your message as its next instruction \u2014 for when you can see it heading the wrong way and want to redirect it instead of waiting. Leave it alone and it still sends when the turn ends, as before.'],
      ['The Chrome extension connects even when the usual port is busy', 'If another copy of Radiant was already running \u2014 a second window, or the dev build \u2014 the app would start on a spare port picked at random, and the Chrome extension, which only looks for Radiant on a short fixed list of ports, could never find it: Settings said \u201cNot connected\u201d no matter how many times you reinstalled, and the agent quietly used its own browser instead. The app now falls back only to ports the extension actually checks, so the extension finds it. If you have hit this, quit Radiant fully and reopen it once; the extension reconnects within about half a minute.'],
      ['The sidebar folders use the same open/close chevron as the menus', 'The project, chat and archive folders in the sidebar showed a little \u25b8/\u25be text arrow to open and close. They now use the same chevron icon the Tools menu and the drop-downs use \u2014 it points down when open and turns to point right when closed \u2014 so the whole app opens and closes things with one consistent control.'],
      ['Your branch\u2019s pull request, above the message box', 'When a chat is working in a GitHub repo on a branch that has a pull request, a small row now appears above the message box: the PR number, whether it is mergeable, how many lines it changes, and whether its checks passed \u2014 refreshed on its own and when you come back to the window. Click the number to open the PR, or open the checks to see each one and jump to its logs. On a branch with no PR yet, it offers Create PR, which opens GitHub\u2019s page for you to submit. Radiant only reads \u2014 it never pushes, opens, or merges anything itself. It needs the GitHub CLI (gh) signed in, and it stays hidden on the main branch or outside a GitHub repo.'],
      ['Radiant follows a project\u2019s own rules file', 'If a chat is working in a folder that has an AGENTS.md, CLAUDE.md, .clinerules or .cursorrules \u2014 the standing instructions many projects keep for coding agents \u2014 Radiant now loads it and the agent follows those conventions without you repeating them. It looks in the folder and up at the repository root, and the chat tells you once which file it loaded. This is how other coding tools work; Radiant did not, so an agent building in a real repo missed the project\u2019s own guidance. Turn it off under Settings \u2192 Models \u2192 Background work if you\u2019d rather it ignore those files.'],
      ['The buttons under the message box line up', 'The toggle buttons on the right of the composer (computer, plan, thinking, permissions) had slightly smaller icons and sat a hair taller than Attach, Skills and Dictate beside them, so the row looked uneven. They are all the same size now.'],
      ['Long builds run to completion instead of stopping every so often', 'Radiant used to cut a turn off after a fixed number of tool steps, which meant building a whole app kept hitting a wall that looked like an error \u2014 you had to press Continue over and over. That is gone. A turn now runs until the work is actually done. The only limit is a spend budget you set (Settings \u2192 Models \u2192 Long builds), and it is measured by real cost \u2014 the tokens that actually cost money, not the raw total. A long turn re-reads the conversation from cache every step, and cache reads barely count, so an ordinary build finishes without ever pausing; the turn only stops to ask if it runs up genuine spend. And if it genuinely gets stuck \u2014 commands that keep failing \u2014 it stops early and tells you what is broken, rather than grinding to the budget.'],
      ['A turn that keeps hitting the same wall now stops early instead of burning through your usage', 'If an agent gets stuck on something a command cannot fix \u2014 a broken build, a package version mismatch, a missing tool \u2014 it used to keep trying variation after variation, sometimes for a very long time, because each attempt looked a little different from the last. Radiant now watches how the recent commands are going, and when almost all of them are failing it stops the turn, tells you it was stuck (usually a broken build or a version clash), and points you at the last error. It gives the agent one reminder to step back first, and it never stops a turn where commands are actually succeeding. Everything so far is saved, and Continue picks it up once you have told it the fix.'],
      ['Your answer to an agent\u2019s question now looks like yours', 'When an agent pauses to ask you something, your reply used to appear inline in the agent\u2019s own column, which made it read like the agent talking to itself. Your answer now shows in the same right-aligned bubble as a message you type, and the agent\u2019s question is labelled \u201cRadiant asked\u201d above it \u2014 so your voice always looks like your voice, wherever it appears.'],
      ['A false “iCloud isn\u2019t syncing” warning is gone, and the lock stops leaving junk behind', 'If you run Radiant on more than one Mac against an iCloud folder, you may have seen \u201ciCloud reported an error uploading this folder \u2014 your setup is not reaching your other Macs.\u201d In most cases that was a false alarm: it was set off by Radiant\u2019s own \u201cwho\u2019s using this folder\u201d marker, a tiny file it rewrites every few seconds, which iCloud is always in the middle of uploading. Your actual chats and settings were syncing fine. The warning now looks at your real data, so it only appears when something that matters is genuinely stuck. Radiant also used to share one marker file across all your Macs, which iCloud could not merge and kept forking into copies (\u201c\u2026 2.json\u201d, \u201c\u2026 3.json\u201d); each Mac now keeps its own, and Radiant clears out the old copies on startup.'],
      ['Task, Loop and Graph now live under one Tools menu, and the tabs have icons', 'The sidebar had five tabs across the top. The three that start a background run — Task, Loop and Graph — are now one compact Tools menu instead, sitting just to the right of Chat and Agents on the same row. Open it and pick one, with an icon beside each; the menu is the same drop-down the right-hand panel uses. While one is running its section, the Tools button shows that tool’s name and turns green, so you can still see where you are at a glance. Chat and Agents stay where they were, each now with a small icon beside its name. And when you make the sidebar narrow, the three tabs drop to just their icons instead of crowding — hover any of them for the name.'],
      ['An edit can carry its own check, and big results are kept instead of re-sent', 'Two changes taken from a study of what makes coding agents waste tokens (SoL-Pi, NVIDIA and MIT, 2026).\n\nWhen the agent edits a file and already knows the command it will run next \u2014 the tests, the build \u2014 it can now attach that command to the edit, and both results come back together. That saves a whole round trip to the model for the most common pair of actions there is, and in the study it was the change that most improved results on Opus, not only cost: fewer rounds, less drift. The approval card shows the command with the edit, and it only runs if the edit succeeded. The card also now says what it is asking about \u2014 it used to say \u201cRun this command\u201d for a file write too, with an empty box.\n\nAnd a tool result over about 10 KB is now kept on disk in full. The conversation carries the whole thing for the next few rounds, then only its first and last lines and a handle; the agent can read the exact original back a page at a time or search it, with recall. Before this, a trimmed result said \u201crun it again if you need the rest\u201d \u2014 another round, and not every command is safe to repeat \u2014 and kept only the beginning, which is the wrong end of a test log.'],
      ['Graphs show what each round cost, and can stop at a budget', 'A graph run now shows the tokens every step used and what each round spent in all, with a dollar estimate at list price for models that have one (Claude and OpenAI models; a ChatGPT or Claude subscription is not charged per token, so read it as a size, not a bill). A round that found nothing new and still cost money is now plain to see while it runs, instead of in a report afterwards.\n\nWith Keep going until nothing new turns up ticked, a new box, Stop after \u2026 thousand tokens, sets a spending limit. The graph stops after the round that reaches it and says so; the last round finishes rather than being cut off halfway, so it can go a little over. Leave the box empty for no limit.'],
      ['A loop step can be told it cannot be done', 'The check on a loop step used to have two answers, pass or fail, so a step that could never pass \u2014 the goal needs access the agent does not have, or asks for something the setup rules out \u2014 went round again on every attempt it had left, paying each time for work that could not succeed. The checker now has a third answer: blocked, with the reason. A blocked step ends the loop at once and the step says why, so you can fix the setup instead of watching the attempts run out. The goal check at the end can answer blocked too. It is for a wall, not a gap: work that more effort could finish is still a fail and still retries.'],
      ['Graphs: steps start the moment their inputs are in, a step can decide the path, and a graph can keep going until it runs dry', 'Four changes to the Graph tab.\n\nA step now starts as soon as the steps it reads have finished \u2014 not when everything else at its stage has. Before, one slow step held back every step in the next stage, including the ones that never read it. Now only a real wait waits.\n\nA new kind of step, Decide, picks one of a few choices you name \u2014 \u201cbig\u201d or \u201csmall\u201d, say \u2014 and any other step can be set to run only when it chose one of them. The agent makes the call; the graph does the branching, the same way every time. The steps on the branch not taken show as Skipped, not failed, and the merge is told why they are missing.\n\nA step that was asked for a particular shape of answer and got it wrong \u2014 prose instead of the fields, a key missing \u2014 is told what was wrong and asked once more, instead of failing on the first slip. The run says when that happened.\n\nAnd a checkbox, Keep going until nothing new turns up, runs the whole graph again with every step told what earlier rounds already found, for jobs whose size you do not know in advance \u2014 a bug sweep where each find leads to more. It stops after two rounds in a row add nothing, and never runs more than five rounds; the run shows each round\u2019s count and why it stopped. That ceiling is deliberate: a loop with no end is how an account\u2019s usage disappears in an afternoon.'],
      ['Research helpers keep the big reads out of your chat', 'When answering means reading a lot of files it does not need to keep \u2014 \u201cwhere is login handled?\u201d, \u201chow does a request get from the button to the database?\u201d \u2014 the agent can now hand up to five such questions to research helpers. Each one works in its own small context on the fast model, reads what it needs, and sends back an answer with the files that matter and why. Only that answer lands in your chat, so a long session stays smaller and cheaper. Helpers can only read: they cannot edit, delete, install or run anything that changes your project, and a read outside the project folder is refused. The \u201cresearch\u201d chip in the transcript opens to show each question, the model that answered it, and what it cost; the session counter lists research spend on its own line.'],
      ['Undo a reply\u2019s changes without losing the chat', 'In a chat with a project folder, Radiant takes a snapshot of the folder before every reply and after it. Under a reply that changed files you now see \u201cChanges \u00b7 3 files\u201d: open it for the list, click a file for its diff, and press Undo these changes to put the files back exactly as they were before that reply \u2014 the conversation stays, so you can say \u201ctry it another way\u201d. The undo is itself undoable. A comment button next to each file drops \u201cAbout that file:\u201d into the composer so a note on a diff becomes your next message. Snapshots live in Radiant\u2019s own folder and never touch your project\u2019s git. A chat whose folder is your home directory gets no snapshots \u2014 that is the whole disk \u2014 so set a project folder for the chats where this matters.'],
      ['The voice button says what it is doing', 'While a voice conversation is running, the button under the composer no longer says \u201cOn a call\u201d. It reads Connecting\u2026, Listening, Working\u2026, or End \u2014 whatever is true right now, and End because that is what pressing it does.'],
      ['The reply is checked against what actually happened', 'When a reply says \u201ctests pass\u201d, \u201ccommitted and pushed\u201d or \u201cthe file is created\u201d, Radiant now checks that claim against the commands the agent actually ran in that turn. A claim nothing supports is written under the reply \u2014 \u201cNot shown by anything in this turn: \u2026\u201d \u2014 and the agent gets one chance to do the thing for real or correct itself. Explanations and suggestions are left alone; only \u201cI did X\u201d statements are checked. Needs an OpenRouter key.'],
      ['Memory learns how the work goes, not only who you are', 'Memory used to keep facts and preferences. It now also keeps lessons about the work \u2014 a command that failed until a flag was added, a script that needed permissions, a source that had the answer when another did not \u2014 so the next chat in that folder starts knowing. Settings \u2192 Memory shows and edits them as before.'],
      ['Quick lookups answer instantly', 'Ask \u201cwhat\u2019s uncommitted?\u201d, \u201clast few commits?\u201d, \u201cwhat\u2019s in this folder?\u201d, \u201cwhich model is this?\u201d or \u201cwhat\u2019s TG-474 about?\u201d and the answer appears in under a second, labeled \u201cinstant\u201d \u2014 no model was involved, the tool\u2019s output is the answer. A quick decision recognizes those questions and only takes the shortcut when it is sure; anything else, and anything mid-task, goes to the model as usual. Want the model\u2019s take on the same thing? Ask in more words. Off switch under Settings \u2192 Models \u2192 Background work.'],
      ['Less busywork after each message', 'After every reply Radiant used to make three more small model calls in the background \u2014 to name the chat, to look for something worth remembering, and to look for a procedure worth saving as a skill \u2014 even after \u201cthanks\u201d. Now one quick decision runs first and only the ones worth doing run: a preference you state gets remembered, a chat about nothing leaves no trace and costs nothing extra. In the same spirit, a skill you have switched on for everything now rides along only when the message calls for it, and once it has joined a chat it stays for the rest of it. Both use the same decision model as the fast lane and need an OpenRouter key; without one, everything runs as before.'],
      ['Easy messages get a fast answer', 'Not every message needs your strongest model. Before each one, Radiant asks a tiny decision model whether a fast model can answer it well \u2014 a quick question, a one-line change, \u201cthanks, now commit\u201d. When it is sure, a fast model from the same provider answers in a couple of seconds instead of ten; anything harder goes to the model you chose. The reply\u2019s label shows which one answered and says \u201crouted\u201d, so nothing is hidden. It stays out of the way mid-task, in plan mode and in group chats. On Grok it uses Grok 4.20 non-reasoning; on OpenRouter, GPT-5 mini; on Claude, Haiku. Switch it off under Settings \u2192 Models \u2192 Background work.'],
      ['What the model saw', 'Under every reply there is a small line \u2014 \u201cWhat the model saw \u00b7 3 rounds \u00b7 12 tools \u00b7 41k in, 88% cached\u201d. Open it and you get a table, one row per request the reply took: which model, how big the instructions were, how many tools were attached, how much of it came from the cache. It is the answer to \u201cwhy was that slow\u201d or \u201cwhy did that cost so much\u201d without guessing. If something is wrong \u2014 the instructions changing mid-reply, which throws the cache away \u2014 it says so in red. Commands the agent runs also no longer see any password, key or token from Radiant\u2019s own environment, so a script that prints its surroundings cannot put a key into the chat.'],
      ['@others, and a room that keeps everyone\u2019s plan current', 'In a group chat you could already name one agent with @Coder so only that agent acts. Two more ways to address the room: <b>@others</b> (or @all) pulls the rest in \u2014 not to do the work, but to say what changes in their own plans because of it \u2014 and <b>!@Name</b> keeps someone out of a message entirely, wherever you write it. So \u201c@coder move the backend to Go; @others !@marketing update your plans\u201d has Coder do the work, DevOps and Security revise theirs, and Marketing sit it out. Only the agent actually doing the work gets tools. There is also a switch on the group\u2019s roster bar, <b>others re-plan</b>: with it on, naming one agent pulls the rest in automatically, so you do not have to type @others every time.'],
      ['A project can have a folder, and says what it really is', 'A project groups chats in the sidebar \u2014 it does not create a folder on your disk, and now says so where you make one. It can point at a folder, though: the folder button on a project row picks one, and every new chat you start in that project opens in it instead of your home folder.'],
      ['A remote session no longer drops as often, and recovers faster when it does', 'Connecting to Radiant on another Mac — over Tailscale, say — could silently kill a turn after a long "thinking" phase or a slow tool call: the network hop between the two machines was reaping the connection for going quiet, which is the same drop the Continue button (below) was already built to recover from, just happening more than it needed to. A small heartbeat now keeps that connection visibly alive, so it drops far less in the first place. And if the agent was waiting on your approval or an answer right when a drop did happen, the session no longer sits locked for up to 10 minutes waiting for a reply that can never come — it lets go immediately, so Continue (or a fresh message) works right away instead of hitting "a turn is already running".'],
      ['A turn cut off by a closed window or a dropped connection says so too', 'The other half of the same problem: if a turn was interrupted \u2014 you closed the window, quit the app, the network went away, or you pressed Stop \u2014 nothing was written into the conversation, so it was left with an empty reply and no explanation, exactly like a chat that had died. An interrupted turn now records what happened, and a dropped one offers Continue to pick it up from where it stopped.'],
      ['A chat that fails now says why, right in the conversation', 'When a turn failed — the model erroring, its chat template breaking on the tool results, the conversation outgrowing the model — the reason showed for a second in a banner and then vanished, and the chat was left with an empty reply and no explanation. It looked like the chat died for no reason. Every one of those failures is now written into the conversation itself, with the reason and a Continue button, so it is still there when you come back to it. And a message you send while a turn is already running no longer disappears: it stays on screen and tells you a turn is still going.'],
      ['A model that goes quiet no longer ends the chat in silence', 'Three things could make a turn stop mid-work with nothing said, and all three are handled now. A model that returned an empty response after a round of tool results used to end the turn as if it had finished; it is now asked once to continue, and if it returns nothing again the chat gets a plain sentence saying so, with how far into the context it was and what to try. A reply cut off by the model\u2019s output limit now says it was cut off instead of looking finished. And a local model that writes its tool call as text \u2014 a common quirk of community models whose chat template has no tool support \u2014 is now understood and the tool runs.\n\nSeparately, Radiant used to give up on any model that stayed silent for five minutes \u2014 the time a large local model can take to load and read a long prompt before its first word \u2014 and the chat showed only the word \u201cterminated\u201d. It now waits as long as the model takes; Stop still stops it. Local models also report their real context size to the gauge under the composer, so it fills up honestly instead of showing nothing.'],
      ['A fallback model when yours is not answering', 'Settings \u2192 Models has a new choice: If the model is not answering. When a provider is down, rate-limiting or unreachable, a turn that has not yet done anything is rerun on the fallback instead of stopping, and the chat shows a line saying which model took over and why. A turn that had already run tools is not redone on a different model. Only outages count \u2014 a bad key, an empty account or a request the provider refused still shows the real error, because the fallback would not fix those. Pick a model on a different provider.'],
      ['Skills have categories', 'With dozens of skills, one flat list stopped working. Every skill now has a category \u2014 Coding, Apple, Design, Writing, Research, Quality, Ops, Business, Other \u2014 guessed from its name and description, shown faint until you confirm or change it in the small menu on its row; your choice is saved and wins from then on. Settings \u2192 Skills has category chips across the top with counts, and the Skills button in the composer groups the list by category with a fold on each heading, like the model picker, remembering which you folded, and listing the categories alphabetically \u2014 Other last, since it is the catch-all. Within each one the skills are alphabetical too. The filter box searches across all of them.'],
      ['In a group chat, @Name picks who acts \u2014 and they get tools', 'Every agent in a group chat used to answer every message, and none of them could use tools \u2014 so \u201clet\u2019s do the frontend in React\u201d had four agents all trying to do it at once, none of them able to. Now type @ and pick someone from the room (or write @coder, @dev-ops): only they act on that message, with the chat\u2019s tools and skills, and the rest of the room stays quiet but reads it \u2014 what the addressed agent does is in the transcript for everyone\u2019s next turn. Mention two and both act, in order. No mention keeps the round table as before. Asked for by a user on GitHub (#16, #18).'],
      ['MCP servers can be edited, and they find npx', 'Each MCP server row has an Edit button now \u2014 name, command or address, token \u2014 instead of remove-and-re-add. And a server\u2019s command runs with the same PATH your terminal has, so npx, uvx and anything your shell profile sets up are found; before this, a Mac-launched app only saw the bare system PATH and a server like \u201cnpx -y some-server\u201d failed with ENOENT. A command written the way a terminal would take it (PATH=\u2026 npx \u2026, or with a pipe) is run through your shell as written. Asked for on GitHub (#15).'],
      ['A copy that cannot update itself now says so', 'If Radiant is opened from the disk image, or from Downloads before it has been moved, macOS runs it from a temporary read-only spot and will not let it replace itself \u2014 so updates downloaded every six hours and quietly failed, and that Mac stayed on the version it opened with. Settings \u2192 About and Check for Updates\u2026 now say exactly that, with the fix: quit, drag Radiant into the Applications folder, open it from there. Updates work on their own after that.'],
      ['Every composer button grows into its word', 'Attach, Design and Skills now open into a labeled button on hover, the way Dictate, Talk and the toggles on the right already did \u2014 point at any icon under the message box and it tells you what it is.'],
      ['The sparkle button is Skills now', 'The button beside the microphone used to open Recipes, a menu of task templates. It opens your skills instead: pick one and it goes into the message as /name, visible and editable, and sending is what uses it \u2014 the same thing typing a slash does. Skills already pinned to the chat are left out, since they are on every turn anyway; with more than six there is a filter box. Recipes themselves still exist in Settings; they just no longer take a button.'],
      ['Several Macs on one folder is fine \u2014 the banner that said otherwise is gone', 'The bar across the bottom of the window that said \u201cRadiant is also open on <another Mac>\u2026 quit one of them\u201d was written for a two-Mac evening in August and was wrong advice for someone who runs five. Radiant re-reads the shared settings whenever another Mac writes them, so a theme or a key changed on one Mac shows up on the others within a few seconds and nothing is saved over it. The one thing to avoid is editing the same chat on two Macs at the same moment \u2014 the last one to finish wins. That sentence now lives in Settings \u2192 Devices, beside the other Macs, instead of across every window.'],
      ['Picking a theme picks the whole look', 'If you had set a custom background and text color, choosing a theme afterwards changed only the accent \u2014 the background stayed, and every theme looked the same. Picking a theme now clears the custom background too, and the Background & text block says plainly that it overrides the theme\u2019s and that picking a theme clears it. Set it again after choosing a theme if you want both.'],
      ['A voice conversation is kept, as rows', 'While a call is open the captions are now a small transcript above the composer \u2014 one row per turn, You and Radiant, scrolling with the newest unless you scroll up to read back. When the call ends, the whole conversation is saved into the chat as a card (\u201cVoice conversation \u00b7 4 min\u201d) with every row, and the next turn can read it. Before this the captions were one line showing only the latest words, and they vanished with the call.'],
      ['Voice has its own Settings page', 'Everything about talking to Radiant is under Settings \u2192 Voice now: the switch, a key slot of its own, the voice, and what leaves the Mac. Before this it was a block at the very bottom of Providers and the key had to be added as a second OpenAI account beside the sign-in your chats use \u2014 "messy", and it was. The key you paste on the Voice page is kept for voice alone and does not change which OpenAI account your chats are on.'],
      ['A provider can hold a sign-in and a key at once', 'On a provider row that has a subscription sign-in, + Add account used to start another sign-in and there was no way to add an API key beside it \u2014 which is exactly what voice needs on an OpenAI account signed in with ChatGPT. The row now offers both: + Sign in to another account, and + Add an API key. Adding a key makes it the active account; click the subscription chip to switch your chats back, and voice keeps using the key.'],
      ['0.9.0 opened with no window \u2014 fixed', 'If you installed 0.9.0 and Radiant launched to nothing, that was a packaging mistake in the voice feature: one file the server needed was left out of the app, the server failed before it started, and the window waits for the server. 0.9.1 ships the file, and a new check refuses any future build whose server imports something the app does not carry.'],
      ['Talk to Radiant (optional)', 'Settings \u2192 Voice has a switch, off by default: Voice conversations. Turn it on and a Talk button appears in the composer. Press it and you are in a live, two-way conversation over that chat \u2014 speak naturally, interrupt, ask how it is going, change your mind. OpenAI\u2019s GPT-Live does the listening and speaking; anything real is handed to the agent in the chat, on whatever model the chat uses, with the same tools and the same approvals as typing (an approval or a question still waits for you in the app, and the voice says so). The reply is read back to you in a few plain sentences, with the code and detail left in the chat. Spoken messages carry a small wave mark in the transcript.\n\nWhat leaves this Mac: your microphone and the spoken replies go to OpenAI while a call is open, at their per-minute rate (about 5\u00a2 a minute at launch); the strip above the composer shows the running minutes and an End button. Needs an OpenAI API key \u2014 a ChatGPT sign-in does not cover it; paste one in Settings \u2192 Voice. Switching chats ends the call.'],
      ['Four more models on the iPhone and iPad', 'The on-device model list gained Qwen 3 VL 4B and Qwen 3 VL 2B (the newest generation of Qwen\u2019s picture models \u2014 the 4B replaces Qwen 2.5 VL 3B as the most capable one that fits a phone, the 2B fits any iPhone), Qwen 2.5 Coder 3B (the first model in the list tuned for code), and Ministral 3 8B (for 12 GB iPhones and iPads). Every row is checked against the real download before it is published \u2014 size, quantization, and whether the app can actually load it \u2014 and the list reaches an installed app the next time it opens; nothing to update. This is the first of a weekly sweep: new models are looked for every Sunday night and added on Monday morning when they are worth it.'],
      ['A long turn is trimmed, not killed', 'An agent working through a big task \u2014 thirty tool calls in one turn, reading files and running commands \u2014 could hit the model\u2019s size limit mid-turn and die with the provider\u2019s raw error (\u201c400: maximum prompt length is 256000 but the request contains 259445 tokens\u201d). Every safety net counted messages, and one turn is one message however many tool calls it holds. Radiant now trims older tool results inside the turn as it goes (the last few rounds stay whole), watches the real prompt size the provider reports and trims harder as it nears the limit, recognizes every provider\u2019s way of saying \u201ctoo long\u201d \u2014 xAI\u2019s was not on the list \u2014 and if it is still refused, trims everything but the current round and retries, then summarizes. If it truly cannot fit, the message says so in a sentence. The context gauge under the composer also knew grok-4 and grok-build as 131k models; they take 256k.'],
      ['The composer buttons are icons that grow on hover', 'The row under the message box \u2014 tools, computer, plan, thinking, permissions, dictate \u2014 rests as small icons, which gives the model name the room it needs. Point at one and it grows into the button it used to be, with its words (\u201cplan off\u201d, \u201cask each\u201d), and its neighbors slide over to make room. Move away and it shrinks back. While a button is open its words are written in plain text on the plain hover surface \u2014 the word already says on or off, so only the icon keeps the state color \u2014 after an earlier version drew \u201ccomputer on\u201d in the accent color on an accent fill, which in the green theme was two shades of the same green. The words are still there for a screen reader whether or not you are pointing at anything. An earlier version kept the icons small and put the words in a tooltip only; the buttons themselves now expand.'],
      ['The Chrome page no longer says \u201cnot installed\u201d when it cannot know', 'Radiant cannot see inside Chrome. All it knows is whether the extension is talking to it right now, and it used to render silence as \u201cNot installed yet\u201d \u2014 to people who had just installed it. Settings \u2192 Chrome now says one of three true things: connected (with the extension\u2019s version); it was connected earlier today at such-and-such time, so it is installed and Chrome is probably closed or a different profile is in front; or nothing has connected since Radiant started. The install button is only offered in that last case. Radiant also pings the extension every twenty seconds now, which keeps Chrome from putting it to sleep between turns \u2014 before, a browser action landing in one of those gaps failed with \u201cthe extension is not connected\u201d.'],
      ['Chrome has its own page in Settings', 'Everything about the agent working in a browser now lives under Settings \u2192 Chrome: the one-click install of the Radiant Browser Bridge from the Chrome Web Store, and beneath it the fallback \u2014 a second Chrome window with its own profile, for anyone who would rather not install an extension. Before this, both sat at the bottom of the Automation page, under a heading about desktop control, three guesses away from where anyone looked for them. Automation now covers what it says: shell-command approval, the default folder, and the macOS Screen Recording and Accessibility permissions for driving the desktop.'],
      ['The browser extension is one click now', 'The Radiant Browser Bridge \u2014 the small extension that lets the agent work inside the Chrome you are already signed into \u2014 is on the Chrome Web Store. Settings \u2192 Chrome (it was Automation at the time) has a button that opens the listing; press Add to Chrome there and come back. Before this, the same pane walked you through opening chrome://extensions, turning on Developer mode, clicking Load unpacked and pasting a folder path \u2014 the developer sideload, which was the only way in before the listing existed. Those steps are still there, folded away, for anyone running Radiant from source.\n\nThe extension also no longer stamps a blue \u201con\u201d badge across its toolbar icon whenever Radiant is running. That was a permanent sticker on a sixteen-pixel icon. Whether it is connected is already said in the extension\u2019s own popup and in Settings, which is enough.'],
      ['Devices now says which phone thing is which', 'Settings \u2192 Devices has a section that lets your phone\u2019s browser open the Radiant running on this Mac \u2014 this Mac\u2019s chats, models and agents, from the sofa. It was written before there was an iPhone app and said \u201cRadiant behaves like an app,\u201d which stopped being a helpful sentence the day the real one reached the App Store. It now says plainly that it is not the iPhone app: the App Store app runs on the phone by itself and never talks to your Mac; this link is the other way round. A link to the App Store app sits right there.'],
      ['Put Radiant on your phone by pointing the camera at a code', 'Radiant\u2019s server has always accepted a link that signs a device in \u2014 open it once on your phone and you are connected, with the secret part stripped out of the address afterwards so it never lands in your history or a bookmark. The only thing missing was somewhere to get that link, so nobody could use it.\n\nSettings \u2192 Devices, with sharing turned on, now shows the link and a code to point your phone\u2019s camera at. Open it, then Share \u2192 Add to Home Screen, and Radiant behaves like an app.\n\nThe chats are this Mac\u2019s chats. Anything you start at your desk you can carry on from the sofa, because it is the same conversation on the same machine rather than a copy that has to be kept in step.\n\nTwo honest limits, both said on screen. The code is a key, not just an address \u2014 anyone who photographs it gets in, so it stays hidden until you ask for it, and it does not belong on a slide or a screen-share. And this Mac has to be awake with Radiant running, because your phone is looking at it, not replacing it. If you have Tailscale the link works from anywhere; without it, only while your phone is on the same network.'],
      ['Show the model\u2019s thinking, or don\u2019t', 'Models that reason out loud were showing you that reasoning whether you wanted it or not \u2014 the trace opened itself while the model was working and only collapsed once it had finished, which is backwards if you just want the answer. There is a brain button in the row under the message box now: thinking on, thinking off.\n\nOne thing it is honest about, in the tooltip as well as here: this only hides the reasoning. The model still thinks, and you are still billed for it. How hard it thinks is a different control \u2014 the effort setting in the model picker \u2014 and it would be easy to assume this one saved you money. It does not.\n\nThe setting is remembered, so it is not something to set again in every new chat.'],
      ['Radiant tells you when it is open twice on the same folder', 'If you keep Radiant\u2019s folder in iCloud so your chats follow you between Macs, only one Mac should be running Radiant at a time. Two copies writing to the same folder overwrite each other \u2014 that has always been true, and it was said only in a hint inside a collapsed section of Settings, which is not where you look before it matters. Nothing detected it, so the first sign was work quietly going missing.\n\nRadiant now notices, and says so in a line across the top of the window, naming the machine: \u201cRadiant is also open on Tony\u2019s MacBook Air, using this same folder.\u201d It disappears on its own when that copy quits.\n\nIt does not stop you. Being refused entry to your own chats \u2014 because of a crash, or a slow sync, or a clock being off \u2014 is a worse outcome than the risk it would be protecting you from. It tells you the truth and leaves the decision with you. If you do want both Macs at once, the supported way is to run Radiant on one and reach it from the other over your network, in Settings \u2192 Devices.'],
      ['A chat could go blank for a moment while it was being saved', 'Saving a chat emptied its file and then refilled it. That takes a moment on a big conversation \u2014 the largest here is over five megabytes \u2014 and anything reading during that moment got half a file, which Radiant could only read as \u201cno messages\u201d. So the conversation went blank and then came back a second later. Nothing was ever damaged; you were seeing the file mid-write.\n\nIt is measurable rather than theoretical: with a reader running alongside, 828 of 834 reads of a 4.6 MB chat came back empty. Now zero do. The chat is written to a new file which then replaces the old one in a single step, so a reader gets the old version or the new one and never half of either \u2014 which is how every other kind of data in Radiant was already saved. Chats, the biggest and most often written, were the one exception.\n\nIf you keep Radiant\u2019s folder in iCloud this was much more likely, because iCloud is reading the file to upload it at the same time.'],
      ['Two chats at once \u2014 one could stop the other, and leak into it', 'Radiant could only ever follow one running chat, and it never said so. Start a second one and three things went wrong at the same time.\n\nThe first chat appeared to stop dead for no reason. It had not \u2014 the work carried on and every word of it was saved \u2014 but Radiant stopped showing it to you, which looks exactly like a crash.\n\nThe second chat\u2019s thinking and replies were then drawn into whichever chat you happened to be reading. So you could sit in one conversation and watch an agent reason about a completely different one.\n\nAnd worst: a chat running in the background could put its \u201cmay I run this command?\u201d prompt in front of you while you were reading something else. Pressing Approve there ran the other chat\u2019s command. That one could act on your Mac rather than just confuse you.\n\nEvery running chat now keeps its own live view, its own prompts, and its own counters, and a chat only ever shows its own. Nothing was ever lost to this \u2014 if a chat looked like it died mid-answer, reopen it and the rest is there.'],
      ['Claude chats stop paying full price for the same words every turn', 'A long chat re-sends everything before it on every single request. Anthropic will hold most of that on their side and charge about a tenth for it, but only if the part being held is byte-for-byte identical each time — and Radiant\u2019s was not. The instructions at the front of every request included the facts Radiant remembers about you, and those are chosen fresh each turn to match what you just asked, so they changed almost every time. The unchanging part and the changing part are now separated, and only the unchanging part is held.\n\nThere is a new switch in Settings \u2192 Agent, on by default, and a choice of how long the saving lasts \u2014 five minutes, or an hour if you tend to reply slowly. Turn it off if you are using a Claude-compatible service that rejects it, or for one-off questions where there is no second turn to save on. It applies to Claude models whether you reach them directly or through OpenRouter. OpenAI does this on its own and needs nothing from you.\n\nThis was caught before it shipped, not after: as first written it would have cost about 25% MORE on every turn while appearing to work, because a saving you never collect is just a surcharge.'],
      ['Radiant runs on Linux', 'Radiant was written for a Mac and said so about 250 times, in code as well as on screen \u2014 it reached for macOS-only commands to open a folder, read the processor, or find Chrome, with nothing to fall back on. It now runs on Linux as a normal AppImage, updates itself the same way the Mac version does, and drives the desktop there through its own helper. None of this changes anything on a Mac.\n\nThree of the bugs found on the way were ours rather than Linux\u2019s, and one of them was ugly: the Mac helper that moves the mouse and captures the screen was being copied into every build, and the check for whether it was usable only asked whether the file was there. So on a machine where it could never run, Settings offered desktop control and dictation as working features. \u201cThe file exists\u201d is not the same question as \u201cthis works here,\u201d and Radiant had been answering the wrong one.\n\nWith thanks to Samir, who did the port and ran it rather than reading it.'],
      ['A chat that stopped instantly, on every single message', 'The worst bug Radiant has shipped. A turn is allowed to spend a certain amount before it is cut off — a sensible thing to have. It was measured against the wrong number: not what the turn had spent, but what the entire conversation had ever spent, added up over its whole life. So a chat that had done a lot of work was permanently broken. Every message stopped in under a second, having done nothing, with a notice saying it had run out of budget. Pressing Continue produced the same instant nothing. There was no way out of it from inside the app, and the longer a chat had been useful the more certain it was to die that way. It now measures the turn, which is what it was always supposed to mean, and a chat that was bricked by this works again as soon as you update — nothing was lost, it simply could not run.'],
      ['Long chats stop re-sending everything they have ever read', 'A chat that had read a few web pages was sending all of them, in full, on every round of every message — and a turn can take thirty rounds. One real conversation was 540,000 characters, of which 1,700 were things you had typed; the other 98% was raw output from tools, half of it five API responses kept whole and posted again and again. That is why a chat you had barely used felt enormous, slow and expensive, and why it eventually hit its own limits. Older tool results are now shortened on their way to the model, with a note saying how much was trimmed and that it can be fetched again. The last six exchanges are always kept whole — that is the part the agent is still working in. Nothing is deleted: your transcript is untouched and you still see every result in full. This changes only what gets posted, and it roughly halves it.'],
      ['Dragging the window, properly this time', 'The Task, Loop and Graph screens had no way to grab the window, and three attempts to add one all used the same wrong idea: an invisible strip laid over the top of the app. On top it swallowed the buttons underneath it; made to ignore the mouse it may not drag at all; put behind everything it is covered by the app itself. The strip is gone. Each of those screens now uses its own heading bar as the handle \u2014 a real, visible part of the page, which is exactly what the chat screen has always used and the one arrangement that has never broken. It stays put when you scroll, so the handle does not disappear.'],
      ['Turns stop when the agent is stuck, not when the work is long', 'A turn was cut off after 30 rounds of tool use \u2014 and 30 is smaller than an ordinary job. Asked to pull a page of skills and install them, the turn that was actually doing it spent 14 fetches and 13 file writes, 27 of its 30 rounds on the work itself, and was cut off part way through. A limit like that is meant to stop an agent looping forever; it was stopping real work at an arbitrary line.\n\nThe limit is now far out of the way, and the thing that can actually tell working from stuck does the stopping: if the agent makes the identical call a dozen times in a row it is halted and told so, naming the tool. There is also a ceiling on what one turn may spend, because a round count never measured cost \u2014 one stuck chat cost 25.7 million words of input. Whichever way a turn stops, it says which one it was, and Continue picks it up.'],
      ['A chat that stops early says so, explains itself, and can carry on', 'A turn is allowed 30 rounds of tool use. When one used them all up it simply stopped \u2014 the only sign was a line of small grey italic text at the bottom of the reply, which after thirty-odd tool calls is no sign at all, and it did not explain anything either. Now, before it gives up, the agent is asked one last question with its tools taken away: what were you doing, what is done, what is left, and what would unblock it. Its answer goes in the chat, followed by a proper notice you cannot miss \u2014 and a Continue button that picks the work up from where it stopped instead of starting over.'],
      ['Radiant tells you when a turn needs you, or when it is done', 'Radiant could not reach you before \u2014 there were no notifications at all. A turn that finished after ten minutes of work, a turn that failed, and a turn sitting there waiting for you to approve a command were all equally silent, and the only way to find out was to go and look. All four now send a notification when Radiant is not the window you are looking at: finished, failed, stopped early, and waiting on you. Clicking one brings Radiant to the front and opens that chat. Nothing is sent while you are already watching the window, and each chat only ever has one notification waiting \u2014 a finish replaces the approval prompt it followed.'],
      ['A chat started on your other Mac no longer breaks every command it runs', 'If you sync your Radiant folder between Macs, your chats travel but their working folders cannot: a chat started on a Mac where you are \u201Copensource\u201D points at /Users/opensource, which does not exist on the other one. Nothing checked, so every command, every file read and every edit failed \u2014 and failed with nothing but an error code, so the agent could not work out why either and kept trying until it ran out of turns. A chat whose folder is not on this Mac now works in your home folder instead and says so in the conversation, naming the folder it wanted, so you can point it somewhere sensible. The chat is left alone, so it still works on the Mac that set it.'],
      ['New task, New loop and New graph are clickable again, and in a sensible place', 'The strip along the top of the window that lets you drag it was covering most of those buttons \u2014 clicking the bottom few pixels worked and everything else did nothing, which is why it felt intermittent. It was covering the HUD button and the panel button too. The strip no longer intercepts clicks at all, and the three New buttons have moved from the far right of their header to underneath it, on the left, where the New buttons in the sidebar are.'],
      ['A loop step can now pass because a command says so', 'Until now every check in a loop was judged by a model. The box even suggested “npm test exits 0” as an example of a good condition — and then asked an agent whether that had happened. Two models agreeing is not a check.\n\nA step now takes a command as well: it passes when that command exits 0. Type npm test, or pytest, or test -f dist/report.csv. It runs in the loop’s working folder before any agent is asked, so a failing check costs you nothing at all — no model, no waiting. And when it fails, whatever the command printed goes back to the agent as the evidence, so the retry starts from the actual error instead of a summary of it.\n\nYou can still write a plain-English condition too, and use both. The command is checked first because it is the one that cannot be argued with.\n\nA retry is also scoped now. It names the step that failed, why it failed, and says to fix that and nothing else. Without that, a returned step tends to grow — the agent opens the file, spots two other things and fixes those too, and a one-step correction lands as a change nobody asked for, on steps that had already passed their own checks.'],
      ['Loops can check the whole goal, and start themselves', 'Two things a loop could not do before.\n\nThe first: every step passing is not the same as the goal being met. A loop can run the wrong three steps and verify each one perfectly. There is a new stage when you build a loop — “Done, and how often” — where you can give the whole run a check of its own, either a command or a sentence an agent judges. If the goal is not met, the loop starts over from step one, carrying the reason with it, up to a number of passes you set. Both are optional; leave them empty and a loop finishes when its last step passes, exactly as before.\n\nThe second: a loop can now run on a schedule — every 15 minutes, hourly, or daily. Useful for the jobs you keep meaning to run: check the build, triage what came in overnight, re-run the report.\n\nTwo honest limits. Radiant has to be open, because it is Radiant that runs the turns — that is what lets you watch a loop and interrupt it, and the price is that nothing happens while the app is quit. And if a scheduled loop fails twice in a row it switches its own schedule off and says so on the card, rather than repeating the same failure all night.'],
      ['New group chat looks like the other new buttons', 'New session, New project and New group chat all create something, and now they all look the same. The group one was a lighter, dashed style meant to read as a second tier \u2014 but it only ever appeared directly beneath the solid one, so it looked like a mistake rather than a hierarchy. Its icon was an emoji, which ignored your theme and stayed the same colour on hover while the one next to it changed; it is a line icon now, drawn to match the agent icons.'],
      ['The permissions button stays where you put it', 'With a long model name in the row \u2014 something like OPENROUTER moonshotai/kimi-k3 \u2014 the ask each / allow all button was pushed onto a second line under the message box, and it moved depending on which setting you had chosen. The model name now shortens with an ellipsis instead of shoving the other controls around.'],
      ['You can drag the window from any tab again', 'Only the Chat screen ever had a draggable strip along the top. Tasks never had one, and when Loops and Graphs arrived they did not either \u2014 so on those tabs there was nothing to grab and the window could not be moved. There is now one strip for the whole app rather than one per screen, so a new tab cannot arrive without it, and no button can ever be swallowed by it.'],
      ['Fewer tools, and none of them can flood the conversation', 'Three things that were quietly costing you money and time on every turn.\n\nRadiant described twelve tools to the model on every single request, whether or not any of them were used \u2014 and a tool description is not free: it shapes how the model generates, so a long list makes every answer slower as well as dearer. Three of those twelve were different ways to look at a background job, which is one idea, so they are now one tool. Listing a folder was another, and reading a folder now just lists it. Nine tools instead of twelve. If a model asks for one of the old names out of habit, it still works \u2014 it is simply no longer advertised.\n\nOnly three of the twelve limited how much they could return. Fetching a web page returned the whole thing, and so did a search, and so did anything from a connected MCP server \u2014 one large page could fill the conversation and cost real money. Everything is capped now, in one place, and when something is cut you get told how much went. It keeps the beginning AND the end, because a command whose last line was cut off reads like it succeeded.\n\nAnd only two of the twelve had a time limit, so one hung tool could hang the whole turn with no way out. Every tool call now has a budget.'],
      ['Stop actually stops', 'Pressing Stop while the agent was running a command did very little: the command ran to the end \u2014 or to its two-minute limit \u2014 and every other tool that turn had lined up ran too, so the agent carried on for a while after you told it to stop. Stop now kills the running command, skips whatever was queued behind it, and the button says it is stopping while that happens. Whatever the agent had already done is kept in the conversation.'],
      ['Picking a model no longer starts the task', 'On the Tasks board, clicking \u201cPick a model\u201d while writing a new task created the task there and then \u2014 before you had picked anything, with whatever was half-typed as its title. The button had no type set, and a button with no type inside a form is a submit button. Every button in the model picker is explicit about it now.'],
      ['Loops \u2014 a run of steps that checks its own work', 'A task is one job, and it is finished when the agent stops talking, which is not the same as finished. A loop is several steps in order, and each one carries a condition you write in plain English \u2014 "npm test exits 0", "the new page loads and the old link still works". When a step\u2019s turn ends, that condition is judged in a separate turn with the work in front of it, and a step that does not meet it goes round again carrying the reason it failed, up to a number of attempts you set. You can name a different agent to do the checking, which is worth doing: an agent grading its own work is the weak version. Every step runs as an ordinary chat you can watch, interrupt and steer, and a step with no condition says so on the card rather than quietly counting as done. Loops live in the new Loop tab, which opens with a diagram of what a loop actually is \u2014 observe, act, verify, round again \u2014 and sets one up a step at a time rather than as one long form. A loop only moves while Radiant is open on it, and because its steps are ordinary chats it waits at an approval prompt exactly like anything else \u2014 if a loop looks stuck, the chat is where it is waiting.'],
      ['Graph \u2014 describe the job and Radiant draws the graph', 'The Graph tab is the layer above Loop. A loop is one job that keeps going until it passes a check; a graph is several jobs that do not wait for each other.\n\nStart by just saying what you want done \u2014 "audit every route file for missing auth checks, then have something try to break the findings". Radiant proposes the steps and, more importantly, works out which of them genuinely have to wait for each other. Everything else runs at the same time, which is the entire reason to draw a graph rather than a list. It tells you what it assumed, shows you how many steps run together, and drops the whole thing into an editor so you can change anything before it runs. Nothing runs until you press Run. If you would rather lay it out yourself, Build it myself gives you the steps directly.\n\nThree kinds of step. Work is an agent doing one bounded job. Check is a skeptic: it reads what came in, tries to disprove each claim, and drops whatever it cannot support \u2014 give it a different model from the step that produced the work, because an agent asked to check its own answer will pass it. Combine is plain code, joining or de-duplicating what came in; no model is called, so it costs nothing and takes no time.\n\nEach step names its own model, so the broad, repetitive ones can run cheaply and your best model is kept for the merge. A step that fails does not take the rest down with it \u2014 the others still finish and the merge is told there is a gap. Radiant draws the shape, says how many steps run at a time, and points out any step that waits for something it never mentions, which is usually a wait that is not real. Graphs run on the server, so closing the window does not stop one. And a graph cannot stop to ask you for permission, so by default a step that needs approval fails and says so; there is a checkbox to let a graph act on its own, and it means several agents running commands at once with nobody watching.'],
      ['The tabs are in two rows', 'Chat and Agents on top \u2014 where you are. Task, Loop and Graph underneath \u2014 what you are building, each a layer up from the one before it: one job, a run of them, and the shape of the thing you are building them in.'],
      ['A Templeton theme', 'The sage green and warm tan combination, saved as a proper theme so you can pick it from the Theme row rather than rebuilding it. It has light, medium and dark versions, and it is on the iPhone app too.'],
      ['The accent color uses the color you actually picked', 'Choosing white gave you a mid-tone tan, because the picker read only the hue and vividness of your color and drew the accent at a fixed lightness. It now uses the whole color. Very light or very dark picks are nudged into a range where they stay visible \u2014 an accent has to work both as a button and as text \u2014 and the swatch shows what you will actually get. The text drawn on accent-colored buttons now follows the accent rather than the mode, so a pale accent gets dark text instead of vanishing.'],
      ['A better settings icon', 'The gear was redrawn several times and kept looking wrong at the size it is actually displayed. It is now a proven icon from the Heroicons set, the same one in both the Mac app and the iPhone app.'],
      ['The task columns fit the window instead of running off it', 'Narrowing the window used to push Review and Done off the right edge behind a sideways scrollbar, because the five columns held a fixed width whatever the window did. They share the width evenly now and get narrower together, so you can always see the whole board — which is the only reason to have a board. Long task titles wrap instead of forcing a column wide.'],
      ['The lock on that door now checks the right key', 'The fix that stopped other websites reaching Radiant asked whether a request agreed with itself, rather than whether it came from Radiant \u2014 so a site could still get in by claiming to be the address it was calling. It now compares against a fixed list built when Radiant starts: this window, your phone with its token, nothing else. Browser extensions were trusted as a group, which meant any extension you have installed \u2014 an ad blocker, a coupon tool \u2014 could reach the terminal; only the Radiant extension\u2019s own connection accepts one now. And a page can no longer start dictation by quietly loading a Radiant address as though it were an image.'],
      ['Radiant asks before it writes a file', 'Running a shell command asked you first; creating or editing a file did not, at any location on the disk. So anything that talked the agent into writing somewhere \u2014 a page it read, a file in a repo you pointed it at \u2014 could put a file in your home folder with nothing on screen but a line in the transcript. Writing a file now asks, and so does reading one from outside the folder you are working in. Plan mode goes further: the tools that change things are not offered at all, so \u201cresearch only\u201d means it.'],
      ['Auto approval knows what a program is', 'The \u201conly ask about risky commands\u201d setting graded commands with a list of dangerous-looking shapes. It caught the obvious ones and missed every programming language on your Mac \u2014 a one-line Node or Perl command could do anything at all and ran without asking. It now works the other way round: a short list of commands that only look at things runs quietly, and anything it does not recognise asks you. You will see a few more prompts, and they are the ones worth seeing.'],
      ['Other websites can no longer reach Radiant', 'Radiant\u2019s server trusted anything coming from your own machine, and a web page open in your browser counts as your own machine. That meant a site you were simply visiting could read your settings \u2014 including credentials for any MCP servers you had added \u2014 and start a chat as you, without a prompt and without you clicking anything. Radiant now only answers its own window, your phone with its access token, and the browser extension. Nothing else gets a reply.'],
      ['Clearing your memory now stays cleared', 'Looking a memory up could quietly put deleted ones back. Radiant reads the whole memory file, works for a few seconds, then writes it back — and anything you deleted in those seconds was written over, while the screen showed it had gone. Deleting and clearing now take priority, and a memory Radiant replaces keeps the sentence it replaced, so if it ever decides two things contradict when they do not, what you said is still there. What Radiant sends the app about your memories no longer includes the maths behind them, which had grown to megabytes on every screen refresh.'],
      ['A page Radiant reads cannot tell it something about you', 'Radiant writes down durable facts after a conversation. It also reads web pages, and it is asked to tell you what a page said — so a page could put a sentence in front of it that got written down as a fact about you, and then read back later as something you had said. Turns where Radiant read a page, searched the web, or used a connected tool are no longer used to write memories.'],
      ['Radiant remembers what you meant, not just what you typed', 'What Radiant remembers about you and your projects used to be found by matching words. Tell it you prefer tabs, ask later about indentation, and it would not connect the two \u2014 the fact was there and never reached the conversation. If you have Ollama running with an embedding model, memory is now searched by meaning instead, and a fact that contradicts an older one replaces it rather than sitting alongside it. Without Ollama nothing changes: the old word matching still runs, and memory stays on this Mac either way \u2014 nothing about what you have told Radiant is sent anywhere to make this work.'],
      ['The HUD button works again', 'Making the top of the window draggable in 0.6.237 also made the HUD button, and the panel button on the welcome screen, stop responding. A draggable area swallows clicks on anything sitting inside it, and both of those sit on top of one. They are exempt now, and the test that checks whether the window can be dragged also checks that no button has been swallowed.'],
      ['You can drag the window by its top bar again', 'Removing the black title bar also removed the only part of the window macOS knew you could grab, so dragging the top bar did nothing and the window could not be moved at all. The top bar, the area beside the Radiant name, and the Activity/Terminal tabs are all drag handles now, and every button sitting in them still clicks normally.'],
      ['The window has no black bar across the top', 'macOS was drawing its own title bar above the app, which stayed black whatever theme you chose. The app now paints all the way to the top edge, so your background color reaches the window controls.'],
      ['The accent color picker works again', 'Choosing your own accent color did nothing \u2014 the app quietly went back to Radiant blue every time, so anything tinted by the accent stayed blue no matter what you picked. The swatch showed your color; the app ignored it. Fixed.'],
      ['Appearance is less cluttered', 'Background tint and the new Background & text pickers do the same job in different ways, and only one of them can be in effect \u2014 so only one is shown. Pick your own background and the tint slider goes away; clear it and the slider comes back. The vividness slider next to the accent swatch is labeled now instead of being an unexplained bar.'],
      ['Pick your own background and text color', 'Settings \u203a Appearance has a Background & text row: two color wells, one for the page and one for the text, chosen independently of the accent. Until now the background could only be a stronger or weaker version of the accent color \u2014 you could not have, say, a warm grey page under a blue accent. You can now. Everything else \u2014 panels, raised surfaces, hover states, secondary labels \u2014 is worked out from the two colors you pick, and a Contrast slider controls how far apart they sit. If a pairing would make text hard to read, it says so and gives the actual contrast ratio, but it still applies what you chose: it warns, it does not overrule you. Clear puts you back on the theme.'],
      ['Updating shows real progress again', 'Pressing Download & install left the bar at 0% and looked frozen. The download was working the whole time \u2014 it finished normally and waited on disk \u2014 but the progress messages were being sent to the main window while the bar you were watching is in the Settings window, so nothing ever reached it. It updates properly now, and if you close Settings and come back it picks up where things actually are instead of offering to download the same 160 MB again. An update that has finished downloading installs when you quit Radiant.'],
      ['Radiant tells you what is new after it updates', 'Radiant updates itself quietly in the background, so features used to just appear with nothing to announce them. Now, the first time you open a version you have not run before, a short list of what changed is shown once. A brand-new install never sees it, and if several updates went by while your Mac was shut you get all of them, newest first. Settings \u203a Read me still has the full detail.'],
      ['A browser extension, so the agent works in your own Chrome', 'Settings \u203a Automation now has a small Chrome extension you install once. With it, the agent works inside the browser you are already signed into: it can list your open tabs, read the page you are looking at, take a picture of it, click things by name, and fill in fields \u2014 as you, with your logins. Chrome no longer lets any app connect to your everyday browser from outside, and it will not let Radiant install this for you either, so the panel gives you the folder and the four steps. The extension talks only to Radiant on this Mac and to nothing else; quitting Chrome or removing it unplugs it completely.'],
      ['The agent can use the Chrome you are already signed into', 'Chrome no longer lets any app attach to your everyday browser profile, so Radiant used to open a fresh, empty Chrome instead \u2014 no tabs, no extensions, signed in to nothing \u2014 and the agent would describe that one, or tell you your permissions were wrong. It now drives your real Chrome through macOS automation: it can list your open tabs, bring one to the front, read the page you are looking at, open a URL, and click things by their visible text. Ask it about \u201cmy GoDaddy tab\u201d and it can actually see it. It cannot take a picture of that browser \u2014 nothing can \u2014 so it reads the page instead and says so plainly. If macOS or Chrome needs a permission, it names the exact one.'],
      ['You can always see whether the agent is working', 'The small badge beside the agent\u2019s name says what is happening for as long as a turn is running: waiting for the model, thinking, writing, or the name of the tool it is running, with a clock. If nothing has happened for 25 seconds and no tool is running, it turns red and adds how long it has been quiet, so a stuck turn looks different from a busy one. A tool that takes minutes is not called stuck \u2014 it is named instead. There is one badge, not two.'],
      ['A turn that ends with nothing says so', 'Occasionally a model finishes a turn having produced no reply at all. That used to render as blank space, which looked exactly like Radiant losing your message. It now says the turn ended without a reply. And if the connection to a running turn drops, the chat tells you that too instead of going quiet.'],
      ['Dictate instead of typing', 'There is a Dictate button under the message box. Press it, talk, and what you say is typed into the box \u2014 press it again to stop. It uses your Mac\u2019s own speech recognition and transcribes entirely on this Mac: no audio is sent to Apple, to Radiant, or anywhere else, and it works with no internet connection. The first time, macOS asks permission for the microphone and for speech recognition; if either is off you get a message saying which one and where to turn it on. Dictation uses the microphone of the Mac running Radiant, so the button is not shown when you are connected to a shared Radiant on another Mac. Anything already typed is kept \u2014 dictation adds to it rather than replacing it.'],
      ['Chat rows hold still while an agent works', 'Hovering a chat in the sidebar while an agent was typing made its tooltip flicker rapidly. Each row was being rebuilt from scratch on every word the agent produced, which threw away the hover dozens of times a second. Rows are now updated in place \u2014 tooltips are steady, and renaming a chat no longer loses your place mid-word.'],
      ['A follow-up goes to the chat you typed it in', 'If you typed a follow-up while an agent was still working and then switched to another chat, that follow-up was sent into whichever chat you had just opened \u2014 so a conversation answered a question meant for a different one, and a brand-new chat could refuse with "a turn is already running". It now goes only to the chat it was typed in, and is abandoned if you leave.'],
      ['Turns say why they stopped', 'When a turn ended early \u2014 hitting its limit of 30 rounds of tool use, or falling back because a model cannot take tools \u2014 Radiant said so and then erased it: the message was only streamed, never saved, so it vanished the moment the turn finished and the chat looked like it had just stopped. Those notes stay in the conversation now.'],
      ['The composer is text, not a row of buttons', 'Every control under the message box \u2014 the model, tools, computer, plan, permissions \u2014 wore a permanent outlined pill, so six of them competed for attention before you touched any. They are plain text now; the chip appears when you hover one, or while its panel is open. A control that is switched on says so in color rather than filling itself in, and the labels were made readable as text, since they are no longer sitting inside a button.'],
      ['The agent gets a Chrome of its own', 'Computer control used to open a throwaway Chrome \u2014 no extensions, signed in to nothing \u2014 so an agent asked to look at a page saw an empty browser. Settings \u2192 Automation now opens a second Chrome with a profile that persists: sign in to what the agent needs once, in that window, and it stays signed in. Your everyday Chrome is never touched. Chrome refuses to be driven on your normal profile at all since version 136, which is why it has to be a separate window.'],
      ['Settings tells the truth about screen permissions', 'The Automation screen used to say "Screen Recording and Accessibility are granted \u2014 ready to use" whenever it could find its own helper file, which is always. It never asked macOS. So it claimed everything was fine while screenshots came back showing only your wallpaper and clicks went nowhere \u2014 and there was no way to tell which of the two permissions was missing. It now asks macOS and lists them separately, naming the one to fix.'],
      ['The model selector blooms open', 'Picking a model now wipes open from the button instead of appearing all at once \u2014 a frosted panel that unfolds downward, its rows arriving in sequence, with the thinking level last. Providers still collapse and expand exactly as before, Escape closes it, and Reduce Motion turns all of it off.'],
      ['No more "0 GB" downloads', 'Some model repos do not tell Hugging Face how big their files are, and Radiant was turning that silence into a number: a real multi-gigabyte download offered as "0 GB \u00b7 ~2 GB RAM". It now says the size is unknown, sorts those last, and does not pretend to judge whether they fit.'],
      ['A finished task list folds itself away', 'When an agent works through a checklist, the list stayed open above the composer for the rest of the conversation \u2014 five struck-through lines you had already read. It collapses to a single "Tasks \u2713 5/5" line the moment the last item is done. Click it any time to open it back up, and it stays open once you do.'],
      ['Newest activity at the top', 'The Activity panel added each tool call to the bottom and never scrolled, so watching a long turn meant scrolling down again after every call. It runs newest first now.'],
      ['You can see when an agent is working', 'A turn can run for minutes on tool calls with nothing else on screen, and the only sign of life was the word "working" in gray beside the model name. There is a live badge now: a pulsing dot, what it is doing right this second \u2014 thinking, or the name of the tool it is running \u2014 and a clock counting how long the turn has been going. Tony: "id also like some sort of indicator that an agent is working."'],
      ['Answering a question the agent asks', 'When an agent stops to ask you something, the answers were solid blue buttons \u2014 and since each answer is usually a whole sentence, they came out as fat blocks shouting over the question itself. They are quiet stacked rows now, each only as wide as its own text, with a single highlight that travels to whichever one you are on. Arrow keys move it and Enter picks, so you never have to reach for the mouse.'],
      ['Set how hard a model thinks', 'Radiant never asked models for a thinking level \u2014 every one ran at whatever its provider defaults to, and there was no way to see or change it. Open the model selector in the composer and it is at the bottom: Auto, Low, Medium, High, with the highlight sized to whichever word you picked. Auto behaves exactly as before, sending nothing, so models that do not reason are unaffected. It is remembered per chat, and if a model cannot take a level Radiant quietly runs it at the default rather than failing the turn.'],
      ['Tool results say what actually happened', 'A run used to report "\u2715 9 failed" when most of those were not failures. An agent looking for a file and not finding it is how searching works, and a tool you declined is your decision, not a fault \u2014 but both looked identical to a real error. The summary now separates them: real errors still say failed, searches that came up empty say "found nothing", and ones you turned down say "declined".'],
            ['The Settings window moves on its own', 'Settings was opened as a child of the main window, which on macOS means it is glued to it \u2014 always floating on top, and dragged along whenever you moved the main window. It is an ordinary window now: put it where you like, send it behind, move either one without the other. It still closes when you close Radiant.'],
      ['Quieter project and agent headings', 'The headings in the sidebar \u2014 your project names, "No project", "Archived", agent names \u2014 were semibold. They are regular weight now; the slightly larger size and brighter text still mark them as headings.'],
      ['Copy tells you it copied', 'The Copy buttons in Settings \u2192 Devices used to look identical before and after you pressed them \u2014 the only way to know it had worked was to paste somewhere else. They now draw a checkmark and say "Copied" for a moment. Save buttons deliberately do not: saving an API key swaps that row for its "key is set" state and saving an agent closes the editor, so the change itself is already the confirmation.'],
      ['A download tells you which stage it is in', 'Bytes arriving and Ollama importing the finished file used to render as the same gray text, so the second one looked like a stall \u2014 the model is copied and hashed into Ollama\u2019s own store after the download finishes, which for a large model takes minutes. Each stage now has its own mark beside it: a pulsing dot while bytes move, a turning square while it imports.'],
      ['The context counter reacts when it changes', 'The token count sits in the corner of a busy composer and updates once a turn, which is easy to miss \u2014 exactly when it matters most, as you approach the context limit. It gives a small bump when the number changes.'],
      ['Deleting a chat for good is a hold, not a second click', 'The bin in the archive used to arm on one click and delete on the next \u2014 and a second click on a button whose meaning just changed is easy to get wrong. Now you press and hold it for about two thirds of a second while a red ring fills. Let go early and nothing happens at all. It works from the keyboard too: tab to it and hold Enter or Space. Reduce Motion stops the ring animating but does not shorten the hold, because the delay is the safety, not the decoration.'],
      ['Slow lists show their shape while they load', 'Opening a model repo used to say "Loading\u2026" while it fetched from Hugging Face. It now shows three placeholder rows in the shape of the quantizations that are coming, and download bars carry momentum instead of stepping.'],
      ['Things move like they have weight', 'Buttons, cards and tabs now respond with spring motion rather than snapping. The Chats / Agents / Tasks pill glides to the tab you picked instead of jumping. Buttons give slightly under a press and spring back. Cards lift toward the pointer. Task cards and the agent library arrive one after another rather than all at once. Copy buttons confirm themselves with a checkmark instead of saying nothing. All of it is feedback, never information \u2014 turn on Reduce Motion in macOS Accessibility settings and every bit of it stops, with nothing lost.'],
      ['The selected tab is actually visible', 'Chats / Agents / Tasks marked the current view with a near-white chip on a white strip \u2014 fine in the dark themes, close to invisible in the light ones. The selected tab now carries the accent color, the same thing that marks "current" everywhere else in Radiant, so it reads at a glance in every theme. Tony: "the active tab is barely visible."'],
      ['Devices tells you your setup in one sentence', 'Settings \u2192 Devices used to show two headings \u2014 "This Mac does the work" and "This Mac is a window onto another" \u2014 both open at once, both full of explanation, and neither saying which one you were actually in. It now opens with a single line naming both machines: "Right now this Mac is a window onto Tony\u2019s Home MBP M4", and what that means \u2014 where your chats live, where downloads land, whose screen computer control drives. Below it the two setups are cards, and the one you are in is marked Current and is the only one holding controls. Tony: "its my product and i dont 100% understand how this works or how my setup is structured."'],
      ['Changes made while an agent is working now stick', 'If you moved a chat into a project while the agent was still going, it jumped back to No Project the moment the agent stopped \u2014 and the same thing quietly undid renaming, pinning and archiving a live chat. The chat was being saved twice: once by your change, and again by the agent from a copy it had taken before you made it. The agent now keeps only the conversation and leaves everything else to you. Tony: "during a chat, i moved it into the Templeton Group project and something moved it out to No Project."'],
      ['Computer control says which Mac it will drive', 'Everything an agent does happens on the Mac running Radiant \u2014 reading files, running commands, and computer control. If you use Radiant on one Mac from another, that means the mouse that moves, the keys that get typed and the screen that is captured all belong to the other machine, which you may not be sitting at or even able to see. Nothing said so before. The computer button in the composer now names that Mac while it is switched on, its tooltip says whose desktop is being driven, and Settings \u2192 Automation does the same.'],
      ['The HUD counts running chats, not just tasks', 'The floating HUD (\u2325\u2318R) listed only cards from the Tasks board, so an agent working away in an ordinary chat left it reading "Nothing running" while your screen showed otherwise. It now lists live chats alongside board tasks, and clicking one opens that chat.'],
      ['Tooltips read straight', 'The longer tooltips \u2014 the HUD button, agent tools, computer control, permissions \u2014 were centered, which turned every multi-line one into ragged text that looked like a mistake. They are left-aligned now, and the HUD tooltip is shorter and tucked under its button instead of spilling across the window.'],
      ['Models say which Mac they are going to', 'If you use Radiant on one Mac from another, the Models screen was describing the wrong machine: the chip, the memory, the free disk and the installed list all belong to the Mac running Radiant, but every label said "this Mac." Downloads land there too, and keep going even if you close the window. It now names that Mac \u2014 "On Tony\u2019s Home MBP M4 \u00b7 6 installed" \u2014 and says so plainly before you start a download. Tony, on where a model ends up: "correct. thats what confused me."'],
      ['Model lists collapse by provider everywhere', 'Picking a model in the agent editor, in Settings \u2192 Default model, and in Compare used to mean scrolling one long list of every model you have. Those are the same grouped, searchable list the chat window uses now: providers collapsed by default, the one you are already on open, and a search box that expands everything as you type. Choosing no model at all \u2014 Session default, or no planner \u2014 is still the first thing in the list.'],
      ['Put the built-in agents back, as themselves', 'Settings \u2192 Agents \u2192 Browse library lists every built-in you have removed, at the top, under "Removed from your agents". Each one now shows its own icon, its real name and what it actually does \u2014 before this they were all the same gray robot with a name unpicked from a filename, so you were being asked to restore something you could not recognize. Click one to bring it back exactly as it shipped, or use "Restore all" to bring back the lot in one go. Nothing you wrote is affected: restoring puts back the original, and your own agents are untouched.'],
      ['Removing an agent finally sticks', 'If you removed built-in agents and later found them all back, this was why, and it was not you. Radiant records which built-ins you removed, but that record lived in a file any part of the app could overwrite with an older copy of itself \u2014 and once the record was gone, the next launch put every agent back. It matters most if your Radiant folder is in iCloud and shared with a second Mac, because then two machines write that file. Removals are merged rather than overwritten now, so one machine cannot undo the other.'],
      ['Tasks and the HUD have some depth', 'Needs you is the only column where nothing happens until you act, so it is the only place color is spent \u2014 but only while something is actually waiting there. When that column is empty it looks like every other column; the moment a task lands in it, a wash runs down the column, its label picks up the accent, and the card gets a marked edge. A column that glowed all the time was just decoration, and you would stop noticing it on the day it mattered. In the HUD that row glows faintly and its dot breathes. Everything else gets depth instead: a lit top edge on the columns, a shadow under each card, a slight lift as you hover, and some light in the progress bar. All the movement stops if your Mac is set to Reduce Motion; the color and depth stay, because those are what carry the meaning.'],
      ['The agent editor reads properly now', 'The skills list was a wrapping row of differently sized items \u2014 three or four per line at ragged intervals, with the \u201call agents\u201d tags pushing the next name along. It is a tidy grid of columns now, with the tags kept to their own space. Agent tools and Computer control sit apart from the skills, because they are permissions rather than skills, and the buttons have their own row with room around them. Removing an agent also updates the rest of the app straight away \u2014 before, only the Settings window noticed, so the sidebar and the model pickers kept showing an agent you had just removed.'],
      ['Remove agents you don\u2019t use', 'Radiant ships with a set of built-in agents and most people use two or three. You can now remove the rest: open an agent in Settings \u2192 Agents and choose Remove. It stays gone after a restart, and your chats with it are untouched. Nothing is lost \u2014 every built-in you remove is listed at the top of the agent library, one click from coming back. Before this the built-ins could not be deleted at all, so the list only ever grew.'],
      ['A HUD that floats above your other apps', 'Press \u2325\u2318R, or the HUD button at the top of the sidebar, and a small window appears above whatever you are working in. It lists only what is happening right now: tasks an agent is working on, and anything waiting on you \u2014 which sorts to the top, because it is the only kind of row where nothing moves until you act. Click one and Radiant comes forward with that chat open. It stays visible over full-screen apps, and closes when you close Radiant. If it loses contact with Radiant it says so rather than sitting there looking idle.'],
      ['Steer a task while it is running', 'A task that is working, or waiting on you, now has a Steer button on its card. Type what you want instead and it goes into that task\u2019s chat \u2014 no need to find the conversation first. If the agent is in the middle of a turn your message waits and lands the moment that turn finishes, the same way a follow-up typed into the composer does. Queued tasks have no Steer, because nothing is running yet to redirect.'],
      ['Devices no longer describes the wrong Mac', 'When this Mac is showing another Mac\u2019s Radiant, Settings \u2192 Devices used to fill in \u201cThis Mac does the work\u201d with the OTHER Mac\u2019s address, token and sharing switch \u2014 because that Mac is the one answering. It read as a contradiction, and the switch would have turned off sharing on the very Mac you were connected to, cutting your own connection. That half now says plainly whose settings you are looking at and offers no controls until you disconnect.'],
      ['Move a chat to a project from its row', 'Hover any chat and the first control is a folder. Click it and pick a project \u2014 or \u201cNo project\u201d to take it out of one. It used to be a drop-down box wide enough to spell out the project\u2019s name, which ate most of a 248px row and left the chat title squeezed. The folder is the same one the project rows use, and it picks up your accent color when the chat is already in a project \u2014 so you can see where a chat lives without opening anything.'],
      ['Closing a chat archives it now', 'The button at the end of a chat row is an archive box \u2014 a box with an arrow going into it \u2014 because that is what it does. It used to be a \u2715, which every app on earth uses for delete, so the one control that KEEPS your chat looked like the one that destroys it. Inside the archive the buttons are a box with an arrow coming out (restore) and a bin (delete for good). The \u2715 used to delete outright \u2014 every message and tool call gone, behind one confirm, on a button sitting next to rename. It now archives instead: the chat leaves the sidebar and collects in an Archived group at the bottom, one click from coming back. It stays searchable the whole time, so an agent looking through your past work still finds it. Deleting permanently still exists: hold the bin, either next to Archive or inside the archive. Thanks to Justin Sail, who noticed after leaving a multi-hour review in a chat and seeing how close that \u2715 was to the paperclip.'],
      ['A board for work you hand off', 'Tasks, next to Chats in the sidebar. Write what needs doing, pick an agent or a model, and it runs as its own chat \u2014 so everything you already know about chats applies to it. The columns are Queued, Working, Needs you, Review and Done. Only the first and last are yours to drag: the middle three are set by the run itself, so a card cannot claim progress the agent did not make. A card in Working shows the agent\u2019s own checklist and the step it is on, and one lands in Needs you the moment the agent asks a question or wants permission. That column is the point of the board \u2014 until now, work waiting on you was invisible unless you happened to be looking at that chat. Choosing who does it uses the same list as the chat composer: grouped by provider, collapsed until you open one, and searchable, with your agents as their own group at the top. The sidebar switcher reads Chats \u00b7 Agents \u00b7 Tasks.'],
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
      ['Voice can now use Google\u2019s Gemini Live as well as OpenAI', 'Settings \u2192 Voice has a choice of who does the talking. OpenAI\u2019s GPT-Live is about 5\u00a2 a minute; Google\u2019s Gemini 3.8 Live is about half a cent a minute for what you say and 1.8\u00a2 for what it says back, and can keep talking while Radiant works rather than going quiet. Both behave identically in every way that matters: they listen and speak, and hand every real request back to Radiant so your own model, tools and approvals do the work \u2014 the conversation is the only thing that leaves your Mac. Gemini needs its own key from Google AI Studio; an OpenAI key does not work for it, and the key stays on your Mac \u2014 the app hands the browser only a short-lived token that lasts one call. You can also pick the voice and choose between the fast model and the one that reasons more.'],
      ['Radiant\u2019s own housekeeping runs on a cheap model, and is counted', 'After every reply Radiant quietly makes a few more model calls for itself \u2014 naming the chat, noting anything worth remembering, drafting a skill idea, and summarizing when a conversation gets long. Those ran on whatever model the chat was using, so an expensive model was being paid top rates to write a one-line note, and none of it appeared in the token counter. They now run on the cheapest model the same provider offers, and what they spend is shown in the counter\u2019s tooltip under its own heading. Settings \u2192 Models \u2192 Background work lets you choose the model yourself.'],
      ['Connected services come along only when a message needs them', 'If you have connected a service such as Linear under Settings \u2192 MCP servers, every message you sent used to carry the full list of everything that service can do \u2014 for Linear, sixty-nine commands \u2014 even when you were asking about a bug in your code. That made every message bigger and slower than it needed to be. Radiant now asks a tiny, quick helper first: does this message need Linear? If not, it stays out of the way. Once you have used a service in a conversation it stays available for the rest of it, and if the agent ever needs one it was not given, it will say so and ask you to mention it. There is a switch in Settings \u2192 MCP servers if you would rather always include everything.'],
      ['On a Claude subscription, long jobs now cost about a quarter of what they did', 'When an agent works through a job it goes back to the model many times \u2014 once per step. The model remembers the earlier steps cheaply if each visit repeats the previous one exactly and only adds what is new. Radiant was rebuilding the whole conversation on every step instead, so the model had to read all of it again at full price every time. Measured on the same tasks, Radiant was paying about four times what Claude Code paid for the same answers. Each step now adds to the last one, and the difference shows up in your usage: the \u201c% cached\u201d number in the counter goes up, and the bill goes down. Nothing to switch on.'],
      ['Your answer to an agent\u2019s question stays on the page', 'When an agent paused to ask you something and you picked an answer, the answer vanished: the agent carried on as if you had replied, but your reply was folded into a collapsed row of tool calls where nobody would look. Tony: \u201cmy reply did not appear but the agent answered it.\u201d The question and your answer now sit in the conversation where they happened, your answer marked as yours.'],
      ['A ChatGPT sign-in now uses the prompt cache \u2014 the same chats cost a fraction', 'With a ChatGPT subscription, Radiant was sending every round of a conversation as if it were brand new: the fixed part of the prompt \u2014 tools, instructions, the conversation so far \u2014 was billed in full on every model call, because each call carried a different session id and OpenAI could not match it to the one before. A benchmark of Radiant against other coding tools caught it: one 13-round task read 286,000 input tokens and 0 from the cache. Every call in a chat now carries the same id, and the cached share shows in the counter. The same fix on a Claude subscription: the cached share was being counted but never reported, so \u201c% cached\u201d never appeared there \u2014 it does now.'],
      ['The token counter now says how much was cached', 'A chat\u2019s token count could look alarming for a reason that was never explained: an agent re-sends the whole conversation to the model on every round of its work, so a chat holding 150,000 tokens can legitimately report millions of input tokens across a day \u2014 that is the loop working, not a leak. What decides whether it costs anything is how much the provider served from its own prompt cache, at a fraction of the price. Radiant was reading that number and discarding it. The counter beside the composer now shows the cached share, and its tooltip spells out why the input number counts every round, so an expensive chat can be told apart from a busy one.'],
      ['Local models no longer let a chat grow to a quarter of a million tokens', 'Ollama decides how big a local model\u2019s context is from the memory it finds \u2014 on a Mac with 48 GB or more it loads 256K and reserves all of it, which is how one model can take tens of gigabytes. Radiant used to treat that whole number as the point to start trimming, so a local chat could grow toward 262,000 tokens and be re-sent in full every round, which is painfully slow long before it breaks. Radiant now fills 32K of a local model\u2019s context before it starts trimming older tool results, and Settings \u2192 Models \u2192 Local model context lets you raise that (or turn it off and use whatever Ollama loaded). That setting is about what Radiant SENDS; the memory the model reserves is Ollama\u2019s own Settings \u2192 Context length, and the same page now shows what Ollama currently has loaded and how big its context is, so you can see which one needs changing.'],
      ['Find more models on Hugging Face, from your iPhone', 'The Models page on the phone ends with a search box. Type a name \u2014 \u201cllama 3.2\u201d, \u201cqwen 4bit\u201d, \u201cgemma\u201d \u2014 and Radiant searches Hugging Face for models in the MLX format it runs. Before you download anything, each result is checked the way the built-in list is: whether the engine has a loader for that kind of model, whether its weights really are what its description says (a mismatch there fails after a 3 GB download, so it is caught first), and whether it fits the memory of this particular phone. You get the same green, amber or red label as the catalogue \u2014 Runs well, Runs tight, Won\u2019t fit \u2014 or a plain reason it cannot run. Download installs it beside the built-in models, with the same progress, stop, chat and remove. The search is not filtered \u2014 anything published in a format the phone can run will show up, uncensored and abliterated builds included; they are other people\u2019s models, and one with its safety training removed will say anything. The keyboard no longer covers the search box: any field near the foot of a screen now scrolls up clear of it.'],
      ['Subscriptions', 'Sign in with a subscription instead of an API key (Settings → Providers): Claude, ChatGPT, Nous Portal, xAI (Grok), Qwen, and GitHub Copilot — Copilot unlocks GPT, Claude, and Gemini models through your plan.'],
      ['Ready-to-add providers', 'One-tap presets for DeepSeek, Kimi, GLM, MiniMax, Mistral, Groq, Together, Fireworks, Cerebras, Perplexity, Gemini, Ollama Cloud, and Vercel AI Gateway — just paste a key.'],
      ['MiniMax', 'MiniMax is now one of the presets, on the Mac, on Linux and on the iPhone. It gives you MiniMax-M3, which holds a million tokens of context, and the M2 series at around 200,000 — the context meter in the composer knows both, so a long chat on M3 shows how much room is actually left instead of nothing at all. One thing worth knowing before you paste a key: MiniMax runs two separate platforms, an international one and a mainland-China one, and they do not share accounts. A key from one simply does not work on the other, and what you see when that happens is a plain sign-in failure that looks exactly like a mistyped key. The preset is the international one, so a key from platform.minimax.io just works. If yours came from the China platform, use the Add provider row at the bottom of this list — any name you like, and https://api.minimaxi.com/v1 as the base URL — and paste your key into that one instead. That workaround is a Mac and Linux one: the iPhone has no Add provider row, so on the phone MiniMax needs a key from the international platform.'],
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
      ['Auto mode gets a second opinion', 'With shell approval set to Auto, Radiant runs safe-looking commands without asking. The rule list knows the obvious ones (rm -rf, sudo, pushes). Now a quick decision model also reads each command it is about to run silently, with the folder and what you asked for, and pauses it if it could destroy data, send private data out, change the machine, or change files outside the project \u2014 things like \u201cgit checkout -- .\u201d or \u201cgit stash drop\u201d that the rules called safe. The approval card says why it paused. It can only make Radiant ask more, never less. Needs an OpenRouter key; without one, Auto works as before.'],
      ['Files & commands', 'Read, write, and edit files and run shell commands in the workspace folder. Toggle with the “tools” pill; command runs ask for approval.'],
      ['Set the workspace folder', 'Click the folder chip at the top of a chat to choose which folder the agent works in — it opens a native folder picker.'],
      ['Permissions', 'The composer’s permissions pill sets how much the agent can do without asking — Ask each (confirm every command), Auto approve (low-risk runs silently, risky ones still ask), or Allow all (never ask). MCP tools and computer control always ask under Auto approve, even when they are harmless — only Allow all skips those prompts too. Flip it to Allow all for an unattended long build.'],
      ['Background jobs', 'Long builds, test watchers, and dev servers run in the background so the agent keeps working and checks on them.'],
      ['Terminal', 'A real terminal in the activity panel (top-right icon).'],
      ['Preview \u2014 a window on what the agent makes', 'The panel on the right (top-right icon) has one menu at its top \u2014 Activity, Terminal, Preview, For you. Preview shows the newest thing the chat produced that a browser can draw: a web page, an image, a diagram, a Markdown document, a PDF \u2014 or a dev server the agent started, the moment it prints a localhost address. A file is shown again when it changes on disk; a dev server refreshes itself. Chips above the frame let you flip between everything the chat has produced, and the address field takes any URL or file path, so it is also just a viewer.'],
      ['For you \u2014 which chats are waiting on you', 'For you, in the same menu, carries a count. It lists every chat that needs you: a command waiting for approval, a question the agent asked, or a reply that finished while you were looking at another chat. Click a row to go there. \u21e7\u2318I opens the list and jumps to the first one.'],
      ['Computer control (🖥)', 'Let a vision model drive the browser and desktop. Basic automation is on by default; full automation is an opt-in checkbox in Settings → Automation.'],
      ['Design Mode (◎)', 'Point at any element in the agent’s browser and capture its HTML, CSS, and a screenshot straight into the chat, so the agent can match or rework a design.'],
      ['Website → API', 'The agent can watch a site’s network calls and turn its hidden API into a reusable HTTP client (a built-in skill).'],
      ['MCP', 'Connect Model Context Protocol servers in Settings → MCP to give agents extra tools.'],
      ['Skills', 'Drop a skill file into Settings → Skills (or type one) to inject house rules the agent follows — globally or per agent.'],
      ['If a Mac shows no projects', 'Settings → Devices → “Where it is now”. If Radiant says nothing there is syncing, press “Fix this folder” — it stands up a folder iCloud will actually sync, copies your setup in, and keeps the old one alongside.'],
      ['Skill library', 'Settings → Skills → Skill library holds 270 ready-made skills that ship with Radiant, grouped and searchable — languages and frameworks, design, data, security, research and more. Search it, read the whole skill before you add it, and added skills start switched off.'],
      ['Upload a skill folder', 'A skill can be a folder — a SKILL.md with notes and references beside it. Upload one in Settings → Skills. Radiant refuses any folder containing a runnable file, and names it: a skill is read, never executed.'],
      ['Pin the models you use', 'In a chat, open the model picker and click the star beside a model. Pinned models sit in their own group at the top. Pins are per-Mac — a model this Mac cannot run is not worth pinning on it.'],
      ['Models that can see', 'Five vision models are in the iPhone catalogue — FastVLM, Qwen 2 VL, LFM2 VL, Qwen 2.5 VL, and SmolVLM2 Video, which reads a short clip. Download one and a picture button appears beside the composer: attach a screenshot, a receipt, a whiteboard, and ask about it. Text-only models do not show the button, because a picture sent to one is thrown away without a word.'],
      ['Apple Intelligence on iPhone', 'On an iPhone that supports Apple Intelligence, Radiant can answer straight away using Apple\u2019s own on-device model — no download, no key, no network. It is the model a brand new install starts on, and it stays in the switcher afterwards. Downloading one of Radiant\u2019s own models replaces it as the default.'],
      ['Delete a session on iPhone', 'Swipe a row left in Recent Sessions and tap Delete. There is no confirmation — the swipe is the confirmation — and no undo yet, so it goes immediately.'],
      ['Get a skill onto your iPhone', 'Settings → Skills on the phone. Write one, paste a SKILL.md straight in, import a .md from Files or iCloud Drive, or pull short ones across from your Mac (its address and token are on the Mac at Settings → Devices). Anything longer than 900 characters is refused rather than cut in half.'],
      ['Use a skill for one message', 'Type / in the composer, pick a skill, and the command goes in the box. It applies to that message only. Works the same on iPhone — and on iPhone the Skill button above the composer opens the same list, with “Edit skills…” at the bottom to write your own.'],
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
      ['The icons are Apple\u2019s', 'Every icon in the app \u2014 the gear, the sidebar toggle, the microphone, the folder, the composer\u2019s tool switches \u2014 is now the same symbol macOS draws in its own apps, at a weight that sits evenly beside the text. They take the color of whatever they are on, so a switch that is on still reads as on. Nothing moved; it just looks like it belongs on a Mac.'],
      ['Themes', 'Fourteen palettes plus colors you pick yourself, in light / medium / dark (bottom-left toggle). Agents can follow the accent or carry their own color.'],
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
  { id: 'chrome', label: 'Chrome' },
  { id: 'voice', label: 'Voice' },
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
          {tab === 'mcp' && <McpPane config={config} onConfigChange={onConfigChange} onSettings={onSettings} />}
          {tab === 'memory' && <MemoryPane config={config} onSettings={onSettings} />}
          {tab === 'devices' && <DevicesPane config={config} />}
          {tab === 'appearance' && <AppearancePane config={config} onSettings={onSettings} />}
          {tab === 'chrome' && <ChromePane />}
          {tab === 'voice' && <VoicePane config={config} onSettings={onSettings} onConfigChange={onConfigChange} />}
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

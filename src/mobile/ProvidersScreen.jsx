/**
 * Providers — API keys, kept in the Keychain.
 *
 * The key itself is written straight to the native SecureStore plugin and is
 * never read back into this screen. The UI only ever knows WHICH providers have
 * a key, never what it is: a secret that is never rendered cannot be leaked by
 * a screenshot, a log line, or a crash report.
 *
 * Adding a key expands the row rather than pushing a screen. Pasting a key is
 * one field and one button, and a whole screen for that would be ceremony.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { deviceWord } from './device.js'
import usePress from './usePress.js'
import {
  PROVIDERS, connectedProviders, saveKey, removeKey, looksWrong,
  fetchModels, loadChosen, saveChosen, shortModelName, providerById
} from './providers.js'

function ModelPick ({ id, on, onPick }) {
  const press = usePress(onPick, { label: `${id}${on ? ', selected' : ''}`, haptic: 'selection' })
  return (
    <span className={'rx-model-pill' + (on ? ' is-on' : '') + press.className} {...press.handlers}>
      {id}
    </span>
  )
}

function Provider ({ p, connected, chosen, onChoose, onChanged }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [models, setModels] = useState([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelError, setModelError] = useState(null)
  const [filter, setFilter] = useState('')

  // A saved key is only worth something if it actually reaches the vendor, so
  // the list doubles as the proof: models arriving IS the key working, and the
  // vendor's own refusal is a better message than any we could invent.
  useEffect(() => {
    let alive = true
    if (!connected) { setModels([]); setModelError(null); return }
    setLoadingModels(true); setModelError(null)
    fetchModels(p)
      .then(list => { if (alive) setModels(list) })
      .catch(e => { if (alive) setModelError(e?.message || 'Could not reach this provider.') })
      .finally(() => { if (alive) setLoadingModels(false) })
    return () => { alive = false }
  }, [connected, p])

  const head = usePress(() => { setOpen(o => !o); setError(null); setValue('') }, {
    label: `${p.name}${connected ? ', connected' : ''}`,
    expanded: open
  })

  const save = useCallback(async () => {
    const problem = looksWrong(p, value)
    if (problem) { setError(problem); return }
    setBusy(true)
    try {
      await saveKey(p.id, value)
      setValue(''); setOpen(false); setError(null)
      await onChanged()
    } catch (e) {
      setError(e?.message || 'Could not save that key.')
    } finally { setBusy(false) }
  }, [p, value, onChanged])

  const forget = useCallback(async () => {
    setBusy(true)
    try { await removeKey(p.id); setOpen(false); await onChanged() } finally { setBusy(false) }
  }, [p, onChanged])

  const saveBtn = usePress(save, { label: 'Save key', disabled: busy || !value.trim() })
  const forgetBtn = usePress(forget, { label: `Remove ${p.name} key`, disabled: busy })

  return (
    <>
      <div className={'rx-row rx-pressable' + head.className} {...head.handlers}>
        <div className="rx-row-text">
          <div className="rx-headline">{p.name}</div>
          <div className="rx-row-blurb">{p.hint}</div>
        </div>
        {connected && <span className="rx-provider-on">Connected</span>}
      </div>

      {connected && models.length > 0 && (() => {
        // ⚠️ OPENROUTER RETURNS HUNDREDS. Tony: "it presented me with an endless
        // list of modles i had to scroll forever through." Rendering all of them
        // as chips is not a list, it is a wall — so it filters, and until you
        // type it shows a short head rather than everything.
        const q = filter.trim().toLowerCase()
        const matched = q ? models.filter(m => m.toLowerCase().includes(q)) : models
        const shown = q ? matched.slice(0, 60) : matched.slice(0, 12)
        return (
          <div className="rx-provider-modelbox">
            <input
              className="rx-field rx-provider-filter"
              type="search"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder={`Search ${models.length} models`}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label={`Search ${p.name} models`}
            />
            <div className="rx-provider-models">
              {shown.map(m => {
                const on = chosen?.providerId === p.id && chosen?.model === m
                return <ModelPick key={m} id={m} on={on} onPick={() => onChoose(p.id, m)} />
              })}
            </div>
            {matched.length > shown.length && (
              <p className="rx-provider-note">
                {matched.length - shown.length} more — keep typing to narrow it down.
              </p>
            )}
            {q && matched.length === 0 && (
              <p className="rx-provider-note">Nothing matches “{filter.trim()}”.</p>
            )}
          </div>
        )
      })()}

      {connected && loadingModels && (
        <p className="rx-provider-note">Asking {p.name} what it can run…</p>
      )}
      {connected && modelError && <p className="rx-provider-error">{modelError}</p>}

      {open && (
        <div className="rx-provider-edit">
          <input
            className="rx-field"
            type="password"
            value={value}
            onChange={e => { setValue(e.target.value); setError(null) }}
            placeholder={connected ? 'Paste a new key to replace' : 'Paste your API key'}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck="false"
            /* a key is not a password to remember; offering to save it in the
               password manager just puts a second copy somewhere else */
            autoComplete="off"
          />
          {error && <p className="rx-provider-error">{error}</p>}
          <div className="rx-provider-buttons">
            <span className={'rx-provider-save' + saveBtn.className} {...saveBtn.handlers}>
              {busy ? 'Saving…' : connected ? 'Replace key' : 'Save key'}
            </span>
            {connected && (
              <span className={'rx-provider-forget' + forgetBtn.className} {...forgetBtn.handlers}>
                Remove
              </span>
            )}
          </div>
        </div>
      )}
    </>
  )
}

export default function ProvidersScreen ({ onStartChat }) {
  const [connected, setConnected] = useState([])
  const [chosen, setChosen] = useState(() => loadChosen())

  const refresh = useCallback(async () => {
    setConnected(await connectedProviders())
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const choose = useCallback((providerId, model) => {
    const next = chosen?.providerId === providerId && chosen?.model === model
      ? null                        // tapping the chosen one clears it
      : { providerId, model }
    setChosen(next)
    saveChosen(next)
  }, [chosen])

  return (
    <>
      {/* ⚠️ PICKING A MODEL USED TO BE A DEAD END. Tony: "i selected one. now
          what? how do i start a chat with that model?" Nothing on this screen
          said what the selection meant, and every other screen still named an
          on-device model — so the choice was invisible AND silently in force.
          It now says what it did and offers the obvious next step. */}
      {chosen && (
        <div className="rx-chosen-banner">
          <div className="rx-chosen-text">
            <div className="rx-headline">{shortModelName(chosen.model)}</div>
            <div className="rx-row-blurb">
              Answering your chats, through {providerById(chosen.providerId)?.name || chosen.providerId}.
            </div>
          </div>
          <button
            type="button"
            className="rx-chosen-go"
            onClick={() => onStartChat?.()}
          >
            Start chat
          </button>
        </div>
      )}

      <p className="rx-section-footer rx-provider-intro">
        Keys are held in the {deviceWord()}&rsquo;s Keychain, never in the app&rsquo;s own
        storage, and never leave the device except to the provider they belong to.
      </p>

      <div className="rx-group">
        {PROVIDERS.map(p => (
          <Provider
            key={p.id}
            p={p}
            connected={connected.includes(p.id)}
            chosen={chosen}
            onChoose={choose}
            onChanged={refresh}
          />
        ))}
      </div>

      <h2 className="rx-section-header">Not here yet</h2>
      <p className="rx-section-footer">
        ChatGPT Plus and GitHub Copilot sign in through a flow that redirects to
        the machine running it, which a phone cannot answer. Claude Pro and Nous
        Portal subscriptions can work on {deviceWord()} and are not built yet.
      </p>
    </>
  )
}

export { ProvidersScreen }

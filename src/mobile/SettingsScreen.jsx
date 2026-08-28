/**
 * Settings — the phone's own, not a port of the Mac's.
 *
 * The Mac's Settings is enormous and most of it is meaningless here: MCP
 * servers, model providers, agent editors and window behaviour all assume a
 * desktop with a filesystem. What DOES carry across is everything about how the
 * app looks, what it is holding, and where it connects — so that is this first
 * pass, and the rest of parity (providers and API keys, agents, subscription
 * usage) lands on top of this screen rather than beside it.
 *
 * Sections are the iOS grouped-list idiom because Settings is the one screen
 * where matching the platform IS the design — a person looking for a control
 * should find it where every other app puts it.
 */
import React, { useCallback, useState } from 'react'
import { deviceWord } from './device.js'
import usePress from './usePress.js'
import { BrandMark } from './BrandSpinner.jsx'
import { THEMES, TEXT_SIZES, MODES, OPEN_TO, applyAppearance, swatch } from './theme.js'

const GB = 1e9
const fmt = (b) => (b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`)

function Row ({ label, value, onTap, destructive }) {
  const press = usePress(() => onTap?.(), { label, disabled: !onTap })
  return (
    <div
      className={'rx-row' + (onTap ? ' rx-pressable' : '') + press.className}
      {...(onTap ? press.handlers : {})}
    >
      <div className="rx-row-text">
        <div className={'rx-headline' + (destructive ? ' rx-destructive' : '')}>{label}</div>
      </div>
      {value != null && <span className="rx-set-value">{value}</span>}
    </div>
  )
}

/** A downloaded model: what it is, what it weighs, and its own way out. */
function ModelRow ({ model, busy, onRemove }) {
  const press = usePress(onRemove, {
    label: `Remove ${model.name}, ${Number(model.sizeGB).toFixed(1)} GB`,
    haptic: 'MEDIUM',
    disabled: busy
  })
  return (
    <div className="rx-row">
      <div className="rx-row-text">
        <div className="rx-headline">{model.name}</div>
      </div>
      <span className="rx-set-value">{Number(model.sizeGB).toFixed(1)} GB</span>
      <span className={'rx-row-remove' + press.className} {...press.handlers}>
        Remove
      </span>
    </div>
  )
}

function Swatch ({ theme, selected, onPick }) {
  const press = usePress(() => onPick(theme.id), {
    label: `${theme.name}${selected ? ', selected' : ''}`,
    haptic: 'selection'
  })
  return (
    <span
      className={'rx-swatch' + (selected ? ' is-on' : '') + press.className}
      {...press.handlers}
      style={{ '--sw': swatch(theme) }}
    >
      <span className="rx-swatch-dot" aria-hidden="true" />
      <span className="rx-swatch-name">{theme.name}</span>
    </span>
  )
}

export default function SettingsScreen ({
  appearance, onAppearance, local = {}, models = [], onReadMe, onProviders, onSkills,
  onGetModels, version
}) {
  const [busy, setBusy] = useState(false)
  const downloaded = models.filter(m => m?.downloaded)
  const used = downloaded.reduce((n, m) => n + Math.round((Number(m.sizeGB) || 0) * GB), 0)

  const pick = useCallback((themeId) => {
    const next = { ...appearance, themeId }
    applyAppearance(next)
    onAppearance?.(next)
  }, [appearance, onAppearance])

  const setOpenTo = useCallback((openTo) => {
    const next = { ...appearance, openTo }
    applyAppearance(next)
    onAppearance?.(next)
  }, [appearance, onAppearance])

  const setMode = useCallback((mode) => {
    const next = { ...appearance, mode }
    applyAppearance(next)
    onAppearance?.(next)
  }, [appearance, onAppearance])

  const size = useCallback((textScale) => {
    const next = { ...appearance, textScale }
    applyAppearance(next)
    onAppearance?.(next)
  }, [appearance, onAppearance])

  const removeOne = useCallback(async (m) => {
    if (busy) return
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Remove ${m.name}? That frees ${Number(m.sizeGB).toFixed(1)} GB. You can download it again later.`)) return
    setBusy(true)
    try { await local.remove?.(m.id) } finally { setBusy(false) }
  }, [busy, local])

  const clearAll = useCallback(async () => {
    if (!downloaded.length || busy) return
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Remove ${downloaded.length} model${downloaded.length > 1 ? 's' : ''} and free ${fmt(used)}?`)) return
    setBusy(true)
    for (const m of downloaded) { await local.remove?.(m.id) }
    setBusy(false)
  }, [downloaded, used, local, busy])

  return (
    <>
      <h2 className="rx-section-header">Open to</h2>
      <div className="rx-group rx-seg">
        {OPEN_TO.map(o => (
          <SegItem key={o.id} label={o.name} on={o.id === appearance.openTo} onPick={() => setOpenTo(o.id)} />
        ))}
      </div>
      <p className="rx-section-footer">
        Whether Radiant opens on Home or straight back into the conversation you
        were last having.
      </p>

      <h2 className="rx-section-header">Appearance</h2>
      <div className="rx-group rx-seg">
        {MODES.map(m => (
          <SegItem key={m.id} label={m.name} on={m.id === appearance.mode} onPick={() => setMode(m.id)} />
        ))}
      </div>
      <p className="rx-section-footer">
        Radiant opens dark unless you change this. The welcome screen stays dark
        either way — it is a branded moment, like the launch screen.
      </p>

      <h2 className="rx-section-header">Color</h2>
      <div className="rx-group rx-swatches">
        {THEMES.map(t => (
          <Swatch key={t.id} theme={t} selected={t.id === appearance.themeId} onPick={pick} />
        ))}
      </div>
      <p className="rx-section-footer">
        The color runs through the whole app — buttons, the glow behind the
        logo, and the ring while a model downloads.
      </p>

      <h2 className="rx-section-header">Text size</h2>
      <div className="rx-group rx-seg">
        {TEXT_SIZES.map(t => {
          const on = t.id === appearance.textScale
          return <SegItem key={t.id} label={t.name} on={on} onPick={() => size(t.id)} />
        })}
      </div>
      <p className="rx-section-footer">
        Rides on top of the system text size rather than replacing it, so
        Accessibility settings still win.
      </p>

      <h2 className="rx-section-header">Models</h2>
      <div className="rx-group">
        <Row label={`On this ${deviceWord()}`} value={`${downloaded.length} · ${fmt(used)}`} />
        {/* the way OUT of this screen to the one that adds a model — Settings
            listed what you had and offered no route to getting more */}
        <Row label="Download a model" onTap={onGetModels} />
        {/* Each model can be removed on its own — but the row does NOT delete
            on tap. It used to, looking exactly like the inert row above it,
            with no confirmation and no undo. The delete is its own labelled,
            red control at the trailing edge, and it confirms. */}
        {downloaded.map(m => (
          <ModelRow
            key={m.id}
            model={m}
            busy={busy}
            onRemove={() => removeOne(m)}
          />
        ))}
        {downloaded.length > 0 && (
          <Row label={busy ? 'Removing…' : 'Remove all models'} destructive onTap={clearAll} />
        )}
      </div>
      {downloaded.length === 0 && (
        <p className="rx-section-footer">Nothing downloaded yet.</p>
      )}

      <h2 className="rx-section-header">Skills</h2>
      <div className="rx-group">
        <Row label="Skills" onTap={onSkills} />
      </div>
      <p className="rx-section-footer">
        Short instructions you can apply to a message — how to answer, not what to do.
        Pick one from the composer when you want it.
      </p>

      <h2 className="rx-section-header">Providers</h2>
      <div className="rx-group">
        <Row label="API keys" onTap={onProviders} />
      </div>
      <p className="rx-section-footer">
        Bring your own key for Anthropic, OpenAI, OpenRouter and others. Kept in
        the {deviceWord()}&rsquo;s Keychain.
      </p>

      <h2 className="rx-section-header">About</h2>
      <div className="rx-group">
        <Row label="Read me" onTap={onReadMe} />
        {/* ⚠️ APPLE REQUIRES THE POLICY REACHABLE FROM THE BINARY, not only from
            the App Store listing. Opened in Safari rather than a web view: an
            in-app browser showing our own privacy policy is the kind of detail a
            reviewer reads as evasive, and the system browser makes the domain
            visible in the address bar.

            ⚠️ THE .html IS LOAD-BEARING. templetongroup.dev answers 200 for
            unknown paths and serves the HOMEPAGE — the extensionless
            /showcase/radiant/privacy returns 327 KB of the wrong page. Verified
            live: with .html it is the real 7 KB policy. */}
        <Row label="Privacy policy" onTap={openPrivacy} />
        <Row label="Version" value={version || '—'} />
      </div>
      <div className="rx-about-mark">
        <BrandMark size={44} />
        <p className="rx-about-line">Radiant is a Templeton&nbsp;Technologies product.</p>
      </div>
    </>
  )
}

const PRIVACY_URL = 'https://www.templetongroup.dev/showcase/radiant/privacy.html'

/** Open in the system browser, so the address bar shows whose policy it is. */
function openPrivacy () {
  try {
    const browser = window.Capacitor?.Plugins?.Browser
    if (browser?.open) { browser.open({ url: PRIVACY_URL }); return }
  } catch { /* fall through */ }
  window.open(PRIVACY_URL, '_blank', 'noopener')
}

function SegItem ({ label, on, onPick }) {
  const press = usePress(onPick, { label, haptic: 'selection' })
  return (
    <span className={'rx-seg-item' + (on ? ' is-on' : '') + press.className} {...press.handlers}>
      {label}
    </span>
  )
}

export { SettingsScreen }

/**
 * Skills — the library.
 *
 * A skill here is a short instruction that rides at the front of the prompt.
 * The phone has no workspace and no tools, so there is nothing else a skill
 * could usefully be: see the note at the top of skills.js for why this is a
 * different library from the Mac's rather than the same one on a smaller
 * screen.
 *
 * Editing happens in the row, not on a pushed screen. A name and a few
 * sentences do not warrant navigation, and the same decision is already made
 * for adding an API key in ProvidersScreen.
 */
import React, { useCallback, useEffect, useState } from 'react'
import usePress from './usePress.js'
import { listSkills, saveSkill, deleteSkill, onSkillsChanged, MAX_SKILL_CHARS,
  parseSkillMarkdown, fetchMacSkills, readMac, saveMac } from './skills.js'

function Editor ({ skill, onDone, onCancel }) {
  const [name, setName] = useState(skill?.name || '')
  const [body, setBody] = useState(skill?.body || '')
  const left = MAX_SKILL_CHARS - body.length
  const save = usePress(() => {
    if (!name.trim() || !body.trim()) return
    saveSkill({ id: skill?.id, name, body })
    onDone?.()
  }, { label: 'Save skill', disabled: !name.trim() || !body.trim() })
  const cancel = usePress(() => onCancel?.(), { label: 'Cancel' })

  return (
    <div className="rx-skill-edit">
      <input
        className="rx-skill-name"
        placeholder="Name — e.g. Plain English"
        value={name}
        maxLength={60}
        onChange={e => setName(e.target.value)}
      />
      <textarea
        className="rx-skill-body"
        placeholder="What the model should do. One or two sentences works best."
        value={body}
        maxLength={MAX_SKILL_CHARS}
        rows={5}
        onChange={e => setBody(e.target.value)}
      />
      {/* ⚠️ THE COUNT IS NOT DECORATION. Every character here is taken from a
          4,000-character prompt budget that also has to hold the conversation,
          and a small model follows a short instruction far better than a long
          one. The warning starts well before the hard limit. */}
      <div className={'rx-skill-count' + (left < 200 ? ' is-tight' : '')}>
        {left < 200
          ? `${left} characters left — shorter instructions work better here`
          : `${body.length} characters`}
      </div>
      <div className="rx-skill-actions">
        <span className={'rx-skill-cancel' + cancel.className} {...cancel.handlers}>Cancel</span>
        <span className={'rx-skill-save' + save.className} {...save.handlers}>Save</span>
      </div>
    </div>
  )
}

function SkillRow ({ skill, onEdit, onDelete }) {
  const press = usePress(onEdit, { label: `Edit ${skill.name}` })
  const del = usePress(onDelete, { label: `Delete ${skill.name}`, haptic: 'MEDIUM' })
  return (
    <div className={'rx-row rx-pressable' + press.className}>
      <div className="rx-row-text" {...press.handlers}>
        <div className="rx-headline">{skill.name}</div>
        <div className="rx-row-blurb">{skill.body}</div>
      </div>
      <span className={'rx-row-remove' + del.className} {...del.handlers}>Delete</span>
    </div>
  )
}

/**
 * Paste a SKILL.md straight in.
 *
 * The smallest of the three imports and the one that always works: no file
 * system, no network, no permissions. Parses the frontmatter so a real
 * SKILL.md keeps its name instead of arriving as one wall of text.
 */
function PasteImport ({ onDone, onCancel }) {
  const [text, setText] = useState('')
  const parsed = text.trim() ? parseSkillMarkdown(text) : null
  const canSave = Boolean(parsed?.name && parsed?.body && !parsed.tooLong)
  const save = usePress(() => {
    if (!canSave) return
    saveSkill({ name: parsed.name, body: parsed.body })
    onDone?.()
  }, { label: 'Add skill' })
  const cancel = usePress(() => onCancel?.(), { label: 'Cancel' })

  return (
    <div className="rx-skill-edit">
      <textarea
        className="rx-skill-body"
        placeholder={'Paste a skill here — a SKILL.md, or just the instructions.'}
        value={text}
        rows={8}
        onChange={e => setText(e.target.value)}
      />
      {parsed && (
        <div className={'rx-skill-count' + (parsed.tooLong ? ' is-tight' : '')}>
          {/* ⚠️ REFUSE, DO NOT TRIM. A skill cut in half still looks like a
              skill and quietly stops working. */}
          {parsed.tooLong
            ? `${parsed.length} characters — ${parsed.length - MAX_SKILL_CHARS} too many. Shorten it before adding.`
            : `“${parsed.name || 'Untitled'}” · ${parsed.length} characters`}
        </div>
      )}
      <div className="rx-skill-actions">
        <span className={'rx-skill-cancel' + cancel.className} {...cancel.handlers}>Cancel</span>
        <span className={'rx-skill-save' + save.className + (canSave ? '' : ' is-off')} {...save.handlers}>Add</span>
      </div>
    </div>
  )
}

/**
 * Bring skills over from the Mac.
 *
 * ⚠️ MOST OF THEM CANNOT COME. A Mac library skill's text is one line pointing
 * at a folder this device does not have, so it is listed and disabled with the
 * reason rather than imported as an instruction aimed at nothing.
 */
function MacImport ({ onDone, onCancel }) {
  const [mac, setMac] = useState(readMac)
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [taken, setTaken] = useState([])

  const connect = usePress(async () => {
    setBusy(true); setErr(''); setRows(null)
    try {
      const list = await fetchMacSkills(mac.base, mac.token)
      saveMac(mac)
      setRows(list)
      if (!list.length) setErr('That Mac has no skills yet.')
    } catch (e) {
      const m = String(e.message || e)
      setErr(m === 'bad_address' ? 'That does not look like an address. Try 100.x.y.z:5834.'
        : m === 'unauthorized' ? 'The Mac refused that token. Copy it again from Settings → Devices on the Mac.'
        : 'Could not reach that Mac. Check both are on Tailscale and Radiant is open on the Mac.')
    }
    setBusy(false)
  }, { label: 'Connect' })

  const cancel = usePress(() => onCancel?.(), { label: 'Cancel' })
  const done = usePress(() => onDone?.(), { label: 'Done' })

  const take = (r) => {
    saveSkill({ name: r.name, body: r.body })
    setTaken(t => [...t, r.id])
  }

  return (
    <div className="rx-skill-edit">
      {!rows && <>
        <input
          className="rx-skill-name"
          placeholder="Your Mac — 100.x.y.z:5834"
          value={mac.base}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={e => setMac(m => ({ ...m, base: e.target.value }))}
        />
        <input
          className="rx-skill-name"
          placeholder="Sharing token"
          value={mac.token}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={e => setMac(m => ({ ...m, token: e.target.value }))}
        />
        <div className="rx-skill-count">
          Both on the Mac at Settings → Devices, where sharing is turned on.
        </div>
      </>}

      {err && <div className="rx-skill-count is-tight">{err}</div>}

      {rows && rows.map(r => {
        const already = taken.includes(r.id)
        return (
          <MacRow key={r.id} row={r} already={already} onTake={() => take(r)} />
        )
      })}

      <div className="rx-skill-actions">
        <span className={'rx-skill-cancel' + cancel.className} {...cancel.handlers}>Cancel</span>
        {rows
          ? <span className={'rx-skill-save' + done.className} {...done.handlers}>Done</span>
          : <span className={'rx-skill-save' + connect.className} {...connect.handlers}>{busy ? 'Connecting…' : 'Connect'}</span>}
      </div>
    </div>
  )
}

function MacRow ({ row, already, onTake }) {
  const press = usePress(() => { if (!row.reason && !already) onTake() }, { label: `Add ${row.name}` })
  return (
    <div className={'rx-mac-row' + (row.reason ? ' is-off' : '') + press.className} {...(row.reason ? {} : press.handlers)}>
      <div className="rx-row-text">
        <div className="rx-headline">{row.name}</div>
        <div className="rx-row-blurb">{row.reason || row.body}</div>
      </div>
      <span className="rx-mac-take">{row.reason ? '—' : already ? '✓' : 'Add'}</span>
    </div>
  )
}

export default function SkillsScreen () {
  const [skills, setSkills] = useState(() => listSkills())
  const [editing, setEditing] = useState(null)   // skill object, or 'new' | 'paste' | 'mac', or null
  const [note, setNote] = useState('')
  const fileRef = React.useRef(null)

  const refresh = useCallback(() => setSkills(listSkills()), [])
  useEffect(() => onSkillsChanged(refresh), [refresh])

  const add = usePress(() => { setNote(''); setEditing('new') }, { label: 'New skill' })
  const paste = usePress(() => { setNote(''); setEditing('paste') }, { label: 'Paste a skill' })
  const fromMac = usePress(() => { setNote(''); setEditing('mac') }, { label: 'Import from your Mac' })

  /**
   * ⚠️ A PLAIN FILE INPUT, ON PURPOSE. In the app's web view this opens iOS's
   * own document picker, which already browses Files and iCloud Drive — no
   * native code, no extra permission, and it works in a browser too so the
   * harness can drive it. Receiving a .md from another app's share sheet is a
   * separate thing and is NOT what this does.
   */
  const onFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const parsed = parseSkillMarkdown(await file.text(), file.name)
      if (!parsed.body) { setNote('That file had nothing in it.'); return }
      if (parsed.tooLong) {
        setNote(`“${parsed.name}” is ${parsed.length} characters — ${parsed.length - MAX_SKILL_CHARS} too many for the phone. Shorten it and try again.`)
        return
      }
      saveSkill({ name: parsed.name, body: parsed.body })
      setNote(`Added “${parsed.name}”.`)
      refresh()
    } catch { setNote('That file could not be read.') }
  }
  const fromFile = usePress(() => fileRef.current?.click(), { label: 'Import from a file' })

  return (
    <>
      <p className="rx-screen-intro">
        A skill is a short instruction the model follows for a message. Pick one from the
        composer when you want it — nothing here changes your other chats.
      </p>

      {editing === 'new' && <Editor onDone={() => { setEditing(null); refresh() }} onCancel={() => setEditing(null)} />}
      {editing === 'paste' && <PasteImport onDone={() => { setEditing(null); refresh() }} onCancel={() => setEditing(null)} />}
      {editing === 'mac' && <MacImport onDone={() => { setEditing(null); refresh() }} onCancel={() => setEditing(null)} />}

      {/* ⚠️ ONE GROUP UNDER A HEADER, THE WAY SETTINGS IS BUILT. The four ways in
          were a lone blue pill plus a group that then collided with the list
          below it. Tony: "awful spacing on the skill buttons." A header gives
          the separation and says what the group is for. */}
      {!editing && <>
        <h2 className="rx-section-header">Add a skill</h2>
        <div className="rx-group">
          <div className={'rx-row rx-pressable' + add.className} {...add.handlers}>
            <div className="rx-row-text"><div className="rx-headline">Write one</div></div>
          </div>
          <div className={'rx-row rx-pressable' + paste.className} {...paste.handlers}>
            <div className="rx-row-text"><div className="rx-headline">Paste a skill</div></div>
          </div>
          <div className={'rx-row rx-pressable' + fromFile.className} {...fromFile.handlers}>
            <div className="rx-row-text"><div className="rx-headline">Import from a file</div></div>
          </div>
          <div className={'rx-row rx-pressable' + fromMac.className} {...fromMac.handlers}>
            <div className="rx-row-text"><div className="rx-headline">Import from your Mac</div></div>
          </div>
        </div>
        <input ref={fileRef} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden onChange={onFile} />
      </>}
      {note && <p className="rx-screen-intro">{note}</p>}

      {!editing && <h2 className="rx-section-header">Your skills</h2>}
      <div className="rx-group">
        {skills.length === 0 && (
          <div className="rx-row"><div className="rx-row-text">
            <div className="rx-row-blurb">No skills yet. Add one above.</div>
          </div></div>
        )}
        {skills.map(s => (
          editing && editing !== 'new' && editing.id === s.id
            ? <Editor key={s.id} skill={s} onDone={() => { setEditing(null); refresh() }} onCancel={() => setEditing(null)} />
            : <SkillRow
                key={s.id}
                skill={s}
                onEdit={() => setEditing(s)}
                onDelete={() => { deleteSkill(s.id); refresh() }}
              />
        ))}
      </div>
    </>
  )
}

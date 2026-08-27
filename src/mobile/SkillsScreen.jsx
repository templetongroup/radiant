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
import { listSkills, saveSkill, deleteSkill, onSkillsChanged, MAX_SKILL_CHARS } from './skills.js'

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

export default function SkillsScreen () {
  const [skills, setSkills] = useState(() => listSkills())
  const [editing, setEditing] = useState(null)   // skill object, or 'new', or null

  const refresh = useCallback(() => setSkills(listSkills()), [])
  useEffect(() => onSkillsChanged(refresh), [refresh])

  const add = usePress(() => setEditing('new'), { label: 'New skill' })

  return (
    <>
      <p className="rx-screen-intro">
        A skill is a short instruction the model follows for a message. Pick one from the
        composer when you want it — nothing here changes your other chats.
      </p>

      {editing === 'new'
        ? <Editor onDone={() => { setEditing(null); refresh() }} onCancel={() => setEditing(null)} />
        : <div className={'rx-skill-add' + add.className} {...add.handlers}>New skill</div>}

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

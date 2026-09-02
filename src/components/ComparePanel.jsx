import React, { useState } from 'react'
import { api, streamChat } from '../api.js'
import Markdown from './Markdown.jsx'
import { ModelPicker } from './Chat.jsx'

// Send one prompt to two models and stream their answers side by side.
export default function ComparePanel ({ models, onClose }) {
  const [a, setA] = useState(models[0]?.provider + '|' + models[0]?.id || '')
  const [b, setB] = useState(models[1] ? models[1].provider + '|' + models[1].id : (models[0]?.provider + '|' + models[0]?.id || ''))
  const [prompt, setPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const [out, setOut] = useState({ a: '', b: '' })

  const runOne = async (key, val) => {
    const [provider, id] = val.split('|')
    const s = await api.createSession({ provider, model: id, useTools: false })
    try {
      await streamChat(s.id, prompt, ev => {
        if (ev.type === 'text_delta') setOut(o => ({ ...o, [key]: o[key] + ev.text }))
        else if (ev.type === 'error') setOut(o => ({ ...o, [key]: o[key] + `\n\n⚠ ${ev.message}` }))
      })
    } finally { api.deleteSession(s.id).catch(() => {}) }
  }

  const run = async () => {
    if (!prompt.trim() || running) return
    setRunning(true); setOut({ a: '', b: '' })
    await Promise.all([runOne('a', a), runOne('b', b)])
    setRunning(false)
  }

  const label = val => { const [, id] = val.split('|'); return id }
  return (
    <div className='modal-backdrop' onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className='compare'>
        <div className='compare-head'>
          Compare models
          <button className='icon-btn' onClick={onClose} style={{ marginLeft: 'auto' }}>✕</button>
        </div>
        <div className='compare-cols'>
          {[['a', a, setA], ['b', b, setB]].map(([key, val, setVal]) => (
            <div className='compare-col' key={key}>
              <div className='model-pick-field' style={{ marginBottom: 8 }}>
                  <ModelPicker
                    session={{ model: val.split('|')[1], provider: val.split('|')[0] }}
                    models={models}
                    placeholder='Pick a model'
                    onPick={m => setVal(m.provider + '|' + m.id)}
                    onRefresh={() => {}}
                  />
                </div>
              <div className='compare-out'>
                {out[key] ? <Markdown text={out[key]} /> : <span className='activity-empty'>{running ? 'Thinking…' : 'Response appears here'}</span>}
              </div>
            </div>
          ))}
        </div>
        <div className='compare-composer'>
          <textarea rows={2} placeholder='Ask both models the same thing…' value={prompt} onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run() } }} />
          <button className='send-btn' onClick={run} disabled={running || !prompt.trim()} title='Compare'>↑</button>
        </div>
      </div>
    </div>
  )
}

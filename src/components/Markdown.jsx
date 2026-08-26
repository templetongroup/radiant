import React, { useMemo, useRef, useEffect } from 'react'
import { marked } from 'marked'
import hljs from 'highlight.js'
import DOMPurify from 'dompurify'
import { saveToFile } from '../api.js'

marked.setOptions({
  highlight: (code, lang) => {
    try {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value
      return hljs.highlightAuto(code).value
    } catch { return code }
  }
})

const renderer = new marked.Renderer()
renderer.code = ({ text, lang }) => {
  let html
  try {
    html = lang && hljs.getLanguage(lang)
      ? hljs.highlight(text, { language: lang }).value
      : hljs.highlightAuto(text).value
  } catch { html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;') }
  // ⚠️ THE LANGUAGE HAS TO SURVIVE THE RENDER. Artifacts are decided by it, and
  // it was being thrown away here — the <pre> that came out could not be told
  // apart from any other block.
  // ⚠️ A data-* ATTRIBUTE DOES NOT SURVIVE SANITISING HERE. Tagging the <pre>
  // with data-lang looked right and arrived stripped, so previews never appeared
  // and nothing errored. A class on the <code> is the conventional place for
  // this and passes through untouched.
  const tag = String(lang || '').toLowerCase().replace(/[^a-z0-9+-]/g, '')
  return `<pre><code class="hljs${tag ? ` language-${tag}` : ''}">${html}</code></pre>`
}

// ---- artifacts --------------------------------------------------------------
//
// ⚠️ AGENT OUTPUT IS UNTRUSTED, AND SO IS ANYTHING IT EMBEDS. A previewed HTML
// artifact goes into an iframe with sandbox="allow-scripts" and deliberately
// WITHOUT allow-same-origin: the two together would let the page reach this
// app's own origin, its localStorage, and the API on 127.0.0.1 that needs no
// token from here. Scripts run so the artifact is actually useful; the document
// stays in an opaque origin so a page that a model was talked into writing
// cannot read anything of the user's.
//
// Mermaid renders in this document rather than an iframe — it emits SVG and
// sanitises at securityLevel 'strict' — so diagrams inherit the app's fonts and
// theme instead of arriving as a pale rectangle.
const PREVIEWABLE = new Set(['html', 'svg', 'mermaid'])
let mermaidLib = null
let mermaidSeq = 0

async function renderMermaid (code, host, dark) {
  if (!mermaidLib) {
    const mod = await import('mermaid')
    mermaidLib = mod.default
  }
  mermaidLib.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' })
  const { svg } = await mermaidLib.render('rad-mmd-' + (++mermaidSeq), code)
  host.innerHTML = svg
  return svg
}

function frameFor (lang, code) {
  const body = lang === 'svg'
    ? `<div style="display:flex;align-items:center;justify-content:center;min-height:100%">${code}</div>`
    : code
  const doc = `<!doctype html><html><head><meta charset="utf-8">` +
    `<style>html,body{margin:0;padding:12px;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#fff;color:#111}</style>` +
    `</head><body>${body}</body></html>`
  const f = document.createElement('iframe')
  f.className = 'artifact-frame'
  f.setAttribute('sandbox', 'allow-scripts')   // no allow-same-origin — see above
  f.setAttribute('referrerpolicy', 'no-referrer')
  f.srcdoc = doc
  return f
}

function langOf (pre) {
  const cls = pre.querySelector('code')?.className || ''
  const m = /(?:^|\s)language-([a-z0-9+-]+)/i.exec(cls)
  return m ? m[1].toLowerCase() : null
}

function attachArtifact (pre) {
  const lang = langOf(pre)
  if (!PREVIEWABLE.has(lang) || pre.querySelector('.artifact-btn')) return
  const code = pre.querySelector('code')?.innerText || pre.innerText
  if (!code.trim()) return

  const btn = document.createElement('button')
  btn.className = 'artifact-btn'
  btn.type = 'button'
  btn.textContent = lang === 'mermaid' ? 'Diagram' : 'Preview'
  pre.appendChild(btn)

  let panel = null
  let lastSvg = null
  btn.addEventListener('click', async () => {
    if (panel) {
      panel.remove(); panel = null
      btn.textContent = lang === 'mermaid' ? 'Diagram' : 'Preview'
      return
    }
    panel = document.createElement('div')
    panel.className = 'artifact-panel'
    const bar = document.createElement('div')
    bar.className = 'artifact-bar'
    const label = document.createElement('span')
    label.textContent = lang === 'mermaid' ? 'Diagram' : lang.toUpperCase() + ' preview'
    bar.appendChild(label)

    const big = document.createElement('button')
    big.type = 'button'; big.className = 'artifact-act'; big.textContent = 'Bigger'
    big.addEventListener('click', () => panel.classList.toggle('is-big'))
    bar.appendChild(big)

    const save = document.createElement('button')
    save.type = 'button'; save.className = 'artifact-act'; save.textContent = 'Save…'
    bar.appendChild(save)

    const host = document.createElement('div')
    host.className = 'artifact-body'
    panel.appendChild(bar); panel.appendChild(host)
    pre.insertAdjacentElement('afterend', panel)
    btn.textContent = 'Hide'

    if (lang === 'mermaid') {
      try {
        const dark = !document.documentElement.classList.contains('light')
        lastSvg = await renderMermaid(code, host, dark)
      } catch (e) {
        host.innerHTML = ''
        const err = document.createElement('div')
        err.className = 'artifact-err'
        err.textContent = 'That diagram could not be drawn: ' + (e?.message || e)
        host.appendChild(err)
      }
    } else {
      host.appendChild(frameFor(lang, code))
    }

    save.addEventListener('click', async () => {
      const isSvg = lang === 'mermaid' || lang === 'svg'
      const name = isSvg ? 'diagram.svg' : 'artifact.html'
      const content = lang === 'mermaid' ? (lastSvg || code) : code
      try {
        const where = await saveToFile(name, isSvg ? 'image/svg+xml' : 'text/html', content)
        save.textContent = where ? 'Saved' : 'Save…'
        setTimeout(() => { save.textContent = 'Save…' }, 1600)
      } catch { save.textContent = 'Could not save' }
    })
  })
}

export default function Markdown ({ text }) {
  const ref = useRef(null)
  const html = useMemo(() => {
    const raw = marked.parse(text || '', { renderer, breaks: true })
    return DOMPurify.sanitize(raw)
  }, [text])

  // add a copy button to every code block after render
  useEffect(() => {
    const root = ref.current
    if (!root) return
    root.querySelectorAll('pre').forEach(pre => {
      if (pre.querySelector('.code-copy')) return
      const btn = document.createElement('button')
      btn.className = 'code-copy'
      btn.type = 'button'
      btn.textContent = 'Copy'
      btn.addEventListener('click', async () => {
        const code = pre.querySelector('code')?.innerText || pre.innerText
        let ok = false
        try { await navigator.clipboard.writeText(code); ok = true } catch {}
        if (ok) {
          btn.textContent = 'Copied'
          setTimeout(() => { btn.textContent = 'Copy' }, 1400)
        } else {
          // clipboard blocked — select the code so the user can just press ⌘C
          const range = document.createRange()
          range.selectNodeContents(pre.querySelector('code') || pre)
          const sel = window.getSelection()
          sel.removeAllRanges(); sel.addRange(range)
          btn.textContent = 'Press ⌘C'
          setTimeout(() => { btn.textContent = 'Copy' }, 1800)
        }
      })
      pre.appendChild(btn)
      attachArtifact(pre)
    })
    // open links in the external browser — Electron denies in-window navigation,
    // so a plain <a> click does nothing. Intercept and open via the OS.
    const onLinkClick = e => {
      const a = e.target.closest('a[href]')
      if (!a || !root.contains(a)) return
      const href = a.getAttribute('href') || ''
      if (!href || href.startsWith('#')) return
      e.preventDefault()
      window.open(href, '_blank', 'noopener,noreferrer')
    }
    root.addEventListener('click', onLinkClick)
    return () => root.removeEventListener('click', onLinkClick)
  }, [html])

  return <div className='md' ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
}

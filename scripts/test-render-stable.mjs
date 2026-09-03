/**
 * A component declared inside another component is a NEW COMPONENT TYPE on every
 * render, and React does not update a different type — it unmounts the old tree
 * and mounts a new one.
 *
 * Shipped consequence (2026-09-03): SessionRow lived inside Sidebar, so while a
 * turn streamed — App re-renders per token — every chat row was destroyed and
 * rebuilt dozens of times a second. Tony: "while an agent is typing, if i hover
 * over a different chat the tooltips flicker over and over very rapidly." The
 * row under the pointer kept being replaced, so :hover was lost and re-acquired
 * and the tooltip restarted its entry animation each time. Playwright could not
 * complete a single hover: "element was detached from the DOM, retrying."
 *
 * It is invisible in a screenshot and invisible in the code unless you are
 * looking for it, which is why it is checked here instead of being remembered.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const roots = ['src', 'src/components', 'src/mobile']
const files = []
for (const r of roots) {
  let names = []
  try { names = readdirSync(r) } catch { continue }
  for (const n of names) if (n.endsWith('.jsx')) files.push(join(r, n))
}

// A definition indented at least two spaces whose name is Capitalised and whose
// body returns JSX — i.e. a component, nested inside something else.
const DEF = /^(\s+)(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\s*=\s*(?:React\.)?(?:memo\()?\s*(?:\(|function\b)|^(\s+)function\s+([A-Z][A-Za-z0-9_]*)\s*\(/

const offenders = []
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n')
  lines.forEach((line, i) => {
    const m = DEF.exec(line)
    if (!m) return
    const name = m[2] || m[4]
    // Look ahead a little: a component renders JSX. A plain helper does not.
    const body = lines.slice(i, i + 40).join('\n')
    if (!/<[A-Za-z]/.test(body)) return
    // useMemo/useCallback-wrapped values are not component types.
    if (/=\s*use[A-Z]/.test(line)) return
    offenders.push(`${f}:${i + 1}  ${name}`)
  })
}

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++ } else { fail++; console.log('  FAIL ' + msg) } }

ok(offenders.length === 0,
   'no component is declared inside another component — found:\n' + offenders.map(o => '         ' + o).join('\n'))

// And prove the scanner would actually catch it, using the exact shape that shipped.
const sample = `export default function Sidebar () {
  const SessionRow = ({ s }) => {
    return <div className='session-item'>{s.title}</div>
  }
  return <nav>{list.map(s => <SessionRow key={s.id} s={s} />)}</nav>
}`
const caught = sample.split('\n').some((line, i) => {
  const m = DEF.exec(line)
  if (!m) return false
  return /<[A-Za-z]/.test(sample.split('\n').slice(i, i + 40).join('\n'))
})
ok(caught, 'the scanner catches the pattern that actually shipped')

console.log(`  ${pass}/${pass + fail} passed  ·  no component type is rebuilt on every render`)
process.exit(fail ? 1 : 0)

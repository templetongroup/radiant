// The whiteboard: board logic, the agents, the chat tool, the linked chat and the Tasks bridge.
//
// Pure checks first, then a real server against a fake OpenAI-compatible model
// that answers each kind of whiteboard prompt the way a model would — prose,
// then the JSON — so the parsing is tested on the shape that actually arrives.
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  placePlan, lastJsonObject, mergeSave, normalizeBoard, routeStops, toCsv, toMarkdown, boardText,
  readAgentReply, addResult, setWhiteboardDir, saveBoard, newBoard, loadBoard, sectionOf, notesOf
} from '../server/whiteboard.js'
import { whiteboardTool, beforeChatTurn, chatState } from '../server/whiteboard-tool.js'

let pass = 0, fail = 0
const ok = (c, what) => { if (c) pass++; else { fail++; console.log('  FAIL', what) } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)) }) })

// ---------- pure ----------

const plan = { title: 'Launch', layout: 'route', sections: [
  { title: 'Prep', sticker: 'rocket', notes: [{ text: 'Write the post', action: true }, { text: 'Pick a date' }] },
  { title: 'Ship', notes: [{ text: 'Compare hosting prices', action: true }] },
  { title: 'Tell people', notes: [{ text: 'Email the list' }] }
] }
const route = placePlan(plan)
ok(route.items.filter(i => i.kind === 'group').length === 3 && route.items.filter(i => i.kind === 'note').length === 4, 'a route plan becomes 3 sections and 4 notes')
ok(route.links.filter(l => l.kind === 'road').length === 2, 'the road joins the stops in order')
const rb = normalizeBoard({ id: 'x', ...route })
ok(routeStops(rb).map(g => g.title).join() === 'Prep,Ship,Tell people', 'route stops come back in road order')
ok(notesOf(rb).every(n => sectionOf(rb, n)), 'every laid-out note sits inside its section')
ok(placePlan({ ...plan, layout: 'map' }).items.some(i => i.kind === 'text'), 'a map has its centre')
ok(placePlan({ ...plan, layout: 'nonsense' }).layout === 'columns', 'an unknown layout falls back to columns')

ok(lastJsonObject('Here you go:\n```json\n{"a": {"b": "}"}, "ok": 1}\n```\nHope that helps {not json}', o => o.ok)?.a?.b === '}', 'the last JSON object is found through fences, prose and a brace in a string')
ok(lastJsonObject('no json') === null, 'no JSON → null')
ok(readAgentReply('Did it.\n{"headline":"Prices","result":"- A: $5","sources":["https://a.com","javascript:x"]}').sources.length === 1, 'agent reply: only real links kept as sources')
ok(readAgentReply('Just prose, no JSON').title === 'Just prose, no JSON', 'agent reply without JSON still becomes a result')

// merge: a page saving an older copy must not wipe what the server added
const base = normalizeBoard({ id: 'm', rev: 5, items: [{ id: 'n1', kind: 'note', text: 'a', x: 0, y: 0 }, { id: 'n2', kind: 'note', text: 'b', x: 0, y: 200 }] })
const server = { ...base, rev: 6, items: [...base.items.map(i => i.id === 'n1' ? { ...i, mark: { state: 'doing' } } : i), { id: 'r1', kind: 'result', for: 'n1', title: 'R', text: 'x', x: 300, y: 0, rev: 6 }], proposals: [{ id: 'p1', kind: 'note', text: 'new', state: 'pending', rev: 6 }] }
const page = { ...base, items: [{ ...base.items[0], text: 'a edited' }], proposals: [] } // page deleted n2, edited n1
const merged = mergeSave(normalizeBoard(server), page, 5)
ok(merged.items.some(i => i.id === 'r1'), 'merge keeps a result the server added after the page loaded')
ok(!merged.items.some(i => i.id === 'n2'), 'merge respects a note the page deleted')
ok(merged.items.find(i => i.id === 'n1').text === 'a edited' && merged.items.find(i => i.id === 'n1').mark?.state === 'doing', 'merge keeps the page\'s edit and the server\'s status mark')
ok(merged.proposals.some(p => p.id === 'p1' && p.state === 'pending'), 'merge keeps a suggestion the page never saw')
ok(merged.rev === 7, 'every save is a new revision')

const withResult = addResult(normalizeBoard(rb), 9, { noteId: notesOf(rb)[0].id, title: 'Draft', text: 'The post' })
ok(withResult.board.links.some(l => l.kind === 'result' && l.to === withResult.card.id), 'a result is linked to its note')
const again = addResult(withResult.board, 10, { noteId: notesOf(rb)[0].id, title: 'Draft 2', text: 'Better' })
ok(again.board.items.filter(i => i.kind === 'result').length === 1, 'a second result for the same note replaces the first')

const csv = toCsv(again.board)
ok(csv.split('\n')[0] === 'section,note,action,owner,due,status,result' && /Prep,Write the post,yes/.test(csv), `CSV has a header and one row per note`)
ok(/^# Launch/.test(toMarkdown(again.board)) && /- \[ \] Write the post/.test(toMarkdown(again.board)), 'Markdown lists sections with action items as checkboxes')
ok(/\[n[0-9a-f]+\]/.test(boardText(again.board)), 'board text gives a chat the note ids')

// ---------- chat tool + linked chat (on disk, no model) ----------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radiant-wb-'))
setWhiteboardDir(tmp)
ok(/no whiteboards yet/.test(whiteboardTool({ action: 'list' }, { id: 's1' })), 'list says when there are none')
const made = whiteboardTool({ action: 'create', title: 'Trip', layout: 'columns', sections: [{ title: 'Before', notes: [{ text: 'Book flights' }] }, { title: 'During', notes: [{ text: 'Museum day' }] }] }, { id: 's1' })
ok(/Created board wb/.test(made) && /linked to this chat/.test(made), 'create makes a board linked to the chat')
const tripId = made.match(/board (wb[0-9a-f]+)/)[1]
ok(/linked_to_this_chat/.test(whiteboardTool({ action: 'list' }, { id: 's1' })), 'list marks the linked board')
const read = whiteboardTool({ action: 'read' }, { id: 's1' })
ok(/BOARD DATA START/.test(read) && /Book flights/.test(read), 'read wraps the board as data and needs no id when linked')
const trip = loadBoard(tripId)
const nid = notesOf(trip)[0].id
ok(/status mark/i.test(whiteboardTool({ action: 'propose', board: tripId, status: [{ note: nid, state: 'doing' }] }, { id: 'other' })), 'a chat that is not linked cannot set status')
ok(!loadBoard(tripId).items.find(i => i.id === nid).mark, '…and nothing was marked')
const prop = whiteboardTool({ action: 'propose', notes: [{ text: 'Pack an adapter', reason: 'UK plugs' }], status: [{ note: nid, state: 'doing', detail: 'checking fares' }] }, { id: 's1' })
ok(/1 suggestion/.test(prop) && /1 status mark/.test(prop), 'the linked chat proposes and marks')
const afterProp = loadBoard(tripId)
ok(afterProp.proposals.some(p => p.kind === 'note' && p.state === 'pending' && p.by === 'chat'), 'the proposal waits on the board')
ok(afterProp.items.find(i => i.id === nid).mark?.state === 'doing', 'the mark shows at once')

ok(/linked to the whiteboard/.test(beforeChatTurn('s1', true)), 'the linked chat is told once that the board exists')
ok(beforeChatTurn('s1', true) === '', '…and not again when nothing changed')
ok(beforeChatTurn('s1', false) === '', 'nothing is added while chat access is off')
const edited = loadBoard(tripId)
edited.items.find(i => i.id === nid).text = 'Book flights by Friday'
saveBoard(edited)
const told = beforeChatTurn('s1', true)
ok(/edited: \[n[0-9a-f]+\] "Book flights" → "Book flights by Friday"/.test(told), `a change on the board reaches the chat with the next message`)

// answer pickup from the linked chat
const fakeSession = { id: 's1', title: 'Trip chat', messages: [{ role: 'user', text: 'hi' }] }
const sessions = { s1: fakeSession }
const b2 = loadBoard(tripId)
b2.items.find(i => i.id === nid).chatAsk = { chatId: 's1', at: new Date().toISOString(), count: 1 }
saveBoard(b2)
let st = chatState(tripId, { loadSession: id => sessions[id], activeTurns: new Map() })
ok(st.linked && st.waiting === 1, 'a note waiting on the chat is counted')
fakeSession.messages.push({ role: 'user', text: 'Find flights' }, { role: 'assistant', parts: [{ type: 'text', text: 'Cheapest is $420 on Tuesday.' }] })
st = chatState(tripId, { loadSession: id => sessions[id], activeTurns: new Map() })
const picked = loadBoard(tripId)
ok(picked.proposals.some(p => p.kind === 'result' && /\$420/.test(p.text)), 'the chat\'s answer arrives as a suggested result')
ok(!picked.items.find(i => i.id === nid).chatAsk, '…and the note stops waiting')
ok(st.ended === 'done' && /\$420/.test(st.firstLine), 'the chat button shows how the last turn ended')

// ---------- live: a real server, a fake model ----------

const reply = body => {
  const msgs = JSON.stringify(body.messages || body.input || '')
  if (/laying out a whiteboard/.test(msgs)) return 'Sure.\n{"title":"Bake sale","layout":"route","sections":[{"title":"Plan","sticker":"calendar","notes":[{"text":"Find a venue nearby","action":true}]},{"title":"Promote","notes":[{"text":"Draft the flyer","action":true}]}]}'
  if (/make sense of their whiteboard/.test(msgs)) return '{"summary":"two themes","groups":[{"title":"Money","notes":["n1","n2"],"reason":"both about cost"}],"actions":[{"text":"Set a budget","source":"n1","reason":"needed first"}],"owners":[]}'
  if (/working on one item/.test(msgs)) {
    const earlier = /already delivered/.test(msgs) ? ' (built on earlier)' : ''
    return `Done.\n{"headline":"Item done","result":"- finished${earlier}","sources":["https://example.com"]}`
  }
  if (/worked through the whiteboard/.test(msgs)) return '{"headline":"Brief","result":"- all ready","sources":[]}'
  if (/answering a question about part/.test(msgs)) return '{"headline":"Answer","result":"It costs $40.","sources":[]}'
  if (/Turn one delivered result/.test(msgs)) return '{"notes":[{"text":"Call the venue","action":true,"reason":"next step"},{"text":"Print flyers","reason":"from the draft"}]}'
  return 'ok'
}
const prov = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'm1' }] })) }
    const b = JSON.parse(body)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: b.model === 'm1' ? reply(b) : 'ok' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
    res.write('data: [DONE]\n\n'); res.end()
  })
})
const [pp, pr] = [await freePort(), await freePort()]
await new Promise(r => prov.listen(pp, r))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radiant-wb-live-'))
fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ providers: [{ id: 'fakeco', name: 'FakeCo', type: 'openai', baseUrl: `http://127.0.0.1:${pp}/v1`, auth: 'key', removable: true }], keys: { fakeco: 'k' }, oauth: {}, accounts: {}, activeAccount: {}, settings: { autoCompact: false, approvalMode: 'off', whiteboard: { chatAccess: true, planProvider: 'fakeco', planModel: 'm1', agentProvider: 'fakeco', agentModel: 'm1' } } }))
const srv = spawn('node', ['server/index.js'], { env: { ...process.env, RADIANT_PORT: String(pr), RADIANT_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] })
srv.stderr.on('data', d => { const t = String(d); if (/Error|throw/.test(t)) process.stderr.write('  [server] ' + t) })
const api = async (method, url, body) => {
  const r = await fetch(`http://127.0.0.1:${pr}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  try { return { status: r.status, ...JSON.parse(t) } } catch { return { status: r.status, text: t } }
}
const settle = async id => { for (let i = 0; i < 80; i++) { const a = await api('GET', `/api/whiteboards/${id}/activity`); if (!a.running) return a; await sleep(150) } return null }
try {
  let up = false
  for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${pr}/api/config`)).ok } catch {} if (!up) await sleep(250) }
  ok(up, 'server up')

  let b = await api('POST', '/api/whiteboards', { name: 'Bake sale' })
  ok(b.id && b.rev === 1, 'a new board')
  const laid = await api('POST', `/api/whiteboards/${b.id}/layout`, { request: 'a school bake sale next month' })
  ok(laid.layout === 'route' && laid.items.filter(i => i.kind === 'note').length === 2, `one sentence becomes a laid-out route (${laid.error || laid.items?.length})`)
  b = await api('PUT', `/api/whiteboards/${b.id}`, { board: { ...b, layout: laid.layout, items: laid.items, links: laid.links }, baseRev: 1 })
  ok(b.rev === 2 && b.items.length === laid.items.length, 'the page saves it')

  // run the route: both action items, the second building on the first, then a brief
  ok((await api('POST', `/api/whiteboards/${b.id}/run`)).running, 'Run starts in the background')
  ok((await api('POST', `/api/whiteboards/${b.id}/run`)).status === 409, 'a second Run while one is going is refused')
  await settle(b.id)
  b = await api('GET', `/api/whiteboards/${b.id}`)
  const results = b.items.filter(i => i.kind === 'result')
  ok(results.length === 3, `each action item got a result, plus the brief (${results.length})`)
  ok(results.some(r => /built on earlier/.test(r.text)), 'the second stop was handed what the first delivered')
  ok(b.brief && /all ready/.test(b.brief.text), 'the brief is at the end of the road')

  // a page holding the pre-run copy saves: the results survive
  const stale = await api('PUT', `/api/whiteboards/${b.id}`, { board: { ...b, items: b.items.filter(i => i.kind !== 'result') }, baseRev: 1 })
  ok(stale.items.filter(i => i.kind === 'result').length === 3, 'a stale page save does not wipe results added after it loaded')

  // hand a single note, ask, group, unpack
  const note = b.items.find(i => i.kind === 'note')
  await api('POST', `/api/whiteboards/${b.id}/hand`, { noteIds: [note.id] }); await settle(b.id)
  b = await api('GET', `/api/whiteboards/${b.id}`)
  ok(b.items.filter(i => i.kind === 'result' && i.for === note.id).length === 1, 'Hand to Radiant replaces the note\'s result, not stacks a second')
  await api('POST', `/api/whiteboards/${b.id}/ask`, { itemIds: [note.id], question: 'What will it cost?' }); await settle(b.id)
  b = await api('GET', `/api/whiteboards/${b.id}`)
  ok(b.items.some(i => i.kind === 'result' && /\$40/.test(i.text) && /What will it cost/.test(i.text)), 'Ask: the answer lands as a card with the question on it')
  b = await api('POST', `/api/whiteboards/${b.id}/group`)
  ok(b.proposals.some(p => p.kind === 'group' && p.noteIds.length === 2) && b.proposals.some(p => p.kind === 'action'), 'Group my notes: groups and actions arrive as suggestions')
  const card = b.items.find(i => i.kind === 'result')
  const unpacked = await api('POST', `/api/whiteboards/${b.id}/unpack`, { resultId: card.id })
  ok(unpacked.proposals?.filter(p => p.kind === 'note' && p.from === card.id).length === 2, `Unpack a result: its points arrive as suggested notes (${unpacked.error || ''})`)

  const md = await fetch(`http://127.0.0.1:${pr}/api/whiteboards/${b.id}/export?format=md`)
  ok(md.headers.get('content-disposition')?.includes('Bake sale.md') && /# Bake sale/.test(await md.text()), 'export downloads Markdown named after the board')

  // Tasks bridge
  const sent = await api('POST', `/api/whiteboards/${b.id}/send-tasks`, { noteIds: [note.id] })
  const tid = sent.items.find(i => i.id === note.id).taskId
  ok(tid && sent.items.find(i => i.id === note.id).taskState === 'queued', 'Send to Tasks: one task, parked in Queued')
  const twice = await api('POST', `/api/whiteboards/${b.id}/send-tasks`, { noteIds: [note.id] })
  const allTasks = await (await fetch(`http://127.0.0.1:${pr}/api/tasks`)).json()
  ok(twice.items.find(i => i.id === note.id).taskId === tid && allTasks.filter(t => (t.labels || []).includes('whiteboard')).length === 1, 'a second click gives the same task, not a copy')
  const states = await api('GET', `/api/whiteboards/${b.id}/task-states`)
  ok(states.states[note.id] === 'queued', 'the note shows where its task is')
  const fromTasks = await api('POST', '/api/whiteboards/from-tasks')
  ok(fromTasks.taskBoard && fromTasks.items.filter(i => i.kind === 'group').length === 5 && fromTasks.items.some(i => i.taskId === tid), 'New board from Tasks: one column per state, the task in it')

  // the chat tool, from a real chat turn: the board is linked, the chat hears about it
  const s = await api('POST', '/api/sessions', { provider: 'fakeco', model: 'm1', useTools: true })
  await api('PUT', `/api/whiteboards/${b.id}`, { board: { ...(await api('GET', `/api/whiteboards/${b.id}`)), chatId: s.id }, baseRev: 999 })
  await fetch(`http://127.0.0.1:${pr}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: s.id, content: { text: 'hello' } }) }).then(r => r.text())
  const saved = await api('GET', `/api/sessions/${s.id}`)
  ok(/linked to the whiteboard "Bake sale"/.test(saved.messages[0].text), 'a linked chat is told about its board with the first message')
  const cs = await api('GET', `/api/whiteboards/${b.id}/chat`)
  ok(cs.linked && cs.ended === 'done' && !cs.working, 'the board sees the chat\'s last turn')
} finally {
  srv.kill(); prov.close()
}

console.log(`\n${pass}/${pass + fail} passed  ·  whiteboard: layout, agents, merge, chat tool, linked chat, Tasks`)
process.exit(fail ? 1 : 0)

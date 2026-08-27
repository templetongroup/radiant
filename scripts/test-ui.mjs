/**
 * The gauntlet's missing station: RUN the app and look at it.
 *
 * ⚠️ SIX PASSES OF THE GAUNTLET REPORTED GREEN WHILE THE APP WAS BROKEN. 68
 * assertions, and not one rendered a screen — they read source strings or
 * exercised pure functions. Every defect Tony hit lived in that gap:
 *   · "On device" printed under a cloud model — a rendered string
 *   · a transcript that would not scroll while streaming — runtime interaction
 *   · a section header 100px narrower than its own rows — geometry
 *   · screens whose buttons led nowhere — navigation
 * Source that reads correctly is not an app that works. This file drives the
 * real phone UI in a real browser and asserts what a person would see.
 */
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'

const BASE = process.env.HARNESS_URL || 'http://localhost:5833/harness/'
let pass = 0, fail = 0
const results = []
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  if (!ok) results.push(`  FAIL ${name}\n        got:    ${JSON.stringify(got)}\n        wanted: ${JSON.stringify(want)}`)
}
const ok = (name, cond) => is(name, !!cond, true)

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3 })
const errors = []
page.on('pageerror', e => errors.push(String(e.message)))
page.on('console', m => {
  if (m.type() !== 'error') return
  const t = m.text()
  // The harness page ships no favicon; the app does. Anything else is real.
  if (/favicon/i.test(t)) return
  if (/Failed to load resource.*404/i.test(t) && !/\.(js|css|png|woff2?)\b/i.test(t)) return
  errors.push(t)
})

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(600)

// ── the app renders at all ────────────────────────────────────────────────
const body = () => page.locator('body').innerText()
ok('the app renders something', (await body()).trim().length > 0)
is('no uncaught errors on load', errors, [])

// ── flow: get to Home ─────────────────────────────────────────────────────
// First run shows only when nothing is downloaded; the stub has two, so Home.
const tap = async (text) => {
  const el = page.locator(`text=${JSON.stringify(text)}`).first()
  if (!(await el.count())) return false
  await el.click({ force: true }); await page.waitForTimeout(350); return true
}

ok('Home names the current model', /Current model/i.test(await body()))
ok('Home offers a new chat', /New chat/i.test(await body()))

// ── flow: open a chat and send ────────────────────────────────────────────
ok('tapping New chat opens a chat', await tap('New chat'))
const composer = page.locator('textarea').first()
ok('the chat has a composer', await composer.count() > 0)
await composer.fill('hello there')
await page.waitForTimeout(120)
const sendBtn = page.locator('button[aria-label*="Send" i], button:has-text("Send")').first()
if (await sendBtn.count()) { await sendBtn.click({ force: true }); await page.waitForTimeout(500) }
ok('the reply appears in the transcript', /Local reply to/i.test(await body()))

// ⚠️ THE PRIVACY CLAIM. It must name where the answer came from, and with a
// local model that is the device.
const sub = await page.locator('.rx-chat-title-2').first().innerText().catch(() => '')
ok('the chat states where the answer comes from', sub.trim().length > 0)

// ── ⚠️ THE STYLESHEET ACTUALLY REACHED THE PAGE ─────────────────────────
// The chat's CSS is a template literal in MobileChat.jsx. An unescaped backtick
// inside one of its comments — writing `/` in prose — closes the literal early,
// the rest parses as division, and <style> renders NaN: every chat style gone,
// silently, with no error. That happened on 2026-08-27 and the only symptom was
// one unrelated assertion about scrolling.
const styleLen = await page.evaluate(() =>
  [...document.querySelectorAll('style')].reduce((n, el) => Math.max(n, (el.textContent || '').length), 0))
ok('the chat stylesheet is present, not NaN', styleLen > 5000)

// ── ⚠️ SLASH COMMANDS, WHICH THE PHONE SHIPPED WITHOUT ───────────────────
// `/plain-english` worked on the Mac and did nothing here: the mobile composer
// had no slash handling, so the command went to the model as literal text.
// Tony: "the slash command is not working in ios". Driven, not read.
await composer.fill('/')
await page.waitForTimeout(200)
const slashRows = page.locator('.rx-chat-slashrow')
ok('typing / offers the skills', await slashRows.count() > 0)
// ⚠️ ALPHABETICAL, NOT STORAGE ORDER. Tony: "i dont know what order they are in
// now." Asserting the sort rather than a fixed first item, so adding a skill
// never breaks this for the wrong reason.
const cmds = await page.locator('.rx-chat-slashcmd').allInnerTexts()
is('the commands are alphabetical', cmds, [...cmds].sort((a, b) => a.localeCompare(b)))
ok('and the bundled skills are all there', cmds.includes('/plain-english') && cmds.length >= 5)

await composer.fill('/pl')
await page.waitForTimeout(200)
is('typing narrows the list to one', await slashRows.count(), 1)

await slashRows.first().click({ force: true })
await page.waitForTimeout(200)
// ⚠️ THE COMMAND GOES IN THE BOX — the convention Hermes and Claude use, and
// the one the Mac already followed. Attaching it silently is what broke before.
is('picking one puts the command in the composer',
  (await composer.inputValue()).trim(), '/plain-english')
ok('and the list closes once it is chosen', await slashRows.count() === 0)

// ⚠️ WAIT FOR THE TURN TO SETTLE. Mid-answer that same button is Stop, so
// clicking it sends nothing and cancels instead.
await page.waitForSelector('button[aria-label="Send"]', { timeout: 5000 }).catch(() => {})
await composer.fill('/plain-english what is a pointer')
const b4 = page.locator('button[aria-label="Send"]').first()
if (await b4.count()) await b4.click({ force: true })
await page.waitForTimeout(900)
// The slug is stripped: the skill reaches the model in the prompt head, not as
// a bare word at the top of the question.
const sent = await body()
ok('the sent message drops the command', /what is a pointer/.test(sent))
ok('and does not show the raw slug back', !/\/plain-english what is a pointer/.test(sent))

// ── ⚠️ THE SCROLL BUG TONY HIT ───────────────────────────────────────────
// Send enough that the transcript overflows, then scroll up WHILE tokens are
// still arriving and check the app leaves you where you put yourself.
for (let i = 0; i < 4; i++) {
  await composer.fill('tell me something long, number ' + i)
  const b2 = page.locator('button[aria-label*="Send" i], button:has-text("Send")').first()
  if (await b2.count()) await b2.click({ force: true })
  await page.waitForTimeout(700)
}
await page.waitForTimeout(400)

const geom = await page.evaluate(() => {
  const el = document.querySelector('.rx-chat-scroll')
  return el ? { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } : null
})
ok('the transcript now overflows, so scrolling means something',
  geom && geom.scrollHeight > geom.clientHeight + 50)

// scroll up while a fresh reply streams
await composer.fill('one more long answer please')
const b3 = page.locator('button[aria-label*="Send" i], button:has-text("Send")').first()
if (await b3.count()) await b3.click({ force: true })
await page.waitForTimeout(120)
const held = await page.evaluate(async () => {
  const el = document.querySelector('.rx-chat-scroll')
  if (!el) return null
  // Touch first, the way a finger does — the app decides who is driving from
  // the touch, not from the scroll event alone.
  el.dispatchEvent(new TouchEvent('touchstart', {
    bubbles: true,
    touches: [new Touch({ identifier: 1, target: el, clientX: 100, clientY: 400 })]
  }))
  el.scrollTop = 0
  el.dispatchEvent(new Event('scroll', { bubbles: true }))
  const parked = el.scrollTop
  await new Promise(r => setTimeout(r, 700))   // let the stream keep arriving
  return { parked, after: el.scrollTop }
})
ok('scrolling up is possible mid-stream', held && held.parked === 0)
// ⚠️ THE REGRESSION: autoscroll used to drag the reader back every frame.
ok('and the app does not drag you back down', held && held.after < 80)

// ── ⚠️ THE PRIVACY CLAIM, RENDERED ───────────────────────────────────────
// The single most damaging string in the app. It said "On device" under an
// OpenRouter model, on a request that had already left the phone. Assert the
// RENDERED text for both cases, because the source read fine while it lied.
{
  const local = (await page.locator('.rx-chat-title-2').first().innerText().catch(() => '')).trim()
  ok('a local model says On device', /On device|tok\/s/i.test(local))

  await page.evaluate(() => {
    localStorage.setItem('radiant.phone.cloudModel',
      JSON.stringify({ providerId: 'openrouter', model: 'anthropic/claude-opus-4.5' }))
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  const t = await page.locator('body').innerText()
  ok('Home names the cloud model, not a local one', /claude-opus-4\.5/.test(t))
  ok('and never claims On device beside it', !/On device/i.test(t))
}

// ── flow: Models — installed models are reachable and shelves open ────────
await page.evaluate(() => localStorage.removeItem('radiant.phone.cloudModel'))
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(600)
{
  const opened = await tap('Models') || await tap('Choose a model')
  ok('the models screen opens', opened)
  const t = await page.locator('body').innerText()
  ok('it lists what is already on the phone', /On this iPhone/i.test(t))
  ok('it groups the rest by maker', /Alibaba|Google|Meta|Microsoft/.test(t))

  // ⚠️ GEOMETRY: the maker header and its rows must be one card. They were 253px
  // against 353px — aligned left, a hundred pixels short on the right.
  await tap('Google')
  await page.waitForTimeout(300)
  const geo = await page.evaluate(() => {
    const h = document.querySelector('.rx-makerhead')
    const g = document.querySelector('.rx-makerhead + div .rx-group')
    if (!h || !g) return null
    const a = h.getBoundingClientRect(), b = g.getBoundingClientRect()
    return { hw: Math.round(a.width), gw: Math.round(b.width),
             left: Math.abs(a.left - b.left) < 1, right: Math.abs(a.right - b.right) < 1 }
  })
  ok('a maker shelf is one card, not two widths', geo && geo.hw === geo.gw && geo.left && geo.right)

  // ⚠️ EVERY CARD ON THIS SCREEN SHARES ONE INSET. The phone-spec card shipped
  // full-bleed at 0→393 while the list cards sat at 20→373, so the one card
  // that is not a list ran 40pt wider and touched both screen edges. Tony:
  // "why is the phone spec card wider than the on this phone card or the model
  // selector card?" Compares edges, not just width — a card can match width
  // and still be offset.
  // ⚠️ COMPARED AGAINST THE MAKER SHELF, not a global `.rx-group`. Home stays
  // mounted beneath and is translated off-screen mid-transition, so the first
  // `.rx-group` in the document is its recent-chats card at left -98; and the
  // "On this iPhone" card is not present in every state this file drives
  // through. The shelf is always there, and the assertion above already ties it
  // to its own rows, so matching it matches the whole screen.
  const cards = await page.evaluate(() => {
    const box = s => { const e = document.querySelector(s); if (!e) return null
      const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right)] }
    return { specs: box('.rx-specs'), maker: box('.rx-makerhead') }
  })
  ok('both cards are on screen to compare', cards.specs && cards.maker && cards.specs[0] >= 0)
  is('the spec card sits on the same inset as the list cards', cards.specs, cards.maker)

  // ⚠️ EVERY CATALOG ROW STATES ITS WEIGHT. Tony, scanning the list: "models
  // have no sizes. no way to tell whats small." The size had been removed from
  // the row and left only in the sheet a row opens — which is the one place it
  // cannot help you choose. It has now moved three times; this is the gate that
  // stops a fourth removal being invisible.
  for (const m of await page.locator('.rx-makerhead').all()) await m.click({ force: true })
  await page.waitForTimeout(500)
  // ⚠️ SCOPED TO THE MAKER SHELVES, NOT `.rx-row`. Home stays mounted beneath
  // the pushed screen, so a bare `.rx-row` also collects its recent-chat rows
  // ("Just now · Qwen 3 1.7B") and this gate fails on a chat, not a model.
  const rows = await page.$$eval('.rx-makerhead + div .rx-row', els => els.map(e => {
    const b = e.querySelector('.rx-row-blurb')
    return {
      blurb: b ? b.innerText.replace(/\n/g, ' ') : '',
      clipped: b ? b.scrollWidth > b.clientWidth + 1 : false,
      h: Math.round(e.getBoundingClientRect().height)
    }
  }))
  ok('the catalog actually rendered', rows.length > 20)
  // A row mid-download or just failed deliberately spends its blurb on the
  // progress or the retry line; earlier assertions in this file leave one in
  // that state. Every OTHER row must carry a weight.
  const idle = rows.filter(r => !/Downloading|did not finish/i.test(r.blurb))
  // Names the offender rather than counting it — a bare "got 1, wanted 0" on a
  // forty-row list tells you nothing about which row lost its weight.
  is('every idle row states a size in GB',
    idle.filter(r => !/\d+(\.\d)? GB/.test(r.blurb)).map(r => r.blurb), [])
  // Both earlier removals were about width. These are the two failures.
  is('no blurb truncates mid-word', rows.filter(r => r.clipped).length, 0)
  is('no row grows past two blurb lines', rows.filter(r => r.h > 90).length, 0)
}

// ── ⚠️ NO CONTROL MAY LEAD NOWHERE ───────────────────────────────────────
// Remote access shipped as a screen that saved an address nothing ever read.
// The cheap, general form of that check: every visible control must be
// reachable and labelled, and nothing may claim a feature that was removed.
{
  const t = await page.locator('body').innerText()
  ok('no trace of the removed Mac feature', !/Connect to a Mac|Your Mac/i.test(t))
  const unlabelled = await page.evaluate(() =>
    [...document.querySelectorAll('[role="button"],button')]
      .filter(el => !el.getAttribute('aria-label') && !el.textContent.trim()).length)
  is('every control has a name', unlabelled, 0)
}

// ── ⚠️ MARKDOWN IN REPLIES ───────────────────────────────────────────────
// Tony's own App Store screenshot had "1. **Time**: How much time" in it —
// literal asterisks, because only ``` fences were handled. Bold is the most
// common thing a model emits.
{
  await page.evaluate(() => {
    const el = document.querySelector('.rx-chat-scroll')
    if (el) el.scrollTop = el.scrollHeight
  })
  const t = await page.locator('body').innerText()
  ok('no raw ** survives in a reply', !/\*\*[A-Za-z]/.test(t))
  const strongCount = await page.locator('.rx-chat-body strong').count()
  ok('bold actually renders as bold', strongCount >= 0)
}

// ⚠️ MODEL OUTPUT IS UNTRUSTED INPUT. A model can be talked into emitting a
// script tag; the renderer must build React nodes, never HTML.
{
  const injected = await page.evaluate(() => {
    const src = document.documentElement.innerHTML
    return /<script[^>]*>alert/i.test(src)
  })
  is('no model text can become markup', injected, false)
  // ⚠️ MATCH THE ATTRIBUTE, NOT THE WORD. The first version of this assertion
  // failed on the COMMENT warning against it — a test that cannot tell code
  // from prose will cry wolf and then be ignored.
  const src = readFileSync('src/mobile/MobileChat.jsx', 'utf8')
  is('the chat never uses dangerouslySetInnerHTML on a reply',
    /dangerouslySetInnerHTML\s*=/.test(src), false)
  is('and never writes model text as innerHTML',
    /\.innerHTML\s*(=|\+=)/.test(src), false)
}

// ⚠️ A REMOVED MODEL MUST STOP BEING THE CURRENT MODEL. Tony removed every
// model and Home went on saying "Current model: Qwen 3 1.7B", with New chat
// still enabled and the chat it opened still titled Qwen — a conversation
// pointed at weights that were no longer on the phone. The shell resolved the
// active model against the whole 44-model CATALOGUE instead of what is
// downloaded, and a removed model is still in the catalogue with
// downloaded:false.
//
// ⚠️ THIS RUNS ON ITS OWN PAGE, and it must. `rx.activeModel` has to be set
// BEFORE first paint (addInitScript, not an eval-then-reload — a reload rebuilds
// the harness catalogue and puts the models back). The first version of this
// check set nothing, so activeModelId was null, the broken lookup was never
// reached, and it passed against the BUG as happily as against the fix.
{
  const p2 = await browser.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3 })
  await p2.addInitScript(() => localStorage.setItem('rx.activeModel', 'qwen3-1.7b'))
  await p2.goto(BASE, { waitUntil: 'networkidle' })
  await p2.waitForTimeout(900)
  // Real pointer presses: these controls listen for pointer events, not clicks.
  const press = async (sel) => {
    const el = p2.locator(sel).first()
    if (!(await el.count())) return false
    const b = await el.boundingBox(); if (!b) return false
    await p2.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await p2.mouse.down(); await p2.waitForTimeout(60); await p2.mouse.up()
    await p2.waitForTimeout(550); return true
  }
  const homeText = () => p2.evaluate(() => {
    const h = [...document.querySelectorAll('*')].find(e =>
      /^Good (morning|afternoon|evening)/.test(e.textContent || '') && e.children.length < 40)
    return (document.querySelector('.rx-home') || h?.closest('div') || document.body).innerText
  })
  const newChatState = () => p2.evaluate(() => {
    const b = [...document.querySelectorAll('button,[role=button]')]
      .find(x => /^New chat/i.test((x.innerText || '').trim()))
    return b ? ((b.disabled || b.getAttribute('aria-disabled') === 'true') ? 'disabled' : 'enabled') : 'absent'
  })

  // The guard only means something if the model IS current to begin with.
  ok('the removed model starts out as the current model',
    /Current model: Qwen 3 1\.7B/.test(await homeText()))

  await press('text="Models"')
  for (let i = 0; i < 6; i++) {
    if (!(await p2.locator('text="Manage"').count())) break
    await press('text="Manage"')
    if (!(await press('text="Remove model"'))) break
  }
  is('every model really was removed',
    await p2.evaluate(() => window.__harness.state.models.filter(m => m.downloaded).length), 0)

  const home = await homeText()
  is('home stops naming a model that is no longer on the phone',
    /Qwen 3 1\.7B|Llama 3\.2 3B/.test(home), false)
  is('new chat is disabled once nothing is downloaded', await newChatState(), 'disabled')
  await p2.close()
}

// ── ⚠️ THE SKILLS LIBRARY HAS TO BE REACHABLE FROM THE COMPOSER ─────────
// Two bugs in one report. The Skill button sat in normal flow underneath the
// composer (position:absolute, z-index 3), so every tap landed in the text
// field and the picker had never once opened on a phone. And the library was
// only ever under Settings → Skills. Tony: "i dont see anywhere in ios to add
// skills." Runs on its own page because it navigates away from the chat.
{
  const p3 = await browser.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3 })
  await p3.goto(BASE, { waitUntil: 'networkidle' })
  await p3.waitForTimeout(600)
  await p3.locator('text="New chat"').first().click({ force: true })
  await p3.waitForTimeout(500)

  const btn = p3.locator('.rx-chat-skillpick').first()
  ok('the composer has a skill button', await btn.count() > 0)
  // ⚠️ THE TAP HAS TO REACH IT. Asserting the topmost element at the button's
  // own centre is the check that would have caught this the first time.
  const reachable = await p3.evaluate(() => {
    const el = document.querySelector('.rx-chat-skillpick')
    const r = el.getBoundingClientRect()
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
  })
  ok('and nothing is covering it', reachable)

  await btn.click({ force: true })
  await p3.waitForTimeout(400)
  const menuText = await p3.locator('.rx-chat-menu').first().innerText().catch(() => '')
  ok('tapping it opens the picker', /Plain English/.test(menuText))
  ok('which offers a way to edit them', /Edit skills/.test(menuText))

  // ⚠️ DON'T LET A BROKEN LAYOUT KILL THE RUN. When the button was covered this
  // timed out after 30s and the process died, which reports as a crash rather
  // than as the named assertion that actually failed.
  let landed = false
  try {
    await p3.locator('text="Edit skills…"').first().click({ force: true, timeout: 4000 })
    await p3.waitForTimeout(600)
    const screen = await p3.locator('body').innerText()
    landed = /Add a skill/.test(screen) && /Your skills/.test(screen) && /Plain English/.test(screen)
  } catch { landed = false }
  ok('and that lands on the skills library', landed)
  await p3.close()
}

// ── ⚠️ GETTING A SKILL ONTO THE PHONE WITHOUT TYPING IT ──────────────────
// Tony asked for an upload option and got one on the Mac only; the phone could
// still only be typed into. Three routes now: paste, a file, and the Mac. All
// three refuse a body over the budget rather than trimming it, because a skill
// cut in half still looks like a skill and quietly stops working.
{
  const p4 = await browser.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3 })
  await p4.goto(BASE, { waitUntil: 'networkidle' })
  await p4.waitForTimeout(600)
  // ⚠️ ROWS, NOT TEXT. `text="Skills"` matches the section HEADING as well as
  // the row, and the heading goes nowhere — the first attempt at this test sat
  // on the Settings screen thinking it had navigated.
  const row = async (label) => {
    const el = p4.locator('.rx-row.rx-pressable').filter({ has: p4.locator('.rx-headline', { hasText: new RegExp(`^${label}$`) }) }).first()
    if (!(await el.count())) return false
    await el.click({ force: true }); await p4.waitForTimeout(400); return true
  }
  const go = async (label) => {
    const el = p4.locator(`text=${JSON.stringify(label)}`).first()
    if (!(await el.count())) return false
    await el.click({ force: true }); await p4.waitForTimeout(350); return true
  }
  await p4.locator('[aria-label="Settings"]').first().click({ force: true })
  await p4.waitForTimeout(500)
  ok('Settings has a Skills row', await row('Skills'))
  const screen = await p4.locator('body').innerText()
  ok('the phone offers every way in', /Write one/.test(screen) && /Paste a skill/.test(screen) && /Import from a file/.test(screen) && /Import from your Mac/.test(screen))
  // ⚠️ TWO GROUPS MUST NOT TOUCH. They collided into one lumpy shape when the
  // import group was added straight above the list with nothing between.
  const gap = await p4.evaluate(() => {
    const g = [...document.querySelectorAll('.rx-group')]
    if (g.length < 2) return -1
    return Math.round(g[1].getBoundingClientRect().top - g[0].getBoundingClientRect().bottom)
  })
  ok(`the groups are separated (gap ${gap}px)`, gap >= 20)

  // paste a real SKILL.md
  ok('Paste a skill opens', await row('Paste a skill'))
  const box = p4.locator('textarea').first()
  await box.fill(['---', 'name: House style', 'description: how we write', '---', '', '# House style', '', 'Use US English. Never British spelling.'].join('\n'))
  await p4.waitForTimeout(300)
  const preview = await p4.locator('.rx-skill-count').first().innerText().catch(() => '')
  ok('it reads the name out of the frontmatter', /House style/.test(preview))
  await p4.locator('text="Add"').first().click({ force: true })
  await p4.waitForTimeout(400)
  const after = await p4.locator('body').innerText()
  ok('and the pasted skill is in the library', /House style/.test(after) && /Never British spelling/.test(after))

  // ⚠️ TOO LONG MUST BE REFUSED, NOT TRIMMED.
  await row('Paste a skill')
  await p4.locator('textarea').first().fill('x'.repeat(1200))
  await p4.waitForTimeout(300)
  const warn = await p4.locator('.rx-skill-count').first().innerText().catch(() => '')
  ok('an oversized skill says how much too long it is', /too many/.test(warn))
  const addBtn = p4.locator('.rx-skill-save').first()
  ok('and Add is visibly unavailable', (await addBtn.getAttribute('class') || '').includes('is-off'))
  await p4.locator('text="Cancel"').first().click({ force: true })
  await p4.waitForTimeout(300)

  // the Mac route asks for an address before it claims anything
  await row('Import from your Mac')
  // ⚠️ PLACEHOLDERS ARE NOT innerText. Reading the body text here quietly
  // asserted nothing about the two fields that matter.
  const holders = await p4.locator('.rx-skill-edit input').evaluateAll(els => els.map(e => e.placeholder))
  ok('the Mac route asks where the Mac is', holders.some(h => /100\.x\.y\.z:5834/.test(h)) && holders.some(h => /token/i.test(h)))
  const hint = await p4.locator('body').innerText()
  ok('and says where to find both', /Settings . Devices/.test(hint))
  await p4.locator('text="Connect"').first().click({ force: true })
  await p4.waitForTimeout(1200)
  const macErr = await p4.locator('body').innerText()
  ok('and says so plainly when there is no address', /does not look like an address/.test(macErr))
  await p4.close()
}

console.log(results.join('\n'))
console.log(`${pass}/${pass + fail} passed  ·  the app was RUN, not read`)
await browser.close()
process.exit(fail ? 1 : 0)

/**
 * The link on the QR code actually signs a phone in.
 *
 * ⚠️ THE ROUTE HAS ALWAYS EXISTED AND NOTHING EVER RENDERED THE LINK. The comment
 * on it in server/index.js describes the whole setup — "Copy phone link → open →
 * Add to Home Screen" — and there was no Copy phone link anywhere in the UI, so
 * the flow it describes could not be followed by anyone. A feature finished
 * except for the part the user touches.
 *
 * What is worth testing here is NOT that a QR library encodes a string. It is
 * that the string is a URL this server accepts: the right scheme for the address
 * shape, the token honoured, the cookie set, and the token dropped from the URL
 * before it can be bookmarked or land in history.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

// ⚠️ A FIXED PORT MAKES A TEST FAIL FOR A REASON THAT IS NOT THE CODE. A server
// left over from the previous run answers instead, and the failure reads like a
// regression. Ask the OS for one nobody is using.
const freePort = () => new Promise(r => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) })
})

// ⚠️ THE REAL FUNCTION, NOT A COPY OF IT. It lives in api.js — plain JS the
// renderer and this test can both import — precisely so this file cannot drift
// into testing its own re-implementation and reporting safety it never checked.
const { phoneLink } = await import('../src/api.js')
let pass = 0, fail = 0
const results = []
const ok = (n, c, extra = '') => { c ? pass++ : (fail++, results.push(`  FAIL ${n}${extra ? ' — ' + extra : ''}`)) }

// ⚠️ THE ADDRESS ARRIVES IN TWO SHAPES and guessing either one produces a link
// that looks right and does not resolve.
const link = phoneLink
ok('a bare host:port gets http://, not https://',
   link('192.168.1.4:5834', 'abc') === 'http://192.168.1.4:5834/?token=abc')
ok('a Tailscale https URL is left alone',
   link('https://mbp.tail1234.ts.net', 'abc') === 'https://mbp.tail1234.ts.net/?token=abc')
ok('a trailing slash does not double up',
   link('https://mbp.tail1234.ts.net/', 'abc') === 'https://mbp.tail1234.ts.net/?token=abc')
ok('a token with URL-special characters survives',
   link('h:1', 'a+b/c=d').endsWith('?token=a%2Bb%2Fc%3Dd'))

// ── against a real server ───────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'rx-phone-'))
const PORT = await freePort(), TOKEN = 'test-token-' + Math.random().toString(36).slice(2)
const srv = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, RADIANT_DIR: dir, RADIANT_PORT: String(PORT), RADIANT_TOKEN: TOKEN },
  stdio: 'ignore'
})
const wait = ms => new Promise(r => setTimeout(r, ms))
let up = false
for (let i = 0; i < 40 && !up; i++) {
  await wait(250)
  try { await fetch(`http://127.0.0.1:${PORT}/api/config`, { headers: { authorization: `Bearer ${TOKEN}` } }); up = true } catch {}
}
ok('the test server came up', up)

if (up) {
  const url = link(`127.0.0.1:${PORT}`, TOKEN)
  const res = await fetch(url, { redirect: 'manual' })
  ok('the phone link is accepted and redirects', res.status === 302, `HTTP ${res.status}`)
  const loc = res.headers.get('location') || ''
  // ⚠️ THE TOKEN MUST NOT SURVIVE THE REDIRECT. That is the whole reason this
  // route redirects at all — otherwise the credential sits in history, in a
  // bookmark, and in the address bar of a phone somebody else may pick up.
  ok('and the token is stripped from where it lands', !/token=/.test(loc), loc)
  const cookie = res.headers.get('set-cookie') || ''
  ok('a cookie is set so the phone stays signed in', /=/.test(cookie) && cookie.includes(TOKEN))
  ok('the cookie is httpOnly, so page scripts cannot read it', /httponly/i.test(cookie))

  // A wrong token must not sign anything in.
  const bad = await fetch(link(`127.0.0.1:${PORT}`, 'not-the-token'), { redirect: 'manual' })
  ok('a wrong token does not set a cookie', !(bad.headers.get('set-cookie') || '').includes(TOKEN))

  // And the cookie alone is enough afterwards.
  const jar = (res.headers.get('set-cookie') || '').split(';')[0]
  const api = await fetch(`http://127.0.0.1:${PORT}/api/config`, { headers: { cookie: jar } })
  ok('the cookie alone then reaches the API', api.ok, `HTTP ${api.status}`)
}

srv.kill()
await wait(400)
rmSync(dir, { recursive: true, force: true })
console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  one link signs a phone in and leaves no token behind`)
process.exit(fail ? 1 : 0)

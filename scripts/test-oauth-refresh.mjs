// A single-use refresh token is spent once, however many callers need it.
//
// ⚠️ Nous (and OpenAI) rotate the refresh token on every use. Parallel graph
// nodes each found the access token expired and each refreshed with the same
// refresh token; the provider accepted the first and refused the second, which
// reported "session expired — sign in again" though the session was fine.
let pass = 0, fail = 0
const ok = (c, what) => { if (c) pass++; else { fail++; console.log('  FAIL', what) } }

// a token endpoint that honours each refresh token exactly once
let live = new Set(['r0']), calls = 0, n = 0
globalThis.fetch = async (url, opts) => {
  calls++
  await new Promise(r => setTimeout(r, 50))
  const used = opts.headers['x-nous-refresh-token']
  if (!live.has(used)) return new Response('used', { status: 401 })
  live.delete(used); n++; live.add('r' + n)
  return new Response(JSON.stringify({ access_token: 'a' + n, refresh_token: 'r' + n, expires_in: 900 }), { status: 200 })
}
const { validAccessToken } = await import('../server/oauth.js')
const expired = () => ({ oauth: { nousresearch: { access: 'a0', refresh: 'r0', expires: Date.now() - 1000 } } })
let saves = 0
const save = () => { saves++ }

// two callers, each with its own copy of the config (graph nodes load their own)
const [x, y] = await Promise.allSettled([validAccessToken('nousresearch', expired(), save), validAccessToken('nousresearch', expired(), save)])
ok(x.status === 'fulfilled' && y.status === 'fulfilled', `both callers get a token, neither is told the session expired (${x.reason?.message || ''}${y.reason?.message || ''})`)
ok(x.value === 'a1' && y.value === 'a1', `they share one refresh (${x.value}, ${y.value})`)
ok(calls === 1 && saves === 1, `the refresh token was spent once (${calls} calls, ${saves} saves)`)

// a caller still holding the old config gets the minted token, not a dead refresh
const stale = expired()
const z = await validAccessToken('nousresearch', stale, save).catch(e => e.message)
ok(z === 'a1' && calls === 1, `an older copy of the config reuses the new token (${z}, ${calls} calls)`)
ok(stale.oauth.nousresearch.refresh === 'r1', 'and that copy is updated, so saving it later cannot put the dead token back')

// ⚠️ A REFUSED SIGN-IN WAS SILENT AND RETRIED FOREVER. Anthropic refused the refresh
// token; every model-list load asked again, the error was swallowed, and the Anthropic
// group vanished with Settings still showing a green tick.
const { signInProblem } = await import('../server/oauth.js')
let antCalls = 0, antStatus = 400
globalThis.fetch = async (url, opts) => {
  antCalls++
  if (antStatus !== 200) return new Response('{"error":"invalid_grant"}', { status: antStatus })
  return new Response(JSON.stringify({ access_token: 'fresh', refresh_token: 'ant-r2', expires_in: 3600 }), { status: 200 })
}
const dead = { oauth: { anthropic: { access: 'old', refresh: 'ant-r1', expires: Date.now() - 1000 } } }
const e1 = await validAccessToken('anthropic', dead, save).catch(e => e.message)
ok(/expired/i.test(e1) && /Settings/.test(e1), `a refused refresh says to sign in again (${e1})`)
ok(signInProblem('anthropic', dead) === e1, 'and the UI can ask what is wrong')
await validAccessToken('anthropic', dead, save).catch(() => {})
await validAccessToken('anthropic', dead, save).catch(() => {})
ok(antCalls === 1, `a refused refresh token is not asked again (${antCalls} calls)`)

// a fresh sign-in replaces the dead token, and the problem goes with it
antStatus = 200
const reSigned = { oauth: { anthropic: { access: 'new', refresh: 'ant-r9', expires: Date.now() + 3600_000 } } }
ok(signInProblem('anthropic', reSigned) === null, 'a new sign-in clears the warning')
ok(await validAccessToken('anthropic', reSigned, save) === 'new', 'and its token is used')

// a temporary outage is retried later, not treated as a dead sign-in
antCalls = 0; antStatus = 503
const busy = { oauth: { anthropic: { access: 'old', refresh: 'ant-r5', expires: Date.now() - 1000 } } }
const e2 = await validAccessToken('anthropic', busy, save).catch(e => e.message)
ok(/temporarily/i.test(e2), `an outage is reported as temporary (${e2})`)
await validAccessToken('anthropic', busy, save).catch(() => {})
ok(antCalls === 3, `and not retried within 5 minutes beyond its own retries (${antCalls} calls)`)

console.log(`\n${pass}/${pass + fail} passed  ·  one refresh per provider, however many callers need it; a refused sign-in is reported, not retried`)
process.exit(fail ? 1 : 0)

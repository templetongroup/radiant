/**
 * Can a web page you did not open drive your agent?
 *
 * ⚠️ THE SERVER TRUSTS EVERY LOOPBACK REQUEST, AND THE CORS LAYER REFLECTS ANY
 * ORIGIN. Together those mean an ordinary page in the user's browser — nothing
 * to do with Radiant — can fetch http://127.0.0.1:5834/api/config, read the
 * reply (because Access-Control-Allow-Origin comes back as that page's own
 * origin), and go on to drive /api/chat. No token is needed: the request looks
 * local. This asserts the door is shut, and it is the regression test for the
 * whole class.
 *
 * Same-origin and no-Origin requests MUST keep working — that is the app's own
 * UI and the phone over Tailscale, and breaking them is worse than the hole.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 5893
const dir = mkdtempSync(join(tmpdir(), 'rx-origin-'))
// ⚠️ SEED A CREDENTIAL, or the redaction assertions below pass vacuously on an
// empty profile and prove nothing. This is a fake token in a throwaway dir.
writeFileSync(join(dir, 'config.json'), JSON.stringify({
  settings: {},
  mcpServers: [{ id: 'probe', name: 'probe', url: 'https://example.invalid/mcp',
                 token: 'mcp-secret-should-never-reach-a-browser',
                 env: { PROBE_API_KEY: 'env-secret-should-never-reach-a-browser' } }]
}, null, 2))
const server = spawn('node', ['server/index.js'], {
  env: { ...process.env, RADIANT_PORT: String(PORT), RADIANT_DIR: dir, NODE_ENV: 'production' },
  stdio: 'ignore'
})
process.on('exit', () => server.kill())
const base = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(base)).ok) break } catch {}
  await new Promise(r => setTimeout(r, 250))
}

let pass = 0, fail = 0
const results = []
const ok = (name, cond, detail = '') => {
  cond ? pass++ : (fail++, results.push(`  FAIL ${name}${detail ? '\n        ' + detail : ''}`))
}

const get = (headers) => fetch(`${base}/api/config`, { headers })

// ── the hole ────────────────────────────────────────────────────────────────
const evil = await get({ Origin: 'https://evil.example.com' })
ok('a third-party origin is refused', evil.status === 401 || evil.status === 403,
   `got HTTP ${evil.status}`)
ok('a third-party origin gets no Access-Control-Allow-Origin',
   evil.headers.get('access-control-allow-origin') === null,
   `got ${evil.headers.get('access-control-allow-origin')}`)

// ── what must not regress ───────────────────────────────────────────────────
const bare = await get({})
ok('a request with no Origin still works (the app itself)', bare.status === 200, `got HTTP ${bare.status}`)
const same = await get({ Origin: base })
ok('a same-origin request still works', same.status === 200, `got HTTP ${same.status}`)

// ── credentials must not ride along in the config payload ───────────────────
if (bare.status === 200) {
  const cfg = await bare.json()
  const mcp = JSON.stringify(cfg.mcpServers || [])
  const whole = JSON.stringify(cfg)
  ok('the seeded MCP bearer token is not in the payload',
     !whole.includes('mcp-secret-should-never-reach-a-browser'))
  ok('the seeded MCP env secret is not in the payload',
     !whole.includes('env-secret-should-never-reach-a-browser'))
  ok('the MCP server itself is still listed (redacted, not removed)',
     Array.isArray(cfg.mcpServers) && cfg.mcpServers.length === 1)
}

server.kill()
console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  a page you did not open cannot drive the agent`)
process.exit(fail ? 1 : 0)

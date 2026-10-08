// Isolate the model-list function: no credentials, network, or provider dependencies.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../server/providers.js', import.meta.url), 'utf8')
const start = source.indexOf('const CHATGPT_BASE =')
const end = source.indexOf('\nfunction toResponsesInput', start)
assert.ok(start >= 0 && end > start, 'model-list source boundaries exist')
const snippet = source.slice(start, end)

for (const [override, expected] of [[undefined, '0.160.1'], ['', '0.160.1'], ['0.161.0', '0.161.0']]) {
  let requested
  const env = override === undefined ? {} : { RADIANT_CODEX_CLIENT_VERSION: override }
  const context = vm.createContext({
    process: { env }, AbortSignal,
    fetchRetry: async (url) => {
      requested = new URL(url)
      return { ok: true, json: async () => ({ models: [
        { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', supported_in_api: true, visibility: 'list' },
        { slug: 'hidden', supported_in_api: true, visibility: 'hide' },
        { slug: 'unsupported', supported_in_api: false, visibility: 'list' }
      ] }) }
    }
  })
  const models = await vm.runInContext(`${snippet}\nchatgptModels('test-token', 'test-account')`, context)
  assert.equal(requested.pathname, '/backend-api/codex/models')
  assert.equal(requested.searchParams.get('client_version'), expected)
  assert.deepEqual(JSON.parse(JSON.stringify(models)), [{ id: 'gpt-6-astra', label: 'GPT-6 Astra' }])
  console.log(`PASS override=${JSON.stringify(override)} -> ${expected}; visible supported models preserved`)
}

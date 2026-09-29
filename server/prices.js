// List prices, $ per million tokens, first-party APIs, read 2026-09-17
// (Anthropic and developers.openai.com/api/docs/pricing). An estimate, not a
// bill: a subscription sign-in is not charged per token, and a model missing
// here is shown as tokens only. Shared by the graph runner and the benchmark.
export const PRICES = {
  'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-fable-5': { in: 10, out: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'gpt-6-astra': { in: 10, out: 50, cacheRead: 1, cacheWrite: 10 },
  'gpt-5.6-sol': { in: 4, out: 20, cacheRead: 0.4, cacheWrite: 4 },
  'gpt-5.6-terra': { in: 2, out: 12, cacheRead: 0.2, cacheWrite: 2 },
  'gpt-5.6-luna': { in: 0.2, out: 1.2, cacheRead: 0.02, cacheWrite: 0.2 },
  'gpt-5.5': { in: 5, out: 30, cacheRead: 0.5, cacheWrite: 5 }
}

/** anthropic/claude-sonnet-5:batch → claude-sonnet-5 */
export const priceOf = model => {
  if (!model) return null
  const m = String(model).replace(/^[^/]+\//, '').replace(/:.*$/, '').replace(/\.(\d)$/, '-$1')
  return PRICES[m] || PRICES[model] || null
}

/**
 * Dollars for one usage tally, or null when the model has no list price.
 * `input` is ALL prompt tokens, cached ones included — the shape every
 * provider round in providers.js emits — so the fresh part is what is left.
 */
export function costOf (u, model) {
  const p = priceOf(model)
  if (!p || !u) return null
  const cacheRead = u.cacheRead || 0, cacheWrite = u.cacheWrite || 0
  const fresh = Math.max(0, (u.input || 0) - cacheRead - cacheWrite)
  return (fresh * p.in + cacheWrite * p.cacheWrite + cacheRead * p.cacheRead + (u.output || 0) * p.out) / 1e6
}

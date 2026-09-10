/**
 * How much a model can be sent, by name. One table for the server and the UI:
 * the gauge under the composer reads it to draw "how full", and the agent loop
 * reads it to trim BEFORE the provider refuses the request.
 *
 * ⚠️ NO BAR BEATS A WRONG ONE. A model that is not matched returns null, and
 * every caller treats null as "unknown" rather than assuming a size. The grok
 * row was 131,072 for every grok while grok-4 and grok-build take 256,000 —
 * so the gauge under-reported by half, which is the wrong direction to be wrong
 * in: it said "fine" right up to the request that xAI refused.
 */
export const CONTEXT_WINDOWS = [
  [/claude.*(opus|sonnet|haiku)/i, 200_000],
  [/gpt-5|gpt-4\.1|o[34]/i, 400_000],
  [/gpt-4o|gpt-4-turbo/i, 128_000],
  [/gemini.*(pro|flash)/i, 1_000_000],
  [/grok-(4|build|code)/i, 256_000],
  [/grok/i, 131_072],
  [/deepseek/i, 65_536],
  // M3 is 1M; the whole M2 series is 204,800. Anything else MiniMax ships is
  // deliberately unmatched — no bar beats a wrong one.
  [/minimax.*m3\b/i, 1_048_576],
  [/minimax.*m2/i, 204_800],
  [/qwen.*(2\.5|3)/i, 32_768],
  [/llama.*3\.[123]/i, 128_000],
  [/mistral|mixtral/i, 32_768]
]

export function contextWindow (model) {
  for (const [re, n] of CONTEXT_WINDOWS) if (re.test(model || '')) return n
  return null
}

/**
 * What to say about a turn that is running.
 *
 * ⚠️ "WORKING" WITH NO WAY TO SAY "STUCK" IS THE BUG, NOT THE FIX. Radiant already
 * had an indicator; it lived inside the assistant bubble, scrolled away, and was
 * equally confident whether or not anything was still happening. Tony: "I have no
 * idea if the agent is thinking, working or stopped. this is a real problem. it
 * happens in almost every chat but never happens in gpt or claude app."
 *
 * So the interesting logic is the silence: how long since the last event, and when
 * that stops meaning "thinking" and starts meaning "you should know". That is pure
 * arithmetic over timestamps and belongs where it can be tested at any instant,
 * rather than by staring at a real turn and waiting.
 */

export const STALL_AFTER = 25   // seconds of unexplained silence before we say so

export function turnStatus ({ streaming, thinkingActive, parts = [], startedAt, lastEventAt, now }) {
  if (!streaming) return null
  const began = startedAt || now
  const last = lastEventAt || began
  const elapsed = Math.max(0, Math.floor((now - began) / 1000))
  const quiet = Math.max(0, Math.floor((now - last) / 1000))

  // The last tool with no result yet is the one running right now.
  const running = [...parts].reverse().find(p => p.type === 'tool' && p.result == null && !p.denied)

  const what = thinkingActive ? 'Thinking'
    : running ? `Running ${(running.name || 'a tool').replace(/_/g, ' ')}`
      : parts.length ? 'Writing' : 'Waiting for the model'

  // ⚠️ SILENCE WITH A TOOL RUNNING IS NOT A STALL. A build, a test run or a browser
  // step is silent for minutes by nature, and flagging those would put a warning on
  // screen for most of a normal turn — an indicator that cries wolf is back to
  // telling you nothing. When a tool is running we can already NAME it, which is
  // the informative thing to say. A stall is silence nobody has accounted for.
  return { what, elapsed, quiet, running: Boolean(running), stalled: !running && quiet >= STALL_AFTER }
}

export function clock (t) {
  return t >= 60 ? `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, '0')}s` : `${t}s`
}

/**
 * Should the mid-turn queue be sent now?
 *
 * ⚠️ THIS EXISTS BECAUSE THE QUEUE LEAKED INTO OTHER CHATS. Two effects ran in the
 * same commit when you switched away from a streaming chat — this drain, declared
 * first, and "a session switch abandons anything queued", declared second. React
 * runs them in order, so the drain saw `wasStreaming` true (the OLD chat was
 * streaming), `streaming` false (the NEW chat is not) and a queue the second effect
 * had not cleared yet — and sent the follow-up you typed for one chat into
 * whichever chat you had just opened. Tony: "im following up on a previous chat and
 * its answering questions from another chat." If the chat you landed on was itself
 * mid-turn, the server refused it and you saw "a turn is already running" in a chat
 * you had only just started.
 *
 * The missing condition is identity: the turn that settled has to be THIS chat's.
 * Pure and separate so it can be tested, because the bug only appears in a
 * transition between two renders and is invisible to any check of the final state.
 */
export function shouldDrainQueue ({ wasStreaming, streaming, streamedFor, sessionId, queuedCount }) {
  if (!wasStreaming || streaming) return false          // no turn just settled
  if (!queuedCount || !sessionId) return false          // nothing to send
  return streamedFor === sessionId                      // and it settled HERE
}


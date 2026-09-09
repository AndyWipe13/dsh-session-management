/**
 * The DSH rc.7 event-type vocabulary plus the title-event payload factory.
 *
 * Producers (fidelity mapping, host title repair/seed) and consumers
 * (projection metrics) must agree on these strings; they live here so a
 * future host rename is a single edit.
 */

export const DshEventTypes = {
  turnStart: 'turn/start',
  stepStart: 'step/start',
  stepEnd: 'step/end',
  turnEnd: 'turn/end',
  userMessage: 'user/message',
  assistantMessage: 'assistant/message',
  toolCall: 'tool/call',
  toolResult: 'tool/result',
  sessionTitle: 'session/title',
} as const

/** Payload of a `session/title` event exactly as the rc.7 host appends it. */
export function sessionTitleData(title: string): {
  title: string
  messageSeqs: never[]
  source: { kind: 'user' }
} {
  return { title: title.trim(), messageSeqs: [], source: { kind: 'user' } }
}

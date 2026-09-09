import { randomUUID } from 'node:crypto'
import { DshEventTypes } from './dsh-events.js'

export interface FidelityEvent {
  type: string
  seq: number
  time: number
  data: Record<string, any>
  surfaceOp?: 'append'
}

export type FidelityContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }

interface KnownCall {
  name: string
  known: boolean
}

/**
 * Constructs the DSH event invariants shared by every source dialect.
 * Dialect adapters decide what a source record means; this module owns
 * sequencing, turn/step boundaries, message shapes, tools, and fallbacks.
 */
export class FidelityMapping {
  readonly events: FidelityEvent[] = []
  private readonly calls = new Map<string, KnownCall>()
  private seq = 0
  private turn = 0
  private currentTurn: number | undefined
  private currentStep: number | undefined
  private knownCount = 0
  private textCardCount = 0

  constructor(private readonly knowTool: (name: string) => boolean) {}

  get knownToolCalls(): number {
    return this.knownCount
  }

  get textCardToolCalls(): number {
    return this.textCardCount
  }

  text(text: string): FidelityContentBlock {
    return { type: 'text', text }
  }

  reasoning(text: string): FidelityContentBlock {
    return { type: 'reasoning', text }
  }

  toolCallBlock(id: string, name: string, args: unknown): FidelityContentBlock {
    return { type: 'tool-call', id, name, arguments: this.arguments(args) }
  }

  arguments(value: unknown): string {
    if (typeof value === 'string') return value
    if (value !== undefined) return JSON.stringify(value)
    return ''
  }

  output(value: unknown): string {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) {
      return value.map((block) => {
        if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
          return (block as { text: string }).text
        }
        return block === undefined ? '' : JSON.stringify(block)
      }).filter(Boolean).join('\n')
    }
    return value !== undefined ? JSON.stringify(value) : ''
  }

  toolCallCard(label: 'tool_use' | 'tool_call', name: string, id: string | undefined, args: unknown): FidelityContentBlock {
    this.textCardCount++
    const body = this.arguments(args)
    return this.text(`[${label}: ${name}${id ? ` (${id})` : ''}]\n${body}`)
  }

  toolResultCard(callId: string | undefined, output: unknown, isError = false): FidelityContentBlock {
    this.textCardCount++
    return this.text(`[tool_result${callId ? `: ${callId}` : ''}${isError ? ' [error]' : ''}]\n${this.output(output)}`)
  }

  registerTool(callId: string, name: string): KnownCall {
    const call = { name, known: this.knowTool(name) }
    this.calls.set(callId, call)
    if (call.known) this.knownCount++
    return call
  }

  tool(callId: string): KnownCall | undefined {
    return this.calls.get(callId)
  }

  openTurn(time: number): void {
    this.closeTurn(time)
    this.turn++
    this.currentTurn = this.turn
    this.currentStep = 1
    this.push(DshEventTypes.turnStart, time, { turn: this.currentTurn })
    this.push(DshEventTypes.stepStart, time, { turn: this.currentTurn, step: this.currentStep })
  }

  ensureTurn(time: number): void {
    if (this.currentTurn === undefined) this.openTurn(time)
  }

  closeTurn(time: number): void {
    if (this.currentStep !== undefined) {
      this.push(DshEventTypes.stepEnd, time, { turn: this.currentTurn, step: this.currentStep })
      this.currentStep = undefined
    }
    if (this.currentTurn !== undefined) {
      this.push(DshEventTypes.turnEnd, time, { turn: this.currentTurn, reason: { kind: 'completed' } })
      this.currentTurn = undefined
    }
  }

  userMessage(time: number, content: readonly FidelityContentBlock[], id = `msg-${randomUUID()}`): void {
    this.ensureTurn(time)
    this.push(DshEventTypes.userMessage, time, {
      role: 'user', content, source: { kind: 'user' }, id,
    }, 'append')
  }

  assistantMessage(
    time: number,
    content: readonly FidelityContentBlock[],
    source: { provider: string; model: string },
    id = `msg-${randomUUID()}`,
  ): void {
    this.ensureTurn(time)
    this.push(DshEventTypes.assistantMessage, time, {
      turn: this.currentTurn,
      step: this.currentStep,
      message: {
        role: 'assistant', content, source: { kind: 'model', ...source }, id,
      },
    }, 'append')
  }

  toolCall(time: number, callId: string, name: string, args: unknown): void {
    this.ensureTurn(time)
    this.push(DshEventTypes.toolCall, time, {
      turn: this.currentTurn,
      step: this.currentStep,
      callId,
      name,
      arguments: this.arguments(args),
    })
  }

  toolResult(time: number, callId: string, output: unknown, isError = false): void {
    this.ensureTurn(time)
    const content = [this.text(this.output(output))]
    if (isError) content.push(this.text('[error]'))
    this.push(DshEventTypes.toolResult, time, {
      turn: this.currentTurn,
      step: this.currentStep,
      message: {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          content,
          ...(isError ? { isError: true } : {}),
        }],
        source: { kind: 'tool', callId },
        id: `msg-${callId}`,
      },
    }, 'append')
  }

  private push(type: string, time: number, data: Record<string, any>, surfaceOp?: 'append'): void {
    this.events.push({
      type,
      seq: this.seq++,
      time,
      data,
      ...(surfaceOp ? { surfaceOp } : {}),
    })
  }
}

import { randomUUID } from 'node:crypto';
import { DshEventTypes } from './dsh-events.js';
/**
 * Constructs the DSH event invariants shared by every source dialect.
 * Dialect adapters decide what a source record means; this module owns
 * sequencing, turn/step boundaries, message shapes, tools, and fallbacks.
 */
export class FidelityMapping {
    knowTool;
    events = [];
    calls = new Map();
    seq = 0;
    turn = 0;
    currentTurn;
    currentStep;
    knownCount = 0;
    textCardCount = 0;
    constructor(knowTool) {
        this.knowTool = knowTool;
    }
    get knownToolCalls() {
        return this.knownCount;
    }
    get textCardToolCalls() {
        return this.textCardCount;
    }
    text(text) {
        return { type: 'text', text };
    }
    reasoning(text) {
        return { type: 'reasoning', text };
    }
    toolCallBlock(id, name, args) {
        return { type: 'tool-call', id, name, arguments: this.arguments(args) };
    }
    arguments(value) {
        if (typeof value === 'string')
            return value;
        if (value !== undefined)
            return JSON.stringify(value);
        return '';
    }
    output(value) {
        if (typeof value === 'string')
            return value;
        if (Array.isArray(value)) {
            return value.map((block) => {
                if (block && typeof block === 'object' && typeof block.text === 'string') {
                    return block.text;
                }
                return block === undefined ? '' : JSON.stringify(block);
            }).filter(Boolean).join('\n');
        }
        return value !== undefined ? JSON.stringify(value) : '';
    }
    toolCallCard(label, name, id, args) {
        this.textCardCount++;
        const body = this.arguments(args);
        return this.text(`[${label}: ${name}${id ? ` (${id})` : ''}]\n${body}`);
    }
    toolResultCard(callId, output, isError = false) {
        this.textCardCount++;
        return this.text(`[tool_result${callId ? `: ${callId}` : ''}${isError ? ' [error]' : ''}]\n${this.output(output)}`);
    }
    registerTool(callId, name) {
        const call = { name, known: this.knowTool(name) };
        this.calls.set(callId, call);
        if (call.known)
            this.knownCount++;
        return call;
    }
    tool(callId) {
        return this.calls.get(callId);
    }
    openTurn(time) {
        this.closeTurn(time);
        this.turn++;
        this.currentTurn = this.turn;
        this.currentStep = 1;
        this.push(DshEventTypes.turnStart, time, { turn: this.currentTurn });
        this.push(DshEventTypes.stepStart, time, { turn: this.currentTurn, step: this.currentStep });
    }
    ensureTurn(time) {
        if (this.currentTurn === undefined)
            this.openTurn(time);
    }
    closeTurn(time) {
        if (this.currentStep !== undefined) {
            this.push(DshEventTypes.stepEnd, time, { turn: this.currentTurn, step: this.currentStep });
            this.currentStep = undefined;
        }
        if (this.currentTurn !== undefined) {
            this.push(DshEventTypes.turnEnd, time, { turn: this.currentTurn, reason: { kind: 'completed' } });
            this.currentTurn = undefined;
        }
    }
    userMessage(time, content, id = `msg-${randomUUID()}`) {
        this.ensureTurn(time);
        this.push(DshEventTypes.userMessage, time, {
            role: 'user', content, source: { kind: 'user' }, id,
        }, 'append');
    }
    assistantMessage(time, content, source, id = `msg-${randomUUID()}`) {
        this.ensureTurn(time);
        this.push(DshEventTypes.assistantMessage, time, {
            turn: this.currentTurn,
            step: this.currentStep,
            message: {
                role: 'assistant', content, source: { kind: 'model', ...source }, id,
            },
        }, 'append');
    }
    toolCall(time, callId, name, args) {
        this.ensureTurn(time);
        this.push(DshEventTypes.toolCall, time, {
            turn: this.currentTurn,
            step: this.currentStep,
            callId,
            name,
            arguments: this.arguments(args),
        });
    }
    toolResult(time, callId, output, isError = false) {
        this.ensureTurn(time);
        const content = [this.text(this.output(output))];
        if (isError)
            content.push(this.text('[error]'));
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
        }, 'append');
    }
    push(type, time, data, surfaceOp) {
        this.events.push({
            type,
            seq: this.seq++,
            time,
            data,
            ...(surfaceOp ? { surfaceOp } : {}),
        });
    }
}
//# sourceMappingURL=fidelity.js.map
export interface FidelityEvent {
    type: string;
    seq: number;
    time: number;
    data: Record<string, any>;
    surfaceOp?: 'append';
}
export type FidelityContentBlock = {
    type: 'text';
    text: string;
} | {
    type: 'reasoning';
    text: string;
} | {
    type: 'tool-call';
    id: string;
    name: string;
    arguments: string;
};
interface KnownCall {
    name: string;
    known: boolean;
}
/**
 * Constructs the DSH event invariants shared by every source dialect.
 * Dialect adapters decide what a source record means; this module owns
 * sequencing, turn/step boundaries, message shapes, tools, and fallbacks.
 */
export declare class FidelityMapping {
    private readonly knowTool;
    readonly events: FidelityEvent[];
    private readonly calls;
    private seq;
    private turn;
    private currentTurn;
    private currentStep;
    private knownCount;
    private textCardCount;
    constructor(knowTool: (name: string) => boolean);
    get knownToolCalls(): number;
    get textCardToolCalls(): number;
    text(text: string): FidelityContentBlock;
    reasoning(text: string): FidelityContentBlock;
    toolCallBlock(id: string, name: string, args: unknown): FidelityContentBlock;
    arguments(value: unknown): string;
    output(value: unknown): string;
    toolCallCard(label: 'tool_use' | 'tool_call', name: string, id: string | undefined, args: unknown): FidelityContentBlock;
    toolResultCard(callId: string | undefined, output: unknown, isError?: boolean): FidelityContentBlock;
    registerTool(callId: string, name: string): KnownCall;
    tool(callId: string): KnownCall | undefined;
    openTurn(time: number): void;
    ensureTurn(time: number): void;
    closeTurn(time: number): void;
    userMessage(time: number, content: readonly FidelityContentBlock[], id?: string): void;
    assistantMessage(time: number, content: readonly FidelityContentBlock[], source: {
        provider: string;
        model: string;
    }, id?: string): void;
    toolCall(time: number, callId: string, name: string, args: unknown): void;
    toolResult(time: number, callId: string, output: unknown, isError?: boolean): void;
    private push;
}
export {};

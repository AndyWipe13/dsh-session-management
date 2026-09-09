/**
 * The DSH rc.7 event-type vocabulary plus the title-event payload factory.
 *
 * Producers (fidelity mapping, host title repair/seed) and consumers
 * (projection metrics) must agree on these strings; they live here so a
 * future host rename is a single edit.
 */
export declare const DshEventTypes: {
    readonly turnStart: "turn/start";
    readonly stepStart: "step/start";
    readonly stepEnd: "step/end";
    readonly turnEnd: "turn/end";
    readonly userMessage: "user/message";
    readonly assistantMessage: "assistant/message";
    readonly toolCall: "tool/call";
    readonly toolResult: "tool/result";
    readonly sessionTitle: "session/title";
};
/** Payload of a `session/title` event exactly as the rc.7 host appends it. */
export declare function sessionTitleData(title: string): {
    title: string;
    messageSeqs: never[];
    source: {
        kind: 'user';
    };
};

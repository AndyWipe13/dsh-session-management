/**
 * Codex import slice.
 *
 * This module owns the filesystem-facing Codex rollout JSONL scanning/parsing
 * plus the pure transcript -> DSH event conversion.  The SessionManagement
 * service remains filesystem-free; it receives a `CodexSourceReader` (usually
 * `createCodexSourceReader()`) so tests can drive the same seam with fakes or
 * real fixture directories.
 *
 * Read-only contract: every function here only reads source files and the
 * Codex sqlite title index.  No Codex file or database is ever modified,
 * moved, or deleted.
 */
export interface CodexFileStat {
    sizeBytes: number;
    mtimeMs: number;
}
export interface CodexRecord {
    /** Parsed JSON object from one valid line. */
    value: Record<string, any>;
    /** 1-based line number in the source file. */
    line: number;
}
export interface CodexFileSummary {
    /** Codex rollout session id; falls back to the file basename when absent. */
    sourceSessionId: string;
    cwd?: string;
    projectName?: string;
    title?: string;
    /** First real user text, used by the title priority rule. */
    firstUserText?: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
    hasRealUserMessage: boolean;
    isSubagent: boolean;
}
export interface CodexParsedFile {
    summary: CodexFileSummary;
    records: CodexRecord[];
    badLines: number;
}
export interface CodexSourceReader {
    listCodexFiles(root: string): Promise<string[]>;
    readCodexFile(filePath: string): Promise<CodexParsedFile>;
    stat(filePath: string): Promise<CodexFileStat>;
    resolveTitle(root: string, sourceSessionId: string): Promise<string | undefined>;
}
/** A minimal DSH session event shape produced by the converter. */
export interface CodexDshEvent {
    type: string;
    seq: number;
    time: number;
    data: Record<string, any>;
    surfaceOp?: 'append';
}
export interface CodexDshHeader {
    cwd?: string;
    createdAt: number;
}
export interface CodexConversionResult {
    dshSessionId: string;
    header: CodexDshHeader;
    events: CodexDshEvent[];
    knownToolCalls: number;
    textCardToolCalls: number;
}
/**
 * Pure summary of a parsed Codex rollout.  External title sources
 * (`session_index.jsonl` / sqlite) are applied by `applyCodexThreadTitle`.
 */
export declare function summarizeCodexRecords(records: readonly CodexRecord[], stat: CodexFileStat, fallbackSessionId?: string): CodexFileSummary;
/**
 * Apply the Codex thread-title priority: only use the external title when it
 * differs from the first real user text; otherwise keep the fallback title.
 */
export declare function applyCodexThreadTitle(summary: CodexFileSummary, threadTitle: string | undefined): CodexFileSummary;
/** The default Codex home directory on this machine. */
export declare function defaultCodexHome(): string;
/** Expand `~` / empty input to a concrete Codex home. */
export declare function resolveCodexHome(input: string | undefined): string;
/**
 * Recursively list Codex rollout `.jsonl` files.  When the given root is a
 * Codex home containing `sessions/` + `archived_sessions/`, only those two
 * directories are scanned; otherwise the root itself is scanned recursively.
 */
export declare function listCodexFiles(root: string): Promise<string[]>;
/**
 * Read one Codex rollout JSONL file.  Malformed lines are skipped and counted;
 * every valid line is returned in order for high-fidelity conversion.
 */
export declare function readCodexFile(filePath: string): Promise<CodexParsedFile>;
/**
 * Resolve a Codex thread title from `session_index.jsonl` and
 * `sqlite/codex-dev.db` (or a sibling of the current root).  The database is
 * opened read-only; both `local_thread_catalog` and the older `threads` table
 * shapes are supported.
 */
export declare function resolveCodexTitle(root: string, sourceSessionId: string): Promise<string | undefined>;
export declare function createCodexSourceReader(): CodexSourceReader;
export declare function convertCodexRecords(records: readonly CodexRecord[], opts?: {
    dshSessionId?: string;
    knowTool(name: string): boolean;
}): CodexConversionResult;

/**
 * Claude Code import slice.
 *
 * This module owns the filesystem-facing Claude Code JSONL scanning/parsing and
 * the pure transcript -> DSH event conversion.  The SessionManagement service
 * remains filesystem-free; it receives a `ClaudeSourceReader` (usually
 * `createClaudeSourceReader()`) so tests can drive the same seam with fakes or
 * real fixture directories.
 *
 * Read-only contract: every function here only reads source files.  No Claude
 * Code file is ever modified, moved, or deleted.
 */
export interface ClaudeFileStat {
    sizeBytes: number;
    mtimeMs: number;
}
export interface ClaudeRecord {
    /** Parsed JSON object from one valid line. */
    value: Record<string, any>;
    /** 1-based line number in the source file. */
    line: number;
}
export interface ClaudeFileSummary {
    /** Claude Code session id; falls back to the file basename when absent. */
    sourceSessionId: string;
    cwd?: string;
    projectName?: string;
    title?: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
    hasRealUserMessage: boolean;
    isSubagent: boolean;
}
export interface ClaudeParsedFile {
    summary: ClaudeFileSummary;
    records: ClaudeRecord[];
    badLines: number;
}
export interface ClaudeSourceReader {
    listClaudeFiles(root: string): Promise<string[]>;
    readClaudeFile(filePath: string): Promise<ClaudeParsedFile>;
    stat(filePath: string): Promise<ClaudeFileStat>;
}
/** A minimal DSH session event shape produced by the converter. */
export interface ClaudeDshEvent {
    type: string;
    seq: number;
    time: number;
    data: Record<string, any>;
    surfaceOp?: 'append';
}
export interface ClaudeDshHeader {
    cwd?: string;
    createdAt: number;
}
export interface ClaudeConversionResult {
    dshSessionId: string;
    header: ClaudeDshHeader;
    events: ClaudeDshEvent[];
    knownToolCalls: number;
    textCardToolCalls: number;
}
/** The default Claude Code projects root on this machine. */
export declare function defaultClaudeProjectsRoot(): string;
/** Expand `~` / empty input to a concrete Claude Code projects root. */
export declare function resolveClaudeProjectsRoot(input: string | undefined): string;
/**
 * Summarize a parsed Claude Code file for the import queue.  This is a pure
 * function so tests can assert title/exclusion rules without touching the disk.
 */
export declare function summarizeClaudeRecords(records: readonly ClaudeRecord[], stat: ClaudeFileStat, fallbackSessionId?: string): ClaudeFileSummary;
/**
 * Read one Claude Code JSONL file.  Malformed lines are skipped and counted;
 * every valid line is returned in order so the converter can preserve as much
 * fidelity as possible.
 */
export declare function readClaudeFile(filePath: string): Promise<ClaudeParsedFile>;
/**
 * Recursively list `.jsonl` files under a Claude Code projects root.  The
 * scanner follows the real `~/.claude/projects/**` layout but also works when
 * fixture files sit directly in the configured root.
 */
export declare function listClaudeFiles(root: string): Promise<string[]>;
export declare function createClaudeSourceReader(): ClaudeSourceReader;
/**
 * Convert a parsed Claude Code transcript into a minimal but valid DSH session
 * event stream.  Known DSH tools map to `tool/call` + `tool/result`; unknown
 * tools degrade to read-only text cards (ADR-0002) instead of faking an
 * executable tool event.
 *
 * The returned events have contiguous seq values starting at 0; `Session`'
 * official seed path appends `session/end-seed` after them and persists the
 * whole log through `ctx.sessions`.
 */
export declare function convertClaudeRecords(records: readonly ClaudeRecord[], opts?: {
    dshSessionId?: string;
    knowTool(name: string): boolean;
}): ClaudeConversionResult;

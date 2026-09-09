/**
 * Codex import slice.
 *
 * This module owns the Codex dialect: rollout JSONL record interpretation
 * (summarize + pure transcript -> DSH event conversion) plus the external
 * title index (session_index.jsonl / read-only sqlite). Dialect-neutral
 * plumbing lives in jsonl-source.ts, and the SessionManagement service stays
 * filesystem-free behind the `ImportSourceAdapter` seam.
 *
 * Read-only contract: every function here only reads source files and the
 * Codex sqlite title index.  No Codex file or database is ever modified,
 * moved, or deleted.
 */
import type { ImportSourceAdapter } from './import-queue.js';
import { type SourceFileStat, type SourceRecord } from './jsonl-source.js';
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
    records: SourceRecord[];
    badLines: number;
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
 * (`session_index.jsonl` / sqlite) are applied by the import queue's
 * title-priority rule.
 */
export declare function summarizeCodexRecords(records: readonly SourceRecord[], stat: SourceFileStat, fallbackSessionId?: string): CodexFileSummary;
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
 * Read one Codex rollout JSONL file: shared streaming parse, dialect summary.
 */
export declare function readCodexFile(filePath: string): Promise<CodexParsedFile>;
/**
 * Resolve a Codex thread title from `session_index.jsonl` and
 * `sqlite/codex-dev.db` (or a sibling of the current root).  The database is
 * opened read-only; both `local_thread_catalog` and the older `threads` table
 * shapes are supported.
 */
export declare function resolveCodexTitle(root: string, sourceSessionId: string): Promise<string | undefined>;
/** Resolve many titles while reading each index/database at most once. */
export declare function resolveCodexTitles(root: string, sourceSessionIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
/** Codex adapter at the import-queue seam. */
export declare function createCodexImportAdapter(root?: string): ImportSourceAdapter;
export declare function convertCodexRecords(records: readonly SourceRecord[], opts?: {
    dshSessionId?: string;
    knowTool(name: string): boolean;
}): CodexConversionResult;

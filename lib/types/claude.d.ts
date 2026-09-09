/**
 * Claude Code import slice.
 *
 * This module owns the Claude Code dialect: JSONL record interpretation
 * (summarize + pure transcript -> DSH event conversion). The dialect-neutral
 * plumbing (streaming reads, walks, `~` expansion) lives in jsonl-source.ts,
 * and the SessionManagement service stays filesystem-free behind the
 * `ImportSourceAdapter` seam.
 *
 * Read-only contract: every function here only reads source files.  No Claude
 * Code file is ever modified, moved, or deleted.
 */
import type { ImportSourceAdapter } from './import-queue.js';
import { type SourceFileStat, type SourceRecord } from './jsonl-source.js';
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
    records: SourceRecord[];
    badLines: number;
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
export declare function summarizeClaudeRecords(records: readonly SourceRecord[], stat: SourceFileStat, fallbackSessionId?: string): ClaudeFileSummary;
/**
 * Read one Claude Code JSONL file: shared streaming parse, dialect summary.
 */
export declare function readClaudeFile(filePath: string): Promise<ClaudeParsedFile>;
/**
 * Recursively list `.jsonl` files under a Claude Code projects root.  The
 * scanner follows the real `~/.claude/projects/**` layout but also works when
 * fixture files sit directly in the configured root. Subagent transcripts
 * (`agent-*`) are excluded.
 */
export declare function listClaudeFiles(root: string): Promise<string[]>;
/** Claude Code adapter at the import-queue seam. */
export declare function createClaudeImportAdapter(root?: string): ImportSourceAdapter;
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
export declare function convertClaudeRecords(records: readonly SourceRecord[], opts?: {
    dshSessionId?: string;
    knowTool(name: string): boolean;
}): ClaudeConversionResult;

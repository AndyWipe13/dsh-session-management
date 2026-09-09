/**
 * Dialect-neutral plumbing shared by the JSONL-backed import sources
 * (Claude Code, Codex): record guards, timestamp coercion, `~` expansion,
 * streaming JSONL reads, and directory walks. Only record interpretation
 * differs per dialect and stays in claude.ts / codex.ts.
 *
 * Read-only contract: every function here only reads source files.
 */
export interface SourceRecord {
    /** Parsed JSON object from one valid line. */
    value: Record<string, any>;
    /** 1-based line number in the source file. */
    line: number;
}
export interface SourceFileStat {
    sizeBytes: number;
    mtimeMs: number;
}
export declare function isRecord(value: unknown): value is Record<string, any>;
export declare function asString(value: unknown): string | undefined;
/** Accepts epoch millis or ISO-ish strings across source dialects. */
export declare function recordTimestamp(value: Record<string, any>): number | undefined;
/** Last path segment after forward-slash normalization, without case folding. */
export declare function pathBaseName(value: string): string;
export declare function projectNameOf(cwd: string | undefined): string | undefined;
/** Backslash→slash, trailing-slash strip, case-folded key for path comparisons. */
export declare function normalizePathKey(value: string): string;
/** Expand `~` / empty input to a concrete home-relative root. */
export declare function resolveHomeRoot(input: string | undefined, defaultRoot: () => string): string;
/** Read-only file identity shared by every source adapter. */
export declare function statSourceFile(filePath: string): Promise<SourceFileStat>;
/**
 * Stream one JSONL file. Malformed lines are skipped and counted; every valid
 * line is returned in order so converters can preserve as much fidelity as
 * possible.
 */
export declare function readJsonlFile(filePath: string): Promise<{
    stat: SourceFileStat;
    records: SourceRecord[];
    badLines: number;
}>;
/**
 * Recursively list `.jsonl` files under the given roots. Missing directories
 * are skipped; `skip` excludes files by basename (per-dialect metadata).
 */
export declare function walkJsonlFiles(roots: readonly string[], skip?: (name: string) => boolean): Promise<string[]>;

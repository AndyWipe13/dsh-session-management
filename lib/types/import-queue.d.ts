import type { ManifestStore, SessionSource } from './manifest.js';
export type ImportSource = Exclude<SessionSource, 'dsh'>;
export type ImportRecordState = 'pending' | 'complete';
export interface ImportFileStat {
    sizeBytes: number;
    mtimeMs: number;
}
export interface ImportFileSummary {
    sourceSessionId: string;
    cwd?: string;
    projectName?: string;
    title?: string;
    firstUserText?: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
    hasRealUserMessage: boolean;
    isSubagent: boolean;
}
export interface ImportFileScan {
    summary: ImportFileSummary;
    badLines: number;
}
export interface ParsedImportFile extends ImportFileScan {
    records: readonly unknown[];
}
export interface ImportConversionResult {
    dshSessionId: string;
    header: {
        cwd?: string;
        createdAt: number;
    };
    events: Array<{
        type: string;
        seq: number;
        time: number;
        data: Record<string, any>;
        surfaceOp?: 'append';
    }>;
    knownToolCalls: number;
    textCardToolCalls: number;
}
export interface ImportSourceAdapter {
    readonly source: ImportSource;
    resolveRoot(input: string | undefined): string;
    listFiles(root: string): Promise<string[]>;
    read(filePath: string): Promise<ParsedImportFile>;
    stat(filePath: string): Promise<ImportFileStat>;
    enrichTitles?(root: string, files: readonly ImportFileScan[]): Promise<ReadonlyMap<string, string>>;
    convert(records: readonly unknown[], options: {
        knowTool(name: string): boolean;
    }): ImportConversionResult;
}
export interface ImportCandidateItem {
    source: ImportSource;
    sourceSessionId: string;
    path: string;
    title?: string;
    cwd?: string;
    projectName?: string;
    createdAt: number;
    updatedAt: number;
    sizeBytes: number;
    messageCount: number;
    badLines: number;
    importState?: 'reconciliation-required';
    dshSessionId?: string;
}
export interface ImportScanResult {
    scanId: string;
    items: ImportCandidateItem[];
    total: number;
    badLines: number;
}
export interface ImportScanPageOptions {
    root?: string;
    workspace?: string;
    limit?: number;
    cursor?: string;
    scanId?: string;
}
export interface ImportScanPageResult extends ImportScanResult {
    nextCursor?: string;
}
export interface ImportSelection {
    sourceSessionId: string;
}
export interface ImportReportItem {
    sourceSessionId: string;
    path?: string;
    status: 'success' | 'skipped' | 'failed' | 'reconciliation-required';
    dshSessionId?: string;
    reason?: string;
    badLines?: number;
}
export interface ImportReport {
    items: ImportReportItem[];
    success: number;
    skipped: number;
    failed: number;
    reconciliationRequired: number;
}
export interface ImportQueueDependencies {
    manifest: ManifestStore;
    adapters: readonly ImportSourceAdapter[];
    knowTool(name: string): boolean;
    seed(conversion: ImportConversionResult, title?: string): Promise<void>;
    sessionExists(dshSessionId: string): Promise<boolean>;
    now?(): number;
}
export declare class ImportQueue {
    private readonly dependencies;
    private readonly adapters;
    private readonly fileCache;
    private readonly snapshots;
    private readonly flights;
    constructor(dependencies: ImportQueueDependencies);
    scan(source: ImportSource, root?: string): Promise<ImportScanResult>;
    scanPage(source: ImportSource, options?: ImportScanPageOptions): Promise<ImportScanPageResult>;
    import(source: ImportSource, scanId: string, selections: readonly ImportSelection[]): Promise<ImportReport>;
    inspect(source: ImportSource, root?: string): Promise<ImportCandidateItem[]>;
    supports(source: ImportSource): boolean;
    reconcileDshSessions(ids: readonly string[]): Promise<void>;
    private adapter;
    private now;
    private requireSnapshot;
    private expireSnapshots;
    private rememberSnapshot;
    private rememberFile;
    private createSnapshot;
    private reconcile;
    private importOne;
}

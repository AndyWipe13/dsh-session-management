/**
 * SessionManagement host service — the single test seam for session management.
 *
 * Issues #3/#4 implement list/search/preview/archive/unarchive; issue #5 adds
 * Claude Code scan/import plus open/resume. The service is a thin composition
 * over the official services and the plugin's import manifest; it deliberately
 * contains no filesystem access so every test can drive it through fakes.
 */
import type { ManifestStore, SessionSource } from './manifest.js';
import type { ClaudeSourceReader } from './claude.js';
import type { CodexSourceReader } from './codex.js';
export interface SessionManagementOptions {
    /** Configured Claude Code projects root; empty/undefined means caller supplies a path. */
    claudePath?: string;
    /** Configured Codex home; empty/undefined means caller supplies a path. */
    codexPath?: string;
    /**
     * Full-text search mode. `first-search` (default) enables content search via
     * the official searchSessions API; `never` falls back to title-only search.
     */
    fullTextSearch?: 'first-search' | 'never';
    /** Filesystem-facing Claude reader. Defaults are supplied by the plugin entry. */
    claude?: ClaudeSourceReader;
    /** Filesystem-facing Codex reader. Defaults are supplied by the plugin entry. */
    codex?: CodexSourceReader;
    /** Filesystem-facing artifact deleter. Defaults are supplied by the plugin entry. */
    deleter?: SessionArtifactDeleter;
    /** Defaults for the cleanup rule form. */
    cleanup?: Partial<CleanupRule>;
}
export interface SessionListFilter {
    source?: SessionSource | 'all';
    archived?: boolean | 'all';
    cwd?: string;
    workspace?: string;
    query?: string;
}
export interface SessionListItem {
    id: string;
    title?: string;
    source: SessionSource;
    cwd?: string;
    createdAt: number;
    updatedAt: number;
    sizeBytes: number;
    messageCount: number;
    durationMs: number;
    toolCalls: number;
    toolSuccess: number;
    toolNoResult: number;
    running: boolean;
    archived: boolean;
    live: boolean;
    persisted: boolean;
    blank: boolean;
    /** Plain-text excerpt from the strongest matching event, when available. */
    snippet?: string;
}
export interface SessionListResult {
    items: SessionListItem[];
    total: number;
}
export interface SessionMetric {
    id: string;
    title?: string;
    source: SessionSource;
    cwd?: string;
    createdAt: number;
    updatedAt: number;
    sizeBytes: number;
    messageCount: number;
    durationMs: number;
    toolCalls: number;
    toolSuccess: number;
    toolNoResult: number;
    running: boolean;
    archived: boolean;
    blank: boolean;
}
export interface SessionSourceStats {
    source: SessionSource;
    count: number;
    totalSizeBytes: number;
}
export interface SessionStatsResult {
    totalSessions: number;
    totalSizeBytes: number;
    bySource: SessionSourceStats[];
    sessions: SessionMetric[];
}
export interface CleanupRule {
    olderThanDays: number;
    largerThanMb: number;
    emptySessions: boolean;
    archivedOnly: boolean;
    source: SessionSource | 'all';
}
export interface CleanupPreviewItem extends SessionMetric {
    matchedRules: readonly string[];
}
export interface CleanupExcludedItem {
    sessionId: string;
    title?: string;
    reason: string;
}
export interface CleanupPreviewResult {
    previewId: string;
    rules: CleanupRule;
    items: CleanupPreviewItem[];
    excluded: CleanupExcludedItem[];
    total: number;
    totalSizeBytes: number;
}
export interface CleanupExecuteOptions {
    /** Batch (and tool) cleanup requires the exact token `DELETE`. */
    confirmToken?: string;
    /** Id returned by cleanupPreview; required so cleanup can never run un-previewed. */
    previewId?: string;
}
export interface CleanupReportItem {
    sessionId: string;
    status: 'success' | 'failed';
    path?: string;
    reason?: string;
}
export interface CleanupReport {
    items: CleanupReportItem[];
    success: number;
    failed: number;
}
export interface SessionPreview {
    id: string;
    title?: string;
    source: SessionSource;
    cwd?: string;
    createdAt: number;
    updatedAt: number;
    running: boolean;
    archived: boolean;
    events: readonly unknown[];
}
export interface ImportCandidateItem {
    source: SessionSource;
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
}
export interface ImportScanResult {
    items: ImportCandidateItem[];
    total: number;
    badLines: number;
}
export interface ImportSelection {
    sourceSessionId: string;
    path?: string;
}
export interface ImportReportItem {
    sourceSessionId: string;
    path?: string;
    status: 'success' | 'skipped' | 'failed';
    dshSessionId?: string;
    reason?: string;
    badLines?: number;
}
export interface ImportReport {
    items: ImportReportItem[];
    success: number;
    skipped: number;
    failed: number;
}
export interface SessionOpenResult {
    sessionId: string;
    resumed: boolean;
    alreadyRunning: boolean;
    cwd?: string;
    reason?: string;
}
export interface SessionDeleteOptions {
    /** Batch deletes (and all tool-driven deletes) require the exact token `DELETE`. */
    confirmToken?: string;
}
export interface SessionDeleteResult {
    deletedSessionIds: readonly string[];
    paths: readonly string[];
}
export interface SessionArtifactLocation {
    sessionId: string;
    path: string;
}
export type SessionArtifactDeleter = (location: SessionArtifactLocation) => Promise<void> | void;
/** One workspace entity as seen by the deletion cleanup path. */
export interface SessionWorkspaceLike {
    path?: string;
    sessionIds?: readonly string[];
    attachSession?(sessionId: string): Promise<void> | void;
    detachSession?(sessionId: string): Promise<void> | void;
}
/** Minimal structural face of the official services the read path needs. */
export interface SessionServiceContext {
    sessionQuery: {
        listSessions(): Promise<readonly unknown[]>;
        readSession(id: string): Promise<{
            session?: unknown;
            header?: unknown;
            events?: readonly unknown[];
        }>;
        listEvents?(id: string): Promise<readonly {
            type?: string;
            time?: number;
        }[]>;
        readTitle?(id: string): Promise<unknown>;
        readTitleSnapshot?(id: string): Promise<{
            title?: unknown;
        }>;
        readTitleSnapshots?(ids: readonly string[]): Promise<readonly {
            sessionId?: string;
            status?: string;
            value?: unknown;
        }[]>;
        searchSessions?(request: {
            query: string;
            limit?: number;
            cursor?: unknown;
            sessionFilters?: readonly unknown[];
        }): Promise<{
            items?: readonly unknown[];
            nextCursor?: unknown;
        }>;
    };
    sessionPersistence?: {
        prepare?(id: string): Promise<{
            session: {
                append(type: string, data: unknown): unknown;
            };
            [Symbol.dispose](): void;
        }>;
        readRaw?(id: string): Promise<{
            content?: string;
        } | undefined>;
        locate?(meta: {
            id: string;
            cwd?: string;
            createdAt?: number;
        }): {
            path?: string;
        } | undefined;
    };
    workspaceRegistry?: {
        create?(path: string): Promise<SessionWorkspaceLike>;
        archivedSessionIds?: readonly string[] | Set<string>;
        archiveSession?(sessionId: string): Promise<void> | void;
        enqueueOperation?(operation: () => Promise<void> | void): Promise<unknown>;
        requireState?(): {
            workspaceIds?: readonly unknown[];
            archivedSessionIds?: readonly string[];
        } | undefined;
        setState?(state: unknown): Promise<unknown> | unknown;
        list?(): readonly SessionWorkspaceLike[];
    };
    sessions?: {
        get?(id: string): unknown;
        prepare?(id?: string, options?: {
            seed?: readonly unknown[];
            meta?: {
                cwd?: string;
                createdAt?: number;
            };
        }): unknown;
        enter?(session: unknown): () => void;
        announce?(session: unknown): void;
        flush?(session: unknown): Promise<unknown>;
    };
    agents?: {
        resume?(options: {
            resumeSessionId: string;
        }): Promise<unknown>;
    };
    tools?: {
        list?(): readonly {
            name?: string;
        }[];
    };
}
export declare const DELETE_CONFIRM_TOKEN = "DELETE";
export declare class SessionManagementService {
    private readonly ctx;
    private readonly manifest;
    private readonly options;
    /** In-memory preview snapshots required before cleanup execution can run. */
    private readonly cleanupPreviews;
    /** Cached per-session statistics keyed by the session's updatedAt fingerprint. */
    private readonly detailCache;
    private static readonly MAX_DETAIL_CACHE;
    constructor(ctx: SessionServiceContext, manifest: ManifestStore, options?: SessionManagementOptions);
    /** Run async map over a bounded pool to avoid opening unbounded file handles. */
    private mapConcurrent;
    /**
     * Unified DSH native + imported session list, newest-active first.
     *
     * The official `sessionQuery.filterSessions` cannot express source (manifest),
     * archive-state (workspaceRegistry), or title search, so those predicates are
     * composed here on top of the official `listSessions` read path.  All data
     * still comes from official services; no filesystem is touched.
     */
    list(filters?: SessionListFilter): Promise<SessionListResult>;
    /**
     * Search the unified session list.
     *
     * With `fullTextSearch` left at `first-search` (the default) and the official
     * `sessionQuery.searchSessions` available, this searches conversation body
     * text (user/assistant/tool messages) and keeps the same source, archive,
     * workspace, and cwd filters. When full-text is configured `never` (or the
     * search API is unavailable) it falls back to the previous title substring
     * search.
     */
    search(query: string, filters?: SessionListFilter): Promise<SessionListResult>;
    private searchContent;
    private filteredSessionIds;
    /** Read one session's history preview through the official read path. */
    preview(id: string): Promise<SessionPreview>;
    /** Archive one session through the official workspace registry API. */
    archive(sessionId: string): Promise<void>;
    /**
     * Unarchive one session through the ADR-0001 internal channel.
     *
     * The channel is shape/version guarded: a missing or damaged internal face
     * fails loudly before any write. Repeated unarchive of an already-active
     * session is a no-op.
     */
    unarchive(sessionId: string): Promise<void>;
    /**
     * Permanently delete one or more DSH-side sessions.
     *
     * Safety gates run before any side effect:
     * - batch (and tool) calls require the exact token `DELETE`;
     * - running sessions (`ctx.sessions` hit) are rejected;
     * - the private workspaceRegistry channel shape is validated;
     * - located artifacts are asserted never to live under a third-party source tree.
     *
     * After the artifact is removed the archived set and workspace accounts are
     * cleaned, and any import manifest mapping is removed.
     */
    deleteSessions(sessionIds: readonly string[], options?: SessionDeleteOptions): Promise<SessionDeleteResult>;
    /**
     * Global and per-session statistics.
     *
     * This is a read-only walk over the unified session list; it never touches
     * third-party source files and never writes to any service.
     */
    stats(): Promise<SessionStatsResult>;
    /**
     * Generate a cleanup candidate preview from composable rules.
     *
     * This phase is strictly read-only: it walks the same unified list as the UI
     * and records an in-memory preview snapshot.  Running sessions that would
     * otherwise match are moved to `excluded` with a reason; no session is ever
     * deleted here.
     */
    cleanupPreview(overrides?: Partial<CleanupRule>): Promise<CleanupPreviewResult>;
    /**
     * Execute a previously previewed cleanup.
     *
     * Hard gates before any irreversible side effect:
     * - a live preview id from `cleanupPreview` must be supplied;
     * - every selected id must belong to that preview;
     * - the exact confirm token `DELETE` is required;
     * - running sessions are rejected by the shared delete path.
     */
    cleanupExecute(sessionIds: readonly string[], options?: CleanupExecuteOptions): Promise<CleanupReport>;
    private normalizeCleanupRule;
    /**
     * Open/resume a cold session through the official agent registry resume
     * path. Running sessions are left untouched.
     */
    open(sessionId: string): Promise<SessionOpenResult>;
    /**
     * Scan the configured (or caller-supplied) Claude Code projects directory
     * and return only unimported, non-subagent, non-empty main sessions.
     */
    scanClaude(root?: string): Promise<ImportScanResult>;
    /**
     * Import one or more previously scanned Claude Code sessions through the
     * official session seed path.  Already-imported sessions are skipped; bad
     * lines are counted and do not abort the whole file.
     */
    importClaude(selections: readonly ImportSelection[], root?: string): Promise<ImportReport>;
    /**
     * Scan the configured (or caller-supplied) Codex home and return only
     * unimported, non-subagent, non-empty main sessions from both `sessions/`
     * and `archived_sessions/`.
     */
    scanCodex(root?: string): Promise<ImportScanResult>;
    /**
     * Import one or more previously scanned Codex sessions through the official
     * session seed path.  Already-imported sessions are skipped; bad lines are
     * counted and do not abort the whole file.
     */
    importCodex(selections: readonly ImportSelection[], root?: string): Promise<ImportReport>;
    private requireCodex;
    private scanCodexFiles;
    private requireClaude;
    private scanClaudeFiles;
    private isKnownTool;
    private workspaceForImport;
    /** Repair workspace membership for persisted imports created by older versions. */
    repairImportedWorkspaces(): Promise<ImportReport>;
    private restoreImportedTitle;
    private createImportedSession;
    private sourceOf;
    private titleOf;
    private eventsOf;
    /** Single-pass metrics over an event list; avoids multiple full-array scans. */
    private computeMetrics;
    private detailOf;
    private isToolResultSuccess;
    private sizeOf;
    private lastActiveAt;
    private locateDeletionTarget;
    private assertWorkspaceCleanupAvailable;
    private removeArchived;
    private detachWorkspaces;
    private removeManifest;
    private isRunning;
}
/** Convenience factory used by the plugin entry. */
export declare function createSessionManagementService(ctx: SessionServiceContext, manifest: ManifestStore, options?: SessionManagementOptions): SessionManagementService;
/** Backward-friendly aliases matching the spec's "SessionManagement 服务" naming. */
export declare const SessionManagement: typeof SessionManagementService;
export declare const createSessionManagement: typeof createSessionManagementService;

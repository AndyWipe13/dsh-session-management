/**
 * SessionManagement host service — the single test seam for session management.
 *
 * Issues #3/#4 implement list/search/preview/archive/unarchive; issue #5 adds
 * Claude Code scan/import plus open/resume. The service is a thin composition
 * over the official services and the plugin's import manifest; it deliberately
 * contains no filesystem access so every test can drive it through fakes.
 */
import type { ManifestStore, SessionSource } from './manifest.js';
import type { ImportReport, ImportScanPageOptions, ImportScanPageResult, ImportScanResult, ImportSelection, ImportSource, ImportSourceAdapter } from './import-queue.js';
import { type DshHostAdapter } from './dsh-host.js';
export type { ImportCandidateItem, ImportReport, ImportReportItem, ImportScanPageOptions, ImportScanPageResult, ImportScanResult, ImportSelection, ImportSource, ImportSourceAdapter, } from './import-queue.js';
export interface SessionManagementOptions {
    /** Substitute the DSH host implementation at the host-adapter seam. */
    host?: DshHostAdapter;
    /** Detected host version; defaults to the installed @deepseek-ai/dsh package. */
    dshVersion?: string;
    /** Configured Claude Code projects root; empty/undefined means caller supplies a path. */
    claudePath?: string;
    /** Configured Codex home; empty/undefined means caller supplies a path. */
    codexPath?: string;
    /**
     * Full-text search mode. `first-search` (default) enables content search via
     * the official searchSessions API; `never` falls back to title-only search.
     */
    fullTextSearch?: 'first-search' | 'never';
    /** Source-dialect adapters at the import-queue seam. */
    imports?: readonly ImportSourceAdapter[];
    /** Filesystem-facing artifact deleter. Defaults are supplied by the plugin entry. */
    deleter?: SessionArtifactDeleter;
    /** Read-only file identity fallback for hosts without persistence list/stat metadata. */
    sessionArtifactStat?: (path: string) => Promise<{
        sizeBytes: number;
        mtimeMs: number;
    }>;
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
/** Identity, provenance, activity, and state shared by every session projection. */
export interface SessionProjectionCore {
    id: string;
    title?: string;
    source: SessionSource;
    cwd?: string;
    createdAt: number;
    updatedAt: number;
    running: boolean;
    archived: boolean;
}
/** Event-derived measurements shared by detailed session projections. */
export interface SessionProjectionMetrics {
    sizeBytes: number;
    messageCount: number;
    durationMs: number;
    toolCalls: number;
    toolSuccess: number;
    toolNoResult: number;
}
export interface SessionListItem extends SessionProjectionCore, SessionProjectionMetrics {
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
/** Cursor-page row used by the settings page. Event metrics are optional. */
export interface SessionPageItem extends SessionProjectionCore {
    live: boolean;
    persisted: boolean;
    blank: boolean;
    sizeBytes?: number;
    messageCount?: number;
    durationMs?: number;
    snippet?: string;
}
export interface SessionPageOptions {
    limit?: number;
    cursor?: string;
    /** Hydrate event-derived values for the selected page only. */
    includeMetrics?: boolean;
}
export interface SessionPageResult {
    items: SessionPageItem[];
    total: number;
    nextCursor?: string;
}
export interface SessionMetric extends SessionProjectionCore, SessionProjectionMetrics {
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
export interface SessionPreview extends SessionProjectionCore, SessionProjectionMetrics {
    events: readonly unknown[];
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
    failures?: readonly {
        sessionId: string;
        reason: string;
    }[];
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
    /** Explicit host version used by structural fakes; production resolves the installed package. */
    dshVersion?: string;
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
        stat?(id: string): Promise<{
            header?: {
                id?: string;
            };
            revision?: unknown;
            sizeBytes?: number;
        } | undefined>;
        list?(): Promise<readonly {
            header?: {
                id?: string;
            };
            revision?: unknown;
            sizeBytes?: number;
        }[]>;
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
        get?(id: string): unknown | Promise<unknown>;
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
        get?(id: string): unknown | Promise<unknown>;
        resume?(options: {
            resumeSessionId: string;
        }): Promise<unknown>;
    };
    apiProxy?: {
        sessions?: {
            create?(request: {
                rpcId: string;
                payload: {
                    sessionId: string;
                    cwd: string;
                };
            }): Promise<{
                result: {
                    ok: true;
                    value: {
                        sessionId: string;
                    };
                } | {
                    ok: false;
                    error: {
                        message: string;
                    };
                };
            }>;
        };
    };
    tools?: {
        list?(): readonly {
            name?: string;
        }[];
    };
}
/** Keep only well-formed session ids from an untrusted array. */
export declare function sanitizeSessionIds(values: unknown): string[];
export declare const DELETE_CONFIRM_TOKEN = "DELETE";
export declare class SessionManagementService {
    private readonly manifest;
    private readonly options;
    /** In-memory preview snapshots required before cleanup execution can run. */
    private readonly cleanupPreviews;
    /** Canonical read model shared by list, search, preview, statistics, and cleanup. */
    private readonly projection;
    /** The only module that understands DSH rc.7 host shapes and fallbacks. */
    private readonly host;
    /** Deep import queue; source-dialect details stay behind its adapter seam. */
    private readonly importQueue;
    constructor(ctx: SessionServiceContext, manifest: ManifestStore, options?: SessionManagementOptions);
    list(filters?: SessionListFilter): Promise<SessionListResult>;
    listPage(filters?: SessionListFilter, page?: SessionPageOptions): Promise<SessionPageResult>;
    search(query: string, filters?: SessionListFilter): Promise<SessionListResult>;
    searchPage(query: string, filters?: SessionListFilter, page?: SessionPageOptions): Promise<SessionPageResult>;
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
     * - attached sessions (`ctx.sessions` hit) are rejected, regardless of agent status;
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
    /** Resolve cwd from the header scan; only fall back to the full session read. */
    private sessionCwd;
    /**
     * Scan the configured (or caller-supplied) Claude Code projects directory
     * and return only unimported, non-subagent, non-empty main sessions.
     */
    scan(source: ImportSource, root?: string): Promise<ImportScanResult>;
    scanPage(source: ImportSource, page?: ImportScanPageOptions): Promise<ImportScanPageResult>;
    /**
     * Import one or more previously scanned Claude Code sessions through the
     * official session seed path.  Already-imported sessions are skipped; bad
     * lines are counted and do not abort the whole file.
     */
    import(source: ImportSource, scanId: string, selections: readonly ImportSelection[]): Promise<ImportReport>;
    /** Persisted session records managed by this workspace (subagents filtered out). */
    private managedRecords;
    /** Repair workspace membership for persisted imports created by older versions. */
    repairImportedWorkspaces(): Promise<ImportReport>;
    reconcileImports(): Promise<void>;
    private removeManifest;
}
/** Convenience factory used by the plugin entry. */
export declare function createSessionManagementService(ctx: SessionServiceContext, manifest: ManifestStore, options?: SessionManagementOptions): SessionManagementService;

/**
 * Canonical projection of DSH native and imported sessions.
 *
 * All read paths cross this module so identity, activity, title, source,
 * runtime state, archive state, metrics, and caching have one implementation.
 */
import type { ManifestStore } from './manifest.js';
import type { DshHostAdapter, HostPersistenceHint } from './dsh-host.js';
import type { SessionListFilter, SessionListResult, SessionManagementOptions, SessionPageOptions, SessionPageResult, SessionPreview } from './service.js';
type SessionDetailHint = HostPersistenceHint;
export declare class SessionProjection {
    private readonly host;
    private readonly manifest;
    private readonly options;
    private readonly detailCache;
    private static readonly MAX_DETAIL_CACHE;
    private readonly titleCache;
    constructor(host: DshHostAdapter, manifest: ManifestStore, options: Pick<SessionManagementOptions, 'fullTextSearch'>);
    private filteredCandidates;
    private collectSearchHits;
    /**
     * Unified DSH native + imported session list, newest-active first.
     *
     * The official `sessionQuery.filterSessions` cannot express source (manifest),
     * archive-state (workspaceRegistry), or title search, so those predicates are
     * composed here on top of the official `listSessions` read path.  All data
     * still comes from official services; no filesystem is touched.
     */
    list(filters?: SessionListFilter): Promise<SessionListResult>;
    /** Cursor page for the settings UI. Metrics remain opt-in for lightweight callers. */
    listPage(filters?: SessionListFilter, page?: SessionPageOptions): Promise<SessionPageResult>;
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
    /** Full-text search page for the settings UI. Metrics remain opt-in. */
    searchPage(query: string, filters?: SessionListFilter, page?: SessionPageOptions): Promise<SessionPageResult>;
    private searchContent;
    /**
     * The one canonical SessionListItem assembly, shared by the list and search
     * paths: source metadata, batched titles, and event metrics hydrate into a
     * single row shape so the two views cannot drift.
     */
    private hydrateListItems;
    /** Read one session's history preview through the official read path. */
    preview(id: string): Promise<SessionPreview>;
    private sourceMetadataOf;
    titleOf(id: string): Promise<string | undefined>;
    /**
     * Batch title reads are essential here: the official implementation scans
     * persistence once per call, so every multi-session path must batch.
     */
    titlesOf(ids: readonly string[], hints?: ReadonlyMap<string, SessionDetailHint>): Promise<Map<string, string | undefined>>;
    private titleFromEvents;
    private rememberTitle;
    private buildPage;
    private persistenceHints;
    private eventsOf;
    /** Single-pass metrics over an event list; avoids multiple full-array scans. */
    private computeMetrics;
    private mergeMetrics;
    private detailFromMetrics;
    private detailOf;
    private isToolResultSuccess;
    private sizeOf;
    private sizeOfEvents;
    isRunning(id: string): Promise<boolean>;
}
export {};

/**
 * SessionManagement host service — the single test seam for session management.
 *
 * Issues #3/#4 implement list/search/preview/archive/unarchive; issue #5 adds
 * Claude Code scan/import plus open/resume. The service is a thin composition
 * over the official services and the plugin's import manifest; it deliberately
 * contains no filesystem access so every test can drive it through fakes.
 */
import { convertClaudeRecords } from './claude.js';
import { applyCodexThreadTitle, convertCodexRecords } from './codex.js';
function isSessionRecord(value) {
    return typeof value === 'object' && value !== null;
}
function recordId(record) {
    return record.header?.id ?? record.id ?? '';
}
function recordHeader(record) {
    return record.header;
}
function normalizeTitle(value) {
    if (value == null)
        return undefined;
    if (typeof value === 'string')
        return value;
    const obj = value;
    if (typeof obj.title === 'string')
        return obj.title;
    return undefined;
}
function normalizeTitleObservation(result) {
    if (result == null)
        return undefined;
    const obj = result;
    if (obj.title != null)
        return normalizeTitle(obj.title);
    if (obj.value != null)
        return normalizeTitle(obj.value);
    return undefined;
}
function normalizeReadSession(value) {
    const header = (value.session ?? value.header);
    return {
        id: header?.id,
        createdAt: header?.createdAt,
        cwd: header?.cwd,
        events: (value.events ?? []),
    };
}
function searchHitId(hit) {
    return hit.header?.id ?? hit.id ?? '';
}
function searchHitSnippet(hit) {
    return hit.bestMatch?.snippet;
}
function workspaceMatches(cwd, workspace) {
    if (!workspace)
        return true;
    if (!cwd)
        return false;
    const normalized = cwd.replace(/\\/g, '/');
    const base = normalized.split('/').filter(Boolean).pop() ?? '';
    return normalized === workspace || base === workspace || normalized.includes(workspace);
}
function archivedSetOf(workspaceRegistry) {
    const raw = workspaceRegistry?.archivedSessionIds;
    if (!raw)
        return new Set();
    if (Array.isArray(raw))
        return new Set(raw);
    return raw instanceof Set ? raw : new Set();
}
const DSH_RC_VERSION = '0.1.0-rc.7';
const UNARCHIVE_CHANNEL_VERSION = 1;
export const DELETE_CONFIRM_TOKEN = 'DELETE';
function requireUnarchiveChannel(registry) {
    if (!registry || typeof registry.enqueueOperation !== 'function' || typeof registry.requireState !== 'function' || typeof registry.setState !== 'function') {
        throw new Error(`workspaceRegistry.unarchive internal channel is unavailable: expected enqueueOperation/requireState/setState ` +
            `(DSH ${DSH_RC_VERSION}, channel v${UNARCHIVE_CHANNEL_VERSION})`);
    }
    return registry;
}
/** Shared internal-channel state validation for unarchive/delete cleanup. */
function requireRegistryState(registry) {
    const channel = requireUnarchiveChannel(registry);
    const state = channel.requireState();
    if (!state ||
        typeof state.initialized !== 'boolean' ||
        !Array.isArray(state.archivedSessionIds) ||
        state.archivedSessionIds.some((id) => typeof id !== 'string') ||
        !Array.isArray(state.workspaceIds) ||
        state.workspaceIds.some((id) => typeof id !== 'string')) {
        throw new Error(`workspaceRegistry unarchive internal channel state is invalid: expected initialized boolean, workspaceIds string[], archivedSessionIds string[] ` +
            `(DSH ${DSH_RC_VERSION}, channel v${UNARCHIVE_CHANNEL_VERSION})`);
    }
    return {
        initialized: state.initialized,
        workspaceIds: state.workspaceIds,
        archivedSessionIds: state.archivedSessionIds,
    };
}
const THIRD_PARTY_SOURCE_SEGMENTS = new Set(['.claude', '.codex']);
function isProtectedThirdPartyPath(filePath) {
    const segments = filePath.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
    return segments.some((segment) => THIRD_PARTY_SOURCE_SEGMENTS.has(segment));
}
export class SessionManagementService {
    ctx;
    manifest;
    options;
    /** In-memory preview snapshots required before cleanup execution can run. */
    cleanupPreviews = new Map();
    constructor(ctx, manifest, options = {}) {
        this.ctx = ctx;
        this.manifest = manifest;
        this.options = options;
    }
    /**
     * Unified DSH native + imported session list, newest-active first.
     *
     * The official `sessionQuery.filterSessions` cannot express source (manifest),
     * archive-state (workspaceRegistry), or title search, so those predicates are
     * composed here on top of the official `listSessions` read path.  All data
     * still comes from official services; no filesystem is touched.
     */
    async list(filters = {}) {
        const records = await this.ctx.sessionQuery.listSessions();
        const archived = archivedSetOf(this.ctx.workspaceRegistry);
        const items = [];
        for (const raw of records) {
            if (!isSessionRecord(raw))
                continue;
            const id = recordId(raw);
            if (!id)
                continue;
            const header = recordHeader(raw);
            const cwd = header?.cwd;
            if (filters.cwd && cwd !== filters.cwd)
                continue;
            if (filters.workspace && !workspaceMatches(cwd, filters.workspace))
                continue;
            const isArchived = archived.has(id);
            if (filters.archived != null && filters.archived !== 'all' && isArchived !== filters.archived) {
                continue;
            }
            const source = await this.sourceOf(id);
            if (filters.source && filters.source !== 'all' && source !== filters.source)
                continue;
            const title = await this.titleOf(id);
            if (filters.query) {
                const q = filters.query.trim().toLowerCase();
                if (!q || !(title ?? '').toLowerCase().includes(q))
                    continue;
            }
            const detail = await this.detailOf(id, source, isArchived, raw);
            items.push({
                id,
                title,
                source,
                cwd,
                createdAt: detail.createdAt,
                updatedAt: detail.updatedAt,
                sizeBytes: detail.sizeBytes,
                messageCount: detail.messageCount,
                durationMs: detail.durationMs,
                toolCalls: detail.toolCalls,
                toolSuccess: detail.toolSuccess,
                toolNoResult: detail.toolNoResult,
                running: detail.running,
                archived: isArchived,
                live: detail.live,
                persisted: detail.persisted,
                blank: detail.blank,
            });
        }
        items.sort((a, b) => b.updatedAt - a.updatedAt);
        return { items, total: items.length };
    }
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
    async search(query, filters = {}) {
        const q = query?.trim() ?? '';
        if (!q)
            return this.list(filters);
        if (this.options.fullTextSearch !== 'never' && typeof this.ctx.sessionQuery.searchSessions === 'function') {
            return this.searchContent(q, filters);
        }
        return this.list({ ...filters, query: q });
    }
    async searchContent(query, filters = {}) {
        const searchSessions = this.ctx.sessionQuery.searchSessions;
        if (typeof searchSessions !== 'function') {
            return this.list({ ...filters, query });
        }
        // Apply plugin-owned filters (source, archive state, workspace) to the full
        // logical corpus first, then ask the official full-text engine to search
        // only that filtered session pool. This keeps search + filters composable
        // without dropping matches after a pagination cap.
        const sessionIds = await this.filteredSessionIds(filters);
        if (sessionIds.length === 0)
            return { items: [], total: 0 };
        const sessionFilters = [{ kind: 'id', values: sessionIds }];
        if (filters.cwd)
            sessionFilters.push({ kind: 'cwd', values: [filters.cwd] });
        const hits = [];
        let cursor;
        do {
            const page = await searchSessions({
                query,
                limit: 100,
                ...(cursor !== undefined ? { cursor } : {}),
                sessionFilters,
            });
            const pageItems = (page?.items ?? []);
            for (const raw of pageItems) {
                if (typeof raw === 'object' && raw !== null)
                    hits.push(raw);
            }
            cursor = page?.nextCursor;
        } while (cursor !== undefined);
        const archived = archivedSetOf(this.ctx.workspaceRegistry);
        const items = [];
        for (const hit of hits) {
            const id = searchHitId(hit);
            if (!id || !sessionIds.includes(id))
                continue;
            const header = hit.header;
            const cwd = header?.cwd;
            const isArchived = archived.has(id);
            const source = await this.sourceOf(id);
            const title = await this.titleOf(id);
            const detail = await this.detailOf(id, source, isArchived, hit);
            items.push({
                id,
                title,
                source,
                cwd,
                createdAt: detail.createdAt,
                updatedAt: detail.updatedAt,
                sizeBytes: detail.sizeBytes,
                messageCount: detail.messageCount,
                durationMs: detail.durationMs,
                toolCalls: detail.toolCalls,
                toolSuccess: detail.toolSuccess,
                toolNoResult: detail.toolNoResult,
                running: detail.running,
                archived: isArchived,
                live: detail.live,
                persisted: detail.persisted,
                blank: detail.blank,
                snippet: searchHitSnippet(hit),
            });
        }
        items.sort((a, b) => b.updatedAt - a.updatedAt);
        return { items, total: items.length };
    }
    async filteredSessionIds(filters) {
        const records = await this.ctx.sessionQuery.listSessions();
        const archived = archivedSetOf(this.ctx.workspaceRegistry);
        const ids = [];
        for (const raw of records) {
            if (!isSessionRecord(raw))
                continue;
            const id = recordId(raw);
            if (!id)
                continue;
            const header = recordHeader(raw);
            const cwd = header?.cwd;
            if (filters.cwd && cwd !== filters.cwd)
                continue;
            if (filters.workspace && !workspaceMatches(cwd, filters.workspace))
                continue;
            const isArchived = archived.has(id);
            if (filters.archived != null && filters.archived !== 'all' && isArchived !== filters.archived)
                continue;
            const source = await this.sourceOf(id);
            if (filters.source && filters.source !== 'all' && source !== filters.source)
                continue;
            ids.push(id);
        }
        return ids;
    }
    /** Read one session's history preview through the official read path. */
    async preview(id) {
        const snapshot = await this.ctx.sessionQuery.readSession(id);
        const normalized = normalizeReadSession(snapshot);
        const source = await this.sourceOf(id);
        const archived = archivedSetOf(this.ctx.workspaceRegistry).has(id);
        const title = await this.titleOf(id);
        const running = await this.isRunning(id);
        return {
            id,
            title,
            source,
            cwd: normalized.cwd,
            createdAt: normalized.createdAt ?? 0,
            updatedAt: this.lastActiveAt(normalized.events, normalized.createdAt),
            running,
            archived,
            events: normalized.events,
        };
    }
    /** Archive one session through the official workspace registry API. */
    async archive(sessionId) {
        const registry = this.ctx.workspaceRegistry;
        if (!registry || typeof registry.archiveSession !== 'function') {
            throw new Error(`workspaceRegistry.archiveSession is unavailable (DSH ${DSH_RC_VERSION})`);
        }
        await registry.archiveSession(sessionId);
    }
    /**
     * Unarchive one session through the ADR-0001 internal channel.
     *
     * The channel is shape/version guarded: a missing or damaged internal face
     * fails loudly before any write. Repeated unarchive of an already-active
     * session is a no-op.
     */
    async unarchive(sessionId) {
        const registry = requireUnarchiveChannel(this.ctx.workspaceRegistry);
        await registry.enqueueOperation(async () => {
            const state = requireRegistryState(this.ctx.workspaceRegistry);
            if (!state.archivedSessionIds.includes(sessionId))
                return;
            await registry.setState({
                ...state,
                archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
            });
        });
    }
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
    async deleteSessions(sessionIds, options = {}) {
        const ids = [...new Set(sessionIds.filter((id) => typeof id === 'string' && id.length > 0))];
        if (ids.length === 0) {
            throw new Error('No session ids provided for deletion');
        }
        if (options.confirmToken !== DELETE_CONFIRM_TOKEN) {
            throw new Error('Delete requires the exact token DELETE');
        }
        // Validate every gate before any irreversible side effect.
        const registry = requireUnarchiveChannel(this.ctx.workspaceRegistry);
        requireRegistryState(this.ctx.workspaceRegistry);
        const running = [];
        for (const id of ids) {
            if (await this.isRunning(id))
                running.push(id);
        }
        if (running.length > 0) {
            throw new Error(`Cannot delete running session(s): ${running.join(', ')}`);
        }
        const locations = [];
        for (const id of ids) {
            locations.push(await this.locateDeletionTarget(id));
        }
        if (!this.options.deleter) {
            throw new Error('Session artifact deleter is not configured');
        }
        // Double-check all cleanup faces before deleting anything.
        await this.manifest.assertDeleteAvailable();
        this.assertWorkspaceCleanupAvailable(ids);
        for (const location of locations) {
            await this.options.deleter(location);
        }
        await this.removeArchived(ids, registry);
        await this.detachWorkspaces(ids);
        await this.removeManifest(ids);
        return {
            deletedSessionIds: ids,
            paths: locations.map((location) => location.path),
        };
    }
    /**
     * Global and per-session statistics.
     *
     * This is a read-only walk over the unified session list; it never touches
     * third-party source files and never writes to any service.
     */
    async stats() {
        const result = await this.list();
        const bySource = new Map([
            ['dsh', { count: 0, totalSizeBytes: 0 }],
            ['claude-code', { count: 0, totalSizeBytes: 0 }],
            ['codex', { count: 0, totalSizeBytes: 0 }],
        ]);
        const sessions = result.items.map((item) => ({
            id: item.id,
            title: item.title,
            source: item.source,
            cwd: item.cwd,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            sizeBytes: item.sizeBytes,
            messageCount: item.messageCount,
            durationMs: item.durationMs,
            toolCalls: item.toolCalls,
            toolSuccess: item.toolSuccess,
            toolNoResult: item.toolNoResult,
            running: item.running,
            archived: item.archived,
            blank: item.blank,
        }));
        for (const session of sessions) {
            const entry = bySource.get(session.source);
            entry.count += 1;
            entry.totalSizeBytes += session.sizeBytes;
        }
        const bySourceList = [...bySource.entries()].map(([source, value]) => ({
            source,
            ...value,
        }));
        return {
            totalSessions: sessions.length,
            totalSizeBytes: sessions.reduce((sum, session) => sum + session.sizeBytes, 0),
            bySource: bySourceList,
            sessions,
        };
    }
    /**
     * Generate a cleanup candidate preview from composable rules.
     *
     * This phase is strictly read-only: it walks the same unified list as the UI
     * and records an in-memory preview snapshot.  Running sessions that would
     * otherwise match are moved to `excluded` with a reason; no session is ever
     * deleted here.
     */
    async cleanupPreview(overrides = {}) {
        const rules = this.normalizeCleanupRule(overrides);
        const listResult = await this.list({
            source: rules.source === 'all' ? undefined : rules.source,
            archived: rules.archivedOnly ? true : undefined,
        });
        const items = [];
        const excluded = [];
        const now = Date.now();
        const olderThanMs = rules.olderThanDays > 0 ? rules.olderThanDays * 24 * 60 * 60 * 1000 : 0;
        const largerThanBytes = rules.largerThanMb > 0 ? rules.largerThanMb * 1024 * 1024 : 0;
        for (const item of listResult.items) {
            const matchedRules = [];
            if (olderThanMs > 0 && now - item.updatedAt >= olderThanMs)
                matchedRules.push('olderThanDays');
            if (largerThanBytes > 0 && item.sizeBytes > largerThanBytes)
                matchedRules.push('largerThanMb');
            if (rules.emptySessions && item.blank)
                matchedRules.push('emptySessions');
            if (matchedRules.length === 0)
                continue;
            if (item.running) {
                excluded.push({
                    sessionId: item.id,
                    title: item.title,
                    reason: `Running session is never deleted${matchedRules.length > 0 ? ` (matched: ${matchedRules.join(', ')})` : ''}`,
                });
                continue;
            }
            items.push({
                id: item.id,
                title: item.title,
                source: item.source,
                cwd: item.cwd,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
                sizeBytes: item.sizeBytes,
                messageCount: item.messageCount,
                durationMs: item.durationMs,
                toolCalls: item.toolCalls,
                toolSuccess: item.toolSuccess,
                toolNoResult: item.toolNoResult,
                running: false,
                archived: item.archived,
                blank: item.blank,
                matchedRules,
            });
        }
        const previewId = `preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        this.cleanupPreviews.set(previewId, {
            sessionIds: items.map((item) => item.id),
        });
        return {
            previewId,
            rules,
            items,
            excluded,
            total: items.length,
            totalSizeBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
        };
    }
    /**
     * Execute a previously previewed cleanup.
     *
     * Hard gates before any irreversible side effect:
     * - a live preview id from `cleanupPreview` must be supplied;
     * - every selected id must belong to that preview;
     * - the exact confirm token `DELETE` is required;
     * - running sessions are rejected by the shared delete path.
     */
    async cleanupExecute(sessionIds, options = {}) {
        if (options.confirmToken !== DELETE_CONFIRM_TOKEN) {
            throw new Error('Cleanup requires the exact token DELETE');
        }
        if (!options.previewId) {
            throw new Error('Cleanup must be previewed before execution');
        }
        const preview = this.cleanupPreviews.get(options.previewId);
        if (!preview) {
            throw new Error('Cleanup preview is missing or expired; run cleanupPreview again');
        }
        this.cleanupPreviews.delete(options.previewId);
        const ids = [...new Set(sessionIds.filter((id) => typeof id === 'string' && id.length > 0))];
        if (ids.length === 0) {
            return { items: [], success: 0, failed: 0 };
        }
        const notInPreview = ids.filter((id) => !preview.sessionIds.includes(id));
        if (notInPreview.length > 0) {
            throw new Error(`Cleanup selection includes sessions not in the latest preview: ${notInPreview.join(', ')}`);
        }
        try {
            const result = await this.deleteSessions(ids, { confirmToken: DELETE_CONFIRM_TOKEN });
            return {
                items: ids.map((id) => {
                    const path = result.paths[result.deletedSessionIds.indexOf(id)];
                    return {
                        sessionId: id,
                        status: 'success',
                        ...(path ? { path } : {}),
                    };
                }),
                success: ids.length,
                failed: 0,
            };
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return {
                items: ids.map((id) => ({ sessionId: id, status: 'failed', reason })),
                success: 0,
                failed: ids.length,
            };
        }
    }
    normalizeCleanupRule(overrides) {
        return {
            olderThanDays: overrides.olderThanDays ?? this.options.cleanup?.olderThanDays ?? 30,
            largerThanMb: overrides.largerThanMb ?? this.options.cleanup?.largerThanMb ?? 100,
            emptySessions: overrides.emptySessions ?? this.options.cleanup?.emptySessions ?? false,
            archivedOnly: overrides.archivedOnly ?? this.options.cleanup?.archivedOnly ?? true,
            source: overrides.source ?? this.options.cleanup?.source ?? 'all',
        };
    }
    /**
     * Open/resume a cold session through the official agent registry resume
     * path. Running sessions are left untouched.
     */
    async open(sessionId) {
        if (await this.isRunning(sessionId)) {
            return { sessionId, resumed: false, alreadyRunning: true };
        }
        if (!this.ctx.agents?.resume) {
            throw new Error(`agents.resume is unavailable (DSH ${DSH_RC_VERSION})`);
        }
        const snapshot = await this.ctx.sessionQuery.readSession(sessionId);
        const normalized = normalizeReadSession(snapshot);
        await this.ctx.agents.resume({ resumeSessionId: sessionId });
        return {
            sessionId,
            resumed: true,
            alreadyRunning: false,
            cwd: normalized.cwd,
        };
    }
    /**
     * Scan the configured (or caller-supplied) Claude Code projects directory
     * and return only unimported, non-subagent, non-empty main sessions.
     */
    async scanClaude(root) {
        const files = await this.scanClaudeFiles(root);
        files.sort((a, b) => b.updatedAt - a.updatedAt);
        return {
            items: files,
            total: files.length,
            badLines: files.reduce((sum, item) => sum + item.badLines, 0),
        };
    }
    /**
     * Import one or more previously scanned Claude Code sessions through the
     * official session seed path.  Already-imported sessions are skipped; bad
     * lines are counted and do not abort the whole file.
     */
    async importClaude(selections, root) {
        const reader = this.requireClaude();
        const scanRoot = root ?? this.options.claudePath;
        if (!scanRoot) {
            throw new Error('Claude import root is not configured; pass claudePath or scan root');
        }
        const scanned = await this.scanClaudeFiles(scanRoot);
        const byId = new Map(scanned.map((item) => [item.sourceSessionId, item]));
        const items = [];
        for (const selection of selections) {
            const existing = await this.manifest.getBySource('claude-code', selection.sourceSessionId);
            if (existing) {
                items.push({
                    sourceSessionId: selection.sourceSessionId,
                    path: selection.path,
                    status: 'skipped',
                    dshSessionId: existing.dshSessionId,
                    reason: 'Already imported',
                });
                continue;
            }
            const candidate = byId.get(selection.sourceSessionId);
            if (!candidate) {
                items.push({
                    sourceSessionId: selection.sourceSessionId,
                    path: selection.path,
                    status: 'failed',
                    reason: 'Session is not in the unimported scan queue (already imported, subagent, empty, or not found)',
                });
                continue;
            }
            try {
                const parsed = await reader.readClaudeFile(candidate.path);
                const conversion = convertClaudeRecords(parsed.records, {
                    knowTool: (name) => this.isKnownTool(name),
                });
                const dshSessionId = await this.createImportedSession(conversion);
                await this.manifest.put({
                    source: 'claude-code',
                    sourceSessionId: candidate.sourceSessionId,
                    dshSessionId,
                    importedAt: Date.now(),
                });
                items.push({
                    sourceSessionId: candidate.sourceSessionId,
                    path: candidate.path,
                    status: 'success',
                    dshSessionId,
                    badLines: parsed.badLines,
                });
            }
            catch (error) {
                items.push({
                    sourceSessionId: candidate.sourceSessionId,
                    path: candidate.path,
                    status: 'failed',
                    reason: error instanceof Error ? error.message : String(error),
                    badLines: 0,
                });
            }
        }
        return {
            items,
            success: items.filter((item) => item.status === 'success').length,
            skipped: items.filter((item) => item.status === 'skipped').length,
            failed: items.filter((item) => item.status === 'failed').length,
        };
    }
    /**
     * Scan the configured (or caller-supplied) Codex home and return only
     * unimported, non-subagent, non-empty main sessions from both `sessions/`
     * and `archived_sessions/`.
     */
    async scanCodex(root) {
        const files = await this.scanCodexFiles(root);
        files.sort((a, b) => b.updatedAt - a.updatedAt);
        return {
            items: files,
            total: files.length,
            badLines: files.reduce((sum, item) => sum + item.badLines, 0),
        };
    }
    /**
     * Import one or more previously scanned Codex sessions through the official
     * session seed path.  Already-imported sessions are skipped; bad lines are
     * counted and do not abort the whole file.
     */
    async importCodex(selections, root) {
        const reader = this.requireCodex();
        const scanRoot = root ?? this.options.codexPath;
        if (!scanRoot) {
            throw new Error('Codex import root is not configured; pass codexPath or scan root');
        }
        const scanned = await this.scanCodexFiles(scanRoot);
        const byId = new Map(scanned.map((item) => [item.sourceSessionId, item]));
        const items = [];
        for (const selection of selections) {
            const existing = await this.manifest.getBySource('codex', selection.sourceSessionId);
            if (existing) {
                items.push({
                    sourceSessionId: selection.sourceSessionId,
                    path: selection.path,
                    status: 'skipped',
                    dshSessionId: existing.dshSessionId,
                    reason: 'Already imported',
                });
                continue;
            }
            const candidate = byId.get(selection.sourceSessionId);
            if (!candidate) {
                items.push({
                    sourceSessionId: selection.sourceSessionId,
                    path: selection.path,
                    status: 'failed',
                    reason: 'Session is not in the unimported scan queue (already imported, subagent, empty, or not found)',
                });
                continue;
            }
            try {
                const parsed = await reader.readCodexFile(candidate.path);
                const conversion = convertCodexRecords(parsed.records, {
                    knowTool: (name) => this.isKnownTool(name),
                });
                const dshSessionId = await this.createImportedSession(conversion);
                await this.manifest.put({
                    source: 'codex',
                    sourceSessionId: candidate.sourceSessionId,
                    dshSessionId,
                    importedAt: Date.now(),
                });
                items.push({
                    sourceSessionId: candidate.sourceSessionId,
                    path: candidate.path,
                    status: 'success',
                    dshSessionId,
                    badLines: parsed.badLines,
                });
            }
            catch (error) {
                items.push({
                    sourceSessionId: candidate.sourceSessionId,
                    path: candidate.path,
                    status: 'failed',
                    reason: error instanceof Error ? error.message : String(error),
                    badLines: 0,
                });
            }
        }
        return {
            items,
            success: items.filter((item) => item.status === 'success').length,
            skipped: items.filter((item) => item.status === 'skipped').length,
            failed: items.filter((item) => item.status === 'failed').length,
        };
    }
    requireCodex() {
        if (!this.options.codex) {
            throw new Error('Codex source reader is not configured');
        }
        return this.options.codex;
    }
    async scanCodexFiles(root) {
        const reader = this.requireCodex();
        const scanRoot = root ?? this.options.codexPath;
        if (!scanRoot) {
            throw new Error('Codex import root is not configured; pass codexPath or scan root');
        }
        const files = await reader.listCodexFiles(scanRoot);
        const seen = new Map();
        for (const file of files) {
            const parsed = await reader.readCodexFile(file);
            if (parsed.summary.isSubagent)
                continue;
            if (!parsed.summary.hasRealUserMessage)
                continue;
            const existing = await this.manifest.getBySource('codex', parsed.summary.sourceSessionId);
            if (existing)
                continue;
            if (seen.has(parsed.summary.sourceSessionId))
                continue;
            const threadTitle = await reader.resolveTitle(scanRoot, parsed.summary.sourceSessionId);
            const summary = applyCodexThreadTitle(parsed.summary, threadTitle);
            const stat = await reader.stat(file);
            seen.set(parsed.summary.sourceSessionId, {
                source: 'codex',
                sourceSessionId: parsed.summary.sourceSessionId,
                path: file,
                title: summary.title,
                cwd: summary.cwd,
                projectName: summary.projectName,
                createdAt: summary.createdAt,
                updatedAt: summary.updatedAt,
                sizeBytes: stat.sizeBytes,
                messageCount: summary.messageCount,
                badLines: parsed.badLines,
            });
        }
        return [...seen.values()];
    }
    requireClaude() {
        if (!this.options.claude) {
            throw new Error('Claude source reader is not configured');
        }
        return this.options.claude;
    }
    async scanClaudeFiles(root) {
        const reader = this.requireClaude();
        const scanRoot = root ?? this.options.claudePath;
        if (!scanRoot) {
            throw new Error('Claude import root is not configured; pass claudePath or scan root');
        }
        const files = await reader.listClaudeFiles(scanRoot);
        const seen = new Map();
        for (const file of files) {
            const parsed = await reader.readClaudeFile(file);
            if (parsed.summary.isSubagent)
                continue;
            if (!parsed.summary.hasRealUserMessage)
                continue;
            const existing = await this.manifest.getBySource('claude-code', parsed.summary.sourceSessionId);
            if (existing)
                continue;
            if (seen.has(parsed.summary.sourceSessionId))
                continue;
            const stat = await reader.stat(file);
            seen.set(parsed.summary.sourceSessionId, {
                source: 'claude-code',
                sourceSessionId: parsed.summary.sourceSessionId,
                path: file,
                title: parsed.summary.title,
                cwd: parsed.summary.cwd,
                projectName: parsed.summary.projectName,
                createdAt: parsed.summary.createdAt,
                updatedAt: parsed.summary.updatedAt,
                sizeBytes: stat.sizeBytes,
                messageCount: parsed.summary.messageCount,
                badLines: parsed.badLines,
            });
        }
        return [...seen.values()];
    }
    isKnownTool(name) {
        const list = this.ctx.tools?.list?.();
        if (!list)
            return false;
        return list.some((tool) => tool.name === name);
    }
    async createImportedSession(conversion) {
        const sessions = this.ctx.sessions;
        if (!sessions ||
            typeof sessions.prepare !== 'function' ||
            typeof sessions.enter !== 'function' ||
            typeof sessions.announce !== 'function' ||
            typeof sessions.flush !== 'function') {
            throw new Error('sessions official seed path is unavailable (prepare/enter/announce/flush)');
        }
        const session = sessions.prepare(conversion.dshSessionId, {
            seed: conversion.events,
            meta: {
                cwd: conversion.header.cwd,
                createdAt: conversion.header.createdAt,
            },
        });
        const detach = sessions.enter(session);
        try {
            sessions.announce(session);
            await sessions.flush(session);
        }
        finally {
            detach();
        }
        return conversion.dshSessionId;
    }
    async sourceOf(id) {
        const record = await this.manifest.getByDsh(id);
        return record?.source ?? 'dsh';
    }
    async titleOf(id) {
        const query = this.ctx.sessionQuery;
        if (typeof query.readTitleSnapshots === 'function') {
            const results = await query.readTitleSnapshots([id]);
            const result = results.find((entry) => entry.sessionId === id || entry.id === id);
            if (result)
                return normalizeTitleObservation(result);
        }
        if (typeof query.readTitleSnapshot === 'function') {
            const result = await query.readTitleSnapshot(id);
            return normalizeTitleObservation(result);
        }
        if (typeof query.readTitle === 'function') {
            const result = await query.readTitle(id);
            return normalizeTitle(result);
        }
        return undefined;
    }
    async eventsOf(id) {
        const query = this.ctx.sessionQuery;
        if (typeof query.listEvents === 'function') {
            const events = await query.listEvents(id);
            if (events.length > 0)
                return events;
        }
        const snapshot = await query.readSession(id);
        return normalizeReadSession(snapshot).events;
    }
    async detailOf(id, _source, _archived, record) {
        const header = recordHeader(record);
        const events = await this.eventsOf(id);
        const createdAt = header?.createdAt ?? 0;
        const updatedAt = this.lastActiveAt(events, createdAt);
        const messageCount = events.filter((event) => event.type === 'user/message' || event.type === 'assistant/message').length;
        const sizeBytes = await this.sizeOf(id, events);
        const live = record.live ?? (await this.isRunning(id));
        const running = record.live ?? live;
        const times = events
            .map((event) => event.time)
            .filter((time) => typeof time === 'number');
        const durationMs = times.length > 0 ? Math.max(0, Math.max(...times) - Math.min(...times)) : 0;
        const toolCalls = events.filter((event) => event.type === 'tool/call').length;
        const toolResults = events.filter((event) => event.type === 'tool/result');
        const toolSuccess = toolResults.filter((event) => this.isToolResultSuccess(event)).length;
        const toolNoResult = Math.max(0, toolCalls - toolSuccess);
        return {
            createdAt,
            updatedAt,
            sizeBytes,
            messageCount,
            durationMs,
            toolCalls,
            toolSuccess,
            toolNoResult,
            running,
            live,
            persisted: record.persisted ?? true,
            blank: record.blank === true || !events.some((event) => event.type === 'turn/start'),
        };
    }
    isToolResultSuccess(event) {
        const data = event.data;
        if (!data)
            return true;
        if (data.isError === true || data.success === false || data.is_error === true)
            return false;
        if (typeof data.success === 'boolean')
            return data.success;
        if (Array.isArray(data.message?.content)) {
            for (const block of data.message.content) {
                if (!block || typeof block !== 'object')
                    continue;
                const candidate = block;
                if (candidate.is_error === true || candidate.success === false)
                    return false;
                if (candidate.is_error === false || candidate.success === true)
                    return true;
            }
        }
        return true;
    }
    async sizeOf(id, events) {
        const raw = await this.ctx.sessionPersistence?.readRaw?.(id);
        if (raw?.content) {
            return Buffer.byteLength(raw.content, 'utf8');
        }
        return events.reduce((sum, event) => sum + JSON.stringify(event).length, 0);
    }
    lastActiveAt(events, fallback = 0) {
        if (events.length === 0)
            return fallback;
        const last = events[events.length - 1]?.time;
        return last ?? fallback;
    }
    async locateDeletionTarget(id) {
        const locate = this.ctx.sessionPersistence?.locate;
        if (typeof locate !== 'function') {
            throw new Error(`sessionPersistence.locate is unavailable; cannot delete session ${id}`);
        }
        const snapshot = await this.ctx.sessionQuery.readSession(id);
        const normalized = normalizeReadSession(snapshot);
        const location = locate({
            id,
            ...(normalized.cwd ? { cwd: normalized.cwd } : {}),
            ...(normalized.createdAt ? { createdAt: normalized.createdAt } : {}),
        });
        if (!location || typeof location.path !== 'string' || location.path.length === 0) {
            throw new Error(`Cannot resolve deletion path for session ${id}`);
        }
        if (isProtectedThirdPartyPath(location.path)) {
            throw new Error(`Refusing to delete third-party source file: ${location.path}`);
        }
        return { sessionId: id, path: location.path };
    }
    assertWorkspaceCleanupAvailable(ids) {
        const registry = this.ctx.workspaceRegistry;
        const state = requireRegistryState(this.ctx.workspaceRegistry);
        const workspaces = typeof registry?.list === 'function' ? registry.list() : [];
        const hasMatchingWorkspace = workspaces.some((workspace) => workspace.sessionIds?.some((id) => ids.includes(id)));
        if (hasMatchingWorkspace && workspaces.some((workspace) => workspace.sessionIds?.some((id) => ids.includes(id)) && typeof workspace.detachSession !== 'function')) {
            throw new Error('workspace entity detachSession is unavailable; cannot clean workspace registration');
        }
        if (!hasMatchingWorkspace && state.workspaceIds.length > 0 && typeof registry?.list !== 'function') {
            throw new Error('workspaceRegistry.list is unavailable; cannot clean workspace registration');
        }
    }
    async removeArchived(ids, registry) {
        await registry.enqueueOperation(async () => {
            const state = requireRegistryState(this.ctx.workspaceRegistry);
            const next = state.archivedSessionIds.filter((id) => !ids.includes(id));
            if (next.length === state.archivedSessionIds.length)
                return;
            await registry.setState({
                ...state,
                archivedSessionIds: next,
            });
        });
    }
    async detachWorkspaces(ids) {
        const registry = this.ctx.workspaceRegistry;
        if (typeof registry?.list !== 'function')
            return;
        for (const workspace of registry.list()) {
            if (!workspace.sessionIds?.some((id) => ids.includes(id)))
                continue;
            if (typeof workspace.detachSession !== 'function') {
                throw new Error('workspace entity detachSession is unavailable; cannot clean workspace registration');
            }
            for (const id of ids) {
                if (workspace.sessionIds.includes(id)) {
                    await workspace.detachSession(id);
                }
            }
        }
    }
    async removeManifest(ids) {
        for (const id of ids) {
            await this.manifest.removeByDsh(id);
        }
    }
    async isRunning(id) {
        const session = await this.ctx.sessions?.get?.(id);
        return Boolean(session);
    }
}
/** Convenience factory used by the plugin entry. */
export function createSessionManagementService(ctx, manifest, options = {}) {
    return new SessionManagementService(ctx, manifest, options);
}
/** Backward-friendly aliases matching the spec's "SessionManagement 服务" naming. */
export const SessionManagement = SessionManagementService;
export const createSessionManagement = createSessionManagementService;
//# sourceMappingURL=service.js.map
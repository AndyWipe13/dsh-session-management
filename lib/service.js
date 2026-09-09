/**
 * SessionManagement host service — the single test seam for session management.
 *
 * Issues #3/#4 implement list/search/preview/archive/unarchive; issue #5 adds
 * Claude Code scan/import plus open/resume. The service is a thin composition
 * over the official services and the plugin's import manifest; it deliberately
 * contains no filesystem access so every test can drive it through fakes.
 */
import { SESSION_SOURCES } from './manifest.js';
import { ImportQueue } from './import-queue.js';
import { SessionProjection } from './session-projection.js';
import { createDshHostAdapter, isSessionRecord, recordId } from './dsh-host.js';
import { mapConcurrent } from './async-pool.js';
/** Keep only well-formed session ids from an untrusted array. */
export function sanitizeSessionIds(values) {
    return Array.isArray(values)
        ? values.filter((value) => typeof value === 'string' && value.length > 0)
        : [];
}
export const DELETE_CONFIRM_TOKEN = 'DELETE';
/** SessionMetric is the canonical list row minus the list-only state fields. */
function toSessionMetric(item) {
    const { live: _live, persisted: _persisted, snippet: _snippet, ...metric } = item;
    return metric;
}
export class SessionManagementService {
    manifest;
    options;
    /** In-memory preview snapshots required before cleanup execution can run. */
    cleanupPreviews = new Map();
    /** Canonical read model shared by list, search, preview, statistics, and cleanup. */
    projection;
    /** The only module that understands DSH rc.7 host shapes and fallbacks. */
    host;
    /** Deep import queue; source-dialect details stay behind its adapter seam. */
    importQueue;
    constructor(ctx, manifest, options = {}) {
        this.manifest = manifest;
        this.options = options;
        this.host = options.host ?? createDshHostAdapter(ctx, options);
        this.projection = new SessionProjection(this.host, manifest, options);
        this.importQueue = new ImportQueue({
            manifest,
            adapters: options.imports ?? [],
            knowTool: (name) => this.host.knowTool(name),
            seed: (conversion, title) => this.host.seedImported(conversion, title),
            sessionExists: (id) => this.host.sessionExists(id),
        });
    }
    async list(filters = {}) {
        return this.projection.list(filters);
    }
    async listPage(filters = {}, page = {}) {
        return this.projection.listPage(filters, page);
    }
    async search(query, filters = {}) {
        return this.projection.search(query, filters);
    }
    async searchPage(query, filters = {}, page = {}) {
        return this.projection.searchPage(query, filters, page);
    }
    async preview(id) {
        return this.projection.preview(id);
    }
    /** Archive one session through the official workspace registry API. */
    async archive(sessionId) {
        await this.host.archive(sessionId);
    }
    /**
     * Unarchive one session through the ADR-0001 internal channel.
     *
     * The channel is shape/version guarded: a missing or damaged internal face
     * fails loudly before any write. Repeated unarchive of an already-active
     * session is a no-op.
     */
    async unarchive(sessionId) {
        await this.host.unarchive(sessionId);
    }
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
    async deleteSessions(sessionIds, options = {}) {
        const ids = [...new Set(sanitizeSessionIds(sessionIds))];
        if (ids.length === 0) {
            throw new Error('No session ids provided for deletion');
        }
        if (options.confirmToken !== DELETE_CONFIRM_TOKEN) {
            throw new Error('Delete requires the exact token DELETE');
        }
        const attached = [];
        for (const id of ids) {
            if (await this.host.attachedSession(id))
                attached.push(id);
        }
        if (attached.length > 0) {
            throw new Error(`Cannot delete attached session(s): ${attached.join(', ')}`);
        }
        // One header scan supplies cwd/createdAt for locate() so planning never
        // has to re-read any session's full event log.
        const headers = new Map();
        for (const raw of await this.host.listSessions()) {
            if (!isSessionRecord(raw))
                continue;
            const id = recordId(raw);
            if (id)
                headers.set(id, raw.header);
        }
        const deletions = [];
        const failures = [];
        for (const id of ids) {
            try {
                deletions.push({ id, plan: await this.host.planDeletion(id, headers.get(id)) });
            }
            catch (error) {
                failures.push({ sessionId: id, reason: error instanceof Error ? error.message : String(error) });
            }
        }
        if (ids.length === 1 && failures.length === 1)
            throw new Error(failures[0].reason);
        if (deletions.length > 0)
            await this.manifest.assertDeleteAvailable();
        const deletedSessionIds = [];
        const paths = [];
        for (const { id, plan } of deletions) {
            try {
                await plan.execute();
                await this.removeManifest([id]);
                deletedSessionIds.push(id);
                paths.push(plan.location.path);
            }
            catch (error) {
                failures.push({ sessionId: id, reason: error instanceof Error ? error.message : String(error) });
            }
        }
        return {
            deletedSessionIds,
            paths,
            ...(failures.length > 0 ? { failures } : {}),
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
        const bySource = new Map(SESSION_SOURCES.map((source) => [source, { count: 0, totalSizeBytes: 0 }]));
        const sessions = result.items.map(toSessionMetric);
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
                    reason: `Running session is never deleted (matched: ${matchedRules.join(', ')})`,
                });
                continue;
            }
            items.push({
                ...toSessionMetric(item),
                running: false,
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
        const ids = [...new Set(sanitizeSessionIds(sessionIds))];
        if (ids.length === 0) {
            return { items: [], success: 0, failed: 0 };
        }
        const previewIds = new Set(preview.sessionIds);
        const notInPreview = ids.filter((id) => !previewIds.has(id));
        if (notInPreview.length > 0) {
            throw new Error(`Cleanup selection includes sessions not in the latest preview: ${notInPreview.join(', ')}`);
        }
        try {
            const result = await this.deleteSessions(ids, { confirmToken: DELETE_CONFIRM_TOKEN });
            const failures = new Map((result.failures ?? []).map((failure) => [failure.sessionId, failure.reason]));
            const pathById = new Map(result.deletedSessionIds.map((id, index) => [id, result.paths[index]]));
            const items = ids.map((id) => {
                const reason = failures.get(id);
                if (reason)
                    return { sessionId: id, status: 'failed', reason };
                const path = pathById.get(id);
                return {
                    sessionId: id,
                    status: 'success',
                    ...(path ? { path } : {}),
                };
            });
            return {
                items,
                success: items.filter((item) => item.status === 'success').length,
                failed: items.filter((item) => item.status === 'failed').length,
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
        if (await this.projection.isRunning(sessionId)) {
            return { sessionId, resumed: false, alreadyRunning: true };
        }
        const cwd = await this.sessionCwd(sessionId);
        if (!cwd) {
            return {
                sessionId,
                resumed: false,
                alreadyRunning: false,
                reason: 'Session has no cwd and cannot be resumed safely',
            };
        }
        await this.host.resume(sessionId, cwd);
        return {
            sessionId,
            resumed: true,
            alreadyRunning: false,
            cwd,
        };
    }
    /** Resolve cwd from the header scan; only fall back to the full session read. */
    async sessionCwd(sessionId) {
        const record = (await this.host.listSessions())
            .find((raw) => isSessionRecord(raw) && recordId(raw) === sessionId);
        return record?.header?.cwd ?? (await this.host.readSession(sessionId)).cwd;
    }
    /**
     * Scan the configured (or caller-supplied) Claude Code projects directory
     * and return only unimported, non-subagent, non-empty main sessions.
     */
    async scan(source, root) {
        return this.importQueue.scan(source, root);
    }
    async scanPage(source, page = {}) {
        return this.importQueue.scanPage(source, page);
    }
    /**
     * Import one or more previously scanned Claude Code sessions through the
     * official session seed path.  Already-imported sessions are skipped; bad
     * lines are counted and do not abort the whole file.
     */
    async import(source, scanId, selections) {
        return this.importQueue.import(source, scanId, selections);
    }
    /** Persisted session records managed by this workspace (subagents filtered out). */
    async managedRecords() {
        return (await this.host.listSessions()).filter(isSessionRecord);
    }
    /** Repair workspace membership for persisted imports created by older versions. */
    async repairImportedWorkspaces() {
        const items = [];
        const sources = new Map();
        const records = await this.managedRecords();
        await this.importQueue.reconcileDshSessions(records.map(recordId).filter(Boolean));
        const imported = (await mapConcurrent(records, 16, async (raw) => {
            const id = recordId(raw);
            if (!id)
                return undefined;
            const record = await this.manifest.getByDsh(id);
            return record ? { raw, id, record } : undefined;
        })).filter((entry) => entry !== undefined);
        const titles = imported.length > 0
            ? await this.projection.titlesOf(imported.map((entry) => entry.id))
            : new Map();
        for (const { raw, id, record } of imported) {
            try {
                await this.host.attachSession(id, raw.header?.cwd ?? (await this.host.readSession(id)).cwd);
                if (!titles.get(id)) {
                    if (record.source !== 'dsh' && this.importQueue.supports(record.source) && !sources.has(record.source)) {
                        sources.set(record.source, this.importQueue.inspect(record.source));
                    }
                    const candidates = record.source === 'dsh' || !sources.has(record.source) ? [] : await sources.get(record.source);
                    const candidate = candidates.find(item => item.sourceSessionId === record.sourceSessionId);
                    if (candidate?.title)
                        await this.host.restoreTitle(id, candidate.title);
                }
                items.push({ sourceSessionId: record.sourceSessionId, dshSessionId: id, status: 'success' });
            }
            catch (error) {
                items.push({ sourceSessionId: record.sourceSessionId, dshSessionId: id, status: 'failed', reason: String(error) });
            }
        }
        return { items, success: items.filter(item => item.status === 'success').length,
            failed: items.filter(item => item.status === 'failed').length, skipped: 0, reconciliationRequired: 0 };
    }
    async reconcileImports() {
        const records = await this.managedRecords();
        await this.importQueue.reconcileDshSessions(records.map(recordId).filter(Boolean));
    }
    async removeManifest(ids) {
        for (const id of ids) {
            await this.manifest.removeByDsh(id);
        }
    }
}
/** Convenience factory used by the plugin entry. */
export function createSessionManagementService(ctx, manifest, options = {}) {
    return new SessionManagementService(ctx, manifest, options);
}
//# sourceMappingURL=service.js.map
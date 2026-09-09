/**
 * Canonical projection of DSH native and imported sessions.
 *
 * All read paths cross this module so identity, activity, title, source,
 * runtime state, archive state, metrics, and caching have one implementation.
 */
import { isSessionRecord, recordId } from './dsh-host.js';
import { DshEventTypes } from './dsh-events.js';
import { mapConcurrent } from './async-pool.js';
function recordHeader(record) {
    return record.header;
}
/** Subagents belong to their parent session and cannot be resumed through the ordinary session route. */
function isManagedSessionRecord(value) {
    return isSessionRecord(value) && recordHeader(value)?.origin !== 'subagent';
}
/**
 * Parse the raw JSONL body returned by `sessionPersistence.readRaw` into the
 * same event face used by the read path. Header rows and malformed lines are
 * skipped so this is safe to use as a stats fast path.
 */
function parseRawEvents(content) {
    const events = [];
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const value = JSON.parse(trimmed);
            if (value && typeof value === 'object' && typeof value.type === 'string') {
                events.push({
                    type: value.type,
                    time: typeof value.time === 'number' ? value.time : undefined,
                    data: value.data,
                });
            }
        }
        catch {
            // Mirror reader-level tolerance: malformed lines do not abort stats.
        }
    }
    return events;
}
/**
 * Cheap change fingerprint for cached session statistics. The official
 * session summaries expose an updatedAt projection; when it is present it is
 * a reliable append-only change signal and lets us skip re-reading events.
 */
function recordActivityAt(record) {
    if (typeof record !== 'object' || record === null)
        return undefined;
    const obj = record;
    const header = (obj.header ?? {});
    const candidates = [
        obj.updatedAt,
        obj.updated_at,
        obj.lastActiveAt,
        header.updatedAt,
        header.updated_at,
        header.lastActiveAt,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'number' && Number.isFinite(candidate))
            return candidate;
    }
    return undefined;
}
function recordFingerprint(record) {
    return recordActivityAt(record);
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
export class SessionProjection {
    host;
    manifest;
    options;
    detailCache = new Map();
    static MAX_DETAIL_CACHE = 1000;
    titleCache = new Map();
    constructor(host, manifest, options) {
        this.host = host;
        this.manifest = manifest;
        this.options = options;
    }
    async filteredCandidates(filters) {
        const records = await this.host.listSessions();
        const archived = this.host.archivedSessionIds();
        let candidates = [];
        for (const raw of records) {
            if (!isManagedSessionRecord(raw))
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
            candidates.push({
                record: raw,
                id,
                cwd,
                createdAt: header?.createdAt ?? 0,
                activityAt: recordActivityAt(raw),
                archived: isArchived,
            });
        }
        if (filters.source && filters.source !== 'all') {
            const expectedSource = filters.source;
            const sourced = await mapConcurrent(candidates, 16, async (candidate) => {
                const metadata = await this.sourceMetadataOf(candidate.id);
                return { ...candidate, source: metadata.source, importedAt: metadata.importedAt };
            });
            candidates = sourced.filter((candidate) => candidate.source === expectedSource);
        }
        return candidates;
    }
    async collectSearchHits(query, candidates, filters) {
        const sessionIds = candidates.map((candidate) => candidate.id);
        const sessionFilters = [{ kind: 'id', values: sessionIds }];
        if (filters.cwd)
            sessionFilters.push({ kind: 'cwd', values: [filters.cwd] });
        const allowed = new Set(sessionIds);
        const hits = new Map();
        let cursor;
        do {
            const page = await this.host.searchSessions({
                query,
                limit: 100,
                ...(cursor !== undefined ? { cursor } : {}),
                sessionFilters,
            });
            for (const raw of page.items ?? []) {
                if (typeof raw !== 'object' || raw === null)
                    continue;
                const hit = raw;
                const id = searchHitId(hit);
                if (id && allowed.has(id) && !hits.has(id))
                    hits.set(id, hit);
            }
            cursor = page.nextCursor;
        } while (cursor !== undefined);
        return hits;
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
        const candidates = await this.filteredCandidates(filters);
        const records = candidates.map((candidate) => candidate.record);
        const hints = await this.persistenceHints(records);
        const titleQuery = filters.query?.trim().toLowerCase();
        let working = candidates;
        if (titleQuery) {
            const titles = await this.titlesOf(candidates.map((candidate) => candidate.id), hints);
            working = candidates.filter((candidate) => (titles.get(candidate.id) ?? '').toLowerCase().includes(titleQuery));
        }
        const items = await this.hydrateListItems(working, hints);
        items.sort((a, b) => b.updatedAt - a.updatedAt);
        return { items, total: items.length };
    }
    /** Cursor page for the settings UI. Metrics remain opt-in for lightweight callers. */
    async listPage(filters = {}, page = {}) {
        let candidates = await this.filteredCandidates(filters);
        let knownTitles;
        const titleQuery = filters.query?.trim().toLowerCase();
        if (titleQuery) {
            knownTitles = await this.titlesOf(candidates.map((candidate) => candidate.id));
            candidates = candidates.filter((candidate) => (knownTitles?.get(candidate.id) ?? '').toLowerCase().includes(titleQuery));
        }
        return this.buildPage(candidates, page, knownTitles);
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
        if (this.options.fullTextSearch !== 'never' && this.host.canSearch()) {
            return this.searchContent(q, filters);
        }
        return this.list({ ...filters, query: q });
    }
    /** Full-text search page for the settings UI. Metrics remain opt-in. */
    async searchPage(query, filters = {}, page = {}) {
        const q = query?.trim() ?? '';
        if (!q)
            return this.listPage(filters, page);
        if (this.options.fullTextSearch === 'never' || !this.host.canSearch()) {
            return this.listPage({ ...filters, query: q }, page);
        }
        const canonical = await this.filteredCandidates(filters);
        if (canonical.length === 0)
            return { items: [], total: 0 };
        const hits = await this.collectSearchHits(q, canonical, filters);
        const candidates = canonical
            .filter((candidate) => hits.has(candidate.id))
            .map((candidate) => ({ ...candidate, snippet: searchHitSnippet(hits.get(candidate.id)) }));
        return this.buildPage(candidates, page);
    }
    async searchContent(query, filters = {}) {
        // Call through the service object: searchSessions may read instance state,
        // so a bare unbound reference would drop `this`.
        if (!this.host.canSearch()) {
            return this.list({ ...filters, query });
        }
        // Apply plugin-owned filters (source, archive state, workspace) to the full
        // logical corpus first, then ask the official full-text engine to search
        // only that filtered session pool. This keeps search + filters composable
        // without dropping matches after a pagination cap.
        const candidates = await this.filteredCandidates(filters);
        if (candidates.length === 0)
            return { items: [], total: 0 };
        const hits = await this.collectSearchHits(query, candidates, filters);
        const matched = candidates
            .filter((candidate) => hits.has(candidate.id))
            .map((candidate) => ({ ...candidate, snippet: searchHitSnippet(hits.get(candidate.id)) }));
        // Hints are fetched once for all matches so each detail hydration gets the
        // persistence revision/size without re-reading session logs.
        const hints = await this.persistenceHints(matched.map((candidate) => candidate.record));
        const items = await this.hydrateListItems(matched, hints);
        items.sort((a, b) => b.updatedAt - a.updatedAt);
        return { items, total: items.length };
    }
    /**
     * The one canonical SessionListItem assembly, shared by the list and search
     * paths: source metadata, batched titles, and event metrics hydrate into a
     * single row shape so the two views cannot drift.
     */
    async hydrateListItems(candidates, hints) {
        const titlesPromise = this.titlesOf(candidates.map((candidate) => candidate.id), hints);
        return mapConcurrent(candidates, 16, async (candidate) => {
            const { record: raw, id, cwd, archived: isArchived } = candidate;
            const imported = candidate.source !== undefined
                ? { source: candidate.source, importedAt: candidate.importedAt }
                : await this.sourceMetadataOf(id);
            const [title, detail] = await Promise.all([
                titlesPromise.then((titles) => titles.get(id)),
                this.detailOf(id, raw, hints.get(id)),
            ]);
            return {
                id,
                title,
                source: imported.source,
                cwd,
                createdAt: detail.createdAt,
                updatedAt: Math.max(detail.updatedAt, imported.importedAt ?? 0),
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
                ...(candidate.snippet ? { snippet: candidate.snippet } : {}),
            };
        });
    }
    /** Read one session's history preview through the official read path. */
    async preview(id) {
        const normalized = await this.host.readSession(id);
        const sourceMetadata = await this.sourceMetadataOf(id);
        const archived = this.host.archivedSessionIds().has(id);
        const title = await this.titleOf(id);
        const running = await this.isRunning(id);
        const metrics = this.computeMetrics(normalized.events);
        // The bulk persistence snapshot carries the artifact size; only fall back
        // to a full read when the hint is missing.
        const sizeBytes = (await this.persistenceHints()).get(id)?.sizeBytes ?? await this.sizeOf(id, normalized.events);
        return {
            id,
            title,
            source: sourceMetadata.source,
            cwd: normalized.cwd,
            createdAt: normalized.createdAt ?? 0,
            updatedAt: Math.max(metrics.maxTime ?? normalized.createdAt ?? 0, sourceMetadata.importedAt ?? 0),
            sizeBytes,
            messageCount: metrics.messageCount,
            durationMs: metrics.minTime === undefined || metrics.maxTime === undefined
                ? 0 : Math.max(0, metrics.maxTime - metrics.minTime),
            toolCalls: metrics.toolCalls,
            toolSuccess: metrics.toolSuccess,
            toolNoResult: Math.max(0, metrics.toolCalls - metrics.toolSuccess),
            running,
            archived,
            events: normalized.events,
        };
    }
    async sourceMetadataOf(id) {
        const record = await this.manifest.getByDsh(id);
        return {
            source: record?.source ?? 'dsh',
            ...(record?.importedAt !== undefined ? { importedAt: record.importedAt } : {}),
        };
    }
    async titleOf(id) {
        return (await this.host.readTitles([id])).get(id);
    }
    /**
     * Batch title reads are essential here: the official implementation scans
     * persistence once per call, so every multi-session path must batch.
     */
    async titlesOf(ids, hints) {
        const titles = new Map();
        if (ids.length === 0)
            return titles;
        const unresolved = [];
        const fingerprints = new Map();
        const states = await mapConcurrent(ids, 16, async (id) => {
            const attached = await this.host.attachedSession(id);
            const seq = typeof attached?.seq === 'number' ? attached.seq : undefined;
            return { id, attached, seq, fingerprint: seq === undefined ? hints?.get(id)?.revision : `live:${seq}` };
        });
        for (const state of states) {
            const { id, attached, seq, fingerprint } = state;
            if (fingerprint !== undefined)
                fingerprints.set(id, fingerprint);
            const cached = this.titleCache.get(id);
            if (cached && cached.fingerprint === fingerprint) {
                titles.set(id, cached.title);
                continue;
            }
            const cachedSeq = typeof cached?.fingerprint === 'string' && cached.fingerprint.startsWith('live:')
                ? Number.parseInt(cached.fingerprint.slice(5), 10)
                : undefined;
            if (cached && cachedSeq !== undefined && seq !== undefined && Number.isSafeInteger(cachedSeq)
                && cachedSeq < seq && typeof attached?.snapshotEvents === 'function') {
                const tail = attached.snapshotEvents(cachedSeq, seq);
                if (tail.length === seq - cachedSeq) {
                    const title = this.titleFromEvents(tail) ?? cached.title;
                    this.rememberTitle(id, fingerprint, title);
                    titles.set(id, title);
                    continue;
                }
            }
            unresolved.push(id);
        }
        if (unresolved.length === 0)
            return titles;
        const resolved = await this.host.readTitles(unresolved);
        for (const id of unresolved) {
            const title = resolved.get(id);
            titles.set(id, title);
            const fingerprint = fingerprints.get(id);
            if (fingerprint !== undefined)
                this.rememberTitle(id, fingerprint, title);
        }
        return titles;
    }
    titleFromEvents(events) {
        for (let index = events.length - 1; index >= 0; index--) {
            const event = events[index];
            if (event?.type !== DshEventTypes.sessionTitle || typeof event.data !== 'object' || event.data === null)
                continue;
            const title = event.data.title;
            if (typeof title === 'string' && title.trim())
                return title.trim();
        }
        return undefined;
    }
    rememberTitle(id, fingerprint, title) {
        if (this.titleCache.size >= SessionProjection.MAX_DETAIL_CACHE && !this.titleCache.has(id)) {
            const oldest = this.titleCache.keys().next().value;
            if (oldest !== undefined)
                this.titleCache.delete(oldest);
        }
        this.titleCache.set(id, { fingerprint, title });
    }
    async buildPage(candidates, page, knownTitles) {
        const limit = Math.max(1, Math.min(100, Math.floor(page.limit ?? 20)));
        const parsedOffset = Number.parseInt(page.cursor ?? '0', 10);
        const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
        const enriched = await mapConcurrent(candidates, 16, async (candidate) => {
            if (candidate.source !== undefined)
                return { ...candidate, source: candidate.source };
            const metadata = await this.sourceMetadataOf(candidate.id);
            return {
                ...candidate,
                source: metadata.source,
                ...(metadata.importedAt !== undefined ? { importedAt: metadata.importedAt } : {}),
            };
        });
        const sortTime = (candidate) => Math.max(candidate.createdAt, candidate.activityAt ?? 0, candidate.importedAt ?? 0);
        const sorted = [...enriched].sort((a, b) => sortTime(b) - sortTime(a)
            || b.createdAt - a.createdAt
            || a.id.localeCompare(b.id));
        const selected = sorted.slice(offset, offset + limit);
        const titles = knownTitles ?? await this.titlesOf(selected.map((candidate) => candidate.id));
        const hints = page.includeMetrics
            ? await this.persistenceHints(selected.map((candidate) => candidate.record))
            : undefined;
        const items = await mapConcurrent(selected, 16, async (candidate) => {
            const source = candidate.source;
            const detail = page.includeMetrics
                ? await this.detailOf(candidate.id, candidate.record, hints?.get(candidate.id))
                : undefined;
            const running = detail?.running ?? await this.host.running(candidate.id, candidate.record.live ?? false);
            return {
                id: candidate.id,
                title: titles.get(candidate.id),
                source,
                cwd: candidate.cwd,
                createdAt: detail?.createdAt ?? candidate.createdAt,
                updatedAt: Math.max(detail?.updatedAt ?? 0, sortTime(candidate)),
                running,
                archived: candidate.archived,
                live: detail?.live ?? candidate.record.live ?? running,
                persisted: detail?.persisted ?? candidate.record.persisted ?? true,
                blank: detail?.blank ?? candidate.record.blank ?? false,
                ...(detail ? {
                    sizeBytes: detail.sizeBytes,
                    messageCount: detail.messageCount,
                    durationMs: detail.durationMs,
                } : {}),
                ...(candidate.snippet ? { snippet: candidate.snippet } : {}),
            };
        });
        const nextOffset = offset + items.length;
        return {
            items,
            total: sorted.length,
            ...(nextOffset < sorted.length ? { nextCursor: String(nextOffset) } : {}),
        };
    }
    async persistenceHints(records = []) {
        return this.host.persistenceHints(records);
    }
    async eventsOf(id) {
        const events = await this.host.listEvents(id);
        if (events && events.length > 0)
            return events;
        return (await this.host.readSession(id)).events;
    }
    /** Single-pass metrics over an event list; avoids multiple full-array scans. */
    computeMetrics(events) {
        let messageCount = 0;
        let toolCalls = 0;
        let toolSuccess = 0;
        let hasTurnStart = false;
        let minTime;
        let maxTime;
        for (const event of events) {
            const type = event.type;
            if (type === DshEventTypes.userMessage || type === DshEventTypes.assistantMessage)
                messageCount++;
            else if (type === DshEventTypes.toolCall)
                toolCalls++;
            else if (type === DshEventTypes.toolResult && this.isToolResultSuccess(event))
                toolSuccess++;
            if (type === DshEventTypes.turnStart)
                hasTurnStart = true;
            const time = event.time;
            if (typeof time === 'number') {
                if (minTime === undefined || time < minTime)
                    minTime = time;
                if (maxTime === undefined || time > maxTime)
                    maxTime = time;
            }
        }
        return {
            minTime,
            maxTime,
            messageCount,
            toolCalls,
            toolSuccess,
            hasTurnStart,
        };
    }
    mergeMetrics(left, right) {
        return {
            minTime: left.minTime === undefined ? right.minTime
                : right.minTime === undefined ? left.minTime : Math.min(left.minTime, right.minTime),
            maxTime: left.maxTime === undefined ? right.maxTime
                : right.maxTime === undefined ? left.maxTime : Math.max(left.maxTime, right.maxTime),
            messageCount: left.messageCount + right.messageCount,
            toolCalls: left.toolCalls + right.toolCalls,
            toolSuccess: left.toolSuccess + right.toolSuccess,
            hasTurnStart: left.hasTurnStart || right.hasTurnStart,
        };
    }
    detailFromMetrics(createdAt, sizeBytes, record, metrics) {
        return {
            createdAt,
            updatedAt: metrics.maxTime ?? createdAt,
            sizeBytes,
            messageCount: metrics.messageCount,
            durationMs: metrics.minTime === undefined || metrics.maxTime === undefined
                ? 0 : Math.max(0, metrics.maxTime - metrics.minTime),
            toolCalls: metrics.toolCalls,
            toolSuccess: metrics.toolSuccess,
            toolNoResult: Math.max(0, metrics.toolCalls - metrics.toolSuccess),
            persisted: record.persisted ?? true,
            blank: record.blank === true || !metrics.hasTurnStart,
        };
    }
    async detailOf(id, record, hint) {
        const header = recordHeader(record);
        const createdAt = header?.createdAt ?? 0;
        const attached = record.live === false ? undefined : await this.host.attachedSession(id);
        const live = record.live === true || Boolean(attached);
        const running = await this.host.running(id, live);
        const liveSeq = typeof attached?.seq === 'number'
            ? attached.seq
            : undefined;
        const fingerprint = live
            ? liveSeq === undefined ? undefined : `live:${liveSeq}`
            : hint?.revision ?? recordFingerprint(record);
        // Cold sessions use the durable persistence revision. Live sessions use
        // Session.seq, the append-only log length exposed by the official Session
        // object. Both change whenever the metrics can change.
        if (fingerprint !== undefined) {
            const cached = this.detailCache.get(id);
            if (cached && cached.fingerprint === fingerprint) {
                return { ...cached.detail, running, live };
            }
            const cachedLiveSeq = typeof cached?.fingerprint === 'string'
                && cached.fingerprint.startsWith('live:')
                ? Number.parseInt(cached.fingerprint.slice(5), 10)
                : undefined;
            if (live && cached && cachedLiveSeq !== undefined && liveSeq !== undefined
                && Number.isSafeInteger(cachedLiveSeq) && cachedLiveSeq < liveSeq
                && typeof attached?.snapshotEvents === 'function') {
                const tail = attached.snapshotEvents(cachedLiveSeq, liveSeq);
                if (tail.length === liveSeq - cachedLiveSeq) {
                    const metrics = this.mergeMetrics(cached.metrics, this.computeMetrics(tail));
                    const detail = this.detailFromMetrics(createdAt, cached.detail.sizeBytes + this.sizeOfEvents(tail), record, metrics);
                    this.detailCache.set(id, { fingerprint, detail, metrics });
                    return { ...detail, running: true, live: true };
                }
            }
        }
        let events;
        // A persistence snapshot can lag an attached session's in-memory tail.
        let sizeBytes = live ? undefined : hint?.sizeBytes;
        let rawContent;
        if (live && typeof attached?.snapshotEvents === 'function') {
            events = liveSeq === undefined ? attached.snapshotEvents() : attached.snapshotEvents(0, liveSeq);
            sizeBytes = this.sizeOfEvents(events);
        }
        if (!live && sizeBytes === undefined) {
            rawContent = await this.host.readRaw(id);
        }
        const listed = events === undefined ? await this.host.listEvents(id) : undefined;
        if (events === undefined && listed !== undefined) {
            // An empty official result is authoritative for a header-only session.
            events = listed;
            if (sizeBytes === undefined) {
                sizeBytes = rawContent
                    ? Buffer.byteLength(rawContent, 'utf8')
                    : this.sizeOfEvents(listed);
            }
        }
        if (events === undefined) {
            if (rawContent) {
                // readRaw fast path: one full JSONL read supplies both metrics and size.
                events = parseRawEvents(rawContent);
                sizeBytes = Buffer.byteLength(rawContent, 'utf8');
            }
            else {
                events = await this.eventsOf(id);
                sizeBytes = await this.sizeOf(id, events);
            }
        }
        if (sizeBytes === undefined) {
            sizeBytes = await this.sizeOf(id, events);
        }
        const metrics = this.computeMetrics(events);
        const detail = this.detailFromMetrics(createdAt, sizeBytes, record, metrics);
        if (fingerprint !== undefined) {
            if (this.detailCache.size >= SessionProjection.MAX_DETAIL_CACHE && !this.detailCache.has(id)) {
                const oldest = this.detailCache.keys().next().value;
                if (oldest !== undefined)
                    this.detailCache.delete(oldest);
            }
            this.detailCache.set(id, { fingerprint, detail, metrics });
        }
        return { ...detail, running, live };
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
        const raw = await this.host.readRaw(id);
        if (raw) {
            return Buffer.byteLength(raw, 'utf8');
        }
        return this.sizeOfEvents(events);
    }
    sizeOfEvents(events) {
        return events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event), 'utf8'), 0);
    }
    async isRunning(id) {
        return this.host.running(id, Boolean(await this.host.attachedSession(id)));
    }
}
//# sourceMappingURL=session-projection.js.map
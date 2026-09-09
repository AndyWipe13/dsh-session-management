/**
 * Canonical projection of DSH native and imported sessions.
 *
 * All read paths cross this module so identity, activity, title, source,
 * runtime state, archive state, metrics, and caching have one implementation.
 */

import type { ManifestStore, SessionSource } from './manifest.js'
import type { DshHostAdapter, HostPersistenceHint } from './dsh-host.js'
import { isSessionRecord, recordId } from './dsh-host.js'
import { DshEventTypes } from './dsh-events.js'
import { mapConcurrent } from './async-pool.js'
import type {
  SessionListFilter,
  SessionListItem,
  SessionListResult,
  SessionManagementOptions,
  SessionPageItem,
  SessionPageOptions,
  SessionPageResult,
  SessionPreview,
} from './service.js'

/** Session statistics cached while a durable revision or live sequence is stable. */
interface SessionDetailBase {
  createdAt: number
  updatedAt: number
  sizeBytes: number
  messageCount: number
  durationMs: number
  toolCalls: number
  toolSuccess: number
  toolNoResult: number
  persisted: boolean
  blank: boolean
}

interface SessionMetricState {
  minTime?: number
  maxTime?: number
  messageCount: number
  toolCalls: number
  toolSuccess: number
  hasTurnStart: boolean
}

function recordHeader(record: { header?: unknown }): {
  id?: string
  createdAt?: number
  cwd?: string
  parentSession?: string
  origin?: string
} | undefined {
  return record.header as {
    id?: string
    createdAt?: number
    cwd?: string
    parentSession?: string
    origin?: string
  } | undefined
}

/** Subagents belong to their parent session and cannot be resumed through the ordinary session route. */
function isManagedSessionRecord(value: unknown): value is {
  header?: { id?: string }
  id?: string
  live?: boolean
  persisted?: boolean
  blank?: boolean
} {
  return isSessionRecord(value) && recordHeader(value)?.origin !== 'subagent'
}

/**
 * Parse the raw JSONL body returned by `sessionPersistence.readRaw` into the
 * same event face used by the read path. Header rows and malformed lines are
 * skipped so this is safe to use as a stats fast path.
 */
function parseRawEvents(content: string): { type?: string; time?: number; data?: unknown }[] {
  const events: { type?: string; time?: number; data?: unknown }[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const value = JSON.parse(trimmed)
      if (value && typeof value === 'object' && typeof value.type === 'string') {
        events.push({
          type: value.type,
          time: typeof value.time === 'number' ? value.time : undefined,
          data: value.data,
        })
      }
    } catch {
      // Mirror reader-level tolerance: malformed lines do not abort stats.
    }
  }
  return events
}

/**
 * Cheap change fingerprint for cached session statistics. The official
 * session summaries expose an updatedAt projection; when it is present it is
 * a reliable append-only change signal and lets us skip re-reading events.
 */
function recordActivityAt(record: unknown): number | undefined {
  if (typeof record !== 'object' || record === null) return undefined
  const obj = record as Record<string, unknown>
  const header = (obj.header ?? {}) as Record<string, unknown>
  const candidates = [
    obj.updatedAt,
    obj.updated_at,
    obj.lastActiveAt,
    header.updatedAt,
    header.updated_at,
    header.lastActiveAt,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
  }
  return undefined
}

function recordFingerprint(record: unknown): number | undefined {
  return recordActivityAt(record)
}

/** One cross-session full-text hit as returned by `sessionQuery.searchSessions`. */
interface SessionSearchHitLike {
  header?: { id?: string; createdAt?: number; cwd?: string }
  id?: string
  live?: boolean
  persisted?: boolean
  blank?: boolean
  bestMatch?: { snippet?: string }
}

interface SessionPageCandidate {
  record: { header?: unknown; live?: boolean; persisted?: boolean; blank?: boolean }
  id: string
  cwd?: string
  createdAt: number
  activityAt?: number
  importedAt?: number
  archived: boolean
  source?: SessionSource
  snippet?: string
}

type SessionDetailHint = HostPersistenceHint

function searchHitId(hit: SessionSearchHitLike): string {
  return hit.header?.id ?? hit.id ?? ''
}

function searchHitSnippet(hit: SessionSearchHitLike): string | undefined {
  return hit.bestMatch?.snippet
}

function workspaceMatches(cwd: string | undefined, workspace: string | undefined): boolean {
  if (!workspace) return true
  if (!cwd) return false
  const normalized = cwd.replace(/\\/g, '/')
  const base = normalized.split('/').filter(Boolean).pop() ?? ''
  return normalized === workspace || base === workspace || normalized.includes(workspace)
}

export class SessionProjection {
  private readonly detailCache = new Map<string, {
    fingerprint: unknown
    detail: SessionDetailBase
    metrics: SessionMetricState
  }>()
  private static readonly MAX_DETAIL_CACHE = 1000
  private readonly titleCache = new Map<string, { fingerprint: unknown; title?: string }>()

  constructor(
    private readonly host: DshHostAdapter,
    private readonly manifest: ManifestStore,
    private readonly options: Pick<SessionManagementOptions, 'fullTextSearch'>,
  ) {}

  private async filteredCandidates(filters: SessionListFilter): Promise<SessionPageCandidate[]> {
    const records = await this.host.listSessions()
    const archived = this.host.archivedSessionIds()
    let candidates: SessionPageCandidate[] = []
    for (const raw of records) {
      if (!isManagedSessionRecord(raw)) continue
      const id = recordId(raw)
      if (!id) continue
      const header = recordHeader(raw)
      const cwd = header?.cwd
      if (filters.cwd && cwd !== filters.cwd) continue
      if (filters.workspace && !workspaceMatches(cwd, filters.workspace)) continue
      const isArchived = archived.has(id)
      if (filters.archived != null && filters.archived !== 'all' && isArchived !== filters.archived) continue
      candidates.push({
        record: raw,
        id,
        cwd,
        createdAt: header?.createdAt ?? 0,
        activityAt: recordActivityAt(raw),
        archived: isArchived,
      })
    }
    if (filters.source && filters.source !== 'all') {
      const expectedSource = filters.source
      const sourced = await mapConcurrent(candidates, 16, async (candidate) => {
        const metadata = await this.sourceMetadataOf(candidate.id)
        return { ...candidate, source: metadata.source, importedAt: metadata.importedAt }
      })
      candidates = sourced.filter((candidate) => candidate.source === expectedSource)
    }
    return candidates
  }

  private async collectSearchHits(
    query: string,
    candidates: readonly SessionPageCandidate[],
    filters: SessionListFilter,
  ): Promise<Map<string, SessionSearchHitLike>> {
    const sessionIds = candidates.map((candidate) => candidate.id)
    const sessionFilters: unknown[] = [{ kind: 'id', values: sessionIds }]
    if (filters.cwd) sessionFilters.push({ kind: 'cwd', values: [filters.cwd] })
    const allowed = new Set(sessionIds)
    const hits = new Map<string, SessionSearchHitLike>()
    let cursor: unknown
    do {
      const page = await this.host.searchSessions({
        query,
        limit: 100,
        ...(cursor !== undefined ? { cursor } : {}),
        sessionFilters,
      })
      for (const raw of page.items ?? []) {
        if (typeof raw !== 'object' || raw === null) continue
        const hit = raw as SessionSearchHitLike
        const id = searchHitId(hit)
        if (id && allowed.has(id) && !hits.has(id)) hits.set(id, hit)
      }
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return hits
  }

  /**
   * Unified DSH native + imported session list, newest-active first.
   *
   * The official `sessionQuery.filterSessions` cannot express source (manifest),
   * archive-state (workspaceRegistry), or title search, so those predicates are
   * composed here on top of the official `listSessions` read path.  All data
   * still comes from official services; no filesystem is touched.
   */
  async list(filters: SessionListFilter = {}): Promise<SessionListResult> {
    const candidates = await this.filteredCandidates(filters)
    const records = candidates.map((candidate) => candidate.record)
    const hints = await this.persistenceHints(records)
    const titleQuery = filters.query?.trim().toLowerCase()
    let working = candidates
    if (titleQuery) {
      const titles = await this.titlesOf(candidates.map((candidate) => candidate.id), hints)
      working = candidates.filter((candidate) => (titles.get(candidate.id) ?? '').toLowerCase().includes(titleQuery))
    }
    const items = await this.hydrateListItems(working, hints)
    items.sort((a, b) => b.updatedAt - a.updatedAt)
    return { items, total: items.length }
  }

  /** Cursor page for the settings UI. Metrics remain opt-in for lightweight callers. */
  async listPage(filters: SessionListFilter = {}, page: SessionPageOptions = {}): Promise<SessionPageResult> {
    let candidates = await this.filteredCandidates(filters)

    let knownTitles: Map<string, string | undefined> | undefined
    const titleQuery = filters.query?.trim().toLowerCase()
    if (titleQuery) {
      knownTitles = await this.titlesOf(candidates.map((candidate) => candidate.id))
      candidates = candidates.filter((candidate) => (knownTitles?.get(candidate.id) ?? '').toLowerCase().includes(titleQuery))
    }

    return this.buildPage(candidates, page, knownTitles)
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
  async search(query: string, filters: SessionListFilter = {}): Promise<SessionListResult> {
    const q = query?.trim() ?? ''
    if (!q) return this.list(filters)
    if (this.options.fullTextSearch !== 'never' && this.host.canSearch()) {
      return this.searchContent(q, filters)
    }
    return this.list({ ...filters, query: q })
  }

  /** Full-text search page for the settings UI. Metrics remain opt-in. */
  async searchPage(query: string, filters: SessionListFilter = {}, page: SessionPageOptions = {}): Promise<SessionPageResult> {
    const q = query?.trim() ?? ''
    if (!q) return this.listPage(filters, page)
    if (this.options.fullTextSearch === 'never' || !this.host.canSearch()) {
      return this.listPage({ ...filters, query: q }, page)
    }

    const canonical = await this.filteredCandidates(filters)
    if (canonical.length === 0) return { items: [], total: 0 }
    const hits = await this.collectSearchHits(q, canonical, filters)
    const candidates = canonical
      .filter((candidate) => hits.has(candidate.id))
      .map((candidate) => ({ ...candidate, snippet: searchHitSnippet(hits.get(candidate.id)!) }))
    return this.buildPage(candidates, page)
  }

  private async searchContent(query: string, filters: SessionListFilter = {}): Promise<SessionListResult> {
    // Call through the service object: searchSessions may read instance state,
    // so a bare unbound reference would drop `this`.
    if (!this.host.canSearch()) {
      return this.list({ ...filters, query })
    }

    // Apply plugin-owned filters (source, archive state, workspace) to the full
    // logical corpus first, then ask the official full-text engine to search
    // only that filtered session pool. This keeps search + filters composable
    // without dropping matches after a pagination cap.
    const candidates = await this.filteredCandidates(filters)
    if (candidates.length === 0) return { items: [], total: 0 }
    const hits = await this.collectSearchHits(query, candidates, filters)
    const matched = candidates
      .filter((candidate) => hits.has(candidate.id))
      .map((candidate) => ({ ...candidate, snippet: searchHitSnippet(hits.get(candidate.id)!) }))
    // Hints are fetched once for all matches so each detail hydration gets the
    // persistence revision/size without re-reading session logs.
    const hints = await this.persistenceHints(matched.map((candidate) => candidate.record))
    const items = await this.hydrateListItems(matched, hints)
    items.sort((a, b) => b.updatedAt - a.updatedAt)
    return { items, total: items.length }
  }

  /**
   * The one canonical SessionListItem assembly, shared by the list and search
   * paths: source metadata, batched titles, and event metrics hydrate into a
   * single row shape so the two views cannot drift.
   */
  private async hydrateListItems(
    candidates: readonly SessionPageCandidate[],
    hints: ReadonlyMap<string, SessionDetailHint>,
  ): Promise<SessionListItem[]> {
    const titlesPromise = this.titlesOf(candidates.map((candidate) => candidate.id), hints)
    return mapConcurrent(candidates, 16, async (candidate): Promise<SessionListItem> => {
      const { record: raw, id, cwd, archived: isArchived } = candidate
      const imported = candidate.source !== undefined
        ? { source: candidate.source, importedAt: candidate.importedAt }
        : await this.sourceMetadataOf(id)
      const [title, detail] = await Promise.all([
        titlesPromise.then((titles) => titles.get(id)),
        this.detailOf(id, raw, hints.get(id)),
      ])
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
      }
    })
  }

  /** Read one session's history preview through the official read path. */
  async preview(id: string): Promise<SessionPreview> {
    const normalized = await this.host.readSession(id)
    const sourceMetadata = await this.sourceMetadataOf(id)
    const archived = this.host.archivedSessionIds().has(id)
    const title = await this.titleOf(id)
    const running = await this.isRunning(id)
    const metrics = this.computeMetrics(normalized.events)
    // The bulk persistence snapshot carries the artifact size; only fall back
    // to a full read when the hint is missing.
    const sizeBytes = (await this.persistenceHints()).get(id)?.sizeBytes ?? await this.sizeOf(id, normalized.events)

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
    }
  }

  private async sourceMetadataOf(id: string): Promise<{ source: SessionSource; importedAt?: number }> {
    const record = await this.manifest.getByDsh(id)
    return {
      source: record?.source ?? 'dsh',
      ...(record?.importedAt !== undefined ? { importedAt: record.importedAt } : {}),
    }
  }

  async titleOf(id: string): Promise<string | undefined> {
    return (await this.host.readTitles([id])).get(id)
  }

  /**
   * Batch title reads are essential here: the official implementation scans
   * persistence once per call, so every multi-session path must batch.
   */
  async titlesOf(
    ids: readonly string[],
    hints?: ReadonlyMap<string, SessionDetailHint>,
  ): Promise<Map<string, string | undefined>> {
    const titles = new Map<string, string | undefined>()
    if (ids.length === 0) return titles
    const unresolved: string[] = []
    const fingerprints = new Map<string, unknown>()
    const states = await mapConcurrent(ids, 16, async (id) => {
      const attached = await this.host.attachedSession(id)
      const seq = typeof attached?.seq === 'number' ? attached.seq : undefined
      return { id, attached, seq, fingerprint: seq === undefined ? hints?.get(id)?.revision : `live:${seq}` }
    })

    for (const state of states) {
      const { id, attached, seq, fingerprint } = state
      if (fingerprint !== undefined) fingerprints.set(id, fingerprint)
      const cached = this.titleCache.get(id)
      if (cached && cached.fingerprint === fingerprint) {
        titles.set(id, cached.title)
        continue
      }
      const cachedSeq = typeof cached?.fingerprint === 'string' && cached.fingerprint.startsWith('live:')
        ? Number.parseInt(cached.fingerprint.slice(5), 10)
        : undefined
      if (cached && cachedSeq !== undefined && seq !== undefined && Number.isSafeInteger(cachedSeq)
        && cachedSeq < seq && typeof attached?.snapshotEvents === 'function') {
        const tail = attached.snapshotEvents(cachedSeq, seq)
        if (tail.length === seq - cachedSeq) {
          const title = this.titleFromEvents(tail) ?? cached.title
          this.rememberTitle(id, fingerprint, title)
          titles.set(id, title)
          continue
        }
      }
      unresolved.push(id)
    }

    if (unresolved.length === 0) return titles
    const resolved = await this.host.readTitles(unresolved)
    for (const id of unresolved) {
      const title = resolved.get(id)
      titles.set(id, title)
      const fingerprint = fingerprints.get(id)
      if (fingerprint !== undefined) this.rememberTitle(id, fingerprint, title)
    }
    return titles
  }

  private titleFromEvents(events: readonly { type?: string; data?: unknown }[]): string | undefined {
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]
      if (event?.type !== DshEventTypes.sessionTitle || typeof event.data !== 'object' || event.data === null) continue
      const title = (event.data as { title?: unknown }).title
      if (typeof title === 'string' && title.trim()) return title.trim()
    }
    return undefined
  }

  private rememberTitle(id: string, fingerprint: unknown, title: string | undefined): void {
    if (this.titleCache.size >= SessionProjection.MAX_DETAIL_CACHE && !this.titleCache.has(id)) {
      const oldest = this.titleCache.keys().next().value
      if (oldest !== undefined) this.titleCache.delete(oldest)
    }
    this.titleCache.set(id, { fingerprint, title })
  }

  private async buildPage(
    candidates: readonly SessionPageCandidate[],
    page: SessionPageOptions,
    knownTitles?: Map<string, string | undefined>,
  ): Promise<SessionPageResult> {
    const limit = Math.max(1, Math.min(100, Math.floor(page.limit ?? 20)))
    const parsedOffset = Number.parseInt(page.cursor ?? '0', 10)
    const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0
    const enriched = await mapConcurrent(candidates, 16, async (candidate) => {
      if (candidate.source !== undefined) return { ...candidate, source: candidate.source }
      const metadata = await this.sourceMetadataOf(candidate.id)
      return {
        ...candidate,
        source: metadata.source,
        ...(metadata.importedAt !== undefined ? { importedAt: metadata.importedAt } : {}),
      }
    })
    const sortTime = (candidate: SessionPageCandidate) => Math.max(
      candidate.createdAt,
      candidate.activityAt ?? 0,
      candidate.importedAt ?? 0,
    )
    const sorted = [...enriched].sort((a, b) =>
      sortTime(b) - sortTime(a)
      || b.createdAt - a.createdAt
      || a.id.localeCompare(b.id))
    const selected = sorted.slice(offset, offset + limit)
    const titles = knownTitles ?? await this.titlesOf(selected.map((candidate) => candidate.id))
    const hints = page.includeMetrics
      ? await this.persistenceHints(selected.map((candidate) => candidate.record))
      : undefined
    const items = await mapConcurrent(selected, 16, async (candidate): Promise<SessionPageItem> => {
      const source = candidate.source
      const detail = page.includeMetrics
        ? await this.detailOf(candidate.id, candidate.record, hints?.get(candidate.id))
        : undefined
      const running = detail?.running ?? await this.host.running(candidate.id, candidate.record.live ?? false)
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
      }
    })
    const nextOffset = offset + items.length
    return {
      items,
      total: sorted.length,
      ...(nextOffset < sorted.length ? { nextCursor: String(nextOffset) } : {}),
    }
  }

  private async persistenceHints(records: readonly unknown[] = []): Promise<Map<string, SessionDetailHint>> {
    return this.host.persistenceHints(records)
  }

  private async eventsOf(id: string): Promise<readonly { type?: string; time?: number }[]> {
    const events = await this.host.listEvents(id)
    if (events && events.length > 0) return events
    return (await this.host.readSession(id)).events
  }

  /** Single-pass metrics over an event list; avoids multiple full-array scans. */
  private computeMetrics(events: readonly { type?: string; time?: number; data?: unknown }[]): SessionMetricState {
    let messageCount = 0
    let toolCalls = 0
    let toolSuccess = 0
    let hasTurnStart = false
    let minTime: number | undefined
    let maxTime: number | undefined
    for (const event of events) {
      const type = event.type
      if (type === DshEventTypes.userMessage || type === DshEventTypes.assistantMessage) messageCount++
      else if (type === DshEventTypes.toolCall) toolCalls++
      else if (type === DshEventTypes.toolResult && this.isToolResultSuccess(event)) toolSuccess++
      if (type === DshEventTypes.turnStart) hasTurnStart = true
      const time = event.time
      if (typeof time === 'number') {
        if (minTime === undefined || time < minTime) minTime = time
        if (maxTime === undefined || time > maxTime) maxTime = time
      }
    }
    return {
      minTime,
      maxTime,
      messageCount,
      toolCalls,
      toolSuccess,
      hasTurnStart,
    }
  }

  private mergeMetrics(left: SessionMetricState, right: SessionMetricState): SessionMetricState {
    return {
      minTime: left.minTime === undefined ? right.minTime
        : right.minTime === undefined ? left.minTime : Math.min(left.minTime, right.minTime),
      maxTime: left.maxTime === undefined ? right.maxTime
        : right.maxTime === undefined ? left.maxTime : Math.max(left.maxTime, right.maxTime),
      messageCount: left.messageCount + right.messageCount,
      toolCalls: left.toolCalls + right.toolCalls,
      toolSuccess: left.toolSuccess + right.toolSuccess,
      hasTurnStart: left.hasTurnStart || right.hasTurnStart,
    }
  }

  private detailFromMetrics(
    createdAt: number,
    sizeBytes: number,
    record: { persisted?: boolean; blank?: boolean },
    metrics: SessionMetricState,
  ): SessionDetailBase {
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
    }
  }

  private async detailOf(
    id: string,
    record: { header?: unknown; live?: boolean; persisted?: boolean; blank?: boolean },
    hint?: SessionDetailHint,
  ): Promise<SessionDetailBase & { running: boolean; live: boolean }> {
    const header = recordHeader(record)
    const createdAt = header?.createdAt ?? 0
    const attached = record.live === false ? undefined : await this.host.attachedSession(id)
    const live = record.live === true || Boolean(attached)
    const running = await this.host.running(id, live)
    const liveSeq = typeof attached?.seq === 'number'
      ? attached.seq
      : undefined
    const fingerprint = live
      ? liveSeq === undefined ? undefined : `live:${liveSeq}`
      : hint?.revision ?? recordFingerprint(record)

    // Cold sessions use the durable persistence revision. Live sessions use
    // Session.seq, the append-only log length exposed by the official Session
    // object. Both change whenever the metrics can change.
    if (fingerprint !== undefined) {
      const cached = this.detailCache.get(id)
      if (cached && cached.fingerprint === fingerprint) {
        return { ...cached.detail, running, live }
      }
      const cachedLiveSeq = typeof cached?.fingerprint === 'string'
        && cached.fingerprint.startsWith('live:')
        ? Number.parseInt(cached.fingerprint.slice(5), 10)
        : undefined
      if (live && cached && cachedLiveSeq !== undefined && liveSeq !== undefined
        && Number.isSafeInteger(cachedLiveSeq) && cachedLiveSeq < liveSeq
        && typeof attached?.snapshotEvents === 'function') {
        const tail = attached.snapshotEvents(cachedLiveSeq, liveSeq)
        if (tail.length === liveSeq - cachedLiveSeq) {
          const metrics = this.mergeMetrics(cached.metrics, this.computeMetrics(tail))
          const detail = this.detailFromMetrics(
            createdAt,
            cached.detail.sizeBytes + this.sizeOfEvents(tail),
            record,
            metrics,
          )
          this.detailCache.set(id, { fingerprint, detail, metrics })
          return { ...detail, running: true, live: true }
        }
      }
    }

    let events: readonly { type?: string; time?: number; data?: unknown }[] | undefined
    // A persistence snapshot can lag an attached session's in-memory tail.
    let sizeBytes = live ? undefined : hint?.sizeBytes
    let rawContent: string | undefined
    if (live && typeof attached?.snapshotEvents === 'function') {
      events = liveSeq === undefined ? attached.snapshotEvents() : attached.snapshotEvents(0, liveSeq)
      sizeBytes = this.sizeOfEvents(events)
    }
    if (!live && sizeBytes === undefined) {
      rawContent = await this.host.readRaw(id)
    }
    const listed = events === undefined ? await this.host.listEvents(id) : undefined
    if (events === undefined && listed !== undefined) {
      // An empty official result is authoritative for a header-only session.
      events = listed
      if (sizeBytes === undefined) {
        sizeBytes = rawContent
          ? Buffer.byteLength(rawContent, 'utf8')
          : this.sizeOfEvents(listed)
      }
    }
    if (events === undefined) {
      if (rawContent) {
        // readRaw fast path: one full JSONL read supplies both metrics and size.
        events = parseRawEvents(rawContent)
        sizeBytes = Buffer.byteLength(rawContent, 'utf8')
      } else {
        events = await this.eventsOf(id)
        sizeBytes = await this.sizeOf(id, events)
      }
    }
    if (sizeBytes === undefined) {
      sizeBytes = await this.sizeOf(id, events)
    }

    const metrics = this.computeMetrics(events)
    const detail = this.detailFromMetrics(createdAt, sizeBytes, record, metrics)

    if (fingerprint !== undefined) {
      if (this.detailCache.size >= SessionProjection.MAX_DETAIL_CACHE && !this.detailCache.has(id)) {
        const oldest = this.detailCache.keys().next().value
        if (oldest !== undefined) this.detailCache.delete(oldest)
      }
      this.detailCache.set(id, { fingerprint, detail, metrics })
    }

    return { ...detail, running, live }
  }

  private isToolResultSuccess(event: { type?: string; data?: unknown }): boolean {
    const data = event.data as
      | { isError?: unknown; success?: unknown; is_error?: unknown; message?: { content?: readonly unknown[] } }
      | undefined
    if (!data) return true
    if (data.isError === true || data.success === false || data.is_error === true) return false
    if (typeof data.success === 'boolean') return data.success
    if (Array.isArray(data.message?.content)) {
      for (const block of data.message.content) {
        if (!block || typeof block !== 'object') continue
        const candidate = block as { is_error?: unknown; success?: unknown }
        if (candidate.is_error === true || candidate.success === false) return false
        if (candidate.is_error === false || candidate.success === true) return true
      }
    }
    return true
  }

  private async sizeOf(id: string, events: readonly unknown[]): Promise<number> {
    const raw = await this.host.readRaw(id)
    if (raw) {
      return Buffer.byteLength(raw, 'utf8')
    }
    return this.sizeOfEvents(events)
  }

  private sizeOfEvents(events: readonly unknown[]): number {
    return events.reduce<number>((sum, event) => sum + Buffer.byteLength(JSON.stringify(event), 'utf8'), 0)
  }


  async isRunning(id: string): Promise<boolean> {
    return this.host.running(id, Boolean(await this.host.attachedSession(id)))
  }

}

/**
 * SessionManagement host service — the single test seam for session management.
 *
 * Issues #3/#4 implement list/search/preview/archive/unarchive; issue #5 adds
 * Claude Code scan/import plus open/resume. The service is a thin composition
 * over the official services and the plugin's import manifest; it deliberately
 * contains no filesystem access so every test can drive it through fakes.
 */

import type { ManifestStore, SessionSource } from './manifest.js'
import type {
  ClaudeConversionResult,
  ClaudeSourceReader,
} from './claude.js'
import { convertClaudeRecords } from './claude.js'
import type {
  CodexConversionResult,
  CodexSourceReader,
} from './codex.js'
import { applyCodexThreadTitle, convertCodexRecords } from './codex.js'

export interface SessionManagementOptions {
  /** Configured Claude Code projects root; empty/undefined means caller supplies a path. */
  claudePath?: string
  /** Configured Codex home; empty/undefined means caller supplies a path. */
  codexPath?: string
  /**
   * Full-text search mode. `first-search` (default) enables content search via
   * the official searchSessions API; `never` falls back to title-only search.
   */
  fullTextSearch?: 'first-search' | 'never'
  /** Filesystem-facing Claude reader. Defaults are supplied by the plugin entry. */
  claude?: ClaudeSourceReader
  /** Filesystem-facing Codex reader. Defaults are supplied by the plugin entry. */
  codex?: CodexSourceReader
  /** Filesystem-facing artifact deleter. Defaults are supplied by the plugin entry. */
  deleter?: SessionArtifactDeleter
  /** Defaults for the cleanup rule form. */
  cleanup?: Partial<CleanupRule>
}

export interface SessionListFilter {
  source?: SessionSource | 'all'
  archived?: boolean | 'all'
  cwd?: string
  workspace?: string
  query?: string
}

export interface SessionListItem {
  id: string
  title?: string
  source: SessionSource
  cwd?: string
  createdAt: number
  updatedAt: number
  sizeBytes: number
  messageCount: number
  durationMs: number
  toolCalls: number
  toolSuccess: number
  toolNoResult: number
  running: boolean
  archived: boolean
  live: boolean
  persisted: boolean
  blank: boolean
  /** Plain-text excerpt from the strongest matching event, when available. */
  snippet?: string
}

export interface SessionListResult {
  items: SessionListItem[]
  total: number
}

export interface SessionMetric {
  id: string
  title?: string
  source: SessionSource
  cwd?: string
  createdAt: number
  updatedAt: number
  sizeBytes: number
  messageCount: number
  durationMs: number
  toolCalls: number
  toolSuccess: number
  toolNoResult: number
  running: boolean
  archived: boolean
  blank: boolean
}

export interface SessionSourceStats {
  source: SessionSource
  count: number
  totalSizeBytes: number
}

export interface SessionStatsResult {
  totalSessions: number
  totalSizeBytes: number
  bySource: SessionSourceStats[]
  sessions: SessionMetric[]
}

export interface CleanupRule {
  olderThanDays: number
  largerThanMb: number
  emptySessions: boolean
  archivedOnly: boolean
  source: SessionSource | 'all'
}

export interface CleanupPreviewItem extends SessionMetric {
  matchedRules: readonly string[]
}

export interface CleanupExcludedItem {
  sessionId: string
  title?: string
  reason: string
}

export interface CleanupPreviewResult {
  previewId: string
  rules: CleanupRule
  items: CleanupPreviewItem[]
  excluded: CleanupExcludedItem[]
  total: number
  totalSizeBytes: number
}

export interface CleanupExecuteOptions {
  /** Batch (and tool) cleanup requires the exact token `DELETE`. */
  confirmToken?: string
  /** Id returned by cleanupPreview; required so cleanup can never run un-previewed. */
  previewId?: string
}

export interface CleanupReportItem {
  sessionId: string
  status: 'success' | 'failed'
  path?: string
  reason?: string
}

export interface CleanupReport {
  items: CleanupReportItem[]
  success: number
  failed: number
}

export interface SessionPreview {
  id: string
  title?: string
  source: SessionSource
  cwd?: string
  createdAt: number
  updatedAt: number
  running: boolean
  archived: boolean
  events: readonly unknown[]
}

export interface ImportCandidateItem {
  source: SessionSource
  sourceSessionId: string
  path: string
  title?: string
  cwd?: string
  projectName?: string
  createdAt: number
  updatedAt: number
  sizeBytes: number
  messageCount: number
  badLines: number
}

export interface ImportScanResult {
  items: ImportCandidateItem[]
  total: number
  badLines: number
}

export interface ImportSelection {
  sourceSessionId: string
  path?: string
}

export interface ImportReportItem {
  sourceSessionId: string
  path?: string
  status: 'success' | 'skipped' | 'failed'
  dshSessionId?: string
  reason?: string
  badLines?: number
}

export interface ImportReport {
  items: ImportReportItem[]
  success: number
  skipped: number
  failed: number
}

export interface SessionOpenResult {
  sessionId: string
  resumed: boolean
  alreadyRunning: boolean
  cwd?: string
  reason?: string
}

export interface SessionDeleteOptions {
  /** Batch deletes (and all tool-driven deletes) require the exact token `DELETE`. */
  confirmToken?: string
}

export interface SessionDeleteResult {
  deletedSessionIds: readonly string[]
  paths: readonly string[]
}

/** Session statistics that are stable while a session's updatedAt is stable. */
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

export interface SessionArtifactLocation {
  sessionId: string
  path: string
}

export type SessionArtifactDeleter = (location: SessionArtifactLocation) => Promise<void> | void

/** One workspace entity as seen by the deletion cleanup path. */
export interface SessionWorkspaceLike {
  sessionIds?: readonly string[]
  detachSession?(sessionId: string): Promise<void> | void
}

/** Minimal structural face of the official services the read path needs. */
export interface SessionServiceContext {
  sessionQuery: {
    listSessions(): Promise<readonly unknown[]>
    readSession(id: string): Promise<{ session?: unknown; header?: unknown; events?: readonly unknown[] }>
    listEvents?(id: string): Promise<readonly { type?: string; time?: number }[]>
    readTitle?(id: string): Promise<unknown>
    readTitleSnapshot?(id: string): Promise<{ title?: unknown }>
    readTitleSnapshots?(ids: readonly string[]): Promise<readonly { sessionId?: string; status?: string; value?: unknown }[]>
    searchSessions?(request: {
      query: string
      limit?: number
      cursor?: unknown
      sessionFilters?: readonly unknown[]
    }): Promise<{
      items?: readonly unknown[]
      nextCursor?: unknown
    }>
  }
  sessionPersistence?: {
    readRaw?(id: string): Promise<{ content?: string } | undefined>
    locate?(meta: { id: string; cwd?: string; createdAt?: number }): { path?: string } | undefined
  }
  workspaceRegistry?: {
    archivedSessionIds?: readonly string[] | Set<string>
    archiveSession?(sessionId: string): Promise<void> | void
    enqueueOperation?(operation: () => Promise<void> | void): Promise<unknown>
    requireState?(): { workspaceIds?: readonly unknown[]; archivedSessionIds?: readonly string[] } | undefined
    setState?(state: unknown): Promise<unknown> | unknown
    list?(): readonly SessionWorkspaceLike[]
  }
  sessions?: {
    get?(id: string): unknown
    prepare?(id?: string, options?: {
      seed?: readonly unknown[]
      meta?: { cwd?: string; createdAt?: number }
    }): unknown
    enter?(session: unknown): () => void
    announce?(session: unknown): void
    flush?(session: unknown): Promise<unknown>
  }
  agents?: {
    resume?(options: { resumeSessionId: string }): Promise<unknown>
  }
  tools?: {
    list?(): readonly { name?: string }[]
  }
}

function isSessionRecord(value: unknown): value is { header?: { id?: string }; id?: string; live?: boolean; persisted?: boolean; blank?: boolean } {
  return typeof value === 'object' && value !== null
}

function recordId(record: { header?: { id?: string }; id?: string }): string {
  return record.header?.id ?? record.id ?? ''
}

function recordHeader(record: { header?: unknown }): { id?: string; createdAt?: number; cwd?: string } | undefined {
  return record.header as { id?: string; createdAt?: number; cwd?: string } | undefined
}

function normalizeTitle(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') return value
  const obj = value as { title?: unknown }
  if (typeof obj.title === 'string') return obj.title
  return undefined
}

function normalizeTitleObservation(result: unknown): string | undefined {
  if (result == null) return undefined
  const obj = result as { value?: unknown; title?: unknown }
  if (obj.title != null) return normalizeTitle(obj.title)
  if (obj.value != null) return normalizeTitle(obj.value)
  return undefined
}

function normalizeReadSession(value: { session?: unknown; header?: unknown; events?: readonly unknown[] }): { id?: string; createdAt?: number; cwd?: string; events: readonly { type?: string; time?: number; data?: unknown }[] } {
  const header = (value.session ?? value.header) as { id?: string; createdAt?: number; cwd?: string } | undefined
  return {
    id: header?.id,
    createdAt: header?.createdAt,
    cwd: header?.cwd,
    events: (value.events ?? []) as readonly { type?: string; time?: number; data?: unknown }[],
  }
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
function recordFingerprint(record: unknown): number | undefined {
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

/** One cross-session full-text hit as returned by `sessionQuery.searchSessions`. */
interface SessionSearchHitLike {
  header?: { id?: string; createdAt?: number; cwd?: string }
  id?: string
  live?: boolean
  persisted?: boolean
  blank?: boolean
  bestMatch?: { snippet?: string }
}

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

function archivedSetOf(workspaceRegistry: SessionServiceContext['workspaceRegistry']): Set<string> {
  const raw = workspaceRegistry?.archivedSessionIds
  if (!raw) return new Set()
  if (Array.isArray(raw)) return new Set(raw)
  return raw instanceof Set ? raw : new Set()
}

const DSH_RC_VERSION = '0.1.0-rc.7'
const UNARCHIVE_CHANNEL_VERSION = 1
export const DELETE_CONFIRM_TOKEN = 'DELETE'

/** The rc.7 workspaceRegistry internal channel face required by ADR-0001. */
interface UnarchiveWorkspaceRegistry {
  enqueueOperation(operation: () => Promise<void> | void): Promise<unknown>
  requireState(): { initialized?: boolean; workspaceIds?: readonly unknown[]; archivedSessionIds?: readonly string[] }
  setState(state: unknown): Promise<unknown> | unknown
}

function requireUnarchiveChannel(registry: SessionServiceContext['workspaceRegistry']): UnarchiveWorkspaceRegistry {
  if (!registry || typeof registry.enqueueOperation !== 'function' || typeof registry.requireState !== 'function' || typeof registry.setState !== 'function') {
    throw new Error(
      `workspaceRegistry.unarchive internal channel is unavailable: expected enqueueOperation/requireState/setState ` +
      `(DSH ${DSH_RC_VERSION}, channel v${UNARCHIVE_CHANNEL_VERSION})`,
    )
  }
  return registry as unknown as UnarchiveWorkspaceRegistry
}

/** Shared internal-channel state validation for unarchive/delete cleanup. */
function requireRegistryState(registry: SessionServiceContext['workspaceRegistry']): { initialized: boolean; workspaceIds: readonly string[]; archivedSessionIds: readonly string[] } {
  const channel = requireUnarchiveChannel(registry)
  const state = channel.requireState()
  if (
    !state ||
    typeof state.initialized !== 'boolean' ||
    !Array.isArray(state.archivedSessionIds) ||
    state.archivedSessionIds.some((id) => typeof id !== 'string') ||
    !Array.isArray(state.workspaceIds) ||
    state.workspaceIds.some((id) => typeof id !== 'string')
  ) {
    throw new Error(
      `workspaceRegistry unarchive internal channel state is invalid: expected initialized boolean, workspaceIds string[], archivedSessionIds string[] ` +
      `(DSH ${DSH_RC_VERSION}, channel v${UNARCHIVE_CHANNEL_VERSION})`,
    )
  }
  return {
    initialized: state.initialized,
    workspaceIds: state.workspaceIds as readonly string[],
    archivedSessionIds: state.archivedSessionIds as readonly string[],
  }
}

const THIRD_PARTY_SOURCE_SEGMENTS = new Set(['.claude', '.codex'])

function isProtectedThirdPartyPath(filePath: string): boolean {
  const segments = filePath.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean)
  return segments.some((segment) => THIRD_PARTY_SOURCE_SEGMENTS.has(segment))
}

export class SessionManagementService {
  /** In-memory preview snapshots required before cleanup execution can run. */
  private readonly cleanupPreviews = new Map<string, { sessionIds: readonly string[] }>()

  /** Cached per-session statistics keyed by the session's updatedAt fingerprint. */
  private readonly detailCache = new Map<string, { fingerprint: number; detail: SessionDetailBase }>()
  private static readonly MAX_DETAIL_CACHE = 1000

  constructor(
    private readonly ctx: SessionServiceContext,
    private readonly manifest: ManifestStore,
    private readonly options: SessionManagementOptions = {},
  ) {}

  /** Run async map over a bounded pool to avoid opening unbounded file handles. */
  private async mapConcurrent<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length)
    let next = 0
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await fn(items[index], index)
      }
    })
    await Promise.all(workers)
    return results
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
    const records = await this.ctx.sessionQuery.listSessions()
    const archived = archivedSetOf(this.ctx.workspaceRegistry)

    const mapped = await this.mapConcurrent(records, 16, async (raw): Promise<SessionListItem | null> => {
      if (!isSessionRecord(raw)) return null
      const id = recordId(raw)
      if (!id) return null
      const header = recordHeader(raw)
      const cwd = header?.cwd

      if (filters.cwd && cwd !== filters.cwd) return null
      if (filters.workspace && !workspaceMatches(cwd, filters.workspace)) return null

      const isArchived = archived.has(id)
      if (filters.archived != null && filters.archived !== 'all' && isArchived !== filters.archived) {
        return null
      }

      const source = await this.sourceOf(id)
      if (filters.source && filters.source !== 'all' && source !== filters.source) return null

      const title = await this.titleOf(id)
      if (filters.query) {
        const q = filters.query.trim().toLowerCase()
        if (!q || !(title ?? '').toLowerCase().includes(q)) return null
      }

      const detail = await this.detailOf(id, source, isArchived, raw)
      return {
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
      }
    })

    const items = mapped.filter((item): item is SessionListItem => item !== null)
    items.sort((a, b) => b.updatedAt - a.updatedAt)
    return { items, total: items.length }
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
    if (this.options.fullTextSearch !== 'never' && typeof this.ctx.sessionQuery.searchSessions === 'function') {
      return this.searchContent(q, filters)
    }
    return this.list({ ...filters, query: q })
  }

  private async searchContent(query: string, filters: SessionListFilter = {}): Promise<SessionListResult> {
    const searchSessions = this.ctx.sessionQuery.searchSessions
    if (typeof searchSessions !== 'function') {
      return this.list({ ...filters, query })
    }

    // Apply plugin-owned filters (source, archive state, workspace) to the full
    // logical corpus first, then ask the official full-text engine to search
    // only that filtered session pool. This keeps search + filters composable
    // without dropping matches after a pagination cap.
    const sessionIds = await this.filteredSessionIds(filters)
    if (sessionIds.length === 0) return { items: [], total: 0 }

    const sessionFilters: unknown[] = [{ kind: 'id', values: sessionIds }]
    if (filters.cwd) sessionFilters.push({ kind: 'cwd', values: [filters.cwd] })

    const hits: SessionSearchHitLike[] = []
    let cursor: unknown
    do {
      const page = await searchSessions({
        query,
        limit: 100,
        ...(cursor !== undefined ? { cursor } : {}),
        sessionFilters,
      })
      const pageItems = (page?.items ?? []) as unknown[]
      for (const raw of pageItems) {
        if (typeof raw === 'object' && raw !== null) hits.push(raw as SessionSearchHitLike)
      }
      cursor = page?.nextCursor
    } while (cursor !== undefined)

    const archived = archivedSetOf(this.ctx.workspaceRegistry)
    const mapped = await this.mapConcurrent(hits, 16, async (hit): Promise<SessionListItem | null> => {
      const id = searchHitId(hit)
      if (!id || !sessionIds.includes(id)) return null
      const header = hit.header
      const cwd = header?.cwd
      const isArchived = archived.has(id)
      const source = await this.sourceOf(id)
      const title = await this.titleOf(id)
      const detail = await this.detailOf(id, source, isArchived, hit)
      return {
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
      }
    })

    const items = mapped.filter((item): item is SessionListItem => item !== null)
    items.sort((a, b) => b.updatedAt - a.updatedAt)
    return { items, total: items.length }
  }

  private async filteredSessionIds(filters: SessionListFilter): Promise<string[]> {
    const records = await this.ctx.sessionQuery.listSessions()
    const archived = archivedSetOf(this.ctx.workspaceRegistry)
    const ids: string[] = []

    for (const raw of records) {
      if (!isSessionRecord(raw)) continue
      const id = recordId(raw)
      if (!id) continue
      const header = recordHeader(raw)
      const cwd = header?.cwd

      if (filters.cwd && cwd !== filters.cwd) continue
      if (filters.workspace && !workspaceMatches(cwd, filters.workspace)) continue
      const isArchived = archived.has(id)
      if (filters.archived != null && filters.archived !== 'all' && isArchived !== filters.archived) continue
      const source = await this.sourceOf(id)
      if (filters.source && filters.source !== 'all' && source !== filters.source) continue

      ids.push(id)
    }

    return ids
  }

  /** Read one session's history preview through the official read path. */
  async preview(id: string): Promise<SessionPreview> {
    const snapshot = await this.ctx.sessionQuery.readSession(id)
    const normalized = normalizeReadSession(snapshot)
    const source = await this.sourceOf(id)
    const archived = archivedSetOf(this.ctx.workspaceRegistry).has(id)
    const title = await this.titleOf(id)
    const running = await this.isRunning(id)

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
    }
  }

  /** Archive one session through the official workspace registry API. */
  async archive(sessionId: string): Promise<void> {
    const registry = this.ctx.workspaceRegistry
    if (!registry || typeof registry.archiveSession !== 'function') {
      throw new Error(`workspaceRegistry.archiveSession is unavailable (DSH ${DSH_RC_VERSION})`)
    }
    await registry.archiveSession(sessionId)
  }

  /**
   * Unarchive one session through the ADR-0001 internal channel.
   *
   * The channel is shape/version guarded: a missing or damaged internal face
   * fails loudly before any write. Repeated unarchive of an already-active
   * session is a no-op.
   */
  async unarchive(sessionId: string): Promise<void> {
    const registry = requireUnarchiveChannel(this.ctx.workspaceRegistry)
    await registry.enqueueOperation(async () => {
      const state = requireRegistryState(this.ctx.workspaceRegistry)
      if (!state.archivedSessionIds.includes(sessionId)) return
      await registry.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
      })
    })
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
  async deleteSessions(sessionIds: readonly string[], options: SessionDeleteOptions = {}): Promise<SessionDeleteResult> {
    const ids = [...new Set(sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    if (ids.length === 0) {
      throw new Error('No session ids provided for deletion')
    }
    if (options.confirmToken !== DELETE_CONFIRM_TOKEN) {
      throw new Error('Delete requires the exact token DELETE')
    }

    // Validate every gate before any irreversible side effect.
    const registry = requireUnarchiveChannel(this.ctx.workspaceRegistry)
    requireRegistryState(this.ctx.workspaceRegistry)

    const running = []
    for (const id of ids) {
      if (await this.isRunning(id)) running.push(id)
    }
    if (running.length > 0) {
      throw new Error(`Cannot delete running session(s): ${running.join(', ')}`)
    }

    const locations: SessionArtifactLocation[] = []
    for (const id of ids) {
      locations.push(await this.locateDeletionTarget(id))
    }

    if (!this.options.deleter) {
      throw new Error('Session artifact deleter is not configured')
    }

    // Double-check all cleanup faces before deleting anything.
    await this.manifest.assertDeleteAvailable()
    this.assertWorkspaceCleanupAvailable(ids)

    for (const location of locations) {
      await this.options.deleter(location)
    }

    await this.removeArchived(ids, registry)
    await this.detachWorkspaces(ids)
    await this.removeManifest(ids)

    return {
      deletedSessionIds: ids,
      paths: locations.map((location) => location.path),
    }
  }

  /**
   * Global and per-session statistics.
   *
   * This is a read-only walk over the unified session list; it never touches
   * third-party source files and never writes to any service.
   */
  async stats(): Promise<SessionStatsResult> {
    const result = await this.list()
    const bySource = new Map<SessionSource, { count: number; totalSizeBytes: number }>([
      ['dsh', { count: 0, totalSizeBytes: 0 }],
      ['claude-code', { count: 0, totalSizeBytes: 0 }],
      ['codex', { count: 0, totalSizeBytes: 0 }],
    ])
    const sessions: SessionMetric[] = result.items.map((item) => ({
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
    }))
    for (const session of sessions) {
      const entry = bySource.get(session.source)!
      entry.count += 1
      entry.totalSizeBytes += session.sizeBytes
    }
    const bySourceList: SessionSourceStats[] = [...bySource.entries()].map(([source, value]) => ({
      source,
      ...value,
    }))
    return {
      totalSessions: sessions.length,
      totalSizeBytes: sessions.reduce((sum, session) => sum + session.sizeBytes, 0),
      bySource: bySourceList,
      sessions,
    }
  }

  /**
   * Generate a cleanup candidate preview from composable rules.
   *
   * This phase is strictly read-only: it walks the same unified list as the UI
   * and records an in-memory preview snapshot.  Running sessions that would
   * otherwise match are moved to `excluded` with a reason; no session is ever
   * deleted here.
   */
  async cleanupPreview(overrides: Partial<CleanupRule> = {}): Promise<CleanupPreviewResult> {
    const rules = this.normalizeCleanupRule(overrides)
    const listResult = await this.list({
      source: rules.source === 'all' ? undefined : rules.source,
      archived: rules.archivedOnly ? true : undefined,
    })

    const items: CleanupPreviewItem[] = []
    const excluded: CleanupExcludedItem[] = []
    const now = Date.now()
    const olderThanMs = rules.olderThanDays > 0 ? rules.olderThanDays * 24 * 60 * 60 * 1000 : 0
    const largerThanBytes = rules.largerThanMb > 0 ? rules.largerThanMb * 1024 * 1024 : 0

    for (const item of listResult.items) {
      const matchedRules: string[] = []
      if (olderThanMs > 0 && now - item.updatedAt >= olderThanMs) matchedRules.push('olderThanDays')
      if (largerThanBytes > 0 && item.sizeBytes > largerThanBytes) matchedRules.push('largerThanMb')
      if (rules.emptySessions && item.blank) matchedRules.push('emptySessions')
      if (matchedRules.length === 0) continue

      if (item.running) {
        excluded.push({
          sessionId: item.id,
          title: item.title,
          reason: `Running session is never deleted${matchedRules.length > 0 ? ` (matched: ${matchedRules.join(', ')})` : ''}`,
        })
        continue
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
      })
    }

    const previewId = `preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    this.cleanupPreviews.set(previewId, {
      sessionIds: items.map((item) => item.id),
    })

    return {
      previewId,
      rules,
      items,
      excluded,
      total: items.length,
      totalSizeBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
    }
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
  async cleanupExecute(
    sessionIds: readonly string[],
    options: CleanupExecuteOptions = {},
  ): Promise<CleanupReport> {
    if (options.confirmToken !== DELETE_CONFIRM_TOKEN) {
      throw new Error('Cleanup requires the exact token DELETE')
    }
    if (!options.previewId) {
      throw new Error('Cleanup must be previewed before execution')
    }
    const preview = this.cleanupPreviews.get(options.previewId)
    if (!preview) {
      throw new Error('Cleanup preview is missing or expired; run cleanupPreview again')
    }
    this.cleanupPreviews.delete(options.previewId)

    const ids = [...new Set(sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    if (ids.length === 0) {
      return { items: [], success: 0, failed: 0 }
    }
    const notInPreview = ids.filter((id) => !preview.sessionIds.includes(id))
    if (notInPreview.length > 0) {
      throw new Error(`Cleanup selection includes sessions not in the latest preview: ${notInPreview.join(', ')}`)
    }

    try {
      const result = await this.deleteSessions(ids, { confirmToken: DELETE_CONFIRM_TOKEN })
      return {
        items: ids.map((id) => {
          const path = result.paths[result.deletedSessionIds.indexOf(id)]
          return {
            sessionId: id,
            status: 'success' as const,
            ...(path ? { path } : {}),
          }
        }),
        success: ids.length,
        failed: 0,
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return {
        items: ids.map((id) => ({ sessionId: id, status: 'failed' as const, reason })),
        success: 0,
        failed: ids.length,
      }
    }
  }

  private normalizeCleanupRule(overrides: Partial<CleanupRule>): CleanupRule {
    return {
      olderThanDays: overrides.olderThanDays ?? this.options.cleanup?.olderThanDays ?? 30,
      largerThanMb: overrides.largerThanMb ?? this.options.cleanup?.largerThanMb ?? 100,
      emptySessions: overrides.emptySessions ?? this.options.cleanup?.emptySessions ?? false,
      archivedOnly: overrides.archivedOnly ?? this.options.cleanup?.archivedOnly ?? true,
      source: overrides.source ?? this.options.cleanup?.source ?? 'all',
    }
  }

  /**
   * Open/resume a cold session through the official agent registry resume
   * path. Running sessions are left untouched.
   */
  async open(sessionId: string): Promise<SessionOpenResult> {
    if (await this.isRunning(sessionId)) {
      return { sessionId, resumed: false, alreadyRunning: true }
    }

    if (!this.ctx.agents?.resume) {
      throw new Error(`agents.resume is unavailable (DSH ${DSH_RC_VERSION})`)
    }

    const snapshot = await this.ctx.sessionQuery.readSession(sessionId)
    const normalized = normalizeReadSession(snapshot)
    await this.ctx.agents.resume({ resumeSessionId: sessionId })
    return {
      sessionId,
      resumed: true,
      alreadyRunning: false,
      cwd: normalized.cwd,
    }
  }

  /**
   * Scan the configured (or caller-supplied) Claude Code projects directory
   * and return only unimported, non-subagent, non-empty main sessions.
   */
  async scanClaude(root?: string): Promise<ImportScanResult> {
    const files = await this.scanClaudeFiles(root)
    files.sort((a, b) => b.updatedAt - a.updatedAt)
    return {
      items: files,
      total: files.length,
      badLines: files.reduce((sum, item) => sum + item.badLines, 0),
    }
  }

  /**
   * Import one or more previously scanned Claude Code sessions through the
   * official session seed path.  Already-imported sessions are skipped; bad
   * lines are counted and do not abort the whole file.
   */
  async importClaude(selections: readonly ImportSelection[], root?: string): Promise<ImportReport> {
    const reader = this.requireClaude()
    const scanRoot = root ?? this.options.claudePath
    if (!scanRoot) {
      throw new Error('Claude import root is not configured; pass claudePath or scan root')
    }

    const scanned = await this.scanClaudeFiles(scanRoot)
    const byId = new Map(scanned.map((item) => [item.sourceSessionId, item]))
    const items: ImportReportItem[] = []

    for (const selection of selections) {
      const existing = await this.manifest.getBySource('claude-code', selection.sourceSessionId)
      if (existing) {
        items.push({
          sourceSessionId: selection.sourceSessionId,
          path: selection.path,
          status: 'skipped',
          dshSessionId: existing.dshSessionId,
          reason: 'Already imported',
        })
        continue
      }

      const candidate = byId.get(selection.sourceSessionId)
      if (!candidate) {
        items.push({
          sourceSessionId: selection.sourceSessionId,
          path: selection.path,
          status: 'failed',
          reason: 'Session is not in the unimported scan queue (already imported, subagent, empty, or not found)',
        })
        continue
      }

      try {
        const parsed = await reader.readClaudeFile(candidate.path)
        const conversion = convertClaudeRecords(parsed.records, {
          knowTool: (name) => this.isKnownTool(name),
        })
        const dshSessionId = await this.createImportedSession(conversion)
        await this.manifest.put({
          source: 'claude-code',
          sourceSessionId: candidate.sourceSessionId,
          dshSessionId,
          importedAt: Date.now(),
        })
        items.push({
          sourceSessionId: candidate.sourceSessionId,
          path: candidate.path,
          status: 'success',
          dshSessionId,
          badLines: parsed.badLines,
        })
      } catch (error) {
        items.push({
          sourceSessionId: candidate.sourceSessionId,
          path: candidate.path,
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
          badLines: 0,
        })
      }
    }

    return {
      items,
      success: items.filter((item) => item.status === 'success').length,
      skipped: items.filter((item) => item.status === 'skipped').length,
      failed: items.filter((item) => item.status === 'failed').length,
    }
  }

  /**
   * Scan the configured (or caller-supplied) Codex home and return only
   * unimported, non-subagent, non-empty main sessions from both `sessions/`
   * and `archived_sessions/`.
   */
  async scanCodex(root?: string): Promise<ImportScanResult> {
    const files = await this.scanCodexFiles(root)
    files.sort((a, b) => b.updatedAt - a.updatedAt)
    return {
      items: files,
      total: files.length,
      badLines: files.reduce((sum, item) => sum + item.badLines, 0),
    }
  }

  /**
   * Import one or more previously scanned Codex sessions through the official
   * session seed path.  Already-imported sessions are skipped; bad lines are
   * counted and do not abort the whole file.
   */
  async importCodex(selections: readonly ImportSelection[], root?: string): Promise<ImportReport> {
    const reader = this.requireCodex()
    const scanRoot = root ?? this.options.codexPath
    if (!scanRoot) {
      throw new Error('Codex import root is not configured; pass codexPath or scan root')
    }

    const scanned = await this.scanCodexFiles(scanRoot)
    const byId = new Map(scanned.map((item) => [item.sourceSessionId, item]))
    const items: ImportReportItem[] = []

    for (const selection of selections) {
      const existing = await this.manifest.getBySource('codex', selection.sourceSessionId)
      if (existing) {
        items.push({
          sourceSessionId: selection.sourceSessionId,
          path: selection.path,
          status: 'skipped',
          dshSessionId: existing.dshSessionId,
          reason: 'Already imported',
        })
        continue
      }

      const candidate = byId.get(selection.sourceSessionId)
      if (!candidate) {
        items.push({
          sourceSessionId: selection.sourceSessionId,
          path: selection.path,
          status: 'failed',
          reason: 'Session is not in the unimported scan queue (already imported, subagent, empty, or not found)',
        })
        continue
      }

      try {
        const parsed = await reader.readCodexFile(candidate.path)
        const conversion = convertCodexRecords(parsed.records, {
          knowTool: (name) => this.isKnownTool(name),
        })
        const dshSessionId = await this.createImportedSession(conversion)
        await this.manifest.put({
          source: 'codex',
          sourceSessionId: candidate.sourceSessionId,
          dshSessionId,
          importedAt: Date.now(),
        })
        items.push({
          sourceSessionId: candidate.sourceSessionId,
          path: candidate.path,
          status: 'success',
          dshSessionId,
          badLines: parsed.badLines,
        })
      } catch (error) {
        items.push({
          sourceSessionId: candidate.sourceSessionId,
          path: candidate.path,
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
          badLines: 0,
        })
      }
    }

    return {
      items,
      success: items.filter((item) => item.status === 'success').length,
      skipped: items.filter((item) => item.status === 'skipped').length,
      failed: items.filter((item) => item.status === 'failed').length,
    }
  }

  private requireCodex(): CodexSourceReader {
    if (!this.options.codex) {
      throw new Error('Codex source reader is not configured')
    }
    return this.options.codex
  }

  private async scanCodexFiles(root: string | undefined): Promise<ImportCandidateItem[]> {
    const reader = this.requireCodex()
    const scanRoot = root ?? this.options.codexPath
    if (!scanRoot) {
      throw new Error('Codex import root is not configured; pass codexPath or scan root')
    }

    const files = await reader.listCodexFiles(scanRoot)
    const seen = new Map<string, ImportCandidateItem>()

    for (const file of files) {
      const parsed = await reader.readCodexFile(file)
      if (parsed.summary.isSubagent) continue
      if (!parsed.summary.hasRealUserMessage) continue
      const existing = await this.manifest.getBySource('codex', parsed.summary.sourceSessionId)
      if (existing) continue
      if (seen.has(parsed.summary.sourceSessionId)) continue

      const threadTitle = await reader.resolveTitle(scanRoot, parsed.summary.sourceSessionId)
      const summary = applyCodexThreadTitle(parsed.summary, threadTitle)
      const stat = await reader.stat(file)
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
      })
    }

    return [...seen.values()]
  }

  private requireClaude(): ClaudeSourceReader {
    if (!this.options.claude) {
      throw new Error('Claude source reader is not configured')
    }
    return this.options.claude
  }

  private async scanClaudeFiles(root: string | undefined): Promise<ImportCandidateItem[]> {
    const reader = this.requireClaude()
    const scanRoot = root ?? this.options.claudePath
    if (!scanRoot) {
      throw new Error('Claude import root is not configured; pass claudePath or scan root')
    }

    const files = await reader.listClaudeFiles(scanRoot)
    const seen = new Map<string, ImportCandidateItem>()

    for (const file of files) {
      const parsed = await reader.readClaudeFile(file)
      if (parsed.summary.isSubagent) continue
      if (!parsed.summary.hasRealUserMessage) continue
      const existing = await this.manifest.getBySource('claude-code', parsed.summary.sourceSessionId)
      if (existing) continue
      if (seen.has(parsed.summary.sourceSessionId)) continue

      const stat = await reader.stat(file)
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
      })
    }

    return [...seen.values()]
  }

  private isKnownTool(name: string): boolean {
    const list = this.ctx.tools?.list?.()
    if (!list) return false
    return list.some((tool) => tool.name === name)
  }

  private async createImportedSession(conversion: ClaudeConversionResult | CodexConversionResult): Promise<string> {
    const sessions = this.ctx.sessions
    if (
      !sessions ||
      typeof sessions.prepare !== 'function' ||
      typeof sessions.enter !== 'function' ||
      typeof sessions.announce !== 'function' ||
      typeof sessions.flush !== 'function'
    ) {
      throw new Error('sessions official seed path is unavailable (prepare/enter/announce/flush)')
    }

    const session = sessions.prepare(conversion.dshSessionId, {
      seed: conversion.events,
      meta: {
        cwd: conversion.header.cwd,
        createdAt: conversion.header.createdAt,
      },
    })
    const detach = sessions.enter(session)
    try {
      sessions.announce(session)
      await sessions.flush(session)
    } finally {
      detach()
    }
    return conversion.dshSessionId
  }

  private async sourceOf(id: string): Promise<SessionSource> {
    const record = await this.manifest.getByDsh(id)
    return record?.source ?? 'dsh'
  }

  private async titleOf(id: string): Promise<string | undefined> {
    const query = this.ctx.sessionQuery
    if (typeof query.readTitleSnapshots === 'function') {
      const results = await query.readTitleSnapshots([id])
      const result = results.find((entry) => entry.sessionId === id || (entry as { id?: string }).id === id)
      if (result) return normalizeTitleObservation(result)
    }
    if (typeof query.readTitleSnapshot === 'function') {
      const result = await query.readTitleSnapshot(id)
      return normalizeTitleObservation(result)
    }
    if (typeof query.readTitle === 'function') {
      const result = await query.readTitle(id)
      return normalizeTitle(result)
    }
    return undefined
  }

  private async eventsOf(id: string): Promise<readonly { type?: string; time?: number }[]> {
    const query = this.ctx.sessionQuery
    if (typeof query.listEvents === 'function') {
      const events = await query.listEvents(id)
      if (events.length > 0) return events
    }
    const snapshot = await query.readSession(id)
    return normalizeReadSession(snapshot).events as readonly { type?: string; time?: number }[]
  }

  /** Single-pass metrics over an event list; avoids multiple full-array scans. */
  private computeMetrics(events: readonly { type?: string; time?: number; data?: unknown }[]): {
    updatedAt: number | undefined
    messageCount: number
    durationMs: number
    toolCalls: number
    toolSuccess: number
    toolNoResult: number
    blank: boolean
  } {
    let messageCount = 0
    let toolCalls = 0
    let toolSuccess = 0
    let hasTurnStart = false
    let minTime: number | undefined
    let maxTime: number | undefined
    let lastTime: number | undefined
    for (const event of events) {
      const type = event.type
      if (type === 'user/message' || type === 'assistant/message') messageCount++
      else if (type === 'tool/call') toolCalls++
      else if (type === 'tool/result' && this.isToolResultSuccess(event)) toolSuccess++
      if (type === 'turn/start') hasTurnStart = true
      const time = event.time
      if (typeof time === 'number') {
        if (minTime === undefined || time < minTime) minTime = time
        if (maxTime === undefined || time > maxTime) maxTime = time
      }
      lastTime = event.time
    }
    return {
      updatedAt: lastTime,
      messageCount,
      durationMs: minTime === undefined || maxTime === undefined ? 0 : Math.max(0, maxTime - minTime),
      toolCalls,
      toolSuccess,
      toolNoResult: Math.max(0, toolCalls - toolSuccess),
      blank: !hasTurnStart,
    }
  }

  private async detailOf(
    id: string,
    _source: SessionSource,
    _archived: boolean,
    record: { header?: unknown; live?: boolean; persisted?: boolean; blank?: boolean },
  ): Promise<SessionDetailBase & { running: boolean; live: boolean }> {
    const header = recordHeader(record)
    const createdAt = header?.createdAt ?? 0
    const fingerprint = recordFingerprint(record)

    // Fast path: the official summary exposes updatedAt; when unchanged the
    // session is append-only, so the previous stats are still valid.
    if (fingerprint !== undefined) {
      const cached = this.detailCache.get(id)
      if (cached && cached.fingerprint === fingerprint) {
        const live = record.live ?? (await this.isRunning(id))
        return { ...cached.detail, running: record.live ?? live, live }
      }
    }

    let events: readonly { type?: string; time?: number; data?: unknown }[] | undefined
    let sizeBytes: number | undefined
    const raw = await this.ctx.sessionPersistence?.readRaw?.(id)
    const rawContent = raw?.content
    const listEvents = this.ctx.sessionQuery.listEvents
    if (typeof listEvents === 'function') {
      const listed = await listEvents(id)
      if (listed.length > 0) {
        // listEvents is the official lightweight event face when available.
        events = listed
        sizeBytes = rawContent ? Buffer.byteLength(rawContent, 'utf8') : await this.sizeOf(id, listed)
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
    const live = record.live ?? (await this.isRunning(id))
    const running = record.live ?? live
    const detail: SessionDetailBase = {
      createdAt,
      updatedAt: metrics.updatedAt ?? createdAt,
      sizeBytes,
      messageCount: metrics.messageCount,
      durationMs: metrics.durationMs,
      toolCalls: metrics.toolCalls,
      toolSuccess: metrics.toolSuccess,
      toolNoResult: metrics.toolNoResult,
      persisted: record.persisted ?? true,
      blank: record.blank === true || metrics.blank,
    }

    if (fingerprint !== undefined) {
      if (this.detailCache.size >= SessionManagementService.MAX_DETAIL_CACHE) {
        this.detailCache.clear()
      }
      this.detailCache.set(id, { fingerprint, detail })
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
    const raw = await this.ctx.sessionPersistence?.readRaw?.(id)
    if (raw?.content) {
      return Buffer.byteLength(raw.content, 'utf8')
    }
    return events.reduce<number>((sum, event) => sum + JSON.stringify(event).length, 0)
  }

  private lastActiveAt(events: readonly { time?: number }[], fallback = 0): number {
    if (events.length === 0) return fallback
    const last = events[events.length - 1]?.time
    return last ?? fallback
  }

  private async locateDeletionTarget(id: string): Promise<SessionArtifactLocation> {
    const locate = this.ctx.sessionPersistence?.locate
    if (typeof locate !== 'function') {
      throw new Error(`sessionPersistence.locate is unavailable; cannot delete session ${id}`)
    }
    const snapshot = await this.ctx.sessionQuery.readSession(id)
    const normalized = normalizeReadSession(snapshot)
    const location = locate({
      id,
      ...(normalized.cwd ? { cwd: normalized.cwd } : {}),
      ...(normalized.createdAt ? { createdAt: normalized.createdAt } : {}),
    })
    if (!location || typeof location.path !== 'string' || location.path.length === 0) {
      throw new Error(`Cannot resolve deletion path for session ${id}`)
    }
    if (isProtectedThirdPartyPath(location.path)) {
      throw new Error(`Refusing to delete third-party source file: ${location.path}`)
    }
    return { sessionId: id, path: location.path }
  }

  private assertWorkspaceCleanupAvailable(ids: readonly string[]): void {
    const registry = this.ctx.workspaceRegistry
    const state = requireRegistryState(this.ctx.workspaceRegistry)
    const workspaces = typeof registry?.list === 'function' ? registry.list() : []
    const hasMatchingWorkspace = workspaces.some((workspace) =>
      workspace.sessionIds?.some((id) => ids.includes(id)),
    )
    if (hasMatchingWorkspace && workspaces.some((workspace) =>
      workspace.sessionIds?.some((id) => ids.includes(id)) && typeof workspace.detachSession !== 'function',
    )) {
      throw new Error('workspace entity detachSession is unavailable; cannot clean workspace registration')
    }
    if (!hasMatchingWorkspace && state.workspaceIds.length > 0 && typeof registry?.list !== 'function') {
      throw new Error('workspaceRegistry.list is unavailable; cannot clean workspace registration')
    }
  }

  private async removeArchived(
    ids: readonly string[],
    registry: UnarchiveWorkspaceRegistry,
  ): Promise<void> {
    await registry.enqueueOperation(async () => {
      const state = requireRegistryState(this.ctx.workspaceRegistry)
      const next = state.archivedSessionIds.filter((id) => !ids.includes(id))
      if (next.length === state.archivedSessionIds.length) return
      await registry.setState({
        ...state,
        archivedSessionIds: next,
      })
    })
  }

  private async detachWorkspaces(ids: readonly string[]): Promise<void> {
    const registry = this.ctx.workspaceRegistry
    if (typeof registry?.list !== 'function') return
    for (const workspace of registry.list()) {
      if (!workspace.sessionIds?.some((id) => ids.includes(id))) continue
      if (typeof workspace.detachSession !== 'function') {
        throw new Error('workspace entity detachSession is unavailable; cannot clean workspace registration')
      }
      for (const id of ids) {
        if (workspace.sessionIds.includes(id)) {
          await workspace.detachSession(id)
        }
      }
    }
  }

  private async removeManifest(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await this.manifest.removeByDsh(id)
    }
  }

  private async isRunning(id: string): Promise<boolean> {
    const session = await this.ctx.sessions?.get?.(id)
    return Boolean(session)
  }
}

/** Convenience factory used by the plugin entry. */
export function createSessionManagementService(
  ctx: SessionServiceContext,
  manifest: ManifestStore,
  options: SessionManagementOptions = {},
): SessionManagementService {
  return new SessionManagementService(ctx, manifest, options)
}

/** Backward-friendly aliases matching the spec's "SessionManagement 服务" naming. */
export const SessionManagement = SessionManagementService
export const createSessionManagement = createSessionManagementService
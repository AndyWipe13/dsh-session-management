/**
 * SessionManagement host service — the single test seam for session management.
 *
 * Issues #3/#4 implement list/search/preview/archive/unarchive; issue #5 adds
 * Claude Code scan/import plus open/resume. The service is a thin composition
 * over the official services and the plugin's import manifest; it deliberately
 * contains no filesystem access so every test can drive it through fakes.
 */

import type { ImportRecord, ManifestStore, SessionSource } from './manifest.js'
import { SESSION_SOURCES } from './manifest.js'
import type {
  ImportCandidateItem,
  ImportReport,
  ImportReportItem,
  ImportScanPageOptions,
  ImportScanPageResult,
  ImportScanResult,
  ImportSelection,
  ImportSource,
  ImportSourceAdapter,
} from './import-queue.js'
import { ImportQueue } from './import-queue.js'
import { SessionProjection } from './session-projection.js'
import { createDshHostAdapter, isSessionRecord, recordId,
  type DshHostAdapter, type HostDeletionPlan, type HostSessionRecord } from './dsh-host.js'
import { mapConcurrent } from './async-pool.js'

export type {
  ImportCandidateItem,
  ImportReport,
  ImportReportItem,
  ImportScanPageOptions,
  ImportScanPageResult,
  ImportScanResult,
  ImportSelection,
  ImportSource,
  ImportSourceAdapter,
} from './import-queue.js'

export interface SessionManagementOptions {
  /** Substitute the DSH host implementation at the host-adapter seam. */
  host?: DshHostAdapter
  /** Detected host version; defaults to the installed @deepseek-ai/dsh package. */
  dshVersion?: string
  /** Configured Claude Code projects root; empty/undefined means caller supplies a path. */
  claudePath?: string
  /** Configured Codex home; empty/undefined means caller supplies a path. */
  codexPath?: string
  /**
   * Full-text search mode. `first-search` (default) enables content search via
   * the official searchSessions API; `never` falls back to title-only search.
   */
  fullTextSearch?: 'first-search' | 'never'
  /** Source-dialect adapters at the import-queue seam. */
  imports?: readonly ImportSourceAdapter[]
  /** Filesystem-facing artifact deleter. Defaults are supplied by the plugin entry. */
  deleter?: SessionArtifactDeleter
  /** Read-only file identity fallback for hosts without persistence list/stat metadata. */
  sessionArtifactStat?: (path: string) => Promise<{ sizeBytes: number; mtimeMs: number }>
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

/** Identity, provenance, activity, and state shared by every session projection. */
export interface SessionProjectionCore {
  id: string
  title?: string
  source: SessionSource
  cwd?: string
  createdAt: number
  updatedAt: number
  running: boolean
  archived: boolean
}

/** Event-derived measurements shared by detailed session projections. */
export interface SessionProjectionMetrics {
  sizeBytes: number
  messageCount: number
  durationMs: number
  toolCalls: number
  toolSuccess: number
  toolNoResult: number
}

export interface SessionListItem extends SessionProjectionCore, SessionProjectionMetrics {
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

/** Cursor-page row used by the settings page. Event metrics are optional. */
export interface SessionPageItem extends SessionProjectionCore {
  live: boolean
  persisted: boolean
  blank: boolean
  sizeBytes?: number
  messageCount?: number
  durationMs?: number
  snippet?: string
}

export interface SessionPageOptions {
  limit?: number
  cursor?: string
  /** Hydrate event-derived values for the selected page only. */
  includeMetrics?: boolean
}

export interface SessionPageResult {
  items: SessionPageItem[]
  total: number
  nextCursor?: string
}

export interface SessionMetric extends SessionProjectionCore, SessionProjectionMetrics {
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

export interface SessionPreview extends SessionProjectionCore, SessionProjectionMetrics {
  events: readonly unknown[]
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
  failures?: readonly { sessionId: string; reason: string }[]
}

export interface SessionArtifactLocation {
  sessionId: string
  path: string
}

export type SessionArtifactDeleter = (location: SessionArtifactLocation) => Promise<void> | void

/** One workspace entity as seen by the deletion cleanup path. */
export interface SessionWorkspaceLike {
  path?: string
  sessionIds?: readonly string[]
  attachSession?(sessionId: string): Promise<void> | void
  detachSession?(sessionId: string): Promise<void> | void
}

/** Minimal structural face of the official services the read path needs. */
export interface SessionServiceContext {
  /** Explicit host version used by structural fakes; production resolves the installed package. */
  dshVersion?: string
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
    prepare?(id: string): Promise<{ session: { append(type: string, data: unknown): unknown }; [Symbol.dispose](): void }>
    readRaw?(id: string): Promise<{ content?: string } | undefined>
    stat?(id: string): Promise<{ header?: { id?: string }; revision?: unknown; sizeBytes?: number } | undefined>
    list?(): Promise<readonly { header?: { id?: string }; revision?: unknown; sizeBytes?: number }[]>
    locate?(meta: { id: string; cwd?: string; createdAt?: number }): { path?: string } | undefined
  }
  workspaceRegistry?: {
    create?(path: string): Promise<SessionWorkspaceLike>
    archivedSessionIds?: readonly string[] | Set<string>
    archiveSession?(sessionId: string): Promise<void> | void
    enqueueOperation?(operation: () => Promise<void> | void): Promise<unknown>
    requireState?(): { workspaceIds?: readonly unknown[]; archivedSessionIds?: readonly string[] } | undefined
    setState?(state: unknown): Promise<unknown> | unknown
    list?(): readonly SessionWorkspaceLike[]
  }
  sessions?: {
    get?(id: string): unknown | Promise<unknown>
    prepare?(id?: string, options?: {
      seed?: readonly unknown[]
      meta?: { cwd?: string; createdAt?: number }
    }): unknown
    enter?(session: unknown): () => void
    announce?(session: unknown): void
    flush?(session: unknown): Promise<unknown>
  }
  agents?: {
    get?(id: string): unknown | Promise<unknown>
    resume?(options: { resumeSessionId: string }): Promise<unknown>
  }
  apiProxy?: {
    sessions?: {
      create?(request: {
        rpcId: string
        payload: { sessionId: string; cwd: string }
      }): Promise<{
        result: { ok: true; value: { sessionId: string } }
          | { ok: false; error: { message: string } }
      }>
    }
  }
  tools?: {
    list?(): readonly { name?: string }[]
  }
}

/** Keep only well-formed session ids from an untrusted array. */
export function sanitizeSessionIds(values: unknown): string[] {
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : []
}

export const DELETE_CONFIRM_TOKEN = 'DELETE'

/** SessionMetric is the canonical list row minus the list-only state fields. */
function toSessionMetric(item: SessionListItem): SessionMetric {
  const { live: _live, persisted: _persisted, snippet: _snippet, ...metric } = item
  return metric
}

export class SessionManagementService {
  /** In-memory preview snapshots required before cleanup execution can run. */
  private readonly cleanupPreviews = new Map<string, { sessionIds: readonly string[] }>()

  /** Canonical read model shared by list, search, preview, statistics, and cleanup. */
  private readonly projection: SessionProjection

  /** The only module that understands DSH rc.7 host shapes and fallbacks. */
  private readonly host: DshHostAdapter

  /** Deep import queue; source-dialect details stay behind its adapter seam. */
  private readonly importQueue: ImportQueue

  constructor(
    ctx: SessionServiceContext,
    private readonly manifest: ManifestStore,
    private readonly options: SessionManagementOptions = {},
  ) {
    this.host = options.host ?? createDshHostAdapter(ctx, options)
    this.projection = new SessionProjection(this.host, manifest, options)
    this.importQueue = new ImportQueue({
      manifest,
      adapters: options.imports ?? [],
      knowTool: (name) => this.host.knowTool(name),
      seed: (conversion, title) => this.host.seedImported(conversion, title),
      sessionExists: (id) => this.host.sessionExists(id),
    })
  }

  async list(filters: SessionListFilter = {}): Promise<SessionListResult> {
    return this.projection.list(filters)
  }

  async listPage(filters: SessionListFilter = {}, page: SessionPageOptions = {}): Promise<SessionPageResult> {
    return this.projection.listPage(filters, page)
  }

  async search(query: string, filters: SessionListFilter = {}): Promise<SessionListResult> {
    return this.projection.search(query, filters)
  }

  async searchPage(query: string, filters: SessionListFilter = {}, page: SessionPageOptions = {}): Promise<SessionPageResult> {
    return this.projection.searchPage(query, filters, page)
  }

  async preview(id: string): Promise<SessionPreview> {
    return this.projection.preview(id)
  }

  /** Archive one session through the official workspace registry API. */
  async archive(sessionId: string): Promise<void> {
    await this.host.archive(sessionId)
  }

  /**
   * Unarchive one session through the ADR-0001 internal channel.
   *
   * The channel is shape/version guarded: a missing or damaged internal face
   * fails loudly before any write. Repeated unarchive of an already-active
   * session is a no-op.
   */
  async unarchive(sessionId: string): Promise<void> {
    await this.host.unarchive(sessionId)
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
  async deleteSessions(sessionIds: readonly string[], options: SessionDeleteOptions = {}): Promise<SessionDeleteResult> {
    const ids = [...new Set(sanitizeSessionIds(sessionIds))]
    if (ids.length === 0) {
      throw new Error('No session ids provided for deletion')
    }
    if (options.confirmToken !== DELETE_CONFIRM_TOKEN) {
      throw new Error('Delete requires the exact token DELETE')
    }

    const attached = []
    for (const id of ids) {
      if (await this.host.attachedSession(id)) attached.push(id)
    }
    if (attached.length > 0) {
      throw new Error(`Cannot delete attached session(s): ${attached.join(', ')}`)
    }

    // One header scan supplies cwd/createdAt for locate() so planning never
    // has to re-read any session's full event log.
    const headers = new Map<string, HostSessionRecord['header']>()
    for (const raw of await this.host.listSessions()) {
      if (!isSessionRecord(raw)) continue
      const id = recordId(raw)
      if (id) headers.set(id, raw.header)
    }

    const deletions: Array<{ id: string; plan: HostDeletionPlan }> = []
    const failures: { sessionId: string; reason: string }[] = []
    for (const id of ids) {
      try {
        deletions.push({ id, plan: await this.host.planDeletion(id, headers.get(id)) })
      } catch (error) {
        failures.push({ sessionId: id, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    if (ids.length === 1 && failures.length === 1) throw new Error(failures[0].reason)
    if (deletions.length > 0) await this.manifest.assertDeleteAvailable()
    const deletedSessionIds: string[] = []
    const paths: string[] = []
    for (const { id, plan } of deletions) {
      try {
        await plan.execute()
        await this.removeManifest([id])
        deletedSessionIds.push(id)
        paths.push(plan.location.path)
      } catch (error) {
        failures.push({ sessionId: id, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return {
      deletedSessionIds,
      paths,
      ...(failures.length > 0 ? { failures } : {}),
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
    const bySource = new Map<SessionSource, { count: number; totalSizeBytes: number }>(
      SESSION_SOURCES.map((source) => [source, { count: 0, totalSizeBytes: 0 }]),
    )
    const sessions: SessionMetric[] = result.items.map(toSessionMetric)
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
          reason: `Running session is never deleted (matched: ${matchedRules.join(', ')})`,
        })
        continue
      }

      items.push({
        ...toSessionMetric(item),
        running: false,
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

    const ids = [...new Set(sanitizeSessionIds(sessionIds))]
    if (ids.length === 0) {
      return { items: [], success: 0, failed: 0 }
    }
    const previewIds = new Set(preview.sessionIds)
    const notInPreview = ids.filter((id) => !previewIds.has(id))
    if (notInPreview.length > 0) {
      throw new Error(`Cleanup selection includes sessions not in the latest preview: ${notInPreview.join(', ')}`)
    }

    try {
      const result = await this.deleteSessions(ids, { confirmToken: DELETE_CONFIRM_TOKEN })
      const failures = new Map((result.failures ?? []).map((failure) => [failure.sessionId, failure.reason]))
      const pathById = new Map(result.deletedSessionIds.map((id, index) => [id, result.paths[index]]))
      const items = ids.map((id) => {
          const reason = failures.get(id)
          if (reason) return { sessionId: id, status: 'failed' as const, reason }
          const path = pathById.get(id)
          return {
            sessionId: id,
            status: 'success' as const,
            ...(path ? { path } : {}),
          }
        })
      return {
        items,
        success: items.filter((item) => item.status === 'success').length,
        failed: items.filter((item) => item.status === 'failed').length,
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
    if (await this.projection.isRunning(sessionId)) {
      return { sessionId, resumed: false, alreadyRunning: true }
    }

    const cwd = await this.sessionCwd(sessionId)
    if (!cwd) {
      return {
        sessionId,
        resumed: false,
        alreadyRunning: false,
        reason: 'Session has no cwd and cannot be resumed safely',
      }
    }
    await this.host.resume(sessionId, cwd)
    return {
      sessionId,
      resumed: true,
      alreadyRunning: false,
      cwd,
    }
  }

  /** Resolve cwd from the header scan; only fall back to the full session read. */
  private async sessionCwd(sessionId: string): Promise<string | undefined> {
    const record = (await this.host.listSessions())
      .find((raw) => isSessionRecord(raw) && recordId(raw) === sessionId)
    return record?.header?.cwd ?? (await this.host.readSession(sessionId)).cwd
  }

  /**
   * Scan the configured (or caller-supplied) Claude Code projects directory
   * and return only unimported, non-subagent, non-empty main sessions.
   */
  async scan(source: ImportSource, root?: string): Promise<ImportScanResult> {
    return this.importQueue.scan(source, root)
  }

  async scanPage(source: ImportSource, page: ImportScanPageOptions = {}): Promise<ImportScanPageResult> {
    return this.importQueue.scanPage(source, page)
  }

  /**
   * Import one or more previously scanned Claude Code sessions through the
   * official session seed path.  Already-imported sessions are skipped; bad
   * lines are counted and do not abort the whole file.
   */
  async import(source: ImportSource, scanId: string, selections: readonly ImportSelection[]): Promise<ImportReport> {
    return this.importQueue.import(source, scanId, selections)
  }

  /** Persisted session records managed by this workspace (subagents filtered out). */
  private async managedRecords(): Promise<HostSessionRecord[]> {
    return (await this.host.listSessions()).filter(isSessionRecord)
  }

  /** Repair workspace membership for persisted imports created by older versions. */
  async repairImportedWorkspaces(): Promise<ImportReport> {
    const items: ImportReportItem[] = []
    const sources = new Map<ImportSource, Promise<ImportCandidateItem[]>>()
    const records = await this.managedRecords()
    await this.importQueue.reconcileDshSessions(records.map(recordId).filter(Boolean))
    const imported = (await mapConcurrent(records, 16, async (raw) => {
      const id = recordId(raw)
      if (!id) return undefined
      const record = await this.manifest.getByDsh(id)
      return record ? { raw, id, record } : undefined
    })).filter((entry): entry is { raw: HostSessionRecord; id: string; record: ImportRecord } => entry !== undefined)
    const titles = imported.length > 0
      ? await this.projection.titlesOf(imported.map((entry) => entry.id))
      : new Map<string, string | undefined>()
    for (const { raw, id, record } of imported) {
      try {
        await this.host.attachSession(id, raw.header?.cwd ?? (await this.host.readSession(id)).cwd)
        if (!titles.get(id)) {
          if (record.source !== 'dsh' && this.importQueue.supports(record.source) && !sources.has(record.source)) {
            sources.set(record.source, this.importQueue.inspect(record.source))
          }
          const candidates = record.source === 'dsh' || !sources.has(record.source) ? [] : await sources.get(record.source)!
          const candidate = candidates.find(item => item.sourceSessionId === record.sourceSessionId)
          if (candidate?.title) await this.host.restoreTitle(id, candidate.title)
        }
        items.push({ sourceSessionId: record.sourceSessionId, dshSessionId: id, status: 'success' })
      } catch (error) {
        items.push({ sourceSessionId: record.sourceSessionId, dshSessionId: id, status: 'failed', reason: String(error) })
      }
    }
    return { items, success: items.filter(item => item.status === 'success').length,
      failed: items.filter(item => item.status === 'failed').length, skipped: 0, reconciliationRequired: 0 }
  }

  async reconcileImports(): Promise<void> {
    const records = await this.managedRecords()
    await this.importQueue.reconcileDshSessions(records.map(recordId).filter(Boolean))
  }

  private async removeManifest(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await this.manifest.removeByDsh(id)
    }
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

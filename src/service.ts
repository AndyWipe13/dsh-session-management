/**
 * SessionManagement host service — the single test seam for read-path work.
 *
 * Issue #3 implements `list`, `search`, and `preview`.  The service is a thin
 * composition over the official read services (`sessionQuery`,
 * `sessionPersistence`, `workspaceRegistry`) plus the plugin's import
 * manifest; it deliberately contains no filesystem access so every test can
 * drive it through fakes.
 */

import type { ManifestStore, SessionSource } from './manifest.js'

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
  running: boolean
  archived: boolean
  live: boolean
  persisted: boolean
  blank: boolean
}

export interface SessionListResult {
  items: SessionListItem[]
  total: number
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

/** Minimal structural face of the official services the read path needs. */
export interface SessionServiceContext {
  sessionQuery: {
    listSessions(): Promise<readonly unknown[]>
    readSession(id: string): Promise<{ session?: unknown; header?: unknown; events?: readonly unknown[] }>
    listEvents?(id: string): Promise<readonly { type?: string; time?: number }[]>
    readTitle?(id: string): Promise<unknown>
    readTitleSnapshot?(id: string): Promise<{ title?: unknown }>
    readTitleSnapshots?(ids: readonly string[]): Promise<readonly { sessionId?: string; status?: string; value?: unknown }[]>
  }
  sessionPersistence?: {
    readRaw?(id: string): Promise<{ content?: string } | undefined>
  }
  workspaceRegistry?: {
    archivedSessionIds?: readonly string[] | Set<string>
    archiveSession?(sessionId: string): Promise<void> | void
    enqueueOperation?(operation: () => Promise<void> | void): Promise<unknown>
    requireState?(): { workspaceIds?: readonly unknown[]; archivedSessionIds?: readonly string[] } | undefined
    setState?(state: unknown): Promise<unknown> | unknown
  }
  sessions?: {
    get?(id: string): unknown
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

export class SessionManagementService {
  constructor(
    private readonly ctx: SessionServiceContext,
    private readonly manifest: ManifestStore,
  ) {}

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
    const items: SessionListItem[] = []

    for (const raw of records) {
      if (!isSessionRecord(raw)) continue
      const id = recordId(raw)
      if (!id) continue
      const header = recordHeader(raw)
      const cwd = header?.cwd

      if (filters.cwd && cwd !== filters.cwd) continue
      if (filters.workspace && !workspaceMatches(cwd, filters.workspace)) continue

      const isArchived = archived.has(id)
      if (filters.archived != null && filters.archived !== 'all' && isArchived !== filters.archived) {
        continue
      }

      const source = await this.sourceOf(id)
      if (filters.source && filters.source !== 'all' && source !== filters.source) continue

      const title = await this.titleOf(id)
      if (filters.query) {
        const q = filters.query.trim().toLowerCase()
        if (!q || !(title ?? '').toLowerCase().includes(q)) continue
      }

      const detail = await this.detailOf(id, source, isArchived, raw)
      items.push({
        id,
        title,
        source,
        cwd,
        createdAt: detail.createdAt,
        updatedAt: detail.updatedAt,
        sizeBytes: detail.sizeBytes,
        messageCount: detail.messageCount,
        running: detail.running,
        archived: isArchived,
        live: detail.live,
        persisted: detail.persisted,
        blank: detail.blank,
      })
    }

    items.sort((a, b) => b.updatedAt - a.updatedAt)
    return { items, total: items.length }
  }

  /** Title search over the unified session list, combined with the same filters. */
  async search(query: string, filters: SessionListFilter = {}): Promise<SessionListResult> {
    return this.list({ ...filters, query })
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
      const state = registry.requireState()
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
      if (!state.archivedSessionIds.includes(sessionId)) return
      await registry.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
      })
    })
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

  private async detailOf(
    id: string,
    _source: SessionSource,
    _archived: boolean,
    record: { header?: unknown; live?: boolean; persisted?: boolean; blank?: boolean },
  ): Promise<{
    createdAt: number
    updatedAt: number
    sizeBytes: number
    messageCount: number
    running: boolean
    live: boolean
    persisted: boolean
    blank: boolean
  }> {
    const header = recordHeader(record)
    const events = await this.eventsOf(id)
    const createdAt = header?.createdAt ?? 0
    const updatedAt = this.lastActiveAt(events, createdAt)
    const messageCount = events.filter((event) => event.type === 'user/message' || event.type === 'assistant/message').length
    const sizeBytes = await this.sizeOf(id, events)
    const live = record.live ?? (await this.isRunning(id))
    const running = record.live ?? live

    return {
      createdAt,
      updatedAt,
      sizeBytes,
      messageCount,
      running,
      live,
      persisted: record.persisted ?? true,
      blank: record.blank ?? events.length === 0,
    }
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

  private async isRunning(id: string): Promise<boolean> {
    const session = await this.ctx.sessions?.get?.(id)
    return Boolean(session)
  }
}

/** Convenience factory used by the plugin entry. */
export function createSessionManagementService(
  ctx: SessionServiceContext,
  manifest: ManifestStore,
): SessionManagementService {
  return new SessionManagementService(ctx, manifest)
}

/** Backward-friendly aliases matching the spec's "SessionManagement 服务" naming. */
export const SessionManagement = SessionManagementService
export const createSessionManagement = createSessionManagementService
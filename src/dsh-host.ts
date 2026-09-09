import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import type { ImportConversionResult } from './import-queue.js'
import { DshEventTypes, sessionTitleData } from './dsh-events.js'
import { normalizePathKey } from './jsonl-source.js'
import { mapConcurrent } from './async-pool.js'
import type {
  SessionArtifactDeleter,
  SessionArtifactLocation,
  SessionManagementOptions,
  SessionServiceContext,
  SessionWorkspaceLike,
} from './service.js'

export interface HostSessionRecord {
  header?: { id?: string; createdAt?: number; cwd?: string; origin?: string }
  id?: string
  live?: boolean
  persisted?: boolean
  blank?: boolean
  [key: string]: unknown
}

export interface HostSessionSnapshot {
  id?: string
  createdAt?: number
  cwd?: string
  events: readonly { type?: string; time?: number; data?: unknown }[]
}

export interface HostPersistenceHint {
  revision?: unknown
  sizeBytes?: number
}

export interface HostLiveSession {
  seq?: unknown
  append?(type: string, data: unknown): unknown
  snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly {
    type?: string
    time?: number
    data?: unknown
  }[]
}

export interface HostDeletionPlan {
  readonly location: SessionArtifactLocation
  execute(): Promise<void>
}

export interface DshHostAdapter {
  listSessions(): Promise<readonly HostSessionRecord[]>
  readSession(id: string): Promise<HostSessionSnapshot>
  canSearch(): boolean
  searchSessions(request: {
    query: string
    limit?: number
    cursor?: unknown
    sessionFilters?: readonly unknown[]
  }): Promise<{ items?: readonly unknown[]; nextCursor?: unknown }>
  archivedSessionIds(): ReadonlySet<string>
  readTitles(ids: readonly string[]): Promise<Map<string, string | undefined>>
  attachedSession(id: string): Promise<HostLiveSession | undefined>
  persistenceHints(records: readonly unknown[]): Promise<Map<string, HostPersistenceHint>>
  listEvents(id: string): Promise<readonly { type?: string; time?: number; data?: unknown }[] | undefined>
  readRaw(id: string): Promise<string | undefined>
  running(id: string, liveFallback: boolean): Promise<boolean>
  archive(id: string): Promise<void>
  unarchive(id: string): Promise<void>
  resume(id: string, cwd: string): Promise<void>
  knowTool(name: string): boolean
  attachSession(id: string, cwd: string | undefined): Promise<void>
  restoreTitle(id: string, title: string): Promise<void>
  seedImported(conversion: ImportConversionResult, title?: string): Promise<void>
  sessionExists(id: string): Promise<boolean>
  /**
   * Plan the deletion of one session. `header` (cwd/createdAt from a
   * listSessions record) lets locate resolve the artifact without reading the
   * session's event log; when absent the full read path is the fallback.
   */
  planDeletion(id: string, header?: { cwd?: string; createdAt?: number }): Promise<HostDeletionPlan>
}

const DSH_RC_VERSION = '0.1.0-rc.7'
const UNARCHIVE_CHANNEL_VERSION = 1
const THIRD_PARTY_SOURCE_SEGMENTS = new Set(['.claude', '.codex'])
const require = createRequire(import.meta.url)

function installedDshVersion(): string {
  let version: unknown
  try {
    version = (require('@deepseek-ai/dsh/package.json') as { version?: unknown }).version
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Cannot detect installed DSH version required by the rc.7 adapter: ${reason}`)
  }
  if (typeof version !== 'string' || !version) {
    throw new Error('Cannot detect installed DSH version required by the rc.7 adapter: package version is missing')
  }
  return version
}

function assertSupportedDshVersion(version: string): void {
  if (version !== DSH_RC_VERSION) {
    throw new Error(`rc.7 host adapter requires DSH ${DSH_RC_VERSION}; detected ${version}`)
  }
}

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

function requireRegistryState(registry: SessionServiceContext['workspaceRegistry']): {
  initialized: boolean
  workspaceIds: readonly string[]
  archivedSessionIds: readonly string[]
} {
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

function normalizeTitle(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') return value
  const obj = value as { title?: unknown }
  return obj.title != null ? normalizeTitle(obj.title) : undefined
}

function normalizeTitleObservation(result: unknown): string | undefined {
  if (result == null) return undefined
  const obj = result as { value?: unknown; title?: unknown }
  if (obj.title != null) return normalizeTitle(obj.title)
  return obj.value != null ? normalizeTitle(obj.value) : undefined
}

function normalizeReadSession(value: { session?: unknown; header?: unknown; events?: readonly unknown[] }): HostSessionSnapshot {
  const header = (value.session ?? value.header) as { id?: string; createdAt?: number; cwd?: string } | undefined
  return {
    id: header?.id,
    createdAt: header?.createdAt,
    cwd: header?.cwd,
    events: (value.events ?? []) as readonly { type?: string; time?: number; data?: unknown }[],
  }
}

/** Structurally, every session record is an object; subagents are filtered separately. */
export function isSessionRecord(value: unknown): value is HostSessionRecord {
  return typeof value === 'object' && value !== null
}

/** Session id from the header, falling back to the record-level id. */
export function recordId(record: HostSessionRecord): string {
  return record.header?.id ?? record.id ?? ''
}

function isProtectedThirdPartyPath(filePath: string): boolean {
  const segments = normalizePathKey(filePath).split('/').filter(Boolean)
  return segments.some((segment) => THIRD_PARTY_SOURCE_SEGMENTS.has(segment))
}

/** Compatibility adapter for the DSH rc.7 host surface. */
export class Rc7DshHostAdapter implements DshHostAdapter {
  constructor(
    private readonly ctx: SessionServiceContext,
    private readonly options: Pick<SessionManagementOptions, 'deleter' | 'sessionArtifactStat' | 'dshVersion'> = {},
  ) {}

  async listSessions(): Promise<readonly HostSessionRecord[]> {
    return await this.ctx.sessionQuery.listSessions() as readonly HostSessionRecord[]
  }

  async readSession(id: string): Promise<HostSessionSnapshot> {
    return normalizeReadSession(await this.ctx.sessionQuery.readSession(id))
  }

  canSearch(): boolean {
    return typeof this.ctx.sessionQuery.searchSessions === 'function'
  }

  async searchSessions(request: Parameters<NonNullable<SessionServiceContext['sessionQuery']['searchSessions']>>[0]): Promise<{ items?: readonly unknown[]; nextCursor?: unknown }> {
    const search = this.ctx.sessionQuery.searchSessions
    if (typeof search !== 'function') throw new Error('sessionQuery.searchSessions is unavailable')
    return search.call(this.ctx.sessionQuery, request)
  }

  archivedSessionIds(): ReadonlySet<string> {
    const raw = this.ctx.workspaceRegistry?.archivedSessionIds
    if (Array.isArray(raw)) return new Set(raw)
    return raw instanceof Set ? raw : new Set()
  }

  async readTitles(ids: readonly string[]): Promise<Map<string, string | undefined>> {
    const query = this.ctx.sessionQuery
    const titles = new Map<string, string | undefined>()
    if (ids.length === 0) return titles
    if (typeof query.readTitleSnapshots === 'function') {
      const results = await query.readTitleSnapshots(ids)
      results.forEach((result, index) => {
        const id = result.sessionId ?? (result as { id?: string }).id ?? ids[index]
        if (id) titles.set(id, normalizeTitleObservation(result))
      })
      for (const id of ids) if (!titles.has(id)) titles.set(id, undefined)
      return titles
    }
    const values = await mapConcurrent(ids, 16, async (id) => {
      if (typeof query.readTitleSnapshot === 'function') {
        return normalizeTitleObservation(await query.readTitleSnapshot(id))
      }
      return typeof query.readTitle === 'function' ? normalizeTitle(await query.readTitle(id)) : undefined
    })
    ids.forEach((id, index) => titles.set(id, values[index]))
    return titles
  }

  async attachedSession(id: string): Promise<HostLiveSession | undefined> {
    return await this.ctx.sessions?.get?.(id) as HostLiveSession | undefined
  }

  async persistenceHints(records: readonly unknown[]): Promise<Map<string, HostPersistenceHint>> {
    const hints = new Map<string, HostPersistenceHint>()
    const persistence = this.ctx.sessionPersistence
    const candidates = records
      .filter((record): record is HostSessionRecord => typeof record === 'object' && record !== null)
      .map((record) => ({ id: recordId(record), header: record.header }))
      .filter(({ id }) => id.length > 0)
    if (typeof persistence?.list === 'function') {
      for (const snapshot of await persistence.list()) {
        const id = snapshot.header?.id
        if (id) hints.set(id, { revision: snapshot.revision, sizeBytes: snapshot.sizeBytes })
      }
    }
    if (typeof persistence?.stat === 'function') {
      const snapshots = await mapConcurrent(candidates.filter(({ id }) => !hints.has(id)), 16, async ({ id }) => ({
        id,
        snapshot: await persistence.stat!(id),
      }))
      for (const { id, snapshot } of snapshots) {
        if (snapshot) hints.set(id, { revision: snapshot.revision, sizeBytes: snapshot.sizeBytes })
      }
    }
    const locate = persistence?.locate
    const statArtifact = this.options.sessionArtifactStat
    if (typeof locate === 'function' && typeof statArtifact === 'function') {
      const snapshots = await mapConcurrent(candidates.filter(({ id }) => !hints.has(id)), 16, async ({ id, header }) => {
        try {
          const location = locate.call(persistence, { id, cwd: header?.cwd, createdAt: header?.createdAt })
          if (!location?.path) return undefined
          const stat = await statArtifact(location.path)
          return { id, stat }
        } catch {
          // A disappearing artifact falls back to the uncached official read path.
          return undefined
        }
      })
      for (const entry of snapshots) {
        if (entry) hints.set(entry.id, { revision: `file:${entry.stat.sizeBytes}:${entry.stat.mtimeMs}`, sizeBytes: entry.stat.sizeBytes })
      }
    }
    return hints
  }

  async listEvents(id: string): Promise<readonly { type?: string; time?: number; data?: unknown }[] | undefined> {
    if (typeof this.ctx.sessionQuery.listEvents !== 'function') return undefined
    return await this.ctx.sessionQuery.listEvents(id) as readonly { type?: string; time?: number; data?: unknown }[]
  }

  async readRaw(id: string): Promise<string | undefined> {
    return (await this.ctx.sessionPersistence?.readRaw?.(id))?.content
  }

  async running(id: string, liveFallback: boolean): Promise<boolean> {
    if (typeof this.ctx.agents?.get !== 'function') return liveFallback
    const agent = await this.ctx.agents.get(id)
    return typeof agent === 'object' && agent !== null && (agent as { status?: unknown }).status === 'running'
  }

  async archive(id: string): Promise<void> {
    const archive = this.ctx.workspaceRegistry?.archiveSession
    if (typeof archive !== 'function') throw new Error(`workspaceRegistry.archiveSession is unavailable (DSH ${DSH_RC_VERSION})`)
    await archive.call(this.ctx.workspaceRegistry, id)
  }

  async unarchive(id: string): Promise<void> {
    this.assertPrivateChannelVersion()
    const registry = requireUnarchiveChannel(this.ctx.workspaceRegistry)
    await registry.enqueueOperation(async () => {
      const state = requireRegistryState(this.ctx.workspaceRegistry)
      if (!state.archivedSessionIds.includes(id)) return
      await registry.setState({ ...state, archivedSessionIds: state.archivedSessionIds.filter((entry) => entry !== id) })
    })
  }

  async resume(id: string, cwd: string): Promise<void> {
    const sessionsApi = this.ctx.apiProxy?.sessions
    const create = sessionsApi?.create
    if (typeof create !== 'function') throw new Error(`apiProxy.sessions.create is unavailable (DSH ${DSH_RC_VERSION})`)
    const response = await create.call(sessionsApi, {
      rpcId: `session-management-${randomUUID()}`,
      payload: { sessionId: id, cwd },
    })
    if (!response.result.ok) {
      throw new Error(`session.create failed: ${response.result.error.message}`)
    }
  }

  knowTool(name: string): boolean {
    return this.ctx.tools?.list?.().some((tool) => tool.name === name) ?? false
  }

  async attachSession(id: string, cwd: string | undefined): Promise<void> {
    const workspace = await this.workspace(cwd)
    await workspace.attachSession!(id)
  }

  async restoreTitle(id: string, title: string): Promise<void> {
    const sessions = this.ctx.sessions
    if (!sessions?.enter || !sessions.announce || !sessions.flush) throw new Error('sessions official title repair path is unavailable')
    const live = await this.attachedSession(id)
    if (live?.append) {
      live.append(DshEventTypes.sessionTitle, sessionTitleData(title))
      await sessions.flush(live)
      return
    }
    if (!this.ctx.sessionPersistence?.prepare) throw new Error('sessionPersistence.prepare is unavailable')
    const prepared = await this.ctx.sessionPersistence.prepare(id)
    let detach: (() => void) | undefined
    try {
      detach = sessions.enter(prepared.session)
      sessions.announce(prepared.session)
      prepared.session.append(DshEventTypes.sessionTitle, sessionTitleData(title))
      await sessions.flush(prepared.session)
    } finally {
      detach?.()
      prepared[Symbol.dispose]()
    }
  }

  async seedImported(conversion: ImportConversionResult, title?: string): Promise<void> {
    const sessions = this.ctx.sessions
    if (!sessions?.prepare || !sessions.enter || !sessions.announce || !sessions.flush) {
      throw new Error('sessions official seed path is unavailable (prepare/enter/announce/flush)')
    }
    const workspace = await this.workspace(conversion.header.cwd)
    const events = [...conversion.events]
    if (title?.trim()) {
      const last = events[events.length - 1]
      events.push({ seq: events.length, type: DshEventTypes.sessionTitle,
        time: last?.time ?? conversion.header.createdAt, data: sessionTitleData(title) })
    }
    const session = sessions.prepare(conversion.dshSessionId, {
      seed: events,
      meta: { cwd: conversion.header.cwd, createdAt: conversion.header.createdAt },
    })
    const detach = sessions.enter(session)
    try {
      sessions.announce(session)
      await sessions.flush(session)
      await workspace.attachSession!(conversion.dshSessionId)
    } finally {
      detach()
    }
  }

  async sessionExists(id: string): Promise<boolean> {
    if (await this.attachedSession(id)) return true
    if (typeof this.ctx.sessionPersistence?.stat === 'function' && await this.ctx.sessionPersistence.stat(id)) return true
    return (await this.listSessions()).some((record) => recordId(record) === id)
  }

  async planDeletion(id: string, header?: { cwd?: string; createdAt?: number }): Promise<HostDeletionPlan> {
    this.assertPrivateChannelVersion()
    const registry = requireUnarchiveChannel(this.ctx.workspaceRegistry)
    const state = requireRegistryState(this.ctx.workspaceRegistry)
    if (!this.options.deleter) throw new Error('Session artifact deleter is not configured')
    const location = await this.locateDeletionTarget(id, header)
    const workspaces = typeof this.ctx.workspaceRegistry?.list === 'function' ? this.ctx.workspaceRegistry.list() : []
    const matching = workspaces.filter((workspace) => workspace.sessionIds?.includes(id))
    if (matching.some((workspace) => typeof workspace.detachSession !== 'function')) {
      throw new Error('workspace entity detachSession is unavailable; cannot clean workspace registration')
    }
    if (matching.length === 0 && state.workspaceIds.length > 0 && typeof this.ctx.workspaceRegistry?.list !== 'function') {
      throw new Error('workspaceRegistry.list is unavailable; cannot clean workspace registration')
    }
    return {
      location,
      execute: async () => {
        await this.options.deleter!(location)
        await registry.enqueueOperation(async () => {
          const current = requireRegistryState(this.ctx.workspaceRegistry)
          const archivedSessionIds = current.archivedSessionIds.filter((entry) => entry !== id)
          if (archivedSessionIds.length !== current.archivedSessionIds.length) {
            await registry.setState({ ...current, archivedSessionIds })
          }
        })
        for (const workspace of matching) {
          if (workspace.sessionIds?.includes(id)) await workspace.detachSession!(id)
        }
      },
    }
  }

  private async workspace(cwd: string | undefined): Promise<SessionWorkspaceLike> {
    if (!cwd) throw new Error('会话缺少工作目录，无法导入到对应工作区')
    if (!this.ctx.workspaceRegistry?.create) throw new Error('workspaceRegistry.create is unavailable')
    const workspace = await this.ctx.workspaceRegistry.create(cwd)
    if (!workspace.attachSession) throw new Error('workspace.attachSession is unavailable')
    return workspace
  }

  private async locateDeletionTarget(id: string, header?: { cwd?: string; createdAt?: number }): Promise<SessionArtifactLocation> {
    const persistence = this.ctx.sessionPersistence
    if (typeof persistence?.locate !== 'function') throw new Error(`sessionPersistence.locate is unavailable; cannot delete session ${id}`)
    let cwd = header?.cwd
    let createdAt = header?.createdAt
    if (cwd === undefined || createdAt === undefined) {
      const snapshot = await this.readSession(id)
      cwd ??= snapshot.cwd
      createdAt ??= snapshot.createdAt
    }
    const location = persistence.locate({ id, cwd, createdAt })
    if (!location?.path) throw new Error(`Cannot resolve deletion path for session ${id}`)
    if (isProtectedThirdPartyPath(location.path)) throw new Error(`Refusing to delete third-party source file: ${location.path}`)
    return { sessionId: id, path: location.path }
  }

  private assertPrivateChannelVersion(): void {
    assertSupportedDshVersion(this.options.dshVersion ?? this.ctx.dshVersion ?? installedDshVersion())
  }

}

export function createDshHostAdapter(ctx: SessionServiceContext, options: SessionManagementOptions = {}): DshHostAdapter {
  return new Rc7DshHostAdapter(ctx, options)
}

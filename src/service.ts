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
  /** Filesystem-facing Claude reader. Defaults are supplied by the plugin entry. */
  claude?: ClaudeSourceReader
  /** Filesystem-facing Codex reader. Defaults are supplied by the plugin entry. */
  codex?: CodexSourceReader
  /** Filesystem-facing artifact deleter. Defaults are supplied by the plugin entry. */
  deleter?: SessionArtifactDeleter
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
  constructor(
    private readonly ctx: SessionServiceContext,
    private readonly manifest: ManifestStore,
    private readonly options: SessionManagementOptions = {},
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
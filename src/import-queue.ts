import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ImportRecord, ManifestStore, SessionSource } from './manifest.js'
import { normalizePathKey } from './jsonl-source.js'
import { mapConcurrent } from './async-pool.js'

export type ImportSource = Exclude<SessionSource, 'dsh'>
export type ImportRecordState = 'pending' | 'complete'

export interface ImportFileStat {
  sizeBytes: number
  mtimeMs: number
}

export interface ImportFileSummary {
  sourceSessionId: string
  cwd?: string
  projectName?: string
  title?: string
  firstUserText?: string
  createdAt: number
  updatedAt: number
  messageCount: number
  hasRealUserMessage: boolean
  isSubagent: boolean
}

export interface ImportFileScan {
  summary: ImportFileSummary
  badLines: number
}

export interface ParsedImportFile extends ImportFileScan {
  records: readonly unknown[]
}

export interface ImportConversionResult {
  dshSessionId: string
  header: { cwd?: string; createdAt: number }
  events: Array<{ type: string; seq: number; time: number; data: Record<string, any>; surfaceOp?: 'append' }>
  knownToolCalls: number
  textCardToolCalls: number
}

export interface ImportSourceAdapter {
  readonly source: ImportSource
  resolveRoot(input: string | undefined): string
  listFiles(root: string): Promise<string[]>
  read(filePath: string): Promise<ParsedImportFile>
  stat(filePath: string): Promise<ImportFileStat>
  enrichTitles?(root: string, files: readonly ImportFileScan[]): Promise<ReadonlyMap<string, string>>
  convert(records: readonly unknown[], options: { knowTool(name: string): boolean }): ImportConversionResult
}

export interface ImportCandidateItem {
  source: ImportSource
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
  importState?: 'reconciliation-required'
  dshSessionId?: string
}

export interface ImportScanResult {
  scanId: string
  items: ImportCandidateItem[]
  total: number
  badLines: number
}

export interface ImportScanPageOptions {
  root?: string
  workspace?: string
  limit?: number
  cursor?: string
  scanId?: string
}

export interface ImportScanPageResult extends ImportScanResult {
  nextCursor?: string
}

export interface ImportSelection {
  sourceSessionId: string
}

export interface ImportReportItem {
  sourceSessionId: string
  path?: string
  status: 'success' | 'skipped' | 'failed' | 'reconciliation-required'
  dshSessionId?: string
  reason?: string
  badLines?: number
}

export interface ImportReport {
  items: ImportReportItem[]
  success: number
  skipped: number
  failed: number
  reconciliationRequired: number
}

interface CachedFile {
  sizeBytes: number
  mtimeMs: number
  scan: ImportFileScan
  candidate: ImportCandidateItem | null
}

interface ImportSnapshot {
  id: string
  source: ImportSource
  root: string
  items: ImportCandidateItem[]
  files: Map<string, CachedFile>
  badLines: number
  touchedAt: number
}

export interface ImportQueueDependencies {
  manifest: ManifestStore
  adapters: readonly ImportSourceAdapter[]
  knowTool(name: string): boolean
  seed(conversion: ImportConversionResult, title?: string): Promise<void>
  sessionExists(dshSessionId: string): Promise<boolean>
  now?(): number
}

const SNAPSHOT_TTL_MS = 15 * 60 * 1000
const MAX_SNAPSHOTS = 100
const MAX_FILE_CACHE = 5000

function sameWorkspace(cwd: string | undefined, workspace: string | undefined): boolean {
  if (!workspace) return true
  if (!cwd) return false
  const left = normalizePathKey(cwd)
  const right = normalizePathKey(workspace)
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
}

function recordState(record: ImportRecord): ImportRecordState {
  return record.state === 'pending' ? 'pending' : 'complete'
}

function report(items: ImportReportItem[]): ImportReport {
  return {
    items,
    success: items.filter((item) => item.status === 'success').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
    failed: items.filter((item) => item.status === 'failed').length,
    reconciliationRequired: items.filter((item) => item.status === 'reconciliation-required').length,
  }
}

export class ImportQueue {
  private readonly adapters = new Map<ImportSource, ImportSourceAdapter>()
  private readonly fileCache = new Map<string, CachedFile>()
  private readonly snapshots = new Map<string, ImportSnapshot>()
  private readonly flights = new Map<string, Promise<ImportReportItem>>()

  constructor(private readonly dependencies: ImportQueueDependencies) {
    for (const adapter of dependencies.adapters) this.adapters.set(adapter.source, adapter)
  }

  async scan(source: ImportSource, root?: string): Promise<ImportScanResult> {
    const snapshot = await this.createSnapshot(source, root)
    return { scanId: snapshot.id, items: snapshot.items.map((item) => ({ ...item })), total: snapshot.items.length, badLines: snapshot.badLines }
  }

  async scanPage(source: ImportSource, options: ImportScanPageOptions = {}): Promise<ImportScanPageResult> {
    if (options.cursor && !options.scanId) throw new Error('scanId is required when continuing an import queue scan')
    if (options.scanId && (options.root !== undefined || options.workspace !== undefined)) {
      throw new Error('Import queue root and workspace are fixed by scanId')
    }
    const snapshot = options.scanId
      ? this.requireSnapshot(options.scanId, source)
      : await this.createSnapshot(source, options.root, options.workspace)
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)))
    const parsedOffset = Number.parseInt(options.cursor ?? '0', 10)
    const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0
    const items = snapshot.items.slice(offset, offset + limit).map((item) => ({ ...item }))
    const nextOffset = offset + items.length
    return {
      scanId: snapshot.id,
      items,
      total: snapshot.items.length,
      badLines: snapshot.badLines,
      ...(nextOffset < snapshot.items.length ? { nextCursor: String(nextOffset) } : {}),
    }
  }

  async import(source: ImportSource, scanId: string, selections: readonly ImportSelection[]): Promise<ImportReport> {
    const snapshot = this.requireSnapshot(scanId, source)
    const byId = new Map(snapshot.items.map((item) => [item.sourceSessionId, item]))
    const items: ImportReportItem[] = []
    for (const selection of selections) {
      const key = `${source}\u0000${selection.sourceSessionId}`
      let flight = this.flights.get(key)
      if (!flight) {
        flight = this.importOne(snapshot, byId.get(selection.sourceSessionId), selection)
          .catch((error) => ({
            sourceSessionId: selection.sourceSessionId,
            path: byId.get(selection.sourceSessionId)?.path,
            status: 'failed' as const,
            reason: error instanceof Error ? error.message : String(error),
          }))
        this.flights.set(key, flight)
        void flight.then(() => {
          if (this.flights.get(key) === flight) this.flights.delete(key)
        })
      }
      items.push(await flight)
    }
    return report(items)
  }

  async inspect(source: ImportSource, root?: string): Promise<ImportCandidateItem[]> {
    const snapshot = await this.createSnapshot(source, root, undefined, true)
    return snapshot.items.map((item) => ({ ...item }))
  }

  supports(source: ImportSource): boolean {
    return this.adapters.has(source)
  }

  async reconcileDshSessions(ids: readonly string[]): Promise<void> {
    await mapConcurrent(ids, 16, async (id) => {
      const record = await this.dependencies.manifest.getByDsh(id)
      if (!record) return
      await this.reconcile(record)
    })
  }

  private adapter(source: ImportSource): ImportSourceAdapter {
    const adapter = this.adapters.get(source)
    if (!adapter) throw new Error(`Import source adapter is not configured: ${source}`)
    return adapter
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }

  private requireSnapshot(scanId: string, source: ImportSource): ImportSnapshot {
    this.expireSnapshots()
    const snapshot = this.snapshots.get(scanId)
    if (!snapshot || snapshot.source !== source) throw new Error('Import queue snapshot is missing or expired; scan again')
    snapshot.touchedAt = this.now()
    return snapshot
  }

  private expireSnapshots(): void {
    const cutoff = this.now() - SNAPSHOT_TTL_MS
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.touchedAt < cutoff) this.snapshots.delete(id)
    }
  }

  private rememberSnapshot(snapshot: ImportSnapshot): void {
    this.expireSnapshots()
    while (this.snapshots.size >= MAX_SNAPSHOTS) {
      const oldest = [...this.snapshots.values()].sort((a, b) => a.touchedAt - b.touchedAt)[0]
      if (!oldest) break
      this.snapshots.delete(oldest.id)
    }
    this.snapshots.set(snapshot.id, snapshot)
  }

  private rememberFile(key: string, value: CachedFile): void {
    if (this.fileCache.size >= MAX_FILE_CACHE && !this.fileCache.has(key)) {
      const oldest = this.fileCache.keys().next().value
      if (oldest !== undefined) this.fileCache.delete(oldest)
    }
    this.fileCache.set(key, value)
  }

  private async createSnapshot(
    source: ImportSource,
    rootInput?: string,
    workspace?: string,
    includeImported = false,
  ): Promise<ImportSnapshot> {
    const adapter = this.adapter(source)
    const root = path.resolve(adapter.resolveRoot(rootInput))
    const files = await adapter.listFiles(root)
    const scannedFiles: ImportFileScan[] = []
    const cachedFiles = new Map<string, CachedFile>()

    const loaded = await mapConcurrent(files, 8, async (file) => {
      const resolved = path.resolve(file)
      const relative = path.relative(root, resolved)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Import source file escapes the scanned root: ${resolved}`)
      }
      const stat = await adapter.stat(resolved)
      const key = `${source}\u0000${resolved}`
      let cached = this.fileCache.get(key)
      if (!cached || cached.sizeBytes !== stat.sizeBytes || cached.mtimeMs !== stat.mtimeMs) {
        const parsed = await adapter.read(resolved)
        const summary = parsed.summary
        const candidate = summary.isSubagent || !summary.hasRealUserMessage ? null : {
          source,
          sourceSessionId: summary.sourceSessionId,
          path: resolved,
          title: summary.title,
          cwd: summary.cwd,
          projectName: summary.projectName,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          sizeBytes: stat.sizeBytes,
          messageCount: summary.messageCount,
          badLines: parsed.badLines,
        }
        cached = { ...stat, scan: { summary, badLines: parsed.badLines }, candidate }
        this.rememberFile(key, cached)
      }
      return { key, cached }
    })
    for (const { key, cached } of loaded) {
      scannedFiles.push(cached.scan)
      const identity = cached.candidate?.sourceSessionId ?? key
      if (!cachedFiles.has(identity)) cachedFiles.set(identity, cached)
    }

    const titles = adapter.enrichTitles ? await adapter.enrichTitles(root, scannedFiles) : undefined
    const items: ImportCandidateItem[] = []
    const seen = new Set<string>()
    for (const cached of cachedFiles.values()) {
      if (!cached.candidate || seen.has(cached.candidate.sourceSessionId)) continue
      const candidate = { ...cached.candidate }
      const title = titles?.get(candidate.sourceSessionId)
      const firstUserText = cached.scan.summary.firstUserText
      if (title && (!firstUserText || title.trim() !== firstUserText.trim())) candidate.title = title
      const existing = await this.dependencies.manifest.getBySource(source, candidate.sourceSessionId)
      if (existing) {
        const state = await this.reconcile(existing)
        if (state === 'complete' && !includeImported) continue
        if (state === 'reserved') continue
        if (state === 'reconciliation-required') {
          candidate.importState = 'reconciliation-required'
          candidate.dshSessionId = existing.dshSessionId
        }
      }
      if (!sameWorkspace(candidate.cwd, workspace)) continue
      seen.add(candidate.sourceSessionId)
      items.push(candidate)
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt)
    const snapshot: ImportSnapshot = {
      id: randomUUID(), source, root, items, files: cachedFiles,
      badLines: items.reduce((sum, item) => sum + item.badLines, 0), touchedAt: this.now(),
    }
    this.rememberSnapshot(snapshot)
    return snapshot
  }

  private async reconcile(record: ImportRecord): Promise<'complete' | 'reserved' | 'reconciliation-required' | 'cleared'> {
    const exists = await this.dependencies.sessionExists(record.dshSessionId)
    if (!exists) {
      if (recordState(record) === 'pending') {
        if (this.now() - record.importedAt < SNAPSHOT_TTL_MS) return 'reserved'
        await this.dependencies.manifest.removeBySource(record.source, record.sourceSessionId)
        return 'cleared'
      }
      return 'complete'
    }
    const reverse = await this.dependencies.manifest.getByDsh(record.dshSessionId)
    if (recordState(record) === 'complete' && reverse && recordState(reverse) === 'complete') return 'complete'
    try {
      await this.dependencies.manifest.put({ ...record, state: 'complete' })
      return 'complete'
    } catch {
      return 'reconciliation-required'
    }
  }

  private async importOne(
    snapshot: ImportSnapshot,
    candidate: ImportCandidateItem | undefined,
    selection: ImportSelection,
  ): Promise<ImportReportItem> {
    if (!candidate) return { sourceSessionId: selection.sourceSessionId, status: 'failed', reason: 'Session is not in this import queue snapshot' }
    if (candidate.importState === 'reconciliation-required') {
      return { sourceSessionId: candidate.sourceSessionId, path: candidate.path, status: 'reconciliation-required', dshSessionId: candidate.dshSessionId, reason: 'Imported session exists but its manifest requires reconciliation' }
    }
    const existing = await this.dependencies.manifest.getBySource(snapshot.source, candidate.sourceSessionId)
    if (existing) {
      const state = await this.reconcile(existing)
      if (state !== 'cleared') {
        return { sourceSessionId: candidate.sourceSessionId, path: candidate.path,
          status: state === 'reconciliation-required' ? 'reconciliation-required' : 'skipped', dshSessionId: existing.dshSessionId,
          reason: state === 'reconciliation-required'
            ? 'Imported session exists but its manifest requires reconciliation'
            : state === 'reserved' ? 'Import is already in progress' : 'Already imported' }
      }
    }
    const adapter = this.adapter(snapshot.source)
    const candidatePath = path.resolve(candidate.path)
    const relative = path.relative(snapshot.root, candidatePath)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return { sourceSessionId: candidate.sourceSessionId, path: candidatePath, status: 'failed', reason: 'Source file escapes the scanned root; scan again' }
    }
    const stat = await adapter.stat(candidatePath)
    const cached = snapshot.files.get(candidate.sourceSessionId)
    if (!cached || stat.sizeBytes !== cached.sizeBytes || stat.mtimeMs !== cached.mtimeMs) {
      return { sourceSessionId: candidate.sourceSessionId, path: candidatePath, status: 'failed', reason: 'Source file changed after scan; scan again' }
    }
    let conversion: ImportConversionResult
    let parsed: ParsedImportFile
    try {
      parsed = await adapter.read(candidatePath)
      conversion = adapter.convert(parsed.records, { knowTool: this.dependencies.knowTool })
    } catch (error) {
      return { sourceSessionId: candidate.sourceSessionId, path: candidatePath, status: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
    const pending: ImportRecord = {
      source: snapshot.source,
      sourceSessionId: candidate.sourceSessionId,
      dshSessionId: conversion.dshSessionId,
      importedAt: this.now(),
      state: 'pending',
    }
    try {
      await this.dependencies.manifest.put(pending)
    } catch (error) {
      try { await this.dependencies.manifest.removeBySource(snapshot.source, candidate.sourceSessionId) } catch {}
      return { sourceSessionId: candidate.sourceSessionId, path: candidatePath, status: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
    try {
      await this.dependencies.seed(conversion, candidate.title)
    } catch (error) {
      if (await this.dependencies.sessionExists(conversion.dshSessionId)) {
        return { sourceSessionId: candidate.sourceSessionId, path: candidatePath, status: 'reconciliation-required', dshSessionId: conversion.dshSessionId, reason: 'Session seed completed but manifest requires reconciliation', badLines: parsed.badLines }
      }
      try { await this.dependencies.manifest.removeBySource(snapshot.source, candidate.sourceSessionId) } catch {}
      return { sourceSessionId: candidate.sourceSessionId, path: candidatePath, status: 'failed', reason: error instanceof Error ? error.message : String(error), badLines: parsed.badLines }
    }
    try {
      await this.dependencies.manifest.put({ ...pending, state: 'complete' })
      return { sourceSessionId: candidate.sourceSessionId, path: candidatePath, status: 'success', dshSessionId: conversion.dshSessionId, badLines: parsed.badLines }
    } catch (error) {
      return { sourceSessionId: candidate.sourceSessionId, path: candidatePath, status: 'reconciliation-required', dshSessionId: conversion.dshSessionId, reason: error instanceof Error ? error.message : String(error), badLines: parsed.badLines }
    }
  }
}

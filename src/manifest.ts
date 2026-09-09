/**
 * import manifest storage unit for dsh-session-management.
 *
 * Issue #3 scope: the unit is created here (initially empty) and the Session
 * service uses it to reverse-lookup an imported session's `source` from its
 * DSH session id.  Writes will be added by the import slice.
 *
 * The official `storageDomain` API opens typed domains with table handles.
 * The fake harness in test/ exposes a simpler KV unit; this adapter supports
 * both shapes so service tests stay fully fake-driven.
 */

/** The closed set of session sources; every source enum/schema derives from this. */
export const SESSION_SOURCES = ['dsh', 'claude-code', 'codex'] as const

export type SessionSource = (typeof SESSION_SOURCES)[number]

export interface ImportRecord {
  source: SessionSource
  sourceSessionId: string
  dshSessionId: string
  importedAt: number
  /** Missing on legacy v1 records and therefore interpreted as complete. */
  state?: 'pending' | 'complete'
}

// Storage unit names must match /^[a-z][a-z0-9_]*$/ (dsh-storage validation):
// underscores, not hyphens.
const MANIFEST_DOMAIN = 'session_management'
const MANIFEST_VERSION = 1
const IMPORTS_TABLE = 'imports'

/**
 * Runtime record validation for the imports table.
 *
 * The storage-domain facility calls `valueSchema.parse(raw)` (zod-style,
 * throwing) on every stored record when it reopens the unit, so this schema
 * must actually validate — a passthrough that only implements `safeParse`
 * turns the first stored record into a fatal `invalid-record` load failure.
 * Extras are tolerated so older records keep loading across additive
 * changes; the four contract fields are checked strictly.
 */
const importRecordSchema = {
  parse(value: unknown): ImportRecord {
    if (typeof value !== 'object' || value === null) {
      throw new TypeError('import record must be an object')
    }
    const v = value as Record<string, unknown>
    if (!(SESSION_SOURCES as readonly unknown[]).includes(v.source)) {
      throw new TypeError(`import record source must be dsh|claude-code|codex, got ${String(v.source)}`)
    }
    for (const key of ['sourceSessionId', 'dshSessionId'] as const) {
      if (typeof v[key] !== 'string' || (v[key] as string) === '') {
        throw new TypeError(`import record ${key} must be a non-empty string`)
      }
    }
    if (typeof v.importedAt !== 'number' || !Number.isFinite(v.importedAt)) {
      throw new TypeError('import record importedAt must be a finite number')
    }
    if (v.state !== undefined && v.state !== 'pending' && v.state !== 'complete') {
      throw new TypeError(`import record state must be pending|complete, got ${String(v.state)}`)
    }
    return value as ImportRecord
  },
}

export interface ManifestStore {
  /** Reverse lookup: DSH session id -> import record (undefined = native DSH). */
  getByDsh(dshSessionId: string): Promise<ImportRecord | undefined>
  /** Forward lookup used by import/dedupe slices. */
  getBySource(source: SessionSource, sourceSessionId: string): Promise<ImportRecord | undefined>
  /** Persist the bidirectional (source, sourceSessionId) <-> dshSessionId index. */
  put(record: ImportRecord): Promise<void>
  /** Remove both index directions for a deleted imported session. */
  removeByDsh(dshSessionId: string): Promise<void>
  /** Remove both index directions when only the source identity is known. */
  removeBySource(source: SessionSource, sourceSessionId: string): Promise<void>
  /** Fail before any deletion if the manifest cannot clean imported mappings. */
  assertDeleteAvailable(): Promise<void>
  close(): Promise<void>
}

interface StorageDomainLike {
  open(spec: unknown): Promise<unknown>
}

/** A write-capable handle for the imports table/unit. */
interface ManifestTableLike {
  get(key: string): unknown
  put?(key: string, value: unknown): unknown
  set?(key: string, value: unknown): unknown
  delete?(key: string): unknown
}

/**
 * Open the plugin's own `session_management` v1 storage unit.
 *
 * The returned store is safe to use before the asynchronous open settles:
 * every method awaits the same open promise.
 */
export function openManifestStore(storageDomain: StorageDomainLike): ManifestStore {
  const opening = storageDomain.open({
    name: MANIFEST_DOMAIN,
    version: MANIFEST_VERSION,
    tables: {
      [IMPORTS_TABLE]: { valueSchema: importRecordSchema },
    },
  })

  async function resolveTable(): Promise<ManifestTableLike> {
    const domain = await opening
    const maybeDomain = domain as {
      table?: (name: string) => ManifestTableLike
      get?: (key: string) => unknown
      put?: (key: string, value: unknown) => unknown
      set?: (key: string, value: unknown) => unknown
      delete?: (key: string) => unknown
    }
    if (typeof maybeDomain.table === 'function') {
      return maybeDomain.table(IMPORTS_TABLE)
    }
    const table: ManifestTableLike = {
      get: (key: string) => maybeDomain.get?.(key),
    }
    if (typeof maybeDomain.put === 'function') {
      table.put = (key: string, value: unknown) => maybeDomain.put!(key, value)
    }
    if (typeof maybeDomain.set === 'function') {
      table.set = (key: string, value: unknown) => maybeDomain.set!(key, value)
    }
    if (typeof maybeDomain.delete === 'function') {
      table.delete = (key: string) => maybeDomain.delete!(key)
    }
    return table
  }

  async function read(key: string): Promise<unknown> {
    const table = await resolveTable()
    return await table.get(key)
  }

  async function write(key: string, value: unknown): Promise<void> {
    const table = await resolveTable()
    const writeHandle = table.put ?? table.set
    if (typeof writeHandle !== 'function') {
      throw new Error('manifest storage unit does not expose a write handle')
    }
    await writeHandle.call(table, key, value)
  }

  async function remove(key: string): Promise<void> {
    const table = await resolveTable()
    if (typeof table.delete !== 'function') {
      throw new Error('manifest storage unit does not expose a delete handle')
    }
    await table.delete(key)
  }

  async function assertDeleteAvailable(): Promise<void> {
    const table = await resolveTable()
    if (typeof table.delete !== 'function') {
      throw new Error('manifest storage unit does not expose a delete handle')
    }
  }

  return {
    async getByDsh(dshSessionId: string): Promise<ImportRecord | undefined> {
      return (await read(`dsh:${dshSessionId}`)) as ImportRecord | undefined
    },
    async getBySource(source: SessionSource, sourceSessionId: string): Promise<ImportRecord | undefined> {
      return (await read(`source:${source}:${sourceSessionId}`)) as ImportRecord | undefined
    },
    async put(record: ImportRecord): Promise<void> {
      await write(`source:${record.source}:${record.sourceSessionId}`, record)
      await write(`dsh:${record.dshSessionId}`, record)
    },
    async removeByDsh(dshSessionId: string): Promise<void> {
      const record = (await read(`dsh:${dshSessionId}`)) as ImportRecord | undefined
      if (!record) return
      await remove(`dsh:${dshSessionId}`)
      await remove(`source:${record.source}:${record.sourceSessionId}`)
    },
    async removeBySource(source: SessionSource, sourceSessionId: string): Promise<void> {
      const sourceKey = `source:${source}:${sourceSessionId}`
      const record = (await read(sourceKey)) as ImportRecord | undefined
      if (!record) return
      await remove(`dsh:${record.dshSessionId}`)
      await remove(sourceKey)
    },
    async assertDeleteAvailable(): Promise<void> {
      await assertDeleteAvailable()
    },
    async close(): Promise<void> {
      const domain = (await opening) as { close?: () => Promise<void> }
      if (typeof domain.close === 'function') {
        await domain.close()
      }
    },
  }
}

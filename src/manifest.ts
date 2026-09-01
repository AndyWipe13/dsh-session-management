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

export type SessionSource = 'dsh' | 'claude-code' | 'codex'

export interface ImportRecord {
  source: SessionSource
  sourceSessionId: string
  dshSessionId: string
  importedAt: number
}

const MANIFEST_DOMAIN = 'session-management'
const MANIFEST_VERSION = 1
const IMPORTS_TABLE = 'imports'

/** Minimal schema-like object satisfying storage-domain's runtime `safeParse` use. */
const passthroughSchema = {
  safeParse: (value: unknown) => ({ success: true, data: value }),
} as never

export interface ManifestStore {
  /** Reverse lookup: DSH session id -> import record (undefined = native DSH). */
  getByDsh(dshSessionId: string): Promise<ImportRecord | undefined>
  /** Forward lookup used by import/dedupe slices. */
  getBySource(source: SessionSource, sourceSessionId: string): Promise<ImportRecord | undefined>
  /** Persist the bidirectional (source, sourceSessionId) <-> dshSessionId index. */
  put(record: ImportRecord): Promise<void>
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
}

/**
 * Open the plugin's own `session-management` v1 storage unit.
 *
 * The returned store is safe to use before the asynchronous open settles:
 * every method awaits the same open promise.
 */
export function openManifestStore(storageDomain: StorageDomainLike): ManifestStore {
  const opening = storageDomain.open({
    name: MANIFEST_DOMAIN,
    version: MANIFEST_VERSION,
    tables: {
      [IMPORTS_TABLE]: { valueSchema: passthroughSchema },
    },
  })

  async function resolveTable(): Promise<ManifestTableLike> {
    const domain = await opening
    const maybeDomain = domain as {
      table?: (name: string) => ManifestTableLike
      get?: (key: string) => unknown
      put?: (key: string, value: unknown) => unknown
      set?: (key: string, value: unknown) => unknown
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
    return table
  }

  async function read(key: string): Promise<unknown> {
    const table = await resolveTable()
    const value = table.get(key)
    return value instanceof Promise ? await value : value
  }

  async function write(key: string, value: unknown): Promise<void> {
    const table = await resolveTable()
    if (typeof table.put === 'function') {
      const result = table.put(key, value)
      if (result instanceof Promise) await result
      return
    }
    if (typeof table.set === 'function') {
      const result = table.set(key, value)
      if (result instanceof Promise) await result
      return
    }
    throw new Error('manifest storage unit does not expose a write handle')
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
    async close(): Promise<void> {
      const domain = (await opening) as { close?: () => Promise<void> }
      if (typeof domain.close === 'function') {
        await domain.close()
      }
    },
  }
}
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
export type SessionSource = 'dsh' | 'claude-code' | 'codex';
export interface ImportRecord {
    source: SessionSource;
    sourceSessionId: string;
    dshSessionId: string;
    importedAt: number;
}
export interface ManifestStore {
    /** Reverse lookup: DSH session id -> import record (undefined = native DSH). */
    getByDsh(dshSessionId: string): Promise<ImportRecord | undefined>;
    /** Forward lookup used by import/dedupe slices. */
    getBySource(source: SessionSource, sourceSessionId: string): Promise<ImportRecord | undefined>;
    /** Persist the bidirectional (source, sourceSessionId) <-> dshSessionId index. */
    put(record: ImportRecord): Promise<void>;
    /** Remove both index directions for a deleted imported session. */
    removeByDsh(dshSessionId: string): Promise<void>;
    /** Fail before any deletion if the manifest cannot clean imported mappings. */
    assertDeleteAvailable(): Promise<void>;
    close(): Promise<void>;
}
interface StorageDomainLike {
    open(spec: unknown): Promise<unknown>;
}
/**
 * Open the plugin's own `session-management` v1 storage unit.
 *
 * The returned store is safe to use before the asynchronous open settles:
 * every method awaits the same open promise.
 */
export declare function openManifestStore(storageDomain: StorageDomainLike): ManifestStore;
export {};

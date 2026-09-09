import type { ImportConversionResult } from './import-queue.js';
import type { SessionArtifactLocation, SessionManagementOptions, SessionServiceContext } from './service.js';
export interface HostSessionRecord {
    header?: {
        id?: string;
        createdAt?: number;
        cwd?: string;
        origin?: string;
    };
    id?: string;
    live?: boolean;
    persisted?: boolean;
    blank?: boolean;
    [key: string]: unknown;
}
export interface HostSessionSnapshot {
    id?: string;
    createdAt?: number;
    cwd?: string;
    events: readonly {
        type?: string;
        time?: number;
        data?: unknown;
    }[];
}
export interface HostPersistenceHint {
    revision?: unknown;
    sizeBytes?: number;
}
export interface HostLiveSession {
    seq?: unknown;
    append?(type: string, data: unknown): unknown;
    snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly {
        type?: string;
        time?: number;
        data?: unknown;
    }[];
}
export interface HostDeletionPlan {
    readonly location: SessionArtifactLocation;
    execute(): Promise<void>;
}
export interface DshHostAdapter {
    listSessions(): Promise<readonly HostSessionRecord[]>;
    readSession(id: string): Promise<HostSessionSnapshot>;
    canSearch(): boolean;
    searchSessions(request: {
        query: string;
        limit?: number;
        cursor?: unknown;
        sessionFilters?: readonly unknown[];
    }): Promise<{
        items?: readonly unknown[];
        nextCursor?: unknown;
    }>;
    archivedSessionIds(): ReadonlySet<string>;
    readTitles(ids: readonly string[]): Promise<Map<string, string | undefined>>;
    attachedSession(id: string): Promise<HostLiveSession | undefined>;
    persistenceHints(records: readonly unknown[]): Promise<Map<string, HostPersistenceHint>>;
    listEvents(id: string): Promise<readonly {
        type?: string;
        time?: number;
        data?: unknown;
    }[] | undefined>;
    readRaw(id: string): Promise<string | undefined>;
    running(id: string, liveFallback: boolean): Promise<boolean>;
    archive(id: string): Promise<void>;
    unarchive(id: string): Promise<void>;
    resume(id: string, cwd: string): Promise<void>;
    knowTool(name: string): boolean;
    attachSession(id: string, cwd: string | undefined): Promise<void>;
    restoreTitle(id: string, title: string): Promise<void>;
    seedImported(conversion: ImportConversionResult, title?: string): Promise<void>;
    sessionExists(id: string): Promise<boolean>;
    /**
     * Plan the deletion of one session. `header` (cwd/createdAt from a
     * listSessions record) lets locate resolve the artifact without reading the
     * session's event log; when absent the full read path is the fallback.
     */
    planDeletion(id: string, header?: {
        cwd?: string;
        createdAt?: number;
    }): Promise<HostDeletionPlan>;
}
/** Structurally, every session record is an object; subagents are filtered separately. */
export declare function isSessionRecord(value: unknown): value is HostSessionRecord;
/** Session id from the header, falling back to the record-level id. */
export declare function recordId(record: HostSessionRecord): string;
/** Compatibility adapter for the DSH rc.7 host surface. */
export declare class Rc7DshHostAdapter implements DshHostAdapter {
    private readonly ctx;
    private readonly options;
    constructor(ctx: SessionServiceContext, options?: Pick<SessionManagementOptions, 'deleter' | 'sessionArtifactStat' | 'dshVersion'>);
    listSessions(): Promise<readonly HostSessionRecord[]>;
    readSession(id: string): Promise<HostSessionSnapshot>;
    canSearch(): boolean;
    searchSessions(request: Parameters<NonNullable<SessionServiceContext['sessionQuery']['searchSessions']>>[0]): Promise<{
        items?: readonly unknown[];
        nextCursor?: unknown;
    }>;
    archivedSessionIds(): ReadonlySet<string>;
    readTitles(ids: readonly string[]): Promise<Map<string, string | undefined>>;
    attachedSession(id: string): Promise<HostLiveSession | undefined>;
    persistenceHints(records: readonly unknown[]): Promise<Map<string, HostPersistenceHint>>;
    listEvents(id: string): Promise<readonly {
        type?: string;
        time?: number;
        data?: unknown;
    }[] | undefined>;
    readRaw(id: string): Promise<string | undefined>;
    running(id: string, liveFallback: boolean): Promise<boolean>;
    archive(id: string): Promise<void>;
    unarchive(id: string): Promise<void>;
    resume(id: string, cwd: string): Promise<void>;
    knowTool(name: string): boolean;
    attachSession(id: string, cwd: string | undefined): Promise<void>;
    restoreTitle(id: string, title: string): Promise<void>;
    seedImported(conversion: ImportConversionResult, title?: string): Promise<void>;
    sessionExists(id: string): Promise<boolean>;
    planDeletion(id: string, header?: {
        cwd?: string;
        createdAt?: number;
    }): Promise<HostDeletionPlan>;
    private workspace;
    private locateDeletionTarget;
    private assertPrivateChannelVersion;
}
export declare function createDshHostAdapter(ctx: SessionServiceContext, options?: SessionManagementOptions): DshHostAdapter;

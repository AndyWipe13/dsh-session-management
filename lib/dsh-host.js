import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { DshEventTypes, sessionTitleData } from './dsh-events.js';
import { normalizePathKey } from './jsonl-source.js';
import { mapConcurrent } from './async-pool.js';
const DSH_RC_VERSION = '0.1.0-rc.7';
const UNARCHIVE_CHANNEL_VERSION = 1;
const THIRD_PARTY_SOURCE_SEGMENTS = new Set(['.claude', '.codex']);
const require = createRequire(import.meta.url);
function installedDshVersion() {
    let version;
    try {
        version = require('@deepseek-ai/dsh/package.json').version;
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot detect installed DSH version required by the rc.7 adapter: ${reason}`);
    }
    if (typeof version !== 'string' || !version) {
        throw new Error('Cannot detect installed DSH version required by the rc.7 adapter: package version is missing');
    }
    return version;
}
function assertSupportedDshVersion(version) {
    if (version !== DSH_RC_VERSION) {
        throw new Error(`rc.7 host adapter requires DSH ${DSH_RC_VERSION}; detected ${version}`);
    }
}
function requireUnarchiveChannel(registry) {
    if (!registry || typeof registry.enqueueOperation !== 'function' || typeof registry.requireState !== 'function' || typeof registry.setState !== 'function') {
        throw new Error(`workspaceRegistry.unarchive internal channel is unavailable: expected enqueueOperation/requireState/setState ` +
            `(DSH ${DSH_RC_VERSION}, channel v${UNARCHIVE_CHANNEL_VERSION})`);
    }
    return registry;
}
function requireRegistryState(registry) {
    const channel = requireUnarchiveChannel(registry);
    const state = channel.requireState();
    if (!state ||
        typeof state.initialized !== 'boolean' ||
        !Array.isArray(state.archivedSessionIds) ||
        state.archivedSessionIds.some((id) => typeof id !== 'string') ||
        !Array.isArray(state.workspaceIds) ||
        state.workspaceIds.some((id) => typeof id !== 'string')) {
        throw new Error(`workspaceRegistry unarchive internal channel state is invalid: expected initialized boolean, workspaceIds string[], archivedSessionIds string[] ` +
            `(DSH ${DSH_RC_VERSION}, channel v${UNARCHIVE_CHANNEL_VERSION})`);
    }
    return {
        initialized: state.initialized,
        workspaceIds: state.workspaceIds,
        archivedSessionIds: state.archivedSessionIds,
    };
}
function normalizeTitle(value) {
    if (value == null)
        return undefined;
    if (typeof value === 'string')
        return value;
    const obj = value;
    return obj.title != null ? normalizeTitle(obj.title) : undefined;
}
function normalizeTitleObservation(result) {
    if (result == null)
        return undefined;
    const obj = result;
    if (obj.title != null)
        return normalizeTitle(obj.title);
    return obj.value != null ? normalizeTitle(obj.value) : undefined;
}
function normalizeReadSession(value) {
    const header = (value.session ?? value.header);
    return {
        id: header?.id,
        createdAt: header?.createdAt,
        cwd: header?.cwd,
        events: (value.events ?? []),
    };
}
/** Structurally, every session record is an object; subagents are filtered separately. */
export function isSessionRecord(value) {
    return typeof value === 'object' && value !== null;
}
/** Session id from the header, falling back to the record-level id. */
export function recordId(record) {
    return record.header?.id ?? record.id ?? '';
}
function isProtectedThirdPartyPath(filePath) {
    const segments = normalizePathKey(filePath).split('/').filter(Boolean);
    return segments.some((segment) => THIRD_PARTY_SOURCE_SEGMENTS.has(segment));
}
/** Compatibility adapter for the DSH rc.7 host surface. */
export class Rc7DshHostAdapter {
    ctx;
    options;
    constructor(ctx, options = {}) {
        this.ctx = ctx;
        this.options = options;
    }
    async listSessions() {
        return await this.ctx.sessionQuery.listSessions();
    }
    async readSession(id) {
        return normalizeReadSession(await this.ctx.sessionQuery.readSession(id));
    }
    canSearch() {
        return typeof this.ctx.sessionQuery.searchSessions === 'function';
    }
    async searchSessions(request) {
        const search = this.ctx.sessionQuery.searchSessions;
        if (typeof search !== 'function')
            throw new Error('sessionQuery.searchSessions is unavailable');
        return search.call(this.ctx.sessionQuery, request);
    }
    archivedSessionIds() {
        const raw = this.ctx.workspaceRegistry?.archivedSessionIds;
        if (Array.isArray(raw))
            return new Set(raw);
        return raw instanceof Set ? raw : new Set();
    }
    async readTitles(ids) {
        const query = this.ctx.sessionQuery;
        const titles = new Map();
        if (ids.length === 0)
            return titles;
        if (typeof query.readTitleSnapshots === 'function') {
            const results = await query.readTitleSnapshots(ids);
            results.forEach((result, index) => {
                const id = result.sessionId ?? result.id ?? ids[index];
                if (id)
                    titles.set(id, normalizeTitleObservation(result));
            });
            for (const id of ids)
                if (!titles.has(id))
                    titles.set(id, undefined);
            return titles;
        }
        const values = await mapConcurrent(ids, 16, async (id) => {
            if (typeof query.readTitleSnapshot === 'function') {
                return normalizeTitleObservation(await query.readTitleSnapshot(id));
            }
            return typeof query.readTitle === 'function' ? normalizeTitle(await query.readTitle(id)) : undefined;
        });
        ids.forEach((id, index) => titles.set(id, values[index]));
        return titles;
    }
    async attachedSession(id) {
        return await this.ctx.sessions?.get?.(id);
    }
    async persistenceHints(records) {
        const hints = new Map();
        const persistence = this.ctx.sessionPersistence;
        const candidates = records
            .filter((record) => typeof record === 'object' && record !== null)
            .map((record) => ({ id: recordId(record), header: record.header }))
            .filter(({ id }) => id.length > 0);
        if (typeof persistence?.list === 'function') {
            for (const snapshot of await persistence.list()) {
                const id = snapshot.header?.id;
                if (id)
                    hints.set(id, { revision: snapshot.revision, sizeBytes: snapshot.sizeBytes });
            }
        }
        if (typeof persistence?.stat === 'function') {
            const snapshots = await mapConcurrent(candidates.filter(({ id }) => !hints.has(id)), 16, async ({ id }) => ({
                id,
                snapshot: await persistence.stat(id),
            }));
            for (const { id, snapshot } of snapshots) {
                if (snapshot)
                    hints.set(id, { revision: snapshot.revision, sizeBytes: snapshot.sizeBytes });
            }
        }
        const locate = persistence?.locate;
        const statArtifact = this.options.sessionArtifactStat;
        if (typeof locate === 'function' && typeof statArtifact === 'function') {
            const snapshots = await mapConcurrent(candidates.filter(({ id }) => !hints.has(id)), 16, async ({ id, header }) => {
                try {
                    const location = locate.call(persistence, { id, cwd: header?.cwd, createdAt: header?.createdAt });
                    if (!location?.path)
                        return undefined;
                    const stat = await statArtifact(location.path);
                    return { id, stat };
                }
                catch {
                    // A disappearing artifact falls back to the uncached official read path.
                    return undefined;
                }
            });
            for (const entry of snapshots) {
                if (entry)
                    hints.set(entry.id, { revision: `file:${entry.stat.sizeBytes}:${entry.stat.mtimeMs}`, sizeBytes: entry.stat.sizeBytes });
            }
        }
        return hints;
    }
    async listEvents(id) {
        if (typeof this.ctx.sessionQuery.listEvents !== 'function')
            return undefined;
        return await this.ctx.sessionQuery.listEvents(id);
    }
    async readRaw(id) {
        return (await this.ctx.sessionPersistence?.readRaw?.(id))?.content;
    }
    async running(id, liveFallback) {
        if (typeof this.ctx.agents?.get !== 'function')
            return liveFallback;
        const agent = await this.ctx.agents.get(id);
        return typeof agent === 'object' && agent !== null && agent.status === 'running';
    }
    async archive(id) {
        const archive = this.ctx.workspaceRegistry?.archiveSession;
        if (typeof archive !== 'function')
            throw new Error(`workspaceRegistry.archiveSession is unavailable (DSH ${DSH_RC_VERSION})`);
        await archive.call(this.ctx.workspaceRegistry, id);
    }
    async unarchive(id) {
        this.assertPrivateChannelVersion();
        const registry = requireUnarchiveChannel(this.ctx.workspaceRegistry);
        await registry.enqueueOperation(async () => {
            const state = requireRegistryState(this.ctx.workspaceRegistry);
            if (!state.archivedSessionIds.includes(id))
                return;
            await registry.setState({ ...state, archivedSessionIds: state.archivedSessionIds.filter((entry) => entry !== id) });
        });
    }
    async resume(id, cwd) {
        const sessionsApi = this.ctx.apiProxy?.sessions;
        const create = sessionsApi?.create;
        if (typeof create !== 'function')
            throw new Error(`apiProxy.sessions.create is unavailable (DSH ${DSH_RC_VERSION})`);
        const response = await create.call(sessionsApi, {
            rpcId: `session-management-${randomUUID()}`,
            payload: { sessionId: id, cwd },
        });
        if (!response.result.ok) {
            throw new Error(`session.create failed: ${response.result.error.message}`);
        }
    }
    knowTool(name) {
        return this.ctx.tools?.list?.().some((tool) => tool.name === name) ?? false;
    }
    async attachSession(id, cwd) {
        const workspace = await this.workspace(cwd);
        await workspace.attachSession(id);
    }
    async restoreTitle(id, title) {
        const sessions = this.ctx.sessions;
        if (!sessions?.enter || !sessions.announce || !sessions.flush)
            throw new Error('sessions official title repair path is unavailable');
        const live = await this.attachedSession(id);
        if (live?.append) {
            live.append(DshEventTypes.sessionTitle, sessionTitleData(title));
            await sessions.flush(live);
            return;
        }
        if (!this.ctx.sessionPersistence?.prepare)
            throw new Error('sessionPersistence.prepare is unavailable');
        const prepared = await this.ctx.sessionPersistence.prepare(id);
        let detach;
        try {
            detach = sessions.enter(prepared.session);
            sessions.announce(prepared.session);
            prepared.session.append(DshEventTypes.sessionTitle, sessionTitleData(title));
            await sessions.flush(prepared.session);
        }
        finally {
            detach?.();
            prepared[Symbol.dispose]();
        }
    }
    async seedImported(conversion, title) {
        const sessions = this.ctx.sessions;
        if (!sessions?.prepare || !sessions.enter || !sessions.announce || !sessions.flush) {
            throw new Error('sessions official seed path is unavailable (prepare/enter/announce/flush)');
        }
        const workspace = await this.workspace(conversion.header.cwd);
        const events = [...conversion.events];
        if (title?.trim()) {
            const last = events[events.length - 1];
            events.push({ seq: events.length, type: DshEventTypes.sessionTitle,
                time: last?.time ?? conversion.header.createdAt, data: sessionTitleData(title) });
        }
        const session = sessions.prepare(conversion.dshSessionId, {
            seed: events,
            meta: { cwd: conversion.header.cwd, createdAt: conversion.header.createdAt },
        });
        const detach = sessions.enter(session);
        try {
            sessions.announce(session);
            await sessions.flush(session);
            await workspace.attachSession(conversion.dshSessionId);
        }
        finally {
            detach();
        }
    }
    async sessionExists(id) {
        if (await this.attachedSession(id))
            return true;
        if (typeof this.ctx.sessionPersistence?.stat === 'function' && await this.ctx.sessionPersistence.stat(id))
            return true;
        return (await this.listSessions()).some((record) => recordId(record) === id);
    }
    async planDeletion(id, header) {
        this.assertPrivateChannelVersion();
        const registry = requireUnarchiveChannel(this.ctx.workspaceRegistry);
        const state = requireRegistryState(this.ctx.workspaceRegistry);
        if (!this.options.deleter)
            throw new Error('Session artifact deleter is not configured');
        const location = await this.locateDeletionTarget(id, header);
        const workspaces = typeof this.ctx.workspaceRegistry?.list === 'function' ? this.ctx.workspaceRegistry.list() : [];
        const matching = workspaces.filter((workspace) => workspace.sessionIds?.includes(id));
        if (matching.some((workspace) => typeof workspace.detachSession !== 'function')) {
            throw new Error('workspace entity detachSession is unavailable; cannot clean workspace registration');
        }
        if (matching.length === 0 && state.workspaceIds.length > 0 && typeof this.ctx.workspaceRegistry?.list !== 'function') {
            throw new Error('workspaceRegistry.list is unavailable; cannot clean workspace registration');
        }
        return {
            location,
            execute: async () => {
                await this.options.deleter(location);
                await registry.enqueueOperation(async () => {
                    const current = requireRegistryState(this.ctx.workspaceRegistry);
                    const archivedSessionIds = current.archivedSessionIds.filter((entry) => entry !== id);
                    if (archivedSessionIds.length !== current.archivedSessionIds.length) {
                        await registry.setState({ ...current, archivedSessionIds });
                    }
                });
                for (const workspace of matching) {
                    if (workspace.sessionIds?.includes(id))
                        await workspace.detachSession(id);
                }
            },
        };
    }
    async workspace(cwd) {
        if (!cwd)
            throw new Error('会话缺少工作目录，无法导入到对应工作区');
        if (!this.ctx.workspaceRegistry?.create)
            throw new Error('workspaceRegistry.create is unavailable');
        const workspace = await this.ctx.workspaceRegistry.create(cwd);
        if (!workspace.attachSession)
            throw new Error('workspace.attachSession is unavailable');
        return workspace;
    }
    async locateDeletionTarget(id, header) {
        const persistence = this.ctx.sessionPersistence;
        if (typeof persistence?.locate !== 'function')
            throw new Error(`sessionPersistence.locate is unavailable; cannot delete session ${id}`);
        let cwd = header?.cwd;
        let createdAt = header?.createdAt;
        if (cwd === undefined || createdAt === undefined) {
            const snapshot = await this.readSession(id);
            cwd ??= snapshot.cwd;
            createdAt ??= snapshot.createdAt;
        }
        const location = persistence.locate({ id, cwd, createdAt });
        if (!location?.path)
            throw new Error(`Cannot resolve deletion path for session ${id}`);
        if (isProtectedThirdPartyPath(location.path))
            throw new Error(`Refusing to delete third-party source file: ${location.path}`);
        return { sessionId: id, path: location.path };
    }
    assertPrivateChannelVersion() {
        assertSupportedDshVersion(this.options.dshVersion ?? this.ctx.dshVersion ?? installedDshVersion());
    }
}
export function createDshHostAdapter(ctx, options = {}) {
    return new Rc7DshHostAdapter(ctx, options);
}
//# sourceMappingURL=dsh-host.js.map
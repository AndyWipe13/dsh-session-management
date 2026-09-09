/**
 * Minimal fake official services for dsh-session-management tests.
 *
 * All fakes are intentionally dumb records so tests can assert observable
 * calls without depending on DSH internals. The `setupSessionService`,
 * `seedSessions`, `stubTitleSnapshots`, and `fakeImportAdapter` helpers build
 * on these fakes so every test file drives the same seams the same way.
 */

import { openManifestStore } from '../../lib/manifest.js'
import { createSessionManagementService } from '../../lib/service.js'

/** The official service faces the harness must expose. */
export const OFFICIAL_SERVICES = [
  'sessions',
  'agents',
  'apiProxy',
  'sessionQuery',
  'sessionPersistence',
  'workspaceRegistry',
  'storageDomain',
  'webServer',
]

/** Create a fake Cordis-like context with the official service faces. */
export function createFakeContext(overrides = {}) {
  const calls = {
    sessions: [],
    agents: [],
    apiProxy: [],
    sessionQuery: [],
    sessionPersistence: [],
    workspaceRegistry: [],
    storageDomain: [],
    tools: [],
    webServer: [],
  }

  const disposers = []
  const registeredTools = []
  const registeredRoutes = []
  const registeredEvents = new Map()

  const tools = {
    register(tool) {
      registeredTools.push(tool)
      calls.tools.push({ op: 'register', name: tool.name })
      return () => {
        const index = registeredTools.indexOf(tool)
        if (index >= 0) registeredTools.splice(index, 1)
      }
    },
    list() {
      return registeredTools.slice()
    },
  }

  const webServer = {
    register(route) {
      registeredRoutes.push(route)
      calls.webServer.push({ op: 'register', path: route.path, kind: route.kind })
      return () => {
        const index = registeredRoutes.indexOf(route)
        if (index >= 0) registeredRoutes.splice(index, 1)
      }
    },
    list() {
      return registeredRoutes.slice()
    },
  }

  const sessions = {
    create: async (...args) => {
      calls.sessions.push({ op: 'create', args })
      return { id: 'session-fake', events: [], header: { id: 'session-fake' } }
    },
    prepare: (...args) => {
      calls.sessions.push({ op: 'prepare', args })
      return { id: 'session-fake', header: { id: 'session-fake' } }
    },
    enter: (session) => {
      calls.sessions.push({ op: 'enter', args: [session] })
      return () => {
        calls.sessions.push({ op: 'enter-dispose', args: [session] })
      }
    },
    announce: (session) => {
      calls.sessions.push({ op: 'announce', args: [session] })
    },
    get: async (id) => {
      calls.sessions.push({ op: 'get', args: [id] })
      return undefined
    },
    list: async () => {
      calls.sessions.push({ op: 'list' })
      return []
    },
    flush: async () => true,
    fork: () => {
      throw new Error('fake fork not implemented')
    },
  }

  const agents = {
    resume: async (options) => {
      calls.agents.push({ op: 'resume', args: [options] })
      return { agent: { id: options.resumeSessionId } }
    },
  }

  const apiProxy = {
    sessions: {
      create: async (request) => {
        calls.apiProxy.push({ op: 'session.create', args: [request] })
        await agents.resume({ resumeSessionId: request.payload.sessionId })
        return { rpcId: request.rpcId, result: { ok: true, value: { sessionId: request.payload.sessionId } } }
      },
    },
  }

  const sessionQuery = {
    listSessions: async () => {
      calls.sessionQuery.push({ op: 'listSessions' })
      return []
    },
    filterSessions: async (filters) => {
      calls.sessionQuery.push({ op: 'filterSessions', args: [filters] })
      return []
    },
    searchSessions: async (request) => {
      calls.sessionQuery.push({ op: 'searchSessions', args: [request] })
      return { items: [], nextCursor: undefined }
    },
    readSession: async (id) => {
      calls.sessionQuery.push({ op: 'readSession', args: [id] })
      return { header: { id }, events: [] }
    },
    readTitle: async (id) => {
      calls.sessionQuery.push({ op: 'readTitle', args: [id] })
      return undefined
    },
    readTitleSnapshot: async (id) => {
      calls.sessionQuery.push({ op: 'readTitleSnapshot', args: [id] })
      return { header: { id }, title: undefined }
    },
    readTitleSnapshots: async (ids) => {
      calls.sessionQuery.push({ op: 'readTitleSnapshots', args: [ids] })
      return ids.map((id) => ({ id, ok: true, value: undefined }))
    },
    listEvents: async (id) => {
      calls.sessionQuery.push({ op: 'listEvents', args: [id] })
      return []
    },
    filterEvents: async (id, filters) => {
      calls.sessionQuery.push({ op: 'filterEvents', args: [id, filters] })
      return []
    },
    searchEvents: async (request) => {
      calls.sessionQuery.push({ op: 'searchEvents', args: [request] })
      return { items: [], nextCursor: undefined }
    },
    readSurface: async (id) => {
      calls.sessionQuery.push({ op: 'readSurface', args: [id] })
      return { header: { id }, surface: [], lastSeq: 0 }
    },
    traceSession: async (id) => {
      calls.sessionQuery.push({ op: 'traceSession', args: [id] })
      return { id, parents: [], children: [] }
    },
    traceEvent: async (request) => {
      calls.sessionQuery.push({ op: 'traceEvent', args: [request] })
      return { header: { id: request.sessionId }, links: [] }
    },
    readEvent: async (request) => {
      calls.sessionQuery.push({ op: 'readEvent', args: [request] })
      return { target: undefined, before: [], after: [] }
    },
  }

  const sessionPersistence = {
    supportsRawArtifacts: true,
    locate: (meta) => {
      calls.sessionPersistence.push({ op: 'locate', args: [meta] })
      return { kind: 'jsonl', path: `C:\\fake\\sessions\\${meta.id ?? 'unknown'}\\session.jsonl` }
    },
    create: async (meta) => {
      calls.sessionPersistence.push({ op: 'create', args: [meta] })
    },
    append: async (id, events) => {
      calls.sessionPersistence.push({ op: 'append', args: [id, events] })
    },
    load: async (id) => {
      calls.sessionPersistence.push({ op: 'load', args: [id] })
      return { meta: { id }, events: [] }
    },
    inspect: async (id) => {
      calls.sessionPersistence.push({ op: 'inspect', args: [id] })
      return { meta: { id }, events: [] }
    },
    readFrom: async (id, fromSeq) => {
      calls.sessionPersistence.push({ op: 'readFrom', args: [id, fromSeq] })
      return { meta: { id }, events: [] }
    },
    prepare: async (id) => {
      calls.sessionPersistence.push({ op: 'prepare', args: [id] })
      return {}
    },
    list: async () => {
      calls.sessionPersistence.push({ op: 'list' })
      return []
    },
    listSnapshots: async () => {
      calls.sessionPersistence.push({ op: 'listSnapshots' })
      return []
    },
    readRaw: async (id) => {
      calls.sessionPersistence.push({ op: 'readRaw', args: [id] })
      return undefined
    },
  }

  const workspaceState = {
    initialized: true,
    workspaceIds: [],
    archivedSessionIds: [],
  }
  let operationTail = Promise.resolve()
  const workspaceRegistry = {
    get archivedSessionIds() {
      return workspaceState.archivedSessionIds
    },
    set archivedSessionIds(value) {
      workspaceState.archivedSessionIds = value
    },
    archiveSession: async (sessionId) => {
      calls.workspaceRegistry.push({ op: 'archiveSession', args: [sessionId] })
      if (!workspaceState.archivedSessionIds.includes(sessionId)) {
        workspaceState.archivedSessionIds.push(sessionId)
      }
    },
    enqueueOperation(operation) {
      calls.workspaceRegistry.push({ op: 'enqueueOperation' })
      const result = operationTail.then(() => operation())
      operationTail = result.then(() => {}, () => {})
      return result
    },
    requireState() {
      calls.workspaceRegistry.push({ op: 'requireState' })
      return workspaceState
    },
    async setState(state) {
      calls.workspaceRegistry.push({ op: 'setState', args: [state] })
      Object.assign(workspaceState, state)
    },
    create: async (path, title) => {
      calls.workspaceRegistry.push({ op: 'create', args: [path, title] })
      const sessionIds = []
      return { id: 'workspace-fake', path, title, sessionIds, attachSession: async (id) => {
        calls.workspaceRegistry.push({ op: 'attachSession', args: [id, path] })
        if (!sessionIds.includes(id)) sessionIds.push(id)
      } }
    },
    get: () => undefined,
    list: () => [],
    delete: async () => true,
    insertBefore: async () => [],
    resolveByPath: async () => undefined,
    $state: workspaceState,
  }

  const openDomains = new Map()
  const storageDomain = {
    async open(spec) {
      calls.storageDomain.push({ op: 'open', args: [spec] })
      const unit = createFakeDomainUnit(spec)
      openDomains.set(spec.name ?? 'session_management', unit)
      return unit
    },
    get(name) {
      return openDomains.get(name)
    },
    async closeAll() {
      calls.storageDomain.push({ op: 'closeAll' })
      openDomains.clear()
    },
  }

  const ctx = {
    dshVersion: '0.1.0-rc.7',
    effect(fn) {
      const disposer = typeof fn === 'function' ? fn() : undefined
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    on(event, listener) {
      if (!registeredEvents.has(event)) registeredEvents.set(event, [])
      registeredEvents.get(event).push(listener)
      return () => {
        const listeners = registeredEvents.get(event)
        if (!listeners) return
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    emit() {},
    bail: async () => undefined,
    serial: async () => undefined,
    waterfall: async (_input, next) => next(),
    tools,
    sessions,
    agents,
    apiProxy,
    sessionQuery,
    sessionPersistence,
    workspaceRegistry,
    storageDomain,
    webServer,
    ...overrides,
  }

  ctx.$calls = calls
  ctx.$disposers = disposers
  ctx.$registeredTools = registeredTools
  ctx.$registeredRoutes = registeredRoutes
  ctx.$registeredEvents = registeredEvents
  ctx.$openDomains = openDomains
  return ctx
}

/** Create a naive domain unit backing `storageDomain.open`. */
function createFakeDomainUnit(spec) {
  const records = new Map()
  const unit = {
    name: spec.name,
    get: async (key) => {
      unit.$calls?.push({ op: 'get', args: [key] })
      return records.get(key)
    },
    set: async (key, value) => {
      unit.$calls?.push({ op: 'set', args: [key, value] })
      records.set(key, value)
    },
    update: async (key, updater) => {
      unit.$calls?.push({ op: 'update', args: [key] })
      const next = updater(records.get(key))
      records.set(key, next)
      return next
    },
    delete: async (key) => {
      unit.$calls?.push({ op: 'delete', args: [key] })
      return records.delete(key)
    },
    close: async () => {
      unit.$closed = true
    },
    $records: records,
    $calls: [],
  }
  return unit
}

/**
 * Install the standard batched title-snapshot stub. `titleFor` is either a
 * per-id title function or a constant title.
 */
export function stubTitleSnapshots(ctx, titleFor) {
  const resolve = typeof titleFor === 'function' ? titleFor : () => titleFor
  ctx.sessionQuery.readTitleSnapshots = async (ids) =>
    ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: resolve(id) } }))
  return ctx
}

/**
 * Seed the fake sessionQuery with session records plus the standard title,
 * event, and read-session stubs. `options`: events (per id), cwd/createdAt
 * maps for readSession, running id list, readRaw callback.
 */
export function seedSessions(ctx, records, options = {}) {
  stubTitleSnapshots(ctx, (id) => `Title ${id}`)
  ctx.sessionQuery.listSessions = async () => records
  ctx.sessionQuery.listEvents = async (id) => options.events?.[id] ?? []
  ctx.sessionQuery.readSession = async (sessionId) => ({
    session: {
      id: sessionId,
      createdAt: options.createdAt?.[sessionId] ?? 1000,
      cwd: options.cwd?.[sessionId] ?? 'C:/work',
    },
    events: options.events?.[sessionId] ?? [],
  })
  if (options.running) {
    ctx.sessions.get = async (id) => (options.running.includes(id) ? { id } : undefined)
  }
  if (options.readRaw) {
    ctx.sessionPersistence.readRaw = async (id) => options.readRaw(id)
  }
  return ctx
}

/**
 * Create the plugin service against a fresh fake context. Deleted artifact
 * paths are always collected and returned for assertions.
 */
export function setupSessionService(options = {}) {
  const ctx = createFakeContext()
  const manifest = openManifestStore(ctx.storageDomain)
  const deletedPaths = []
  const service = createSessionManagementService(ctx, manifest, {
    deleter: async (location) => {
      deletedPaths.push(location.path)
    },
    ...options,
  })
  return { ctx, manifest, service, deletedPaths }
}

/**
 * Standard ImportSourceAdapter fake (source-neutral, one session, no
 * records). Override `files`, `summary`, `convert`, or any member directly.
 */
export function fakeImportAdapter({ source = 'codex', root = 'C:/codex', files = [], summary = {}, convert, ...overrides } = {}) {
  return {
    source,
    resolveRoot: (input) => input || root,
    listFiles: async () => files,
    stat: async () => ({ sizeBytes: 10, mtimeMs: 1 }),
    read: async () => ({
      summary: {
        sourceSessionId: 'source-1',
        cwd: 'C:/work',
        createdAt: 1,
        updatedAt: 1,
        messageCount: 1,
        hasRealUserMessage: true,
        isSubagent: false,
        ...summary,
      },
      records: [],
      badLines: 0,
    }),
    convert:
      convert ??
      (() => ({ dshSessionId: 'dsh-1', header: { cwd: 'C:/work', createdAt: 1 }, events: [], knownToolCalls: 0, textCardToolCalls: 0 })),
    ...overrides,
  }
}

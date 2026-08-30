/**
 * Minimal fake official services for dsh-session-management tests.
 *
 * Issue #2 baseline: the harness only needs to assemble the five official
 * service faces that later slices will drive from the single `SessionManagement`
 * seam. All fakes are intentionally dumb records so tests can assert observable
 * calls without depending on DSH internals.
 */

/** The five official service faces the harness must expose. */
export const OFFICIAL_SERVICES = [
  'sessions',
  'sessionQuery',
  'sessionPersistence',
  'workspaceRegistry',
  'storageDomain',
]

/** Create a fake Cordis-like context with the five official service faces. */
export function createFakeContext(overrides = {}) {
  const calls = {
    sessions: [],
    sessionQuery: [],
    sessionPersistence: [],
    workspaceRegistry: [],
    storageDomain: [],
    tools: [],
  }

  const disposers = []
  const registeredTools = []

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

  const sessions = {
    create: async (...args) => {
      calls.sessions.push({ op: 'create', args })
      return { id: 'session-fake', events: [], header: { id: 'session-fake' } }
    },
    prepare: (...args) => {
      calls.sessions.push({ op: 'prepare', args })
      return { id: 'session-fake', header: { id: 'session-fake' } }
    },
    enter: () => {
      calls.sessions.push({ op: 'enter' })
      return () => {}
    },
    announce: () => {
      calls.sessions.push({ op: 'announce' })
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
      return { items: [], cursor: undefined }
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
      return { items: [], cursor: undefined }
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

  const workspaceRegistry = {
    archivedSessionIds: [],
    archiveSession: async (sessionId) => {
      calls.workspaceRegistry.push({ op: 'archiveSession', args: [sessionId] })
      if (!workspaceRegistry.archivedSessionIds.includes(sessionId)) {
        workspaceRegistry.archivedSessionIds.push(sessionId)
      }
    },
    create: async (path, title) => {
      calls.workspaceRegistry.push({ op: 'create', args: [path, title] })
      return { id: 'workspace-fake', path, title, sessionIds: [] }
    },
    get: () => undefined,
    list: () => [],
    delete: async () => true,
    insertBefore: async () => [],
    resolveByPath: async () => undefined,
  }

  const openDomains = new Map()
  const storageDomain = {
    async open(spec) {
      calls.storageDomain.push({ op: 'open', args: [spec] })
      const unit = createFakeDomainUnit(spec)
      openDomains.set(spec.name ?? 'session-management', unit)
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
    effect(fn) {
      const disposer = typeof fn === 'function' ? fn() : undefined
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    on() {},
    emit() {},
    bail: async () => undefined,
    serial: async () => undefined,
    waterfall: async (_input, next) => next(),
    tools,
    sessions,
    sessionQuery,
    sessionPersistence,
    workspaceRegistry,
    storageDomain,
    ...overrides,
  }

  ctx.$calls = calls
  ctx.$disposers = disposers
  ctx.$registeredTools = registeredTools
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
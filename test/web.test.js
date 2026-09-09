import test from 'node:test'
import assert from 'node:assert/strict'

import { registerSessionApi } from '../lib/web.js'

function captureRoute() {
  let route
  const ctx = {
    webServer: {
      register(value) {
        route = value
        return () => {}
      },
    },
  }
  return { ctx, route: () => route }
}

function jsonReq(url, body) {
  return {
    method: 'POST',
    url,
    setEncoding() {},
    on(event, callback) {
      if (event === 'data' && body) callback(JSON.stringify(body))
      if (event === 'end') callback()
    },
    destroy() {},
  }
}

function jsonRes() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(body) {
      state.body = body
    },
    $state: state,
  }
}

const API = '/@nathan110628/dsh-session-management/api'

function getRequest(url) {
  return { method: 'GET', url, setEncoding() {}, on() {}, destroy() {} }
}

test('archive and unarchive HTTP routes call the service with sessionId', async () => {
  const calls = []
  const service = {
    archive: async (sessionId) => calls.push(['archive', sessionId]),
    unarchive: async (sessionId) => calls.push(['unarchive', sessionId]),
  }
  const { ctx, route } = captureRoute()
  const dispose = registerSessionApi(ctx, service)

  const archiveRes = jsonRes()
  await route().handler(jsonReq(`${API}/archive`, { sessionId: 's1' }), archiveRes)
  assert.deepEqual(calls, [['archive', 's1']])
  assert.equal(archiveRes.$state.status, 200)
  assert.deepEqual(JSON.parse(archiveRes.$state.body), { ok: true, sessionId: 's1' })

  const unarchiveRes = jsonRes()
  await route().handler(jsonReq(`${API}/unarchive`, { sessionId: 's1' }), unarchiveRes)
  assert.deepEqual(calls, [['archive', 's1'], ['unarchive', 's1']])
  assert.equal(unarchiveRes.$state.status, 200)
  assert.deepEqual(JSON.parse(unarchiveRes.$state.body), { ok: true, sessionId: 's1' })

  dispose()
})

test('archive route rejects a missing sessionId', async () => {
  const calls = []
  const service = {
    archive: async (sessionId) => calls.push(['archive', sessionId]),
    unarchive: async (sessionId) => calls.push(['unarchive', sessionId]),
  }
  const { ctx, route } = captureRoute()
  const dispose = registerSessionApi(ctx, service)

  const res = jsonRes()
  await route().handler(jsonReq(`${API}/archive`, {}), res)
  assert.equal(res.$state.status, 400)
  assert.deepEqual(JSON.parse(res.$state.body), { error: 'Missing sessionId' })
  assert.deepEqual(calls, [])
  dispose()
})

test('delete HTTP route calls the service with sessionIds and confirmToken', async () => {
  const calls = []
  const service = {
    deleteSessions: async (sessionIds, options) => {
      calls.push(['delete', sessionIds, options])
      return { deletedSessionIds: sessionIds, paths: ['C:/fake/sessions/s1/session.jsonl'] }
    },
  }
  const { ctx, route } = captureRoute()
  const dispose = registerSessionApi(ctx, service)

  const res = jsonRes()
  await route().handler(jsonReq(`${API}/delete`, { sessionIds: ['s1', 's2'], confirmToken: 'DELETE' }), res)
  assert.deepEqual(calls, [['delete', ['s1', 's2'], { confirmToken: 'DELETE' }]])
  assert.equal(res.$state.status, 200)
  assert.deepEqual(JSON.parse(res.$state.body), {
    deletedSessionIds: ['s1', 's2'],
    paths: ['C:/fake/sessions/s1/session.jsonl'],
  })
  dispose()
})

test('delete route rejects a missing sessionIds', async () => {
  const calls = []
  const service = {
    deleteSessions: async (sessionIds) => calls.push(['delete', sessionIds]),
  }
  const { ctx, route } = captureRoute()
  const dispose = registerSessionApi(ctx, service)

  const res = jsonRes()
  await route().handler(jsonReq(`${API}/delete`, { confirmToken: 'DELETE' }), res)
  assert.equal(res.$state.status, 400)
  assert.deepEqual(JSON.parse(res.$state.body), { error: 'Missing sessionIds' })
  assert.deepEqual(calls, [])
  dispose()
})

test('open HTTP route calls the service with sessionId', async () => {
  const calls = []
  const service = {
    open: async (sessionId) => {
      calls.push(['open', sessionId])
      return { sessionId, resumed: true, alreadyRunning: false }
    },
  }
  const { ctx, route } = captureRoute()
  const dispose = registerSessionApi(ctx, service)

  const res = jsonRes()
  await route().handler(jsonReq(`${API}/open`, { sessionId: 's1' }), res)
  assert.deepEqual(calls, [['open', 's1']])
  assert.equal(res.$state.status, 200)
  assert.deepEqual(JSON.parse(res.$state.body), { sessionId: 's1', resumed: true, alreadyRunning: false })
  dispose()
})

test('search HTTP route calls the service with query and combined filters', async () => {
  const calls = []
  const service = {
    search: async (query, filters) => {
      calls.push([query, filters])
      return { items: [], total: 0 }
    },
  }
  const { ctx, route } = captureRoute()
  const dispose = registerSessionApi(ctx, service)

  const res = jsonRes()
  await route().handler(getRequest(`${API}/search?query=needle&source=codex&archived=true&workspace=b`), res)

  assert.deepEqual(calls, [['needle', { source: 'codex', archived: true, cwd: undefined, workspace: 'b', query: 'needle' }]])
  assert.equal(res.$state.status, 200)
  assert.deepEqual(JSON.parse(res.$state.body), { items: [], total: 0 })
  dispose()
})

test('list HTTP route supports metric hydration with cursor paging', async () => {
  const calls = []
  const service = {
    listPage: async (filters, page) => {
      calls.push([filters, page])
      return { items: [{ id: 's21' }], total: 45, nextCursor: '40' }
    },
  }
  const { ctx, route } = captureRoute()
  const dispose = registerSessionApi(ctx, service)
  const res = jsonRes()

  await route().handler(getRequest(`${API}/list?source=codex&limit=20&cursor=20&metrics=true`), res)

  assert.deepEqual(calls, [[
    { source: 'codex', archived: undefined, cwd: undefined, workspace: undefined, query: undefined },
    { limit: 20, cursor: '20', includeMetrics: true },
  ]])
  assert.equal(res.$state.status, 200)
  assert.deepEqual(JSON.parse(res.$state.body), { items: [{ id: 's21' }], total: 45, nextCursor: '40' })
  dispose()
})

test('search HTTP route uses lightweight cursor paging when limit is present', async () => {
  const calls = []
  const service = {
    searchPage: async (query, filters, page) => {
      calls.push([query, filters, page])
      return { items: [], total: 3 }
    },
  }
  const { ctx, route } = captureRoute()
  const dispose = registerSessionApi(ctx, service)
  const res = jsonRes()

  await route().handler(getRequest(`${API}/search?query=needle&archived=false&limit=20`), res)

  assert.deepEqual(calls, [[
    'needle',
    { source: undefined, archived: false, cwd: undefined, workspace: undefined, query: 'needle' },
    { limit: 20, cursor: undefined, includeMetrics: false },
  ]])
  assert.equal(res.$state.status, 200)
  dispose()
})

test('scan HTTP route uses one source-neutral service interface', async () => {
  const calls = []
  const service = {
    scan: async (source, root) => { calls.push([source, root]); return { scanId: 'scan-1', items: [], total: 0, badLines: 0 } },
  }
  const { ctx, route } = captureRoute()
  const dispose = registerSessionApi(ctx, service)

  const res1 = jsonRes()
  await route().handler(getRequest(`${API}/scan?source=codex&root=C%3A%5Ccodex`), res1)
  assert.deepEqual(calls, [['codex', 'C:\\codex']])
  assert.equal(res1.$state.status, 200)

  const res2 = jsonRes()
  await route().handler(getRequest(`${API}/scan`), res2)
  assert.deepEqual(calls, [['codex', 'C:\\codex'], ['claude-code', undefined]])
  assert.equal(res2.$state.status, 200)
  dispose()
})

test('scan and import HTTP routes reject unknown import sources', async () => {
  const calls = []
  const service = {
    scan: async (...args) => calls.push(['scan', ...args]),
    import: async (...args) => calls.push(['import', ...args]),
  }
  const { ctx, route } = captureRoute()
  const dispose = registerSessionApi(ctx, service)

  const scanRes = jsonRes()
  await route().handler(getRequest(`${API}/scan?source=unknown`), scanRes)
  assert.equal(scanRes.$state.status, 400)
  assert.deepEqual(JSON.parse(scanRes.$state.body), { error: 'Invalid import source' })

  const importRes = jsonRes()
  await route().handler(jsonReq(`${API}/import`, { source: 'unknown', scanId: 'scan-1', targets: [] }), importRes)
  assert.equal(importRes.$state.status, 400)
  assert.deepEqual(JSON.parse(importRes.$state.body), { error: 'Invalid import source' })
  assert.deepEqual(calls, [])
  dispose()
})

test('scan HTTP route uses cursor paging when limit is present', async () => {
  const calls = []
  const service = {
    scanPage: async (source, page) => {
      calls.push([source, page])
      return { scanId: 'scan-1', items: [], total: 45, badLines: 0, nextCursor: '40' }
    },
  }
  const { ctx, route } = captureRoute()
  const dispose = registerSessionApi(ctx, service)
  const res = jsonRes()

  await route().handler(getRequest(`${API}/scan?source=codex&limit=20&cursor=20&scanId=scan-1`), res)

  assert.deepEqual(calls, [['codex', { root: undefined, limit: 20, cursor: '20', scanId: 'scan-1', workspace: undefined }]])
  assert.equal(res.$state.status, 200)
  dispose()
})

test('import HTTP route requires scanId and uses one source-neutral interface', async () => {
  const calls = []
  const service = {
    import: async (source, scanId, targets) => { calls.push([source, scanId, targets]); return { items: [], success: 0, skipped: 0, failed: 0, reconciliationRequired: 0 } },
  }
  const { ctx, route } = captureRoute()
  const dispose = registerSessionApi(ctx, service)

  const res1 = jsonRes()
  await route().handler(jsonReq(`${API}/import`, { source: 'codex', scanId: 'scan-codex', targets: [{ sourceSessionId: 's1' }] }), res1)
  assert.deepEqual(calls, [['codex', 'scan-codex', [{ sourceSessionId: 's1' }]]])
  assert.equal(res1.$state.status, 200)

  const res2 = jsonRes()
  await route().handler(jsonReq(`${API}/import`, { scanId: 'scan-claude', targets: [{ sourceSessionId: 's2' }] }), res2)
  assert.deepEqual(calls, [
    ['codex', 'scan-codex', [{ sourceSessionId: 's1' }]],
    ['claude-code', 'scan-claude', [{ sourceSessionId: 's2' }]],
  ])
  assert.equal(res2.$state.status, 200)
  dispose()
})

test('stats HTTP route calls service.stats', async () => {
  const calls = []
  const service = {
    stats: async () => {
      calls.push(['stats'])
      return { totalSessions: 2, totalSizeBytes: 10, bySource: [], sessions: [] }
    },
  }
  const { ctx, route } = captureRoute()
  const dispose = registerSessionApi(ctx, service)
  const res = jsonRes()
  await route().handler(getRequest(`${API}/stats`), res)
  assert.deepEqual(calls, [['stats']])
  assert.equal(res.$state.status, 200)
  assert.deepEqual(JSON.parse(res.$state.body), { totalSessions: 2, totalSizeBytes: 10, bySource: [], sessions: [] })
  dispose()
})

test('cleanup preview HTTP route passes parsed rules to service.cleanupPreview', async () => {
  const calls = []
  const service = {
    cleanupPreview: async (rules) => {
      calls.push(['preview', rules])
      return { previewId: 'p1', rules, items: [], excluded: [], total: 0, totalSizeBytes: 0 }
    },
  }
  const { ctx, route } = captureRoute()
  const dispose = registerSessionApi(ctx, service)
  const res = jsonRes()
  await route().handler(getRequest(`${API}/cleanup/preview?olderThanDays=10&largerThanMb=50&emptySessions=true&archivedOnly=false&source=codex`), res)
  assert.deepEqual(calls, [['preview', {
    olderThanDays: 10,
    largerThanMb: 50,
    emptySessions: true,
    archivedOnly: false,
    source: 'codex',
  }]])
  assert.equal(res.$state.status, 200)
  dispose()
})

test('cleanup execute HTTP route calls service.cleanupExecute with previewId and confirmToken', async () => {
  const calls = []
  const service = {
    cleanupExecute: async (sessionIds, options) => {
      calls.push(['execute', sessionIds, options])
      return { items: sessionIds.map((sessionId) => ({ sessionId, status: 'success' })), success: sessionIds.length, failed: 0 }
    },
  }
  const { ctx, route } = captureRoute()
  const dispose = registerSessionApi(ctx, service)

  const res = jsonRes()
  await route().handler(jsonReq(`${API}/cleanup/execute`, { previewId: 'p1', sessionIds: ['s1', 's2'], confirmToken: 'DELETE' }), res)
  assert.deepEqual(calls, [['execute', ['s1', 's2'], { confirmToken: 'DELETE', previewId: 'p1' }]])
  assert.equal(res.$state.status, 200)
  assert.deepEqual(JSON.parse(res.$state.body), {
    items: [{ sessionId: 's1', status: 'success' }, { sessionId: 's2', status: 'success' }],
    success: 2,
    failed: 0,
  })
  dispose()
})

test('cleanup execute HTTP route rejects missing previewId', async () => {
  const calls = []
  const service = {
    cleanupExecute: async (sessionIds, options) => {
      calls.push(['execute', sessionIds, options])
    },
  }
  const { ctx, route } = captureRoute()
  const dispose = registerSessionApi(ctx, service)

  const res = jsonRes()
  await route().handler(jsonReq(`${API}/cleanup/execute`, { sessionIds: ['s1'], confirmToken: 'DELETE' }), res)
  assert.equal(res.$state.status, 400)
  assert.deepEqual(JSON.parse(res.$state.body), { error: 'Missing previewId' })
  assert.deepEqual(calls, [])
  dispose()
})

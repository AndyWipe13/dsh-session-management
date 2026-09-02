import test from 'node:test'
import assert from 'node:assert/strict'

import { createFakeContext } from './helpers/fake-services.js'
import { openManifestStore } from '../lib/manifest.js'
import { createSessionManagementService } from '../lib/service.js'

function setupService(options = {}) {
  const ctx = createFakeContext()
  const manifest = openManifestStore(ctx.storageDomain)
  const service = createSessionManagementService(ctx, manifest, options)
  return { ctx, manifest, service }
}

test('list returns unified sessions sorted by last active descending', async () => {
  const { ctx, manifest, service } = setupService()
  ctx.sessionQuery.listSessions = async () => [
    { header: { id: 's-old', createdAt: 1000, cwd: 'C:/work/a' }, live: false, persisted: true, blank: false },
    { header: { id: 's-new', createdAt: 2000, cwd: 'C:/work/b' }, live: true, persisted: true, blank: false },
  ]
  ctx.sessionQuery.readTitleSnapshots = async (ids) =>
    ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: id === 's-old' ? 'Old' : 'New' } }))
  ctx.sessionQuery.listEvents = async (id) =>
    id === 's-old'
      ? [
          { seq: 0, type: 'user/message', time: 1100 },
          { seq: 1, type: 'assistant/message', time: 1200 },
        ]
      : [{ seq: 0, type: 'user/message', time: 2100 }]

  const result = await service.list()

  assert.equal(result.total, 2)
  assert.deepEqual(result.items.map((item) => item.id), ['s-new', 's-old'])
  assert.equal(result.items[0].messageCount, 1)
  assert.equal(result.items[0].running, true)
  assert.equal(result.items[1].messageCount, 2)
  assert.equal(result.items[1].running, false)
  assert.equal(result.items[1].source, 'dsh')
  await manifest.close()
})

test('list reverse-looks-up imported source from manifest', async () => {
  const { ctx, manifest, service } = setupService()
  const unit = ctx.$openDomains.get('session_management')
  await unit.set('dsh:session-imported', {
    source: 'claude-code',
    sourceSessionId: 'cc-1',
    dshSessionId: 'session-imported',
    importedAt: 123,
  })

  ctx.sessionQuery.listSessions = async () => [
    { header: { id: 'session-imported', createdAt: 1000, cwd: 'C:/work' }, live: false, persisted: true, blank: false },
  ]
  ctx.sessionQuery.readTitleSnapshots = async (ids) =>
    ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: 'Imported' } }))
  ctx.sessionQuery.listEvents = async () => []

  const result = await service.list()
  assert.equal(result.items[0].source, 'claude-code')
  await manifest.close()
})

test('source, archive-state, and workspace filters combine', async () => {
  const { ctx, manifest, service } = setupService()
  const unit = ctx.$openDomains.get('session_management')
  await unit.set('dsh:codex-1', {
    source: 'codex',
    sourceSessionId: 'cx-1',
    dshSessionId: 'codex-1',
    importedAt: 1,
  })

  ctx.workspaceRegistry.archivedSessionIds = ['codex-1']
  ctx.sessionQuery.listSessions = async () => [
    { header: { id: 'native-1', createdAt: 1000, cwd: 'C:/work/a' }, live: false, persisted: true, blank: false },
    { header: { id: 'codex-1', createdAt: 2000, cwd: 'C:/work/b' }, live: false, persisted: true, blank: false },
    { header: { id: 'native-2', createdAt: 3000, cwd: 'C:/other/c' }, live: false, persisted: true, blank: false },
  ]
  ctx.sessionQuery.readTitleSnapshots = async (ids) =>
    ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: `Title ${id}` } }))
  ctx.sessionQuery.listEvents = async () => []

  const result = await service.list({ source: 'codex', archived: true, workspace: 'b' })
  assert.equal(result.total, 1)
  assert.equal(result.items[0].id, 'codex-1')
  await manifest.close()
})

test('title search filters case-insensitively when full-text API is unavailable', async () => {
  const { ctx, manifest, service } = setupService()
  ctx.sessionQuery.searchSessions = undefined
  ctx.sessionQuery.listSessions = async () => [
    { header: { id: 'one', createdAt: 1, cwd: 'C:/a' }, live: false, persisted: true, blank: false },
    { header: { id: 'two', createdAt: 2, cwd: 'C:/b' }, live: false, persisted: true, blank: false },
  ]
  ctx.sessionQuery.readTitleSnapshots = async (ids) =>
    ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: id === 'one' ? 'Alpha Project' : 'Beta' } }))
  ctx.sessionQuery.listEvents = async () => []

  const result = await service.search('alpha')
  assert.equal(result.total, 1)
  assert.equal(result.items[0].id, 'one')
  await manifest.close()
})

test('content search uses searchSessions, keeps filters, and projects snippet/source', async () => {
  const { ctx, manifest, service } = setupService()
  const unit = ctx.$openDomains.get('session_management')
  await unit.set('dsh:codex-1', {
    source: 'codex',
    sourceSessionId: 'cx-1',
    dshSessionId: 'codex-1',
    importedAt: 1,
  })

  ctx.workspaceRegistry.archivedSessionIds = ['codex-1']
  ctx.sessionQuery.listSessions = async () => [
    { header: { id: 'codex-1', createdAt: 2000, cwd: 'C:/work/b' }, live: false, persisted: true, blank: false },
    { header: { id: 'native-1', createdAt: 1000, cwd: 'C:/work/a' }, live: false, persisted: true, blank: false },
    { header: { id: 'native-2', createdAt: 3000, cwd: 'C:/other/c' }, live: false, persisted: true, blank: false },
  ]
  const searchCalls = []
  ctx.sessionQuery.searchSessions = async (request) => {
    searchCalls.push(request)
    return {
      items: [
        { header: { id: 'codex-1', createdAt: 2000, cwd: 'C:/work/b' }, live: false, persisted: true, bestMatch: { seq: 3, type: 'assistant/message', time: 2500, snippet: '... found in codex ...' } },
        { header: { id: 'native-1', createdAt: 1000, cwd: 'C:/work/a' }, live: false, persisted: true, bestMatch: { seq: 1, type: 'user/message', time: 1500, snippet: '... native ...' } },
        { header: { id: 'native-2', createdAt: 3000, cwd: 'C:/other/c' }, live: false, persisted: true, bestMatch: { seq: 0, type: 'tool/result', time: 3100, snippet: '... other ...' } },
      ],
      nextCursor: undefined,
    }
  }
  ctx.sessionQuery.readTitleSnapshots = async (ids) =>
    ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: `Title ${id}` } }))
  ctx.sessionQuery.listEvents = async (id) =>
    id === 'codex-1'
      ? [{ seq: 3, type: 'assistant/message', time: 2500 }]
      : [{ seq: 0, type: 'user/message', time: 1500 }]

  const result = await service.search('needle', { source: 'codex', archived: true, workspace: 'b' })

  assert.equal(searchCalls.length, 1)
  assert.equal(searchCalls[0].query, 'needle')
  assert.equal(searchCalls[0].limit, 100)
  assert.deepEqual(searchCalls[0].sessionFilters, [{ kind: 'id', values: ['codex-1'] }])
  assert.equal(result.total, 1)
  assert.equal(result.items[0].id, 'codex-1')
  assert.equal(result.items[0].source, 'codex')
  assert.equal(result.items[0].snippet, '... found in codex ...')
  await manifest.close()
})

test('fullTextSearch never falls back to title search without calling searchSessions', async () => {
  const { ctx, manifest, service } = setupService({ fullTextSearch: 'never' })
  let searchCalls = 0
  ctx.sessionQuery.searchSessions = async () => {
    searchCalls += 1
    return { items: [] }
  }
  ctx.sessionQuery.listSessions = async () => [
    { header: { id: 'one', createdAt: 1, cwd: 'C:/a' }, live: false, persisted: true, blank: false },
    { header: { id: 'two', createdAt: 2, cwd: 'C:/b' }, live: false, persisted: true, blank: false },
  ]
  ctx.sessionQuery.readTitleSnapshots = async (ids) =>
    ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: id === 'one' ? 'Alpha Project' : 'Beta' } }))
  ctx.sessionQuery.listEvents = async () => []

  const result = await service.search('alpha')

  assert.equal(searchCalls, 0)
  assert.equal(result.total, 1)
  assert.equal(result.items[0].id, 'one')
  await manifest.close()
})

test('content search falls back to title search when searchSessions is unavailable', async () => {
  const { ctx, manifest, service } = setupService()
  ctx.sessionQuery.searchSessions = undefined
  ctx.sessionQuery.listSessions = async () => [
    { header: { id: 'one', createdAt: 1, cwd: 'C:/a' }, live: false, persisted: true, blank: false },
  ]
  ctx.sessionQuery.readTitleSnapshots = async (ids) =>
    ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: 'Alpha Project' } }))
  ctx.sessionQuery.listEvents = async () => []

  const result = await service.search('alpha')

  assert.equal(result.total, 1)
  assert.equal(result.items[0].id, 'one')
  await manifest.close()
})

test('running marker awaits an async sessions.get result', async () => {
  const { ctx, manifest, service } = setupService()
  ctx.sessionQuery.listSessions = async () => [
    { header: { id: 'live-session', createdAt: 1000, cwd: 'C:/work' }, persisted: true, blank: false },
  ]
  ctx.sessionQuery.readTitleSnapshots = async (ids) =>
    ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: 'Live' } }))
  ctx.sessionQuery.listEvents = async () => []
  ctx.sessions.get = async () => ({ id: 'live-session' })

  const result = await service.list()
  assert.equal(result.items[0].running, true)
  await manifest.close()
})

test('preview returns official read-session history', async () => {
  const { ctx, manifest, service } = setupService()
  ctx.sessionQuery.readSession = async (id) => ({
    session: { id, createdAt: 1000, cwd: 'C:/work' },
    events: [
      { seq: 0, type: 'user/message', time: 1000, data: { content: 'hello' } },
      { seq: 1, type: 'assistant/message', time: 1100, data: { content: 'hi' } },
    ],
  })
  ctx.sessionQuery.readTitleSnapshots = async (ids) =>
    ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: 'Preview Title' } }))

  const preview = await service.preview('session-1')
  assert.equal(preview.id, 'session-1')
  assert.equal(preview.title, 'Preview Title')
  assert.equal(preview.source, 'dsh')
  assert.equal(preview.events.length, 2)
  assert.equal(preview.updatedAt, 1100)
  await manifest.close()
})

test('open resumes a cold session through agents.resume', async () => {
  const { ctx, manifest, service } = setupService()
  ctx.sessionQuery.readSession = async (id) => ({
    session: { id, createdAt: 1000, cwd: 'C:/work' },
    events: [],
  })
  ctx.sessions.get = async () => undefined

  const result = await service.open('session-cold')

  assert.deepEqual(result, { sessionId: 'session-cold', resumed: true, alreadyRunning: false, cwd: 'C:/work' })
  assert.equal(ctx.$calls.agents.filter((call) => call.op === 'resume').length, 1)
  assert.deepEqual(ctx.$calls.agents.find((call) => call.op === 'resume').args[0], { resumeSessionId: 'session-cold' })
  await manifest.close()
})

test('open no-ops for a running session without calling agents.resume', async () => {
  const { ctx, manifest, service } = setupService()
  ctx.sessions.get = async () => ({ id: 'session-live' })

  const result = await service.open('session-live')

  assert.deepEqual(result, { sessionId: 'session-live', resumed: false, alreadyRunning: true })
  assert.equal(ctx.$calls.agents.filter((call) => call.op === 'resume').length, 0)
  await manifest.close()
})

test('durationMs handles a very large event list without stack overflow', async () => {
  const { ctx, manifest, service } = setupService()
  const count = 300_000
  const events = Array.from({ length: count }, (_, i) => ({ type: 'user/message', time: 1000 + i }))
  ctx.sessionQuery.listSessions = async () => [
    { header: { id: 'big', createdAt: 1000, cwd: 'C:/work' }, persisted: true, blank: false },
  ]
  ctx.sessionQuery.readTitleSnapshots = async (ids) =>
    ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: 'Big' } }))
  ctx.sessionQuery.listEvents = async () => events
  ctx.sessionPersistence.readRaw = async () => ({ content: 'x' }) // keep sizeOf off the reduce path

  const result = await service.list()

  assert.equal(result.total, 1)
  assert.equal(result.items[0].messageCount, count)
  assert.equal(result.items[0].durationMs, count - 1)
  await manifest.close()
})
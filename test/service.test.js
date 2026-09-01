import test from 'node:test'
import assert from 'node:assert/strict'

import { createFakeContext } from './helpers/fake-services.js'
import { openManifestStore } from '../lib/manifest.js'
import { createSessionManagementService } from '../lib/service.js'

function setupService() {
  const ctx = createFakeContext()
  const manifest = openManifestStore(ctx.storageDomain)
  const service = createSessionManagementService(ctx, manifest)
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
  const unit = ctx.$openDomains.get('session-management')
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
  const unit = ctx.$openDomains.get('session-management')
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

test('title search filters case-insensitively', async () => {
  const { ctx, manifest, service } = setupService()
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
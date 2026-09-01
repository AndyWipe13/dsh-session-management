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

async function seedOne(ctx, id = 's1') {
  ctx.sessionQuery.listSessions = async () => [
    { header: { id, createdAt: 1, cwd: 'C:/work' }, live: false, persisted: true, blank: false },
  ]
  ctx.sessionQuery.readTitleSnapshots = async (ids) =>
    ids.map((sessionId) => ({ sessionId, status: 'fulfilled', value: { title: `Title ${sessionId}` } }))
  ctx.sessionQuery.listEvents = async () => []
}

test('archive calls official archiveSession and the list reflects archived state immediately', async () => {
  const { ctx, manifest, service } = setupService()
  await seedOne(ctx, 's1')

  await service.archive('s1')

  const archiveCalls = ctx.$calls.workspaceRegistry.filter((call) => call.op === 'archiveSession')
  assert.equal(archiveCalls.length, 1)
  assert.deepEqual(archiveCalls.map((call) => call.args[0]), ['s1'])
  assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, ['s1'])

  const all = await service.list()
  assert.equal(all.items[0].archived, true)

  const archivedOnly = await service.list({ archived: true })
  assert.equal(archivedOnly.total, 1)
  assert.equal(archivedOnly.items[0].id, 's1')
  await manifest.close()
})

test('archive is idempotent through the official idempotent API', async () => {
  const { ctx, manifest, service } = setupService()
  await seedOne(ctx, 's1')

  await service.archive('s1')
  await service.archive('s1')

  assert.equal(ctx.$calls.workspaceRegistry.filter((call) => call.op === 'archiveSession').length, 2)
  assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, ['s1'])
  await manifest.close()
})

test('unarchive uses the internal channel and preserves workspace registration order', async () => {
  const { ctx, manifest, service } = setupService()
  ctx.workspaceRegistry.$state.workspaceIds = ['w1', 'w2']
  ctx.workspaceRegistry.archivedSessionIds = ['s1', 's2']
  const before = [...ctx.workspaceRegistry.$state.workspaceIds]

  await service.unarchive('s1')

  assert.ok(ctx.$calls.workspaceRegistry.some((call) => call.op === 'enqueueOperation'))
  assert.equal(ctx.$calls.workspaceRegistry.filter((call) => call.op === 'setState').length, 1)
  assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, ['s2'])
  assert.deepEqual(ctx.workspaceRegistry.$state.workspaceIds, before)
  await manifest.close()
})

test('unarchive is idempotent: repeated unarchive of an active session is a no-op', async () => {
  const { ctx, manifest, service } = setupService()
  ctx.workspaceRegistry.archivedSessionIds = ['s1']

  await service.unarchive('s1')
  await service.unarchive('s1')

  assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, [])
  assert.equal(ctx.$calls.workspaceRegistry.filter((call) => call.op === 'setState').length, 1)
  await manifest.close()
})

test('unarchive guard rejects a missing internal channel with zero side effects', async () => {
  const { ctx, manifest, service } = setupService()
  delete ctx.workspaceRegistry.enqueueOperation
  delete ctx.workspaceRegistry.requireState
  delete ctx.workspaceRegistry.setState

  await assert.rejects(() => service.unarchive('s1'), /internal channel is unavailable/)

  assert.equal(ctx.$calls.workspaceRegistry.filter((call) => call.op === 'setState').length, 0)
  assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, [])
  await manifest.close()
})

test('unarchive guard rejects a damaged archivedSessionIds shape with zero side effects', async () => {
  const { ctx, manifest, service } = setupService()
  ctx.workspaceRegistry.requireState = () => ({ workspaceIds: [], archivedSessionIds: 'not-an-array' })

  await assert.rejects(() => service.unarchive('s1'), /archivedSessionIds string\[\]/)

  assert.equal(ctx.$calls.workspaceRegistry.filter((call) => call.op === 'setState').length, 0)
  assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, [])
  await manifest.close()
})

test('unarchive guard rejects non-string archivedSessionIds entries with zero side effects', async () => {
  const { ctx, manifest, service } = setupService()
  ctx.workspaceRegistry.requireState = () => ({ workspaceIds: [], archivedSessionIds: ['s1', 42] })

  await assert.rejects(() => service.unarchive('s1'), /archivedSessionIds string\[\]/)

  assert.equal(ctx.$calls.workspaceRegistry.filter((call) => call.op === 'setState').length, 0)
  assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, [])
  await manifest.close()
})
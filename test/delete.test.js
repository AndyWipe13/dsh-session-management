import test from 'node:test'
import assert from 'node:assert/strict'

import { createFakeContext } from './helpers/fake-services.js'
import { openManifestStore } from '../lib/manifest.js'
import { createSessionManagementService } from '../lib/service.js'

function setupService(overrides = {}) {
  const ctx = createFakeContext()
  const manifest = openManifestStore(ctx.storageDomain)
  const deletedPaths = []
  const options = {
    deleter: async (location) => {
      deletedPaths.push(location.path)
    },
    ...overrides.options,
  }
  const service = createSessionManagementService(ctx, manifest, options)
  return { ctx, manifest, service, deletedPaths }
}

async function seedSession(ctx, id = 's1', cwd = 'C:/work') {
  ctx.sessionQuery.listSessions = async () => [
    { header: { id, createdAt: 1, cwd }, live: false, persisted: true, blank: false },
  ]
  ctx.sessionQuery.readTitleSnapshots = async (ids) =>
    ids.map((sessionId) => ({ sessionId, status: 'fulfilled', value: { title: `Title ${sessionId}` } }))
  ctx.sessionQuery.listEvents = async () => []
  ctx.sessionQuery.readSession = async (sessionId) => ({
    session: { id: sessionId, createdAt: 1, cwd },
    events: [],
  })
}

test('deleteSessions requires the exact DELETE token and performs zero side effects', async () => {
  const { ctx, manifest, service, deletedPaths } = setupService()
  await seedSession(ctx, 's1')

  await assert.rejects(() => service.deleteSessions(['s1']), /exact token DELETE/)
  assert.deepEqual(deletedPaths, [])
  assert.equal(ctx.$calls.workspaceRegistry.filter((call) => call.op === 'setState').length, 0)
  await manifest.close()
})

test('deleteSessions rejects running sessions with zero side effects', async () => {
  const { ctx, manifest, service, deletedPaths } = setupService()
  await seedSession(ctx, 's1')
  ctx.sessions.get = async () => ({ id: 's1' })

  await assert.rejects(
    () => service.deleteSessions(['s1'], { confirmToken: 'DELETE' }),
    /Cannot delete running session/,
  )
  assert.deepEqual(deletedPaths, [])
  assert.equal(ctx.$calls.workspaceRegistry.filter((call) => call.op === 'setState').length, 0)
  await manifest.close()
})

test('deleteSessions removes the artifact, archived id, workspace registration, and manifest mapping', async () => {
  const { ctx, manifest, service, deletedPaths } = setupService()
  const detached = []
  const unit = ctx.$openDomains.get('session-management')
  await unit.set('dsh:s1', {
    source: 'claude-code',
    sourceSessionId: 'cc-1',
    dshSessionId: 's1',
    importedAt: 1,
  })
  await unit.set('source:claude-code:cc-1', {
    source: 'claude-code',
    sourceSessionId: 'cc-1',
    dshSessionId: 's1',
    importedAt: 1,
  })

  ctx.workspaceRegistry.archivedSessionIds = ['s1', 's2']
  ctx.workspaceRegistry.$state.workspaceIds = ['w1']
  ctx.workspaceRegistry.list = () => [
    {
      sessionIds: ['s1', 's2'],
      detachSession: async (sessionId) => detached.push(sessionId),
    },
  ]
  await seedSession(ctx, 's1')

  const result = await service.deleteSessions(['s1'], { confirmToken: 'DELETE' })

  assert.deepEqual(result.deletedSessionIds, ['s1'])
  assert.deepEqual(result.paths, ['C:\\fake\\sessions\\s1\\session.jsonl'])
  assert.deepEqual(deletedPaths, ['C:\\fake\\sessions\\s1\\session.jsonl'])
  assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, ['s2'])
  assert.deepEqual(detached, ['s1'])
  assert.equal(await unit.get('dsh:s1'), undefined)
  assert.equal(await unit.get('source:claude-code:cc-1'), undefined)
  await manifest.close()
})

test('deleteSessions refuses third-party source paths before any side effect', async () => {
  const { ctx, manifest, service, deletedPaths } = setupService()
  await seedSession(ctx, 's1')
  ctx.sessionPersistence.locate = () => ({
    kind: 'jsonl',
    path: 'C:/Users/example/.claude/projects/foo/session.jsonl',
  })

  await assert.rejects(
    () => service.deleteSessions(['s1'], { confirmToken: 'DELETE' }),
    /third-party source file/,
  )
  assert.deepEqual(deletedPaths, [])
  assert.equal(ctx.$calls.workspaceRegistry.filter((call) => call.op === 'setState').length, 0)
  await manifest.close()
})

test('deleteSessions fails loudly on a damaged private channel with zero side effects', async () => {
  const { ctx, manifest, service, deletedPaths } = setupService()
  await seedSession(ctx, 's1')
  ctx.workspaceRegistry.requireState = () => ({ workspaceIds: [], archivedSessionIds: 'not-an-array' })

  await assert.rejects(
    () => service.deleteSessions(['s1'], { confirmToken: 'DELETE' }),
    /archivedSessionIds string\[\]/,
  )
  assert.deepEqual(deletedPaths, [])
  assert.equal(ctx.$calls.workspaceRegistry.filter((call) => call.op === 'setState').length, 0)
  await manifest.close()
})

test('deleteSessions fails loudly when the workspace cleanup face is damaged before deleting', async () => {
  const { ctx, manifest, service, deletedPaths } = setupService()
  await seedSession(ctx, 's1')
  ctx.workspaceRegistry.$state.workspaceIds = ['w1']
  ctx.workspaceRegistry.list = () => [
    { sessionIds: ['s1'] },
  ]

  await assert.rejects(
    () => service.deleteSessions(['s1'], { confirmToken: 'DELETE' }),
    /detachSession is unavailable/,
  )
  assert.deepEqual(deletedPaths, [])
  assert.equal(ctx.$calls.workspaceRegistry.filter((call) => call.op === 'setState').length, 0)
  await manifest.close()
})
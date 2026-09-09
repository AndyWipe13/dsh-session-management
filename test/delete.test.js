import test from 'node:test'
import assert from 'node:assert/strict'

import { seedSessions, setupSessionService } from './helpers/fake-services.js'

function seedSession(ctx, id = 's1', cwd = 'C:/work') {
  return seedSessions(ctx, [{ header: { id, createdAt: 1, cwd }, live: false, persisted: true, blank: false }])
}

test('deleteSessions requires the exact DELETE token and performs zero side effects', async () => {
  const { ctx, manifest, service, deletedPaths } = setupSessionService()
  await seedSession(ctx, 's1')

  await assert.rejects(() => service.deleteSessions(['s1']), /exact token DELETE/)
  assert.deepEqual(deletedPaths, [])
  assert.equal(ctx.$calls.workspaceRegistry.filter((call) => call.op === 'setState').length, 0)
  await manifest.close()
})

test('delete preserves the official persistence receiver when locating artifacts', async () => {
  const { ctx, manifest, service } = setupSessionService()
  await seedSession(ctx, 's1')
  ctx.sessionPersistence.root = 'C:/fake/sessions'
  ctx.sessionPersistence.locate = function (meta) { return { path: `${this.root}/${meta.id}/session.jsonl` } }
  try {
    assert.deepEqual((await service.deleteSessions(['s1'], { confirmToken: 'DELETE' })).paths, ['C:/fake/sessions/s1/session.jsonl'])
  } finally { await manifest.close() }
})

test('deleteSessions rejects attached sessions with zero side effects', async () => {
  const { ctx, manifest, service, deletedPaths } = setupSessionService()
  await seedSession(ctx, 's1')
  ctx.sessions.get = async () => ({ id: 's1' })

  await assert.rejects(
    () => service.deleteSessions(['s1'], { confirmToken: 'DELETE' }),
    /Cannot delete attached session/,
  )
  assert.deepEqual(deletedPaths, [])
  assert.equal(ctx.$calls.workspaceRegistry.filter((call) => call.op === 'setState').length, 0)
  await manifest.close()
})

test('deleteSessions protects an attached session even when its agent is idle', async () => {
  const { ctx, manifest, service, deletedPaths } = setupSessionService()
  await seedSession(ctx, 's1')
  ctx.sessions.get = async () => ({ id: 's1' })
  ctx.agents.get = async () => ({ status: 'idle' })

  await assert.rejects(
    () => service.deleteSessions(['s1'], { confirmToken: 'DELETE' }),
    /Cannot delete attached session/,
  )
  assert.deepEqual(deletedPaths, [])
  await manifest.close()
})

test('deleteSessions removes the artifact, archived id, workspace registration, and manifest mapping', async () => {
  const { ctx, manifest, service, deletedPaths } = setupSessionService()
  const detached = []
  const unit = ctx.$openDomains.get('session_management')
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

test('batch deletion continues after one artifact fails and reports each outcome', async () => {
  const { ctx, manifest, service, deletedPaths } = setupSessionService({
    deleter: async (location) => {
      if (location.sessionId === 's2') throw new Error('disk denied')
      deletedPaths.push(location.path)
    },
  })
  ctx.sessionQuery.readSession = async (id) => ({
    session: { id, createdAt: 1, cwd: 'C:/work' },
    events: [],
  })

  const result = await service.deleteSessions(['s1', 's2', 's3'], { confirmToken: 'DELETE' })

  assert.deepEqual(result.deletedSessionIds, ['s1', 's3'])
  assert.deepEqual(result.failures, [{ sessionId: 's2', reason: 'disk denied' }])
  assert.deepEqual(deletedPaths, [
    'C:\\fake\\sessions\\s1\\session.jsonl',
    'C:\\fake\\sessions\\s3\\session.jsonl',
  ])
  await manifest.close()
})

test('batch deletion isolates one planning failure and executes valid plans', async () => {
  const { ctx, manifest, service, deletedPaths } = setupSessionService()
  ctx.sessionQuery.readSession = async (id) => ({
    session: { id, createdAt: 1, cwd: 'C:/work' },
    events: [],
  })
  ctx.sessionPersistence.locate = ({ id }) => ({
    path: id === 's2'
      ? 'C:/Users/example/.codex/sessions/s2.jsonl'
      : `C:\\fake\\sessions\\${id}\\session.jsonl`,
  })

  const result = await service.deleteSessions(['s1', 's2', 's3'], { confirmToken: 'DELETE' })

  assert.deepEqual(result.deletedSessionIds, ['s1', 's3'])
  assert.match(result.failures[0].reason, /third-party source file/)
  assert.deepEqual(deletedPaths, [
    'C:\\fake\\sessions\\s1\\session.jsonl',
    'C:\\fake\\sessions\\s3\\session.jsonl',
  ])
  await manifest.close()
})

test('deleteSessions refuses third-party source paths before any side effect', async () => {
  const { ctx, manifest, service, deletedPaths } = setupSessionService()
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
  const { ctx, manifest, service, deletedPaths } = setupSessionService()
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
  const { ctx, manifest, service, deletedPaths } = setupSessionService()
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

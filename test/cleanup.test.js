import test from 'node:test'
import assert from 'node:assert/strict'

import { createFakeContext } from './helpers/fake-services.js'
import { openManifestStore } from '../lib/manifest.js'
import { createSessionManagementService } from '../lib/service.js'

function setupService(options = {}) {
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

function seedList(ctx, sessions, options = {}) {
  ctx.sessionQuery.listSessions = async () => sessions
  ctx.sessionQuery.readTitleSnapshots = async (ids) =>
    ids.map((sessionId) => ({ sessionId, status: 'fulfilled', value: { title: `Title ${sessionId}` } }))
  ctx.sessionQuery.listEvents = async (id) => options.events?.[id] ?? []
  ctx.sessionQuery.readSession = async (sessionId) => ({
    session: { id: sessionId, createdAt: options.createdAt?.[sessionId] ?? 1000, cwd: options.cwd?.[sessionId] ?? 'C:/work' },
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

test('stats returns global totals, per-source distribution, and per-session metrics', async () => {
  const { ctx, manifest, service } = setupService()
  seedList(ctx, [
    { header: { id: 's1', createdAt: 1000, cwd: 'C:/work' }, live: false, persisted: true, blank: false },
    { header: { id: 's2', createdAt: 3000, cwd: 'C:/work' }, live: false, persisted: true, blank: false },
  ], {
    events: {
      s1: [
        { type: 'user/message', time: 100 },
        { type: 'tool/call', time: 150 },
        { type: 'tool/result', time: 160, data: { success: true } },
        { type: 'tool/call', time: 170 },
        { type: 'tool/result', time: 180, data: { isError: true } },
        { type: 'assistant/message', time: 200 },
      ],
      s2: [
        { type: 'turn/start', time: 300 },
        { type: 'user/message', time: 310 },
      ],
    },
  })

  const stats = await service.stats()

  assert.equal(stats.totalSessions, 2)
  assert.ok(stats.totalSizeBytes > 0)
  assert.deepEqual(stats.bySource.find((entry) => entry.source === 'dsh'), {
    source: 'dsh',
    count: 2,
    totalSizeBytes: stats.totalSizeBytes,
  })
  const s1 = stats.sessions.find((session) => session.id === 's1')
  assert.equal(s1.messageCount, 2)
  assert.equal(s1.durationMs, 100)
  assert.equal(s1.toolCalls, 2)
  assert.equal(s1.toolSuccess, 1)
  assert.equal(s1.toolNoResult, 1)
  const s2 = stats.sessions.find((session) => session.id === 's2')
  assert.equal(s2.messageCount, 1)
  assert.equal(s2.blank, false)
  await manifest.close()
})

test('cleanupPreview combines rules, excludes running sessions, and has zero side effects', async () => {
  const { ctx, manifest, service, deletedPaths } = setupService()
  const now = Date.now()
  const oldTime = now - 40 * 24 * 60 * 60 * 1000
  const recentTime = now - 1000
  ctx.workspaceRegistry.archivedSessionIds = ['s1', 's2', 's3', 's4']
  seedList(ctx, [
    { header: { id: 's1', createdAt: oldTime, cwd: 'C:/work' }, live: false, persisted: true, blank: false },
    { header: { id: 's2', createdAt: recentTime, cwd: 'C:/work' }, live: false, persisted: true, blank: false },
    { header: { id: 's3', createdAt: recentTime, cwd: 'C:/work' }, live: false, persisted: true, blank: false },
    { header: { id: 's4', createdAt: oldTime, cwd: 'C:/work' }, persisted: true, blank: false },
  ], {
    events: {
      s1: [{ type: 'turn/start', time: oldTime + 1 }],
      s2: [{ type: 'turn/start', time: recentTime }],
      s3: [{ type: 'turn/start', time: recentTime }],
      s4: [{ type: 'turn/start', time: oldTime + 1 }],
    },
    readRaw: (id) => (id === 's2' ? { content: 'x'.repeat(1024 * 1024 + 1) } : undefined),
    running: ['s4'],
  })

  const preview = await service.cleanupPreview({
    olderThanDays: 30,
    largerThanMb: 1,
    emptySessions: false,
    archivedOnly: true,
    source: 'all',
  })

  assert.equal(preview.total, 2)
  assert.deepEqual(preview.items.map((item) => item.id).sort(), ['s1', 's2'])
  assert.deepEqual(preview.items.find((item) => item.id === 's1').matchedRules, ['olderThanDays'])
  assert.deepEqual(preview.items.find((item) => item.id === 's2').matchedRules, ['largerThanMb'])
  assert.equal(preview.excluded.length, 1)
  assert.equal(preview.excluded[0].sessionId, 's4')
  assert.match(preview.excluded[0].reason, /Running session/)
  assert.deepEqual(deletedPaths, [])
  assert.equal(ctx.$calls.workspaceRegistry.filter((call) => call.op === 'setState').length, 0)
  await manifest.close()
})

test('cleanupExecute requires DELETE token and a live preview before any side effect', async () => {
  const { ctx, manifest, service, deletedPaths } = setupService()
  seedList(ctx, [{ header: { id: 's1', createdAt: 1000, cwd: 'C:/work' }, live: false, persisted: true, blank: false }], {
    events: { s1: [{ type: 'turn/start', time: 1001 }] },
  })

  await assert.rejects(
    () => service.cleanupExecute(['s1'], { confirmToken: 'NOPE' }),
    /exact token DELETE/,
  )
  await assert.rejects(
    () => service.cleanupExecute(['s1'], { confirmToken: 'DELETE' }),
    /must be previewed/,
  )
  assert.deepEqual(deletedPaths, [])
  assert.equal(ctx.$calls.workspaceRegistry.filter((call) => call.op === 'setState').length, 0)
  await manifest.close()
})

test('cleanupExecute rejects selections not present in the preview', async () => {
  const { ctx, manifest, service, deletedPaths } = setupService()
  const now = Date.now()
  const oldTime = now - 40 * 24 * 60 * 60 * 1000
  seedList(ctx, [
    { header: { id: 's1', createdAt: oldTime, cwd: 'C:/work' }, live: false, persisted: true, blank: false },
  ], {
    events: { s1: [{ type: 'turn/start', time: oldTime + 1 }] },
  })

  const preview = await service.cleanupPreview({ olderThanDays: 30, largerThanMb: 1, emptySessions: false, archivedOnly: false, source: 'all' })
  assert.equal(preview.total, 1)

  await assert.rejects(
    () => service.cleanupExecute(['not-in-preview'], { confirmToken: 'DELETE', previewId: preview.previewId }),
    /not in the latest preview/,
  )
  assert.deepEqual(deletedPaths, [])
  await manifest.close()
})

test('cleanupExecute deletes the selected subset and returns a success report', async () => {
  const { ctx, manifest, service, deletedPaths } = setupService()
  const now = Date.now()
  const oldTime = now - 40 * 24 * 60 * 60 * 1000
  ctx.workspaceRegistry.archivedSessionIds = ['s1', 's2']
  seedList(ctx, [
    { header: { id: 's1', createdAt: oldTime, cwd: 'C:/work' }, live: false, persisted: true, blank: false },
    { header: { id: 's2', createdAt: oldTime, cwd: 'C:/work' }, live: false, persisted: true, blank: false },
  ], {
    events: {
      s1: [{ type: 'turn/start', time: oldTime + 1 }],
      s2: [{ type: 'turn/start', time: oldTime + 1 }],
    },
  })

  const preview = await service.cleanupPreview({ olderThanDays: 30, largerThanMb: 1, emptySessions: false, archivedOnly: false, source: 'all' })
  assert.equal(preview.total, 2)

  const report = await service.cleanupExecute(['s2'], { confirmToken: 'DELETE', previewId: preview.previewId })

  assert.equal(report.success, 1)
  assert.equal(report.failed, 0)
  assert.equal(report.items[0].sessionId, 's2')
  assert.equal(report.items[0].status, 'success')
  assert.deepEqual(deletedPaths, ['C:\\fake\\sessions\\s2\\session.jsonl'])
  assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, ['s1'])
  await manifest.close()
})

test('cleanupExecute returns a failed report when the shared delete path rejects', async () => {
  const { ctx, manifest, service, deletedPaths } = setupService({
    deleter: async () => {
      throw new Error('disk failure')
    },
  })
  const now = Date.now()
  const oldTime = now - 40 * 24 * 60 * 60 * 1000
  seedList(ctx, [
    { header: { id: 's1', createdAt: oldTime, cwd: 'C:/work' }, live: false, persisted: true, blank: false },
  ], {
    events: { s1: [{ type: 'turn/start', time: oldTime + 1 }] },
  })

  const preview = await service.cleanupPreview({ olderThanDays: 30, largerThanMb: 1, emptySessions: false, archivedOnly: false, source: 'all' })
  const report = await service.cleanupExecute(['s1'], { confirmToken: 'DELETE', previewId: preview.previewId })

  assert.equal(report.success, 0)
  assert.equal(report.failed, 1)
  assert.equal(report.items[0].status, 'failed')
  assert.match(report.items[0].reason, /disk failure/)
  assert.deepEqual(deletedPaths, [])
  await manifest.close()
})

test('cleanupPreview can select empty sessions when enabled', async () => {
  const { ctx, manifest, service } = setupService()
  ctx.workspaceRegistry.archivedSessionIds = ['s1']
  seedList(ctx, [
    { header: { id: 's1', createdAt: Date.now() - 1000, cwd: 'C:/work' }, live: false, persisted: true, blank: false },
  ], {
    events: { s1: [{ type: 'session/title', time: Date.now() }] },
  })

  const withoutEmpty = await service.cleanupPreview({ olderThanDays: 0, largerThanMb: 0, emptySessions: false, archivedOnly: false, source: 'all' })
  assert.equal(withoutEmpty.total, 0)

  const withEmpty = await service.cleanupPreview({ olderThanDays: 0, largerThanMb: 0, emptySessions: true, archivedOnly: false, source: 'all' })
  assert.equal(withEmpty.total, 1)
  assert.deepEqual(withEmpty.items[0].matchedRules, ['emptySessions'])
  await manifest.close()
})
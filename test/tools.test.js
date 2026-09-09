import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'
import { registerSessionTools } from '../lib/tools.js'
import { createFakeContext, stubTitleSnapshots } from './helpers/fake-services.js'

test('session tools are registered and call the service', async () => {
  const ctx = createFakeContext()
  ctx.sessionQuery.searchSessions = undefined
  ctx.sessionQuery.listSessions = async () => [
    { header: { id: 's1', createdAt: 1000, cwd: 'C:/work' }, live: false, persisted: true, blank: false },
  ]
  stubTitleSnapshots(ctx, 'Session One')
  ctx.sessionQuery.listEvents = async () => []

  assert.doesNotThrow(() => apply(ctx, {}))

  assert.deepEqual(
    ctx.$registeredTools.map((tool) => tool.name),
    [
      'list_sessions',
      'search_sessions',
      'session_stats',
      'preview_session',
      'archive_session',
      'unarchive_session',
      'scan_import_queue',
      'import_sessions',
      'delete_sessions',
      'cleanup_preview_sessions',
      'cleanup_sessions',
    ],
  )

  const listTool = ctx.$registeredTools.find((tool) => tool.name === 'list_sessions')
  const listResult = await listTool.execute({})
  assert.equal(listResult.items.length, 1)
  assert.equal(listResult.items[0].title, 'Session One')

  const searchTool = ctx.$registeredTools.find((tool) => tool.name === 'search_sessions')
  const searchResult = await searchTool.execute({ query: 'SESSION' })
  assert.equal(searchResult.items.length, 1)

  ctx.sessionQuery.readSession = async (id) => ({
    session: { id, createdAt: 1000, cwd: 'C:/work' },
    events: [{ seq: 0, type: 'user/message', time: 1000, data: { content: 'hello' } }],
  })

  const previewTool = ctx.$registeredTools.find((tool) => tool.name === 'preview_session')
  const previewResult = await previewTool.execute({ sessionId: 's1' })
  assert.equal(previewResult.id, 's1')
  assert.equal(previewResult.events.length, 1)

  const archiveTool = ctx.$registeredTools.find((tool) => tool.name === 'archive_session')
  const archiveResult = await archiveTool.execute({ sessionId: 's1' })
  assert.deepEqual(archiveResult, { sessionId: 's1', archived: true })

  const unarchiveTool = ctx.$registeredTools.find((tool) => tool.name === 'unarchive_session')
  const unarchiveResult = await unarchiveTool.execute({ sessionId: 's1' })
  assert.deepEqual(unarchiveResult, { sessionId: 's1', archived: false })

  const deleteTool = ctx.$registeredTools.find((tool) => tool.name === 'delete_sessions')
  assert.ok(deleteTool, 'delete_sessions should be registered')
  const approvalListeners = ctx.$registeredEvents.get('tools/pre-execute') || []
  assert.ok(approvalListeners.length > 0, 'delete_sessions should install a tools/pre-execute approval hook')
  const decision = await approvalListeners[0](
    { name: 'delete_sessions', arguments: { sessionIds: ['s1'] } },
    async () => ({ kind: 'allow' }),
  )
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /s1/)
})

test('session_stats, cleanup_preview_sessions, and cleanup_sessions tools call the service', async () => {
  const ctx = createFakeContext()
  const calls = []
  const service = {
    stats: async () => ({
      totalSessions: 1,
      totalSizeBytes: 1024,
      bySource: [{ source: 'dsh', count: 1, totalSizeBytes: 1024 }],
      sessions: [],
    }),
    cleanupPreview: async (args) => ({
      previewId: 'preview-1',
      rules: { olderThanDays: 7, largerThanMb: 100, emptySessions: false, archivedOnly: true, source: 'all', ...args },
      items: [],
      excluded: [],
      total: 0,
      totalSizeBytes: 0,
    }),
    cleanupExecute: async (sessionIds, options) => {
      calls.push(['execute', sessionIds, options])
      return {
        items: sessionIds.map((sessionId) => ({ sessionId, status: 'success' })),
        success: sessionIds.length,
        failed: 0,
      }
    },
  }
  const dispose = registerSessionTools(ctx, service)
  try {
    const statsTool = ctx.$registeredTools.find((entry) => entry.name === 'session_stats')
    assert.ok(statsTool, 'session_stats should be registered')
    const statsResult = await statsTool.execute({})
    assert.equal(statsResult.totalSessions, 1)

    const previewTool = ctx.$registeredTools.find((entry) => entry.name === 'cleanup_preview_sessions')
    assert.ok(previewTool, 'cleanup_preview_sessions should be registered')
    const previewResult = await previewTool.execute({ olderThanDays: 7 })
    assert.equal(previewResult.previewId, 'preview-1')
    assert.equal(previewResult.rules.olderThanDays, 7)

    const cleanupTool = ctx.$registeredTools.find((entry) => entry.name === 'cleanup_sessions')
    assert.ok(cleanupTool, 'cleanup_sessions should be registered')
    const cleanupResult = await cleanupTool.execute({
      previewId: 'preview-1',
      sessionIds: ['s1'],
      confirmToken: 'DELETE',
    })
    assert.deepEqual(calls, [
      ['execute', ['s1'], { confirmToken: 'DELETE', previewId: 'preview-1' }],
    ])
    assert.equal(cleanupResult.success, 1)

    const approvalListeners = ctx.$registeredEvents.get('tools/pre-execute') || []
    assert.ok(approvalListeners.length > 0, 'cleanup_sessions should install a tools/pre-execute approval hook')
    let nextCalled = 0
    const decision = await approvalListeners[0](
      { name: 'cleanup_sessions', arguments: { sessionIds: ['s1'] } },
      async () => {
        nextCalled += 1
        return { kind: 'allow' }
      },
    )
    assert.equal(decision.kind, 'ask')
    assert.equal(nextCalled, 0, 'approval request must interrupt execution until the user approves')
    assert.match(decision.reason, /s1/)
  } finally {
    dispose()
  }
})

test('scan_import_queue and import_sessions share a source-bound snapshot', async () => {
  const ctx = createFakeContext()
  const calls = []
  const service = {
    scanPage: async (source, page) => {
      calls.push(['scan', source, page])
      return { scanId: 'scan-1', items: [], total: 0, badLines: 0 }
    },
    import: async (source, scanId, selections) => {
      calls.push(['import', source, scanId, selections])
      return { items: [], success: 0, skipped: 0, failed: 0, reconciliationRequired: 0 }
    },
  }
  const dispose = registerSessionTools(ctx, service)
  try {
    const scanTool = ctx.$registeredTools.find((entry) => entry.name === 'scan_import_queue')
    const scan = await scanTool.execute({ source: 'codex', root: 'C:/codex', limit: 20 })
    assert.equal(scan.scanId, 'scan-1')

    const tool = ctx.$registeredTools.find((entry) => entry.name === 'import_sessions')
    assert.ok(tool, 'import_sessions should be registered')
    assert.match(JSON.stringify(tool.parameters), /claude-code/)
    assert.match(JSON.stringify(tool.parameters), /codex/)

    await tool.execute({ source: 'codex', sourceSessionIds: ['s2'], scanId: scan.scanId })
    assert.deepEqual(calls, [
      ['scan', 'codex', { source: 'codex', root: 'C:/codex', limit: 20 }],
      ['import', 'codex', 'scan-1', [{ sourceSessionId: 's2' }]],
    ])
  } finally {
    dispose()
  }
})

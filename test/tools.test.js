import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'
import { registerSessionTools } from '../lib/tools.js'
import { createFakeContext } from './helpers/fake-services.js'

test('session tools are registered and call the service', async () => {
  const ctx = createFakeContext()
  ctx.sessionQuery.listSessions = async () => [
    { header: { id: 's1', createdAt: 1000, cwd: 'C:/work' }, live: false, persisted: true, blank: false },
  ]
  ctx.sessionQuery.readTitleSnapshots = async (ids) =>
    ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: 'Session One' } }))
  ctx.sessionQuery.listEvents = async () => []

  assert.doesNotThrow(() => apply(ctx, {}))

  assert.deepEqual(
    ctx.$registeredTools.map((tool) => tool.name),
    ['list_sessions', 'search_sessions', 'preview_session', 'archive_session', 'unarchive_session', 'import_sessions', 'delete_sessions'],
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

test('import_sessions tool dispatches Claude Code and Codex based on source', async () => {
  const ctx = createFakeContext()
  const calls = []
  const service = {
    importClaude: async (selections, root) => {
      calls.push(['claude', selections, root])
      return { items: [], success: 0, skipped: 0, failed: 0 }
    },
    importCodex: async (selections, root) => {
      calls.push(['codex', selections, root])
      return { items: [], success: 0, skipped: 0, failed: 0 }
    },
  }
  const dispose = registerSessionTools(ctx, service)
  try {
    const tool = ctx.$registeredTools.find((entry) => entry.name === 'import_sessions')
    assert.ok(tool, 'import_sessions should be registered')
    assert.match(JSON.stringify(tool.parameters), /claude-code/)
    assert.match(JSON.stringify(tool.parameters), /codex/)

    await tool.execute({ sourceSessionIds: ['s1'] })
    assert.deepEqual(calls, [['claude', [{ sourceSessionId: 's1' }], undefined]])

    await tool.execute({ source: 'codex', sourceSessionIds: ['s2'], root: 'C:/codex' })
    assert.deepEqual(calls, [
      ['claude', [{ sourceSessionId: 's1' }], undefined],
      ['codex', [{ sourceSessionId: 's2' }], 'C:/codex'],
    ])
  } finally {
    dispose()
  }
})
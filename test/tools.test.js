import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'
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
    ['list_sessions', 'search_sessions', 'preview_session', 'archive_session', 'unarchive_session'],
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
})
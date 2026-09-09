import test from 'node:test'
import assert from 'node:assert/strict'

import { createFakeContext, fakeImportAdapter, setupSessionService, stubTitleSnapshots } from './helpers/fake-services.js'
import { openManifestStore } from '../lib/manifest.js'
import { createSessionManagementService } from '../lib/service.js'

test('list returns unified sessions sorted by last active descending', async () => {
  const { ctx, manifest, service } = setupSessionService()
  ctx.sessionQuery.listSessions = async () => [
    { header: { id: 's-old', createdAt: 1000, cwd: 'C:/work/a' }, live: false, persisted: true, blank: false },
    { header: { id: 's-new', createdAt: 2000, cwd: 'C:/work/b' }, live: true, persisted: true, blank: false },
  ]
  stubTitleSnapshots(ctx, (id) => id === 's-old' ? 'Old' : 'New')
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

test('running marker follows agent status instead of an attached idle session', async () => {
  const { ctx, manifest, service } = setupSessionService()
  ctx.sessionQuery.listSessions = async () => [
    { header: { id: 'idle-session', createdAt: 1000, cwd: 'C:/work' }, live: true, persisted: true, blank: false },
  ]
  stubTitleSnapshots(ctx, 'Idle')
  ctx.sessionQuery.listEvents = async () => []
  ctx.sessions.get = async () => ({ id: 'idle-session', seq: 0 })
  ctx.agents.get = async () => ({ status: 'idle' })

  const result = await service.list()

  assert.equal(result.items[0].live, true)
  assert.equal(result.items[0].running, false)
  await manifest.close()
})

test('listPage puts a newly imported session ahead of an older native session', async () => {
  const { ctx, manifest, service } = setupSessionService()
  const records = [
    { header: { id: 'native-session', createdAt: 2000, cwd: 'C:/work' }, live: false, persisted: true, blank: false },
    { header: { id: 'imported-session', createdAt: 1000, cwd: 'C:/work' }, live: false, persisted: true, blank: false },
  ]
  ctx.sessionQuery.listSessions = async () => records
  stubTitleSnapshots(ctx, (id) => id)
  await manifest.put({
    dshSessionId: 'imported-session',
    source: 'codex',
    sourceSessionId: 'source-session',
    importedAt: 3000,
  })

  const result = await service.listPage({}, { limit: 20 })

  assert.deepEqual(result.items.map((item) => item.id), ['imported-session', 'native-session'])
  assert.deepEqual(result.items.map((item) => item.updatedAt), [3000, 2000])
  await manifest.close()
})

test('session management excludes subagent-owned sessions from every aggregate view', async () => {
  const { ctx, manifest, service } = setupSessionService()
  const records = [
    {
      header: { id: 'root-session', createdAt: 1000, cwd: 'C:/work/project' },
      live: false,
      persisted: true,
      blank: true,
    },
    {
      header: {
        id: 'review-subagent',
        createdAt: 2000,
        cwd: 'C:/work/project',
        parentSession: 'root-session',
        origin: 'subagent',
      },
      live: false,
      persisted: true,
      blank: true,
    },
  ]
  const titleRequests = []
  const eventRequests = []
  const searchRequests = []
  ctx.sessionQuery.listSessions = async () => records
  ctx.sessionQuery.readTitleSnapshots = async (ids) => {
    titleRequests.push(...ids)
    return ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: `Title ${id}` } }))
  }
  ctx.sessionQuery.listEvents = async (id) => {
    eventRequests.push(id)
    return []
  }
  ctx.sessionQuery.searchSessions = async (request) => {
    searchRequests.push(request)
    return { items: records, nextCursor: undefined }
  }

  const listed = await service.list()
  const paged = await service.listPage({}, { limit: 20 })
  const searched = await service.searchPage('review', {}, { limit: 20 })
  const stats = await service.stats()
  const cleanup = await service.cleanupPreview({
    emptySessions: true,
    olderThanDays: 0,
    largerThanMb: 0,
    archivedOnly: false,
  })

  assert.deepEqual(listed.items.map((item) => item.id), ['root-session'])
  assert.deepEqual(paged.items.map((item) => item.id), ['root-session'])
  assert.deepEqual(searched.items.map((item) => item.id), ['root-session'])
  assert.equal(stats.totalSessions, 1)
  assert.deepEqual(cleanup.items.map((item) => item.id), ['root-session'])
  assert.deepEqual(searchRequests[0].sessionFilters[0].values, ['root-session'])
  assert.equal(titleRequests.includes('review-subagent'), false)
  assert.equal(eventRequests.includes('review-subagent'), false)
  await manifest.close()
})

test('listPage returns 20 lightweight rows without reading session events', async () => {
  const { ctx, manifest, service } = setupSessionService()
  const records = Array.from({ length: 45 }, (_, index) => ({
    header: { id: `s-${String(index).padStart(2, '0')}`, createdAt: 45 - index, cwd: 'C:/work' },
    live: false,
    persisted: true,
    blank: false,
  }))
  const titleBatches = []
  let eventReads = 0
  let rawReads = 0
  ctx.sessionQuery.listSessions = async () => records
  ctx.sessionQuery.readTitleSnapshots = async (ids) => {
    titleBatches.push([...ids])
    return ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: `Title ${id}` } }))
  }
  ctx.sessionQuery.listEvents = async () => { eventReads += 1; return [] }
  ctx.sessionPersistence.readRaw = async () => { rawReads += 1; return undefined }

  const first = await service.listPage({}, { limit: 20 })
  const second = await service.listPage({}, { limit: 20, cursor: first.nextCursor })

  assert.equal(first.total, 45)
  assert.equal(first.items.length, 20)
  assert.equal(first.items[0].id, 's-00')
  assert.equal(first.items[19].id, 's-19')
  assert.equal(first.nextCursor, '20')
  assert.equal(second.total, 45)
  assert.equal(second.items.length, 20)
  assert.equal(second.items[0].id, 's-20')
  assert.equal(second.items[19].id, 's-39')
  assert.equal(second.nextCursor, '40')
  assert.deepEqual(titleBatches, [
    records.slice(0, 20).map((record) => record.header.id),
    records.slice(20, 40).map((record) => record.header.id),
  ])
  assert.equal(eventReads, 0)
  assert.equal(rawReads, 0)
  await manifest.close()
})

test('listPage hydrates metrics only for the selected page when requested', async () => {
  const { ctx, manifest, service } = setupSessionService()
  const records = Array.from({ length: 25 }, (_, index) => ({
    header: { id: `s-${String(index).padStart(2, '0')}`, createdAt: 25 - index, cwd: 'C:/work' },
    live: false,
    persisted: true,
    blank: false,
  }))
  const eventReads = []
  ctx.sessionQuery.listSessions = async () => records
  stubTitleSnapshots(ctx, (id) => `Title ${id}`)
  ctx.sessionQuery.listEvents = async (id) => {
    eventReads.push(id)
    return [
      { type: 'user/message', time: 1000 },
      { type: 'assistant/message', time: 2500 },
    ]
  }
  ctx.sessionPersistence.list = async () => records.map((record) => ({
    header: record.header,
    revision: `rev-${record.header.id}`,
    sizeBytes: 128,
  }))

  const result = await service.listPage({}, { limit: 20, includeMetrics: true })

  assert.equal(result.items.length, 20)
  assert.equal(eventReads.length, 20)
  assert.deepEqual(new Set(eventReads), new Set(records.slice(0, 20).map((record) => record.header.id)))
  assert.equal(result.items[0].sizeBytes, 128)
  assert.equal(result.items[0].messageCount, 2)
  assert.equal(result.items[0].durationMs, 1500)
  assert.equal(result.items[0].updatedAt, 2500)
  await manifest.close()
})

test('searchPage keeps canonical activity when search hits contain only match metadata', async () => {
  const { ctx, manifest, service } = setupSessionService()
  ctx.sessionQuery.listSessions = async () => [{
    header: { id: 'search-session', createdAt: 1000, cwd: 'C:/work' },
    updatedAt: 5000,
    persisted: true,
    blank: false,
  }]
  ctx.sessionQuery.searchSessions = async () => ({
    items: [{ id: 'search-session', bestMatch: { snippet: 'matched text' } }],
  })
  ctx.sessionQuery.readTitleSnapshots = async () => [{
    sessionId: 'search-session', status: 'fulfilled', value: { title: 'Search title' },
  }]

  const result = await service.searchPage('matched', {}, { limit: 20 })

  assert.equal(result.items[0].updatedAt, 5000)
  assert.equal(result.items[0].cwd, 'C:/work')
  assert.equal(result.items[0].snippet, 'matched text')
  await manifest.close()
})

test('scanPage caches unchanged source summaries, bulk titles, and pages by 20', async () => {
  const files = Array.from({ length: 45 }, (_, index) => `C:/codex/session-${String(index).padStart(2, '0')}.jsonl`)
  let firstMtime = 1
  let reads = 0
  let titleBatchReads = 0
  const codex = {
    source: 'codex',
    resolveRoot: (root) => root || 'C:/codex',
    listFiles: async () => files,
    stat: async (file) => ({ sizeBytes: 100, mtimeMs: file.endsWith('session-00.jsonl') ? firstMtime : 1 }),
    read: async (file) => {
      reads += 1
      const index = Number(file.match(/(\d+)\.jsonl$/)[1])
      return {
        summary: {
          sourceSessionId: `codex-${String(index).padStart(2, '0')}`,
          cwd: 'C:/work',
          title: `Prompt ${index}`,
          firstUserText: `Prompt ${index}`,
          createdAt: index,
          updatedAt: 1000 - index,
          messageCount: 1,
          hasRealUserMessage: true,
          isSubagent: false,
        },
        records: [],
        badLines: 0,
      }
    },
    enrichTitles: async (_root, parsed) => {
      titleBatchReads += 1
      const ids = parsed.map((file) => file.summary.sourceSessionId)
      return new Map(ids.map((id) => [id, `Title ${id}`]))
    },
    convert: () => ({ dshSessionId: 'unused', header: { createdAt: 0 }, events: [], knownToolCalls: 0, textCardToolCalls: 0 }),
  }
  const { manifest, service } = setupSessionService({ imports: [codex], codexPath: 'C:/codex' })

  const first = await service.scanPage('codex', { limit: 20 })
  const second = await service.scanPage('codex', { limit: 20, cursor: first.nextCursor, scanId: first.scanId })
  await service.scanPage('codex', { limit: 20 })

  assert.equal(first.items.length, 20)
  assert.equal(first.total, 45)
  assert.equal(first.nextCursor, '20')
  assert.match(first.items[0].title, /^Title codex-/)
  assert.equal(second.items.length, 20)
  assert.equal(second.nextCursor, '40')
  assert.equal(reads, 45)
  assert.equal(titleBatchReads, 2)

  firstMtime = 2
  await service.scanPage('codex', { limit: 20 })
  assert.equal(reads, 46)
  await manifest.close()
})

test('scan creates a source-bound import queue snapshot through one interface', async () => {
  const adapter = fakeImportAdapter({
    files: ['C:/codex/session.jsonl'],
    summary: { title: 'Imported session', createdAt: 1000, updatedAt: 2000, messageCount: 2 },
    stat: async () => ({ sizeBytes: 120, mtimeMs: 2000 }),
  })
  const { manifest, service } = setupSessionService({ imports: [adapter] })

  const result = await service.scan('codex', 'C:/codex')

  assert.equal(typeof result.scanId, 'string')
  assert.deepEqual(result.items.map((item) => item.sourceSessionId), ['source-1'])
  await manifest.close()
})

test('scanPage rejects a cursor that is not bound to a scan snapshot', async () => {
  const adapter = fakeImportAdapter({
    files: [],
    read: () => { throw new Error('not used') },
    convert: () => { throw new Error('not used') },
  })
  const { manifest, service } = setupSessionService({ imports: [adapter] })

  await assert.rejects(
    service.scanPage('codex', { limit: 20, cursor: '20' }),
    /scanId/i,
  )
  await manifest.close()
})

test('scan results cannot mutate the private import snapshot path', async () => {
  const statPaths = []
  const adapter = fakeImportAdapter({
    files: ['C:/codex/session.jsonl'],
    stat: async (file) => { statPaths.push(file); return { sizeBytes: 10, mtimeMs: 1 } },
  })
  const { manifest, service } = setupSessionService({ imports: [adapter] })
  const scan = await service.scan('codex', 'C:/codex')
  scan.items[0].path = 'C:/outside/session.jsonl'

  const result = await service.import('codex', scan.scanId, [{ sourceSessionId: 'source-1' }])

  assert.equal(result.success, 1)
  assert.equal(statPaths.at(-1), 'C:\\codex\\session.jsonl')
  await manifest.close()
})

test('import rejects a source file that changed after its scan snapshot', async () => {
  let mtimeMs = 1
  const adapter = fakeImportAdapter({
    source: 'claude-code',
    root: 'C:/claude',
    files: ['C:/claude/session.jsonl'],
    stat: async () => ({ sizeBytes: 10, mtimeMs }),
  })
  const { ctx, manifest, service } = setupSessionService({ imports: [adapter] })
  const scan = await service.scan('claude-code', 'C:/claude')
  mtimeMs = 2

  const result = await service.import('claude-code', scan.scanId, [{ sourceSessionId: 'source-1' }])

  assert.equal(result.failed, 1)
  assert.match(result.items[0].reason, /changed after scan/)
  assert.equal(ctx.$calls.sessions.some((call) => call.op === 'prepare'), false)
  await manifest.close()
})

test('import isolates item failures and continues the remaining batch', async () => {
  let scanning = true
  const adapter = {
    source: 'codex',
    resolveRoot: (root) => root || 'C:/codex',
    listFiles: async () => ['C:/codex/one.jsonl', 'C:/codex/two.jsonl'],
    stat: async (file) => {
      if (!scanning && file.endsWith('one.jsonl')) throw new Error('stat unavailable')
      return { sizeBytes: 10, mtimeMs: 1 }
    },
    read: async (file) => {
      const id = file.endsWith('one.jsonl') ? 'source-1' : 'source-2'
      return {
        summary: { sourceSessionId: id, cwd: 'C:/work', createdAt: 1, updatedAt: id === 'source-1' ? 2 : 1, messageCount: 1, hasRealUserMessage: true, isSubagent: false },
        records: [{ id }],
        badLines: 0,
      }
    },
    convert: (records) => ({ dshSessionId: `dsh-${records[0].id}`, header: { cwd: 'C:/work', createdAt: 1 }, events: [], knownToolCalls: 0, textCardToolCalls: 0 }),
  }
  const { manifest, service } = setupSessionService({ imports: [adapter] })
  const scan = await service.scan('codex', 'C:/codex')
  scanning = false

  const result = await service.import('codex', scan.scanId, [
    { sourceSessionId: 'source-1' },
    { sourceSessionId: 'source-2' },
  ])

  assert.equal(result.failed, 1)
  assert.equal(result.success, 1)
  assert.match(result.items[0].reason, /stat unavailable/)
  assert.equal(result.items[1].status, 'success')
  await manifest.close()
})

test('a fresh pending reservation without a DSH session is hidden, not reported as reconciliation-required', async () => {
  const adapter = fakeImportAdapter({ files: ['C:/codex/session.jsonl'] })
  const { manifest, service } = setupSessionService({ imports: [adapter] })
  await manifest.put({ source: 'codex', sourceSessionId: 'source-1', dshSessionId: 'dsh-1', importedAt: Date.now(), state: 'pending' })

  const scan = await service.scan('codex', 'C:/codex')

  assert.equal(scan.total, 0)
  await manifest.close()
})

test('import reports reconciliation required and the next scan completes the manifest', async () => {
  const ctx = createFakeContext()
  const stored = openManifestStore(ctx.storageDomain)
  let putCount = 0
  const manifest = {
    ...stored,
    async put(record) {
      putCount += 1
      if (putCount === 2) throw new Error('manifest completion unavailable')
      return stored.put(record)
    },
  }
  let persisted = false
  ctx.sessions.flush = async () => { persisted = true }
  ctx.sessionQuery.listSessions = async () => persisted ? [{ header: { id: 'dsh-1', createdAt: 1 } }] : []
  const adapter = fakeImportAdapter({ files: ['C:/codex/session.jsonl'] })
  const service = createSessionManagementService(ctx, manifest, { imports: [adapter] })
  const scan = await service.scan('codex', 'C:/codex')

  const result = await service.import('codex', scan.scanId, [{ sourceSessionId: 'source-1' }])

  assert.equal(result.reconciliationRequired, 1)
  assert.equal(result.items[0].status, 'reconciliation-required')
  assert.equal(result.items[0].dshSessionId, 'dsh-1')
  const nextScan = await service.scan('codex', 'C:/codex')
  assert.equal(nextScan.total, 0)
  assert.equal((await stored.getBySource('codex', 'source-1')).state, 'complete')
  await stored.close()
})

test('list reverse-looks-up imported source from manifest', async () => {
  const { ctx, manifest, service } = setupSessionService()
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
  stubTitleSnapshots(ctx, 'Imported')
  ctx.sessionQuery.listEvents = async () => []

  const result = await service.list()
  assert.equal(result.items[0].source, 'claude-code')
  await manifest.close()
})

test('source, archive-state, and workspace filters combine', async () => {
  const { ctx, manifest, service } = setupSessionService()
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
  stubTitleSnapshots(ctx, (id) => `Title ${id}`)
  ctx.sessionQuery.listEvents = async () => []

  const result = await service.list({ source: 'codex', archived: true, workspace: 'b' })
  assert.equal(result.total, 1)
  assert.equal(result.items[0].id, 'codex-1')
  await manifest.close()
})

test('title search filters case-insensitively when full-text API is unavailable', async () => {
  const { ctx, manifest, service } = setupSessionService()
  ctx.sessionQuery.searchSessions = undefined
  ctx.sessionQuery.listSessions = async () => [
    { header: { id: 'one', createdAt: 1, cwd: 'C:/a' }, live: false, persisted: true, blank: false },
    { header: { id: 'two', createdAt: 2, cwd: 'C:/b' }, live: false, persisted: true, blank: false },
  ]
  stubTitleSnapshots(ctx, (id) => id === 'one' ? 'Alpha Project' : 'Beta')
  ctx.sessionQuery.listEvents = async () => []

  const result = await service.search('alpha')
  assert.equal(result.total, 1)
  assert.equal(result.items[0].id, 'one')
  await manifest.close()
})

test('content search uses searchSessions, keeps filters, and projects snippet/source', async () => {
  const { ctx, manifest, service } = setupSessionService()
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
  stubTitleSnapshots(ctx, (id) => `Title ${id}`)
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
  const { ctx, manifest, service } = setupSessionService({ fullTextSearch: 'never' })
  let searchCalls = 0
  ctx.sessionQuery.searchSessions = async () => {
    searchCalls += 1
    return { items: [] }
  }
  ctx.sessionQuery.listSessions = async () => [
    { header: { id: 'one', createdAt: 1, cwd: 'C:/a' }, live: false, persisted: true, blank: false },
    { header: { id: 'two', createdAt: 2, cwd: 'C:/b' }, live: false, persisted: true, blank: false },
  ]
  stubTitleSnapshots(ctx, (id) => id === 'one' ? 'Alpha Project' : 'Beta')
  ctx.sessionQuery.listEvents = async () => []

  const result = await service.search('alpha')

  assert.equal(searchCalls, 0)
  assert.equal(result.total, 1)
  assert.equal(result.items[0].id, 'one')
  await manifest.close()
})

test('content search falls back to title search when searchSessions is unavailable', async () => {
  const { ctx, manifest, service } = setupSessionService()
  ctx.sessionQuery.searchSessions = undefined
  ctx.sessionQuery.listSessions = async () => [
    { header: { id: 'one', createdAt: 1, cwd: 'C:/a' }, live: false, persisted: true, blank: false },
  ]
  stubTitleSnapshots(ctx, 'Alpha Project')
  ctx.sessionQuery.listEvents = async () => []

  const result = await service.search('alpha')

  assert.equal(result.total, 1)
  assert.equal(result.items[0].id, 'one')
  await manifest.close()
})

test('running marker awaits an async sessions.get result', async () => {
  const { ctx, manifest, service } = setupSessionService()
  ctx.sessionQuery.listSessions = async () => [
    { header: { id: 'live-session', createdAt: 1000, cwd: 'C:/work' }, persisted: true, blank: false },
  ]
  stubTitleSnapshots(ctx, 'Live')
  ctx.sessionQuery.listEvents = async () => []
  ctx.sessions.get = async () => ({ id: 'live-session' })

  const result = await service.list()
  assert.equal(result.items[0].running, true)
  await manifest.close()
})

test('preview returns official read-session history', async () => {
  const { ctx, manifest, service } = setupSessionService()
  ctx.sessionQuery.readSession = async (id) => ({
    session: { id, createdAt: 1000, cwd: 'C:/work' },
    events: [
      { seq: 0, type: 'user/message', time: 1000, data: { content: 'hello' } },
      { seq: 1, type: 'assistant/message', time: 1100, data: { content: 'hi' } },
    ],
  })
  stubTitleSnapshots(ctx, 'Preview Title')

  const preview = await service.preview('session-1')
  assert.equal(preview.id, 'session-1')
  assert.equal(preview.title, 'Preview Title')
  assert.equal(preview.source, 'dsh')
  assert.equal(preview.events.length, 2)
  assert.equal(preview.updatedAt, 1100)
  await manifest.close()
})

test('open resumes a cold session through official session.create', async () => {
  const { ctx, manifest, service } = setupSessionService()
  ctx.sessionQuery.readSession = async (id) => ({
    session: { id, createdAt: 1000, cwd: 'C:/work' },
    events: [],
  })
  ctx.sessions.get = async () => undefined

  const result = await service.open('session-cold')

  assert.deepEqual(result, { sessionId: 'session-cold', resumed: true, alreadyRunning: false, cwd: 'C:/work' })
  const create = ctx.$calls.apiProxy.find((call) => call.op === 'session.create')
  assert.deepEqual(create.args[0].payload, { sessionId: 'session-cold', cwd: 'C:/work' })
  await manifest.close()
})

test('open refuses a cold session without cwd before session.create', async () => {
  const { ctx, manifest, service } = setupSessionService()
  ctx.sessionQuery.readSession = async (id) => ({ session: { id, createdAt: 1000 }, events: [] })
  ctx.sessions.get = async () => undefined

  const result = await service.open('session-without-cwd')

  assert.deepEqual(result, {
    sessionId: 'session-without-cwd',
    resumed: false,
    alreadyRunning: false,
    reason: 'Session has no cwd and cannot be resumed safely',
  })
  assert.equal(ctx.$calls.apiProxy.length, 0)
  await manifest.close()
})

test('open no-ops for a running session without calling session.create', async () => {
  const { ctx, manifest, service } = setupSessionService()
  ctx.sessions.get = async () => ({ id: 'session-live' })

  const result = await service.open('session-live')

  assert.deepEqual(result, { sessionId: 'session-live', resumed: false, alreadyRunning: true })
  assert.equal(ctx.$calls.apiProxy.length, 0)
  await manifest.close()
})

test('durationMs handles a very large event list without stack overflow', async () => {
  const { ctx, manifest, service } = setupSessionService()
  const count = 300_000
  const events = Array.from({ length: count }, (_, i) => ({ type: 'user/message', time: 1000 + i }))
  ctx.sessionQuery.listSessions = async () => [
    { header: { id: 'big', createdAt: 1000, cwd: 'C:/work' }, persisted: true, blank: false },
  ]
  stubTitleSnapshots(ctx, 'Big')
  ctx.sessionQuery.listEvents = async () => events
  ctx.sessionPersistence.readRaw = async () => ({ content: 'x' }) // keep sizeOf off the reduce path

  const result = await service.list()

  assert.equal(result.total, 1)
  assert.equal(result.items[0].messageCount, count)
  assert.equal(result.items[0].durationMs, count - 1)
  await manifest.close()
})

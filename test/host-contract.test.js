import test from 'node:test'
import assert from 'node:assert/strict'
import { createFakeContext } from './helpers/fake-services.js'
import { openManifestStore } from '../lib/manifest.js'
import { createSessionManagementService } from '../lib/service.js'
import { createClaudeImportAdapter } from '../lib/claude.js'
import { fileURLToPath } from 'node:url'

test('official nested title observation reaches list and preview', async () => {
  const ctx = createFakeContext()
  const manifest = openManifestStore(ctx.storageDomain)
  const header = { id: 'session-real', cwd: 'C:/project', createdAt: 1 }
  ctx.sessionQuery.listSessions = async () => [{ header, persisted: true }]
  ctx.sessionQuery.readTitleSnapshots = async () => [{ sessionId: header.id, status: 'fulfilled', value: {
    session: header, title: { title: '真实会话标题', source: 'user', updatedAt: 2 },
  } }]
  const service = createSessionManagementService(ctx, manifest)
  try {
    assert.equal((await service.list()).items[0].title, '真实会话标题')
    assert.equal((await service.preview(header.id)).title, '真实会话标题')
  } finally { await manifest.close() }
})

test('SessionManagement accepts a substitutable DSH host adapter', async () => {
  const ctx = createFakeContext()
  const manifest = openManifestStore(ctx.storageDomain)
  ctx.sessionQuery.listSessions = async () => { throw new Error('raw rc.7 context leaked') }
  const record = { header: { id: 'adapter-session', cwd: 'C:/adapter', createdAt: 1 }, persisted: true }
  const host = {
    listSessions: async () => [record],
    archivedSessionIds: () => new Set(),
    persistenceHints: async () => new Map([['adapter-session', { revision: 'r1', sizeBytes: 10 }]]),
    readTitles: async () => new Map([['adapter-session', 'Adapter title']]),
    attachedSession: async () => undefined,
    running: async () => false,
    readRaw: async () => undefined,
    listEvents: async () => [
      { type: 'turn/start', time: 1 },
      { type: 'user/message', time: 2 },
    ],
  }
  const service = createSessionManagementService(ctx, manifest, { host })
  try {
    const result = await service.list()
    assert.equal(result.items[0].title, 'Adapter title')
    assert.equal(result.items[0].updatedAt, 2)
  } finally { await manifest.close() }
})

test('rc.7 private host channel rejects a different installed DSH version before use', async () => {
  const ctx = createFakeContext()
  const manifest = openManifestStore(ctx.storageDomain)
  try {
    const service = createSessionManagementService(ctx, manifest, { dshVersion: '0.1.0-rc.8' })
    await assert.rejects(
      () => service.unarchive('session-version-guard'),
      /requires DSH 0\.1\.0-rc\.7.*detected 0\.1\.0-rc\.8/,
    )
  } finally { await manifest.close() }
})

test('import is discoverable in the workspace matching its persisted cwd', async () => {
  const ctx = createFakeContext()
  const manifest = openManifestStore(ctx.storageDomain)
  const attached = []
  let persisted = false
  let savedHeader
  const prepare = ctx.sessions.prepare
  ctx.sessions.prepare = (id, options) => { savedHeader = options.meta; return prepare(id, options) }
  ctx.sessions.flush = async () => { persisted = true; return true }
  ctx.workspaceRegistry.create = async (cwd) => ({ path: cwd, attachSession: async (id) => {
    assert.equal(persisted, true, 'must persist before header-validated workspace attachment')
    attached.push({ id, cwd })
  } })
  const service = createSessionManagementService(ctx, manifest, { imports: [createClaudeImportAdapter()] })
  try {
    const root = fileURLToPath(new URL('./fixtures/claude-code', import.meta.url))
    const scan = await service.scan('claude-code', root)
    const result = await service.import('claude-code', scan.scanId, [{ sourceSessionId: '00000000-0000-0000-0000-00000000' }])
    assert.equal(result.success, 1, JSON.stringify(result))
    assert.deepEqual(attached, [{ id: result.items[0].dshSessionId, cwd: savedHeader.cwd }])
    const seeded = ctx.$calls.sessions.find(call => call.op === 'prepare').args[1].seed
    assert.ok(seeded.some(event => event.type === 'session/title' && event.data.title), 'scan title must survive in the persisted log')
  } finally { await manifest.close() }
})

test('legacy import repair attaches original identities and preserves archive state', async () => {
  const ctx = createFakeContext()
  const manifest = openManifestStore(ctx.storageDomain)
  await manifest.put({ source: 'codex', sourceSessionId: 'source-1', dshSessionId: 'imported-1', importedAt: 1 })
  ctx.workspaceRegistry.archivedSessionIds = ['imported-1']
  ctx.sessionQuery.listSessions = async () => [{ header: { id: 'imported-1' } }, { header: { id: 'native-1' } }]
  ctx.sessionQuery.readSession = async id => ({ session: { id, cwd: 'C:/existing-project' }, events: [] })
  const service = createSessionManagementService(ctx, manifest)
  try {
    const report = await service.repairImportedWorkspaces()
    assert.equal(report.success, 1)
    assert.deepEqual(ctx.$calls.workspaceRegistry.filter(call => call.op === 'attachSession').map(call => call.args), [['imported-1', 'C:/existing-project']])
    assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, ['imported-1'])
    assert.equal(ctx.$calls.sessions.filter(call => call.op === 'prepare').length, 0)
  } finally { await manifest.close() }
})

test('legacy title repair uses the source title and releases the official cold preparation', async () => {
  const ctx = createFakeContext()
  const manifest = openManifestStore(ctx.storageDomain)
  await manifest.put({ source: 'claude-code', sourceSessionId: '00000000-0000-0000-0000-00000000', dshSessionId: 'legacy', importedAt: 1 })
  ctx.sessionQuery.listSessions = async () => [{ header: { id: 'legacy' } }]
  ctx.sessionQuery.readSession = async () => ({ session: { id: 'legacy', cwd: 'C:/project' }, events: [] })
  const appended = []
  let released = false
  ctx.sessionPersistence.prepare = async id => {
    assert.equal(id, 'legacy')
    return { session: { append: (type, data) => appended.push({ type, data }) }, [Symbol.dispose]: () => { released = true } }
  }
  const service = createSessionManagementService(ctx, manifest, {
    imports: [createClaudeImportAdapter(fileURLToPath(new URL('./fixtures/claude-code', import.meta.url)))],
  })
  try {
    const result = await service.repairImportedWorkspaces()
    assert.equal(result.success, 1, JSON.stringify(result))
    assert.equal(appended[0].type, 'session/title')
    assert.ok(appended[0].data.title)
    assert.equal(released, true)
    assert.equal(ctx.$calls.sessions.filter(call => call.op === 'enter-dispose').length, 1)
  } finally { await manifest.close() }
})

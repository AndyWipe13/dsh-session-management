import test from 'node:test'
import assert from 'node:assert/strict'

import { createFakeContext, OFFICIAL_SERVICES } from './helpers/fake-services.js'

test('fake context exposes the official service faces', () => {
  const ctx = createFakeContext()

  for (const service of OFFICIAL_SERVICES) {
    assert.equal(typeof ctx[service], 'object')
  }
})

test('fake workspaceRegistry records archive calls', async () => {
  const ctx = createFakeContext()
  await ctx.workspaceRegistry.archiveSession('session-1')
  await ctx.workspaceRegistry.archiveSession('session-1')

  assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, ['session-1'])
  assert.equal(ctx.$calls.workspaceRegistry.filter((c) => c.op === 'archiveSession').length, 2)
})

test('fake storageDomain opens an in-memory unit', async () => {
  const ctx = createFakeContext()
  const spec = { name: 'session-management', version: 1, tables: {}, globals: {} }
  const unit = await ctx.storageDomain.open(spec)

  assert.equal(ctx.storageDomain.get('session-management'), unit)

  await unit.set('source:claude-code:id-1', { dshSessionId: 'session-imported-1', importedAt: 1 })
  assert.deepEqual(await unit.get('source:claude-code:id-1'), {
    dshSessionId: 'session-imported-1',
    importedAt: 1,
  })

  await unit.set('source:codex:id-2', { dshSessionId: 'session-imported-2', importedAt: 2 })
  await unit.delete('source:codex:id-2')
  assert.equal(await unit.get('source:codex:id-2'), undefined)

  await ctx.storageDomain.closeAll()
  assert.equal(ctx.storageDomain.get('session-management'), undefined)
})

test('fake tools registers and records tools', () => {
  const ctx = createFakeContext()
  const disposer = ctx.tools.register({ name: 'fake-tool' })
  assert.deepEqual(ctx.$registeredTools.map((t) => t.name), ['fake-tool'])
  assert.equal(ctx.$calls.tools.some((c) => c.op === 'register' && c.name === 'fake-tool'), true)
  disposer()
  assert.deepEqual(ctx.$registeredTools, [])
})

test('fake sessionQuery returns deterministic empty results', async () => {
  const ctx = createFakeContext()

  assert.deepEqual(await ctx.sessionQuery.listSessions(), [])
  assert.deepEqual(await ctx.sessionQuery.filterSessions([]), [])
  assert.deepEqual(await ctx.sessionQuery.readSession('session-1'), {
    header: { id: 'session-1' },
    events: [],
  })
  assert.equal(await ctx.sessionQuery.readTitle('session-1'), undefined)
})

test('fake sessionPersistence exposes locate/list/create/append seams', async () => {
  const ctx = createFakeContext()

  const location = ctx.sessionPersistence.locate({ id: 'session-1' })
  assert.equal(location.kind, 'jsonl')
  assert.match(location.path, /session-1/)

  assert.deepEqual(await ctx.sessionPersistence.list(), [])
  await ctx.sessionPersistence.create({ id: 'session-1' })
  await ctx.sessionPersistence.append('session-1', [])
  assert.equal(ctx.$calls.sessionPersistence.some((c) => c.op === 'create'), true)
  assert.equal(ctx.$calls.sessionPersistence.some((c) => c.op === 'append'), true)
})
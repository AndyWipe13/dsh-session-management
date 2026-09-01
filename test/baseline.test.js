import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { name, inject, Config, apply } from '../lib/index.js'
import { createFakeContext, OFFICIAL_SERVICES } from './helpers/fake-services.js'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('plugin baseline exports shape', () => {
  assert.equal(name, '@dsh-external/dsh-session-management')
  assert.deepEqual(inject, ['tools', 'sessions', 'sessionQuery', 'sessionPersistence', 'workspaceRegistry', 'storageDomain'])
  assert.equal(typeof apply, 'function')
  assert.ok(Config, 'Config schema should exist for future configuration')
})

test('bundle patch points at the built plugin module', () => {
  const patch = fs.readFileSync(path.join(repoRoot, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /@dsh-external\/dsh-session-management/)
  assert.ok(fs.existsSync(path.join(repoRoot, 'lib', 'index.js')), 'lib/index.js must exist after build')
})

test('plugin applies cleanly and registers read-only tools and settings api', () => {
  const ctx = createFakeContext()
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.deepEqual(
    ctx.$registeredTools.map((tool) => tool.name),
    ['list_sessions', 'search_sessions', 'preview_session'],
  )
  assert.equal(
    ctx.$registeredTools.some((tool) => tool.name === '_dsh_external_dsh_session_management_hello'),
    false,
    'hello placeholder tool must be removed',
  )
  assert.ok(
    ctx.$registeredRoutes.some((route) => route.kind === 'prefix' && route.path.includes('/@dsh-external/dsh-session-management/api')),
    'settings api route should be registered',
  )
})

test('plugin can be applied to a fake ctx with all official services present', () => {
  const ctx = createFakeContext()
  apply(ctx, {})

  for (const service of OFFICIAL_SERVICES) {
    assert.ok(ctx[service], `fake ctx should expose ${service}`)
  }
})
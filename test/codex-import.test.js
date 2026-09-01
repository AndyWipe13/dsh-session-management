import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { createFakeContext } from './helpers/fake-services.js'
import { openManifestStore } from '../lib/manifest.js'
import { createSessionManagementService } from '../lib/service.js'
import { convertCodexRecords, createCodexSourceReader, readCodexFile, resolveCodexTitle, summarizeCodexRecords } from '../lib/codex.js'

const require = createRequire(import.meta.url)
const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const codexFixtures = path.join(fixturesRoot, 'codex')
const badLineFixtures = path.join(fixturesRoot, 'bad-line')

function setupService(options = {}) {
  const ctx = createFakeContext()
  const manifest = openManifestStore(ctx.storageDomain)
  const service = createSessionManagementService(ctx, manifest, {
    codex: createCodexSourceReader(),
    ...options,
  })
  return { ctx, manifest, service }
}

function simpleCodexSessionLines(sessionId = 'codex-session', firstUser = 'hello') {
  return [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {
        session_id: sessionId,
        id: sessionId,
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: 'C:/fixture/project',
      },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-01-01T00:00:01.000Z',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: firstUser }],
      },
    }),
  ]
}

test('Codex scan returns only unimported main sessions with real user messages', async () => {
  const { manifest, service } = setupService()
  const result = await service.scanCodex(codexFixtures)

  assert.equal(result.total, 1)
  assert.equal(result.items[0].sourceSessionId, '00000000-0000-0000-0000-0000004c')
  assert.equal(result.items[0].source, 'codex')
  assert.equal(result.items[0].title, '关于管理后台，居然没有做删除功能吗？我想删除一些草稿都不行啊。然后再就是现在的文章编辑又出现重大bug，内容编辑怎么也用不了？然后从新建文章到发布文章的流程呢？现在只有保存草稿。你可以用localhost:3000/admin去debug\n')
  assert.equal(result.items[0].badLines, 0)
  assert.ok(result.items[0].sizeBytes > 0)
  await manifest.close()
})

test('Codex scan excludes subagent, empty, and non-real-user sessions', async () => {
  const { manifest, service } = setupService()
  const result = await service.scanCodex(codexFixtures)

  const ids = result.items.map((item) => item.sourceSessionId)
  assert.ok(!ids.includes('00000000-0000-0000-0000-0000004a'), 'codex-normal has no real user and must be excluded')
  assert.ok(!ids.includes('00000000-0000-0000-0000-00000054'), 'subagent session must be excluded')
  assert.ok(!ids.includes('00000000-0000-0000-0000-00000052'), 'empty session must be excluded')
  await manifest.close()
})

test('bad lines are skipped and counted by the Codex reader', async () => {
  const parsed = await readCodexFile(path.join(badLineFixtures, 'codex-bad-line.jsonl'))
  assert.ok(parsed.badLines >= 1)
  assert.ok(parsed.records.length >= 1)
  assert.equal(parsed.summary.hasRealUserMessage, false)
})

test('Codex import counts bad lines in the report while still importing the session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-codex-import-'))
  const file = path.join(dir, 'rollout-codex-bad.jsonl')
  const lines = [
    ...simpleCodexSessionLines('codex-with-bad-line'),
    '{this is not valid json',
  ]
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')

  const { manifest, service } = setupService()
  try {
    const report = await service.importCodex([{ sourceSessionId: 'codex-with-bad-line' }], dir)
    assert.equal(report.success, 1)
    assert.equal(report.failed, 0)
    assert.equal(report.items[0].badLines, 1)
  } finally {
    await manifest.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('session_index.jsonl thread title beats first user text when different', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-codex-title-'))
  fs.writeFileSync(path.join(dir, 'rollout-title.jsonl'), `${simpleCodexSessionLines('title-session').join('\n')}\n`, 'utf8')
  fs.writeFileSync(path.join(dir, 'session_index.jsonl'), `${JSON.stringify({ id: 'title-session', thread_name: 'Thread Title' })}\n`, 'utf8')

  const { manifest, service } = setupService()
  try {
    const result = await service.scanCodex(dir)
    assert.equal(result.total, 1)
    assert.equal(result.items[0].title, 'Thread Title')
  } finally {
    await manifest.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('session_index.jsonl thread title is ignored when equal to first user text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-codex-title-'))
  const firstUser = 'same title'
  fs.writeFileSync(path.join(dir, 'rollout-title.jsonl'), `${simpleCodexSessionLines('title-session', firstUser).join('\n')}\n`, 'utf8')
  fs.writeFileSync(path.join(dir, 'session_index.jsonl'), `${JSON.stringify({ id: 'title-session', thread_name: firstUser })}\n`, 'utf8')

  const { manifest, service } = setupService()
  try {
    const result = await service.scanCodex(dir)
    assert.equal(result.total, 1)
    assert.equal(result.items[0].title, firstUser)
  } finally {
    await manifest.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Codex scan covers sessions and archived_sessions subdirectories', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-codex-dirs-'))
  const sessionsDir = path.join(dir, 'sessions', '2026', '08')
  const archivedDir = path.join(dir, 'archived_sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  fs.mkdirSync(archivedDir, { recursive: true })
  fs.writeFileSync(path.join(sessionsDir, 'rollout-active.jsonl'), `${simpleCodexSessionLines('active-session', 'active prompt').join('\n')}\n`, 'utf8')
  fs.writeFileSync(path.join(archivedDir, 'rollout-archived.jsonl'), `${simpleCodexSessionLines('archived-session', 'archived prompt').join('\n')}\n`, 'utf8')

  const { manifest, service } = setupService()
  try {
    const result = await service.scanCodex(dir)
    assert.equal(result.total, 2)
    const ids = result.items.map((item) => item.sourceSessionId)
    assert.ok(ids.includes('active-session'))
    assert.ok(ids.includes('archived-session'))
  } finally {
    await manifest.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex-dev.db local_thread_catalog title is read read-only', async (t) => {
  let DatabaseSync
  try {
    ({ DatabaseSync } = require('node:sqlite'))
  } catch {
    t.skip('node:sqlite is unavailable')
    return
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-codex-sqlite-'))
  const sqliteDir = path.join(dir, 'sqlite')
  fs.mkdirSync(sqliteDir, { recursive: true })
  const dbPath = path.join(sqliteDir, 'codex-dev.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE local_thread_catalog (thread_id TEXT PRIMARY KEY, display_title TEXT)')
  db.prepare('INSERT INTO local_thread_catalog (thread_id, display_title) VALUES (?, ?)').run('sqlite-session', 'SQLite Thread Title')
  db.close()

  const dbBefore = {
    bytes: fs.readFileSync(dbPath),
    mtimeMs: fs.statSync(dbPath).mtimeMs,
  }
  fs.writeFileSync(path.join(dir, 'rollout-sqlite.jsonl'), `${simpleCodexSessionLines('sqlite-session').join('\n')}\n`, 'utf8')

  const { manifest, service } = setupService()
  try {
    const result = await service.scanCodex(dir)
    assert.equal(result.total, 1)
    assert.equal(result.items[0].title, 'SQLite Thread Title')
    assert.equal(await resolveCodexTitle(dir, 'sqlite-session'), 'SQLite Thread Title')
    const dbAfter = {
      bytes: fs.readFileSync(dbPath),
      mtimeMs: fs.statSync(dbPath).mtimeMs,
    }
    assert.deepEqual(dbAfter.bytes, dbBefore.bytes)
    assert.equal(dbAfter.mtimeMs, dbBefore.mtimeMs)
  } finally {
    await manifest.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex-dev.db threads table title is read read-only', async (t) => {
  let DatabaseSync
  try {
    ({ DatabaseSync } = require('node:sqlite'))
  } catch {
    t.skip('node:sqlite is unavailable')
    return
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-codex-threads-'))
  const sqliteDir = path.join(dir, 'sqlite')
  fs.mkdirSync(sqliteDir, { recursive: true })
  const dbPath = path.join(sqliteDir, 'codex-dev.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)')
  db.prepare('INSERT INTO threads (id, title) VALUES (?, ?)').run('threads-session', 'Threads Title')
  db.close()

  fs.writeFileSync(path.join(dir, 'rollout-threads.jsonl'), `${simpleCodexSessionLines('threads-session').join('\n')}\n`, 'utf8')

  const { manifest, service } = setupService()
  try {
    const result = await service.scanCodex(dir)
    assert.equal(result.total, 1)
    assert.equal(result.items[0].title, 'Threads Title')
  } finally {
    await manifest.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('convertCodexRecords maps message, reasoning, function_call, and function_call_output', () => {
  const records = [
    {
      value: {
        type: 'response_item',
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'msg-1',
          content: [{ type: 'output_text', text: 'Let me check.' }],
        },
      },
      line: 1,
    },
    {
      value: {
        type: 'response_item',
        timestamp: '2026-01-01T00:00:01.000Z',
        payload: {
          type: 'reasoning',
          id: 'rs-1',
          summary: [{ type: 'summary_text', text: 'Reasoning summary' }],
        },
      },
      line: 2,
    },
    {
      value: {
        type: 'response_item',
        timestamp: '2026-01-01T00:00:02.000Z',
        payload: {
          type: 'function_call',
          id: 'fc-1',
          call_id: 'call-1',
          name: 'shell_command',
          arguments: '{"command":"ls"}',
        },
      },
      line: 3,
    },
    {
      value: {
        type: 'response_item',
        timestamp: '2026-01-01T00:00:03.000Z',
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: 'ok',
        },
      },
      line: 4,
    },
  ]

  const result = convertCodexRecords(records, { knowTool: (name) => name === 'shell_command' })

  assert.equal(result.knownToolCalls, 1)
  assert.equal(result.textCardToolCalls, 0)
  assert.ok(result.events.some((event) => event.type === 'reasoning-block' || event.data?.message?.content?.some((block) => block.type === 'reasoning')))
  assert.ok(result.events.some((event) => event.type === 'tool/call' && event.data.name === 'shell_command'))
  assert.ok(result.events.some((event) => event.type === 'tool/result'))
})

test('convertCodexRecords degrades unknown function calls to read-only text cards', () => {
  const records = [
    {
      value: {
        type: 'response_item',
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: {
          type: 'function_call',
          id: 'fc-2',
          call_id: 'call-2',
          name: 'custom_codex_tool',
          arguments: '{"x":1}',
        },
      },
      line: 1,
    },
    {
      value: {
        type: 'response_item',
        timestamp: '2026-01-01T00:00:01.000Z',
        payload: {
          type: 'function_call_output',
          call_id: 'call-2',
          output: 'done',
        },
      },
      line: 2,
    },
  ]

  const result = convertCodexRecords(records, { knowTool: () => false })

  assert.equal(result.knownToolCalls, 0)
  assert.equal(result.textCardToolCalls, 2)
  assert.ok(!result.events.some((event) => event.type === 'tool/call'))
  assert.ok(!result.events.some((event) => event.type === 'tool/result'))
  assert.ok(result.events.some((event) => event.type === 'assistant/message' && JSON.stringify(event.data).includes('[tool_call: custom_codex_tool')))
})

test('convertCodexRecords preserves event_msg-only user messages without duplicating response_item users', () => {
  const records = [
    {
      value: {
        type: 'event_msg',
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: { type: 'user_message', message: 'event only prompt' },
      },
      line: 1,
    },
    {
      value: {
        type: 'response_item',
        timestamp: '2026-01-01T00:00:01.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'event only prompt' }],
        },
      },
      line: 2,
    },
    {
      value: {
        type: 'event_msg',
        timestamp: '2026-01-01T00:00:02.000Z',
        payload: { type: 'user_message', message: 'second event prompt' },
      },
      line: 3,
    },
  ]

  const result = convertCodexRecords(records, { knowTool: () => false })
  const userMessages = result.events.filter((event) => event.type === 'user/message')
  const texts = userMessages.map((event) => event.data.content?.[0]?.text)
  assert.equal(texts.filter((text) => text === 'event only prompt').length, 1)
  assert.ok(texts.includes('second event prompt'))
})

test('Codex import writes through the official session seed path and records manifest', async () => {
  const { ctx, manifest, service } = setupService()
  const report = await service.importCodex([
    { sourceSessionId: '00000000-0000-0000-0000-0000004c' },
  ], codexFixtures)

  assert.equal(report.success, 1)
  assert.equal(report.failed, 0)
  assert.equal(report.skipped, 0)
  assert.equal(report.items[0].status, 'success')

  const prepareCall = ctx.$calls.sessions.find((call) => call.op === 'prepare')
  assert.ok(prepareCall, 'expected sessions.prepare to be called')
  assert.ok(Array.isArray(prepareCall.args[1].seed), 'expected seed events')
  assert.equal(prepareCall.args[1].meta.cwd, 'C:\\fixture\\project')
  assert.equal(prepareCall.args[1].meta.createdAt > 0, true)

  const record = await manifest.getBySource('codex', '00000000-0000-0000-0000-0000004c')
  assert.ok(record)
  assert.equal(record.source, 'codex')
  assert.equal(record.dshSessionId, report.items[0].dshSessionId)
  await manifest.close()
})

test('Codex import skips already imported sessions', async () => {
  const { manifest, service } = setupService()
  const first = await service.importCodex([
    { sourceSessionId: '00000000-0000-0000-0000-0000004c' },
  ], codexFixtures)
  assert.equal(first.success, 1)

  const second = await service.importCodex([
    { sourceSessionId: '00000000-0000-0000-0000-0000004c' },
  ], codexFixtures)

  assert.equal(second.success, 0)
  assert.equal(second.skipped, 1)
  assert.equal(second.items[0].reason, 'Already imported')
  await manifest.close()
})

test('Codex import reports failed target when session is not in scan queue', async () => {
  const { manifest, service } = setupService()
  const report = await service.importCodex([
    { sourceSessionId: 'missing-session' },
  ], codexFixtures)

  assert.equal(report.failed, 1)
  assert.equal(report.success, 0)
  assert.match(report.items[0].reason, /not in the unimported scan queue/)
  await manifest.close()
})

test('Codex source files remain untouched by scan and import', async () => {
  const { manifest, service } = setupService()
  await service.scanCodex(codexFixtures)
  await service.importCodex([{ sourceSessionId: '00000000-0000-0000-0000-0000004c' }], codexFixtures)
  // The global fixture before/after guard in fixtures.test.js asserts bytes/mtime.
  await manifest.close()
})

test('summarizeCodexRecords keeps IDE context injections out of real user detection', () => {
  const records = [
    { value: { type: 'session_meta', payload: { session_id: 's1', cwd: 'C:/p', timestamp: '2026-01-01T00:00:00Z' } }, line: 1 },
    { value: { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<turn_aborted>\nThe user interrupted' }] } }, line: 2 },
    { value: { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'real prompt' }] } }, line: 3 },
  ]
  const summary = summarizeCodexRecords(records, { sizeBytes: 1, mtimeMs: 1 }, 's1')
  assert.equal(summary.hasRealUserMessage, true)
  assert.equal(summary.firstUserText, 'real prompt')
  assert.equal(summary.title, 'real prompt')
})
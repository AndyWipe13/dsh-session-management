import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createFakeContext } from './helpers/fake-services.js'
import { openManifestStore } from '../lib/manifest.js'
import { createSessionManagementService } from '../lib/service.js'
import { createClaudeSourceReader, convertClaudeRecords, readClaudeFile, summarizeClaudeRecords } from '../lib/claude.js'

const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const claudeFixtures = path.join(fixturesRoot, 'claude-code')
const badLineFixtures = path.join(fixturesRoot, 'bad-line')

function setupService(options = {}) {
  const ctx = createFakeContext()
  const manifest = openManifestStore(ctx.storageDomain)
  const service = createSessionManagementService(ctx, manifest, {
    claude: createClaudeSourceReader(),
    ...options,
  })
  return { ctx, manifest, service }
}

test('Claude scan returns only unimported main sessions with real user messages', async () => {
  const { manifest, service } = setupService()
  const result = await service.scanClaude(claudeFixtures)

  assert.equal(result.total, 1)
  assert.equal(result.items[0].sourceSessionId, '00000000-0000-0000-0000-00000000')
  assert.equal(result.items[0].source, 'claude-code')
  assert.equal(result.items[0].title, '目前ticket3完成了，但我对这个推文的卡片设计还是不太满意，我觉得这个页面设计的还是不好看，你能重新设计一个原型UI让我看看吗')
  assert.equal(result.items[0].badLines, 0)
  assert.ok(result.items[0].sizeBytes > 0)
  await manifest.close()
})

test('Claude scan excludes subagent and empty sessions', async () => {
  const { manifest, service } = setupService()
  const result = await service.scanClaude(claudeFixtures)

  const ids = result.items.map((item) => item.sourceSessionId)
  assert.ok(!ids.includes('00000000-0000-0000-0000-0000003e'), 'subagent session must be excluded')
  assert.ok(!ids.includes('00000000-0000-0000-0000-00000039'), 'empty session must be excluded')
  await manifest.close()
})

test('bad lines are skipped and counted by the Claude reader', async () => {
  const parsed = await readClaudeFile(path.join(badLineFixtures, 'claude-bad-line.jsonl'))
  assert.ok(parsed.badLines >= 1)
  assert.ok(parsed.records.length >= 1)
  assert.equal(parsed.summary.hasRealUserMessage, false)
})

test('Claude import counts bad lines in the report while still importing the session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-claude-import-'))
  const file = path.join(dir, 'session-with-bad-line.jsonl')
  const lines = [
    JSON.stringify({
      type: 'user',
      isMeta: false,
      sessionId: 'session-with-bad-line',
      cwd: 'C:/fixture/project',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'hello' },
    }),
    '{this is not valid json',
  ]
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')

  const { manifest, service } = setupService()
  try {
    const report = await service.importClaude([{ sourceSessionId: 'session-with-bad-line' }], dir)
    assert.equal(report.success, 1)
    assert.equal(report.failed, 0)
    assert.equal(report.items[0].badLines, 1)
  } finally {
    await manifest.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('custom-title beats first user message in Claude titles', () => {
  const records = [
    { value: { type: 'user', isMeta: false, message: { content: 'first question' }, timestamp: '2026-01-01T00:00:00Z' }, line: 1 },
    { value: { type: 'custom-title', customTitle: 'Manual Title', timestamp: '2026-01-01T00:00:01Z' }, line: 2 },
  ]
  const summary = summarizeClaudeRecords(records, { sizeBytes: 1, mtimeMs: 1 }, 'session-1')
  assert.equal(summary.title, 'Manual Title')
  assert.equal(summary.hasRealUserMessage, true)
})

test('Claude import writes through the official session seed path and records manifest', async () => {
  const { ctx, manifest, service } = setupService()
  const report = await service.importClaude([
    { sourceSessionId: '00000000-0000-0000-0000-00000000' },
  ], claudeFixtures)

  assert.equal(report.success, 1)
  assert.equal(report.failed, 0)
  assert.equal(report.skipped, 0)
  assert.equal(report.items[0].status, 'success')

  const prepareCall = ctx.$calls.sessions.find((call) => call.op === 'prepare')
  assert.ok(prepareCall, 'expected sessions.prepare to be called')
  assert.ok(Array.isArray(prepareCall.args[1].seed), 'expected seed events')
  assert.equal(prepareCall.args[1].meta.cwd, 'C:\\fixture\\project')
  assert.equal(prepareCall.args[1].meta.createdAt > 0, true)

  assert.ok(ctx.$calls.sessions.some((call) => call.op === 'announce'))
  assert.ok(ctx.$calls.sessions.some((call) => call.op === 'enter-dispose'))

  const record = await manifest.getBySource('claude-code', '00000000-0000-0000-0000-00000000')
  assert.ok(record)
  assert.equal(record.source, 'claude-code')
  assert.equal(record.dshSessionId, report.items[0].dshSessionId)
  await manifest.close()
})

test('Claude import skips already imported sessions', async () => {
  const { manifest, service } = setupService()
  const first = await service.importClaude([
    { sourceSessionId: '00000000-0000-0000-0000-00000000' },
  ], claudeFixtures)
  assert.equal(first.success, 1)

  const second = await service.importClaude([
    { sourceSessionId: '00000000-0000-0000-0000-00000000' },
  ], claudeFixtures)

  assert.equal(second.success, 0)
  assert.equal(second.skipped, 1)
  assert.equal(second.items[0].reason, 'Already imported')
  await manifest.close()
})

test('Claude import reports failed target when session is not in scan queue', async () => {
  const { manifest, service } = setupService()
  const report = await service.importClaude([
    { sourceSessionId: 'missing-session' },
  ], claudeFixtures)

  assert.equal(report.failed, 1)
  assert.equal(report.success, 0)
  assert.match(report.items[0].reason, /not in the unimported scan queue/)
  await manifest.close()
})

test('convertClaudeRecords maps known tool_use/tool_result to DSH tool events', () => {
  const records = [
    {
      value: {
        type: 'assistant',
        uuid: 'assistant-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      line: 1,
    },
    {
      value: {
        type: 'user',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok', is_error: false }],
        },
      },
      line: 2,
    },
  ]

  const result = convertClaudeRecords(records, { knowTool: (name) => name === 'Bash' })

  assert.equal(result.knownToolCalls, 1)
  assert.equal(result.textCardToolCalls, 0)
  assert.ok(result.events.some((event) => event.type === 'tool/call' && event.data.name === 'Bash'))
  assert.ok(result.events.some((event) => event.type === 'tool/result'))
  const assistant = result.events.find((event) => event.type === 'assistant/message')
  assert.ok(assistant.data.message.content.some((block) => block.type === 'tool-call' && block.name === 'Bash'))
})

test('convertClaudeRecords degrades unknown tools to read-only text cards', () => {
  const records = [
    {
      value: {
        type: 'assistant',
        uuid: 'assistant-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_2', name: 'CustomTool', input: { x: 1 } }],
        },
      },
      line: 1,
    },
    {
      value: {
        type: 'user',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_2', content: 'done', is_error: false }],
        },
      },
      line: 2,
    },
  ]

  const result = convertClaudeRecords(records, { knowTool: () => false })

  assert.equal(result.knownToolCalls, 0)
  assert.equal(result.textCardToolCalls, 2)
  assert.ok(!result.events.some((event) => event.type === 'tool/call'))
  assert.ok(!result.events.some((event) => event.type === 'tool/result'))
  const assistant = result.events.find((event) => event.type === 'assistant/message')
  assert.ok(assistant.data.message.content.some((block) => block.type === 'text' && block.text.includes('[tool_use: CustomTool')))
})

test('Claude source files remain untouched by scan and import', async () => {
  const { manifest, service } = setupService()
  await service.scanClaude(claudeFixtures)
  await service.importClaude([{ sourceSessionId: '00000000-0000-0000-0000-00000000' }], claudeFixtures)
  // The global fixture before/after guard in fixtures.test.js asserts bytes/mtime;
  // this test additionally ensures the service path itself does not throw.
  await manifest.close()
})
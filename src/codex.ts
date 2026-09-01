/**
 * Codex import slice.
 *
 * This module owns the filesystem-facing Codex rollout JSONL scanning/parsing
 * plus the pure transcript -> DSH event conversion.  The SessionManagement
 * service remains filesystem-free; it receives a `CodexSourceReader` (usually
 * `createCodexSourceReader()`) so tests can drive the same seam with fakes or
 * real fixture directories.
 *
 * Read-only contract: every function here only reads source files and the
 * Codex sqlite title index.  No Codex file or database is ever modified,
 * moved, or deleted.
 */

import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export interface CodexFileStat {
  sizeBytes: number
  mtimeMs: number
}

export interface CodexRecord {
  /** Parsed JSON object from one valid line. */
  value: Record<string, any>
  /** 1-based line number in the source file. */
  line: number
}

export interface CodexFileSummary {
  /** Codex rollout session id; falls back to the file basename when absent. */
  sourceSessionId: string
  cwd?: string
  projectName?: string
  title?: string
  /** First real user text, used by the title priority rule. */
  firstUserText?: string
  createdAt: number
  updatedAt: number
  messageCount: number
  hasRealUserMessage: boolean
  isSubagent: boolean
}

export interface CodexParsedFile {
  summary: CodexFileSummary
  records: CodexRecord[]
  badLines: number
}

export interface CodexSourceReader {
  listCodexFiles(root: string): Promise<string[]>
  readCodexFile(filePath: string): Promise<CodexParsedFile>
  stat(filePath: string): Promise<CodexFileStat>
  resolveTitle(root: string, sourceSessionId: string): Promise<string | undefined>
}

/** A minimal DSH session event shape produced by the converter. */
export interface CodexDshEvent {
  type: string
  seq: number
  time: number
  data: Record<string, any>
  surfaceOp?: 'append'
}

export interface CodexDshHeader {
  cwd?: string
  createdAt: number
}

export interface CodexConversionResult {
  dshSessionId: string
  header: CodexDshHeader
  events: CodexDshEvent[]
  knownToolCalls: number
  textCardToolCalls: number
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  return undefined
}

function payloadOf(value: Record<string, any>): Record<string, any> | undefined {
  return isRecord(value.payload) ? value.payload : undefined
}

function recordTimestamp(value: Record<string, any>): number | undefined {
  const raw = value.timestamp ?? value.time ?? value.createdAt
  if (raw == null) return undefined
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const parts: string[] = []
  for (const block of value) {
    if (!isRecord(block)) continue
    if (block.type === 'input_text' || block.type === 'output_text' || block.type === 'text') {
      if (typeof block.text === 'string') parts.push(block.text)
    } else if (block.type === 'input_image') {
      parts.push('[image]')
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

function isCodexInjectedText(text: string | undefined): boolean {
  if (!text) return true
  const trimmed = text.trim()
  if (!trimmed) return true
  if (trimmed.startsWith('<command-name>')) return true
  if (trimmed.startsWith('<command-message>')) return true
  if (trimmed.startsWith('<local-command')) return true
  if (trimmed.startsWith('<turn_aborted>')) return true
  if (trimmed.startsWith('<system-reminder>')) return true
  if (trimmed.startsWith('<EXTERNAL SESSION IMPORTED>')) return true
  // Slash commands are not real prompts.
  if (/^\s*\//.test(trimmed)) return true
  // Compaction/IDE context injections are not the user's own first prompt.
  if (/^This session is being continued from a previous conversation/i.test(trimmed)) return true
  if (/^The following is the Codex agent history/i.test(trimmed)) return true
  return false
}

function userTextFromMessagePayload(payload: Record<string, any>): string | undefined {
  const text = contentText(payload.content)
  if (isCodexInjectedText(text)) return undefined
  return text
}

function eventMsgUserText(value: Record<string, any>): string | undefined {
  const payload = payloadOf(value)
  if (!payload || payload.type !== 'user_message') return undefined
  const text = typeof payload.message === 'string' ? payload.message : contentText(payload.content)
  if (isCodexInjectedText(text)) return undefined
  return text
}

function assistantTextBlocks(content: unknown): Array<{ type: 'text'; text: string }> {
  const out: Array<{ type: 'text'; text: string }> = []
  if (!Array.isArray(content)) return out
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'output_text' || block.type === 'input_text' || block.type === 'text') {
      if (typeof block.text === 'string') out.push({ type: 'text', text: block.text })
    } else if (block.type === 'input_image') {
      out.push({ type: 'text', text: '[image]' })
    }
  }
  return out
}

function reasoningText(payload: Record<string, any>): string | undefined {
  const summary = payload.summary
  if (Array.isArray(summary)) {
    const parts: string[] = []
    for (const entry of summary) {
      if (!isRecord(entry)) continue
      if (entry.type === 'summary_text' && typeof entry.text === 'string') parts.push(entry.text)
    }
    if (parts.length > 0) return parts.join('\n')
  }
  if (typeof payload.text === 'string' && payload.text.length > 0) return payload.text
  if (typeof payload.content === 'string' && payload.content.length > 0) return payload.content
  return undefined
}

function projectNameOf(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = normalized.split('/').filter(Boolean).pop()
  return base || undefined
}

function isSubagentPayload(payload: Record<string, any> | undefined): boolean {
  if (!payload) return false
  if (payload.thread_source === 'subagent') return true
  if (payload.source === 'subagent') return true
  return isRecord(payload.source) && isRecord(payload.source.subagent)
}

/**
 * Pure summary of a parsed Codex rollout.  External title sources
 * (`session_index.jsonl` / sqlite) are applied by `applyCodexThreadTitle`.
 */
export function summarizeCodexRecords(
  records: readonly CodexRecord[],
  stat: CodexFileStat,
  fallbackSessionId?: string,
): CodexFileSummary {
  let sourceSessionId = ''
  let cwd: string | undefined
  let createdAt = 0
  let updatedAt = 0
  let messageCount = 0
  let isSubagent = false
  let firstUserText: string | undefined

  for (const record of records) {
    const value = record.value
    const payload = payloadOf(value)
    const timestamp = recordTimestamp(value) ?? (payload ? recordTimestamp(payload) : undefined)
    if (timestamp) {
      if (createdAt === 0 || timestamp < createdAt) createdAt = timestamp
      if (timestamp > updatedAt) updatedAt = timestamp
    }

    if (value.type === 'session_meta') {
      if (!sourceSessionId && payload) {
        sourceSessionId = asString(payload.session_id) ?? asString(payload.id) ?? ''
      }
      if (!cwd && payload) cwd = asString(payload.cwd)
      if (payload && isSubagentPayload(payload)) isSubagent = true
    }

    if (value.type === 'response_item' && payload?.type === 'message') {
      if (typeof payload.role === 'string') messageCount++
      if (payload.role === 'user' && !firstUserText) {
        firstUserText = userTextFromMessagePayload(payload)
      }
    }

    if (value.type === 'event_msg' && payload?.type === 'user_message' && !firstUserText) {
      firstUserText = eventMsgUserText(value)
    }
  }

  if (!sourceSessionId) sourceSessionId = fallbackSessionId ?? ''
  const projectName = projectNameOf(cwd)
  const title = firstUserText ?? projectName

  return {
    sourceSessionId: sourceSessionId || fallbackSessionId || '',
    cwd,
    projectName,
    title,
    firstUserText,
    createdAt: createdAt || stat.mtimeMs,
    updatedAt: updatedAt || stat.mtimeMs,
    messageCount,
    hasRealUserMessage: Boolean(firstUserText),
    isSubagent,
  }
}

/**
 * Apply the Codex thread-title priority: only use the external title when it
 * differs from the first real user text; otherwise keep the fallback title.
 */
export function applyCodexThreadTitle(
  summary: CodexFileSummary,
  threadTitle: string | undefined,
): CodexFileSummary {
  if (!threadTitle || !summary.firstUserText) return summary
  if (threadTitle.trim() === summary.firstUserText.trim()) return summary
  return { ...summary, title: threadTitle }
}

/** The default Codex home directory on this machine. */
export function defaultCodexHome(): string {
  return path.join(os.homedir(), '.codex')
}

/** Expand `~` / empty input to a concrete Codex home. */
export function resolveCodexHome(input: string | undefined): string {
  if (!input || !input.trim()) return defaultCodexHome()
  const trimmed = input.trim()
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), ...trimmed.slice(2).split(/[\\/]+/).filter(Boolean))
  }
  return trimmed
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return stat.isDirectory()
  } catch {
    return false
  }
}

const SKIPPED_METADATA_FILES = new Set([
  'session_index.jsonl',
  'transcription-history.jsonl',
])

/**
 * Recursively list Codex rollout `.jsonl` files.  When the given root is a
 * Codex home containing `sessions/` + `archived_sessions/`, only those two
 * directories are scanned; otherwise the root itself is scanned recursively.
 */
export async function listCodexFiles(root: string): Promise<string[]> {
  const sessionsDir = path.join(root, 'sessions')
  const archivedDir = path.join(root, 'archived_sessions')
  const hasSessions = await isDirectory(sessionsDir)
  const hasArchived = await isDirectory(archivedDir)
  const scanRoots = hasSessions || hasArchived
    ? [...(hasSessions ? [sessionsDir] : []), ...(hasArchived ? [archivedDir] : [])]
    : [root]

  const out: string[] = []
  for (const scanRoot of scanRoots) {
    const stack = [scanRoot]
    while (stack.length > 0) {
      const dir = stack.pop()!
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (error: any) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          stack.push(full)
        } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !SKIPPED_METADATA_FILES.has(entry.name)) {
          out.push(full)
        }
      }
    }
  }
  return out.sort()
}

/**
 * Read one Codex rollout JSONL file.  Malformed lines are skipped and counted;
 * every valid line is returned in order for high-fidelity conversion.
 */
export async function readCodexFile(filePath: string): Promise<CodexParsedFile> {
  const stat = await fs.stat(filePath)
  const records: CodexRecord[] = []
  let badLines = 0

  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let lineNumber = 0
  for await (const line of rl) {
    lineNumber++
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const value = JSON.parse(trimmed)
      if (!isRecord(value)) {
        badLines++
        continue
      }
      records.push({ value, line: lineNumber })
    } catch {
      badLines++
    }
  }

  const fallbackSessionId = path.basename(filePath, path.extname(filePath))
  const summary = summarizeCodexRecords(records, {
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
  }, fallbackSessionId)

  return { summary, records, badLines }
}

async function readSessionIndexTitle(root: string, sourceSessionId: string): Promise<string | undefined> {
  const candidates = [
    path.join(root, 'session_index.jsonl'),
    path.join(root, '..', 'session_index.jsonl'),
    path.join(root, 'sessions', '..', 'session_index.jsonl'),
  ]
  for (const file of candidates) {
    const resolved = path.resolve(file)
    if (!await pathExists(resolved)) continue
    try {
      const stream = createReadStream(resolved, { encoding: 'utf8' })
      const rl = createInterface({ input: stream, crlfDelay: Infinity })
      for await (const line of rl) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const entry = JSON.parse(trimmed)
          if (!isRecord(entry)) continue
          const id = asString(entry.id) ?? asString(entry.session_id)
          if (!id || id !== sourceSessionId) continue
          const title = asString(entry.thread_name) ?? asString(entry.title)
          if (title) return title
        } catch {
          // Skip malformed index lines; the index is best-effort metadata.
        }
      }
    } catch {
      // Ignore unreadable index; the rollout itself is still importable.
    }
  }
  return undefined
}

function sqliteCandidates(root: string): string[] {
  const direct = [
    path.join(root, 'sqlite', 'codex-dev.db'),
    path.join(root, 'codex-dev.db'),
  ]
  const parent = path.resolve(path.join(root, '..'))
  return [
    ...direct,
    path.join(parent, 'sqlite', 'codex-dev.db'),
    path.join(parent, 'codex-dev.db'),
  ]
}

function querySqliteTitle(file: string, sourceSessionId: string): string | undefined {
  try {
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => {
        prepare(sql: string): {
          get(...params: unknown[]): Record<string, unknown> | undefined
          all(...params: unknown[]): Record<string, unknown>[]
        }
        close(): void
      }
    }
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('local_thread_catalog', 'threads')",
      ).all() as Array<{ name: string }>
      for (const table of tables) {
        const info = db.prepare(`PRAGMA table_info(${table.name})`).all() as Array<{ name: string }>
        const idCol = info.find((col) => col.name === 'thread_id' || col.name === 'id')
        const titleCol = info.find((col) => col.name === 'display_title' || col.name === 'title' || col.name === 'thread_name')
        if (!idCol || !titleCol) continue
        const row = db.prepare(
          `SELECT ${titleCol.name} AS title FROM ${table.name} WHERE ${idCol.name} = ?`,
        ).get(sourceSessionId) as { title?: unknown } | undefined
        if (row) {
          const title = asString(row.title)
          if (title) return title
        }
      }
    } finally {
      db.close()
    }
  } catch {
    // node:sqlite may be unavailable on older hosts; title lookup degrades.
  }
  return undefined
}

/**
 * Resolve a Codex thread title from `session_index.jsonl` and
 * `sqlite/codex-dev.db` (or a sibling of the current root).  The database is
 * opened read-only; both `local_thread_catalog` and the older `threads` table
 * shapes are supported.
 */
export async function resolveCodexTitle(root: string, sourceSessionId: string): Promise<string | undefined> {
  const fromIndex = await readSessionIndexTitle(root, sourceSessionId)
  if (fromIndex) return fromIndex

  for (const file of sqliteCandidates(root)) {
    const resolved = path.resolve(file)
    if (!await pathExists(resolved)) continue
    const fromDb = querySqliteTitle(resolved, sourceSessionId)
    if (fromDb) return fromDb
  }
  return undefined
}

export function createCodexSourceReader(): CodexSourceReader {
  return {
    listCodexFiles,
    readCodexFile: readCodexFile as (filePath: string) => Promise<CodexParsedFile>,
    async stat(filePath) {
      const info = await fs.stat(filePath)
      return { sizeBytes: info.size, mtimeMs: info.mtimeMs }
    },
    resolveTitle: resolveCodexTitle,
  }
}

function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

function reasoningBlock(text: string): { type: 'reasoning'; text: string } {
  return { type: 'reasoning', text }
}

function toolCallBlock(id: string, name: string, args: string): { type: 'tool-call'; id: string; name: string; arguments: string } {
  return {
    type: 'tool-call',
    id,
    name,
    arguments: args,
  }
}

function normalizeArguments(value: unknown): string {
  if (typeof value === 'string') return value
  if (value !== undefined) return JSON.stringify(value)
  return ''
}

function textCardForToolCall(name: string, id: string | undefined, args: string): { type: 'text'; text: string } {
  return textBlock(`[tool_call: ${name}${id ? ` (${id})` : ''}]\n${args}`)
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const block of value) {
      if (isRecord(block) && typeof block.text === 'string') parts.push(block.text)
      else if (block !== undefined) parts.push(typeof block === 'string' ? block : JSON.stringify(block))
    }
    return parts.join('\n')
  }
  return value !== undefined ? JSON.stringify(value) : ''
}

function textCardForToolOutput(callId: string | undefined, output: unknown): { type: 'text'; text: string } {
  return textBlock(`[tool_result${callId ? `: ${callId}` : ''}]\n${outputText(output)}`)
}

function toolResultContent(output: unknown): Array<{ type: 'text'; text: string }> {
  return [textBlock(outputText(output))]
}

/**
 * Convert a parsed Codex rollout into a minimal but valid DSH session event
 * stream.  Known DSH tools map to `tool/call` + `tool/result`; unknown tools
 * degrade to read-only text cards (ADR-0002) instead of faking an executable
 * tool event.
 */
function responseItemUserTexts(records: readonly CodexRecord[]): Set<string> {
  const texts = new Set<string>()
  for (const record of records) {
    const value = record.value
    const payload = payloadOf(value)
    if (value.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'user') continue
    const text = userTextFromMessagePayload(payload)
    if (text) texts.add(text.trim())
  }
  return texts
}

export function convertCodexRecords(
  records: readonly CodexRecord[],
  opts: {
    dshSessionId?: string
    knowTool(name: string): boolean
  } = { knowTool: () => false },
): CodexConversionResult {
  const dshSessionId = opts.dshSessionId ?? `session-${randomUUID()}`
  const events: CodexDshEvent[] = []
  let cwd: string | undefined
  let createdAt = 0
  let updatedAt = 0
  const knownCalls = new Map<string, { name: string; known: boolean }>()
  let knownToolCalls = 0
  let textCardToolCalls = 0
  let seq = 0
  let turn = 0
  let step = 1
  let currentTurn: number | undefined
  let currentStep: number | undefined
  let pendingReasoning: Array<{ type: 'reasoning'; text: string }> = []
  const responseUserTexts = responseItemUserTexts(records)

  const push = (type: string, time: number, data: Record<string, any>, surfaceOp?: 'append'): void => {
    events.push({
      type,
      seq: seq++,
      time,
      data,
      ...(surfaceOp ? { surfaceOp } : {}),
    })
  }

  const closeTurn = (time: number): void => {
    if (currentStep !== undefined) {
      push('step/end', time, { turn: currentTurn, step: currentStep })
      currentStep = undefined
    }
    if (currentTurn !== undefined) {
      push('turn/end', time, { turn: currentTurn, reason: { kind: 'completed' } })
      currentTurn = undefined
    }
  }

  const openTurn = (time: number): void => {
    closeTurn(time)
    turn++
    step = 1
    currentTurn = turn
    currentStep = step
    push('turn/start', time, { turn })
    push('step/start', time, { turn, step })
  }

  const ensureTurn = (time: number): void => {
    if (currentTurn === undefined) openTurn(time)
  }

  const flushReasoning = (time: number): void => {
    if (pendingReasoning.length === 0) return
    ensureTurn(time)
    push('assistant/message', time, {
      turn: currentTurn,
      step: currentStep,
      message: {
        role: 'assistant',
        content: pendingReasoning,
        source: { kind: 'model', provider: 'codex', model: 'unknown' },
        id: `msg-${randomUUID()}`,
      },
    }, 'append')
    pendingReasoning = []
  }

  for (const record of records) {
    const value = record.value
    const payload = payloadOf(value)
    const timestamp = recordTimestamp(value) ?? (payload ? recordTimestamp(payload) : undefined)
    if (timestamp) {
      if (createdAt === 0 || timestamp < createdAt) createdAt = timestamp
      if (timestamp > updatedAt) updatedAt = timestamp
    }
    const time = timestamp ?? updatedAt ?? Date.now()

    if (value.type === 'session_meta') {
      if (!cwd && payload) cwd = asString(payload.cwd)
      continue
    }

    if (value.type === 'event_msg' && payload?.type === 'user_message') {
      const text = eventMsgUserText(value)
      if (text && !responseUserTexts.has(text.trim())) {
        ensureTurn(time)
        push('user/message', time, {
          role: 'user',
          content: [textBlock(text)],
          source: { kind: 'user' },
          id: `msg-${randomUUID()}`,
        }, 'append')
      }
      continue
    }

    if (value.type !== 'response_item' || !payload) continue

    if (payload.type === 'message') {
      if (payload.role === 'user') {
        const text = userTextFromMessagePayload(payload)
        if (!text) continue
        ensureTurn(time)
        push('user/message', time, {
          role: 'user',
          content: [textBlock(text)],
          source: { kind: 'user' },
          id: `msg-${typeof payload.id === 'string' ? payload.id : randomUUID()}`,
        }, 'append')
        continue
      }

      if (payload.role === 'assistant') {
        const blocks = assistantTextBlocks(payload.content)
        if (blocks.length === 0 && pendingReasoning.length === 0) continue
        ensureTurn(time)
        const content = [...pendingReasoning, ...blocks]
        pendingReasoning = []
        push('assistant/message', time, {
          turn: currentTurn,
          step: currentStep,
          message: {
            role: 'assistant',
            content,
            source: { kind: 'model', provider: 'codex', model: 'unknown' },
            id: `msg-${typeof payload.id === 'string' ? payload.id : randomUUID()}`,
          },
        }, 'append')
        continue
      }

      continue
    }

    if (payload.type === 'reasoning') {
      const text = reasoningText(payload)
      if (text) pendingReasoning.push(reasoningBlock(text))
      continue
    }

    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      ensureTurn(time)
      flushReasoning(time)
      const id = typeof payload.id === 'string' ? payload.id : randomUUID()
      const callId = typeof payload.call_id === 'string' ? payload.call_id : id
      const name = typeof payload.name === 'string' ? payload.name : 'unknown-tool'
      const args = normalizeArguments(payload.arguments ?? payload.input)
      const known = opts.knowTool(name)
      knownCalls.set(callId, { name, known })
      if (known) {
        knownToolCalls++
        push('assistant/message', time, {
          turn: currentTurn,
          step: currentStep,
          message: {
            role: 'assistant',
            content: [toolCallBlock(id, name, args)],
            source: { kind: 'model', provider: 'codex', model: 'unknown' },
            id: `msg-${id}`,
          },
        }, 'append')
        push('tool/call', time, {
          turn: currentTurn,
          step: currentStep,
          callId,
          name,
          arguments: args,
        })
      } else {
        textCardToolCalls++
        push('assistant/message', time, {
          turn: currentTurn,
          step: currentStep,
          message: {
            role: 'assistant',
            content: [textCardForToolCall(name, id, args)],
            source: { kind: 'model', provider: 'codex', model: 'unknown' },
            id: `msg-${id}`,
          },
        }, 'append')
      }
      continue
    }

    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      ensureTurn(time)
      const callId = typeof payload.call_id === 'string' ? payload.call_id : ''
      const call = callId ? knownCalls.get(callId) : undefined
      if (call?.known) {
        push('tool/result', time, {
          turn: currentTurn,
          step: currentStep,
          message: {
            role: 'user',
            content: [{
              type: 'tool-result',
              toolCallId: callId,
              content: toolResultContent(payload.output),
            }],
            source: { kind: 'tool', callId },
            id: `msg-${callId}`,
          },
        }, 'append')
      } else {
        textCardToolCalls++
        push('user/message', time, {
          role: 'user',
          content: [textCardForToolOutput(callId || undefined, payload.output)],
          source: { kind: 'user' },
          id: `msg-${callId || randomUUID()}`,
        }, 'append')
      }
      continue
    }

    // Other tool-like Codex items (web_search_call, tool_search_call, etc.)
    // are not DSH executable tools; preserve them as read-only text cards.
    if (payload.type === 'web_search_call' || payload.type === 'tool_search_call') {
      ensureTurn(time)
      flushReasoning(time)
      textCardToolCalls++
      const id = typeof payload.id === 'string' ? payload.id : randomUUID()
      const name = payload.type === 'web_search_call' ? 'web_search' : 'tool_search'
      const args = normalizeArguments(payload.action ?? payload.arguments)
      push('assistant/message', time, {
        turn: currentTurn,
        step: currentStep,
        message: {
          role: 'assistant',
          content: [textCardForToolCall(name, id, args)],
          source: { kind: 'model', provider: 'codex', model: 'unknown' },
          id: `msg-${id}`,
        },
      }, 'append')
      continue
    }

    if (payload.type === 'web_search_output' || payload.type === 'tool_search_output') {
      ensureTurn(time)
      textCardToolCalls++
      const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined
      push('user/message', time, {
        role: 'user',
        content: [textCardForToolOutput(callId, payload.output ?? payload.tools ?? '')],
        source: { kind: 'user' },
        id: `msg-${callId || randomUUID()}`,
      }, 'append')
      continue
    }
  }

  flushReasoning(updatedAt || Date.now())
  closeTurn(updatedAt || Date.now())

  return {
    dshSessionId,
    header: { cwd, createdAt: createdAt || Date.now() },
    events,
    knownToolCalls,
    textCardToolCalls,
  }
}
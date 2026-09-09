/**
 * Codex import slice.
 *
 * This module owns the Codex dialect: rollout JSONL record interpretation
 * (summarize + pure transcript -> DSH event conversion) plus the external
 * title index (session_index.jsonl / read-only sqlite). Dialect-neutral
 * plumbing lives in jsonl-source.ts, and the SessionManagement service stays
 * filesystem-free behind the `ImportSourceAdapter` seam.
 *
 * Read-only contract: every function here only reads source files and the
 * Codex sqlite title index.  No Codex file or database is ever modified,
 * moved, or deleted.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { ImportSourceAdapter } from './import-queue.js'
import { FidelityMapping, type FidelityContentBlock } from './fidelity.js'
import { asString, isRecord, projectNameOf, readJsonlFile, recordTimestamp,
  resolveHomeRoot, statSourceFile, walkJsonlFiles,
  type SourceFileStat, type SourceRecord } from './jsonl-source.js'

const require = createRequire(import.meta.url)

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
  records: SourceRecord[]
  badLines: number
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

function payloadOf(value: Record<string, any>): Record<string, any> | undefined {
  return isRecord(value.payload) ? value.payload : undefined
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

function isSubagentPayload(payload: Record<string, any> | undefined): boolean {
  if (!payload) return false
  if (payload.thread_source === 'subagent') return true
  if (payload.source === 'subagent') return true
  return isRecord(payload.source) && isRecord(payload.source.subagent)
}

/**
 * Pure summary of a parsed Codex rollout.  External title sources
 * (`session_index.jsonl` / sqlite) are applied by the import queue's
 * title-priority rule.
 */
export function summarizeCodexRecords(
  records: readonly SourceRecord[],
  stat: SourceFileStat,
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

/** The default Codex home directory on this machine. */
export function defaultCodexHome(): string {
  return path.join(os.homedir(), '.codex')
}

/** Expand `~` / empty input to a concrete Codex home. */
export function resolveCodexHome(input: string | undefined): string {
  return resolveHomeRoot(input, defaultCodexHome)
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
  return walkJsonlFiles(scanRoots, (name) => SKIPPED_METADATA_FILES.has(name))
}

/**
 * Read one Codex rollout JSONL file: shared streaming parse, dialect summary.
 */
export async function readCodexFile(filePath: string): Promise<CodexParsedFile> {
  const { stat, records, badLines } = await readJsonlFile(filePath)
  const fallbackSessionId = path.basename(filePath, path.extname(filePath))
  const summary = summarizeCodexRecords(records, stat, fallbackSessionId)
  return { summary, records, badLines }
}

async function readSessionIndexTitles(root: string, sourceSessionIds: readonly string[]): Promise<Map<string, string>> {
  const wanted = new Set(sourceSessionIds)
  const titles = new Map<string, string>()
  const candidates = [
    path.join(root, 'session_index.jsonl'),
    path.join(root, '..', 'session_index.jsonl'),
    path.join(root, 'sessions', '..', 'session_index.jsonl'),
  ]
  const seen = new Set<string>()
  for (const file of candidates) {
    const resolved = path.resolve(file)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    if (!await pathExists(resolved)) continue
    try {
      const { records } = await readJsonlFile(resolved)
      for (const record of records) {
        const entry = record.value
        const id = asString(entry.id) ?? asString(entry.session_id)
        if (!id || !wanted.has(id) || titles.has(id)) continue
        const title = asString(entry.thread_name) ?? asString(entry.title)
        if (title) titles.set(id, title)
      }
    } catch {
      // Ignore unreadable index; the rollout itself is still importable.
    }
  }
  return titles
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

function querySqliteTitles(file: string, sourceSessionIds: readonly string[]): Map<string, string> {
  const titles = new Map<string, string>()
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
        const statement = db.prepare(
          `SELECT ${titleCol.name} AS title FROM ${table.name} WHERE ${idCol.name} = ?`,
        )
        for (const sourceSessionId of sourceSessionIds) {
          if (titles.has(sourceSessionId)) continue
          const row = statement.get(sourceSessionId) as { title?: unknown } | undefined
          if (row) {
            const title = asString(row.title)
            if (title) titles.set(sourceSessionId, title)
          }
        }
      }
    } finally {
      db.close()
    }
  } catch {
    // node:sqlite may be unavailable on older hosts; title lookup degrades.
  }
  return titles
}

/**
 * Resolve a Codex thread title from `session_index.jsonl` and
 * `sqlite/codex-dev.db` (or a sibling of the current root).  The database is
 * opened read-only; both `local_thread_catalog` and the older `threads` table
 * shapes are supported.
 */
export async function resolveCodexTitle(root: string, sourceSessionId: string): Promise<string | undefined> {
  return (await resolveCodexTitles(root, [sourceSessionId])).get(sourceSessionId)
}

/** Resolve many titles while reading each index/database at most once. */
export async function resolveCodexTitles(root: string, sourceSessionIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const titles = await readSessionIndexTitles(root, sourceSessionIds)
  let missing = sourceSessionIds.filter((id) => !titles.has(id))
  if (missing.length === 0) return titles

  for (const file of sqliteCandidates(root)) {
    const resolved = path.resolve(file)
    if (!await pathExists(resolved)) continue
    for (const [id, title] of querySqliteTitles(resolved, missing)) titles.set(id, title)
    missing = missing.filter((id) => !titles.has(id))
    if (missing.length === 0) break
  }
  return titles
}

/** Codex adapter at the import-queue seam. */
export function createCodexImportAdapter(root?: string): ImportSourceAdapter {
  return {
    source: 'codex',
    resolveRoot: (input) => resolveCodexHome(input ?? root),
    listFiles: listCodexFiles,
    read: readCodexFile,
    stat: statSourceFile,
    enrichTitles: (scanRoot, files) => resolveCodexTitles(scanRoot, files.map((file) => file.summary.sourceSessionId)),
    convert: (records, options) => convertCodexRecords(records as readonly SourceRecord[], options),
  }
}

/**
 * Convert a parsed Codex rollout into a minimal but valid DSH session event
 * stream.  Known DSH tools map to `tool/call` + `tool/result`; unknown tools
 * degrade to read-only text cards (ADR-0002) instead of faking an executable
 * tool event.
 */
function responseItemUserTexts(records: readonly SourceRecord[]): Set<string> {
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
  records: readonly SourceRecord[],
  opts: {
    dshSessionId?: string
    knowTool(name: string): boolean
  } = { knowTool: () => false },
): CodexConversionResult {
  const dshSessionId = opts.dshSessionId ?? `session-${randomUUID()}`
  const mapping = new FidelityMapping(opts.knowTool)
  let cwd: string | undefined
  let createdAt = 0
  let updatedAt = 0
  let pendingReasoning: FidelityContentBlock[] = []
  const responseUserTexts = responseItemUserTexts(records)

  const flushReasoning = (time: number): void => {
    if (pendingReasoning.length === 0) return
    mapping.assistantMessage(time, pendingReasoning, { provider: 'codex', model: 'unknown' })
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
        mapping.openTurn(time)
        mapping.userMessage(time, [mapping.text(text)])
      }
      continue
    }

    if (value.type !== 'response_item' || !payload) continue

    if (payload.type === 'message') {
      if (payload.role === 'user') {
        const text = userTextFromMessagePayload(payload)
        if (!text) continue
        mapping.openTurn(time)
        mapping.userMessage(time, [mapping.text(text)], `msg-${typeof payload.id === 'string' ? payload.id : randomUUID()}`)
        continue
      }

      if (payload.role === 'assistant') {
        const blocks = assistantTextBlocks(payload.content)
        if (blocks.length === 0 && pendingReasoning.length === 0) continue
        mapping.ensureTurn(time)
        const content = [...pendingReasoning, ...blocks]
        pendingReasoning = []
        mapping.assistantMessage(time, content, { provider: 'codex', model: 'unknown' }, `msg-${typeof payload.id === 'string' ? payload.id : randomUUID()}`)
        continue
      }

      continue
    }

    if (payload.type === 'reasoning') {
      const text = reasoningText(payload)
      if (text) pendingReasoning.push(mapping.reasoning(text))
      continue
    }

    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      mapping.ensureTurn(time)
      flushReasoning(time)
      const id = typeof payload.id === 'string' ? payload.id : randomUUID()
      const callId = typeof payload.call_id === 'string' ? payload.call_id : id
      const name = typeof payload.name === 'string' ? payload.name : 'unknown-tool'
      const args = mapping.arguments(payload.arguments ?? payload.input)
      const call = mapping.registerTool(callId, name)
      if (call.known) {
        mapping.assistantMessage(time, [mapping.toolCallBlock(id, name, args)], { provider: 'codex', model: 'unknown' }, `msg-${id}`)
        mapping.toolCall(time, callId, name, args)
      } else {
        mapping.assistantMessage(time, [mapping.toolCallCard('tool_call', name, id, args)], { provider: 'codex', model: 'unknown' }, `msg-${id}`)
      }
      continue
    }

    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      mapping.ensureTurn(time)
      const callId = typeof payload.call_id === 'string' ? payload.call_id : ''
      const call = callId ? mapping.tool(callId) : undefined
      if (call?.known) {
        mapping.toolResult(time, callId, payload.output)
      } else {
        mapping.userMessage(time, [mapping.toolResultCard(callId || undefined, payload.output)], `msg-${callId || randomUUID()}`)
      }
      continue
    }

    // Other tool-like Codex items (web_search_call, tool_search_call, etc.)
    // are not DSH executable tools; preserve them as read-only text cards.
    if (payload.type === 'web_search_call' || payload.type === 'tool_search_call') {
      mapping.ensureTurn(time)
      flushReasoning(time)
      const id = typeof payload.id === 'string' ? payload.id : randomUUID()
      const name = payload.type === 'web_search_call' ? 'web_search' : 'tool_search'
      const args = mapping.arguments(payload.action ?? payload.arguments)
      mapping.assistantMessage(time, [mapping.toolCallCard('tool_call', name, id, args)], { provider: 'codex', model: 'unknown' }, `msg-${id}`)
      continue
    }

    if (payload.type === 'web_search_output' || payload.type === 'tool_search_output') {
      mapping.ensureTurn(time)
      const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined
      mapping.userMessage(time, [mapping.toolResultCard(callId, payload.output ?? payload.tools ?? '')], `msg-${callId || randomUUID()}`)
      continue
    }
  }

  flushReasoning(updatedAt || Date.now())
  mapping.closeTurn(updatedAt || Date.now())

  return {
    dshSessionId,
    header: { cwd, createdAt: createdAt || Date.now() },
    events: mapping.events,
    knownToolCalls: mapping.knownToolCalls,
    textCardToolCalls: mapping.textCardToolCalls,
  }
}

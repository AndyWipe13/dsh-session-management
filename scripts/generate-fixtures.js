#!/usr/bin/env node
/**
 * Regenerate the test fixture bank from local real Claude Code / Codex / DSH
 * session files. Source paths come from environment variables or common local
 * defaults; DSH artifacts are decompressed (multi-frame zstd). All output is
 * desensitized: real user paths become fixture paths and UUIDs are replaced by
 * stable fake UUIDs.
 *
 * This script is a developer convenience. The committed fixtures under
 * test/fixtures are the source of truth for tests; they must stay read-only.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const home = process.env.USERPROFILE || process.env.HOME || ''
const fixtureRoot = path.join(root, 'test', 'fixtures')

const sources = {
  claudeDir:
    process.env.CLAUDE_SOURCE_DIR ||
    path.join(home, '.claude', 'projects', 'C--AI-------Dev2Agent'),
  codexDir: process.env.CODEX_SOURCE_DIR || path.join(home, '.codex', 'sessions'),
  codexArchivedDir:
    process.env.CODEX_ARCHIVED_DIR || path.join(home, '.codex', 'archived_sessions'),
  dshDir: process.env.DSH_SOURCE_DIR || path.join(home, '.dsh', 'sessions'),
}

const uuidPattern = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g
const uuidMap = new Map()
let uuidCounter = 0
function fakeUuid() {
  const hex = (uuidCounter++).toString(16).padStart(12, '0')
  return `00000000-0000-0000-${hex.slice(0, 4)}-${hex.slice(4)}`
}

function sanitizeText(text) {
  let out = text
  // Real absolute paths observed on the generating machine.
  const pathReplacements = [
    ['C:\\Users\\26716', 'C:\\Users\\fixture'],
    ['C:/Users/26716', 'C:/Users/fixture'],
    ['C:\\AI应用开发学习\\Dev2Agent', 'C:\\fixture\\project'],
    ['C:\\AI-Application\\Dev2Agent', 'C:\\fixture\\project'],
    ['C:\\AI-Application\\dsh-session-management', 'C:\\fixture\\dsh-session-management'],
    ['C:\\AI-Application\\router', 'C:\\fixture\\router'],
    ['C:\\games', 'C:\\fixture\\games'],
    ['C:\\Users\\fixture\\Documents\\Codex\\2026-08-15\\realtime-voice-chat', 'C:\\fixture\\project'],
  ]
  for (const [from, to] of pathReplacements) {
    // Replace both raw and JSON-escaped backslash forms.
    out = out.split(from).join(to)
    out = out.split(from.replace(/\\/g, '\\\\')).join(to.replace(/\\/g, '\\\\'))
  }

  // Real GitHub identity / project names observed on the generating machine.
  out = out.replace(/AndyWipe13/gi, 'fixture-user')
  out = out.replace(/AI应用开发学习/g, 'fixture')
  out = out.replace(/AI-Application/g, 'fixture')
  out = out.replace(/Dev2Agent/gi, 'fixture-project')
  out = out.replace(/github\.com\/fixture-user\/fixture-project\.git/g, 'github.com/fixture/project.git')
  out = out.replace(/vercel\.com\/fixture-users-projects/g, 'vercel.com/fixture-user-projects')
  out = out.replace(/dev2agent/gi, 'fixture-project')

  // Replace UUIDs with stable fake UUIDs.
  out = out.replace(uuidPattern, (match) => {
    if (!uuidMap.has(match)) uuidMap.set(match, fakeUuid())
    return uuidMap.get(match)
  })

  // Generic subagent ids.
  out = out.replace(/agent-[a-f0-9]{16,}/gi, 'agent-fake000000000000')

  return out
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n')
}

function writeFixture(relPath, lines) {
  const target = path.join(fixtureRoot, relPath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, lines.join('\n'), 'utf8')
}

function decodeDshZstd(file) {
  const buf = fs.readFileSync(file)
  const ZSTD_MAGIC = 4247762216
  const frames = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4) break
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid zstd magic at ${file}:${offset}`)
    offset += 4
    if (offset === buf.length) break
    const descriptor = buf.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame header at ${file}:${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buf.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buf.length - offset < 3) break
      const blockHeader = buf.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block at ${file}:${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buf.length - offset < payloadBytes) break
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buf.length - offset < 4) break
      offset += 4
    }
    frames.push({ start, end: offset })
  }

  const chunks = []
  for (const frame of frames) {
    chunks.push(zlib.zstdDecompressSync(buf.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function withoutTrailingEmpty(lines) {
  const out = lines.slice()
  while (out.length > 0 && out.at(-1) === '') out.pop()
  return out
}

function main() {
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
  fs.mkdirSync(fixtureRoot, { recursive: true })

  const required = [
    ['claudeDir', sources.claudeDir],
    ['codexDir', sources.codexDir],
    ['codexArchivedDir', sources.codexArchivedDir],
    ['dshDir', sources.dshDir],
  ]
  for (const [name, dir] of required) {
    if (!fs.existsSync(dir)) {
      throw new Error(`generate-fixtures: missing ${name} at ${dir}; set the corresponding env var`)
    }
  }

  const claudeFiles = fs.readdirSync(sources.claudeDir).filter((f) => f.endsWith('.jsonl')).sort()
  const codexFiles = fs.readdirSync(sources.codexDir, { recursive: true })
    .filter((f) => String(f).endsWith('.jsonl'))
    .map((f) => path.join(sources.codexDir, String(f)))
  const codexArchivedFiles = fs.readdirSync(sources.codexArchivedDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(sources.codexArchivedDir, f))
  const dshFiles = []
  for (const entry of fs.readdirSync(sources.dshDir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.jsonl.zstd')) {
      dshFiles.push(path.join(entry.parentPath ?? entry.path, entry.name))
    }
  }

  function pick(list, predicate, label) {
    const found = list.find(predicate)
    if (!found) throw new Error(`generate-fixtures: no ${label} file found`)
    return found
  }

  // Claude Code fixtures.
  const claudeNormal = pick(
    claudeFiles,
    (f) => f.startsWith('fec1a615-'),
    'Claude normal session',
  )
  const claudeEmpty = pick(claudeFiles, (f) => f.startsWith('bae6cb7b-'), 'Claude empty session')
  const claudeSubagentDir = path.join(sources.claudeDir, '486036cb-ecc3-4a92-b949-3b7d8333c7e1', 'subagents')
  const claudeSubagent = pick(
    fs.readdirSync(claudeSubagentDir).filter((f) => f.endsWith('.jsonl')),
    (f) => f.startsWith('agent-'),
    'Claude subagent session',
  )

  writeFixture(
    'claude-code/claude-normal.jsonl',
    sanitizeText(readLines(path.join(sources.claudeDir, claudeNormal)).join('\n')).split('\n'),
  )
  writeFixture(
    'claude-code/claude-empty.jsonl',
    sanitizeText(readLines(path.join(sources.claudeDir, claudeEmpty)).join('\n')).split('\n'),
  )
  writeFixture(
    'claude-code/claude-subagent.jsonl',
    sanitizeText(readLines(path.join(claudeSubagentDir, claudeSubagent)).slice(0, 10).join('\n')).split('\n'),
  )

  // Codex fixtures.
  const codexNormal = pick(codexFiles, (f) => f.includes('rollout-2026-08-07T20-54-52-019fdc4a-6c38'), 'Codex normal session')
  const codexArchived = pick(codexArchivedFiles, (f) => f.includes('rollout-2026-08-09T19-33-33'), 'Codex archived session')
  const codexEmptyFile = pick(codexArchivedFiles, (f) => f.includes('rollout-2026-08-15T12-41-30'), 'Codex empty session')
  const codexSubagent = pick(
    codexFiles,
    (f) => f.includes('rollout-2026-07-19T18-42-27-019f79f8-48fd-7f23-94f7-d71efa2b3fc2'),
    'Codex subagent session',
  )

  writeFixture(
    'codex/codex-normal.jsonl',
    sanitizeText(readLines(codexNormal).join('\n')).split('\n'),
  )
  writeFixture(
    'codex/codex-archived.jsonl',
    sanitizeText(readLines(codexArchived).slice(0, 6).join('\n')).split('\n'),
  )

  // Codex empty: keep a valid one-line session_meta but drop the bulky
  // base_instructions boilerplate; this is the "real shape" without megabytes.
  {
    const line = readLines(codexEmptyFile).find((l) => l.trim() !== '')
    const parsed = JSON.parse(sanitizeText(line))
    delete parsed.payload?.base_instructions
    writeFixture('codex/codex-empty.jsonl', [JSON.stringify(parsed)])
  }

  // Codex subagent: keep the session_meta (minus bulky base_instructions) and a
  // small set of following rows.
  {
    const lines = sanitizeText(readLines(codexSubagent).join('\n')).split('\n')
    const first = JSON.parse(lines[0])
    delete first.payload?.base_instructions
    writeFixture('codex/codex-subagent.jsonl', [JSON.stringify(first), ...withoutTrailingEmpty(lines).slice(1, 8)])
  }

  // DSH fixtures.
  const dshNormal = pick(dshFiles, (f) => f.includes('session-548cc39c-'), 'DSH normal session')
  const dshEmpty = pick(dshFiles, (f) => f.includes('session-6dec806b-'), 'DSH empty session')
  const dshNormalText = decodeDshZstd(dshNormal)
  const dshEmptyText = decodeDshZstd(dshEmpty)
  writeFixture('dsh/dsh-normal.jsonl', sanitizeText(dshNormalText).split('\n').slice(0, 40))
  // Header-only DSH empty fixture: a real header line from a real empty session.
  const dshEmptyLines = sanitizeText(dshEmptyText).split('\n').filter((line) => line.trim() !== '')
  writeFixture('dsh/dsh-empty.jsonl', dshEmptyLines.slice(0, 1))

  // Bad-line edge samples: valid lines plus one intentionally malformed line.
  writeFixture(
    'bad-line/claude-bad-line.jsonl',
    withoutTrailingEmpty(
      sanitizeText(readLines(path.join(sources.claudeDir, claudeNormal)).join('\n')).split('\n'),
    ).slice(0, 6).concat(['{this is not valid json']),
  )
  writeFixture(
    'bad-line/codex-bad-line.jsonl',
    withoutTrailingEmpty(sanitizeText(readLines(codexNormal).join('\n')).split('\n')).slice(0, 3).concat(['{"type": "malformed"']),
  )
  writeFixture(
    'bad-line/dsh-bad-line.jsonl',
    withoutTrailingEmpty(sanitizeText(dshNormalText).split('\n')).slice(0, 5).concat(['this line is not json']),
  )

  fs.writeFileSync(
    path.join(fixtureRoot, 'README.md'),
    `# Fixture Bank

Read-only regression fixtures for dsh-session-management.

## Provenance

Files are desensitized copies of real local Claude Code, Codex (including
\`archived_sessions\`) and DSH session logs from the generating machine. DSH
artifacts are stored as decompressed plaintext \`.jsonl\` for readability; the
original durable encoding is multi-frame zstd \`session.jsonl.zstd\`.

## Read-only contract

Tests MUST NOT modify, move, or delete any file under this directory. Before
and after a test run, every fixture file's bytes and mtime must be unchanged.
`,
  )

  console.log(`Fixtures written to ${fixtureRoot}`)
}

main()
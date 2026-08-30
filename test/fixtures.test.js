import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

function listFixtureFiles(dir = fixturesRoot) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFixtureFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

function readJsonLines(file) {
  const text = fs.readFileSync(file, 'utf8')
  return text.split('\n').filter((line) => line.trim() !== '')
}

const allFixtureFiles = listFixtureFiles()
const snapshots = new Map()

before(() => {
  for (const file of allFixtureFiles) {
    const stat = fs.statSync(file)
    snapshots.set(file, {
      bytes: fs.readFileSync(file),
      mtimeMs: stat.mtimeMs,
    })
  }
})

after(() => {
  for (const file of allFixtureFiles) {
    const beforeSnap = snapshots.get(file)
    assert.ok(beforeSnap, `missing before-snapshot for ${file}`)
    const stat = fs.statSync(file)
    assert.deepEqual(
      fs.readFileSync(file),
      beforeSnap.bytes,
      `fixture bytes changed after test run: ${file}`,
    )
    assert.equal(stat.mtimeMs, beforeSnap.mtimeMs, `fixture mtime changed after test run: ${file}`)
  }
})

test('fixture bank has at least two files per source category', () => {
  const byDir = {}
  for (const file of allFixtureFiles) {
    const rel = path.relative(fixturesRoot, file)
    const top = rel.split(path.sep)[0]
    byDir[top] ??= []
    byDir[top].push(rel)
  }

  for (const dir of ['claude-code', 'codex', 'dsh']) {
    assert.ok(
      (byDir[dir] ?? []).length >= 2,
      `expected at least 2 fixtures under ${dir}, got ${byDir[dir]?.length ?? 0}`,
    )
  }
  assert.ok((byDir['bad-line'] ?? []).length >= 1, 'expected at least one bad-line fixture')
})

test('codex archived fixtures are present', () => {
  const archived = allFixtureFiles.filter((f) => f.includes(path.join('codex', 'codex-archived')))
  assert.ok(archived.length >= 1, 'expected an archived Codex fixture')
})

test('edge samples exist: empty, subagent, Chinese/Unicode, bad-line', () => {
  const rels = allFixtureFiles.map((f) => path.relative(fixturesRoot, f).replace(/\\/g, '/'))

  assert.ok(rels.some((r) => r.includes('empty')), 'expected empty-session fixtures')
  assert.ok(rels.some((r) => r.includes('subagent')), 'expected subagent fixtures')
  assert.ok(rels.some((r) => r.includes('bad-line')), 'expected bad-line fixtures')

  const unicodeHit = allFixtureFiles.some((f) => /[\u3400-\u9fff]/.test(fs.readFileSync(f, 'utf8')))
  assert.ok(unicodeHit, 'expected at least one fixture with Chinese/Unicode content')
})

test('all non-bad fixture lines are valid JSON', () => {
  for (const file of allFixtureFiles) {
    if (file.includes('bad-line')) continue
    for (const [index, line] of readJsonLines(file).entries()) {
      assert.doesNotThrow(
        () => JSON.parse(line),
        `invalid JSON in ${path.relative(fixturesRoot, file)} at line ${index + 1}`,
      )
    }
  }
})

test('bad-line fixtures contain both valid rows and a malformed row', () => {
  for (const file of allFixtureFiles.filter((f) => f.includes('bad-line'))) {
    const lines = readJsonLines(file)
    assert.ok(lines.length >= 2, `${file} should have multiple rows`)
    const valid = lines.filter((line) => {
      try {
        JSON.parse(line)
        return true
      } catch {
        return false
      }
    })
    assert.ok(valid.length >= 1, `${file} should contain at least one valid row`)
    assert.ok(valid.length < lines.length, `${file} should contain at least one malformed row`)
  }
})

test('DSH empty fixture is header-only', () => {
  const empty = allFixtureFiles.find((f) => f.endsWith(path.join('dsh', 'dsh-empty.jsonl')))
  assert.ok(empty, 'missing dsh/dsh-empty.jsonl')
  const lines = readJsonLines(empty)
  assert.equal(lines.length, 1, 'DSH empty session should only contain the header line')
  const header = JSON.parse(lines[0])
  assert.equal(header.type, 'session')
  assert.equal(header.version, 0)
})

test('subagent fixtures expose the expected marker', () => {
  const claudeSub = allFixtureFiles.find((f) => f.endsWith(path.join('claude-code', 'claude-subagent.jsonl')))
  const codexSub = allFixtureFiles.find((f) => f.endsWith(path.join('codex', 'codex-subagent.jsonl')))

  assert.ok(claudeSub, 'missing Claude subagent fixture')
  const claudeText = fs.readFileSync(claudeSub, 'utf8')
  assert.match(claudeText, /isSidechain|agentId/)

  assert.ok(codexSub, 'missing Codex subagent fixture')
  const codexText = fs.readFileSync(codexSub, 'utf8')
  assert.match(codexText, /"source"\s*:\s*\{[^}]*"subagent"|subagent/)
})
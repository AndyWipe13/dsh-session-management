#!/usr/bin/env node
// Cross-platform build for @nathan110628/dsh-session-management.
// Uses a DSH source checkout (DSH_CHECKOUT) or, when absent, the installed
// dependency mirror at ~/.dsh/profiles/node_modules. Compiles src/ -> lib/.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
process.chdir(root)

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true })
}

function link(linkPath, target) {
  rmrf(linkPath)
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

// The globally installed `dsh` CLI ships its own full @deepseek-ai dependency
// set; use it when the profile mirror lacks a package (the mirror is a trimmed
// snapshot that can lag the CLI, e.g. cordis was removed from it).
function dshCliDeepseekAi() {
  const res = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' })
  if (res.status !== 0 || !res.stdout?.trim()) return ''
  const dir = path.join(res.stdout.trim(), '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
  return fs.existsSync(path.join(dir, 'cordis')) ? dir : ''
}

const home = process.env.HOME || process.env.USERPROFILE || process.cwd()
let checkout = process.env.DSH_CHECKOUT || ''
if (!checkout) {
  for (const c of [path.join(home, 'dsh-harness'), path.join(home, 'dsh'), path.join(home, '.dsh', 'dsh-harness')]) {
    if (fs.existsSync(path.join(c, 'packages'))) {
      checkout = c
      break
    }
  }
}

let mirror = ''
if (checkout && fs.existsSync(path.join(checkout, 'packages'))) {
  console.log(`=== Source checkout mode: ${checkout} ===`)
} else {
  mirror = process.env.DSH_PROFILE_NODE_MODULES || path.join(home, '.dsh', 'profiles', 'node_modules')
  if (!fs.existsSync(path.join(mirror, '@deepseek-ai'))) {
    throw new Error('build: cannot locate dsh source checkout or dependency mirror (set DSH_CHECKOUT or DSH_PROFILE_NODE_MODULES)')
  }
  checkout = ''
  console.log(`=== Dependency mirror mode: ${mirror} ===`)
}

console.log('=== Linking build dependencies ===')
if (mirror) {
  let deepseekAi = path.join(mirror, '@deepseek-ai')
  if (!fs.existsSync(path.join(deepseekAi, 'cordis'))) {
    const cliDeps = dshCliDeepseekAi()
    if (cliDeps) deepseekAi = cliDeps
  }
  link(path.join(root, 'node_modules', '@deepseek-ai'), deepseekAi)
  // The mirror only carries what past profiles installed and may lack @types/node;
  // when it does, keep the npm-installed local @types instead of replacing it.
  if (fs.existsSync(path.join(mirror, '@types', 'node'))) {
    link(path.join(root, 'node_modules', '@types'), path.join(mirror, '@types'))
  }
  link(path.join(root, 'node_modules', '@standard-schema'), path.join(mirror, '@standard-schema'))
} else {
  fs.mkdirSync(path.join(root, 'node_modules', '@deepseek-ai'), { recursive: true })
  const linkSources = [
    ['node_modules/@deepseek-ai/cordis', 'vendor/cordis'],
    ['node_modules/@deepseek-ai/cosmokit', 'vendor/cosmokit'],
    ['node_modules/@deepseek-ai/schemastery', 'vendor/schemastery'],
    ['node_modules/@deepseek-ai/dsh-tools', 'packages/core/tools'],
    ['node_modules/@deepseek-ai/dsh-llm', 'packages/llm/llm'],
    ['node_modules/@deepseek-ai/dsh-system-prompt', 'packages/core/system-prompt'],
    ['node_modules/@types/node', 'node_modules/@types/node'],
  ]
  for (const [rel, src] of linkSources) {
    link(path.join(root, rel), path.join(checkout, src))
  }
  const pnpmStore = path.join(checkout, 'node_modules', '.pnpm')
  if (fs.existsSync(pnpmStore)) {
    const std = fs.readdirSync(pnpmStore).find((name) => name.toLowerCase().startsWith('@standard-schema+spec@'))
    if (std) {
      link(path.join(root, 'node_modules', '@standard-schema', 'spec'), path.join(pnpmStore, std, 'node_modules', '@standard-schema', 'spec'))
    }
  }
}

let tsc = path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js')
if (!fs.existsSync(tsc) && checkout) {
  tsc = path.join(checkout, 'node_modules', 'typescript', 'lib', 'tsc.js')
}
if (!fs.existsSync(tsc)) {
  throw new Error("build: tsc not found; run 'npm install' (typescript) first or set DSH_CHECKOUT")
}

console.log('=== Compiling src -> lib ===')
const res = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { stdio: 'inherit' })
if (res.status !== 0) {
  process.exit(res.status ?? 1)
}
console.log('=== Build complete ===')
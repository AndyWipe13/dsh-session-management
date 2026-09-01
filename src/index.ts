/**
 * @dsh-external/dsh-session-management — 会话管理插件。
 *
 * Issue #3 落地读路径全栈：
 * - SessionManagement 服务面（list/search/preview）作为单一测试接缝；
 * - import manifest 存储单元（初始为空）用于来源反查；
 * - Agent 工具 list_sessions / search_sessions / preview_session / archive_session / unarchive_session；
 * - Host HTTP API 供设置页薄 UI 消费（client 半区见 client.js）。
 */
import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { openManifestStore } from './manifest.js'
import { createClaudeSourceReader, resolveClaudeProjectsRoot } from './claude.js'
import { createCodexSourceReader, resolveCodexHome } from './codex.js'
import { createSessionManagementService } from './service.js'
import { registerSessionTools } from './tools.js'
import { registerSessionApi } from './web.js'

export const name = '@dsh-external/dsh-session-management'
export const inject = ['tools', 'sessions', 'agents', 'sessionQuery', 'sessionPersistence', 'workspaceRegistry', 'storageDomain']

export interface Config {
  /** Claude Code projects root. Empty means auto-detect `~/.claude/projects`. */
  claudePath?: string
  /** Codex home. Empty means auto-detect `~/.codex`. */
  codexPath?: string
}

export const Config = z.object({
  claudePath: z.string().default(''),
  codexPath: z.string().default(''),
})

export function apply(ctx: Context, config: Config): void {
  const services = ctx as unknown as {
    storageDomain: { open(spec: unknown): Promise<unknown> }
    tools: { register(tool: unknown): () => void }
    webServer?: {
      register(route: unknown): () => void
    }
    on?(event: string, listener: (exec: unknown, next: () => unknown) => unknown): unknown
  }

  const manifest = openManifestStore(services.storageDomain)
  const service = createSessionManagementService(ctx as never, manifest, {
    claudePath: resolveClaudeProjectsRoot(config.claudePath),
    codexPath: resolveCodexHome(config.codexPath),
    claude: createClaudeSourceReader(),
    codex: createCodexSourceReader(),
    deleter: async (location) => {
      // The persistence locate() points at the session log file; the whole
      // session directory is the DSH-side artifact we remove.
      await rm(path.dirname(location.path), { recursive: true, force: true })
    },
  })

  ctx.effect(() => () => {
    void manifest.close()
  }, '@dsh-external/dsh-session-management: import manifest')

  ctx.effect(() => registerSessionTools(services, service), '@dsh-external/dsh-session-management: session tools')
  ctx.effect(() => registerSessionApi(services, service), '@dsh-external/dsh-session-management: settings api')
}
/**
 * Agent tools for dsh-session-management.
 *
 * These tools are deliberately thin: they parse/validate args, call the
 * SessionManagement service, and render the canonical result for the model.
 * No business logic lives here.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ImportReport, SessionDeleteResult, SessionListFilter, SessionManagementService, SessionListItem } from './service.js'

interface ToolContext {
  tools: {
    register(tool: unknown): () => void
  }
  on?(event: string, listener: (exec: unknown, next: () => unknown) => unknown): unknown
}

const sourceEnum = ['dsh', 'claude-code', 'codex'] as const

function formatList(items: readonly SessionListItem[], total: number): string {
  if (items.length === 0) return `No sessions found (total ${total}).`
  const lines = items.map((item) => {
    const flags = [
      item.running ? 'running' : '',
      item.archived ? 'archived' : '',
    ].filter(Boolean).join(',')
    const sizeMb = (item.sizeBytes / 1024 / 1024).toFixed(1)
    const snippet = item.snippet ? ` snippet="${item.snippet}"` : ''
    return `- ${item.title ?? item.id} [${item.source}] updated=${new Date(item.updatedAt).toISOString()} size=${sizeMb}MB messages=${item.messageCount}${flags ? ` (${flags})` : ''}${snippet}`
  })
  return `Found ${total} session(s):\n${lines.join('\n')}`
}

function formatPreview(value: Awaited<ReturnType<SessionManagementService['preview']>>): string {
  const lines = [
    `Session: ${value.title ?? value.id}`,
    `Source: ${value.source}`,
    `Path: ${value.cwd ?? '(none)'}`,
    `Created: ${new Date(value.createdAt).toISOString()}`,
    `Updated: ${new Date(value.updatedAt).toISOString()}`,
    `State: ${value.running ? 'running' : 'idle'}${value.archived ? ', archived' : ''}`,
    `Events: ${value.events.length}`,
  ]
  for (const event of value.events.slice(0, 100)) {
    const e = event as { type?: string; time?: number; data?: unknown }
    lines.push(`- [${e.type ?? 'event'}] ${JSON.stringify(e.data ?? '')}`)
  }
  return lines.join('\n')
}

function formatImportReport(report: ImportReport): string {
  const lines = [
    `Import complete: ${report.success} succeeded, ${report.skipped} skipped, ${report.failed} failed.`,
  ]
  for (const item of report.items) {
    const details = [
      item.path ?? item.sourceSessionId,
      item.status,
      item.dshSessionId ? `dsh=${item.dshSessionId}` : '',
      item.reason ?? '',
      item.badLines ? `badLines=${item.badLines}` : '',
    ].filter(Boolean)
    lines.push(`- ${details.join(' | ')}`)
  }
  return lines.join('\n')
}

function formatDeleteResult(result: SessionDeleteResult): string {
  if (result.deletedSessionIds.length === 0) return 'No sessions deleted.'
  const lines = result.deletedSessionIds.map((id, index) => {
    const path = result.paths[index]
    return `- ${id}${path ? ` at ${path}` : ''}`
  })
  return `Deleted ${result.deletedSessionIds.length} session(s):\n${lines.join('\n')}`
}

export function registerSessionTools(ctx: ToolContext, service: SessionManagementService): () => void {
  const disposers: Array<() => void> = []
  const register = (tool: unknown): void => {
    disposers.push(ctx.tools.register(tool))
  }
  const define = (options: any) => defineTool(options)

  register(define({
    name: 'list_sessions',
    description: 'List DSH native and imported sessions with optional source, archive-state, workspace, and title query filters.',
    parameters: {
      source: {
        type: 'string',
        enum: [...sourceEnum],
        description: 'Filter by session source: dsh, claude-code, or codex.',
      },
      archived: {
        type: 'boolean',
        description: 'When true list only archived sessions; when false list only active sessions. Omit for all.',
      },
      cwd: {
        type: 'string',
        description: 'Exact working directory filter.',
      },
      workspace: {
        type: 'string',
        description: 'Workspace/project name or path substring filter.',
      },
      query: {
        type: 'string',
        description: 'Optional title substring filter.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: { items: readonly SessionListItem[]; total: number }) => [
        { type: 'text', text: formatList(value.items, value.total) },
      ],
    },
    async execute(args: SessionListFilter) {
      return service.list(args)
    },
  }))

  register(define({
    name: 'search_sessions',
    description: 'Search DSH native and imported sessions by conversation body text (user/assistant/tool messages) with snippets, or by title when full-text search is disabled, combined with optional filters.',
    parameters: {
      query: {
        type: 'string',
        description: 'Text to search for in conversation body or title (depending on full-text configuration).',
        required: true,
      },
      source: {
        type: 'string',
        enum: [...sourceEnum],
        description: 'Filter by session source: dsh, claude-code, or codex.',
      },
      archived: {
        type: 'boolean',
        description: 'When true list only archived sessions; when false list only active sessions. Omit for all.',
      },
      workspace: {
        type: 'string',
        description: 'Workspace/project name or path substring filter.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: { items: readonly SessionListItem[]; total: number }) => [
        { type: 'text', text: formatList(value.items, value.total) },
      ],
    },
    async execute(args: { query: string } & Omit<SessionListFilter, 'query'>) {
      return service.search(args.query, args)
    },
  }))

  register(define({
    name: 'preview_session',
    description: 'Preview one DSH session history (title, metadata, and the official read-path event log).',
    parameters: {
      sessionId: {
        type: 'string',
        description: 'DSH session id to preview.',
        required: true,
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: Awaited<ReturnType<SessionManagementService['preview']>>) => [
        { type: 'text', text: formatPreview(value) },
      ],
    },
    async execute(args: { sessionId: string }) {
      return service.preview(args.sessionId)
    },
  }))

  register(define({
    name: 'archive_session',
    description: 'Archive one DSH session through the official workspace registry. Reversible; no approval required.',
    parameters: {
      sessionId: {
        type: 'string',
        description: 'DSH session id to archive.',
        required: true,
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: { sessionId: string; archived: boolean }) => [
        { type: 'text', text: `Archived session ${value.sessionId}.` },
      ],
    },
    async execute(args: { sessionId: string }) {
      await service.archive(args.sessionId)
      return { sessionId: args.sessionId, archived: true }
    },
  }))

  register(define({
    name: 'unarchive_session',
    description: 'Unarchive one DSH session through the internal workspace registry channel. Reversible; no approval required.',
    parameters: {
      sessionId: {
        type: 'string',
        description: 'DSH session id to unarchive.',
        required: true,
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: { sessionId: string; archived: boolean }) => [
        { type: 'text', text: `Unarchived session ${value.sessionId}.` },
      ],
    },
    async execute(args: { sessionId: string }) {
      await service.unarchive(args.sessionId)
      return { sessionId: args.sessionId, archived: false }
    },
  }))

  register(define({
    name: 'import_sessions',
    description: 'Import selected Claude Code or Codex sessions into DSH as native sessions through the official seed path. Already imported sessions are skipped.',
    parameters: {
      source: {
        type: 'string',
        enum: ['claude-code', 'codex'],
        description: 'Source to import from. Defaults to claude-code.',
      },
      sourceSessionIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Session ids to import, from a prior scan of the source directory.',
        required: true,
      },
      root: {
        type: 'string',
        description: 'Optional source root to scan (Claude projects root or Codex home). Defaults to plugin configuration.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: ImportReport) => [
        { type: 'text', text: formatImportReport(value) },
      ],
    },
    async execute(args: { source?: 'claude-code' | 'codex'; sourceSessionIds: readonly string[]; root?: string }) {
      const selections = args.sourceSessionIds.map((sourceSessionId) => ({ sourceSessionId }))
      return (args.source ?? 'claude-code') === 'codex'
        ? service.importCodex(selections, args.root)
        : service.importClaude(selections, args.root)
    },
  }))

  register(define({
    name: 'delete_sessions',
    description: 'Permanently delete DSH sessions. Requires the exact token DELETE and official user approval; deleted session logs are removed and cannot be recovered.',
    parameters: {
      sessionIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'DSH session ids to permanently delete.',
        required: true,
      },
      confirmToken: {
        type: 'string',
        description: 'Must equal DELETE to confirm permanent deletion.',
        required: true,
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: SessionDeleteResult) => [
        { type: 'text', text: formatDeleteResult(value) },
      ],
    },
    async execute(args: { sessionIds: readonly string[]; confirmToken: string }) {
      return service.deleteSessions(args.sessionIds, { confirmToken: args.confirmToken })
    },
  }))

  if (typeof ctx.on === 'function') {
    const disposeApproval = ctx.on('tools/pre-execute', async (exec: unknown, next: () => unknown) => {
      const execution = exec as { name?: string; arguments?: { sessionIds?: readonly string[] } } | undefined
      if (execution?.name === 'delete_sessions') {
        const targets = execution.arguments?.sessionIds
        const targetText = targets && targets.length > 0 ? targets.join(', ') : 'unknown session(s)'
        return { kind: 'ask', reason: `Permanently delete DSH session(s): ${targetText}. This action cannot be undone.` }
      }
      return next()
    })
    if (typeof disposeApproval === 'function') disposers.push(disposeApproval as () => void)
  }

  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}
/**
 * Host HTTP API backing the settings-page thin UI.
 *
 * The client half is a small DOM/React adapter; all business logic stays in
 * `SessionManagementService`.  This file maps HTTP GET read requests and
 * POST archive/unarchive requests to service calls and serializes JSON.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SessionSource } from './manifest.js'
import type { CleanupRule, ImportSelection, ImportSource, SessionManagementService } from './service.js'
import { sanitizeSessionIds } from './service.js'

interface WebServerLike {
  register(route: {
    kind: 'prefix' | 'exact'
    path: string
    handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  }): () => void
}

const API_PREFIX = '/@nathan110628/dsh-session-management/api'

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message })
}

function parseImportSource(value: unknown, fallback: ImportSource = 'claude-code'): ImportSource | undefined {
  const source = typeof value === 'string' && value.length > 0 ? value : fallback
  return source === 'claude-code' || source === 'codex' ? source : undefined
}

/** Reply 405 and report rejection when the request is not a POST. */
function rejectNonPost(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === 'POST') return false
  sendError(res, 405, 'Method not allowed')
  return true
}

/** First present string field among the alias keys (empty strings included). */
function stringField(body: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = body[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      raw += chunk
      if (raw.length > 1024 * 1024) {
        reject(new Error('Request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!raw) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {})
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function toBoolean(value: string | null): boolean | 'all' | undefined {
  if (value == null || value === 'all' || value === '') return undefined
  return value === 'true' || value === '1'
}

function toNumber(value: string | null): number | undefined {
  if (value == null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function toOptionalBoolean(value: string | null): boolean | undefined {
  const parsed = toBoolean(value)
  return parsed === 'all' || parsed === undefined ? undefined : parsed
}

export function registerSessionApi(ctx: { webServer?: WebServerLike }, service: SessionManagementService): () => void {
  const webServer = ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') return () => {}

  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname.replace(/\/+$/, '')
        const params = url.searchParams

        if (path === `${API_PREFIX}/repair-workspaces`) {
          if (rejectNonPost(req, res)) return
          sendJson(res, 200, await service.repairImportedWorkspaces())
          return
        }

        if (path === `${API_PREFIX}/stats`) {
          const result = await service.stats()
          sendJson(res, 200, result)
          return
        }

        if (path === `${API_PREFIX}/cleanup/preview`) {
          const rules: Partial<CleanupRule> = {
            olderThanDays: toNumber(params.get('olderThanDays')),
            largerThanMb: toNumber(params.get('largerThanMb')),
            emptySessions: toOptionalBoolean(params.get('emptySessions')),
            archivedOnly: toOptionalBoolean(params.get('archivedOnly')),
            source: (params.get('source') as CleanupRule['source'] | null) ?? undefined,
          }
          const result = await service.cleanupPreview(rules)
          sendJson(res, 200, result)
          return
        }

        if (path === `${API_PREFIX}/cleanup/execute`) {
          if (rejectNonPost(req, res)) return
          const body = await readJsonBody(req)
          const previewId = typeof body.previewId === 'string' ? body.previewId : ''
          const sessionIds = sanitizeSessionIds(body.sessionIds)
          const confirmToken = stringField(body, 'confirmToken', 'token')
          if (!previewId) {
            sendError(res, 400, 'Missing previewId')
            return
          }
          if (sessionIds.length === 0) {
            sendError(res, 400, 'Missing sessionIds')
            return
          }
          const result = await service.cleanupExecute(sessionIds, { confirmToken, previewId })
          sendJson(res, 200, result)
          return
        }

        if (path === `${API_PREFIX}/list` || path === `${API_PREFIX}/search`) {
          const query = params.get('query') ?? params.get('q') ?? undefined
          const filters = {
            source: (params.get('source') as SessionSource | 'all' | null) ?? undefined,
            archived: toBoolean(params.get('archived')),
            cwd: params.get('cwd') ?? undefined,
            workspace: params.get('workspace') ?? undefined,
            query,
          }
          const usesPaging = params.has('limit')
          const page = {
            limit: toNumber(params.get('limit')),
            cursor: params.get('cursor') ?? undefined,
            includeMetrics: params.get('metrics') === 'true',
          }
          const result = query
            ? usesPaging ? await service.searchPage(query, filters, page) : await service.search(query, filters)
            : usesPaging ? await service.listPage(filters, page) : await service.list(filters)
          sendJson(res, 200, result)
          return
        }

        if (path === `${API_PREFIX}/preview`) {
          const id = params.get('id') ?? params.get('sessionId')
          if (!id) {
            sendError(res, 400, 'Missing sessionId')
            return
          }
          const result = await service.preview(id)
          sendJson(res, 200, result)
          return
        }

        if (path === `${API_PREFIX}/open`) {
          if (rejectNonPost(req, res)) return
          const body = await readJsonBody(req)
          const sessionId = stringField(body, 'sessionId', 'id')
          if (!sessionId) {
            sendError(res, 400, 'Missing sessionId')
            return
          }
          const result = await service.open(sessionId)
          sendJson(res, 200, result)
          return
        }

        if (path === `${API_PREFIX}/delete`) {
          if (rejectNonPost(req, res)) return
          const body = await readJsonBody(req)
          const rawIds = Array.isArray(body.sessionIds)
            ? body.sessionIds
            : typeof body.sessionId === 'string'
              ? [body.sessionId]
              : []
          const sessionIds = sanitizeSessionIds(rawIds)
          if (sessionIds.length === 0) {
            sendError(res, 400, 'Missing sessionIds')
            return
          }
          const confirmToken = stringField(body, 'confirmToken', 'token')
          const result = await service.deleteSessions(sessionIds, { confirmToken })
          sendJson(res, 200, result)
          return
        }

        if (path === `${API_PREFIX}/scan`) {
          const source = parseImportSource(params.get('source'))
          if (!source) {
            sendError(res, 400, 'Invalid import source')
            return
          }
          const root = params.get('root') ?? params.get('claudePath') ?? params.get('codexPath') ?? undefined
          const usesPaging = params.has('limit')
          const page = {
            root,
            limit: toNumber(params.get('limit')),
            cursor: params.get('cursor') ?? undefined,
            scanId: params.get('scanId') ?? undefined,
            workspace: params.get('workspace') ?? undefined,
          }
          const result = usesPaging ? await service.scanPage(source, page) : await service.scan(source, root)
          sendJson(res, 200, result)
          return
        }

        if (path === `${API_PREFIX}/import`) {
          if (rejectNonPost(req, res)) return
          const body = await readJsonBody(req)
          const source = parseImportSource(body.source)
          if (!source) {
            sendError(res, 400, 'Invalid import source')
            return
          }
          const scanId = typeof body.scanId === 'string' ? body.scanId : ''
          if (!scanId) {
            sendError(res, 400, 'Missing scanId')
            return
          }
          const rawTargets = Array.isArray(body.targets) ? body.targets : []
          const targets: ImportSelection[] = rawTargets
            .filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null)
            .map((value) => ({
              sourceSessionId: typeof value.sourceSessionId === 'string' ? value.sourceSessionId : '',
            }))
            .filter((target) => target.sourceSessionId.length > 0)
          const result = await service.import(source, scanId, targets)
          sendJson(res, 200, result)
          return
        }

        if (path === `${API_PREFIX}/archive` || path === `${API_PREFIX}/unarchive`) {
          if (rejectNonPost(req, res)) return
          const body = await readJsonBody(req)
          const sessionId = stringField(body, 'sessionId', 'id')
          if (!sessionId) {
            sendError(res, 400, 'Missing sessionId')
            return
          }
          if (path === `${API_PREFIX}/archive`) {
            await service.archive(sessionId)
          } else {
            await service.unarchive(sessionId)
          }
          sendJson(res, 200, { ok: true, sessionId })
          return
        }

        sendError(res, 404, 'Not found')
      } catch (error) {
        console.error('[dsh-session-management] api error:', error)
        sendError(res, 500, error instanceof Error ? error.message : String(error))
      }
    },
  })
}

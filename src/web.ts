/**
 * Host HTTP API backing the settings-page thin UI.
 *
 * The client half is a small DOM/React adapter; all business logic stays in
 * `SessionManagementService`.  This file maps HTTP GET read requests and
 * POST archive/unarchive requests to service calls and serializes JSON.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SessionManagementService } from './service.js'

interface WebServerLike {
  register(route: {
    kind: 'prefix' | 'exact'
    path: string
    handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  }): () => void
}

const API_PREFIX = '/@dsh-external/dsh-session-management/api'

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

function parseQuery(url: string | undefined): URLSearchParams {
  try {
    const parsed = new URL(url ?? '/', 'http://localhost')
    return parsed.searchParams
  } catch {
    return new URLSearchParams()
  }
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

        if (path === `${API_PREFIX}/list` || path === `${API_PREFIX}/search`) {
          const query = params.get('query') ?? params.get('q') ?? undefined
          const filters = {
            source: (params.get('source') as 'dsh' | 'claude-code' | 'codex' | 'all' | null) ?? undefined,
            archived: toBoolean(params.get('archived')),
            cwd: params.get('cwd') ?? undefined,
            workspace: params.get('workspace') ?? undefined,
            query,
          }
          const result = query
            ? await service.search(query, filters)
            : await service.list(filters)
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

        if (path === `${API_PREFIX}/archive` || path === `${API_PREFIX}/unarchive`) {
          if (req.method !== 'POST') {
            sendError(res, 405, 'Method not allowed')
            return
          }
          const body = await readJsonBody(req)
          const sessionId = typeof body.sessionId === 'string'
            ? body.sessionId
            : typeof body.id === 'string' ? body.id : undefined
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
        sendError(res, 500, error instanceof Error ? error.message : String(error))
      }
    },
  })
}
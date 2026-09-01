/**
 * Host HTTP API backing the settings-page thin UI.
 *
 * The client half is a small DOM/React adapter; all read logic stays in
 * `SessionManagementService`.  This file only maps HTTP GET requests to
 * service calls and serializes the canonical JSON result.
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

        sendError(res, 404, 'Not found')
      } catch (error) {
        sendError(res, 500, error instanceof Error ? error.message : String(error))
      }
    },
  })
}
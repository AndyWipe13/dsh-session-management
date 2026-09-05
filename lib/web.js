/**
 * Host HTTP API backing the settings-page thin UI.
 *
 * The client half is a small DOM/React adapter; all business logic stays in
 * `SessionManagementService`.  This file maps HTTP GET read requests and
 * POST archive/unarchive requests to service calls and serializes JSON.
 */
const API_PREFIX = '/@dsh-external/dsh-session-management/api';
function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
    });
    res.end(body);
}
function sendError(res, status, message) {
    sendJson(res, status, { error: message });
}
function parseQuery(url) {
    try {
        const parsed = new URL(url ?? '/', 'http://localhost');
        return parsed.searchParams;
    }
    catch {
        return new URLSearchParams();
    }
}
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            raw += chunk;
            if (raw.length > 1024 * 1024) {
                reject(new Error('Request body too large'));
                req.destroy();
            }
        });
        req.on('end', () => {
            if (!raw) {
                resolve({});
                return;
            }
            try {
                const parsed = JSON.parse(raw);
                resolve(typeof parsed === 'object' && parsed !== null ? parsed : {});
            }
            catch {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}
function toBoolean(value) {
    if (value == null || value === 'all' || value === '')
        return undefined;
    return value === 'true' || value === '1';
}
function toNumber(value) {
    if (value == null || value === '')
        return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function toOptionalBoolean(value) {
    const parsed = toBoolean(value);
    return parsed === 'all' || parsed === undefined ? undefined : parsed;
}
export function registerSessionApi(ctx, service) {
    const webServer = ctx.webServer;
    if (!webServer || typeof webServer.register !== 'function')
        return () => { };
    return webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
            try {
                const url = new URL(req.url ?? '/', 'http://localhost');
                const path = url.pathname.replace(/\/+$/, '');
                const params = url.searchParams;
                if (path === `${API_PREFIX}/repair-workspaces`) {
                    if (req.method !== 'POST') {
                        sendError(res, 405, 'Method not allowed');
                        return;
                    }
                    sendJson(res, 200, await service.repairImportedWorkspaces());
                    return;
                }
                if (path === `${API_PREFIX}/stats`) {
                    const result = await service.stats();
                    sendJson(res, 200, result);
                    return;
                }
                if (path === `${API_PREFIX}/cleanup/preview`) {
                    const rules = {
                        olderThanDays: toNumber(params.get('olderThanDays')),
                        largerThanMb: toNumber(params.get('largerThanMb')),
                        emptySessions: toOptionalBoolean(params.get('emptySessions')),
                        archivedOnly: toOptionalBoolean(params.get('archivedOnly')),
                        source: params.get('source') ?? undefined,
                    };
                    const result = await service.cleanupPreview(rules);
                    sendJson(res, 200, result);
                    return;
                }
                if (path === `${API_PREFIX}/cleanup/execute`) {
                    if (req.method !== 'POST') {
                        sendError(res, 405, 'Method not allowed');
                        return;
                    }
                    const body = await readJsonBody(req);
                    const previewId = typeof body.previewId === 'string' ? body.previewId : '';
                    const rawIds = Array.isArray(body.sessionIds) ? body.sessionIds : [];
                    const sessionIds = rawIds.filter((value) => typeof value === 'string' && value.length > 0);
                    const confirmToken = typeof body.confirmToken === 'string'
                        ? body.confirmToken
                        : typeof body.token === 'string' ? body.token : undefined;
                    if (!previewId) {
                        sendError(res, 400, 'Missing previewId');
                        return;
                    }
                    if (sessionIds.length === 0) {
                        sendError(res, 400, 'Missing sessionIds');
                        return;
                    }
                    const result = await service.cleanupExecute(sessionIds, { confirmToken, previewId });
                    sendJson(res, 200, result);
                    return;
                }
                if (path === `${API_PREFIX}/list` || path === `${API_PREFIX}/search`) {
                    const query = params.get('query') ?? params.get('q') ?? undefined;
                    const filters = {
                        source: params.get('source') ?? undefined,
                        archived: toBoolean(params.get('archived')),
                        cwd: params.get('cwd') ?? undefined,
                        workspace: params.get('workspace') ?? undefined,
                        query,
                    };
                    const result = query
                        ? await service.search(query, filters)
                        : await service.list(filters);
                    sendJson(res, 200, result);
                    return;
                }
                if (path === `${API_PREFIX}/preview`) {
                    const id = params.get('id') ?? params.get('sessionId');
                    if (!id) {
                        sendError(res, 400, 'Missing sessionId');
                        return;
                    }
                    const result = await service.preview(id);
                    sendJson(res, 200, result);
                    return;
                }
                if (path === `${API_PREFIX}/open`) {
                    if (req.method !== 'POST') {
                        sendError(res, 405, 'Method not allowed');
                        return;
                    }
                    const body = await readJsonBody(req);
                    const sessionId = typeof body.sessionId === 'string'
                        ? body.sessionId
                        : typeof body.id === 'string' ? body.id : undefined;
                    if (!sessionId) {
                        sendError(res, 400, 'Missing sessionId');
                        return;
                    }
                    const result = await service.open(sessionId);
                    sendJson(res, 200, result);
                    return;
                }
                if (path === `${API_PREFIX}/delete`) {
                    if (req.method !== 'POST') {
                        sendError(res, 405, 'Method not allowed');
                        return;
                    }
                    const body = await readJsonBody(req);
                    const rawIds = Array.isArray(body.sessionIds)
                        ? body.sessionIds
                        : typeof body.sessionId === 'string'
                            ? [body.sessionId]
                            : [];
                    const sessionIds = rawIds.filter((value) => typeof value === 'string' && value.length > 0);
                    if (sessionIds.length === 0) {
                        sendError(res, 400, 'Missing sessionIds');
                        return;
                    }
                    const confirmToken = typeof body.confirmToken === 'string'
                        ? body.confirmToken
                        : typeof body.token === 'string' ? body.token : undefined;
                    const result = await service.deleteSessions(sessionIds, { confirmToken });
                    sendJson(res, 200, result);
                    return;
                }
                if (path === `${API_PREFIX}/scan`) {
                    const source = params.get('source') ?? 'claude-code';
                    const root = params.get('root') ?? params.get('claudePath') ?? params.get('codexPath') ?? undefined;
                    const result = source === 'codex'
                        ? await service.scanCodex(root)
                        : await service.scanClaude(root);
                    sendJson(res, 200, result);
                    return;
                }
                if (path === `${API_PREFIX}/import`) {
                    if (req.method !== 'POST') {
                        sendError(res, 405, 'Method not allowed');
                        return;
                    }
                    const body = await readJsonBody(req);
                    const source = typeof body.source === 'string' && body.source.length > 0 ? body.source : 'claude-code';
                    const rawTargets = Array.isArray(body.targets) ? body.targets : [];
                    const targets = rawTargets
                        .filter((value) => typeof value === 'object' && value !== null)
                        .map((value) => ({
                        sourceSessionId: typeof value.sourceSessionId === 'string' ? value.sourceSessionId : '',
                        path: typeof value.path === 'string' ? value.path : undefined,
                    }))
                        .filter((target) => target.sourceSessionId.length > 0);
                    const root = typeof body.root === 'string' ? body.root : undefined;
                    const result = source === 'codex'
                        ? await service.importCodex(targets, root)
                        : await service.importClaude(targets, root);
                    sendJson(res, 200, result);
                    return;
                }
                if (path === `${API_PREFIX}/archive` || path === `${API_PREFIX}/unarchive`) {
                    if (req.method !== 'POST') {
                        sendError(res, 405, 'Method not allowed');
                        return;
                    }
                    const body = await readJsonBody(req);
                    const sessionId = typeof body.sessionId === 'string'
                        ? body.sessionId
                        : typeof body.id === 'string' ? body.id : undefined;
                    if (!sessionId) {
                        sendError(res, 400, 'Missing sessionId');
                        return;
                    }
                    if (path === `${API_PREFIX}/archive`) {
                        await service.archive(sessionId);
                    }
                    else {
                        await service.unarchive(sessionId);
                    }
                    sendJson(res, 200, { ok: true, sessionId });
                    return;
                }
                sendError(res, 404, 'Not found');
            }
            catch (error) {
                console.error('[dsh-session-management] api error:', error);
                sendError(res, 500, error instanceof Error ? error.message : String(error));
            }
        },
    });
}
//# sourceMappingURL=web.js.map
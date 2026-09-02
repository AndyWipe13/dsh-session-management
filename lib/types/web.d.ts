/**
 * Host HTTP API backing the settings-page thin UI.
 *
 * The client half is a small DOM/React adapter; all business logic stays in
 * `SessionManagementService`.  This file maps HTTP GET read requests and
 * POST archive/unarchive requests to service calls and serializes JSON.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionManagementService } from './service.js';
interface WebServerLike {
    register(route: {
        kind: 'prefix' | 'exact';
        path: string;
        handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>;
    }): () => void;
}
export declare function registerSessionApi(ctx: {
    webServer?: WebServerLike;
}, service: SessionManagementService): () => void;
export {};

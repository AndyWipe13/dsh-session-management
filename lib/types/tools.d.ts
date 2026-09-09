/**
 * Agent tools for dsh-session-management.
 *
 * These tools are deliberately thin: they parse/validate args, call the
 * SessionManagement service, and render the canonical result for the model.
 * No business logic lives here.
 */
import type { SessionManagementService } from './service.js';
interface ToolContext {
    tools: {
        register(tool: unknown): () => void;
    };
    on?(event: string, listener: (exec: unknown, next: () => unknown) => unknown): unknown;
}
export declare function registerSessionTools(ctx: ToolContext, service: SessionManagementService): () => void;
export {};

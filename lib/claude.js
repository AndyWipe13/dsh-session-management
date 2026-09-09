/**
 * Claude Code import slice.
 *
 * This module owns the Claude Code dialect: JSONL record interpretation
 * (summarize + pure transcript -> DSH event conversion). The dialect-neutral
 * plumbing (streaming reads, walks, `~` expansion) lives in jsonl-source.ts,
 * and the SessionManagement service stays filesystem-free behind the
 * `ImportSourceAdapter` seam.
 *
 * Read-only contract: every function here only reads source files.  No Claude
 * Code file is ever modified, moved, or deleted.
 */
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FidelityMapping } from './fidelity.js';
import { asString, isRecord, projectNameOf, readJsonlFile, recordTimestamp, resolveHomeRoot, statSourceFile, walkJsonlFiles } from './jsonl-source.js';
function contentText(value) {
    if (typeof value === 'string')
        return value;
    if (!Array.isArray(value))
        return undefined;
    const parts = [];
    for (const block of value) {
        if (!isRecord(block))
            continue;
        if (block.type === 'text' && typeof block.text === 'string')
            parts.push(block.text);
        if (block.type === 'thinking') {
            if (typeof block.thinking === 'string')
                parts.push(block.thinking);
            if (typeof block.text === 'string')
                parts.push(block.text);
        }
    }
    return parts.length > 0 ? parts.join('\n') : undefined;
}
function isCommandInjectedText(text) {
    if (!text)
        return true;
    const trimmed = text.trim();
    if (!trimmed)
        return true;
    if (trimmed.startsWith('<local-command-caveat>'))
        return true;
    if (trimmed.startsWith('<command-name>'))
        return true;
    if (trimmed.startsWith('<local-command-stdout>'))
        return true;
    // Slash commands and command-line continuation prompts are not real prompts.
    if (/^\s*\//.test(trimmed))
        return true;
    if (/^(Continue from where you left off\.|Resume cancelled|Set model to)/i.test(trimmed))
        return true;
    return false;
}
function contentHasToolResult(value) {
    return Array.isArray(value) && value.some((block) => isRecord(block) && block.type === 'tool_result');
}
function isSidechainRecord(value) {
    return value.isSidechain === true || value.agentId !== undefined || value.attributionAgent !== undefined;
}
function userMessageText(value) {
    const message = value.message;
    if (!isRecord(message))
        return undefined;
    const content = contentText(message.content);
    if (contentHasToolResult(message.content))
        return undefined;
    if (isCommandInjectedText(content))
        return undefined;
    return content;
}
function assistantContentBlocks(value) {
    const message = value.message;
    if (!isRecord(message) || !Array.isArray(message.content))
        return [];
    return message.content;
}
function firstCustomTitle(records) {
    for (const record of records) {
        if (record.value.type !== 'custom-title')
            continue;
        const candidate = asString(record.value.customTitle) ?? asString(record.value.title);
        if (candidate)
            return candidate;
    }
    return undefined;
}
function firstRealUserText(records) {
    for (const record of records) {
        if (record.value.type !== 'user')
            continue;
        if (record.value.isMeta === true)
            continue;
        const text = userMessageText(record.value);
        if (text)
            return text;
    }
    return undefined;
}
/** The default Claude Code projects root on this machine. */
export function defaultClaudeProjectsRoot() {
    return path.join(os.homedir(), '.claude', 'projects');
}
/** Expand `~` / empty input to a concrete Claude Code projects root. */
export function resolveClaudeProjectsRoot(input) {
    return resolveHomeRoot(input, defaultClaudeProjectsRoot);
}
/**
 * Summarize a parsed Claude Code file for the import queue.  This is a pure
 * function so tests can assert title/exclusion rules without touching the disk.
 */
export function summarizeClaudeRecords(records, stat, fallbackSessionId) {
    let sourceSessionId = '';
    let cwd;
    let createdAt = 0;
    let updatedAt = 0;
    let messageCount = 0;
    let isSubagent = false;
    for (const record of records) {
        const value = record.value;
        if (isSidechainRecord(value))
            isSubagent = true;
        if (!sourceSessionId && typeof value.sessionId === 'string')
            sourceSessionId = value.sessionId;
        if (!cwd && typeof value.cwd === 'string')
            cwd = value.cwd;
        const timestamp = recordTimestamp(value);
        if (timestamp) {
            if (createdAt === 0 || timestamp < createdAt)
                createdAt = timestamp;
            if (timestamp > updatedAt)
                updatedAt = timestamp;
        }
        if (value.type === 'user' || value.type === 'assistant')
            messageCount++;
    }
    if (!sourceSessionId)
        sourceSessionId = fallbackSessionId ?? '';
    const customTitle = firstCustomTitle(records);
    const firstUser = firstRealUserText(records);
    const projectName = projectNameOf(cwd);
    const title = customTitle ?? firstUser ?? projectName;
    return {
        sourceSessionId: sourceSessionId || fallbackSessionId || '',
        cwd,
        projectName,
        title,
        createdAt: createdAt || stat.mtimeMs,
        updatedAt: updatedAt || stat.mtimeMs,
        messageCount,
        hasRealUserMessage: Boolean(firstUser),
        isSubagent,
    };
}
/**
 * Read one Claude Code JSONL file: shared streaming parse, dialect summary.
 */
export async function readClaudeFile(filePath) {
    const { stat, records, badLines } = await readJsonlFile(filePath);
    const fallbackSessionId = path.basename(filePath, path.extname(filePath));
    const summary = summarizeClaudeRecords(records, stat, fallbackSessionId);
    return { summary, records, badLines };
}
/**
 * Recursively list `.jsonl` files under a Claude Code projects root.  The
 * scanner follows the real `~/.claude/projects/**` layout but also works when
 * fixture files sit directly in the configured root. Subagent transcripts
 * (`agent-*`) are excluded.
 */
export async function listClaudeFiles(root) {
    return walkJsonlFiles([root], (name) => name.startsWith('agent-'));
}
/** Claude Code adapter at the import-queue seam. */
export function createClaudeImportAdapter(root) {
    return {
        source: 'claude-code',
        resolveRoot: (input) => resolveClaudeProjectsRoot(input ?? root),
        listFiles: listClaudeFiles,
        read: readClaudeFile,
        stat: statSourceFile,
        convert: (records, options) => convertClaudeRecords(records, options),
    };
}
/**
 * Convert a parsed Claude Code transcript into a minimal but valid DSH session
 * event stream.  Known DSH tools map to `tool/call` + `tool/result`; unknown
 * tools degrade to read-only text cards (ADR-0002) instead of faking an
 * executable tool event.
 *
 * The returned events have contiguous seq values starting at 0; `Session`'
 * official seed path appends `session/end-seed` after them and persists the
 * whole log through `ctx.sessions`.
 */
export function convertClaudeRecords(records, opts = { knowTool: () => false }) {
    const dshSessionId = opts.dshSessionId ?? `session-${randomUUID()}`;
    const mapping = new FidelityMapping(opts.knowTool);
    let cwd;
    let createdAt = 0;
    let updatedAt = 0;
    for (const record of records) {
        const value = record.value;
        if (isSidechainRecord(value))
            continue;
        if (!cwd && typeof value.cwd === 'string')
            cwd = value.cwd;
        const timestamp = recordTimestamp(value);
        if (timestamp) {
            if (createdAt === 0 || timestamp < createdAt)
                createdAt = timestamp;
            if (timestamp > updatedAt)
                updatedAt = timestamp;
        }
        const time = timestamp ?? updatedAt ?? Date.now();
        if (value.type === 'user') {
            const message = value.message;
            if (!isRecord(message))
                continue;
            const content = message.content;
            // Tool result user records are not real user prompts; they are matched
            // with the assistant tool_use that preceded them.
            if (Array.isArray(content) && content.some((block) => isRecord(block) && block.type === 'tool_result')) {
                mapping.ensureTurn(time);
                for (const block of content) {
                    if (!isRecord(block) || block.type !== 'tool_result')
                        continue;
                    const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
                    const call = mapping.tool(callId);
                    const resultTime = timestamp ?? time;
                    if (call && call.known) {
                        mapping.toolResult(resultTime, callId, block.content, block.is_error === true);
                    }
                    else {
                        mapping.userMessage(resultTime, [mapping.toolResultCard(callId || undefined, block.content, block.is_error === true)], `msg-${callId || randomUUID()}`);
                    }
                }
                continue;
            }
            // Real user prompt: skip meta/command lines when converting too.
            if (value.isMeta === true)
                continue;
            const text = userMessageText(value);
            if (!text)
                continue;
            mapping.openTurn(time);
            mapping.userMessage(time, [mapping.text(text)], `msg-${typeof value.uuid === 'string' ? value.uuid : randomUUID()}`);
            continue;
        }
        if (value.type === 'assistant') {
            const blocks = assistantContentBlocks(value);
            if (blocks.length === 0)
                continue;
            mapping.ensureTurn(time);
            const contentBlocks = [];
            for (const block of blocks) {
                if (!isRecord(block))
                    continue;
                if (block.type === 'text' && typeof block.text === 'string') {
                    contentBlocks.push(mapping.text(block.text));
                }
                else if (block.type === 'thinking') {
                    contentBlocks.push(mapping.reasoning(typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : ''));
                }
                else if (block.type === 'tool_use') {
                    const id = typeof block.id === 'string' ? block.id : randomUUID();
                    const name = typeof block.name === 'string' ? block.name : 'unknown-tool';
                    const call = mapping.registerTool(id, name);
                    if (call.known) {
                        contentBlocks.push(mapping.toolCallBlock(id, name, block.input ?? {}));
                        mapping.toolCall(time, id, name, block.input ?? {});
                    }
                    else {
                        contentBlocks.push(mapping.toolCallCard('tool_use', name, id, block.input ?? {}));
                    }
                }
            }
            if (contentBlocks.length > 0) {
                const messageId = typeof value.uuid === 'string' ? value.uuid : typeof value.message?.id === 'string' ? value.message.id : randomUUID();
                mapping.assistantMessage(time, contentBlocks, {
                    provider: 'claude-code',
                    model: typeof value.message?.model === 'string' ? value.message.model : 'unknown',
                }, messageId);
            }
            continue;
        }
    }
    mapping.closeTurn(updatedAt || Date.now());
    return {
        dshSessionId,
        header: { cwd, createdAt: createdAt || Date.now() },
        events: mapping.events,
        knownToolCalls: mapping.knownToolCalls,
        textCardToolCalls: mapping.textCardToolCalls,
    };
}
//# sourceMappingURL=claude.js.map
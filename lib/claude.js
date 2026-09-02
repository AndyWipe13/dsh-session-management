/**
 * Claude Code import slice.
 *
 * This module owns the filesystem-facing Claude Code JSONL scanning/parsing and
 * the pure transcript -> DSH event conversion.  The SessionManagement service
 * remains filesystem-free; it receives a `ClaudeSourceReader` (usually
 * `createClaudeSourceReader()`) so tests can drive the same seam with fakes or
 * real fixture directories.
 *
 * Read-only contract: every function here only reads source files.  No Claude
 * Code file is ever modified, moved, or deleted.
 */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function asString(value) {
    if (typeof value === 'string' && value.length > 0)
        return value;
    return undefined;
}
function recordTimestamp(value) {
    const raw = value.timestamp ?? value.time ?? value.createdAt;
    if (raw == null)
        return undefined;
    if (typeof raw === 'number' && Number.isFinite(raw))
        return raw;
    if (typeof raw === 'string') {
        const parsed = Date.parse(raw);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}
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
function projectNameOf(cwd) {
    if (!cwd)
        return undefined;
    const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    const base = normalized.split('/').filter(Boolean).pop();
    return base || undefined;
}
/** The default Claude Code projects root on this machine. */
export function defaultClaudeProjectsRoot() {
    return path.join(os.homedir(), '.claude', 'projects');
}
/** Expand `~` / empty input to a concrete Claude Code projects root. */
export function resolveClaudeProjectsRoot(input) {
    if (!input || !input.trim())
        return defaultClaudeProjectsRoot();
    const trimmed = input.trim();
    if (trimmed === '~')
        return os.homedir();
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
        return path.join(os.homedir(), ...trimmed.slice(2).split(/[\\/]+/).filter(Boolean));
    }
    return trimmed;
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
 * Read one Claude Code JSONL file.  Malformed lines are skipped and counted;
 * every valid line is returned in order so the converter can preserve as much
 * fidelity as possible.
 */
export async function readClaudeFile(filePath) {
    const stat = await fs.stat(filePath);
    const records = [];
    let badLines = 0;
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of rl) {
        lineNumber++;
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const value = JSON.parse(trimmed);
            if (!isRecord(value)) {
                badLines++;
                continue;
            }
            records.push({ value, line: lineNumber });
        }
        catch {
            badLines++;
        }
    }
    const fallbackSessionId = path.basename(filePath, path.extname(filePath));
    const summary = summarizeClaudeRecords(records, {
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
    }, fallbackSessionId);
    return { summary, records, badLines };
}
/**
 * Recursively list `.jsonl` files under a Claude Code projects root.  The
 * scanner follows the real `~/.claude/projects/**` layout but also works when
 * fixture files sit directly in the configured root.
 */
export async function listClaudeFiles(root) {
    const out = [];
    const stack = [root];
    while (stack.length > 0) {
        const dir = stack.pop();
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        }
        catch (error) {
            if (error?.code === 'ENOENT')
                continue;
            throw error;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            }
            else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('agent-')) {
                out.push(full);
            }
        }
    }
    return out.sort();
}
export function createClaudeSourceReader() {
    return {
        listClaudeFiles,
        readClaudeFile: readClaudeFile,
        async stat(filePath) {
            const info = await fs.stat(filePath);
            return { sizeBytes: info.size, mtimeMs: info.mtimeMs };
        },
    };
}
function textBlock(text) {
    return { type: 'text', text };
}
function reasoningBlock(text) {
    return { type: 'reasoning', text };
}
function toolCallBlock(id, name, input) {
    return {
        type: 'tool-call',
        id,
        name,
        arguments: typeof input === 'string' ? input : JSON.stringify(input ?? {}),
    };
}
function textCardForToolUse(block) {
    const name = typeof block.name === 'string' ? block.name : 'unknown-tool';
    const id = typeof block.id === 'string' ? block.id : '';
    const input = block.input !== undefined ? JSON.stringify(block.input, null, 2) : '';
    return textBlock(`[tool_use: ${name}${id ? ` (${id})` : ''}]\n${input}`);
}
function textCardForToolResult(block) {
    const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
    const content = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
            ? block.content.map((part) => isRecord(part) && typeof part.text === 'string' ? part.text : JSON.stringify(part)).join('\n')
            : block.content !== undefined ? JSON.stringify(block.content) : '';
    const error = block.is_error === true ? ' [error]' : '';
    return textBlock(`[tool_result${id ? `: ${id}` : ''}${error}]\n${content}`);
}
function toolResultContent(block) {
    const body = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
            ? block.content.map((part) => isRecord(part) && typeof part.text === 'string' ? part.text : JSON.stringify(part)).join('\n')
            : block.content !== undefined ? JSON.stringify(block.content) : '';
    const blocks = [textBlock(body)];
    if (block.is_error === true)
        blocks.push(textBlock('[error]'));
    return blocks;
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
    const events = [];
    let cwd;
    let createdAt = 0;
    let updatedAt = 0;
    const knownCalls = new Map();
    let knownToolCalls = 0;
    let textCardToolCalls = 0;
    let seq = 0;
    let turn = 0;
    let step = 0;
    const push = (type, time, data, surfaceOp) => {
        events.push({
            type,
            seq: seq++,
            time,
            data,
            ...(surfaceOp ? { surfaceOp } : {}),
        });
    };
    const pushBoundary = (type, time, data) => {
        push(type, time, data);
    };
    let currentTurn;
    let currentStep;
    const closeTurn = (time) => {
        if (currentStep !== undefined) {
            pushBoundary('step/end', time, { turn: currentTurn, step: currentStep });
            currentStep = undefined;
        }
        if (currentTurn !== undefined) {
            pushBoundary('turn/end', time, { turn: currentTurn, reason: { kind: 'completed' } });
            currentTurn = undefined;
        }
    };
    const openTurn = (time) => {
        closeTurn(time);
        turn++;
        step = 1;
        currentTurn = turn;
        currentStep = step;
        pushBoundary('turn/start', time, { turn });
        pushBoundary('step/start', time, { turn, step });
    };
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
                if (currentTurn === undefined)
                    openTurn(time);
                for (const block of content) {
                    if (!isRecord(block) || block.type !== 'tool_result')
                        continue;
                    const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
                    const call = knownCalls.get(callId);
                    const resultTime = timestamp ?? time;
                    if (call && call.known) {
                        push('tool/result', resultTime, {
                            turn: currentTurn,
                            step: currentStep,
                            message: {
                                role: 'user',
                                content: [{
                                        type: 'tool-result',
                                        toolCallId: callId,
                                        content: toolResultContent(block),
                                        ...(block.is_error === true ? { isError: true } : {}),
                                    }],
                                source: { kind: 'tool', callId },
                                id: `msg-${callId}`,
                            },
                        }, 'append');
                    }
                    else {
                        textCardToolCalls++;
                        push('user/message', resultTime, {
                            role: 'user',
                            content: [textCardForToolResult(block)],
                            source: { kind: 'user' },
                            id: `msg-${callId || randomUUID()}`,
                        }, 'append');
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
            openTurn(time);
            push('user/message', time, {
                role: 'user',
                content: [textBlock(text)],
                source: { kind: 'user' },
                id: `msg-${typeof value.uuid === 'string' ? value.uuid : randomUUID()}`,
            }, 'append');
            continue;
        }
        if (value.type === 'assistant') {
            const blocks = assistantContentBlocks(value);
            if (blocks.length === 0)
                continue;
            if (currentTurn === undefined)
                openTurn(time);
            const contentBlocks = [];
            let hasToolUse = false;
            for (const block of blocks) {
                if (!isRecord(block))
                    continue;
                if (block.type === 'text' && typeof block.text === 'string') {
                    contentBlocks.push(textBlock(block.text));
                }
                else if (block.type === 'thinking') {
                    contentBlocks.push(reasoningBlock(typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : ''));
                }
                else if (block.type === 'tool_use') {
                    hasToolUse = true;
                    const id = typeof block.id === 'string' ? block.id : randomUUID();
                    const name = typeof block.name === 'string' ? block.name : 'unknown-tool';
                    const known = opts.knowTool(name);
                    knownCalls.set(id, { name, known });
                    if (known) {
                        knownToolCalls++;
                        contentBlocks.push(toolCallBlock(id, name, block.input));
                        push('tool/call', time, {
                            turn: currentTurn,
                            step: currentStep,
                            callId: id,
                            name,
                            arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
                        });
                    }
                    else {
                        textCardToolCalls++;
                        contentBlocks.push(textCardForToolUse(block));
                    }
                }
            }
            if (contentBlocks.length > 0) {
                const messageId = typeof value.uuid === 'string' ? value.uuid : typeof value.message?.id === 'string' ? value.message.id : randomUUID();
                push('assistant/message', time, {
                    turn: currentTurn,
                    step: currentStep,
                    message: {
                        role: 'assistant',
                        content: contentBlocks,
                        source: {
                            kind: 'model',
                            provider: 'claude-code',
                            model: typeof value.message?.model === 'string' ? value.message.model : 'unknown',
                        },
                        id: messageId,
                    },
                    ...(hasToolUse ? {} : {}),
                }, 'append');
            }
            continue;
        }
    }
    closeTurn(updatedAt || Date.now());
    return {
        dshSessionId,
        header: { cwd, createdAt: createdAt || Date.now() },
        events,
        knownToolCalls,
        textCardToolCalls,
    };
}
//# sourceMappingURL=claude.js.map
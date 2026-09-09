/**
 * Dialect-neutral plumbing shared by the JSONL-backed import sources
 * (Claude Code, Codex): record guards, timestamp coercion, `~` expansion,
 * streaming JSONL reads, and directory walks. Only record interpretation
 * differs per dialect and stays in claude.ts / codex.ts.
 *
 * Read-only contract: every function here only reads source files.
 */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function asString(value) {
    if (typeof value === 'string' && value.length > 0)
        return value;
    return undefined;
}
/** Accepts epoch millis or ISO-ish strings across source dialects. */
export function recordTimestamp(value) {
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
/** Last path segment after forward-slash normalization, without case folding. */
export function pathBaseName(value) {
    return value.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
}
export function projectNameOf(cwd) {
    if (!cwd)
        return undefined;
    return pathBaseName(cwd) || undefined;
}
/** Backslash→slash, trailing-slash strip, case-folded key for path comparisons. */
export function normalizePathKey(value) {
    return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
/** Expand `~` / empty input to a concrete home-relative root. */
export function resolveHomeRoot(input, defaultRoot) {
    if (!input || !input.trim())
        return defaultRoot();
    const trimmed = input.trim();
    if (trimmed === '~')
        return os.homedir();
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
        return path.join(os.homedir(), ...trimmed.slice(2).split(/[\\/]+/).filter(Boolean));
    }
    return trimmed;
}
/** Read-only file identity shared by every source adapter. */
export async function statSourceFile(filePath) {
    const info = await fs.stat(filePath);
    return { sizeBytes: info.size, mtimeMs: info.mtimeMs };
}
/**
 * Stream one JSONL file. Malformed lines are skipped and counted; every valid
 * line is returned in order so converters can preserve as much fidelity as
 * possible.
 */
export async function readJsonlFile(filePath) {
    const stat = await statSourceFile(filePath);
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
    return { stat, records, badLines };
}
/**
 * Recursively list `.jsonl` files under the given roots. Missing directories
 * are skipped; `skip` excludes files by basename (per-dialect metadata).
 */
export async function walkJsonlFiles(roots, skip) {
    const out = [];
    const stack = [...roots];
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
            else if (entry.isFile() && entry.name.endsWith('.jsonl') && !skip?.(entry.name)) {
                out.push(full);
            }
        }
    }
    return out.sort();
}
//# sourceMappingURL=jsonl-source.js.map
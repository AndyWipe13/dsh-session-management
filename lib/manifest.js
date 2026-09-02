/**
 * import manifest storage unit for dsh-session-management.
 *
 * Issue #3 scope: the unit is created here (initially empty) and the Session
 * service uses it to reverse-lookup an imported session's `source` from its
 * DSH session id.  Writes will be added by the import slice.
 *
 * The official `storageDomain` API opens typed domains with table handles.
 * The fake harness in test/ exposes a simpler KV unit; this adapter supports
 * both shapes so service tests stay fully fake-driven.
 */
const MANIFEST_DOMAIN = 'session-management';
const MANIFEST_VERSION = 1;
const IMPORTS_TABLE = 'imports';
/** Minimal schema-like object satisfying storage-domain's runtime `safeParse` use. */
const passthroughSchema = {
    safeParse: (value) => ({ success: true, data: value }),
};
/**
 * Open the plugin's own `session-management` v1 storage unit.
 *
 * The returned store is safe to use before the asynchronous open settles:
 * every method awaits the same open promise.
 */
export function openManifestStore(storageDomain) {
    const opening = storageDomain.open({
        name: MANIFEST_DOMAIN,
        version: MANIFEST_VERSION,
        tables: {
            [IMPORTS_TABLE]: { valueSchema: passthroughSchema },
        },
    });
    async function resolveTable() {
        const domain = await opening;
        const maybeDomain = domain;
        if (typeof maybeDomain.table === 'function') {
            return maybeDomain.table(IMPORTS_TABLE);
        }
        const table = {
            get: (key) => maybeDomain.get?.(key),
        };
        if (typeof maybeDomain.put === 'function') {
            table.put = (key, value) => maybeDomain.put(key, value);
        }
        if (typeof maybeDomain.set === 'function') {
            table.set = (key, value) => maybeDomain.set(key, value);
        }
        if (typeof maybeDomain.delete === 'function') {
            table.delete = (key) => maybeDomain.delete(key);
        }
        return table;
    }
    async function read(key) {
        const table = await resolveTable();
        const value = table.get(key);
        return value instanceof Promise ? await value : value;
    }
    async function write(key, value) {
        const table = await resolveTable();
        if (typeof table.put === 'function') {
            const result = table.put(key, value);
            if (result instanceof Promise)
                await result;
            return;
        }
        if (typeof table.set === 'function') {
            const result = table.set(key, value);
            if (result instanceof Promise)
                await result;
            return;
        }
        throw new Error('manifest storage unit does not expose a write handle');
    }
    async function remove(key) {
        const table = await resolveTable();
        if (typeof table.delete !== 'function') {
            throw new Error('manifest storage unit does not expose a delete handle');
        }
        const result = table.delete(key);
        if (result instanceof Promise)
            await result;
    }
    async function assertDeleteAvailable() {
        const table = await resolveTable();
        if (typeof table.delete !== 'function') {
            throw new Error('manifest storage unit does not expose a delete handle');
        }
    }
    return {
        async getByDsh(dshSessionId) {
            return (await read(`dsh:${dshSessionId}`));
        },
        async getBySource(source, sourceSessionId) {
            return (await read(`source:${source}:${sourceSessionId}`));
        },
        async put(record) {
            await write(`source:${record.source}:${record.sourceSessionId}`, record);
            await write(`dsh:${record.dshSessionId}`, record);
        },
        async removeByDsh(dshSessionId) {
            const record = (await read(`dsh:${dshSessionId}`));
            if (!record)
                return;
            await remove(`dsh:${dshSessionId}`);
            await remove(`source:${record.source}:${record.sourceSessionId}`);
        },
        async assertDeleteAvailable() {
            await assertDeleteAvailable();
        },
        async close() {
            const domain = (await opening);
            if (typeof domain.close === 'function') {
                await domain.close();
            }
        },
    };
}
//# sourceMappingURL=manifest.js.map
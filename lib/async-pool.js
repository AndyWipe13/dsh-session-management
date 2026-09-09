/** Map values with bounded concurrency while preserving input order. */
export async function mapConcurrent(items, limit, fn) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error('Concurrency limit must be a positive safe integer');
    }
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}
//# sourceMappingURL=async-pool.js.map
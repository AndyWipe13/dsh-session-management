/** Map values with bounded concurrency while preserving input order. */
export declare function mapConcurrent<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;

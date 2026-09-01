export declare const inject: string[]
export declare function apply(ctx: {
  effect(fn: () => unknown, label?: string): unknown
  slots: {
    inject(key: string, callback: () => unknown): unknown
  }
}): void
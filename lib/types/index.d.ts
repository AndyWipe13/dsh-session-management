import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "@dsh-external/dsh-session-management";
export declare const inject: string[];
export interface Config {
    /** Claude Code projects root. Empty means auto-detect `~/.claude/projects`. */
    claudePath?: string;
    /** Codex home. Empty means auto-detect `~/.codex`. */
    codexPath?: string;
    /**
     * Full-text search mode. `first-search` enables content search and builds
     * the SQLite index on the first search; `never` disables full-text indexing
     * and falls back to title-only search.
     */
    fullTextSearch?: 'first-search' | 'never';
    /** Default cleanup rule values used by the 清理与统计 tab and Agent tools. */
    cleanup?: {
        olderThanDays?: number;
        largerThanMb?: number;
        emptySessions?: boolean;
        archivedOnly?: boolean;
    };
}
export declare const Config: z<Schemastery.ObjectS<{
    claudePath: z<string, string>;
    codexPath: z<string, string>;
    fullTextSearch: z<"first-search" | "never", "first-search" | "never">;
    cleanup: z<Schemastery.ObjectS<{
        olderThanDays: z<number, number>;
        largerThanMb: z<number, number>;
        emptySessions: z<boolean, boolean>;
        archivedOnly: z<boolean, boolean>;
    }>, Schemastery.ObjectT<{
        olderThanDays: z<number, number>;
        largerThanMb: z<number, number>;
        emptySessions: z<boolean, boolean>;
        archivedOnly: z<boolean, boolean>;
    }>>;
}>, Schemastery.ObjectT<{
    claudePath: z<string, string>;
    codexPath: z<string, string>;
    fullTextSearch: z<"first-search" | "never", "first-search" | "never">;
    cleanup: z<Schemastery.ObjectS<{
        olderThanDays: z<number, number>;
        largerThanMb: z<number, number>;
        emptySessions: z<boolean, boolean>;
        archivedOnly: z<boolean, boolean>;
    }>, Schemastery.ObjectT<{
        olderThanDays: z<number, number>;
        largerThanMb: z<number, number>;
        emptySessions: z<boolean, boolean>;
        archivedOnly: z<boolean, boolean>;
    }>>;
}>>;
export declare function apply(ctx: Context, config: Config): void;

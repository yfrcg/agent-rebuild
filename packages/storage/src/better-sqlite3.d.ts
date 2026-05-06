
declare module "better-sqlite3" {
    interface Statement<BindParameters extends unknown[] = unknown[]> {
    /** 方法 `run`：负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。 */
    run(...params: BindParameters): RunResult;
    /** 方法 `get`：负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。 */
    get(...params: BindParameters): unknown;
    /** 方法 `all`：承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。 */
    all(...params: BindParameters): unknown[];
    /** 方法 `iterate`：承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。 */
    iterate(...params: BindParameters): IterableIterator<Record<string, unknown>>;
  }

    interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

    interface Database {
    /** 方法 `exec`：承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。 */
    exec(sql: string): void;
    /** 方法 `prepare`：承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。 */
    prepare<BindParameters extends unknown[] = unknown[]>(sql: string): Statement<BindParameters>;
    /** 方法 `pragma`：承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。 */
    pragma(pragma: string): unknown;
    /** 方法 `transaction`：承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。 */
    transaction<F extends (...args: unknown[]) => unknown>(fn: F): F;
    /** 方法 `close`：承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。 */
    close(): void;
  }

    class BetterSqlite3 implements Database {
    /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
    constructor(filename: string, options?: { readonly?: boolean; fileMustExist?: boolean });
    /**
     * 方法 `exec` 的职责说明。
     * `exec` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
     * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
     */
    exec(sql: string): void;
    /**
     * 方法 `prepare` 的职责说明。
     * `prepare` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
     * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
     */
    prepare<BindParameters extends unknown[] = unknown[]>(sql: string): Statement<BindParameters>;
    /**
     * 方法 `pragma` 的职责说明。
     * `pragma` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
     * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
     */
    pragma(pragma: string): unknown;
    /**
     * 方法 `transaction` 的职责说明。
     * `transaction` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
     * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
     */
    transaction<F extends (...args: unknown[]) => unknown>(fn: F): F;
    /**
     * 方法 `close` 的职责说明。
     * `close` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
     * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
     */
    close(): void;
  }

  export = BetterSqlite3;
    export type Database = BetterSqlite3;
}

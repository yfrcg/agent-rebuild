declare module "better-sqlite3" {
  interface Statement<BindParameters extends unknown[] = unknown[]> {
    run(...params: BindParameters): RunResult;
    get(...params: BindParameters): unknown;
    all(...params: BindParameters): unknown[];
  }

  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface Database {
    exec(sql: string): void;
    prepare<BindParameters extends unknown[] = unknown[]>(sql: string): Statement<BindParameters>;
    pragma(pragma: string): unknown;
    close(): void;
  }

  class BetterSqlite3 implements Database {
    constructor(filename: string, options?: { readonly?: boolean; fileMustExist?: boolean });
    exec(sql: string): void;
    prepare<BindParameters extends unknown[] = unknown[]>(sql: string): Statement<BindParameters>;
    pragma(pragma: string): unknown;
    close(): void;
  }

  export = BetterSqlite3;
  export type Database = BetterSqlite3;
}

/**
 * SQLite 驱动抽象 —— 双运行时（Bun / Node）。
 *
 * Blade 同时在 Bun（dev/prod 经 scripts/run-bun.js）与 Node（vitest、终端用户的
 * dist/blade.js）下运行。此模块复刻 server/routes/terminal.ts 中 pty 的双运行时
 * 模式：Bun 用内置 `bun:sqlite`，Node 用 `better-sqlite3`（原生模块，放在
 * optionalDependencies + 根 trustedDependencies）。两者均为同步 API，用一层薄
 * adapter 抹平方法名差异，暴露统一的 {@link SqliteDb} 接口。
 *
 * openDb 任何失败（模块缺失、加载/编译失败、无法打开文件）都返回 null，调用方据此
 * fail-open 回退到 JSONL 全量扫描 —— SQLite 是可选的派生缓存，绝不致命。
 */

export interface SqliteStatement {
  run(...params: unknown[]): void;
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(...params: unknown[]): T[];
}

export interface SqliteDb {
  /** 执行一段（可含多条）SQL，无返回。 */
  exec(sql: string): void;
  /** 预编译语句。 */
  prepare(sql: string): SqliteStatement;
  /** 在单个事务内运行 fn；异常时回滚。 */
  transaction<T>(fn: () => T): T;
  /** 读取一个 PRAGMA（simple 形式返回标量）。 */
  pragma(source: string): unknown;
  close(): void;
}

function isBunRuntime(): boolean {
  return typeof (globalThis as Record<string, unknown>).Bun !== 'undefined';
}

/** better-sqlite3 (Node) 适配。 */
function wrapBetterSqlite(db: BetterSqliteDatabase): SqliteDb {
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      return {
        run: (...params) => {
          stmt.run(...params);
        },
        get: <T,>(...params: unknown[]) => stmt.get(...params) as T | undefined,
        all: <T,>(...params: unknown[]) => stmt.all(...params) as T[],
      };
    },
    transaction: <T,>(fn: () => T): T => db.transaction(fn)(),
    pragma: (source) => db.pragma(source, { simple: true }),
    close: () => db.close(),
  };
}

/** bun:sqlite (Bun) 适配。 */
function wrapBunSqlite(db: BunDatabase): SqliteDb {
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const stmt = db.query(sql);
      return {
        run: (...params) => {
          stmt.run(...(params as never[]));
        },
        get: <T,>(...params: unknown[]) => stmt.get(...(params as never[])) as T | undefined,
        all: <T,>(...params: unknown[]) => stmt.all(...(params as never[])) as T[],
      };
    },
    // bun:sqlite 也提供 db.transaction(fn)，返回可调用的包装函数。
    transaction: <T,>(fn: () => T): T => db.transaction(fn)(),
    pragma: (source) => {
      const row = db.query(`PRAGMA ${source}`).get() as Record<string, unknown> | null;
      if (!row) return undefined;
      const values = Object.values(row);
      return values.length === 1 ? values[0] : row;
    },
    close: () => db.close(),
  };
}

const PRAGMAS = [
  'PRAGMA journal_mode=WAL;',
  'PRAGMA busy_timeout=5000;',
  'PRAGMA synchronous=NORMAL;',
  'PRAGMA foreign_keys=ON;',
].join('\n');

/**
 * 打开（或创建）一个 SQLite 数据库。失败返回 null（调用方回退 JSONL）。
 */
export async function openDb(dbPath: string): Promise<SqliteDb | null> {
  try {
    let db: SqliteDb;
    if (isBunRuntime()) {
      // Computed specifier + @vite-ignore so bundlers (Vite/esbuild used by some
      // test configs) don't try to statically resolve the Bun-only builtin.
      const bunSqlite = 'bun:sqlite';
      const { Database } = (await import(/* @vite-ignore */ bunSqlite)) as {
        Database: new (path: string) => BunDatabase;
      };
      db = wrapBunSqlite(new Database(dbPath));
    } else {
      const betterSqlite = 'better-sqlite3';
      const mod = (await import(/* @vite-ignore */ betterSqlite)) as unknown as {
        default: new (path: string) => BetterSqliteDatabase;
      };
      const Database = mod.default;
      db = wrapBetterSqlite(new Database(dbPath));
    }
    db.exec(PRAGMAS);
    return db;
  } catch {
    // 模块缺失 / 原生编译失败 / 无法打开：静默回退。
    return null;
  }
}

// ==================== 最小结构类型（避免硬依赖类型包） ====================

interface BetterSqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface BetterSqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): BetterSqliteStatement;
  transaction<T>(fn: () => T): () => T;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  close(): void;
}

interface BunStatement {
  run(...params: never[]): unknown;
  get(...params: never[]): unknown;
  all(...params: never[]): unknown[];
}
interface BunDatabase {
  exec(sql: string): unknown;
  query(sql: string): BunStatement;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

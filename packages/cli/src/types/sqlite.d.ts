// Minimal ambient declarations so the SQLite driver abstraction type-checks
// without pulling in @types/better-sqlite3. The driver uses only a tiny subset
// and re-wraps everything behind its own SqliteDb interface. `better-sqlite3`
// is an optionalDependency loaded dynamically under the Node runtime; `bun:sqlite`
// is Bun's built-in module loaded under the Bun runtime.

declare module 'better-sqlite3' {
  const Database: unknown;
  export default Database;
}

declare module 'bun:sqlite' {
  export const Database: unknown;
}

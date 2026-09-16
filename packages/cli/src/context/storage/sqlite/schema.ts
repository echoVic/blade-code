/**
 * SQLite 读侧投影的 schema 与迁移。
 *
 * 设计要点：SQLite 是 JSONL 的派生只读缓存，可随时 drop 重建。为**保证与现有
 * JSONL 扫描逐条一致**，`sessions` 表不在 SQL 里重实现元数据聚合，而是存整条
 * `StoredSessionMetadata` 的 JSON（由现有 `projectMetadataFromEntries` 计算），
 * 另加少量索引列用于排序/过滤。`parts`/`parts_fts` 承载跨会话全文搜索。
 */

/** schema 版本；不兼容变更时递增，落后版本直接 drop 重建（缓存可弃）。 */
export const SCHEMA_VERSION = 8;

import type { SqliteDb } from './driver.js';
import DROP_ALL from './drop-all.sql?raw';
import DDL from './schema.sql?raw';

/** 确保 schema 存在且为当前版本。版本落后（且无迁移路径）时 drop 重建 —— 投影是 纯派生缓存，重建成本可接受，换取零迁移负担。 */
export function migrate(db: SqliteDb): void {
  const version = Number(db.pragma('user_version') ?? 0);
  if (version === SCHEMA_VERSION) return;
  if (version > 0 && version !== SCHEMA_VERSION) {
    // 不兼容旧版本：丢弃重建。
    db.exec(DROP_ALL);
  }
  db.exec(DDL);
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION};`);
}

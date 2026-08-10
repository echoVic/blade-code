/**
 * SQLite 读侧投影的 schema 与迁移。
 *
 * 设计要点：SQLite 是 JSONL 的派生只读缓存，可随时 drop 重建。为**保证与现有
 * JSONL 扫描逐条一致**，`sessions` 表不在 SQL 里重实现元数据聚合，而是存整条
 * `StoredSessionMetadata` 的 JSON（由现有 `projectMetadataFromEntries` 计算），
 * 另加少量索引列用于排序/过滤。`parts`/`parts_fts` 承载跨会话全文搜索。
 */

/** schema 版本；不兼容变更时递增，落后版本直接 drop 重建（缓存可弃）。 */
export const SCHEMA_VERSION = 3;

const DDL = `
CREATE TABLE IF NOT EXISTS projection_state (
  project_path TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  last_seq     INTEGER NOT NULL DEFAULT 0,
  file_size    INTEGER NOT NULL DEFAULT 0,
  mtime_ms     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_path, session_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  project_path       TEXT NOT NULL,
  session_id         TEXT NOT NULL,
  root_id            TEXT,
  parent_id          TEXT,
  relation_type      TEXT,
  title              TEXT,
  agent_type         TEXT,
  model              TEXT,
  task_status        TEXT,
  archived_at        TEXT,
  last_message_time  TEXT,
  project_sort_key   TEXT NOT NULL,
  session_sort_key   TEXT NOT NULL,
  first_message_time TEXT,
  message_count      INTEGER NOT NULL DEFAULT 0,
  has_errors         INTEGER NOT NULL DEFAULT 0,
  is_subagent        INTEGER NOT NULL DEFAULT 0,
  -- 完整 StoredSessionMetadata JSON，读回时直接反序列化，保证与 JSONL 路径一致。
  metadata_json      TEXT NOT NULL,
  PRIMARY KEY (project_path, session_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_catalog ON sessions(
  last_message_time DESC,
  project_sort_key ASC,
  session_sort_key ASC
);
CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(
  archived_at,
  project_path,
  parent_id
);

CREATE TABLE IF NOT EXISTS parts (
  project_path TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  part_id      TEXT NOT NULL,
  message_id   TEXT,
  part_type    TEXT,
  role         TEXT,
  seq          INTEGER,
  timestamp    TEXT,
  text         TEXT,
  PRIMARY KEY (project_path, session_id, part_id)
);
CREATE INDEX IF NOT EXISTS idx_parts_session ON parts(project_path, session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS parts_fts USING fts5(
  text,
  project_path UNINDEXED,
  session_id   UNINDEXED,
  part_id      UNINDEXED,
  role         UNINDEXED,
  timestamp    UNINDEXED,
  seq          UNINDEXED,
  tokenize = 'unicode61'
);
`;

const DROP_ALL = `
DROP TABLE IF EXISTS parts_fts;
DROP TABLE IF EXISTS parts;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS projection_state;
`;

import type { SqliteDb } from './driver.js';

/**
 * 确保 schema 存在且为当前版本。版本落后（且无迁移路径）时 drop 重建 —— 投影是
 * 纯派生缓存，重建成本可接受，换取零迁移负担。
 */
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

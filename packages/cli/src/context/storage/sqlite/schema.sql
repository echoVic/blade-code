
CREATE TABLE IF NOT EXISTS surface_projection_meta (
  singleton        INTEGER PRIMARY KEY CHECK(singleton = 1),
  catalog_revision INTEGER NOT NULL DEFAULT 0 CHECK(catalog_revision >= 0)
);
INSERT OR IGNORE INTO surface_projection_meta (singleton, catalog_revision)
VALUES (1, 0);

CREATE TABLE IF NOT EXISTS projection_state (
  source_kind  TEXT NOT NULL CHECK(source_kind IN ('local', 'acp-remote')),
  source_file_path TEXT NOT NULL,
  project_path TEXT,
  session_id   TEXT NOT NULL,
  last_seq     INTEGER NOT NULL DEFAULT 0,
  file_size    INTEGER NOT NULL DEFAULT 0,
  mtime_ms     INTEGER NOT NULL DEFAULT 0,
  stat_fingerprint TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (source_kind, source_file_path)
);
CREATE INDEX IF NOT EXISTS idx_projection_state_session ON projection_state(
  source_kind, project_path, session_id
);

CREATE TABLE IF NOT EXISTS sessions (
  source_kind        TEXT NOT NULL CHECK(source_kind IN ('local', 'acp-remote')),
  source_file_path   TEXT NOT NULL,
  project_path       TEXT NOT NULL,
  session_id         TEXT NOT NULL,
  root_id            TEXT,
  parent_id          TEXT,
  relation_type      TEXT,
  title              TEXT,
  agent_type         TEXT,
  model              TEXT,
  task_status        TEXT,
  task_priority      TEXT,
  task_kind          TEXT,
  task_due_at        TEXT,
  archived_at        TEXT,
  last_message_time  TEXT,
  project_sort_key   TEXT NOT NULL,
  public_workspace_ref TEXT,
  public_workspace_sort_key TEXT NOT NULL,
  session_sort_key   TEXT NOT NULL,
  first_message_time TEXT,
  message_count      INTEGER NOT NULL DEFAULT 0,
  has_errors         INTEGER NOT NULL DEFAULT 0,
  is_subagent        INTEGER NOT NULL DEFAULT 0,
  -- 完整 StoredSessionMetadata JSON，读回时直接反序列化，保证与 JSONL 路径一致。
  metadata_json      TEXT NOT NULL,
  surface_digest     TEXT NOT NULL,
  PRIMARY KEY (source_kind, project_path, session_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_source_file ON sessions(
  source_kind, source_file_path
);
CREATE INDEX IF NOT EXISTS idx_sessions_catalog ON sessions(
  last_message_time DESC,
  source_kind DESC,
  public_workspace_sort_key ASC,
  session_sort_key ASC
);
CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(
  source_kind,
  archived_at,
  project_path,
  parent_id
);
-- 任务看板过滤/排序：按项目锁定后再按状态、优先级、截止时间收敛。
CREATE INDEX IF NOT EXISTS idx_sessions_task_board ON sessions(
  project_path,
  task_status,
  task_priority,
  task_due_at,
  source_kind
);
CREATE INDEX IF NOT EXISTS idx_sessions_task_status ON sessions(
  task_status,
  project_path,
  source_kind
);
CREATE INDEX IF NOT EXISTS idx_sessions_task_priority ON sessions(
  task_priority,
  task_due_at,
  source_kind
) WHERE task_priority IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_task_due_at ON sessions(
  task_due_at,
  source_kind
) WHERE task_due_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS parts (
  source_kind TEXT NOT NULL CHECK(source_kind IN ('local', 'acp-remote')),
  project_path TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  part_id      TEXT NOT NULL,
  message_id   TEXT,
  part_type    TEXT,
  role         TEXT,
  seq          INTEGER,
  timestamp    TEXT,
  text         TEXT,
  PRIMARY KEY (source_kind, project_path, session_id, part_id)
);
CREATE INDEX IF NOT EXISTS idx_parts_session ON parts(
  source_kind, project_path, session_id
);

CREATE TABLE IF NOT EXISTS surface_messages (
  source_kind TEXT NOT NULL CHECK(source_kind IN ('local', 'acp-remote')),
  project_path TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  message_seq  INTEGER NOT NULL CHECK(message_seq >= 0),
  message_id   TEXT NOT NULL,
  message_json TEXT NOT NULL,
  byte_count   INTEGER NOT NULL CHECK(byte_count >= 0),
  PRIMARY KEY (
    source_kind, project_path, session_id, message_seq, message_id
  )
);
CREATE INDEX IF NOT EXISTS idx_surface_messages_history ON surface_messages(
  source_kind, project_path, session_id, message_seq DESC, message_id DESC
);

CREATE VIRTUAL TABLE IF NOT EXISTS parts_fts USING fts5(
  text,
  source_kind UNINDEXED,
  project_path UNINDEXED,
  session_id   UNINDEXED,
  part_id      UNINDEXED,
  role         UNINDEXED,
  timestamp    UNINDEXED,
  seq          UNINDEXED,
  tokenize = 'unicode61'
);

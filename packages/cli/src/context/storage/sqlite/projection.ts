/**
 * SQLite 读侧投影的拉取式同步。
 *
 * 不依赖任何日志订阅（大量写入绕过 SessionEventLog），而是以 JSONL 为权威、按
 * mtime/size/last_seq 门控地增量同步。未变的会话近乎零成本跳过；变更的会话整条
 * 重物化（复用 `materializeSessionEvents` + 调用方注入的元数据聚合），从而天然
 * 正确处理 rewind（seq 截断）与文件重写。多进程安全靠 WAL + 幂等 upsert。
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { SessionEvent } from '../../types.js';
import { JSONLStore } from '../JSONLStore.js';
import { createLogger, LogCategory } from '../../../logging/Logger.js';
import {
  getBladeStorageRoot,
  getSessionFilePath,
  isValidSessionId,
  listProjectDirectories,
  unescapeProjectPath,
} from '../pathUtils.js';
import type { SqliteDb } from './driver.js';
import { openDb } from './driver.js';
import { migrate } from './schema.js';
import { materializeSessionEvents } from '../../../services/sessionRewind.js';

const logger = createLogger(LogCategory.SERVICE);

export interface ProjectedSession {
  /** 完整元数据（序列化存入 sessions.metadata_json）。 */
  metadata: Record<string, unknown> & {
    sessionId: string;
    projectPath: string;
    rootId: string;
    relationType?: string;
    title?: string;
    agentType?: string;
    model?: string;
    parentId?: string;
    taskStatus: string;
    messageCount: number;
    firstMessageTime: string;
    lastMessageTime: string;
    hasErrors: boolean;
  };
}

/**
 * 调用方注入的元数据聚合器（由 SessionService 提供，复用其 projectMetadataFromEntries
 * 以保证与 JSONL 扫描逐条一致）。返回 null 表示该 transcript 不可投影（如空文件）。
 */
export type MetadataDeriver = (
  entries: readonly SessionEvent[],
  sessionId: string,
  projectPath: string
) => ProjectedSession['metadata'] | null;

let dbCache: { path: string; db: Promise<SqliteDb | null> } | undefined;

/** 全局索引库路径：<root>/index.db。 */
export function getIndexDbPath(): string {
  return path.join(getBladeStorageRoot(), 'index.db');
}

/**
 * 打开并迁移全局索引库（按 db 路径缓存）。失败返回 null → 调用方回退 JSONL。
 * 按路径缓存而非无条件缓存：BLADE_STORAGE_ROOT 变化（如测试隔离）时自动重开。
 */
export async function getProjectionDb(): Promise<SqliteDb | null> {
  const dbPath = getIndexDbPath();
  if (dbCache && dbCache.path === dbPath) return dbCache.db;
  const db = (async () => {
    const opened = await openDb(dbPath);
    if (!opened) return null;
    try {
      migrate(opened);
      return opened;
    } catch {
      return null;
    }
  })();
  dbCache = { path: dbPath, db };
  return db;
}

/** 测试 seam：重置进程内 DB 缓存。 */
export function resetProjectionDbCache(): void {
  dbCache = undefined;
}

function extractSearchText(payload: unknown): string | null {
  if (payload && typeof payload === 'object') {
    const text = (payload as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return null;
}

/**
 * 用一条会话的规范化事件重建 parts / parts_fts 行并写入。调用方保证在事务内。
 */
function writeParts(
  db: SqliteDb,
  projectPath: string,
  sessionId: string,
  events: readonly SessionEvent[]
): void {
  db.prepare('DELETE FROM parts WHERE project_path=? AND session_id=?').run(
    projectPath,
    sessionId
  );
  db.prepare('DELETE FROM parts_fts WHERE project_path=? AND session_id=?').run(
    projectPath,
    sessionId
  );

  const roleByMessage = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'message_created') {
      roleByMessage.set(event.data.messageId, event.data.role);
    }
  }

  const insertPart = db.prepare(
    `INSERT OR REPLACE INTO parts
       (project_path, session_id, part_id, message_id, part_type, role, seq, timestamp, text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertFts = db.prepare(
    `INSERT INTO parts_fts (text, project_path, session_id, part_id, role, timestamp, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  for (const event of events) {
    if (event.type !== 'part_created' && event.type !== 'part_updated') continue;
    if (event.data.partType !== 'text') continue;
    const text = extractSearchText(event.data.payload);
    if (text === null) continue;
    const role = roleByMessage.get(event.data.messageId) ?? 'assistant';
    const seq = event.seq ?? 0;
    insertPart.run(
      projectPath,
      sessionId,
      event.data.partId,
      event.data.messageId,
      event.data.partType,
      role,
      seq,
      event.timestamp,
      text
    );
    // 仅对用户/助手可见文本建全文索引（与 TranscriptSearch 现有语义一致）。
    if (role === 'user' || role === 'assistant') {
      insertFts.run(text, projectPath, sessionId, event.data.partId, role, event.timestamp, seq);
    }
  }
}

function upsertSession(
  db: SqliteDb,
  meta: ProjectedSession['metadata']
): void {
  db.prepare(
    `INSERT INTO sessions
       (project_path, session_id, root_id, parent_id, relation_type, title,
        agent_type, model, task_status, last_message_time, first_message_time,
        message_count, has_errors, is_subagent, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_path, session_id) DO UPDATE SET
       root_id=excluded.root_id, parent_id=excluded.parent_id,
       relation_type=excluded.relation_type, title=excluded.title,
       agent_type=excluded.agent_type, model=excluded.model,
       task_status=excluded.task_status, last_message_time=excluded.last_message_time,
       first_message_time=excluded.first_message_time, message_count=excluded.message_count,
       has_errors=excluded.has_errors, is_subagent=excluded.is_subagent,
       metadata_json=excluded.metadata_json`
  ).run(
    meta.projectPath,
    meta.sessionId,
    meta.rootId,
    meta.parentId ?? null,
    meta.relationType ?? null,
    meta.title ?? null,
    meta.agentType ?? null,
    meta.model ?? null,
    meta.taskStatus,
    meta.lastMessageTime,
    meta.firstMessageTime,
    meta.messageCount,
    meta.hasErrors ? 1 : 0,
    meta.relationType === 'subagent' ? 1 : 0,
    JSON.stringify(meta)
  );
}

function deleteSessionRows(
  db: SqliteDb,
  projectPath: string,
  sessionId: string
): void {
  for (const table of ['sessions', 'parts', 'parts_fts', 'projection_state']) {
    db.prepare(`DELETE FROM ${table} WHERE project_path=? AND session_id=?`).run(
      projectPath,
      sessionId
    );
  }
}

interface StateRow {
  last_seq: number;
  file_size: number;
  mtime_ms: number;
}

/**
 * 同步单个会话。mtime/size/last_seq 全等则跳过；否则整条重物化后 upsert。
 * @param filePath 可选：实际 JSONL 路径（syncAll 传入扫描到的真实路径，支持同一
 *   sessionId 存在于多个存储目录的边界情形）；缺省时按 projectPath 推导规范路径。
 * 返回是否发生了写入（true=有变更）。
 */
export async function syncSession(
  db: SqliteDb,
  sessionId: string,
  projectPath: string,
  derive: MetadataDeriver,
  filePath: string = getSessionFilePath(projectPath, sessionId)
): Promise<boolean> {
  let fileStat: { size: number; mtimeMs: number };
  try {
    const s = await stat(filePath);
    fileStat = { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    // 文件不存在 → GC 掉可能残留的行。
    db.transaction(() => deleteSessionRows(db, projectPath, sessionId));
    return true;
  }

  const state = db
    .prepare(
      'SELECT last_seq, file_size, mtime_ms FROM projection_state WHERE project_path=? AND session_id=?'
    )
    .get<StateRow>(projectPath, sessionId);

  if (
    state &&
    state.file_size === fileStat.size &&
    state.mtime_ms === Math.floor(fileStat.mtimeMs)
  ) {
    return false; // 未变，廉价跳过（列表加速的关键）。
  }

  // 整条重物化：始终正确（含 rewind seq 截断 / 文件重写），只对已变更的会话执行。
  const store = new JSONLStore(filePath);
  const raw = await store.readAll();
  if (raw.length === 0) return false;
  const events = materializeSessionEvents(raw);
  const meta = derive(raw, sessionId, projectPath);
  if (!meta) return false;
  const lastSeq = raw.reduce((max, e) => (typeof e.seq === 'number' && e.seq > max ? e.seq : max), 0);

  // 去重：同一 (projectPath, sessionId) 可能来自多个存储目录，保留 lastMessageTime
  // 更新的一条（与 JSONL 扫描 + compareSessionCatalogItems 的择新语义一致）。
  const existing = db
    .prepare('SELECT last_message_time FROM sessions WHERE project_path=? AND session_id=?')
    .get<{ last_message_time: string | null }>(meta.projectPath, meta.sessionId);
  if (
    existing &&
    typeof existing.last_message_time === 'string' &&
    existing.last_message_time > meta.lastMessageTime
  ) {
    // 已有更新的一条：仅登记同步游标，避免用较旧数据覆盖。
    db.prepare(
      `INSERT INTO projection_state (project_path, session_id, last_seq, file_size, mtime_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_path, session_id) DO UPDATE SET
         last_seq=excluded.last_seq, file_size=excluded.file_size, mtime_ms=excluded.mtime_ms`
    ).run(projectPath, sessionId, lastSeq, fileStat.size, Math.floor(fileStat.mtimeMs));
    return true;
  }

  db.transaction(() => {
    upsertSession(db, meta);
    writeParts(db, meta.projectPath, meta.sessionId, events);
    db.prepare(
      `INSERT INTO projection_state (project_path, session_id, last_seq, file_size, mtime_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_path, session_id) DO UPDATE SET
         last_seq=excluded.last_seq, file_size=excluded.file_size, mtime_ms=excluded.mtime_ms`
    ).run(projectPath, sessionId, lastSeq, fileStat.size, Math.floor(fileStat.mtimeMs));
  });
  return true;
}

/**
 * 全量同步：枚举所有项目/会话文件逐个 syncSession，并 GC 掉 JSONL 已不存在的行。
 */
export async function syncAll(db: SqliteDb, derive: MetadataDeriver): Promise<void> {
  const { readdir } = await import('node:fs/promises');
  const dirs = await listProjectDirectories();
  const seen = new Set<string>();

  for (const dir of dirs) {
    const projectPath = unescapeProjectPath(dir);
    const projectDir = path.join(getBladeStorageRoot(), 'projects', dir);
    let files: string[];
    try {
      files = await readdir(projectDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.slice(0, -'.jsonl'.length);
      if (!isValidSessionId(sessionId)) continue;
      seen.add(`${projectPath}\u0000${sessionId}`);
      try {
        await syncSession(
          db,
          sessionId,
          projectPath,
          derive,
          path.join(projectDir, file)
        );
      } catch (error) {
        // 与 JSONL 扫描保持一致的诊断：损坏 transcript 记一次告警（不含路径）。
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          logger.warn(
            `[SessionService] Skipping invalid session transcript: ${sessionId}`
          );
        }
      }
    }
  }

  // GC：projection_state 中 JSONL 已不存在的行。
  const known = db
    .prepare('SELECT project_path, session_id FROM projection_state')
    .all<{ project_path: string; session_id: string }>();
  for (const row of known) {
    if (!seen.has(`${row.project_path}\u0000${row.session_id}`)) {
      db.transaction(() => deleteSessionRows(db, row.project_path, row.session_id));
    }
  }
}

/** 删除单个会话的所有投影行（供 deleteSession 钩子 best-effort 调用）。 */
export function removeSessionFromProjection(
  db: SqliteDb,
  sessionId: string,
  projectPath: string
): void {
  db.transaction(() => deleteSessionRows(db, projectPath, sessionId));
}

/**
 * 删除 index.db（含 -wal/-shm）并从 JSONL 全量重建。返回同步的会话数；投影不可用
 * 返回 null。供 `blade doctor --rebuild-index` 调用。
 */
export async function rebuildProjectionIndex(
  derive: MetadataDeriver
): Promise<number | null> {
  const { rm } = await import('node:fs/promises');
  resetProjectionDbCache();
  const base = getIndexDbPath();
  for (const suffix of ['', '-wal', '-shm']) {
    await rm(`${base}${suffix}`, { force: true }).catch(() => undefined);
  }
  const db = await getProjectionDb();
  if (!db) return null;
  await syncAll(db, derive);
  const row = db.prepare('SELECT COUNT(*) c FROM sessions').get<{ c: number }>();
  return row?.c ?? 0;
}

export interface ProjectionTextRow {
  session_id: string;
  role: string;
  timestamp: string | null;
  text: string;
}

/**
 * FTS 候选检索：返回含 query token 的用户/助手文本行，按 timestamp 倒序。
 * 调用方（TranscriptSearch）在其上套用原有 substring/snippet 逻辑以保持语义一致。
 * FTS 是「缩小候选集」，最终匹配仍由调用方判定，避免分词差异导致结果漂移。
 */
export function searchProjectionText(
  db: SqliteDb,
  query: string,
  projectPath: string | undefined,
  limit: number
): ProjectionTextRow[] {
  // 将 query 转为安全的 FTS 前缀匹配 token，规避 FTS5 语法字符注入。
  const token = query.replace(/["*]/g, ' ').trim().split(/\s+/)[0];
  if (!token) return [];
  const match = `"${token}"*`;
  const sql = projectPath
    ? `SELECT session_id, role, timestamp, text FROM parts_fts
         WHERE parts_fts MATCH ? AND project_path = ?
         ORDER BY timestamp DESC LIMIT ?`
    : `SELECT session_id, role, timestamp, text FROM parts_fts
         WHERE parts_fts MATCH ?
         ORDER BY timestamp DESC LIMIT ?`;
  const stmt = db.prepare(sql);
  return projectPath
    ? stmt.all<ProjectionTextRow>(match, projectPath, limit)
    : stmt.all<ProjectionTextRow>(match, limit);
}

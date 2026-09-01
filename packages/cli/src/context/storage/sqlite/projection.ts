/**
 * SQLite 读侧投影的拉取式同步。
 *
 * 不依赖任何日志订阅（大量写入绕过 SessionEventLog），而是以 JSONL 为权威、按
 * mtime/size/last_seq 门控地增量同步。未变的会话近乎零成本跳过；变更的会话整条
 * 重物化（复用 `materializeSessionEvents` + 调用方注入的元数据聚合），从而天然
 * 正确处理 rewind（seq 截断）与文件重写。多进程安全靠 WAL + 幂等 upsert。
 */

import type { BigIntStats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type AcpRemoteStateScope,
  AcpRemoteWorkspaceStateError,
  assertAcpRemoteSessionTranscriptIdentity,
  assertAcpRemoteStateFile,
  deriveAcpRemoteHostStateRoot,
  listValidatedAcpRemoteStateScopes,
  parseAcpRemoteWorkspaceDescriptor,
  withValidatedAcpRemoteStateScope,
} from '../../../acp/AcpRemoteWorkspace.js';
import { createLogger, LogCategory } from '../../../logging/Logger.js';
import { sessionCatalogSortKey } from '../../../services/sessionCatalog.js';
import { materializeSessionEvents } from '../../../services/sessionRewind.js';
import type { SessionEvent } from '../../types.js';
import { JSONLStore } from '../JSONLStore.js';
import {
  getAcpRemoteSessionFilePath,
  getBladeStorageRoot,
  getSessionFilePath,
  isValidSessionId,
  listSessionStorageScopes,
} from '../pathUtils.js';
import type { SqliteDb } from './driver.js';
import { openDb } from './driver.js';
import { migrate } from './schema.js';

const logger = createLogger(LogCategory.SERVICE);
type ProjectionSourceKind = 'local' | 'acp-remote';

interface ProjectionIO {
  readSession(store: JSONLStore): Promise<SessionEvent[]>;
}

const defaultProjectionIO: ProjectionIO = {
  readSession(store) {
    return store.readAll();
  },
};
let projectionIO = defaultProjectionIO;

export function __setProjectionIOForTesting(io: ProjectionIO): void {
  projectionIO = io;
}

export function __resetProjectionIOForTesting(): void {
  projectionIO = defaultProjectionIO;
}

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
    taskPriority?: string;
    taskKind?: string;
    taskDueAt?: string;
    archivedAt?: string;
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
  projectPath: string,
  sourceKind: ProjectionSourceKind,
  actualFilePath?: string
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
  sourceKind: ProjectionSourceKind,
  projectPath: string,
  sessionId: string,
  events: readonly SessionEvent[]
): void {
  db.prepare(
    'DELETE FROM parts WHERE source_kind=? AND project_path=? AND session_id=?'
  ).run(sourceKind, projectPath, sessionId);
  db.prepare(
    'DELETE FROM parts_fts WHERE source_kind=? AND project_path=? AND session_id=?'
  ).run(sourceKind, projectPath, sessionId);

  const roleByMessage = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'message_created') {
      roleByMessage.set(event.data.messageId, event.data.role);
    }
  }

  const insertPart = db.prepare(
    `INSERT OR REPLACE INTO parts
       (source_kind, project_path, session_id, part_id, message_id, part_type, role,
        seq, timestamp, text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertFts = db.prepare(
    `INSERT INTO parts_fts
       (text, source_kind, project_path, session_id, part_id, role, timestamp, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const event of events) {
    if (event.type !== 'part_created' && event.type !== 'part_updated') continue;
    if (event.data.partType !== 'text') continue;
    const text = extractSearchText(event.data.payload);
    if (text === null) continue;
    const role = roleByMessage.get(event.data.messageId) ?? 'assistant';
    const seq = event.seq ?? 0;
    insertPart.run(
      sourceKind,
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
      insertFts.run(
        text,
        sourceKind,
        projectPath,
        sessionId,
        event.data.partId,
        role,
        event.timestamp,
        seq
      );
    }
  }
}

function upsertSession(
  db: SqliteDb,
  sourceKind: ProjectionSourceKind,
  meta: ProjectedSession['metadata']
): void {
  db.prepare(
    `INSERT INTO sessions
       (source_kind, project_path, session_id, root_id, parent_id, relation_type, title,
        agent_type, model, task_status, task_priority, task_kind, task_due_at,
        archived_at, last_message_time, project_sort_key,
        session_sort_key, first_message_time, message_count, has_errors,
        is_subagent, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_kind, project_path, session_id) DO UPDATE SET
       root_id=excluded.root_id, parent_id=excluded.parent_id,
       relation_type=excluded.relation_type, title=excluded.title,
       agent_type=excluded.agent_type, model=excluded.model,
       task_status=excluded.task_status, task_priority=excluded.task_priority,
       task_kind=excluded.task_kind, task_due_at=excluded.task_due_at,
       archived_at=excluded.archived_at,
       last_message_time=excluded.last_message_time,
       project_sort_key=excluded.project_sort_key,
       session_sort_key=excluded.session_sort_key,
       first_message_time=excluded.first_message_time, message_count=excluded.message_count,
       has_errors=excluded.has_errors, is_subagent=excluded.is_subagent,
       metadata_json=excluded.metadata_json`
  ).run(
    sourceKind,
    meta.projectPath,
    meta.sessionId,
    meta.rootId,
    meta.parentId ?? null,
    meta.relationType ?? null,
    meta.title ?? null,
    meta.agentType ?? null,
    meta.model ?? null,
    meta.taskStatus,
    meta.taskPriority ?? null,
    meta.taskKind ?? null,
    meta.taskDueAt ?? null,
    meta.archivedAt ?? null,
    meta.lastMessageTime,
    sessionCatalogSortKey(meta.projectPath),
    sessionCatalogSortKey(meta.sessionId),
    meta.firstMessageTime,
    meta.messageCount,
    meta.hasErrors ? 1 : 0,
    meta.relationType === 'subagent' ? 1 : 0,
    JSON.stringify(meta)
  );
}

function deleteSessionContentRows(
  db: SqliteDb,
  sourceKind: ProjectionSourceKind,
  projectPath: string,
  sessionId: string
): void {
  for (const table of ['sessions', 'parts', 'parts_fts']) {
    db.prepare(
      `DELETE FROM ${table} WHERE source_kind=? AND project_path=? AND session_id=?`
    ).run(sourceKind, projectPath, sessionId);
  }
}

function deleteSessionRows(
  db: SqliteDb,
  sourceKind: ProjectionSourceKind,
  projectPath: string,
  sessionId: string
): void {
  deleteSessionContentRows(db, sourceKind, projectPath, sessionId);
  db.prepare(
    'DELETE FROM projection_state WHERE source_kind=? AND project_path=? AND session_id=?'
  ).run(sourceKind, projectPath, sessionId);
}

function deleteSessionContentForSourceFile(
  db: SqliteDb,
  sourceKind: ProjectionSourceKind,
  filePath: string
): void {
  const rows = db
    .prepare(
      `SELECT project_path, session_id FROM sessions
       WHERE source_kind=? AND json_extract(metadata_json, '$.filePath')=?`
    )
    .all<{ project_path: string; session_id: string }>(sourceKind, filePath);
  for (const row of rows) {
    deleteSessionContentRows(db, sourceKind, row.project_path, row.session_id);
  }
}

function upsertProjectionState(
  db: SqliteDb,
  sourceKind: ProjectionSourceKind,
  projectPath: string,
  sessionId: string,
  lastSeq: number,
  fileSize: number,
  mtimeMs: number,
  statFingerprint: string
): void {
  db.prepare(
    `INSERT INTO projection_state
       (source_kind, project_path, session_id, last_seq, file_size, mtime_ms,
        stat_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_kind, project_path, session_id) DO UPDATE SET
       last_seq=excluded.last_seq, file_size=excluded.file_size,
       mtime_ms=excluded.mtime_ms, stat_fingerprint=excluded.stat_fingerprint`
  ).run(
    sourceKind,
    projectPath,
    sessionId,
    lastSeq,
    fileSize,
    mtimeMs,
    statFingerprint
  );
}

interface StateRow {
  last_seq: number;
  file_size: number;
  mtime_ms: number;
  stat_fingerprint: string;
}

interface ProjectionStateRow extends StateRow {
  source_kind: ProjectionSourceKind;
  project_path: string;
  session_id: string;
}

interface ProjectionIdentityRow {
  source_kind: ProjectionSourceKind;
  project_path: string;
  session_id: string;
}

interface ProjectionCandidate {
  kind: ProjectionSourceKind;
  projectPath: string;
  sessionId: string;
  filePath: string;
}

function statFingerprint(value: BigIntStats): string {
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
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
  filePath?: string,
  sourceKind: ProjectionSourceKind = 'local'
): Promise<boolean> {
  if (sourceKind === 'acp-remote') {
    return withValidatedAcpRemoteStateScope(projectPath, async (validatedScope) => {
      const expectedFilePath = getAcpRemoteSessionFilePath(validatedScope, sessionId);
      const actualFilePath = filePath ?? expectedFilePath;
      if (actualFilePath !== expectedFilePath) {
        throw new AcpRemoteWorkspaceStateError('remote-session-file-path');
      }
      return syncSessionValidated(
        db,
        sessionId,
        projectPath,
        derive,
        actualFilePath,
        sourceKind,
        validatedScope
      );
    });
  }

  return syncSessionValidated(
    db,
    sessionId,
    projectPath,
    derive,
    filePath ?? getSessionFilePath(projectPath, sessionId),
    sourceKind
  );
}

async function syncSessionValidated(
  db: SqliteDb,
  sessionId: string,
  projectPath: string,
  derive: MetadataDeriver,
  filePath: string,
  sourceKind: ProjectionSourceKind,
  validatedRemoteScope?: AcpRemoteStateScope
): Promise<boolean> {
  if (sourceKind === 'acp-remote') {
    if (!validatedRemoteScope) {
      throw new AcpRemoteWorkspaceStateError('remote-session-scope');
    }
    try {
      await assertAcpRemoteStateFile(validatedRemoteScope, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      db.transaction(() => deleteSessionRows(db, sourceKind, projectPath, sessionId));
      return true;
    }
  }
  let fileStat: BigIntStats;
  try {
    fileStat = await stat(filePath, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (sourceKind === 'acp-remote' && code !== 'ENOENT') {
      throw error;
    }
    // 文件不存在 → GC 掉可能残留的行。
    db.transaction(() => deleteSessionRows(db, sourceKind, projectPath, sessionId));
    return true;
  }

  const state = db
    .prepare(
      `SELECT last_seq, file_size, mtime_ms, stat_fingerprint FROM projection_state
       WHERE source_kind=? AND project_path=? AND session_id=?`
    )
    .get<StateRow>(sourceKind, projectPath, sessionId);

  if (
    sourceKind === 'local' &&
    state &&
    state.stat_fingerprint === statFingerprint(fileStat)
  ) {
    return false; // 未变，廉价跳过（列表加速的关键）。
  }

  // 整条重物化：始终正确（含 rewind seq 截断 / 文件重写），只对已变更的会话执行。
  const store = new JSONLStore(filePath);
  let raw: SessionEvent[];
  try {
    raw = await projectionIO.readSession(store);
  } catch (error) {
    if (
      sourceKind !== 'acp-remote' ||
      (error as NodeJS.ErrnoException).code !== 'ENOENT'
    ) {
      throw error;
    }
    db.transaction(() => deleteSessionRows(db, sourceKind, projectPath, sessionId));
    return true;
  }
  if (sourceKind === 'acp-remote' && raw.length === 0) {
    try {
      await assertAcpRemoteStateFile(validatedRemoteScope!, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        db.transaction(() => deleteSessionRows(db, sourceKind, projectPath, sessionId));
        return true;
      }
      throw error;
    }
    throw new AcpRemoteWorkspaceStateError('remote-session-empty');
  }
  const localCreated =
    sourceKind === 'local'
      ? raw.find(
          (entry): entry is Extract<SessionEvent, { type: 'session_created' }> =>
            entry.type === 'session_created'
        )
      : undefined;
  const localSourceContainsRemoteDescriptor =
    sourceKind === 'local' &&
    localCreated !== undefined &&
    Object.hasOwn(localCreated.data, 'remoteWorkspace');
  let durableRemoteDescriptor: ReturnType<
    typeof parseAcpRemoteWorkspaceDescriptor
  > | null = null;
  if (sourceKind === 'acp-remote') {
    const remoteCreated = assertAcpRemoteSessionTranscriptIdentity(
      raw,
      sessionId,
      projectPath
    );
    durableRemoteDescriptor = parseAcpRemoteWorkspaceDescriptor(
      remoteCreated.data.remoteWorkspace
    );
  } else if (localSourceContainsRemoteDescriptor) {
    parseAcpRemoteWorkspaceDescriptor(localCreated.data.remoteWorkspace);
  }
  const lastSeq = raw.reduce(
    (max, e) => (typeof e.seq === 'number' && e.seq > max ? e.seq : max),
    0
  );
  const events = materializeSessionEvents(raw);
  const meta = localSourceContainsRemoteDescriptor
    ? null
    : derive(raw, sessionId, projectPath, sourceKind, filePath);
  const projectedRemoteWorkspace = meta?.remoteWorkspace;
  if (sourceKind === 'acp-remote') {
    if (
      !meta ||
      meta.sessionId !== sessionId ||
      meta.projectPath !== projectPath ||
      projectedRemoteWorkspace === undefined
    ) {
      throw new AcpRemoteWorkspaceStateError('remote-session-metadata');
    }
    const descriptor = parseAcpRemoteWorkspaceDescriptor(projectedRemoteWorkspace);
    if (
      !durableRemoteDescriptor ||
      descriptor.style !== durableRemoteDescriptor.style ||
      descriptor.wirePath !== durableRemoteDescriptor.wirePath ||
      descriptor.exactIdentity !== durableRemoteDescriptor.exactIdentity ||
      descriptor.collisionIdentity !== durableRemoteDescriptor.collisionIdentity
    ) {
      throw new AcpRemoteWorkspaceStateError('remote-session-descriptor');
    }
    if (deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity) !== projectPath) {
      throw new AcpRemoteWorkspaceStateError('remote-session-project-path');
    }
  }
  if (
    raw.length === 0 ||
    !meta ||
    (sourceKind === 'local' && projectedRemoteWorkspace !== undefined)
  ) {
    db.transaction(() => {
      if (localSourceContainsRemoteDescriptor) {
        deleteSessionContentForSourceFile(db, sourceKind, filePath);
        deleteSessionRows(db, sourceKind, projectPath, sessionId);
      } else {
        deleteSessionContentRows(db, sourceKind, projectPath, sessionId);
        upsertProjectionState(
          db,
          sourceKind,
          projectPath,
          sessionId,
          lastSeq,
          Number(fileStat.size),
          Number(fileStat.mtimeMs),
          statFingerprint(fileStat)
        );
      }
    });
    return true;
  }

  // 去重：同一 (projectPath, sessionId) 可能来自多个存储目录，保留 lastMessageTime
  // 更新的一条（与 JSONL 扫描 + compareSessionCatalogItems 的择新语义一致）。
  const existing = db
    .prepare(
      `SELECT last_message_time FROM sessions
       WHERE source_kind=? AND project_path=? AND session_id=?`
    )
    .get<{ last_message_time: string | null }>(
      sourceKind,
      meta.projectPath,
      meta.sessionId
    );
  const expectedCanonicalPath =
    sourceKind === 'acp-remote' && validatedRemoteScope
      ? getAcpRemoteSessionFilePath(validatedRemoteScope, meta.sessionId)
      : getSessionFilePath(meta.projectPath, meta.sessionId);
  const isCanonicalSource =
    path.resolve(filePath) === path.resolve(expectedCanonicalPath);
  if (
    existing &&
    !isCanonicalSource &&
    typeof existing.last_message_time === 'string' &&
    existing.last_message_time > meta.lastMessageTime
  ) {
    // 已有更新的一条：仅登记同步游标，避免用较旧数据覆盖。
    upsertProjectionState(
      db,
      sourceKind,
      projectPath,
      sessionId,
      lastSeq,
      Number(fileStat.size),
      Number(fileStat.mtimeMs),
      statFingerprint(fileStat)
    );
    return true;
  }

  db.transaction(() => {
    upsertSession(db, sourceKind, meta);
    writeParts(db, sourceKind, meta.projectPath, meta.sessionId, events);
    upsertProjectionState(
      db,
      sourceKind,
      projectPath,
      sessionId,
      lastSeq,
      Number(fileStat.size),
      Number(fileStat.mtimeMs),
      statFingerprint(fileStat)
    );
  });
  return true;
}

/**
 * 全量同步：枚举所有项目/会话文件逐个 syncSession，并 GC 掉 JSONL 已不存在的行。
 */
const syncAllState = new WeakMap<
  SqliteDb,
  { inFlight?: Promise<void>; lastCompletedAt?: number }
>();

function removeMissingProjectionRows(
  db: SqliteDb,
  sourceKind: ProjectionSourceKind,
  projectPath: string,
  seenSessionIds: ReadonlySet<string>
): void {
  const known = db
    .prepare(
      `SELECT session_id FROM projection_state
       WHERE source_kind=? AND project_path=?
       UNION
       SELECT session_id FROM sessions
       WHERE source_kind=? AND project_path=?
       UNION
       SELECT session_id FROM parts
       WHERE source_kind=? AND project_path=?
       UNION
       SELECT session_id FROM parts_fts
       WHERE source_kind=? AND project_path=?`
    )
    .all<{ session_id: string }>(
      sourceKind,
      projectPath,
      sourceKind,
      projectPath,
      sourceKind,
      projectPath,
      sourceKind,
      projectPath
    );
  for (const row of known) {
    if (!seenSessionIds.has(row.session_id)) {
      deleteSessionRows(db, sourceKind, projectPath, row.session_id);
    }
  }
}

export async function syncAcpRemoteScope(
  db: SqliteDb,
  derive: MetadataDeriver,
  projectPath: string
): Promise<void> {
  try {
    await withValidatedAcpRemoteStateScope(projectPath, async (validatedScope) => {
      const candidates = (await readdir(String(validatedScope))).flatMap((file) => {
        if (!file.endsWith('.jsonl')) return [];
        const sessionId = file.slice(0, -'.jsonl'.length);
        if (!isValidSessionId(sessionId)) return [];
        return [
          {
            filePath: getAcpRemoteSessionFilePath(validatedScope, sessionId),
            sessionId,
          },
        ];
      });
      const seenSessionIds = new Set(
        candidates.map((candidate) => candidate.sessionId)
      );
      const concurrency = Math.min(32, candidates.length);
      let nextIndex = 0;
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (nextIndex < candidates.length) {
            const candidate = candidates[nextIndex++];
            if (!candidate) continue;
            await syncSessionValidated(
              db,
              candidate.sessionId,
              projectPath,
              derive,
              candidate.filePath,
              'acp-remote',
              validatedScope
            );
          }
        })
      );
      db.transaction(() => {
        removeMissingProjectionRows(db, 'acp-remote', projectPath, seenSessionIds);
      });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    db.transaction(() => {
      removeMissingProjectionRows(db, 'acp-remote', projectPath, new Set());
    });
  }
}

export async function syncAllAcpRemoteScopes(
  db: SqliteDb,
  derive: MetadataDeriver
): Promise<void> {
  const scopes = await listValidatedAcpRemoteStateScopes();
  for (const scope of scopes) {
    await syncAcpRemoteScope(db, derive, String(scope));
  }

  const liveRoots = new Set(scopes.map(String));
  const projectedRoots = db
    .prepare(
      `SELECT project_path FROM projection_state WHERE source_kind='acp-remote'
       UNION
       SELECT project_path FROM sessions WHERE source_kind='acp-remote'
       UNION
       SELECT project_path FROM parts WHERE source_kind='acp-remote'
       UNION
       SELECT project_path FROM parts_fts WHERE source_kind='acp-remote'`
    )
    .all<{ project_path: string }>();
  for (const row of projectedRoots) {
    if (!liveRoots.has(row.project_path)) {
      db.transaction(() => {
        removeMissingProjectionRows(db, 'acp-remote', row.project_path, new Set());
      });
    }
  }
}

export async function syncAll(
  db: SqliteDb,
  derive: MetadataDeriver,
  maxAgeMs = 0
): Promise<void> {
  const state = syncAllState.get(db) ?? {};
  syncAllState.set(db, state);
  if (state.inFlight) return state.inFlight;
  if (
    maxAgeMs > 0 &&
    state.lastCompletedAt !== undefined &&
    Date.now() - state.lastCompletedAt <= maxAgeMs
  ) {
    return;
  }

  const inFlight = syncAllUncached(db, derive);
  state.inFlight = inFlight;
  try {
    await inFlight;
    state.lastCompletedAt = Date.now();
  } finally {
    if (state.inFlight === inFlight) state.inFlight = undefined;
  }
}

async function syncAllUncached(db: SqliteDb, derive: MetadataDeriver): Promise<void> {
  const seen = new Set<string>();
  const scopes = await listSessionStorageScopes();
  const projectFiles = await Promise.all(
    scopes.map(async (scope) => {
      if (scope.kind === 'local') {
        try {
          const files = await readdir(scope.storagePath);
          return files.flatMap((file) => {
            if (!file.endsWith('.jsonl')) return [];
            const sessionId = file.slice(0, -'.jsonl'.length);
            if (!isValidSessionId(sessionId)) return [];
            return [
              {
                kind: 'local' as const,
                filePath: path.join(scope.storagePath, file),
                projectPath: scope.projectPath,
                sessionId,
              },
            ];
          });
        } catch {
          return [];
        }
      }

      return withValidatedAcpRemoteStateScope(
        scope.storagePath,
        async (validatedScope) => {
          const files = await readdir(String(validatedScope));
          return files.flatMap((file) => {
            if (!file.endsWith('.jsonl')) return [];
            const sessionId = file.slice(0, -'.jsonl'.length);
            if (!isValidSessionId(sessionId)) return [];
            return [
              {
                kind: 'acp-remote' as const,
                filePath: getAcpRemoteSessionFilePath(validatedScope, sessionId),
                projectPath: scope.projectPath,
                sessionId,
              },
            ];
          });
        }
      );
    })
  );
  const candidates: ProjectionCandidate[] = projectFiles.flat();
  for (const candidate of candidates) {
    seen.add(
      `${candidate.kind}\u0000${candidate.projectPath}\u0000${candidate.sessionId}`
    );
  }

  const knownState = db
    .prepare(
      `SELECT source_kind, project_path, session_id, last_seq, file_size, mtime_ms,
              stat_fingerprint
       FROM projection_state`
    )
    .all<ProjectionStateRow>();
  const stateBySession = new Map(
    knownState.map((row) => [
      `${row.source_kind}\u0000${row.project_path}\u0000${row.session_id}`,
      row,
    ])
  );
  const staleCandidates: typeof candidates = [];
  const statConcurrency = Math.min(128, candidates.length);
  let nextStatIndex = 0;
  await Promise.all(
    Array.from({ length: statConcurrency }, async () => {
      while (nextStatIndex < candidates.length) {
        const candidate = candidates[nextStatIndex++];
        if (!candidate) continue;
        if (candidate.kind === 'acp-remote') {
          staleCandidates.push(candidate);
          continue;
        }
        try {
          const fileStat = await stat(candidate.filePath, { bigint: true });
          const state = stateBySession.get(
            `${candidate.kind}\u0000${candidate.projectPath}\u0000${candidate.sessionId}`
          );
          if (state && state.stat_fingerprint === statFingerprint(fileStat)) {
            continue;
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // Let syncSession handle a file removed after directory enumeration.
          if (code !== 'ENOENT') throw error;
        }
        staleCandidates.push(candidate);
      }
    })
  );

  const syncConcurrency = Math.min(32, staleCandidates.length);
  let nextSyncIndex = 0;
  await Promise.all(
    Array.from({ length: syncConcurrency }, async () => {
      while (nextSyncIndex < staleCandidates.length) {
        const candidate = staleCandidates[nextSyncIndex++];
        if (!candidate) continue;
        try {
          if (candidate.kind === 'acp-remote') {
            await syncSession(
              db,
              candidate.sessionId,
              candidate.projectPath,
              derive,
              candidate.filePath,
              'acp-remote'
            );
          } else {
            await syncSession(
              db,
              candidate.sessionId,
              candidate.projectPath,
              derive,
              candidate.filePath,
              'local'
            );
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (candidate.kind === 'acp-remote') {
            if (code === 'ENOENT') continue;
            throw error;
          }
          if (code === 'acp_remote_workspace_state_invalid') {
            throw error;
          }
          if (code !== 'ENOENT') {
            logger.warn(
              `[SessionService] Skipping invalid session transcript: ${candidate.sessionId}`
            );
          }
        }
      }
    })
  );

  // GC：projection_state 中 JSONL 已不存在的行。
  const knownIdentities = db
    .prepare(
      `SELECT source_kind, project_path, session_id FROM projection_state
       UNION
       SELECT source_kind, project_path, session_id FROM sessions
       WHERE source_kind='acp-remote'
       UNION
       SELECT source_kind, project_path, session_id FROM parts
       WHERE source_kind='acp-remote'
       UNION
       SELECT source_kind, project_path, session_id FROM parts_fts
       WHERE source_kind='acp-remote'`
    )
    .all<ProjectionIdentityRow>();
  for (const row of knownIdentities) {
    if (
      !seen.has(`${row.source_kind}\u0000${row.project_path}\u0000${row.session_id}`)
    ) {
      db.transaction(() =>
        deleteSessionRows(db, row.source_kind, row.project_path, row.session_id)
      );
    }
  }
}

/** 删除单个会话的所有投影行（供 deleteSession 钩子 best-effort 调用）。 */
export function removeSessionFromProjection(
  db: SqliteDb,
  sessionId: string,
  projectPath: string,
  sourceKind: ProjectionSourceKind = 'local'
): void {
  db.transaction(() => deleteSessionRows(db, sourceKind, projectPath, sessionId));
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
         WHERE parts_fts MATCH ? AND source_kind = 'local' AND project_path = ?
         ORDER BY timestamp DESC LIMIT ?`
    : `SELECT session_id, role, timestamp, text FROM parts_fts
         WHERE parts_fts MATCH ? AND source_kind = 'local'
         ORDER BY timestamp DESC LIMIT ?`;
  const stmt = db.prepare(sql);
  return projectPath
    ? stmt.all<ProjectionTextRow>(match, projectPath, limit)
    : stmt.all<ProjectionTextRow>(match, limit);
}

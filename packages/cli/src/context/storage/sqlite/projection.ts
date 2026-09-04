/**
 * SQLite 读侧投影的拉取式同步。
 *
 * 不依赖任何日志订阅（大量写入绕过 SessionEventLog），而是以 JSONL 为权威、按
 * mtime/size/last_seq 门控地增量同步。未变的会话近乎零成本跳过；变更的会话整条
 * 重物化（复用 `materializeSessionEvents` + 调用方注入的元数据聚合），从而天然
 * 正确处理 rewind（seq 截断）与文件重写。多进程安全靠 WAL + 幂等 upsert。
 */

import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type AcpRemoteStateScope,
  AcpRemoteWorkspaceStateError,
  assertAcpRemoteSessionTranscriptIdentity,
  assertAcpRemoteStateFile,
  assertAcpRemoteStateFileHandle,
  deriveAcpRemoteHostStateRoot,
  listValidatedAcpRemoteStateScopes,
  parseAcpRemoteWorkspaceDescriptor,
  withValidatedAcpRemoteStateScope,
} from '../../../acp/AcpRemoteWorkspace.js';
import { getOrCreateAcpRemoteWorkspaceReferenceInScope } from '../../../acp/AcpRemoteWorkspaceReference.js';
import {
  type SessionSurfaceMessage,
  SessionSurfaceMessageSchema,
  type SessionSurfaceSummary,
} from '../../../api/sessionSurfaceSchemas.js';
import { createLogger, LogCategory } from '../../../logging/Logger.js';
import { sessionCatalogSortKey } from '../../../services/sessionCatalog.js';
import { materializeSessionEvents } from '../../../services/sessionRewind.js';
import {
  createSessionSurfaceMessageId,
  projectSessionSurfaceMessages,
  redactSessionSurfaceText,
  remoteSessionSurfaceRedactionOptions,
  SessionSurfaceProjectionError,
} from '../../../services/sessionSurfaceProjection.js';
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
const SURFACE_DIGEST_DOMAIN = 'session-surface-projection-v1\0';
const DEFAULT_SURFACE_HISTORY_BYTE_LIMIT = 512 * 1024;
const MAX_PROJECTION_SNAPSHOT_ATTEMPTS = 3;
const NEVER_ABORTED_SIGNAL = new AbortController().signal;
const SURFACE_WORKSPACE_REFERENCE_PATTERN = /^acp-remote-workspace:[A-Za-z0-9_-]{43}$/;
const SURFACE_ARCHIVE_CTE = `WITH RECURSIVE archive_members(
  source_kind, project_path, public_workspace_ref, session_id, archive_root_id,
  effective_archived_at, depth
) AS (
  SELECT source_kind, project_path, public_workspace_ref, session_id, session_id,
         archived_at, 0
  FROM sessions
  WHERE archived_at IS NOT NULL
  UNION ALL
  SELECT child.source_kind, child.project_path, child.public_workspace_ref,
         child.session_id, parent.archive_root_id, parent.effective_archived_at,
         parent.depth + 1
  FROM sessions child
  JOIN archive_members parent
    ON child.source_kind = parent.source_kind
   AND child.project_path = parent.project_path
   AND child.public_workspace_ref IS parent.public_workspace_ref
   AND child.parent_id = parent.session_id
  WHERE parent.depth < 128
),
ranked_archive AS (
  SELECT source_kind, project_path, public_workspace_ref, session_id,
         archive_root_id, effective_archived_at,
         ROW_NUMBER() OVER (
           PARTITION BY source_kind, project_path, public_workspace_ref, session_id
           ORDER BY depth ASC, archive_root_id ASC
         ) AS rank
  FROM archive_members
)`;

interface ProjectionIO {
  readSession(
    store: JSONLStore,
    remoteScope: AcpRemoteStateScope | undefined,
    signal: AbortSignal
  ): Promise<SessionEvent[]>;
}

const defaultProjectionIO: ProjectionIO = {
  readSession(store, remoteScope, signal) {
    return remoteScope
      ? store.readAllValidated({
          noFollow: true,
          signal,
          validateHandle: (handle) =>
            assertAcpRemoteStateFileHandle(remoteScope, store.getFilePath(), handle),
        })
      : store.readAll({ signal });
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
  metadata: Record<string, unknown> & SessionSurfaceSummaryProjectionInput;
  /** 仅 remote row 存在，来自受保护 sidecar，不从远端 wire path 推导。 */
  publicWorkspaceRef?: string;
  /** 已完成严格字段投影与内容边界处理的可见消息。 */
  surfaceMessages: readonly SessionSurfaceMessage[];
}

export interface SessionSurfaceSummaryProjectionInput {
  sessionId: string;
  projectPath: string;
  rootId: string;
  relationType?: string;
  title?: string;
  agentType?: string;
  model?: string;
  parentId?: string;
  taskStatus: string;
  taskCompletedAt?: string;
  taskPriority?: string;
  taskKind?: string;
  taskDueAt?: string;
  archivedAt?: string;
  messageCount: number;
  firstMessageTime: string;
  lastMessageTime: string;
  hasErrors: boolean;
  selectedModelId?: string;
  remoteWorkspace?: unknown;
}

export interface ProjectedSurfaceCandidate {
  sourceKind: ProjectionSourceKind;
  projectPath: string;
  sessionId: string;
  publicWorkspaceRef?: string;
  publicWorkspaceSortKey: string;
  surfaceDigest: string;
  transcriptFingerprint: string;
  lastMessageTime: string;
  sessionSortKey: string;
  summary: Omit<SessionSurfaceSummary, 'locator' | 'capabilities'>;
}

export interface ProjectedSurfaceCatalogBoundary {
  lastMessageTime: string;
  sourceKind: ProjectionSourceKind;
  publicWorkspaceSortKey: string;
  sessionSortKey: string;
}

export interface ProjectedSurfaceCatalogQuery {
  archived: boolean;
  workspaceKind?: ProjectionSourceKind;
  limit: number;
  boundary?: ProjectedSurfaceCatalogBoundary;
}

export interface ProjectedSurfaceCatalogPage {
  revision: number;
  sessions: readonly ProjectedSurfaceCandidate[];
  nextBoundary?: ProjectedSurfaceCatalogBoundary;
}

export interface ProjectedSurfaceHistoryQuery {
  sourceKind: ProjectionSourceKind;
  projectPath: string;
  sessionId: string;
  beforeSequence?: number;
  limit: number;
  maxBytes?: number;
}

export interface ProjectedSurfaceHistoryPage {
  messages: readonly SessionSurfaceMessage[];
  hasOlder: boolean;
  nextSequence?: number;
  transcriptFingerprint: string;
  surfaceDigest: string;
}

export function getSessionSurfaceHistoryByteLimit(): number {
  return DEFAULT_SURFACE_HISTORY_BYTE_LIMIT;
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
  projected: ProjectedSession,
  surfaceDigest: string
): void {
  const { metadata: meta, publicWorkspaceRef } = projected;
  const publicWorkspaceSortKey = sessionCatalogSortKey(
    publicWorkspaceRef ?? meta.projectPath
  );
  db.prepare(
    `INSERT INTO sessions
       (source_kind, project_path, session_id, root_id, parent_id, relation_type, title,
        agent_type, model, task_status, task_priority, task_kind, task_due_at,
        archived_at, last_message_time, project_sort_key,
        public_workspace_ref, public_workspace_sort_key, session_sort_key,
        first_message_time, message_count, has_errors, is_subagent, metadata_json,
        surface_digest)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_kind, project_path, session_id) DO UPDATE SET
       root_id=excluded.root_id, parent_id=excluded.parent_id,
       relation_type=excluded.relation_type, title=excluded.title,
       agent_type=excluded.agent_type, model=excluded.model,
       task_status=excluded.task_status, task_priority=excluded.task_priority,
       task_kind=excluded.task_kind, task_due_at=excluded.task_due_at,
       archived_at=excluded.archived_at,
       last_message_time=excluded.last_message_time,
       project_sort_key=excluded.project_sort_key,
       public_workspace_ref=excluded.public_workspace_ref,
       public_workspace_sort_key=excluded.public_workspace_sort_key,
       session_sort_key=excluded.session_sort_key,
       first_message_time=excluded.first_message_time, message_count=excluded.message_count,
       has_errors=excluded.has_errors, is_subagent=excluded.is_subagent,
       metadata_json=excluded.metadata_json, surface_digest=excluded.surface_digest`
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
    publicWorkspaceRef ?? null,
    publicWorkspaceSortKey,
    sessionCatalogSortKey(meta.sessionId),
    meta.firstMessageTime,
    meta.messageCount,
    meta.hasErrors ? 1 : 0,
    meta.relationType === 'subagent' ? 1 : 0,
    JSON.stringify(meta),
    surfaceDigest
  );
}

function incrementCatalogRevision(db: SqliteDb): void {
  db.prepare(
    `UPDATE surface_projection_meta
     SET catalog_revision=catalog_revision + 1 WHERE singleton=1`
  ).run();
}

function writeSurfaceMessages(
  db: SqliteDb,
  sourceKind: ProjectionSourceKind,
  projectPath: string,
  sessionId: string,
  events: readonly SessionEvent[],
  messages: readonly SessionSurfaceMessage[]
): void {
  db.prepare(
    `DELETE FROM surface_messages
     WHERE source_kind=? AND project_path=? AND session_id=?`
  ).run(sourceKind, projectPath, sessionId);

  const rawMessageIdBySequence = new Map<number, string>();
  for (const event of events) {
    if (event.type === 'message_created' && typeof event.seq === 'number') {
      rawMessageIdBySequence.set(event.seq, event.data.messageId);
    }
  }
  const insert = db.prepare(
    `INSERT INTO surface_messages
       (source_kind, project_path, session_id, message_seq, message_id,
        message_json, byte_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const message of messages) {
    const validated = SessionSurfaceMessageSchema.parse(message);
    const sequence = parseSurfaceMessageSequence(validated.id);
    const rawMessageId = rawMessageIdBySequence.get(sequence);
    if (!rawMessageId) throw new SessionSurfaceProjectionError();
    const messageJson = JSON.stringify(validated);
    insert.run(
      sourceKind,
      projectPath,
      sessionId,
      sequence,
      rawMessageId,
      messageJson,
      Buffer.byteLength(messageJson)
    );
  }
}

function parseSurfaceMessageSequence(id: string): number {
  const match = /^surface-message:([0-9]+):/.exec(id);
  const sequence = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new SessionSurfaceProjectionError();
  }
  return sequence;
}

function buildSurfaceDigest(projected: ProjectedSession): string {
  const { metadata: meta } = projected;
  const catalogSummary = {
    locator:
      projected.publicWorkspaceRef === undefined
        ? {
            version: 2,
            sessionId: meta.sessionId,
            workspace: { kind: 'local', projectPath: meta.projectPath },
          }
        : {
            version: 2,
            sessionId: meta.sessionId,
            workspace: {
              kind: 'acp-remote',
              workspaceRef: projected.publicWorkspaceRef,
            },
          },
    ...projectSessionSurfaceSummaryFields(meta, projected.publicWorkspaceRef),
  };
  return createHash('sha256')
    .update(SURFACE_DIGEST_DOMAIN)
    .update(JSON.stringify({ catalogSummary, messages: projected.surfaceMessages }))
    .digest('hex');
}

export function projectSessionSurfaceSummaryFields(
  metadata: SessionSurfaceSummaryProjectionInput,
  publicWorkspaceRef?: string
): Omit<SessionSurfaceSummary, 'locator' | 'capabilities'> {
  const remoteDescriptor =
    metadata.remoteWorkspace === undefined
      ? undefined
      : parseAcpRemoteWorkspaceDescriptor(metadata.remoteWorkspace);
  if (
    (remoteDescriptor === undefined) !== (publicWorkspaceRef === undefined) ||
    (remoteDescriptor &&
      deriveAcpRemoteHostStateRoot(remoteDescriptor.collisionIdentity) !==
        metadata.projectPath) ||
    !isValidSessionId(metadata.sessionId) ||
    !isValidSessionId(metadata.rootId) ||
    (metadata.parentId !== undefined && !isValidSessionId(metadata.parentId)) ||
    (metadata.relationType !== undefined &&
      metadata.relationType !== 'subagent' &&
      metadata.relationType !== 'fork') ||
    !['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(
      metadata.taskStatus
    ) ||
    !Number.isSafeInteger(metadata.messageCount) ||
    metadata.messageCount < 0 ||
    !metadata.firstMessageTime ||
    !metadata.lastMessageTime ||
    (metadata.archivedAt !== undefined && !metadata.archivedAt) ||
    (metadata.selectedModelId !== undefined && !metadata.selectedModelId)
  ) {
    throw new SessionSurfaceProjectionError();
  }
  const redactionOptions = {
    ...(remoteDescriptor
      ? remoteSessionSurfaceRedactionOptions(metadata.projectPath, remoteDescriptor)
      : { privateRoots: [] }),
    bladeStorageRoots: [getBladeStorageRoot()],
  };
  const relationType = metadata.relationType as 'subagent' | 'fork' | undefined;
  const taskStatus = metadata.taskStatus as SessionSurfaceSummary['taskStatus'];
  const taskCompletedAt =
    typeof metadata.taskCompletedAt === 'string'
      ? Date.parse(metadata.taskCompletedAt)
      : Number.NaN;
  return {
    displayCwd: remoteDescriptor?.wirePath ?? metadata.projectPath,
    ...(remoteDescriptor ? { pathStyle: remoteDescriptor.style } : {}),
    ...(metadata.title !== undefined
      ? { title: redactSessionSurfaceText(metadata.title, redactionOptions) }
      : {}),
    rootId: metadata.rootId,
    ...(metadata.parentId !== undefined ? { parentId: metadata.parentId } : {}),
    ...(relationType !== undefined ? { relationType } : {}),
    taskStatus,
    ...(Number.isFinite(taskCompletedAt)
      ? { taskCompletedAt: new Date(taskCompletedAt).toISOString() }
      : {}),
    messageCount: metadata.messageCount,
    firstMessageTime: metadata.firstMessageTime,
    lastMessageTime: metadata.lastMessageTime,
    hasErrors: metadata.hasErrors,
    ...(metadata.archivedAt !== undefined ? { archivedAt: metadata.archivedAt } : {}),
    ...(metadata.selectedModelId !== undefined
      ? {
          selectedModelId: redactSessionSurfaceText(
            metadata.selectedModelId,
            redactionOptions
          ),
        }
      : {}),
  };
}

function hasSessionSurfaceRows(
  db: SqliteDb,
  sourceKind: ProjectionSourceKind,
  projectPath: string,
  sessionId: string
): boolean {
  const row = db
    .prepare(
      `SELECT EXISTS(
         SELECT 1 FROM sessions
         WHERE source_kind=? AND project_path=? AND session_id=?
         UNION ALL
         SELECT 1 FROM surface_messages
         WHERE source_kind=? AND project_path=? AND session_id=?
       ) AS present`
    )
    .get<{ present: number }>(
      sourceKind,
      projectPath,
      sessionId,
      sourceKind,
      projectPath,
      sessionId
    );
  return row?.present === 1;
}

function deleteSessionContentRows(
  db: SqliteDb,
  sourceKind: ProjectionSourceKind,
  projectPath: string,
  sessionId: string
): boolean {
  const semanticChanged = hasSessionSurfaceRows(db, sourceKind, projectPath, sessionId);
  for (const table of ['surface_messages', 'sessions', 'parts', 'parts_fts']) {
    db.prepare(
      `DELETE FROM ${table} WHERE source_kind=? AND project_path=? AND session_id=?`
    ).run(sourceKind, projectPath, sessionId);
  }
  return semanticChanged;
}

function deleteSessionRows(
  db: SqliteDb,
  sourceKind: ProjectionSourceKind,
  projectPath: string,
  sessionId: string
): boolean {
  const semanticChanged = deleteSessionContentRows(
    db,
    sourceKind,
    projectPath,
    sessionId
  );
  db.prepare(
    'DELETE FROM projection_state WHERE source_kind=? AND project_path=? AND session_id=?'
  ).run(sourceKind, projectPath, sessionId);
  return semanticChanged;
}

function deleteSessionContentForSourceFile(
  db: SqliteDb,
  sourceKind: ProjectionSourceKind,
  filePath: string
): boolean {
  const rows = db
    .prepare(
      `SELECT project_path, session_id FROM sessions
       WHERE source_kind=? AND json_extract(metadata_json, '$.filePath')=?`
    )
    .all<{ project_path: string; session_id: string }>(sourceKind, filePath);
  let semanticChanged = false;
  for (const row of rows) {
    semanticChanged =
      deleteSessionContentRows(db, sourceKind, row.project_path, row.session_id) ||
      semanticChanged;
  }
  return semanticChanged;
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
  sourceKind: ProjectionSourceKind = 'local',
  signal?: AbortSignal
): Promise<boolean> {
  signal?.throwIfAborted();
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
        validatedScope,
        signal
      );
    });
  }

  return syncSessionValidated(
    db,
    sessionId,
    projectPath,
    derive,
    filePath ?? getSessionFilePath(projectPath, sessionId),
    sourceKind,
    undefined,
    signal
  );
}

async function syncSessionValidated(
  db: SqliteDb,
  sessionId: string,
  projectPath: string,
  derive: MetadataDeriver,
  filePath: string,
  sourceKind: ProjectionSourceKind,
  validatedRemoteScope?: AcpRemoteStateScope,
  signal?: AbortSignal
): Promise<boolean> {
  signal?.throwIfAborted();
  if (sourceKind === 'acp-remote') {
    if (!validatedRemoteScope) {
      throw new AcpRemoteWorkspaceStateError('remote-session-scope');
    }
    try {
      await assertAcpRemoteStateFile(validatedRemoteScope, filePath);
      signal?.throwIfAborted();
    } catch (error) {
      if (signal?.aborted) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      signal?.throwIfAborted();
      db.transaction(() => {
        if (deleteSessionRows(db, sourceKind, projectPath, sessionId)) {
          incrementCatalogRevision(db);
        }
      });
      return true;
    }
  }
  let fileStat: BigIntStats;
  try {
    fileStat = await stat(filePath, { bigint: true });
    signal?.throwIfAborted();
  } catch (error) {
    if (signal?.aborted) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (sourceKind === 'acp-remote' && code !== 'ENOENT') {
      throw error;
    }
    // 文件不存在 → GC 掉可能残留的行。
    db.transaction(() => {
      if (deleteSessionRows(db, sourceKind, projectPath, sessionId)) {
        incrementCatalogRevision(db);
      }
    });
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
    let beforeRead = fileStat;
    let stableSnapshot: SessionEvent[] | undefined;
    for (let attempt = 0; attempt < MAX_PROJECTION_SNAPSHOT_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted();
      const candidate = await projectionIO.readSession(
        store,
        validatedRemoteScope,
        signal ?? NEVER_ABORTED_SIGNAL
      );
      signal?.throwIfAborted();
      const afterRead = await stat(filePath, { bigint: true });
      signal?.throwIfAborted();
      if (statFingerprint(beforeRead) === statFingerprint(afterRead)) {
        raw = candidate;
        fileStat = afterRead;
        stableSnapshot = candidate;
        break;
      }
      beforeRead = afterRead;
    }
    if (!stableSnapshot) throw new SessionSurfaceProjectionError();
    raw = stableSnapshot;
  } catch (error) {
    if (signal?.aborted) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      if (sourceKind === 'acp-remote') {
        if (error instanceof AcpRemoteWorkspaceStateError) throw error;
        if (code !== undefined) {
          throw new AcpRemoteWorkspaceStateError('remote-session-read');
        }
      }
      throw error;
    }
    db.transaction(() => {
      if (deleteSessionRows(db, sourceKind, projectPath, sessionId)) {
        incrementCatalogRevision(db);
      }
    });
    return true;
  }
  if (sourceKind === 'acp-remote' && raw.length === 0) {
    try {
      await assertAcpRemoteStateFile(validatedRemoteScope!, filePath);
    } catch (error) {
      if (signal?.aborted) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        db.transaction(() => {
          if (deleteSessionRows(db, sourceKind, projectPath, sessionId)) {
            incrementCatalogRevision(db);
          }
        });
        return true;
      }
      throw error;
    }
    throw new AcpRemoteWorkspaceStateError('remote-session-empty');
  }
  signal?.throwIfAborted();
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
    signal?.throwIfAborted();
    db.transaction(() => {
      let semanticChanged: boolean;
      if (localSourceContainsRemoteDescriptor) {
        semanticChanged = deleteSessionContentForSourceFile(db, sourceKind, filePath);
        semanticChanged =
          deleteSessionRows(db, sourceKind, projectPath, sessionId) || semanticChanged;
      } else {
        semanticChanged = deleteSessionContentRows(
          db,
          sourceKind,
          projectPath,
          sessionId
        );
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
      if (semanticChanged) incrementCatalogRevision(db);
    });
    return true;
  }

  const publicWorkspaceRef =
    durableRemoteDescriptor && validatedRemoteScope
      ? await getOrCreateAcpRemoteWorkspaceReferenceInScope(
          validatedRemoteScope,
          durableRemoteDescriptor
        )
      : undefined;
  signal?.throwIfAborted();
  const surfaceMessages = projectSessionSurfaceMessages(raw, {
    ...(durableRemoteDescriptor
      ? remoteSessionSurfaceRedactionOptions(projectPath, durableRemoteDescriptor)
      : { privateRoots: [] }),
    bladeStorageRoots: [getBladeStorageRoot()],
  });
  const projected: ProjectedSession = {
    metadata: meta,
    ...(publicWorkspaceRef !== undefined ? { publicWorkspaceRef } : {}),
    surfaceMessages,
  };
  const surfaceDigest = buildSurfaceDigest(projected);

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
    signal?.throwIfAborted();
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

  signal?.throwIfAborted();
  db.transaction(() => {
    const existingSurface = db
      .prepare(
        `SELECT surface_digest FROM sessions
         WHERE source_kind=? AND project_path=? AND session_id=?`
      )
      .get<{ surface_digest: string }>(sourceKind, meta.projectPath, meta.sessionId);
    const semanticChanged = existingSurface?.surface_digest !== surfaceDigest;
    upsertSession(db, sourceKind, projected, surfaceDigest);
    writeParts(db, sourceKind, meta.projectPath, meta.sessionId, events);
    writeSurfaceMessages(
      db,
      sourceKind,
      meta.projectPath,
      meta.sessionId,
      events,
      surfaceMessages
    );
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
    if (semanticChanged) incrementCatalogRevision(db);
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
       WHERE source_kind=? AND project_path=?
       UNION
       SELECT session_id FROM surface_messages
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
      projectPath,
      sourceKind,
      projectPath
    );
  for (const row of known) {
    if (!seenSessionIds.has(row.session_id)) {
      if (deleteSessionRows(db, sourceKind, projectPath, row.session_id)) {
        incrementCatalogRevision(db);
      }
    }
  }
}

export async function syncAcpRemoteScope(
  db: SqliteDb,
  derive: MetadataDeriver,
  projectPath: string,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
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
      signal?.throwIfAborted();
      const seenSessionIds = new Set(
        candidates.map((candidate) => candidate.sessionId)
      );
      const concurrency = Math.min(32, candidates.length);
      let nextIndex = 0;
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (nextIndex < candidates.length) {
            signal?.throwIfAborted();
            const candidate = candidates[nextIndex++];
            if (!candidate) continue;
            await syncSessionValidated(
              db,
              candidate.sessionId,
              projectPath,
              derive,
              candidate.filePath,
              'acp-remote',
              validatedScope,
              signal
            );
          }
        })
      );
      signal?.throwIfAborted();
      db.transaction(() => {
        removeMissingProjectionRows(db, 'acp-remote', projectPath, seenSessionIds);
      });
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    db.transaction(() => {
      removeMissingProjectionRows(db, 'acp-remote', projectPath, new Set());
    });
  }
}

export async function syncAllAcpRemoteScopes(
  db: SqliteDb,
  derive: MetadataDeriver,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  const scopes = await listValidatedAcpRemoteStateScopes();
  signal?.throwIfAborted();
  for (const scope of scopes) {
    signal?.throwIfAborted();
    await syncAcpRemoteScope(db, derive, String(scope), signal);
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
       SELECT project_path FROM parts_fts WHERE source_kind='acp-remote'
       UNION
       SELECT project_path FROM surface_messages WHERE source_kind='acp-remote'`
    )
    .all<{ project_path: string }>();
  for (const row of projectedRoots) {
    signal?.throwIfAborted();
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
       WHERE source_kind='acp-remote'
       UNION
       SELECT source_kind, project_path, session_id FROM surface_messages
       WHERE source_kind='acp-remote'`
    )
    .all<ProjectionIdentityRow>();
  for (const row of knownIdentities) {
    if (
      !seen.has(`${row.source_kind}\u0000${row.project_path}\u0000${row.session_id}`)
    ) {
      db.transaction(() => {
        if (deleteSessionRows(db, row.source_kind, row.project_path, row.session_id)) {
          incrementCatalogRevision(db);
        }
      });
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
  db.transaction(() => {
    if (deleteSessionRows(db, sourceKind, projectPath, sessionId)) {
      incrementCatalogRevision(db);
    }
  });
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

interface SurfaceCandidateRow {
  source_kind: ProjectionSourceKind;
  project_path: string;
  session_id: string;
  root_id: string | null;
  parent_id: string | null;
  relation_type: string | null;
  task_status: string;
  first_message_time: string | null;
  last_message_time: string;
  title: string | null;
  archived_at: string | null;
  archive_root_id: string | null;
  effective_archived_at: string | null;
  message_count: number;
  has_errors: number;
  is_subagent: number;
  public_workspace_ref: string | null;
  public_workspace_sort_key: string;
  session_sort_key: string;
  surface_digest: string;
  stat_fingerprint: string;
  metadata_json: string;
}

function parseSurfaceCandidate(row: SurfaceCandidateRow): ProjectedSurfaceCandidate {
  try {
    const parsed: unknown = JSON.parse(row.metadata_json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SessionSurfaceProjectionError();
    }
    const metadata = parsed as ProjectedSession['metadata'];
    const expectedWorkspaceKey = sessionCatalogSortKey(
      row.public_workspace_ref ?? row.project_path
    );
    if (
      metadata.sessionId !== row.session_id ||
      metadata.projectPath !== row.project_path ||
      metadata.rootId !== row.root_id ||
      (metadata.parentId ?? null) !== row.parent_id ||
      (metadata.relationType ?? null) !== row.relation_type ||
      metadata.taskStatus !== row.task_status ||
      (row.relation_type !== null &&
        row.relation_type !== 'subagent' &&
        row.relation_type !== 'fork') ||
      !Number.isSafeInteger(row.message_count) ||
      row.message_count < 0 ||
      (row.has_errors !== 0 && row.has_errors !== 1) ||
      (row.is_subagent !== 0 && row.is_subagent !== 1) ||
      metadata.firstMessageTime !== row.first_message_time ||
      metadata.lastMessageTime !== row.last_message_time ||
      (metadata.title ?? null) !== row.title ||
      (metadata.archivedAt ?? null) !== row.archived_at ||
      metadata.messageCount !== row.message_count ||
      Number(metadata.hasErrors) !== row.has_errors ||
      Number(metadata.relationType === 'subagent') !== row.is_subagent ||
      row.public_workspace_sort_key !== expectedWorkspaceKey ||
      row.session_sort_key !== sessionCatalogSortKey(row.session_id) ||
      !/^[a-f0-9]{64}$/.test(row.surface_digest) ||
      !row.stat_fingerprint ||
      (row.source_kind === 'local' &&
        (row.public_workspace_ref !== null ||
          metadata.remoteWorkspace !== undefined)) ||
      (row.source_kind === 'acp-remote' &&
        (row.public_workspace_ref === null ||
          !SURFACE_WORKSPACE_REFERENCE_PATTERN.test(row.public_workspace_ref) ||
          metadata.remoteWorkspace === undefined))
    ) {
      throw new SessionSurfaceProjectionError();
    }
    const effectiveMetadata: ProjectedSession['metadata'] = row.effective_archived_at
      ? {
          ...metadata,
          archivedAt: row.effective_archived_at,
          archivedBySessionId: row.archive_root_id,
        }
      : metadata;
    const summary = projectSessionSurfaceSummaryFields(
      effectiveMetadata,
      row.public_workspace_ref ?? undefined
    );
    return {
      sourceKind: row.source_kind,
      projectPath: row.project_path,
      sessionId: row.session_id,
      ...(row.public_workspace_ref === null
        ? {}
        : { publicWorkspaceRef: row.public_workspace_ref }),
      publicWorkspaceSortKey: row.public_workspace_sort_key,
      surfaceDigest: row.surface_digest,
      transcriptFingerprint: row.stat_fingerprint,
      lastMessageTime: row.last_message_time,
      sessionSortKey: row.session_sort_key,
      summary,
    };
  } catch {
    throw new SessionSurfaceProjectionError();
  }
}

export function readSessionSurfaceCandidates(
  db: SqliteDb,
  sessionId: string
): readonly ProjectedSurfaceCandidate[] {
  if (!isValidSessionId(sessionId)) {
    throw new SessionSurfaceProjectionError();
  }
  try {
    return db
      .prepare(
        `${SURFACE_ARCHIVE_CTE}
         SELECT s.source_kind, s.project_path, s.session_id, s.root_id, s.parent_id,
                s.relation_type, s.task_status, s.first_message_time,
                s.last_message_time, s.title, s.archived_at, s.message_count,
                s.has_errors,
                s.is_subagent, a.archive_root_id, a.effective_archived_at,
                s.public_workspace_ref, s.public_workspace_sort_key,
                s.session_sort_key, s.surface_digest, p.stat_fingerprint,
                s.metadata_json
         FROM sessions s
         JOIN projection_state p USING (source_kind, project_path, session_id)
         LEFT JOIN ranked_archive a
           ON a.source_kind=s.source_kind AND a.project_path=s.project_path
          AND a.public_workspace_ref IS s.public_workspace_ref
          AND a.session_id=s.session_id AND a.rank=1
         WHERE s.session_id=?
         ORDER BY s.source_kind DESC, s.public_workspace_sort_key ASC,
                  s.session_sort_key ASC`
      )
      .all<SurfaceCandidateRow>(sessionId)
      .map(parseSurfaceCandidate);
  } catch {
    throw new SessionSurfaceProjectionError();
  }
}

export function readSessionSurfaceCatalogRevision(db: SqliteDb): number {
  const revision = db
    .prepare('SELECT catalog_revision FROM surface_projection_meta WHERE singleton=1')
    .get<{ catalog_revision: number }>()?.catalog_revision;
  if (!Number.isSafeInteger(revision) || revision === undefined || revision < 0) {
    throw new SessionSurfaceProjectionError();
  }
  return revision;
}

export function readSessionSurfaceCatalogPage(
  db: SqliteDb,
  query: ProjectedSurfaceCatalogQuery
): ProjectedSurfaceCatalogPage {
  assertSurfaceLimit(query.limit);
  return db.transaction(() => {
    const parameters: unknown[] = [];
    const conditions = [
      's.is_subagent=0',
      query.archived ? 'a.session_id IS NOT NULL' : 'a.session_id IS NULL',
    ];
    if (query.workspaceKind !== undefined) {
      conditions.push('s.source_kind=?');
      parameters.push(query.workspaceKind);
    }
    if (query.boundary !== undefined) {
      conditions.push(
        `(s.last_message_time < ?
          OR (s.last_message_time = ? AND s.source_kind < ?)
          OR (s.last_message_time = ? AND s.source_kind = ?
              AND s.public_workspace_sort_key > ?)
          OR (s.last_message_time = ? AND s.source_kind = ?
              AND s.public_workspace_sort_key = ? AND s.session_sort_key > ?))`
      );
      parameters.push(
        query.boundary.lastMessageTime,
        query.boundary.lastMessageTime,
        query.boundary.sourceKind,
        query.boundary.lastMessageTime,
        query.boundary.sourceKind,
        query.boundary.publicWorkspaceSortKey,
        query.boundary.lastMessageTime,
        query.boundary.sourceKind,
        query.boundary.publicWorkspaceSortKey,
        query.boundary.sessionSortKey
      );
    }
    parameters.push(query.limit + 1);
    const revision = readSessionSurfaceCatalogRevision(db);
    const rows = db
      .prepare(
        `${SURFACE_ARCHIVE_CTE}
         SELECT s.source_kind, s.project_path, s.session_id, s.root_id, s.parent_id,
                s.relation_type, s.task_status, s.first_message_time,
                s.last_message_time, s.title, s.archived_at, s.message_count,
                s.has_errors,
                s.is_subagent, a.archive_root_id, a.effective_archived_at,
                s.public_workspace_ref, s.public_workspace_sort_key,
                s.session_sort_key, s.surface_digest, p.stat_fingerprint,
                s.metadata_json
         FROM sessions s
         JOIN projection_state p USING (source_kind, project_path, session_id)
         LEFT JOIN ranked_archive a
           ON a.source_kind=s.source_kind AND a.project_path=s.project_path
          AND a.public_workspace_ref IS s.public_workspace_ref
          AND a.session_id=s.session_id AND a.rank=1
         WHERE ${conditions.join(' AND ')}
         ORDER BY s.last_message_time DESC, s.source_kind DESC,
                  s.public_workspace_sort_key ASC, s.session_sort_key ASC
         LIMIT ?`
      )
      .all<SurfaceCandidateRow>(...parameters);
    const pageRows = rows.slice(0, query.limit);
    const sessions = pageRows.map(parseSurfaceCandidate);
    const last = rows.length > query.limit ? pageRows.at(-1) : undefined;
    return {
      revision,
      sessions,
      ...(last
        ? {
            nextBoundary: {
              lastMessageTime: last.last_message_time,
              sourceKind: last.source_kind,
              publicWorkspaceSortKey: last.public_workspace_sort_key,
              sessionSortKey: last.session_sort_key,
            },
          }
        : {}),
    };
  });
}

interface SurfaceMessageRow {
  message_seq: number;
  message_id: string;
  message_json: string;
  byte_count: number;
}

export function readSessionSurfaceHistoryPage(
  db: SqliteDb,
  query: ProjectedSurfaceHistoryQuery
): ProjectedSurfaceHistoryPage {
  assertSurfaceLimit(query.limit);
  if (
    query.beforeSequence !== undefined &&
    (!Number.isSafeInteger(query.beforeSequence) || query.beforeSequence < 0)
  ) {
    throw new SessionSurfaceProjectionError();
  }
  const requestedMaxBytes = query.maxBytes ?? DEFAULT_SURFACE_HISTORY_BYTE_LIMIT;
  if (!Number.isSafeInteger(requestedMaxBytes) || requestedMaxBytes < 1) {
    throw new SessionSurfaceProjectionError();
  }
  const maxBytes = Math.min(requestedMaxBytes, DEFAULT_SURFACE_HISTORY_BYTE_LIMIT);
  return db.transaction(() => {
    const candidate = db
      .prepare(
        `SELECT surface_digest, stat_fingerprint FROM sessions
         JOIN projection_state USING (source_kind, project_path, session_id)
         WHERE source_kind=? AND project_path=? AND session_id=?`
      )
      .get<{ surface_digest: string; stat_fingerprint: string }>(
        query.sourceKind,
        query.projectPath,
        query.sessionId
      );
    if (!candidate) throw new SessionSurfaceProjectionError();
    if (
      !/^[a-f0-9]{64}$/.test(candidate.surface_digest) ||
      !candidate.stat_fingerprint
    ) {
      throw new SessionSurfaceProjectionError();
    }

    const sequenceClause =
      query.beforeSequence === undefined ? '' : 'AND message_seq < ?';
    const parameters: unknown[] = [
      query.sourceKind,
      query.projectPath,
      query.sessionId,
      ...(query.beforeSequence === undefined ? [] : [query.beforeSequence]),
      query.limit + 1,
    ];
    const rows = db
      .prepare(
        `SELECT message_seq, message_id, message_json, byte_count
         FROM surface_messages
         WHERE source_kind=? AND project_path=? AND session_id=? ${sequenceClause}
         ORDER BY message_seq DESC, message_id DESC LIMIT ?`
      )
      .all<SurfaceMessageRow>(...parameters);
    const selected: SurfaceMessageRow[] = [];
    let selectedBytes = 2;
    for (const row of rows.slice(0, query.limit)) {
      const separatorBytes = selected.length === 0 ? 0 : 1;
      if (
        selected.length > 0 &&
        selectedBytes + separatorBytes + row.byte_count > maxBytes
      ) {
        break;
      }
      selected.push(row);
      selectedBytes += separatorBytes + row.byte_count;
    }
    const messages = selected.map((row) => parseStoredSurfaceMessage(row)).reverse();
    const hasOlder = rows.length > selected.length;
    return {
      messages,
      hasOlder,
      ...(hasOlder && selected.length > 0
        ? { nextSequence: selected.at(-1)!.message_seq }
        : {}),
      transcriptFingerprint: candidate.stat_fingerprint,
      surfaceDigest: candidate.surface_digest,
    };
  });
}

function parseStoredSurfaceMessage(row: SurfaceMessageRow): SessionSurfaceMessage {
  try {
    if (Buffer.byteLength(row.message_json) !== row.byte_count) {
      throw new SessionSurfaceProjectionError();
    }
    const message = SessionSurfaceMessageSchema.parse(JSON.parse(row.message_json));
    if (
      message.id !== createSessionSurfaceMessageId(row.message_seq, row.message_id) ||
      parseSurfaceMessageSequence(message.id) !== row.message_seq
    ) {
      throw new SessionSurfaceProjectionError();
    }
    return message;
  } catch {
    throw new SessionSurfaceProjectionError();
  }
}

function assertSurfaceLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new SessionSurfaceProjectionError();
  }
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

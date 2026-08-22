/**
 * 会话管理服务
 * 负责加载和恢复历史会话
 */

import type { BigIntStats } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import { SessionInUseError, SessionLease } from '../agent/runtime/SessionLease.js';
import {
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_INLINE_ATTACHMENT_COUNT,
} from '../api/attachmentLimits.js';
import type {
  CommunicationStyleSelection,
  ReasoningEffortSelection,
  ResponseVerbositySelection,
  ServiceTierSelection,
} from '../config/types.js';
import { parseCompactionReplacementMessages } from '../context/compactionCheckpoint.js';
import {
  findPendingSessionInteraction,
  toPendingInteraction,
} from '../context/interactions.js';
import {
  codeReviewMessageMetadata,
  projectSessionReviews,
  renderCodeReview,
  renderReviewStatus,
} from '../context/reviews.js';
import { JSONLStore, parseSessionJSONL } from '../context/storage/JSONLStore.js';
import {
  assertValidSessionId,
  detectGitBranch,
  getBladeStorageRoot,
  getProjectStoragePath,
  getSessionFilePath,
  getSessionGoalFilePath,
  isValidSessionId,
  unescapeProjectPath,
} from '../context/storage/pathUtils.js';
import {
  getProjectionDb,
  type MetadataDeriver,
  removeSessionFromProjection,
  syncAll,
} from '../context/storage/sqlite/projection.js';
import {
  findCurrentTokenBudgetHandoff,
  projectTokenBudgetHandoffEvent,
} from '../context/TokenBudgetHandoff.js';
import { isSessionTaskFailure, toTaskFailure } from '../context/taskFailure.js';
import type {
  SessionEvent,
  SessionPendingInteraction,
  SessionPermissionMode,
  SessionReviewTargetInfo,
  SessionRewindMode,
  SessionTaskDelivery,
  SessionTaskDiffStat,
  SessionTaskDispatch,
  SessionTaskFailure,
  SessionTaskIsolation,
  SessionTaskKind,
  SessionTaskPriority,
  SessionTaskRetryRef,
  SessionTaskStatus,
  SessionTaskWorktree,
} from '../context/types.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type { JsonObject, JsonValue, SessionMessage } from '../store/types.js';
import { FileAccessTracker } from '../tools/builtin/file/FileAccessTracker.js';
import { SnapshotManager } from '../tools/builtin/file/SnapshotManager.js';
import { projectDurableToolResult } from '../tools/display/ToolResultProjector.js';
import { getVersion } from '../utils/packageInfo.js';
import type { ContentPart, Message } from './ChatServiceInterface.js';
import { isClientVisibleMessage } from './clientMessageVisibility.js';
import { isCommunicationStyleSelection } from './communicationStyle.js';
import { isReasoningEffortSelection } from './pi/reasoningEffort.js';
import { isResponseVerbositySelection } from './pi/responseVerbosity.js';
import { isServiceTierSelection } from './pi/serviceTier.js';
import {
  renderSessionMarkdown,
  type SessionMarkdownExport,
  type SessionMarkdownExportOptions,
} from './SessionMarkdownExporter.js';
import { createStructuredOutputContract } from './StructuredOutputService.js';
import {
  compareSessionCatalogItems,
  type NormalizedSessionListOptions,
  type NormalizedSessionTaskFilters,
  normalizeSessionListOptions,
  normalizeSessionTaskFilters,
  paginateSessionCatalog,
  resolveSessionCursorBoundary,
  type SessionListOptions,
  type SessionScanOptions,
  sessionCatalogSortKey,
} from './sessionCatalog.js';
import {
  listSessionRewindCheckpoints as listProjectedRewindCheckpoints,
  materializeSessionEvents,
  type SessionRewindCheckpoint as ProjectedRewindCheckpoint,
  planSessionRewind,
} from './sessionRewind.js';
import {
  renderUserShellCommandForDisplay,
  userShellCommandRecordFromMetadata,
} from './UserShellCommandService.js';

const logger = createLogger(LogCategory.SERVICE);
const SESSION_TASK_STATUSES = new Set<SessionTaskStatus>([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
const SESSION_TASK_ISOLATION = new Set<SessionTaskIsolation>(['local', 'worktree']);
const SESSION_TASK_PRIORITIES = new Set<SessionTaskPriority>(['high', 'medium', 'low']);
const SESSION_TASK_KINDS = new Set<SessionTaskKind>([
  'feature',
  'bug',
  'maintenance',
  'research',
]);

function appendTaskProjectionFilters(
  filters: NormalizedSessionTaskFilters,
  columnPrefix: '' | 's.',
  conditions: string[],
  parameters: unknown[]
): void {
  if (filters.taskStatuses) {
    const statuses = filters.taskStatuses.includes('interrupted')
      ? [...new Set([...filters.taskStatuses, 'running' as const])]
      : filters.taskStatuses;
    conditions.push(
      `${columnPrefix}task_status IN (${statuses.map(() => '?').join(', ')})`
    );
    parameters.push(...statuses);
  }
  if (filters.taskPriorities) {
    conditions.push(
      `${columnPrefix}task_priority IN (${filters.taskPriorities
        .map(() => '?')
        .join(', ')})`
    );
    parameters.push(...filters.taskPriorities);
  }
  if (filters.taskDueAfter) {
    conditions.push(`${columnPrefix}task_due_at >= ?`);
    parameters.push(filters.taskDueAfter);
  }
  if (filters.taskDueBefore) {
    conditions.push(`${columnPrefix}task_due_at <= ?`);
    parameters.push(filters.taskDueBefore);
  }
}

function matchesTaskFilters(
  session: StoredSessionMetadata,
  filters: NormalizedSessionTaskFilters
): boolean {
  if (!matchesTaskStatusFilter(session, filters)) return false;
  if (
    filters.taskPriorities &&
    (session.taskPriority === undefined ||
      !filters.taskPriorities.includes(session.taskPriority))
  ) {
    return false;
  }
  if (
    filters.taskDueAfter &&
    (session.taskDueAt === undefined || session.taskDueAt < filters.taskDueAfter)
  ) {
    return false;
  }
  if (
    filters.taskDueBefore &&
    (session.taskDueAt === undefined || session.taskDueAt > filters.taskDueBefore)
  ) {
    return false;
  }
  return true;
}

function matchesTaskStatusFilter(
  session: StoredSessionMetadata,
  filters: NormalizedSessionTaskFilters
): boolean {
  return (
    filters.taskStatuses === undefined ||
    filters.taskStatuses.includes(session.taskStatus)
  );
}

const SESSION_PERMISSION_MODES = new Set<SessionPermissionMode>([
  'default',
  'autoEdit',
  'yolo',
  'plan',
]);
const SESSION_TASK_DELIVERY_STATUSES = new Set(['applied', 'discarded', 'conflicted']);
export const STALE_EMPTY_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

class SessionTaskReconciliationSkipped extends Error {}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'EPERM'
    );
  }
}

function parseTaskWorktree(value: unknown): SessionTaskWorktree | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const worktree = value as Record<string, unknown>;
  const stringFields = [
    'sessionId',
    'name',
    'branch',
    'baseCommit',
    'originalBranch',
    'repositoryRoot',
    'originalWorkspaceRoot',
    'worktreeRoot',
    'workspaceRoot',
  ] as const;
  if (
    stringFields.some(
      (field) => typeof worktree[field] !== 'string' || !worktree[field]
    ) ||
    typeof worktree.sourceHadChanges !== 'boolean' ||
    (worktree.sourceStateFingerprint !== undefined &&
      (typeof worktree.sourceStateFingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/.test(worktree.sourceStateFingerprint)))
  ) {
    return undefined;
  }
  return worktree as unknown as SessionTaskWorktree;
}

function parseTaskDelivery(value: unknown): SessionTaskDelivery | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const delivery = value as Record<string, unknown>;
  if (
    !SESSION_TASK_DELIVERY_STATUSES.has(String(delivery.status)) ||
    typeof delivery.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(delivery.updatedAt)) ||
    (delivery.sourceCommit !== undefined &&
      (typeof delivery.sourceCommit !== 'string' ||
        !/^[a-f0-9]{40,64}$/.test(delivery.sourceCommit))) ||
    (delivery.changedFiles !== undefined &&
      (typeof delivery.changedFiles !== 'number' ||
        !Number.isInteger(delivery.changedFiles) ||
        delivery.changedFiles < 0)) ||
    (delivery.message !== undefined &&
      (typeof delivery.message !== 'string' ||
        !delivery.message.trim() ||
        delivery.message.length > 500))
  ) {
    return undefined;
  }
  return {
    status: delivery.status as SessionTaskDelivery['status'],
    updatedAt: delivery.updatedAt,
    ...(typeof delivery.sourceCommit === 'string'
      ? { sourceCommit: delivery.sourceCommit }
      : {}),
    ...(typeof delivery.changedFiles === 'number'
      ? { changedFiles: delivery.changedFiles }
      : {}),
    ...(typeof delivery.message === 'string' ? { message: delivery.message } : {}),
  };
}

function parseTaskDiffStat(value: unknown): SessionTaskDiffStat | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const stat = value as Record<string, unknown>;
  const fields = ['changedFiles', 'additions', 'deletions', 'commits'] as const;
  if (
    fields.some(
      (field) =>
        typeof stat[field] !== 'number' ||
        !Number.isInteger(stat[field]) ||
        stat[field] < 0
    )
  ) {
    return undefined;
  }
  return stat as unknown as SessionTaskDiffStat;
}

function parseTaskDispatch(value: unknown): SessionTaskDispatch | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const dispatch = value as Record<string, unknown>;
  let outputSchema: JsonObject | undefined;
  if (dispatch.outputSchema !== undefined) {
    try {
      outputSchema = createStructuredOutputContract(dispatch.outputSchema).schema;
    } catch {
      return undefined;
    }
  }
  if (
    dispatch.version !== 1 ||
    typeof dispatch.prompt !== 'string' ||
    !dispatch.prompt.trim() ||
    dispatch.prompt.length > 32_000 ||
    typeof dispatch.sourceProjectPath !== 'string' ||
    !path.isAbsolute(dispatch.sourceProjectPath) ||
    !SESSION_TASK_ISOLATION.has(dispatch.isolation as SessionTaskIsolation) ||
    !isSessionPermissionMode(dispatch.permissionMode) ||
    (dispatch.title !== undefined &&
      (typeof dispatch.title !== 'string' ||
        !dispatch.title.trim() ||
        dispatch.title.length > 200)) ||
    (dispatch.taskPriority !== undefined &&
      !SESSION_TASK_PRIORITIES.has(dispatch.taskPriority as SessionTaskPriority)) ||
    (dispatch.taskKind !== undefined &&
      !SESSION_TASK_KINDS.has(dispatch.taskKind as SessionTaskKind)) ||
    (dispatch.taskDueAt !== undefined &&
      (typeof dispatch.taskDueAt !== 'string' ||
        !Number.isFinite(Date.parse(dispatch.taskDueAt)))) ||
    (dispatch.modelId !== undefined &&
      (typeof dispatch.modelId !== 'string' ||
        !dispatch.modelId.trim() ||
        dispatch.modelId.length > 500)) ||
    (dispatch.reasoningEffort !== undefined &&
      !isReasoningEffortSelection(dispatch.reasoningEffort)) ||
    (dispatch.serviceTier !== undefined &&
      !isServiceTierSelection(dispatch.serviceTier)) ||
    (dispatch.responseVerbosity !== undefined &&
      !isResponseVerbositySelection(dispatch.responseVerbosity)) ||
    (dispatch.communicationStyle !== undefined &&
      !isCommunicationStyleSelection(dispatch.communicationStyle)) ||
    (dispatch.communicationStyleDigest !== undefined &&
      (typeof dispatch.communicationStyleDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(dispatch.communicationStyleDigest))) ||
    (dispatch.projectInstructionsDigest !== undefined &&
      (typeof dispatch.projectInstructionsDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(dispatch.projectInstructionsDigest)))
  ) {
    return undefined;
  }
  let attachments: SessionTaskDispatch['attachments'];
  if (dispatch.attachments !== undefined) {
    if (
      !Array.isArray(dispatch.attachments) ||
      dispatch.attachments.length > MAX_INLINE_ATTACHMENT_COUNT
    ) {
      return undefined;
    }
    let contentBytes = 0;
    for (const value of dispatch.attachments) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const attachment = value as Record<string, unknown>;
      if (!['file', 'image', 'url'].includes(String(attachment.type))) {
        return undefined;
      }
      for (const field of ['path', 'url', 'content', 'mimeType', 'name']) {
        if (attachment[field] !== undefined && typeof attachment[field] !== 'string') {
          return undefined;
        }
      }
      contentBytes +=
        typeof attachment.content === 'string'
          ? Buffer.byteLength(attachment.content)
          : 0;
    }
    if (contentBytes > MAX_INLINE_ATTACHMENT_BYTES) return undefined;
    attachments = dispatch.attachments.map((value) => {
      const attachment = value as Record<string, string | undefined>;
      return {
        type: attachment.type as 'file' | 'image' | 'url',
        ...(attachment.path !== undefined ? { path: attachment.path } : {}),
        ...(attachment.url !== undefined ? { url: attachment.url } : {}),
        ...(attachment.content !== undefined ? { content: attachment.content } : {}),
        ...(attachment.mimeType !== undefined ? { mimeType: attachment.mimeType } : {}),
        ...(attachment.name !== undefined ? { name: attachment.name } : {}),
      };
    });
  }
  return {
    version: 1,
    prompt: dispatch.prompt as string,
    ...(typeof dispatch.title === 'string' ? { title: dispatch.title } : {}),
    ...(SESSION_TASK_PRIORITIES.has(dispatch.taskPriority as SessionTaskPriority)
      ? { taskPriority: dispatch.taskPriority as SessionTaskPriority }
      : {}),
    ...(SESSION_TASK_KINDS.has(dispatch.taskKind as SessionTaskKind)
      ? { taskKind: dispatch.taskKind as SessionTaskKind }
      : {}),
    ...(typeof dispatch.taskDueAt === 'string'
      ? { taskDueAt: new Date(dispatch.taskDueAt).toISOString() }
      : {}),
    sourceProjectPath: path.resolve(dispatch.sourceProjectPath as string),
    isolation: dispatch.isolation as SessionTaskIsolation,
    permissionMode: dispatch.permissionMode as SessionTaskDispatch['permissionMode'],
    ...(typeof dispatch.modelId === 'string' ? { modelId: dispatch.modelId } : {}),
    ...(isReasoningEffortSelection(dispatch.reasoningEffort)
      ? { reasoningEffort: dispatch.reasoningEffort }
      : {}),
    ...(isServiceTierSelection(dispatch.serviceTier)
      ? { serviceTier: dispatch.serviceTier }
      : {}),
    ...(isResponseVerbositySelection(dispatch.responseVerbosity)
      ? { responseVerbosity: dispatch.responseVerbosity }
      : {}),
    ...(isCommunicationStyleSelection(dispatch.communicationStyle)
      ? { communicationStyle: dispatch.communicationStyle }
      : {}),
    ...(typeof dispatch.communicationStyleDigest === 'string'
      ? { communicationStyleDigest: dispatch.communicationStyleDigest }
      : {}),
    ...(typeof dispatch.projectInstructionsDigest === 'string'
      ? { projectInstructionsDigest: dispatch.projectInstructionsDigest }
      : {}),
    ...(attachments ? { attachments } : {}),
    ...(outputSchema ? { outputSchema } : {}),
  };
}

function isSessionPermissionMode(value: unknown): value is SessionPermissionMode {
  return (
    typeof value === 'string' &&
    SESSION_PERMISSION_MODES.has(value as SessionPermissionMode)
  );
}

function parseTaskRetryRef(value: unknown): SessionTaskRetryRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const ref = value as Record<string, unknown>;
  if (
    typeof ref.sessionId !== 'string' ||
    !ref.sessionId ||
    typeof ref.projectPath !== 'string' ||
    !path.isAbsolute(ref.projectPath)
  ) {
    return undefined;
  }
  return {
    sessionId: ref.sessionId,
    projectPath: path.resolve(ref.projectPath),
  };
}

type SessionSnapshotBigIntStats = BigIntStats;

interface SessionSnapshotIO {
  stat(filePath: string): Promise<SessionSnapshotBigIntStats>;
  readFile(filePath: string): Promise<string>;
}

const defaultSessionSnapshotIO: SessionSnapshotIO = {
  stat(filePath) {
    return stat(filePath, { bigint: true });
  },
  readFile(filePath) {
    return readFile(filePath, 'utf-8');
  },
};

let sessionSnapshotIO: SessionSnapshotIO = defaultSessionSnapshotIO;

export function __setSessionSnapshotIOForTesting(io: SessionSnapshotIO): void {
  sessionSnapshotIO = io;
}

export function __resetSessionSnapshotIOForTesting(): void {
  sessionSnapshotIO = defaultSessionSnapshotIO;
}

export interface SessionMetadata {
  sessionId: string;
  projectPath: string;
  gitBranch?: string;
  rootId: string;
  parentId?: string;
  relationType?: 'subagent' | 'fork';
  resumedFrom?: string;
  rootAgentId?: string;
  resumeDepth?: number;
  title?: string;
  agentType?: string;
  model?: string;
  selectedModelId?: string;
  permissionMode?: SessionPermissionMode;
  reasoningEffort?: ReasoningEffortSelection;
  serviceTier?: ServiceTierSelection;
  responseVerbosity?: ResponseVerbositySelection;
  communicationStyle?: CommunicationStyleSelection;
  communicationStyleDigest?: string;
  projectInstructionsDigest?: string;
  pendingInteraction?: SessionPendingInteraction;
  taskStatus: SessionTaskStatus;
  taskStatusReason?: string;
  taskFailure?: SessionTaskFailure;
  taskStartedAt?: string;
  taskCompletedAt?: string;
  taskPromptSummary?: string;
  taskPriority?: SessionTaskPriority;
  taskKind?: SessionTaskKind;
  taskDueAt?: string;
  taskModelId?: string;
  taskRetryAvailable?: boolean;
  taskRetriedFrom?: SessionTaskRetryRef;
  taskDelivery?: SessionTaskDelivery;
  taskIsolation?: SessionTaskIsolation;
  taskSourceProjectPath?: string;
  taskWorktreePath?: string;
  taskWorktreeBranch?: string;
  taskBaseCommit?: string;
  taskDiffStat?: SessionTaskDiffStat;
  taskQueuePosition?: number;
  taskQueueDepth?: number;
  taskConcurrencyLimit?: number;
  archivedAt?: string;
  archivedBySessionId?: string;
  messageCount: number;
  firstMessageTime: string;
  lastMessageTime: string;
  hasErrors: boolean;
}

interface StoredSessionMetadata extends SessionMetadata {
  filePath: string;
  taskOwnerPid?: number;
  taskWorktree?: SessionTaskWorktree;
  taskDispatch?: SessionTaskDispatch;
}

export interface SessionMetadataUpdate {
  title?: string;
  taskStatus?: SessionTaskStatus;
  taskStatusReason?: string | null;
  taskFailure?: SessionTaskFailure | null;
  taskStartedAt?: string | null;
  taskCompletedAt?: string | null;
  taskOwnerPid?: number | null;
  taskPromptSummary?: string | null;
  taskPriority?: SessionTaskPriority | null;
  taskKind?: SessionTaskKind | null;
  taskDueAt?: string | null;
  taskDispatch?: SessionTaskDispatch | null;
  taskModelId?: string | null;
  taskRetriedFrom?: SessionTaskRetryRef | null;
  taskDelivery?: SessionTaskDelivery | null;
  taskIsolation?: SessionTaskIsolation | null;
  taskSourceProjectPath?: string | null;
  taskWorktree?: SessionTaskWorktree | null;
  taskDiffStat?: SessionTaskDiffStat | null;
  taskQueuePosition?: number | null;
  taskQueueDepth?: number | null;
  taskConcurrencyLimit?: number | null;
  selectedModelId?: string | null;
  permissionMode?: SessionPermissionMode | null;
  reasoningEffort?: ReasoningEffortSelection | null;
  serviceTier?: ServiceTierSelection | null;
  responseVerbosity?: ResponseVerbositySelection | null;
  communicationStyle?: CommunicationStyleSelection | null;
  communicationStyleDigest?: string | null;
  projectInstructionsDigest?: string | null;
}

export interface SessionPage {
  sessions: SessionMetadata[];
  nextCursor?: string;
}

export class SessionMissingCreationError extends Error {
  constructor(sessionId: string) {
    super(`Session has no durable creation record: ${sessionId}`);
    this.name = 'SessionMissingCreationError';
  }
}

export class SessionArchivedError extends Error {
  readonly code = 'BLADE_SESSION_ARCHIVED';

  constructor(
    readonly sessionId: string,
    readonly archivedBySessionId: string
  ) {
    super(
      sessionId === archivedBySessionId
        ? `Session is archived: ${sessionId}`
        : `Session is archived by ancestor ${archivedBySessionId}: ${sessionId}`
    );
    this.name = 'SessionArchivedError';
  }
}

export class SessionArchiveConflictError extends Error {
  readonly code = 'BLADE_SESSION_ARCHIVE_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'SessionArchiveConflictError';
  }
}

export interface ForkSessionOptions {
  newSessionId?: string;
  sourceProjectPath: string;
  targetProjectPath: string;
}

export interface ForkedSession {
  sessionId: string;
  parentSessionId: string;
  projectPath: string;
  messages: Message[];
  metadata: SessionMetadata;
}

export interface SessionRewindCheckpoint extends ProjectedRewindCheckpoint {
  fileCount: number;
}

export interface RewindSessionOptions {
  targetMessageId: string;
  mode: SessionRewindMode;
}

export interface RewoundSession {
  checkpoint: SessionRewindCheckpoint;
  mode: SessionRewindMode;
  removedTurns: number;
  restoredFiles: string[];
  messages: Message[];
}

function archiveKey(projectPath: string, sessionId: string): string {
  return `${projectPath}\0${sessionId}`;
}

function reviewPromptFromTarget(target: SessionReviewTargetInfo): string {
  if (target.kind === 'base') {
    return `/review base ${target.baseSha ?? target.label}`;
  }
  if (target.kind === 'commit') {
    return `/review commit ${target.commitSha ?? target.label}`;
  }
  return '/review uncommitted';
}

function isValidArchiveTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

function projectEffectiveArchiveState(
  sessions: readonly StoredSessionMetadata[]
): StoredSessionMetadata[] {
  const byKey = new Map(
    sessions.map((session) => [
      archiveKey(session.projectPath, session.sessionId),
      session,
    ])
  );

  return sessions.map((session) => {
    let current: StoredSessionMetadata | undefined = session;
    const visited = new Set<string>();
    while (current) {
      const key = archiveKey(current.projectPath, current.sessionId);
      if (visited.has(key)) break;
      visited.add(key);
      if (isValidArchiveTimestamp(current.archivedAt)) {
        return {
          ...session,
          archivedAt: current.archivedAt,
          archivedBySessionId: current.sessionId,
        };
      }
      current = current.parentId
        ? byKey.get(archiveKey(current.projectPath, current.parentId))
        : undefined;
    }

    const {
      archivedAt: _archivedAt,
      archivedBySessionId: _archivedBySessionId,
      ...active
    } = session;
    return active;
  });
}

function filterArchiveState(
  sessions: readonly StoredSessionMetadata[],
  archived: boolean | null
): StoredSessionMetadata[] {
  const projected = projectEffectiveArchiveState(sessions);
  if (archived === null) return projected;
  return projected.filter((session) => Boolean(session.archivedAt) === archived);
}

/**
 * 会话管理服务
 */
export class SessionService {
  /**
   * 将加载到的会话消息转换为 UI 安全的 SessionMessage。
   * 过滤掉 tool / system 等内部消息，仅从 ContentPart[] 中提取文本，
   * 避免把 </functions>、工具调用 JSON、summary 等内部内容泄露给用户或污染历史。
   */
  static toUISafeMessages(messages: Message[]): SessionMessage[] {
    const now = Date.now();
    const total = messages.length;
    const result: SessionMessage[] = [];

    messages.forEach((msg, index) => {
      if (
        (msg.role !== 'user' && msg.role !== 'assistant') ||
        !isClientVisibleMessage(msg)
      ) {
        return;
      }

      let content: string;
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = (msg.content as ContentPart[])
          .map((part) => (part.type === 'text' ? part.text : '[Image]'))
          .join('');
      } else {
        content = '';
      }

      const normalizedContent = content.trim();
      if (!normalizedContent) return;
      const userShellCommand = userShellCommandRecordFromMetadata(msg.metadata);
      const visibleContent = userShellCommand
        ? renderUserShellCommandForDisplay(userShellCommand)
        : normalizedContent;

      const previous = result[result.length - 1];
      if (
        previous &&
        previous.role === msg.role &&
        previous.content === visibleContent
      ) {
        return;
      }

      result.push({
        id: `restored-${now}-${index}`,
        role: msg.role,
        content: visibleContent,
        timestamp: now - (total - index) * 1000,
        metadata:
          msg.metadata && typeof msg.metadata === 'object'
            ? (msg.metadata as Record<string, unknown>)
            : undefined,
      });
    });

    return result;
  }

  static async listSessionPage(options: SessionListOptions = {}): Promise<SessionPage> {
    const normalized = normalizeSessionListOptions(options);
    const projected = await this.listSessionPageFromProjection(normalized);
    if (projected) return projected;
    const stored = await this.scanStoredSessions(
      normalized.cwd ?? undefined,
      normalized.includeSubagents,
      normalized.cursor ? 5_000 : 0,
      normalized.archived
    );
    const filtered = stored.sort(compareSessionCatalogItems);
    const page = paginateSessionCatalog(filtered, normalized);
    return {
      sessions: page.sessions.map((session) => this.toPublicMetadata(session)),
      nextCursor: page.nextCursor,
    };
  }

  private static async listSessionPageFromProjection(
    options: NormalizedSessionListOptions
  ): Promise<SessionPage | null> {
    const boundary = resolveSessionCursorBoundary(options);
    try {
      const db = await getProjectionDb();
      if (!db) return null;
      await syncAll(db, this.projectionDeriver(), options.cursor ? 5_000 : 0);

      const filters: string[] = [];
      const parameters: unknown[] = [];
      if (options.cwd) {
        filters.push('s.project_path = ?');
        parameters.push(options.cwd);
      }
      if (!options.includeSubagents) {
        filters.push('s.is_subagent = 0');
      }
      filters.push(
        options.archived ? 'a.session_id IS NOT NULL' : 'a.session_id IS NULL'
      );
      if (boundary) {
        filters.push(`(
          s.last_message_time < ?
          OR (
            s.last_message_time = ?
            AND (
              s.project_sort_key > ?
              OR (s.project_sort_key = ? AND s.session_sort_key > ?)
            )
          )
        )`);
        const projectSortKey = sessionCatalogSortKey(boundary.projectPath);
        parameters.push(
          boundary.lastMessageTime,
          boundary.lastMessageTime,
          projectSortKey,
          projectSortKey,
          sessionCatalogSortKey(boundary.sessionId)
        );
      }

      const rows = db
        .prepare(
          `WITH RECURSIVE archive_members(
             project_path, session_id, archive_root_id, effective_archived_at, depth
           ) AS (
             SELECT project_path, session_id, session_id, archived_at, 0
             FROM sessions
             WHERE archived_at IS NOT NULL
             UNION ALL
             SELECT child.project_path, child.session_id, parent.archive_root_id,
                    parent.effective_archived_at, parent.depth + 1
             FROM sessions child
             JOIN archive_members parent
               ON child.project_path = parent.project_path
              AND child.parent_id = parent.session_id
             WHERE parent.depth < 128
           ),
           ranked_archive AS (
             SELECT project_path, session_id, archive_root_id,
                    effective_archived_at,
                    ROW_NUMBER() OVER (
                      PARTITION BY project_path, session_id
                      ORDER BY depth ASC, archive_root_id ASC
                    ) AS rank
             FROM archive_members
           )
           SELECT s.metadata_json, a.archive_root_id, a.effective_archived_at
           FROM sessions s
           LEFT JOIN ranked_archive a
             ON a.project_path = s.project_path
            AND a.session_id = s.session_id
            AND a.rank = 1
           ${filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''}
           ORDER BY s.last_message_time DESC,
                    s.project_sort_key ASC,
                    s.session_sort_key ASC
           LIMIT ?`
        )
        .all<{
          metadata_json: string;
          archive_root_id: string | null;
          effective_archived_at: string | null;
        }>(...parameters, options.limit + 1);
      const sessions = await Promise.all(
        rows.map(async (row) => {
          const metadata = JSON.parse(row.metadata_json) as StoredSessionMetadata;
          if (row.archive_root_id && row.effective_archived_at) {
            return this.reconcileInterruptedTask({
              ...metadata,
              archivedAt: row.effective_archived_at,
              archivedBySessionId: row.archive_root_id,
            });
          }
          const {
            archivedAt: _archivedAt,
            archivedBySessionId: _archivedBySessionId,
            ...active
          } = metadata;
          return this.reconcileInterruptedTask(active);
        })
      );
      const page = paginateSessionCatalog(sessions, options);
      return {
        sessions: page.sessions.map((session) => this.toPublicMetadata(session)),
        nextCursor: page.nextCursor,
      };
    } catch {
      return null;
    }
  }

  /**
   * 列出所有可用会话
   * 扫描 ~/.blade/projects/ 目录下的所有 JSONL 文件
   */
  static async listSessions(
    options: SessionScanOptions = {}
  ): Promise<SessionMetadata[]> {
    const normalized = normalizeSessionListOptions(options);
    const taskFilters = normalizeSessionTaskFilters(options);
    const stored = await this.scanStoredSessions(
      normalized.cwd ?? undefined,
      normalized.includeSubagents,
      0,
      normalized.archived,
      taskFilters
    );
    const seenSessions = new Set<string>();
    return stored.sort(compareSessionCatalogItems).flatMap((session) => {
      const key = `${session.projectPath}\0${session.sessionId}`;
      if (seenSessions.has(key)) return [];
      seenSessions.add(key);
      return [this.toPublicMetadata(session)];
    });
  }

  /**
   * Removes abandoned session shells that never progressed past session_created.
   * A cross-process lease and an in-lock transcript check make the deletion safe
   * against a task starting while the collector is scanning.
   */
  static async collectStaleEmptySessions(
    options: { projectPath?: string; olderThanMs?: number; now?: number } = {}
  ): Promise<number> {
    const now = options.now ?? Date.now();
    const olderThanMs = options.olderThanMs ?? STALE_EMPTY_SESSION_AGE_MS;
    if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
      throw new Error('Stale empty session age must be a non-negative number');
    }
    const projectDirs = options.projectPath
      ? [
          {
            storagePath: getProjectStoragePath(
              this.resolveCatalogWorkspace(options.projectPath)
            ),
            projectPath: this.resolveCatalogWorkspace(options.projectPath),
          },
        ]
      : await this.listAllProjectStorageDirectories();
    let deleted = 0;

    for (const project of projectDirs) {
      let files: string[];
      try {
        files = await readdir(project.storagePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.slice(0, -'.jsonl'.length);
        if (!isValidSessionId(sessionId)) continue;
        const filePath = path.join(project.storagePath, file);
        try {
          const fileStat = await stat(filePath);
          if (now - fileStat.mtimeMs < olderThanMs) continue;
          const hasDurableSidecar = await Promise.all([
            stat(path.join(project.storagePath, `${sessionId}.inbox.json`))
              .then(() => true)
              .catch(() => false),
            stat(getSessionGoalFilePath(project.projectPath, sessionId))
              .then(() => true)
              .catch(() => false),
          ]).then((present) => present.some(Boolean));
          if (hasDurableSidecar) continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }

        let lease: SessionLease;
        try {
          lease = await SessionLease.acquire(sessionId, project.projectPath);
        } catch (error) {
          if (error instanceof SessionInUseError) continue;
          throw error;
        }

        try {
          const removed = await new JSONLStore(filePath).deleteValidated(
            (entries) =>
              entries.length === 1 &&
              entries[0]?.type === 'session_created' &&
              entries[0].data.relationType !== 'subagent'
          );
          if (!removed) continue;
          deleted++;
          await rm(path.join(project.storagePath, `${sessionId}.inbox.json`), {
            force: true,
          });
          await rm(getSessionGoalFilePath(project.projectPath, sessionId), {
            force: true,
          });
          await this.removeFromProjection(sessionId, project.projectPath);
        } catch (error) {
          logger.warn(
            `[SessionService] Skipping stale empty session cleanup: ${sessionId}`,
            error
          );
        } finally {
          await lease.release();
        }
      }
    }

    return deleted;
  }

  static async findSessionMetadata(
    sessionId: string,
    projectPath?: string
  ): Promise<SessionMetadata | undefined> {
    assertValidSessionId(sessionId);

    if (projectPath !== undefined) {
      if (!path.isAbsolute(projectPath)) {
        throw new Error('Session catalog cwd must be absolute');
      }
      const resolvedProjectPath = path.resolve(projectPath);
      const filePath = this.getSessionFilePath(resolvedProjectPath, sessionId);
      try {
        const stored = await this.readStoredSessionMetadata(
          filePath,
          sessionId,
          resolvedProjectPath
        );
        if (stored.projectPath !== resolvedProjectPath) {
          return undefined;
        }
        if (!stored.parentId || stored.archivedAt) {
          return this.toPublicMetadata(filterArchiveState([stored], null)[0] ?? stored);
        }
        const scoped = await this.scanStoredSessions(
          resolvedProjectPath,
          true,
          0,
          null
        );
        return this.toPublicMetadata(
          scoped.find((session) => session.sessionId === sessionId) ?? stored
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw error;
      }
    }

    const matches = (await this.scanStoredSessions(undefined, true, 0, null)).filter(
      (session) => session.sessionId === sessionId
    );
    if (matches.length === 0) return undefined;
    if (matches.length > 1) {
      throw new Error(`Ambiguous session ID: ${sessionId}`);
    }
    return this.toPublicMetadata(matches[0]!);
  }

  /**
   * 加载指定会话的消息历史
   * @param sessionId 会话 ID
   * @param projectPath 项目路径（可选，如果不提供则搜索所有项目）
   */
  static async loadSession(
    sessionId: string,
    projectPath?: string
  ): Promise<Message[]> {
    try {
      if (projectPath) {
        if (!path.isAbsolute(projectPath)) {
          throw new Error('Session catalog cwd must be absolute');
        }
        const resolvedProjectPath = path.resolve(projectPath);
        const filePath = this.getSessionFilePath(resolvedProjectPath, sessionId);
        try {
          return await this.loadSessionFromFile(
            filePath,
            sessionId,
            resolvedProjectPath
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(`未找到会话: ${sessionId}`);
          }
          throw error;
        }
      }

      const session = (await this.scanStoredSessions(undefined, true, 0, null)).find(
        (candidate) => candidate.sessionId === sessionId
      );

      if (!session) {
        throw new Error(`未找到会话: ${sessionId}`);
      }

      return await this.loadSessionFromFile(session.filePath, sessionId);
    } catch (error) {
      logger.error(`[SessionService] 加载会话失败 (${sessionId}):`, error);
      throw error;
    }
  }

  /**
   * Load the model-visible context projection.
   *
   * Unlike loadSession(), this applies the latest durable compaction checkpoint
   * while keeping the full transcript available to UI/history consumers.
   */
  static async loadSessionModelContext(
    sessionId: string,
    projectPath?: string
  ): Promise<Message[]> {
    try {
      if (projectPath) {
        if (!path.isAbsolute(projectPath)) {
          throw new Error('Session catalog cwd must be absolute');
        }
        const resolvedProjectPath = path.resolve(projectPath);
        const filePath = this.getSessionFilePath(resolvedProjectPath, sessionId);
        try {
          return await this.loadSessionModelContextFromFile(
            filePath,
            sessionId,
            resolvedProjectPath
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(`未找到会话: ${sessionId}`);
          }
          throw error;
        }
      }

      const session = (await this.scanStoredSessions(undefined, true, 0, null)).find(
        (candidate) => candidate.sessionId === sessionId
      );
      if (!session) {
        throw new Error(`未找到会话: ${sessionId}`);
      }
      return await this.loadSessionModelContextFromFile(session.filePath, sessionId);
    } catch (error) {
      logger.error(`[SessionService] 加载模型上下文失败 (${sessionId}):`, error);
      throw error;
    }
  }

  static async exportSessionMarkdown(
    sessionId: string,
    projectPath: string,
    options: SessionMarkdownExportOptions = {}
  ): Promise<SessionMarkdownExport> {
    assertValidSessionId(sessionId);
    const resolvedProjectPath = this.resolveCatalogWorkspace(projectPath);
    const filePath = getSessionFilePath(resolvedProjectPath, sessionId);
    let entries: SessionEvent[];
    try {
      entries = await this.readStableSessionSnapshot(filePath, sessionId);
    } catch (error) {
      throw this.sanitizeStoredSessionError(error, sessionId);
    }
    const stored = this.projectMetadataFromEntries(
      entries,
      sessionId,
      resolvedProjectPath,
      filePath
    );
    if (stored.projectPath !== resolvedProjectPath) {
      throw new Error(`Session export workspace mismatch: ${sessionId}`);
    }
    let archivedAt = stored.archivedAt;
    if (!archivedAt && stored.parentId) {
      archivedAt = (
        await this.findArchivedAncestor(stored.parentId, resolvedProjectPath)
      )?.archivedAt;
    }
    return renderSessionMarkdown(
      entries,
      {
        ...stored,
        archivedAt,
      },
      options
    );
  }

  static async listRewindCheckpoints(
    sessionId: string,
    projectPath: string
  ): Promise<SessionRewindCheckpoint[]> {
    assertValidSessionId(sessionId);
    const resolvedProjectPath = this.resolveCatalogWorkspace(projectPath);
    const filePath = getSessionFilePath(resolvedProjectPath, sessionId);
    const entries = await this.readStableSessionSnapshot(filePath, sessionId);
    this.validateSessionWorkspace(entries, sessionId, resolvedProjectPath);

    const snapshotManager = new SnapshotManager({
      sessionId,
      workspaceRoot: resolvedProjectPath,
    });
    await snapshotManager.initialize();
    const checkpoints = listProjectedRewindCheckpoints(entries);
    const result: SessionRewindCheckpoint[] = [];
    for (const checkpoint of checkpoints) {
      const plan = planSessionRewind(entries, checkpoint.messageId);
      const preview = await snapshotManager.previewRewind(plan.snapshotMessageIds);
      result.push({
        ...checkpoint,
        fileCount: preview.files.length,
      });
    }
    return result;
  }

  static async rewindSession(
    sessionId: string,
    projectPath: string,
    options: RewindSessionOptions
  ): Promise<RewoundSession> {
    assertValidSessionId(sessionId);
    const resolvedProjectPath = this.resolveCatalogWorkspace(projectPath);
    await this.assertSessionWritable(sessionId, resolvedProjectPath);
    const filePath = getSessionFilePath(resolvedProjectPath, sessionId);
    const store = new JSONLStore(filePath);
    let result: RewoundSession | undefined;

    try {
      await store.appendValidatedAsync(async (entries) => {
        this.validateSessionWorkspace(entries, sessionId, resolvedProjectPath);
        const plan = planSessionRewind(entries, options.targetMessageId);
        const snapshotManager = new SnapshotManager({
          sessionId,
          workspaceRoot: resolvedProjectPath,
        });
        await snapshotManager.initialize();
        const preview = await snapshotManager.previewRewind(plan.snapshotMessageIds);
        const snapshotResult =
          options.mode === 'conversation'
            ? await snapshotManager.commitSnapshots(plan.snapshotMessageIds)
            : await snapshotManager.rewindSnapshots(plan.snapshotMessageIds);
        const now = new Date().toISOString();
        const rewindEvent: Extract<SessionEvent, { type: 'session_rewound' }> = {
          id: nanoid(),
          sessionId,
          timestamp: now,
          type: 'session_rewound',
          cwd: resolvedProjectPath,
          gitBranch: detectGitBranch(resolvedProjectPath),
          version: getVersion(),
          data: {
            rewindId: nanoid(),
            targetMessageId: options.targetMessageId,
            mode: options.mode,
            restoredFiles: options.mode === 'conversation' ? [] : snapshotResult.files,
            createdAt: now,
          },
        };
        const projected = materializeSessionEvents([...entries, rewindEvent]);
        result = {
          checkpoint: {
            ...plan.checkpoint,
            fileCount: preview.files.length,
          },
          mode: options.mode,
          removedTurns: plan.removedTurns,
          restoredFiles: rewindEvent.data.restoredFiles,
          messages: this.convertJSONLToMessages(projected),
        };
        return rewindEvent;
      });
    } catch (error) {
      throw this.sanitizeStoredSessionError(error, sessionId);
    }

    if (!result) {
      throw new Error(`Session rewind did not produce a result: ${sessionId}`);
    }
    for (const filePath of result.restoredFiles) {
      FileAccessTracker.getInstance().clearFileRecord(filePath);
    }
    return result;
  }

  /**
   * Fork committed history into a new transcript without mutating the source.
   * Exclusive creation makes an explicit target ID collision fail closed.
   */
  static async forkSession(
    sourceSessionId: string,
    options: ForkSessionOptions
  ): Promise<ForkedSession> {
    assertValidSessionId(sourceSessionId);
    const targetSessionId = options.newSessionId ?? `fork-${Date.now()}-${nanoid(8)}`;
    assertValidSessionId(targetSessionId);
    const sourceProjectPath = this.resolveForkWorkspace(options.sourceProjectPath);
    const targetProjectPath = this.resolveForkWorkspace(options.targetProjectPath);
    if (sourceProjectPath !== targetProjectPath) {
      throw new Error('Session forks must stay in the source workspace');
    }

    const sourceFilePath = getSessionFilePath(sourceProjectPath, sourceSessionId);
    const sourceTranscript = await this.readStableSessionSnapshot(
      sourceFilePath,
      sourceSessionId
    );
    const sourceCreated = this.getSessionCreatedEntry(
      sourceTranscript,
      sourceSessionId
    );
    if (sourceCreated.data.sessionId !== sourceSessionId) {
      throw new Error(
        'Fork source session_created.data.sessionId must match the requested session ID'
      );
    }
    if (
      !path.isAbsolute(sourceCreated.cwd) ||
      path.resolve(sourceCreated.cwd) !== sourceProjectPath
    ) {
      throw new Error(
        'Fork source session_created.cwd must resolve to the requested source workspace'
      );
    }
    const sourceMetadata = this.projectMetadataFromEntries(
      sourceTranscript,
      sourceSessionId,
      sourceProjectPath,
      sourceFilePath
    );
    if (sourceMetadata.archivedAt) {
      throw new SessionArchivedError(sourceSessionId, sourceSessionId);
    }
    if (sourceMetadata.parentId) {
      const ancestor = await this.findArchivedAncestor(
        sourceMetadata.parentId,
        sourceProjectPath
      );
      if (ancestor) {
        throw new SessionArchivedError(sourceSessionId, ancestor.sessionId);
      }
    }
    const sourceEntries = materializeSessionEvents(sourceTranscript);

    const now = new Date().toISOString();
    const rootId = sourceCreated.data.rootId || sourceSessionId;
    const gitBranch = detectGitBranch(targetProjectPath);
    const version = getVersion();
    const {
      status: _sourceStatus,
      taskStatus: _sourceTaskStatus,
      taskStatusReason: _sourceTaskStatusReason,
      taskFailure: _sourceTaskFailure,
      taskStartedAt: _sourceTaskStartedAt,
      taskCompletedAt: _sourceTaskCompletedAt,
      taskOwnerPid: _sourceTaskOwnerPid,
      taskPromptSummary: _sourceTaskPromptSummary,
      taskPriority: _sourceTaskPriority,
      taskKind: _sourceTaskKind,
      taskDueAt: _sourceTaskDueAt,
      taskDispatch: _sourceTaskDispatch,
      taskModelId: _sourceTaskModelId,
      taskRetriedFrom: _sourceTaskRetriedFrom,
      taskDelivery: _sourceTaskDelivery,
      taskIsolation: _sourceTaskIsolation,
      taskSourceProjectPath: _sourceTaskSourceProjectPath,
      taskWorktree: _sourceTaskWorktree,
      taskDiffStat: _sourceTaskDiffStat,
      taskQueuePosition: _sourceTaskQueuePosition,
      taskQueueDepth: _sourceTaskQueueDepth,
      taskConcurrencyLimit: _sourceTaskConcurrencyLimit,
      pendingInteraction: _sourcePendingInteraction,
      ...sourceCreatedData
    } = sourceCreated.data;
    const childCreated: Extract<SessionEvent, { type: 'session_created' }> = {
      id: nanoid(),
      sessionId: targetSessionId,
      timestamp: now,
      type: 'session_created',
      cwd: targetProjectPath,
      gitBranch,
      version,
      data: {
        ...sourceCreatedData,
        sessionId: targetSessionId,
        rootId,
        parentId: sourceSessionId,
        relationType: 'fork',
        taskStatus: 'completed',
        taskCompletedAt: now,
        taskIsolation: 'local',
        taskSourceProjectPath: targetProjectPath,
        createdAt: now,
        updatedAt: now,
      },
    };
    const copiedEntries = sourceEntries
      .filter(
        (entry) =>
          entry.type !== 'session_created' &&
          entry.type !== 'token_budget_handoff_recorded' &&
          entry.type !== 'inbox_acknowledged' &&
          entry.type !== 'interaction_requested' &&
          entry.type !== 'interaction_responded' &&
          entry.type !== 'interaction_recovered' &&
          entry.type !== 'review_started' &&
          entry.type !== 'review_completed'
      )
      .map((entry): SessionEvent => {
        const base = {
          ...entry,
          id: nanoid(),
          sessionId: targetSessionId,
          cwd: targetProjectPath,
          gitBranch,
          version,
        };
        if (entry.type === 'session_updated') {
          const {
            status: _status,
            taskStatus: _taskStatus,
            taskStatusReason: _taskStatusReason,
            taskFailure: _taskFailure,
            taskStartedAt: _taskStartedAt,
            taskCompletedAt: _taskCompletedAt,
            taskOwnerPid: _taskOwnerPid,
            taskPromptSummary: _taskPromptSummary,
            taskPriority: _taskPriority,
            taskKind: _taskKind,
            taskDueAt: _taskDueAt,
            taskDispatch: _taskDispatch,
            taskModelId: _taskModelId,
            taskRetriedFrom: _taskRetriedFrom,
            taskDelivery: _taskDelivery,
            taskIsolation: _taskIsolation,
            taskSourceProjectPath: _taskSourceProjectPath,
            taskWorktree: _taskWorktree,
            taskDiffStat: _taskDiffStat,
            taskQueuePosition: _taskQueuePosition,
            taskQueueDepth: _taskQueueDepth,
            taskConcurrencyLimit: _taskConcurrencyLimit,
            pendingInteraction: _pendingInteraction,
            ...updatedData
          } = entry.data;
          return {
            ...base,
            type: 'session_updated',
            data: {
              ...updatedData,
              sessionId: targetSessionId,
              rootId,
              parentId: sourceSessionId,
              relationType: 'fork',
            },
          };
        }
        if (entry.type === 'message_created') {
          const { inboxMessageId: _inboxMessageId, ...data } = entry.data;
          return {
            ...base,
            type: 'message_created',
            data,
          };
        }
        return base as SessionEvent;
      });
    const forkBoundary: Extract<SessionEvent, { type: 'session_updated' }> = {
      id: nanoid(),
      sessionId: targetSessionId,
      timestamp: now,
      type: 'session_updated',
      cwd: targetProjectPath,
      gitBranch,
      version,
      data: {
        sessionId: targetSessionId,
        rootId,
        parentId: sourceSessionId,
        relationType: 'fork',
        taskStatus: 'completed',
        taskStatusReason: null,
        taskFailure: null,
        taskStartedAt: null,
        taskCompletedAt: now,
        taskOwnerPid: null,
        taskIsolation: 'local',
        taskSourceProjectPath: targetProjectPath,
        taskWorktree: null,
        taskDiffStat: null,
        taskDelivery: null,
        taskQueuePosition: null,
        taskQueueDepth: null,
        taskConcurrencyLimit: null,
        updatedAt: now,
      },
    };
    const childEntries: SessionEvent[] = [childCreated, ...copiedEntries, forkBoundary];
    const targetFilePath = getSessionFilePath(targetProjectPath, targetSessionId);

    try {
      await new JSONLStore(targetFilePath).createExclusive(childEntries);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Fork session already exists: ${targetSessionId}`, {
          cause: error,
        });
      }
      throw error;
    }

    const metadata = this.projectMetadataFromEntries(
      childEntries,
      targetSessionId,
      targetProjectPath,
      targetFilePath
    );

    return {
      sessionId: targetSessionId,
      parentSessionId: sourceSessionId,
      projectPath: targetProjectPath,
      messages: this.convertJSONLToMessages(childEntries),
      metadata: this.toPublicMetadata(metadata),
    };
  }

  static async deleteSession(sessionId: string, projectPath?: string): Promise<number> {
    assertValidSessionId(sessionId);

    if (projectPath) {
      if (!path.isAbsolute(projectPath)) {
        throw new Error('Session catalog cwd must be absolute');
      }
      const resolvedProjectPath = path.resolve(projectPath);
      const filePath = this.getSessionFilePath(resolvedProjectPath, sessionId);
      const store = new JSONLStore(filePath);
      let deleted: boolean;
      try {
        deleted = await store.deleteValidated((entries) => {
          const stored = this.projectMetadataFromEntries(
            entries,
            sessionId,
            resolvedProjectPath,
            filePath
          );
          return stored.projectPath === resolvedProjectPath;
        });
      } catch (error) {
        if (!this.isCorruptSessionJSONLError(error)) {
          throw error;
        }
        // TODO(storage-v2): Corrupt JSONL has no trustworthy committed cwd. The
        // legacy exact-delete contract cannot distinguish a requested workspace from
        // a non-injective storage-key alias. Preserve cleanup for now. Valid
        // transcripts serialize validation + deletion only within this process; an
        // injective storage key and cross-process locking remain separate debts.
        deleted = await store.delete();
      }
      if (!deleted) {
        return 0;
      }
      await rm(path.join(path.dirname(filePath), `${sessionId}.inbox.json`), {
        force: true,
      });
      await rm(getSessionGoalFilePath(resolvedProjectPath, sessionId), {
        force: true,
      });
      await this.removeFromProjection(sessionId, resolvedProjectPath);
      return 1;
    }

    const matches = (await this.scanStoredSessions(undefined, true)).filter(
      (session) => session.sessionId === sessionId
    );

    if (matches.length === 0) return 0;

    await Promise.all(
      matches.map(async (session) => {
        await new JSONLStore(session.filePath).delete();
        await rm(
          path.join(path.dirname(session.filePath), `${session.sessionId}.inbox.json`),
          {
            force: true,
          }
        );
        await rm(getSessionGoalFilePath(session.projectPath, session.sessionId), {
          force: true,
        });
        await this.removeFromProjection(session.sessionId, session.projectPath);
      })
    );
    return matches.length;
  }

  /** Best-effort：删除会话后同步清理 SQLite 投影行（失败仅忽略，syncAll 会兜底 GC）。 */
  private static async removeFromProjection(
    sessionId: string,
    projectPath: string
  ): Promise<void> {
    try {
      const db = await getProjectionDb();
      if (db) removeSessionFromProjection(db, sessionId, projectPath);
    } catch {
      // 投影是派生缓存，删除失败不影响 JSONL 真相；下次 syncAll GC。
    }
  }

  private static validateTaskMetadataUpdate(
    update: SessionMetadataUpdate,
    sessionId: string
  ): void {
    if (
      update.taskPromptSummary !== undefined &&
      update.taskPromptSummary !== null &&
      (!update.taskPromptSummary.trim() || update.taskPromptSummary.length > 1000)
    ) {
      throw new Error('Session task prompt summary must contain 1-1000 characters');
    }
    if (
      update.taskPriority !== undefined &&
      update.taskPriority !== null &&
      !SESSION_TASK_PRIORITIES.has(update.taskPriority)
    ) {
      throw new Error('Invalid session task priority');
    }
    if (
      update.taskKind !== undefined &&
      update.taskKind !== null &&
      !SESSION_TASK_KINDS.has(update.taskKind)
    ) {
      throw new Error('Invalid session task kind');
    }
    if (
      update.taskDueAt !== undefined &&
      update.taskDueAt !== null &&
      !Number.isFinite(Date.parse(update.taskDueAt))
    ) {
      throw new Error('Invalid session task due date');
    }
    if (
      update.taskFailure !== undefined &&
      update.taskFailure !== null &&
      !isSessionTaskFailure(update.taskFailure)
    ) {
      throw new Error('Invalid session task failure');
    }
    if (
      update.taskDispatch !== undefined &&
      update.taskDispatch !== null &&
      !parseTaskDispatch(update.taskDispatch)
    ) {
      throw new Error('Invalid durable task dispatch');
    }
    if (
      update.taskModelId !== undefined &&
      update.taskModelId !== null &&
      (!update.taskModelId.trim() || update.taskModelId.length > 500)
    ) {
      throw new Error('Invalid session task model ID');
    }
    if (
      update.selectedModelId !== undefined &&
      update.selectedModelId !== null &&
      (!update.selectedModelId.trim() || update.selectedModelId.length > 500)
    ) {
      throw new Error('Invalid selected session model ID');
    }
    if (
      update.permissionMode !== undefined &&
      update.permissionMode !== null &&
      !isSessionPermissionMode(update.permissionMode)
    ) {
      throw new Error('Invalid session permission mode');
    }
    if (
      update.reasoningEffort !== undefined &&
      update.reasoningEffort !== null &&
      !isReasoningEffortSelection(update.reasoningEffort)
    ) {
      throw new Error('Invalid session reasoning effort');
    }
    if (
      update.serviceTier !== undefined &&
      update.serviceTier !== null &&
      !isServiceTierSelection(update.serviceTier)
    ) {
      throw new Error('Invalid session service tier');
    }
    if (
      update.responseVerbosity !== undefined &&
      update.responseVerbosity !== null &&
      !isResponseVerbositySelection(update.responseVerbosity)
    ) {
      throw new Error('Invalid session response verbosity');
    }
    if (
      update.communicationStyle !== undefined &&
      update.communicationStyle !== null &&
      !isCommunicationStyleSelection(update.communicationStyle)
    ) {
      throw new Error('Invalid session communication style');
    }
    if (
      update.communicationStyleDigest !== undefined &&
      update.communicationStyleDigest !== null &&
      !/^[a-f0-9]{64}$/.test(update.communicationStyleDigest)
    ) {
      throw new Error('Invalid session communication style digest');
    }
    if (
      update.projectInstructionsDigest !== undefined &&
      update.projectInstructionsDigest !== null &&
      !/^[a-f0-9]{64}$/.test(update.projectInstructionsDigest)
    ) {
      throw new Error('Invalid session project instructions digest');
    }
    if (
      update.taskRetriedFrom !== undefined &&
      update.taskRetriedFrom !== null &&
      !parseTaskRetryRef(update.taskRetriedFrom)
    ) {
      throw new Error('Invalid session task retry source');
    }
    if (
      update.taskDelivery !== undefined &&
      update.taskDelivery !== null &&
      !parseTaskDelivery(update.taskDelivery)
    ) {
      throw new Error('Invalid session task delivery');
    }
    if (
      update.taskIsolation !== undefined &&
      update.taskIsolation !== null &&
      !SESSION_TASK_ISOLATION.has(update.taskIsolation)
    ) {
      throw new Error(
        `Invalid session task isolation: ${String(update.taskIsolation)}`
      );
    }
    if (
      update.taskSourceProjectPath !== undefined &&
      update.taskSourceProjectPath !== null &&
      !path.isAbsolute(update.taskSourceProjectPath)
    ) {
      throw new Error('Session task source project path must be absolute');
    }
    if (update.taskWorktree !== undefined && update.taskWorktree !== null) {
      const worktree = parseTaskWorktree(update.taskWorktree);
      if (
        !worktree ||
        worktree.sessionId !== sessionId ||
        ![
          worktree.repositoryRoot,
          worktree.originalWorkspaceRoot,
          worktree.worktreeRoot,
          worktree.workspaceRoot,
        ].every((candidate) => path.isAbsolute(candidate))
      ) {
        throw new Error('Invalid session task worktree metadata');
      }
    }
    if (
      update.taskDiffStat !== undefined &&
      update.taskDiffStat !== null &&
      !parseTaskDiffStat(update.taskDiffStat)
    ) {
      throw new Error('Invalid session task diff stat');
    }
    if (
      update.taskQueuePosition !== undefined &&
      update.taskQueuePosition !== null &&
      (!Number.isInteger(update.taskQueuePosition) || update.taskQueuePosition < 1)
    ) {
      throw new Error('Invalid session task queue position');
    }
    if (
      update.taskQueueDepth !== undefined &&
      update.taskQueueDepth !== null &&
      (!Number.isInteger(update.taskQueueDepth) || update.taskQueueDepth < 0)
    ) {
      throw new Error('Invalid session task queue depth');
    }
    if (
      update.taskConcurrencyLimit !== undefined &&
      update.taskConcurrencyLimit !== null &&
      (!Number.isInteger(update.taskConcurrencyLimit) ||
        update.taskConcurrencyLimit < 1)
    ) {
      throw new Error('Invalid session task concurrency limit');
    }
    if (
      typeof update.taskQueuePosition === 'number' &&
      typeof update.taskQueueDepth === 'number' &&
      update.taskQueuePosition > update.taskQueueDepth
    ) {
      throw new Error('Session task queue position exceeds queue depth');
    }
  }

  static async createSessionMetadata(
    sessionId: string,
    projectPath: string,
    initial: Pick<
      SessionMetadataUpdate,
      | 'title'
      | 'taskStatus'
      | 'taskPromptSummary'
      | 'taskPriority'
      | 'taskKind'
      | 'taskDueAt'
      | 'taskDispatch'
      | 'taskModelId'
      | 'taskRetriedFrom'
      | 'taskIsolation'
      | 'taskSourceProjectPath'
      | 'taskWorktree'
      | 'selectedModelId'
      | 'permissionMode'
      | 'reasoningEffort'
      | 'serviceTier'
      | 'responseVerbosity'
      | 'communicationStyle'
      | 'communicationStyleDigest'
      | 'projectInstructionsDigest'
    > = {}
  ): Promise<SessionMetadata> {
    assertValidSessionId(sessionId);
    SessionService.validateTaskMetadataUpdate(initial, sessionId);
    const resolvedProjectPath = SessionService.resolveCatalogWorkspace(projectPath);
    if (
      initial.taskWorktree &&
      path.resolve(initial.taskWorktree.workspaceRoot) !== resolvedProjectPath
    ) {
      throw new Error('Session task worktree must match the catalog workspace');
    }
    const now = new Date().toISOString();
    const entry: Extract<SessionEvent, { type: 'session_created' }> = {
      id: nanoid(),
      sessionId,
      timestamp: now,
      type: 'session_created',
      cwd: resolvedProjectPath,
      gitBranch: detectGitBranch(resolvedProjectPath),
      version: getVersion(),
      data: {
        sessionId,
        rootId: sessionId,
        ...(initial.title !== undefined ? { title: initial.title } : {}),
        taskStatus: initial.taskStatus ?? 'queued',
        ...(initial.taskPromptSummary !== undefined
          ? { taskPromptSummary: initial.taskPromptSummary }
          : {}),
        ...(initial.taskPriority !== undefined
          ? { taskPriority: initial.taskPriority }
          : {}),
        ...(initial.taskKind !== undefined ? { taskKind: initial.taskKind } : {}),
        ...(typeof initial.taskDueAt === 'string'
          ? { taskDueAt: new Date(initial.taskDueAt).toISOString() }
          : {}),
        ...(initial.taskDispatch !== undefined
          ? { taskDispatch: initial.taskDispatch }
          : {}),
        ...(initial.taskModelId !== undefined
          ? { taskModelId: initial.taskModelId }
          : {}),
        ...(initial.taskRetriedFrom !== undefined
          ? { taskRetriedFrom: initial.taskRetriedFrom }
          : {}),
        ...(initial.taskIsolation !== undefined
          ? { taskIsolation: initial.taskIsolation }
          : {}),
        ...(initial.taskSourceProjectPath !== undefined
          ? { taskSourceProjectPath: initial.taskSourceProjectPath }
          : {}),
        ...(initial.taskWorktree !== undefined
          ? { taskWorktree: initial.taskWorktree }
          : {}),
        ...(initial.selectedModelId !== undefined
          ? { selectedModelId: initial.selectedModelId }
          : {}),
        ...(initial.permissionMode !== undefined
          ? { permissionMode: initial.permissionMode }
          : {}),
        ...(initial.reasoningEffort !== undefined
          ? { reasoningEffort: initial.reasoningEffort }
          : {}),
        ...(initial.serviceTier !== undefined
          ? { serviceTier: initial.serviceTier }
          : {}),
        ...(initial.responseVerbosity !== undefined
          ? { responseVerbosity: initial.responseVerbosity }
          : {}),
        ...(initial.communicationStyle !== undefined
          ? { communicationStyle: initial.communicationStyle }
          : {}),
        ...(initial.communicationStyleDigest !== undefined
          ? { communicationStyleDigest: initial.communicationStyleDigest }
          : {}),
        ...(initial.projectInstructionsDigest !== undefined
          ? { projectInstructionsDigest: initial.projectInstructionsDigest }
          : {}),
        createdAt: now,
        updatedAt: now,
      },
    };
    const filePath = SessionService.getSessionFilePath(resolvedProjectPath, sessionId);
    await new JSONLStore(filePath).createExclusive([entry]);
    return SessionService.toPublicMetadata(
      SessionService.projectMetadataFromEntries(
        [entry],
        sessionId,
        resolvedProjectPath,
        filePath
      )
    );
  }

  static async assertSessionWritable(
    sessionId: string,
    projectPath: string
  ): Promise<SessionMetadata> {
    const metadata = await this.findSessionMetadata(sessionId, projectPath);
    if (!metadata) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (metadata.archivedAt) {
      throw new SessionArchivedError(
        sessionId,
        metadata.archivedBySessionId ?? sessionId
      );
    }
    return metadata;
  }

  private static async findArchivedAncestor(
    parentSessionId: string,
    projectPath: string
  ): Promise<{ sessionId: string; archivedAt: string } | undefined> {
    const visited = new Set<string>();
    let currentSessionId: string | undefined = parentSessionId;
    while (currentSessionId) {
      if (visited.has(currentSessionId)) {
        throw new Error('Session lineage contains a cycle');
      }
      visited.add(currentSessionId);
      assertValidSessionId(currentSessionId);
      const filePath = getSessionFilePath(projectPath, currentSessionId);
      let content: string;
      try {
        content = await readFile(filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      const ancestor = this.projectMetadataFromEntries(
        this.parseStoredSession(content, currentSessionId),
        currentSessionId,
        projectPath,
        filePath
      );
      if (ancestor.projectPath !== projectPath) {
        throw new Error('Session lineage escapes the requested workspace');
      }
      if (ancestor.archivedAt) {
        return {
          sessionId: ancestor.sessionId,
          archivedAt: ancestor.archivedAt,
        };
      }
      currentSessionId = ancestor.parentId;
    }
    return undefined;
  }

  static async listSessionArchiveMembers(
    sessionId: string,
    projectPath: string
  ): Promise<SessionMetadata[]> {
    assertValidSessionId(sessionId);
    const resolvedProjectPath = this.resolveCatalogWorkspace(projectPath);
    const sessions = await this.scanStoredSessions(resolvedProjectPath, true, 0, null);
    if (!sessions.some((session) => session.sessionId === sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const memberIds = new Set([sessionId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const session of sessions) {
        if (
          session.parentId &&
          memberIds.has(session.parentId) &&
          !memberIds.has(session.sessionId)
        ) {
          memberIds.add(session.sessionId);
          changed = true;
        }
      }
    }

    return sessions
      .filter((session) => memberIds.has(session.sessionId))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
      .map((session) => this.toPublicMetadata(session));
  }

  static async archiveSession(
    sessionId: string,
    projectPath: string
  ): Promise<SessionMetadata> {
    assertValidSessionId(sessionId);
    const resolvedProjectPath = this.resolveCatalogWorkspace(projectPath);
    const current = await this.findSessionMetadata(sessionId, resolvedProjectPath);
    if (!current) throw new Error(`Session not found: ${sessionId}`);
    if (current.archivedAt) return current;

    const members = await this.listSessionArchiveMembers(
      sessionId,
      resolvedProjectPath
    );
    const activeMember = members.find(
      (member) => member.taskStatus === 'queued' || member.taskStatus === 'running'
    );
    if (activeMember) {
      throw new SessionArchiveConflictError(
        `Stop session ${activeMember.sessionId} before archiving this session tree`
      );
    }

    const leases: SessionLease[] = [];
    try {
      for (const member of members) {
        leases.push(await SessionLease.acquire(member.sessionId, resolvedProjectPath));
      }

      const filePath = getSessionFilePath(resolvedProjectPath, sessionId);
      const store = new JSONLStore(filePath);
      let persistedEntries: SessionEvent[] = [];
      await store.appendValidated((entries) => {
        const stored = this.projectMetadataFromEntries(
          entries,
          sessionId,
          resolvedProjectPath,
          filePath
        );
        if (stored.archivedAt) {
          throw new SessionArchiveConflictError(
            `Session archive state changed concurrently: ${sessionId}`
          );
        }
        if (stored.taskStatus === 'queued' || stored.taskStatus === 'running') {
          throw new SessionArchiveConflictError(
            `Stop session ${sessionId} before archiving it`
          );
        }
        const now = new Date().toISOString();
        const next: Extract<SessionEvent, { type: 'session_updated' }> = {
          id: nanoid(),
          sessionId,
          timestamp: now,
          type: 'session_updated',
          cwd: resolvedProjectPath,
          gitBranch: detectGitBranch(resolvedProjectPath),
          version: getVersion(),
          data: {
            sessionId,
            archivedAt: now,
            updatedAt: now,
          },
        };
        persistedEntries = [...entries, next];
        return next;
      });
      return this.toPublicMetadata({
        ...this.projectMetadataFromEntries(
          persistedEntries,
          sessionId,
          resolvedProjectPath,
          filePath
        ),
        archivedBySessionId: sessionId,
      });
    } catch (error) {
      if (error instanceof SessionArchiveConflictError) throw error;
      if (error instanceof SessionInUseError) {
        throw new SessionArchiveConflictError(error.message);
      }
      throw this.sanitizeStoredSessionError(error, sessionId);
    } finally {
      for (const lease of leases.reverse()) {
        await lease.release();
      }
    }
  }

  static async unarchiveSession(
    sessionId: string,
    projectPath: string
  ): Promise<SessionMetadata> {
    assertValidSessionId(sessionId);
    const resolvedProjectPath = this.resolveCatalogWorkspace(projectPath);
    const current = await this.findSessionMetadata(sessionId, resolvedProjectPath);
    if (!current) throw new Error(`Session not found: ${sessionId}`);
    if (!current.archivedAt) return current;
    if (current.archivedBySessionId && current.archivedBySessionId !== sessionId) {
      throw new SessionArchiveConflictError(
        `Unarchive ancestor ${current.archivedBySessionId} to restore session ${sessionId}`
      );
    }

    let lease: SessionLease | undefined;
    try {
      lease = await SessionLease.acquire(sessionId, resolvedProjectPath);
      const filePath = getSessionFilePath(resolvedProjectPath, sessionId);
      const store = new JSONLStore(filePath);
      let persistedEntries: SessionEvent[] = [];
      await store.appendValidated((entries) => {
        const stored = this.projectMetadataFromEntries(
          entries,
          sessionId,
          resolvedProjectPath,
          filePath
        );
        if (!stored.archivedAt) {
          throw new SessionArchiveConflictError(
            `Session archive state changed concurrently: ${sessionId}`
          );
        }
        const now = new Date().toISOString();
        const next: Extract<SessionEvent, { type: 'session_updated' }> = {
          id: nanoid(),
          sessionId,
          timestamp: now,
          type: 'session_updated',
          cwd: resolvedProjectPath,
          gitBranch: detectGitBranch(resolvedProjectPath),
          version: getVersion(),
          data: {
            sessionId,
            archivedAt: null,
            updatedAt: now,
          },
        };
        persistedEntries = [...entries, next];
        return next;
      });
      return this.toPublicMetadata(
        this.projectMetadataFromEntries(
          persistedEntries,
          sessionId,
          resolvedProjectPath,
          filePath
        )
      );
    } catch (error) {
      if (error instanceof SessionArchiveConflictError) throw error;
      if (error instanceof SessionInUseError) {
        throw new SessionArchiveConflictError(error.message);
      }
      throw this.sanitizeStoredSessionError(error, sessionId);
    } finally {
      await lease?.release();
    }
  }

  static async updateSessionMetadata(
    sessionId: string,
    projectPath: string,
    update: SessionMetadataUpdate
  ): Promise<SessionMetadata> {
    assertValidSessionId(sessionId);
    SessionService.validateTaskMetadataUpdate(update, sessionId);
    if (
      update.taskStatus !== undefined &&
      !SESSION_TASK_STATUSES.has(update.taskStatus)
    ) {
      throw new Error(`Invalid session task status: ${String(update.taskStatus)}`);
    }
    if (
      update.taskOwnerPid !== undefined &&
      update.taskOwnerPid !== null &&
      (!Number.isInteger(update.taskOwnerPid) || update.taskOwnerPid <= 0)
    ) {
      throw new Error('Session task owner PID must be a positive integer');
    }
    const resolvedProjectPath = SessionService.resolveCatalogWorkspace(projectPath);
    if (
      update.taskWorktree &&
      path.resolve(update.taskWorktree.workspaceRoot) !== resolvedProjectPath
    ) {
      throw new Error('Session task worktree must match the catalog workspace');
    }
    const filePath = SessionService.getSessionFilePath(resolvedProjectPath, sessionId);
    const store = new JSONLStore(filePath);
    let persistedEntries: SessionEvent[] = [];

    try {
      await store.appendValidatedAsync(async (entries) => {
        const created = SessionService.getSessionCreatedEntry(entries, sessionId);
        if (created.data.sessionId !== sessionId) {
          throw new Error(
            `Session metadata creation record sessionId mismatch: ${sessionId}`
          );
        }
        if (
          !path.isAbsolute(created.cwd) ||
          path.resolve(created.cwd) !== resolvedProjectPath
        ) {
          throw new Error(
            `Session metadata creation record cwd mismatch: ${sessionId}`
          );
        }
        const stored = SessionService.projectMetadataFromEntries(
          entries,
          sessionId,
          resolvedProjectPath,
          filePath
        );
        if (stored.archivedAt) {
          throw new SessionArchivedError(sessionId, sessionId);
        }
        if (stored.parentId) {
          const ancestor = await SessionService.findArchivedAncestor(
            stored.parentId,
            resolvedProjectPath
          );
          if (ancestor) {
            throw new SessionArchivedError(sessionId, ancestor.sessionId);
          }
        }
        const now = new Date().toISOString();
        const next: Extract<SessionEvent, { type: 'session_updated' }> = {
          id: nanoid(),
          sessionId,
          timestamp: now,
          type: 'session_updated',
          cwd: resolvedProjectPath,
          gitBranch: detectGitBranch(resolvedProjectPath),
          version: getVersion(),
          data: {
            sessionId,
            ...(update.title !== undefined ? { title: update.title } : {}),
            ...(update.taskStatus !== undefined
              ? { taskStatus: update.taskStatus }
              : {}),
            ...(update.taskStatusReason !== undefined
              ? { taskStatusReason: update.taskStatusReason }
              : {}),
            ...(update.taskFailure !== undefined
              ? { taskFailure: update.taskFailure }
              : {}),
            ...(update.taskStartedAt !== undefined
              ? { taskStartedAt: update.taskStartedAt }
              : {}),
            ...(update.taskCompletedAt !== undefined
              ? { taskCompletedAt: update.taskCompletedAt }
              : {}),
            ...(update.taskOwnerPid !== undefined
              ? { taskOwnerPid: update.taskOwnerPid }
              : {}),
            ...(update.taskPromptSummary !== undefined
              ? { taskPromptSummary: update.taskPromptSummary }
              : {}),
            ...(update.taskPriority !== undefined
              ? { taskPriority: update.taskPriority }
              : {}),
            ...(update.taskKind !== undefined ? { taskKind: update.taskKind } : {}),
            ...(update.taskDueAt !== undefined
              ? {
                  taskDueAt:
                    update.taskDueAt === null
                      ? null
                      : new Date(update.taskDueAt).toISOString(),
                }
              : {}),
            ...(update.taskDispatch !== undefined
              ? { taskDispatch: update.taskDispatch }
              : {}),
            ...(update.taskModelId !== undefined
              ? { taskModelId: update.taskModelId }
              : {}),
            ...(update.taskRetriedFrom !== undefined
              ? { taskRetriedFrom: update.taskRetriedFrom }
              : {}),
            ...(update.taskDelivery !== undefined
              ? { taskDelivery: update.taskDelivery }
              : {}),
            ...(update.taskIsolation !== undefined
              ? { taskIsolation: update.taskIsolation }
              : {}),
            ...(update.taskSourceProjectPath !== undefined
              ? { taskSourceProjectPath: update.taskSourceProjectPath }
              : {}),
            ...(update.taskWorktree !== undefined
              ? { taskWorktree: update.taskWorktree }
              : {}),
            ...(update.taskDiffStat !== undefined
              ? { taskDiffStat: update.taskDiffStat }
              : {}),
            ...(update.taskQueuePosition !== undefined
              ? { taskQueuePosition: update.taskQueuePosition }
              : {}),
            ...(update.taskQueueDepth !== undefined
              ? { taskQueueDepth: update.taskQueueDepth }
              : {}),
            ...(update.taskConcurrencyLimit !== undefined
              ? { taskConcurrencyLimit: update.taskConcurrencyLimit }
              : {}),
            ...(update.selectedModelId !== undefined
              ? { selectedModelId: update.selectedModelId }
              : {}),
            ...(update.permissionMode !== undefined
              ? { permissionMode: update.permissionMode }
              : {}),
            ...(update.reasoningEffort !== undefined
              ? { reasoningEffort: update.reasoningEffort }
              : {}),
            ...(update.serviceTier !== undefined
              ? { serviceTier: update.serviceTier }
              : {}),
            ...(update.responseVerbosity !== undefined
              ? { responseVerbosity: update.responseVerbosity }
              : {}),
            ...(update.communicationStyle !== undefined
              ? { communicationStyle: update.communicationStyle }
              : {}),
            ...(update.communicationStyleDigest !== undefined
              ? { communicationStyleDigest: update.communicationStyleDigest }
              : {}),
            ...(update.projectInstructionsDigest !== undefined
              ? { projectInstructionsDigest: update.projectInstructionsDigest }
              : {}),
            updatedAt: now,
          },
        };
        persistedEntries = [...entries, next];
        return next;
      });
    } catch (error) {
      throw SessionService.sanitizeStoredSessionError(error, sessionId);
    }

    return SessionService.toPublicMetadata(
      SessionService.projectMetadataFromEntries(
        persistedEntries,
        sessionId,
        resolvedProjectPath,
        filePath
      )
    );
  }

  static async setSessionPermissionMode(
    sessionId: string,
    projectPath: string,
    permissionMode: SessionPermissionMode
  ): Promise<SessionMetadata> {
    assertValidSessionId(sessionId);
    if (!isSessionPermissionMode(permissionMode)) {
      throw new Error('Invalid session permission mode');
    }
    const resolvedProjectPath = SessionService.resolveCatalogWorkspace(projectPath);
    const current = await SessionService.findSessionMetadata(
      sessionId,
      resolvedProjectPath
    );
    if (current?.permissionMode === permissionMode) {
      return current;
    }
    if (current) {
      return SessionService.updateSessionMetadata(sessionId, resolvedProjectPath, {
        permissionMode,
      });
    }
    try {
      return await SessionService.createSessionMetadata(
        sessionId,
        resolvedProjectPath,
        {
          taskStatus: 'completed',
          permissionMode,
        }
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      return SessionService.updateSessionMetadata(sessionId, resolvedProjectPath, {
        permissionMode,
      });
    }
  }

  static async findSessionTaskWorktree(
    sessionId: string,
    projectPath: string
  ): Promise<SessionTaskWorktree | undefined> {
    assertValidSessionId(sessionId);
    const resolvedProjectPath = SessionService.resolveCatalogWorkspace(projectPath);
    const filePath = SessionService.getSessionFilePath(resolvedProjectPath, sessionId);
    try {
      return (
        await SessionService.readStoredSessionMetadata(
          filePath,
          sessionId,
          resolvedProjectPath
        )
      ).taskWorktree;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw SessionService.sanitizeStoredSessionError(error, sessionId);
    }
  }

  static async findSessionTaskDispatch(
    sessionId: string,
    projectPath: string
  ): Promise<SessionTaskDispatch | undefined> {
    assertValidSessionId(sessionId);
    const resolvedProjectPath = SessionService.resolveCatalogWorkspace(projectPath);
    const filePath = SessionService.getSessionFilePath(resolvedProjectPath, sessionId);
    try {
      return (
        await SessionService.readStoredSessionMetadata(
          filePath,
          sessionId,
          resolvedProjectPath
        )
      ).taskDispatch;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw SessionService.sanitizeStoredSessionError(error, sessionId);
    }
  }

  /**
   * 从 JSONL 文件加载并转换消息
   */
  private static async loadSessionFromFile(
    filePath: string,
    sessionId: string,
    projectPath?: string
  ): Promise<Message[]> {
    const content = await readFile(filePath, 'utf-8');
    const entries = this.parseStoredSession(content, sessionId);
    if (projectPath !== undefined) {
      const stored = this.projectMetadataFromEntries(
        entries,
        sessionId,
        projectPath,
        filePath
      );
      if (stored.projectPath !== projectPath) {
        throw new Error(`未找到会话: ${sessionId}`);
      }
    }
    return this.convertJSONLToMessages(entries);
  }

  private static async loadSessionModelContextFromFile(
    filePath: string,
    sessionId: string,
    projectPath?: string
  ): Promise<Message[]> {
    const content = await readFile(filePath, 'utf-8');
    const entries = this.parseStoredSession(content, sessionId);
    if (projectPath !== undefined) {
      const stored = this.projectMetadataFromEntries(
        entries,
        sessionId,
        projectPath,
        filePath
      );
      if (stored.projectPath !== projectPath) {
        throw new Error(`未找到会话: ${sessionId}`);
      }
    }
    return this.convertJSONLToModelContext(entries);
  }

  static convertJSONLToModelContext(entries: SessionEvent[]): Message[] {
    const materialized = materializeSessionEvents(entries);
    let checkpointIndex = -1;
    let replacementMessages: Message[] | undefined;

    for (let index = 0; index < materialized.length; index++) {
      const entry = materialized[index];
      if (entry?.type !== 'part_created' || entry.data.partType !== 'summary') {
        continue;
      }
      const payload = entry.data.payload as {
        text?: string;
        replacementMessages?: unknown;
      };
      checkpointIndex = index;
      replacementMessages = parseCompactionReplacementMessages(
        payload.replacementMessages
      );
      if (!replacementMessages) {
        replacementMessages = [
          {
            role: 'user',
            content: payload.text ?? '',
            metadata: entry.data.payload as JsonValue,
          },
        ];
      }
    }

    if (checkpointIndex < 0 || !replacementMessages) {
      return this.convertJSONLToMessages(materialized, {
        includeTokenBudgetHandoffs: true,
      });
    }

    const suffix = this.convertJSONLToMessages(
      materialized.slice(checkpointIndex + 1),
      {
        includeTokenBudgetHandoffs: true,
      }
    );
    return [...replacementMessages, ...suffix];
  }

  /**
   * 将 JSONL 条目转换为 OpenAI Message 格式
   */
  static convertJSONLToMessages(
    entries: SessionEvent[],
    options: { includeTokenBudgetHandoffs?: boolean } = {}
  ): Message[] {
    const messages: Message[] = [];
    const messageMap = new Map<string, Message>();
    const partMap = new Map<string, ContentPart[]>();
    const recoveredToolAssistants = new Map<string, Message>();
    const toolCallIdByPartId = new Map<string, string>();
    const assistantMessageByToolCallId = new Map<string, Message>();
    const materialized = materializeSessionEvents(entries);
    const currentTokenBudgetHandoff = options.includeTokenBudgetHandoffs
      ? findCurrentTokenBudgetHandoff(materialized)
      : { kind: 'none' as const };
    const materializedReviewIds = new Set<string>();
    for (const entry of materialized) {
      if (entry.type === 'token_budget_handoff_recorded') {
        if (
          currentTokenBudgetHandoff.kind === 'valid' &&
          currentTokenBudgetHandoff.event.id === entry.id
        ) {
          const handoffMessage = projectTokenBudgetHandoffEvent(entry);
          if (handoffMessage) {
            messages.push(handoffMessage);
          }
        }
        continue;
      }
      if (entry.type === 'message_created') {
        const messageMetadata =
          entry.data.metadata &&
          typeof entry.data.metadata === 'object' &&
          !Array.isArray(entry.data.metadata)
            ? entry.data.metadata
            : undefined;
        const codeReview =
          messageMetadata?.codeReview &&
          typeof messageMetadata.codeReview === 'object' &&
          !Array.isArray(messageMetadata.codeReview)
            ? messageMetadata.codeReview
            : undefined;
        if (
          codeReview?.phase === 'completed' &&
          typeof codeReview.reviewId === 'string'
        ) {
          materializedReviewIds.add(codeReview.reviewId);
        }
        const recoveredAssistant =
          entry.data.role === 'assistant' && entry.data.parentMessageId
            ? recoveredToolAssistants.get(entry.data.parentMessageId)
            : undefined;
        const message: Message = recoveredAssistant ?? {
          role: entry.data.role,
          content: '',
          ...(entry.data.metadata || entry.data.inboxMessageId
            ? {
                metadata: {
                  ...(entry.data.metadata &&
                  typeof entry.data.metadata === 'object' &&
                  !Array.isArray(entry.data.metadata)
                    ? entry.data.metadata
                    : {}),
                  ...(entry.data.inboxMessageId
                    ? { inboxMessageId: entry.data.inboxMessageId }
                    : {}),
                },
              }
            : {}),
        };
        messageMap.set(entry.data.messageId, message);
        partMap.set(entry.data.messageId, []);
        if (!recoveredAssistant) {
          messages.push(message);
        }
      }
      if (entry.type === 'part_created') {
        if (entry.data.partType === 'reasoning') {
          const message = messageMap.get(entry.data.messageId);
          if (message) {
            const payload = entry.data.payload as { text?: string };
            message.reasoningContent =
              (message.reasoningContent ?? '') + (payload.text ?? '');
          }
        }
        if (entry.data.partType === 'text') {
          const message = messageMap.get(entry.data.messageId);
          if (message) {
            const payload = entry.data.payload as { text?: string };
            const parts = partMap.get(entry.data.messageId);
            if (parts) {
              parts.push({ type: 'text', text: payload.text ?? '' });
              message.content = toMessageContent(parts);
            } else {
              message.content = payload.text ?? '';
            }
          }
        }
        if (entry.data.partType === 'image') {
          const message = messageMap.get(entry.data.messageId);
          if (message) {
            const payload = entry.data.payload as { dataUrl?: string };
            const parts = partMap.get(entry.data.messageId);
            if (parts && payload.dataUrl) {
              parts.push({ type: 'image_url', image_url: { url: payload.dataUrl } });
              message.content = toMessageContent(parts);
            }
          }
        }
        if (entry.data.partType === 'tool_call') {
          let message = messageMap.get(entry.data.messageId);
          if (message?.role !== 'assistant') {
            message = recoveredToolAssistants.get(entry.data.messageId);
            if (!message) {
              message = { role: 'assistant', content: '', tool_calls: [] };
              recoveredToolAssistants.set(entry.data.messageId, message);
              messages.push(message);
            }
          }
          if (message.role === 'assistant') {
            const payload = entry.data.payload as {
              toolCallId?: string;
              toolName?: string;
              input?: JsonValue;
            };
            const toolCallId = payload.toolCallId ?? entry.data.partId;
            toolCallIdByPartId.set(entry.data.partId, toolCallId);
            assistantMessageByToolCallId.set(toolCallId, message);
            message.tool_calls ??= [];
            message.tool_calls.push({
              id: toolCallId,
              type: 'function',
              function: {
                name: payload.toolName ?? 'unknown',
                arguments: JSON.stringify(payload.input ?? {}),
              },
            });
          }
        }
        if (entry.data.partType === 'tool_result') {
          const payload = entry.data.payload as {
            toolCallId?: string;
            toolName?: string;
            output?: unknown;
            error?: unknown;
            metadata?: unknown;
          };
          const restored = projectDurableToolResult(payload);
          const content = restored.error
            ? `Error: ${restored.error.message}`
            : typeof restored.llmContent === 'string'
              ? restored.llmContent
              : JSON.stringify(restored.llmContent);
          const metadata = payload as unknown as JsonValue;
          messages.push({
            role: 'tool',
            content,
            tool_call_id:
              toolCallIdByPartId.get(entry.data.messageId) ?? payload.toolCallId,
            name: payload.toolName,
            metadata,
          });
        }
        if (entry.data.partType === 'summary') {
          const payload = entry.data.payload as { text?: string };
          const metadata = entry.data.payload as unknown as JsonValue;
          messages.push({
            role: 'system',
            content: payload.text ?? '',
            metadata,
          });
        }
        if (entry.data.partType === 'subtask_ref') {
          const message =
            messageMap.get(entry.data.messageId) ??
            assistantMessageByToolCallId.get(entry.data.messageId);
          if (message) {
            const metadata = entry.data.payload as unknown as JsonValue;
            const base = (message.metadata ?? {}) as Record<string, JsonValue>;
            message.metadata = { ...base, subtaskRef: metadata } as JsonValue;
          }
        }
      }
    }

    for (const review of projectSessionReviews(materialized)) {
      if (
        review.completion === undefined ||
        materializedReviewIds.has(review.start.reviewId)
      ) {
        continue;
      }
      messages.push({
        role: 'assistant',
        content: renderCodeReview(review.start, review.completion),
        metadata: {
          codeReview: {
            ...codeReviewMessageMetadata(review.start, review.completion),
            synthetic: true,
          },
        },
      });
    }

    return messages;
  }

  /**
   * 元数据聚合器（注入投影层，复用 projectMetadataFromEntries 保证与 JSONL 逐条一致）。
   */
  private static projectionDeriver(): MetadataDeriver {
    return (entries, sessionId, projectPath) => {
      try {
        const filePath = getSessionFilePath(projectPath, sessionId);
        const stored = this.projectMetadataFromEntries(
          entries,
          sessionId,
          projectPath,
          filePath
        );
        return stored as unknown as ReturnType<MetadataDeriver>;
      } catch {
        return null;
      }
    };
  }

  /** 公开给 TranscriptSearch 的聚合器（同 projectionDeriver，避免跨模块重实现）。 */
  static projectionDeriverForSearch(): MetadataDeriver {
    return this.projectionDeriver();
  }

  /**
   * 从 SQLite 投影读取会话列表。返回 null 表示投影不可用（调用方回退 JSONL 扫描）。
   * 读取前先 syncAll（内部 mtime 门控，未变近乎零成本）保证与磁盘一致。
   */
  private static async scanStoredSessionsFromProjection(
    scopedProjectPath: string | undefined,
    includeSubagents: boolean,
    projectionSyncMaxAgeMs = 0,
    archived: boolean | null = false,
    taskFilters: NormalizedSessionTaskFilters = {}
  ): Promise<StoredSessionMetadata[] | null> {
    try {
      const db = await getProjectionDb();
      if (!db) return null;
      await syncAll(db, this.projectionDeriver(), projectionSyncMaxAgeMs);

      const conditions: string[] = [];
      const parameters: unknown[] = [];
      if (scopedProjectPath !== undefined) {
        conditions.push('project_path=?');
        parameters.push(scopedProjectPath);
      }
      appendTaskProjectionFilters(taskFilters, '', conditions, parameters);
      const whereClause =
        conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT metadata_json, is_subagent FROM sessions${whereClause}`)
        .all<{ metadata_json: string; is_subagent: number }>(...parameters);

      const sessions: StoredSessionMetadata[] = [];
      for (const row of rows) {
        if (!includeSubagents && row.is_subagent === 1) continue;
        try {
          const meta = JSON.parse(row.metadata_json) as StoredSessionMetadata;
          if (
            scopedProjectPath !== undefined &&
            meta.projectPath !== scopedProjectPath
          ) {
            continue;
          }
          sessions.push(meta);
        } catch {
          // 损坏行跳过；下次 syncAll 会重建。
        }
      }
      const reconciled = await Promise.all(
        sessions.map((session) => this.reconcileInterruptedTask(session))
      );
      return filterArchiveState(
        reconciled.filter((session) => matchesTaskStatusFilter(session, taskFilters)),
        archived
      );
    } catch {
      return null;
    }
  }

  private static async scanStoredSessions(
    cwd?: string,
    includeSubagents = false,
    projectionSyncMaxAgeMs = 0,
    archived: boolean | null = false,
    taskFilters: NormalizedSessionTaskFilters = {}
  ): Promise<StoredSessionMetadata[]> {
    const scopedProjectPath = cwd ? path.resolve(cwd) : undefined;

    // Fast path: serve from the SQLite read-model projection. Fail-open — any
    // problem (db unavailable, native module missing) falls through to the
    // authoritative JSONL scan below, so SQLite stays an optional accelerator.
    const projected = await this.scanStoredSessionsFromProjection(
      scopedProjectPath,
      includeSubagents,
      projectionSyncMaxAgeMs,
      archived,
      taskFilters
    );
    if (projected) return projected;

    const projectDirs = scopedProjectPath
      ? [
          {
            storagePath: getProjectStoragePath(scopedProjectPath),
            projectPath: scopedProjectPath,
          },
        ]
      : await this.listAllProjectStorageDirectories();
    const sessions: StoredSessionMetadata[] = [];

    for (const project of projectDirs) {
      let files: string[];
      try {
        files = await readdir(project.storagePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        throw error;
      }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.slice(0, -'.jsonl'.length);
        const filePath = path.join(project.storagePath, file);
        try {
          const metadata = await this.readStoredSessionMetadata(
            filePath,
            sessionId,
            project.projectPath
          );
          if (
            scopedProjectPath !== undefined &&
            metadata.projectPath !== scopedProjectPath
          ) {
            logger.warn(
              `[SessionService] Skipping out-of-scope session transcript: ${sessionId}`
            );
            continue;
          }
          if (!includeSubagents && metadata.relationType === 'subagent') continue;
          if (!matchesTaskFilters(metadata, taskFilters)) continue;
          sessions.push(metadata);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') continue;
          if (code) throw error;
          logger.warn(
            `[SessionService] Skipping invalid session transcript: ${sessionId}`
          );
        }
      }
    }

    return filterArchiveState(sessions, archived);
  }

  private static async listAllProjectStorageDirectories(): Promise<
    Array<{ storagePath: string; projectPath: string }>
  > {
    const projectsDir = path.join(getBladeStorageRoot(), 'projects');
    let projectDirs: Array<{ name: string; isDirectory(): boolean }>;
    try {
      projectDirs = (await readdir(projectsDir, {
        withFileTypes: true,
        encoding: 'utf8',
      })) as Array<{ name: string; isDirectory(): boolean }>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    return projectDirs
      .filter((dir) => dir.isDirectory())
      .map((dir) => ({
        storagePath: path.join(projectsDir, dir.name),
        projectPath: unescapeProjectPath(dir.name),
      }));
  }

  private static async readStoredSessionMetadata(
    filePath: string,
    sessionId: string,
    projectPath: string
  ): Promise<StoredSessionMetadata> {
    const content = await readFile(filePath, 'utf-8');
    const entries = this.parseStoredSession(content, sessionId);
    return this.reconcileInterruptedTask(
      this.projectMetadataFromEntries(entries, sessionId, projectPath, filePath)
    );
  }

  private static async reconcileInterruptedTask(
    session: StoredSessionMetadata
  ): Promise<StoredSessionMetadata> {
    const ownerPid = session.taskOwnerPid;
    if (
      session.taskStatus !== 'running' ||
      ownerPid === undefined ||
      isProcessRunning(ownerPid)
    ) {
      return session;
    }

    let lease: SessionLease;
    try {
      lease = await SessionLease.acquire(session.sessionId, session.projectPath);
    } catch (error) {
      if (!(error instanceof SessionInUseError)) throw error;
      const content = await readFile(session.filePath, 'utf-8');
      return this.projectMetadataFromEntries(
        this.parseStoredSession(content, session.sessionId),
        session.sessionId,
        session.projectPath,
        session.filePath
      );
    }

    const store = new JSONLStore(session.filePath);
    let persistedEntries: readonly SessionEvent[] | undefined;
    try {
      try {
        await store.appendValidated((entries) => {
          const current = this.projectMetadataFromEntries(
            entries,
            session.sessionId,
            session.projectPath,
            session.filePath
          );
          if (
            current.taskStatus !== 'running' ||
            current.taskOwnerPid !== ownerPid ||
            isProcessRunning(ownerPid)
          ) {
            throw new SessionTaskReconciliationSkipped();
          }

          const now = new Date().toISOString();
          const next: Extract<SessionEvent, { type: 'session_updated' }> = {
            id: nanoid(),
            sessionId: session.sessionId,
            timestamp: now,
            type: 'session_updated',
            cwd: session.projectPath,
            gitBranch: detectGitBranch(session.projectPath),
            version: getVersion(),
            data: {
              sessionId: session.sessionId,
              taskStatus: 'interrupted',
              taskStatusReason: 'Task owner process exited before completion',
              taskCompletedAt: now,
              taskOwnerPid: null,
              taskQueuePosition: null,
              taskQueueDepth: null,
              updatedAt: now,
            },
          };
          persistedEntries = [...entries, next];
          return next;
        });
      } catch (error) {
        if (!(error instanceof SessionTaskReconciliationSkipped)) throw error;
      }

      if (!persistedEntries) {
        const content = await readFile(session.filePath, 'utf-8');
        persistedEntries = this.parseStoredSession(content, session.sessionId);
      }
      return this.projectMetadataFromEntries(
        persistedEntries,
        session.sessionId,
        session.projectPath,
        session.filePath
      );
    } finally {
      await lease.release();
    }
  }

  private static projectMetadataFromEntries(
    entries: readonly SessionEvent[],
    sessionId: string,
    projectPath: string,
    filePath: string
  ): StoredSessionMetadata {
    if (entries.length === 0) {
      throw new Error(`Empty session transcript: ${sessionId}`);
    }

    const created = this.getSessionCreatedEntry(entries, sessionId);

    const durable = entries.reduce(
      (state, entry) =>
        entry.type === 'session_updated' ? { ...state, ...entry.data } : state,
      { ...created.data }
    );
    const projected = materializeSessionEvents(entries);
    const pendingInteraction = toPendingInteraction(
      findPendingSessionInteraction(projected)
    );
    const reviews = projectSessionReviews(projected);
    const latestReview = reviews.at(-1);
    const latestReviewEventIndex = projected.findLastIndex(
      (entry) =>
        (entry.type === 'review_started' &&
          entry.data.reviewId === latestReview?.start.reviewId) ||
        (entry.type === 'review_completed' &&
          entry.data.reviewId === latestReview?.start.reviewId)
    );
    const latestTaskStatusEventIndex = projected.findLastIndex(
      (entry) =>
        (entry.type === 'session_created' || entry.type === 'session_updated') &&
        Object.hasOwn(entry.data, 'taskStatus')
    );
    const reviewOwnsTaskStatus =
      latestReview !== undefined && latestReviewEventIndex > latestTaskStatusEventIndex;
    const reviewTaskStatus: SessionTaskStatus | undefined = reviewOwnsTaskStatus
      ? latestReview.completion === undefined
        ? 'running'
        : latestReview.completion.status === 'completed' ||
            latestReview.completion.status === 'stale'
          ? 'completed'
          : latestReview.completion.status === 'aborted'
            ? 'cancelled'
            : latestReview.completion.status === 'interrupted'
              ? 'interrupted'
              : 'failed'
      : undefined;

    const messageCount = projected.filter(
      (entry) =>
        entry.type === 'message_created' &&
        ['user', 'assistant'].includes(entry.data.role)
    ).length;
    const hasErrors = projected.some(
      (entry) =>
        entry.type === 'part_created' &&
        entry.data.partType === 'tool_result' &&
        typeof (entry.data.payload as { error?: unknown }).error === 'string'
    );
    const storedTaskStatus = SESSION_TASK_STATUSES.has(
      durable.taskStatus as SessionTaskStatus
    )
      ? (durable.taskStatus as SessionTaskStatus)
      : undefined;
    const taskStatus =
      reviewTaskStatus ?? storedTaskStatus ?? (hasErrors ? 'failed' : 'completed');
    const taskOwnerPid =
      typeof durable.taskOwnerPid === 'number' &&
      Number.isInteger(durable.taskOwnerPid) &&
      durable.taskOwnerPid > 0
        ? durable.taskOwnerPid
        : undefined;
    const taskIsolation = SESSION_TASK_ISOLATION.has(
      durable.taskIsolation as SessionTaskIsolation
    )
      ? (durable.taskIsolation as SessionTaskIsolation)
      : undefined;
    const taskSourceProjectPath =
      typeof durable.taskSourceProjectPath === 'string' &&
      path.isAbsolute(durable.taskSourceProjectPath)
        ? path.resolve(durable.taskSourceProjectPath)
        : undefined;
    const committedProjectPath = created.cwd;
    if (committedProjectPath !== undefined && !path.isAbsolute(committedProjectPath)) {
      throw new Error(`Session catalog cwd must be absolute: ${sessionId}`);
    }
    const resolvedProjectPath =
      committedProjectPath === undefined
        ? projectPath
        : path.resolve(committedProjectPath);
    const parsedTaskWorktree = parseTaskWorktree(durable.taskWorktree);
    const taskWorktree =
      parsedTaskWorktree?.sessionId === sessionId &&
      path.resolve(parsedTaskWorktree.workspaceRoot) === resolvedProjectPath
        ? parsedTaskWorktree
        : undefined;
    const taskDiffStat = parseTaskDiffStat(durable.taskDiffStat);
    const taskDispatch = parseTaskDispatch(durable.taskDispatch);
    const taskPriority = SESSION_TASK_PRIORITIES.has(
      durable.taskPriority as SessionTaskPriority
    )
      ? (durable.taskPriority as SessionTaskPriority)
      : taskDispatch?.taskPriority;
    const taskKind = SESSION_TASK_KINDS.has(durable.taskKind as SessionTaskKind)
      ? (durable.taskKind as SessionTaskKind)
      : taskDispatch?.taskKind;
    const taskDueAt =
      typeof durable.taskDueAt === 'string' &&
      Number.isFinite(Date.parse(durable.taskDueAt))
        ? new Date(durable.taskDueAt).toISOString()
        : taskDispatch?.taskDueAt;
    const taskModelId =
      typeof durable.taskModelId === 'string' && durable.taskModelId.trim()
        ? durable.taskModelId
        : taskDispatch?.modelId;
    const selectedModelId =
      typeof durable.selectedModelId === 'string' && durable.selectedModelId.trim()
        ? durable.selectedModelId
        : taskModelId;
    const permissionMode = isSessionPermissionMode(durable.permissionMode)
      ? durable.permissionMode
      : taskDispatch?.permissionMode;
    const reasoningEffort = isReasoningEffortSelection(durable.reasoningEffort)
      ? durable.reasoningEffort
      : taskDispatch?.reasoningEffort;
    const serviceTier = isServiceTierSelection(durable.serviceTier)
      ? durable.serviceTier
      : taskDispatch?.serviceTier;
    const responseVerbosity = isResponseVerbositySelection(durable.responseVerbosity)
      ? durable.responseVerbosity
      : taskDispatch?.responseVerbosity;
    const communicationStyle = isCommunicationStyleSelection(durable.communicationStyle)
      ? durable.communicationStyle
      : taskDispatch?.communicationStyle;
    const communicationStyleDigest = Object.hasOwn(durable, 'communicationStyleDigest')
      ? typeof durable.communicationStyleDigest === 'string' &&
        /^[a-f0-9]{64}$/.test(durable.communicationStyleDigest)
        ? durable.communicationStyleDigest
        : undefined
      : communicationStyle === taskDispatch?.communicationStyle
        ? taskDispatch?.communicationStyleDigest
        : undefined;
    const projectInstructionsDigest = Object.hasOwn(
      durable,
      'projectInstructionsDigest'
    )
      ? typeof durable.projectInstructionsDigest === 'string' &&
        /^[a-f0-9]{64}$/.test(durable.projectInstructionsDigest)
        ? durable.projectInstructionsDigest
        : undefined
      : taskDispatch?.projectInstructionsDigest;
    const archivedAt = isValidArchiveTimestamp(durable.archivedAt)
      ? durable.archivedAt
      : undefined;
    const taskRetriedFrom = parseTaskRetryRef(durable.taskRetriedFrom);
    const taskDelivery = parseTaskDelivery(durable.taskDelivery);
    const taskQueuePosition =
      typeof durable.taskQueuePosition === 'number' &&
      Number.isInteger(durable.taskQueuePosition) &&
      durable.taskQueuePosition > 0
        ? durable.taskQueuePosition
        : undefined;
    const taskQueueDepth =
      typeof durable.taskQueueDepth === 'number' &&
      Number.isInteger(durable.taskQueueDepth) &&
      durable.taskQueueDepth >= 0
        ? durable.taskQueueDepth
        : undefined;
    const taskConcurrencyLimit =
      typeof durable.taskConcurrencyLimit === 'number' &&
      Number.isInteger(durable.taskConcurrencyLimit) &&
      durable.taskConcurrencyLimit > 0
        ? durable.taskConcurrencyLimit
        : undefined;
    const reviewTaskReason = reviewOwnsTaskStatus
      ? latestReview?.completion
        ? latestReview.completion.status === 'completed'
          ? undefined
          : `Code review ${renderReviewStatus(latestReview.completion.status)}`
        : `Reviewing ${latestReview?.start.target.label ?? 'changes'}`
      : undefined;
    const taskFailure = reviewOwnsTaskStatus
      ? taskStatus === 'failed' && reviewTaskReason
        ? toTaskFailure(reviewTaskReason)
        : undefined
      : isSessionTaskFailure(durable.taskFailure)
        ? durable.taskFailure
        : taskStatus === 'failed' && typeof durable.taskStatusReason === 'string'
          ? toTaskFailure(durable.taskStatusReason)
          : undefined;

    return {
      sessionId,
      projectPath: resolvedProjectPath,
      gitBranch: created.gitBranch,
      rootId: durable.rootId || sessionId,
      parentId: durable.parentId,
      relationType: durable.relationType,
      resumedFrom: durable.resumedFrom,
      rootAgentId: durable.rootAgentId,
      resumeDepth: durable.resumeDepth,
      title: durable.title,
      agentType: durable.agentType,
      model: durable.model,
      selectedModelId,
      permissionMode,
      reasoningEffort,
      serviceTier,
      responseVerbosity,
      communicationStyle,
      communicationStyleDigest,
      projectInstructionsDigest,
      pendingInteraction,
      taskStatus,
      taskStatusReason:
        taskFailure?.message ??
        reviewTaskReason ??
        (typeof durable.taskStatusReason === 'string'
          ? durable.taskStatusReason
          : undefined),
      taskFailure,
      taskStartedAt: reviewOwnsTaskStatus
        ? latestReview?.start.startedAt
        : typeof durable.taskStartedAt === 'string'
          ? durable.taskStartedAt
          : undefined,
      taskCompletedAt: reviewOwnsTaskStatus
        ? latestReview?.completion?.completedAt
        : typeof durable.taskCompletedAt === 'string'
          ? durable.taskCompletedAt
          : undefined,
      taskPromptSummary: reviewOwnsTaskStatus
        ? latestReview
          ? reviewPromptFromTarget(latestReview.start.target)
          : '/review uncommitted'
        : typeof durable.taskPromptSummary === 'string'
          ? durable.taskPromptSummary
          : undefined,
      taskPriority,
      taskKind,
      taskDueAt,
      taskModelId,
      taskRetryAvailable: taskDispatch !== undefined,
      taskRetriedFrom,
      taskDelivery,
      taskIsolation,
      taskSourceProjectPath,
      taskWorktreePath: taskWorktree?.worktreeRoot,
      taskWorktreeBranch: taskWorktree?.branch,
      taskBaseCommit: taskWorktree?.baseCommit,
      taskDiffStat,
      taskQueuePosition,
      taskQueueDepth,
      taskConcurrencyLimit,
      archivedAt,
      taskOwnerPid: reviewOwnsTaskStatus ? undefined : taskOwnerPid,
      taskWorktree,
      taskDispatch,
      messageCount,
      firstMessageTime: entries[0]!.timestamp,
      lastMessageTime: entries.at(-1)!.timestamp,
      hasErrors: hasErrors || taskStatus === 'failed',
      filePath,
    };
  }

  private static toPublicMetadata(session: StoredSessionMetadata): SessionMetadata {
    const {
      filePath: _filePath,
      taskOwnerPid: _taskOwnerPid,
      taskWorktree: _taskWorktree,
      taskDispatch: _taskDispatch,
      ...publicSession
    } = session;
    return publicSession;
  }

  /**
   * 获取会话文件路径
   */
  private static getSessionFilePath(projectPath: string, sessionId: string): string {
    return getSessionFilePath(projectPath, sessionId);
  }

  private static getSessionCreatedEntry(
    entries: readonly SessionEvent[],
    sessionId: string
  ): Extract<SessionEvent, { type: 'session_created' }> {
    const created = entries.find(
      (entry): entry is Extract<SessionEvent, { type: 'session_created' }> =>
        entry.type === 'session_created'
    );
    if (!created) throw new SessionMissingCreationError(sessionId);
    return created;
  }

  private static resolveCatalogWorkspace(projectPath: string): string {
    if (!path.isAbsolute(projectPath)) {
      throw new Error('Session catalog cwd must be absolute');
    }
    return path.resolve(projectPath);
  }

  private static validateSessionWorkspace(
    entries: readonly SessionEvent[],
    sessionId: string,
    projectPath: string
  ): void {
    const created = this.getSessionCreatedEntry(entries, sessionId);
    if (created.data.sessionId !== sessionId) {
      throw new Error(`Session creation record sessionId mismatch: ${sessionId}`);
    }
    if (!path.isAbsolute(created.cwd) || path.resolve(created.cwd) !== projectPath) {
      throw new Error(`Session creation record cwd mismatch: ${sessionId}`);
    }
  }

  private static resolveForkWorkspace(projectPath: string): string {
    if (!path.isAbsolute(projectPath)) {
      throw new Error('Fork workspace paths must be absolute');
    }
    return path.resolve(projectPath);
  }

  private static parseStoredSession(
    content: string,
    sessionId: string
  ): SessionEvent[] {
    return parseSessionJSONL(content, `session ${sessionId}`);
  }

  private static isCorruptSessionJSONLError(error: unknown): boolean {
    return error instanceof Error && error.message.startsWith('Invalid session JSONL ');
  }

  private static sanitizeStoredSessionError(
    error: unknown,
    sessionId: string
  ): unknown {
    if (!this.isCorruptSessionJSONLError(error) || !(error instanceof Error)) {
      return error;
    }
    const line = error.message.match(/ at line (\d+)$/)?.[1];
    return new Error(
      `Invalid session JSONL in session ${sessionId}${line ? ` at line ${line}` : ''}`,
      { cause: error.cause }
    );
  }

  private static async readStableSessionSnapshot(
    filePath: string,
    sessionId: string,
    maxAttempts = 3
  ): Promise<SessionEvent[]> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const before = await sessionSnapshotIO.stat(filePath);
      const content = await sessionSnapshotIO.readFile(filePath);
      const entries = this.parseStoredSession(content, sessionId);
      const after = await sessionSnapshotIO.stat(filePath);
      if (
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.dev === after.dev &&
        before.ino === after.ino
      ) {
        return entries;
      }
    }
    throw new Error('Session changed while creating fork; retry the operation');
  }
}

function toMessageContent(parts: ContentPart[]): Message['content'] {
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text;
  }
  return [...parts];
}

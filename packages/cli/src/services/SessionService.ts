/**
 * 会话管理服务
 * 负责加载和恢复历史会话
 */

import type { BigIntStats } from 'node:fs';
import { access, readdir, readFile, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import { JSONLStore, parseSessionJSONL } from '../context/storage/JSONLStore.js';
import {
  assertValidSessionId,
  detectGitBranch,
  getBladeStorageRoot,
  getProjectStoragePath,
  getSessionFilePath,
  getSessionGoalFilePath,
  unescapeProjectPath,
} from '../context/storage/pathUtils.js';
import type { SessionEvent } from '../context/types.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type { JsonValue, SessionMessage } from '../store/types.js';
import { getVersion } from '../utils/packageInfo.js';
import type { ContentPart, Message } from './ChatServiceInterface.js';
import {
  compareSessionCatalogItems,
  normalizeSessionListOptions,
  paginateSessionCatalog,
  type SessionListOptions,
} from './sessionCatalog.js';

const logger = createLogger(LogCategory.SERVICE);

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
  title?: string;
  agentType?: string;
  model?: string;
  messageCount: number;
  firstMessageTime: string;
  lastMessageTime: string;
  hasErrors: boolean;
}

interface StoredSessionMetadata extends SessionMetadata {
  filePath: string;
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
      if (msg.role !== 'user' && msg.role !== 'assistant') return;

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

      const previous = result[result.length - 1];
      if (
        previous &&
        previous.role === msg.role &&
        previous.content === normalizedContent
      ) {
        return;
      }

      result.push({
        id: `restored-${now}-${index}`,
        role: msg.role,
        content: normalizedContent,
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
    const stored = await this.scanStoredSessions(
      normalized.cwd ?? undefined,
      normalized.includeSubagents
    );
    const filtered = stored.sort(compareSessionCatalogItems);
    const page = paginateSessionCatalog(filtered, normalized);
    return {
      sessions: page.sessions.map((session) => this.toPublicMetadata(session)),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * 列出所有可用会话
   * 扫描 ~/.blade/projects/ 目录下的所有 JSONL 文件
   */
  static async listSessions(
    options: Omit<SessionListOptions, 'cursor' | 'limit'> = {}
  ): Promise<SessionMetadata[]> {
    const normalized = normalizeSessionListOptions(options);
    const stored = await this.scanStoredSessions(
      normalized.cwd ?? undefined,
      normalized.includeSubagents
    );
    const seenSessions = new Set<string>();
    return stored.sort(compareSessionCatalogItems).flatMap((session) => {
      const key = `${session.projectPath}\0${session.sessionId}`;
      if (seenSessions.has(key)) return [];
      seenSessions.add(key);
      return [this.toPublicMetadata(session)];
    });
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
        return this.toPublicMetadata(stored);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw error;
      }
    }

    const matches = (await this.scanStoredSessions(undefined, true)).filter(
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

      const session = (await this.scanStoredSessions(undefined, true)).find(
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
    const sourceEntries = await this.readStableSessionSnapshot(
      sourceFilePath,
      sourceSessionId
    );
    const sourceCreated = this.getSessionCreatedEntry(sourceEntries, sourceSessionId);
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

    const now = new Date().toISOString();
    const rootId = sourceCreated.data.rootId || sourceSessionId;
    const gitBranch = detectGitBranch(targetProjectPath);
    const version = getVersion();
    const { status: _sourceStatus, ...sourceCreatedData } = sourceCreated.data;
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
        createdAt: now,
        updatedAt: now,
      },
    };
    const copiedEntries = sourceEntries
      .filter(
        (entry) =>
          entry.type !== 'session_created' && entry.type !== 'inbox_acknowledged'
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
          const { status: _status, ...updatedData } = entry.data;
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
      })
    );
    return matches.length;
  }

  static async createSessionMetadata(
    sessionId: string,
    projectPath: string,
    initial: { title?: string } = {}
  ): Promise<SessionMetadata> {
    assertValidSessionId(sessionId);
    const resolvedProjectPath = SessionService.resolveCatalogWorkspace(projectPath);
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

  static async updateSessionMetadata(
    sessionId: string,
    projectPath: string,
    update: { title?: string }
  ): Promise<SessionMetadata> {
    assertValidSessionId(sessionId);
    const resolvedProjectPath = SessionService.resolveCatalogWorkspace(projectPath);
    const filePath = SessionService.getSessionFilePath(resolvedProjectPath, sessionId);
    const store = new JSONLStore(filePath);
    let persistedEntries: SessionEvent[] = [];

    try {
      await store.appendValidated((entries) => {
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

  /**
   * 将 JSONL 条目转换为 OpenAI Message 格式
   */
  static convertJSONLToMessages(entries: SessionEvent[]): Message[] {
    const messages: Message[] = [];
    const messageMap = new Map<string, Message>();
    const partMap = new Map<string, ContentPart[]>();
    const recoveredToolAssistants = new Map<string, Message>();
    const toolCallIdByPartId = new Map<string, string>();
    for (const entry of entries) {
      if (entry.type === 'message_created') {
        const recoveredAssistant =
          entry.data.role === 'assistant' && entry.data.parentMessageId
            ? recoveredToolAssistants.get(entry.data.parentMessageId)
            : undefined;
        const message: Message = recoveredAssistant ?? {
          role: entry.data.role,
          content: '',
          ...(entry.data.inboxMessageId
            ? { metadata: { inboxMessageId: entry.data.inboxMessageId } }
            : {}),
        };
        messageMap.set(entry.data.messageId, message);
        partMap.set(entry.data.messageId, []);
        if (!recoveredAssistant) {
          messages.push(message);
        }
      }
      if (entry.type === 'part_created') {
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
          };
          const content =
            typeof payload.error === 'string'
              ? `Error: ${payload.error}`
              : typeof payload.output === 'string'
                ? payload.output
                : JSON.stringify(payload.output ?? '');
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
          const message = messageMap.get(entry.data.messageId);
          if (message) {
            const metadata = entry.data.payload as unknown as JsonValue;
            const base = (message.metadata ?? {}) as Record<string, JsonValue>;
            message.metadata = { ...base, subtaskRef: metadata } as JsonValue;
          }
        }
      }
    }

    return messages;
  }

  private static async scanStoredSessions(
    cwd?: string,
    includeSubagents = false
  ): Promise<StoredSessionMetadata[]> {
    const scopedProjectPath = cwd ? path.resolve(cwd) : undefined;
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

    return sessions;
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
    return this.projectMetadataFromEntries(entries, sessionId, projectPath, filePath);
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

    const messageCount = entries.filter(
      (entry) =>
        entry.type === 'message_created' &&
        ['user', 'assistant'].includes(entry.data.role)
    ).length;
    const hasErrors = entries.some(
      (entry) =>
        entry.type === 'part_created' &&
        entry.data.partType === 'tool_result' &&
        typeof (entry.data.payload as { error?: unknown }).error === 'string'
    );
    const committedProjectPath = created.cwd;
    if (committedProjectPath !== undefined && !path.isAbsolute(committedProjectPath)) {
      throw new Error(`Session catalog cwd must be absolute: ${sessionId}`);
    }

    return {
      sessionId,
      projectPath:
        committedProjectPath === undefined
          ? projectPath
          : path.resolve(committedProjectPath),
      gitBranch: created.gitBranch,
      rootId: durable.rootId || sessionId,
      parentId: durable.parentId,
      relationType: durable.relationType,
      title: durable.title,
      agentType: durable.agentType,
      model: durable.model,
      messageCount,
      firstMessageTime: entries[0]!.timestamp,
      lastMessageTime: entries.at(-1)!.timestamp,
      hasErrors,
      filePath,
    };
  }

  private static toPublicMetadata(session: StoredSessionMetadata): SessionMetadata {
    const { filePath: _filePath, ...publicSession } = session;
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

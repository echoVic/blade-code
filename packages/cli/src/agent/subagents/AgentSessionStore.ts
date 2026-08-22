/**
 * Agent 会话持久化存储
 *
 * 用于支持 Task 工具的 resume 功能：
 * - 保存 agent 执行上下文到文件
 * - 支持跨会话恢复 agent
 * - 自动清理过期会话
 */

import fs from 'node:fs';
import path from 'node:path';
import { join } from 'pathe';
import writeFileAtomic from 'write-file-atomic';
import {
  assertValidSessionId,
  getBladeStorageRoot,
} from '../../context/storage/pathUtils.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import type { Message } from '../../services/ChatServiceInterface.js';
import {
  isProcessIdentity,
  type ProcessIdentity,
} from '../../utils/process/ProcessIdentity.js';
import type { WorktreeSession } from '../../worktree/WorktreeManager.js';
import type { VerificationVerdict } from '../loop/independentVerification.js';
import type { SubagentIsolationMode } from './SubagentWorktreeLifecycle.js';
import type { SubagentConfig } from './types.js';

const logger = createLogger(LogCategory.AGENT);
export const MAX_CACHED_AGENT_SESSIONS = 256;

/**
 * Agent 会话状态
 */
export type AgentSessionStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type AgentRestartRecoveryOutcome = 'completed' | 'interrupted' | 'failed';

export interface AgentRestartRecovery {
  outcome: AgentRestartRecoveryOutcome;
  recoveredAt: number;
}

export interface AgentSessionOwner {
  sessionId: string;
  projectPath: string;
}

export type AgentSessionConfigSnapshot = Pick<
  SubagentConfig,
  | 'name'
  | 'description'
  | 'systemPrompt'
  | 'tools'
  | 'disallowedTools'
  | 'model'
  | 'permissionMode'
  | 'maxTurns'
  | 'skills'
  | 'isolation'
  | 'source'
>;

export function createAgentSessionConfigSnapshot(
  config: SubagentConfig
): AgentSessionConfigSnapshot {
  return {
    name: config.name,
    description: config.description,
    systemPrompt: config.systemPrompt,
    tools: config.tools ? [...config.tools] : undefined,
    disallowedTools: config.disallowedTools ? [...config.disallowedTools] : undefined,
    model: config.model,
    permissionMode: config.permissionMode,
    maxTurns: config.maxTurns,
    skills: config.skills ? [...config.skills] : undefined,
    isolation: config.isolation,
    source: config.source,
  };
}

/**
 * Agent 会话数据
 */
export interface AgentSession {
  /** 持久化 schema。旧 sidecar 在读取时规范化为 v2。 */
  schemaVersion: 2;

  /** 会话 ID (agent_{uuid}) */
  id: string;

  /** Subagent 类型 */
  subagentType: string;

  /** 任务描述 */
  description: string;

  /** 原始 prompt */
  prompt: string;

  /** 会话消息历史 */
  messages: Message[];

  /** 会话状态 */
  status: AgentSessionStatus;

  /** 最终结果（如果已完成） */
  result?: {
    success: boolean;
    message: string;
    error?: string;
    verificationCommands?: string[];
    verificationVerdict?: VerificationVerdict;
    modifiedFiles?: string[];
  };

  /** 是否由 Task/直接 resume 作为后台运行启动；legacy sidecar 规范化为 false */
  background?: boolean;

  /** 执行统计 */
  stats?: {
    tokens?: number;
    toolCalls?: number;
    duration?: number;
  };

  /** 创建时间 */
  createdAt: number;

  /** 最后活跃时间 */
  lastActiveAt: number;

  /** 写入 running sidecar 的 Blade 进程，用于跨进程 orphan 判定 */
  processId?: number;

  /** owner PID 的启动身份，防止 PID 复用被误判为仍在运行 */
  processIdentity?: ProcessIdentity;

  /** hard restart 后从 child JSONL 恢复 sidecar 的结果 */
  restartRecovery?: AgentRestartRecovery;

  /** 完成时间（如果已完成） */
  completedAt?: number;

  /** 父会话 ID（可选） */
  parentSessionId?: string;

  /** Private root Session owner for process-wide Provider admission. */
  providerAdmissionOwnerId?: string;

  /** 父会话 canonical workspace，用于 compound owner 鉴权 */
  parentProjectPath?: string;

  /** lineage 根 agent ID */
  rootAgentId: string;

  /** 本次运行从哪个已完成 agent 恢复 */
  resumedFrom?: string;

  /** 从根运行开始的恢复深度 */
  resumeDepth: number;

  /** 启动时冻结的执行身份，resume 不受后续配置漂移影响 */
  configSnapshot?: AgentSessionConfigSnapshot;

  /** 共享任务列表 ID（用于 Agent Team 协作） */
  taskListId?: string;

  /** Agent Team identity for runtime projection and peer messaging. */
  teamId?: string;

  /** 子代理源工作目录 */
  workspaceRoot?: string;

  /** 子代理文件系统隔离模式 */
  isolation?: SubagentIsolationMode;

  /** 保留并可供 resume 的 worktree lease */
  worktree?: WorktreeSession;
}

export type PublicAgentSession = Pick<
  AgentSession,
  | 'id'
  | 'subagentType'
  | 'description'
  | 'status'
  | 'background'
  | 'rootAgentId'
  | 'resumedFrom'
  | 'resumeDepth'
  | 'createdAt'
  | 'lastActiveAt'
  | 'completedAt'
  | 'result'
  | 'stats'
  | 'restartRecovery'
  | 'teamId'
>;

export function toPublicAgentSession(session: AgentSession): PublicAgentSession {
  return {
    id: session.id,
    subagentType: session.subagentType,
    description: session.description,
    status: session.status,
    background: session.background === true,
    rootAgentId: session.rootAgentId,
    resumedFrom: session.resumedFrom,
    resumeDepth: session.resumeDepth,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    completedAt: session.completedAt,
    result: session.result,
    stats: session.stats,
    restartRecovery: session.restartRecovery,
    teamId: session.teamId,
  };
}

const SESSION_STATUSES = new Set<AgentSessionStatus>([
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export function normalizeAgentSessionOwner(
  owner: AgentSessionOwner
): AgentSessionOwner {
  assertValidSessionId(owner.sessionId);
  if (!path.isAbsolute(owner.projectPath)) {
    throw new Error('Subagent owner projectPath must be absolute');
  }
  return {
    sessionId: owner.sessionId,
    projectPath: path.resolve(owner.projectPath),
  };
}

export function isAgentSessionOwnedBy(
  session: AgentSession,
  owner: AgentSessionOwner
): boolean {
  const normalized = normalizeAgentSessionOwner(owner);
  return (
    session.parentSessionId === normalized.sessionId &&
    session.parentProjectPath !== undefined &&
    path.resolve(session.parentProjectPath) === normalized.projectPath
  );
}

/**
 * Agent 会话存储管理器
 *
 * 存储位置: ${BLADE_STORAGE_ROOT:-~/.blade}/agents/sessions/{agent_id}.json
 */
export class AgentSessionStore {
  private static instance: AgentSessionStore | null = null;
  private readonly storageRoot: string;
  private readonly sessionsDir: string;

  // 内存缓存（避免频繁读取文件）
  private cache = new Map<string, AgentSession>();

  private constructor() {
    this.storageRoot = path.resolve(getBladeStorageRoot());
    this.sessionsDir = join(this.storageRoot, 'agents', 'sessions');
    this.ensureDirectory();
  }

  static getInstance(): AgentSessionStore {
    const storageRoot = path.resolve(getBladeStorageRoot());
    if (
      !AgentSessionStore.instance ||
      AgentSessionStore.instance.storageRoot !== storageRoot
    ) {
      AgentSessionStore.instance = new AgentSessionStore();
    }
    return AgentSessionStore.instance;
  }

  /**
   * 确保存储目录存在
   */
  private ensureDirectory(): void {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    } else {
      fs.chmodSync(this.sessionsDir, 0o700);
    }
  }

  private cacheSession(session: AgentSession): void {
    this.cache.delete(session.id);
    this.cache.set(session.id, session);
    this.pruneTerminalCache();
  }

  private pruneTerminalCache(): void {
    if (this.cache.size <= MAX_CACHED_AGENT_SESSIONS) return;

    for (const [agentId, session] of this.cache) {
      if (session.status === 'running') continue;
      this.cache.delete(agentId);
      if (this.cache.size <= MAX_CACHED_AGENT_SESSIONS) return;
    }
  }

  /**
   * 获取会话文件路径
   */
  private getSessionPath(agentId: string): string {
    assertValidSessionId(agentId);
    return join(this.sessionsDir, `${agentId}.json`);
  }

  /**
   * 保存会话
   */
  saveSession(session: AgentSession): void {
    const normalized = this.normalizeSession(session, session.id);
    this.ensureDirectory();
    const filePath = this.getSessionPath(normalized.id);
    const data = `${JSON.stringify(normalized, null, 2)}\n`;
    writeFileAtomic.sync(filePath, data, {
      encoding: 'utf8',
      mode: 0o600,
      fsync: true,
    });
    this.cacheSession(normalized);
    logger.debug(`Session saved: ${normalized.id}`);
  }

  /**
   * 加载会话
   */
  loadSession(agentId: string): AgentSession | undefined {
    // 先检查缓存
    const cached = this.cache.get(agentId);
    if (cached) {
      this.cacheSession(cached);
      return cached;
    }

    try {
      const filePath = this.getSessionPath(agentId);
      if (!fs.existsSync(filePath)) {
        return undefined;
      }

      const data = fs.readFileSync(filePath, 'utf-8');
      const session = this.normalizeSession(JSON.parse(data), agentId);

      // 更新缓存
      this.cacheSession(session);

      return session;
    } catch (error) {
      logger.warn(`Failed to load session ${agentId}:`, error);
      return undefined;
    }
  }

  private normalizeSession(input: unknown, expectedId: string): AgentSession {
    if (!input || typeof input !== 'object') {
      throw new Error(`Invalid agent session payload: ${expectedId}`);
    }
    const value = input as Partial<AgentSession> & Record<string, unknown>;
    if (value.id !== expectedId) {
      throw new Error(`Agent session ID mismatch: ${expectedId}`);
    }
    assertValidSessionId(expectedId);
    if (typeof value.subagentType !== 'string' || value.subagentType.length === 0) {
      throw new Error(`Invalid subagent type: ${expectedId}`);
    }
    if (typeof value.description !== 'string' || typeof value.prompt !== 'string') {
      throw new Error(`Invalid agent session description: ${expectedId}`);
    }
    if (!Array.isArray(value.messages)) {
      throw new Error(`Invalid agent session messages: ${expectedId}`);
    }
    if (
      typeof value.status !== 'string' ||
      !SESSION_STATUSES.has(value.status as AgentSessionStatus)
    ) {
      throw new Error(`Invalid agent session status: ${expectedId}`);
    }
    if (
      typeof value.createdAt !== 'number' ||
      !Number.isFinite(value.createdAt) ||
      typeof value.lastActiveAt !== 'number' ||
      !Number.isFinite(value.lastActiveAt)
    ) {
      throw new Error(`Invalid agent session timestamps: ${expectedId}`);
    }
    if (value.parentSessionId !== undefined) {
      assertValidSessionId(value.parentSessionId);
    }
    if (value.providerAdmissionOwnerId !== undefined) {
      assertValidSessionId(value.providerAdmissionOwnerId);
    }
    if (value.resumedFrom !== undefined) {
      assertValidSessionId(value.resumedFrom);
    }
    const rootAgentId =
      typeof value.rootAgentId === 'string' ? value.rootAgentId : expectedId;
    assertValidSessionId(rootAgentId);
    const workspaceRoot =
      typeof value.workspaceRoot === 'string' && path.isAbsolute(value.workspaceRoot)
        ? path.resolve(value.workspaceRoot)
        : undefined;
    const parentProjectPath =
      typeof value.parentProjectPath === 'string' &&
      path.isAbsolute(value.parentProjectPath)
        ? path.resolve(value.parentProjectPath)
        : value.parentSessionId && workspaceRoot
          ? workspaceRoot
          : undefined;
    const resumeDepth =
      typeof value.resumeDepth === 'number' &&
      Number.isInteger(value.resumeDepth) &&
      value.resumeDepth >= 0
        ? value.resumeDepth
        : 0;
    const processId =
      typeof value.processId === 'number' &&
      Number.isSafeInteger(value.processId) &&
      value.processId > 1
        ? value.processId
        : undefined;
    const processIdentity = isProcessIdentity(value.processIdentity)
      ? value.processIdentity
      : undefined;
    const restartRecoveryValue = value.restartRecovery as
      | Partial<AgentRestartRecovery>
      | undefined;
    const restartRecovery =
      restartRecoveryValue &&
      (restartRecoveryValue.outcome === 'completed' ||
        restartRecoveryValue.outcome === 'interrupted' ||
        restartRecoveryValue.outcome === 'failed') &&
      typeof restartRecoveryValue.recoveredAt === 'number' &&
      Number.isFinite(restartRecoveryValue.recoveredAt)
        ? {
            outcome: restartRecoveryValue.outcome,
            recoveredAt: restartRecoveryValue.recoveredAt,
          }
        : undefined;
    const background = value.background === true;
    const providerAdmissionOwnerId =
      typeof value.providerAdmissionOwnerId === 'string'
        ? value.providerAdmissionOwnerId
        : undefined;
    const teamId = typeof value.teamId === 'string' ? value.teamId : undefined;

    return {
      ...(value as unknown as AgentSession),
      schemaVersion: 2,
      id: expectedId,
      rootAgentId,
      resumeDepth,
      processId,
      processIdentity,
      restartRecovery,
      background,
      ...(providerAdmissionOwnerId ? { providerAdmissionOwnerId } : {}),
      ...(teamId ? { teamId } : { teamId: undefined }),
      workspaceRoot,
      parentProjectPath,
    };
  }

  /**
   * 更新会话状态
   */
  updateSession(
    agentId: string,
    updates: Partial<AgentSession>
  ): AgentSession | undefined {
    const session = this.loadSession(agentId);
    if (!session) {
      return undefined;
    }

    const updatedSession: AgentSession = {
      ...session,
      ...updates,
      lastActiveAt: Date.now(),
    };

    this.saveSession(updatedSession);
    return updatedSession;
  }

  /**
   * 追加消息到会话
   */
  appendMessages(agentId: string, messages: Message[]): AgentSession | undefined {
    const session = this.loadSession(agentId);
    if (!session) {
      return undefined;
    }

    return this.updateSession(agentId, {
      messages: [...session.messages, ...messages],
    });
  }

  /**
   * 标记会话完成
   */
  markCompleted(
    agentId: string,
    result: {
      success: boolean;
      message: string;
      error?: string;
      verificationCommands?: string[];
      verificationVerdict?: VerificationVerdict;
      modifiedFiles?: string[];
    },
    stats?: AgentSession['stats']
  ): AgentSession | undefined {
    return this.updateSession(agentId, {
      status: result.success ? 'completed' : 'failed',
      result,
      stats,
      completedAt: Date.now(),
    });
  }

  /**
   * 删除会话
   */
  deleteSession(agentId: string): boolean {
    try {
      const filePath = this.getSessionPath(agentId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      this.cache.delete(agentId);
      return true;
    } catch (error) {
      logger.warn(`Failed to delete session ${agentId}:`, error);
      return false;
    }
  }

  /**
   * 列出所有会话
   */
  listSessions(): AgentSession[] {
    try {
      const files = fs.readdirSync(this.sessionsDir);
      const sessions: AgentSession[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const agentId = file.replace('.json', '');
        const session = this.loadSession(agentId);
        if (session) {
          sessions.push(session);
        }
      }

      // 按最后活跃时间倒序，并让缓存保留最近的 terminal 会话。
      const sorted = sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      for (const session of [...sorted].reverse()) {
        this.cacheSession(session);
      }
      return sorted;
    } catch (error) {
      logger.warn('Failed to list sessions:', error);
      return [];
    }
  }

  /**
   * 列出运行中的会话
   */
  listRunningSessions(): AgentSession[] {
    return this.listSessions().filter((s) => s.status === 'running');
  }

  /**
   * 清理过期会话
   * @param maxAgeMs 最大保留时间（毫秒），默认 7 天
   */
  cleanupExpiredSessions(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    const sessions = this.listSessions();
    let cleaned = 0;

    for (const session of sessions) {
      // 只清理已完成的会话
      if (session.status === 'running') continue;

      const age = now - session.lastActiveAt;
      if (age > maxAgeMs) {
        if (this.deleteSession(session.id)) {
          cleaned++;
        }
      }
    }

    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} expired agent sessions`);
    }

    return cleaned;
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * 后台 Agent 管理器
 *
 * 管理在后台运行的 subagent：
 * - 启动后台 agent
 * - 跟踪状态和输出
 * - 支持等待完成、恢复、终止
 */

import { stat } from 'node:fs/promises';
import type {
  CommunicationStyleSelection,
  PermissionMode,
  ReasoningEffortSelection,
  ResponseVerbositySelection,
  ServiceTierSelection,
} from '../../config/types.js';
import { projectTurnLifecycle } from '../../context/events/turnLifecycle.js';
import { ForegroundProcessLeaseStore } from '../../context/storage/ForegroundProcessLeaseStore.js';
import { PersistentStore } from '../../context/storage/PersistentStore.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import type { SessionLspResources } from '../../lsp/WorkspaceLspResources.js';
import type { Message } from '../../services/ChatServiceInterface.js';
import { SessionService } from '../../services/SessionService.js';
import { BackgroundShellManager } from '../../tools/builtin/shell/BackgroundShellManager.js';
import { getCwd } from '../../utils/cwd.js';
import {
  captureProcessIdentity,
  processIdentityMatches,
} from '../../utils/process/ProcessIdentity.js';
import { createSessionId } from '../../utils/sessionId.js';
import {
  GOAL_VERIFICATION_SUBAGENT_TYPE,
  isVerificationAuditSubagent,
} from '../../utils/shell/readOnlyAudit.js';
import type { WorktreeSession } from '../../worktree/WorktreeManager.js';
import { Agent } from '../Agent.js';
import { recordVerificationEvidence } from '../loop/completionPolicy.js';
import {
  parseVerificationVerdict,
  recordModifiedFiles,
} from '../loop/independentVerification.js';
import { drainLoop } from '../loop/index.js';
import type { LoopEvent } from '../loop/types.js';
import type { SessionAgentResources } from '../resources/WorkspaceAgentResources.js';
import type { SessionModelResources } from '../resources/WorkspaceModelResources.js';
import { SessionInUseError, SessionLease } from '../runtime/SessionLease.js';
import { SessionRuntime } from '../runtime/SessionRuntime.js';
import {
  type AgentSession,
  type AgentSessionOwner,
  AgentSessionStore,
  createAgentSessionConfigSnapshot,
  isAgentSessionOwnedBy,
  normalizeAgentSessionOwner,
} from './AgentSessionStore.js';
import {
  GOAL_VERIFICATION_OUTPUT_SCHEMA,
  goalVerificationVerdictFromOutput,
} from './builtinGoalVerificationAgent.js';
import {
  INDEPENDENT_VERIFICATION_OUTPUT_SCHEMA,
  independentVerificationVerdictFromOutput,
} from './builtinVerificationAgent.js';
import {
  type SubagentIsolationMode,
  type SubagentWorktreeLease,
  subagentWorktreeLifecycle,
} from './SubagentWorktreeLifecycle.js';
import type { SubagentConfig, SubagentResult } from './types.js';

const logger = createLogger(LogCategory.AGENT);

export const PROCESS_RESTART_SUBAGENT_ERROR =
  'Subagent execution was interrupted by a process restart. Durable progress was ' +
  'recovered; resume this agent to continue from the committed history.';
export const PROCESS_RESTART_SUBAGENT_RECOVERY_FAILED =
  'Subagent execution was interrupted by a process restart, and its durable ' +
  'history could not be validated. Resume is disabled for this run.';
const LEGACY_ORPHANED_SUBAGENT_ERROR =
  'Session was orphaned (process restart or timeout)';
const SUBAGENT_ACTIVITY_PERSIST_INTERVAL_MS = 1_000;

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

function isSessionOwnerRunning(session: AgentSession): boolean | undefined {
  if (session.processId === undefined) return undefined;
  if (!isProcessRunning(session.processId)) return false;
  return session.processIdentity
    ? processIdentityMatches(session.processId, session.processIdentity)
    : true;
}

function messageKey(message: Message): string {
  return JSON.stringify(message);
}

function mergeRecoveredMessages(
  existing: readonly Message[],
  recovered: readonly Message[]
): Message[] {
  const maxOverlap = Math.min(existing.length, recovered.length);
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    const existingStart = existing.length - overlap;
    let matches = true;
    for (let index = 0; index < overlap; index++) {
      if (
        messageKey(existing[existingStart + index]!) !== messageKey(recovered[index]!)
      ) {
        matches = false;
        break;
      }
    }
    if (matches) return [...existing, ...recovered.slice(overlap)];
  }
  return [...existing, ...recovered];
}

function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function lastAssistantText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== 'assistant') continue;
    const text = messageText(message).trim();
    if (text) return text;
  }
  return '';
}

/**
 * 后台 Agent 运行时信息
 */
interface BackgroundAgentRuntime {
  /** Agent ID */
  id: string;

  /** 执行 Promise */
  promise: Promise<SubagentResult>;

  /** 用于取消执行的 AbortController */
  abortController: AbortController;

  /** 开始时间 */
  startTime: number;
}

/**
 * 启动后台 Agent 的选项
 */
export interface StartBackgroundAgentOptions {
  /** Subagent 配置 */
  config: SubagentConfig;

  /** 任务描述 */
  description: string;

  /** 任务 prompt */
  prompt: string;

  /** 父会话 ID */
  parentSessionId?: string;

  /** Root Session owning Provider request admission for this child tree. */
  providerAdmissionOwnerId?: string;

  /** 父会话 canonical workspace */
  parentProjectPath?: string;

  /** 权限模式 */
  permissionMode?: PermissionMode;

  /** 父 Session 当前的 durable reasoning 策略 */
  reasoningEffort?: ReasoningEffortSelection;
  serviceTier?: ServiceTierSelection;
  responseVerbosity?: ResponseVerbositySelection;
  communicationStyle?: CommunicationStyleSelection;

  /** 已有的 agent ID（用于 resume） */
  agentId?: string;

  /** 恢复时的初始消息（用于 resume） */
  existingMessages?: Message[];

  /** Shared task-list scope for coordinated agent teams */
  taskListId?: string;

  /** Agent Team identity for runtime projection and peer messaging. */
  teamId?: string;

  /** Parent workspace inherited by the child */
  workspaceRoot?: string;

  /** Optional isolated worktree execution */
  isolation?: SubagentIsolationMode;

  /** Persisted lease used when resuming an isolated child */
  restoredWorktree?: WorktreeSession;

  /** Resume lineage root */
  rootAgentId?: string;

  /** Source run for this resume */
  resumedFrom?: string;

  /** Number of resume edges from the root run */
  resumeDepth?: number;

  /** Immutable resource view inherited from the parent Session */
  agentResources?: SessionAgentResources;
  modelResources?: SessionModelResources;
  lspResources?: SessionLspResources;

  /** Forward child loop events to the owning surface */
  onEvent?: (event: LoopEvent, agentId: string) => void | Promise<void>;

  /** Notify callers once the child runtime can accept steering messages. */
  onStarted?: (agentId: string) => void | Promise<void>;

  /** Notify the owning surface after durable completion */
  onCompleted?: (session: AgentSession) => void | Promise<void>;
}

export interface ResumeAgentOptions {
  agentId: string;
  prompt: string;
  config: SubagentConfig;
  owner: AgentSessionOwner;
  permissionMode?: PermissionMode;
  reasoningEffort?: ReasoningEffortSelection;
  serviceTier?: ServiceTierSelection;
  responseVerbosity?: ResponseVerbositySelection;
  communicationStyle?: CommunicationStyleSelection;
  newAgentId?: string;
  agentResources?: SessionAgentResources;
  modelResources?: SessionModelResources;
  lspResources?: SessionLspResources;
  onEvent?: (event: LoopEvent, agentId: string) => void | Promise<void>;
  onCompleted?: (session: AgentSession) => void | Promise<void>;
}

export interface ResumeAgentResult {
  agentId: string;
  source: AgentSession;
}

/**
 * 后台 Agent 管理器
 */
export class BackgroundAgentManager {
  private static instance: BackgroundAgentManager | null = null;

  // 运行中的 agent
  private runningAgents = new Map<string, BackgroundAgentRuntime>();
  private activeRuntimes = new Map<string, SessionRuntime>();

  // 会话存储
  private sessionStore = AgentSessionStore.getInstance();

  private constructor() {}

  static getInstance(): BackgroundAgentManager {
    if (!BackgroundAgentManager.instance) {
      BackgroundAgentManager.instance = new BackgroundAgentManager();
    }
    return BackgroundAgentManager.instance;
  }

  private async cleanupOrphanedSessions(owner?: AgentSessionOwner): Promise<void> {
    const normalizedOwner = owner ? normalizeAgentSessionOwner(owner) : undefined;
    const sessions = this.sessionStore
      .listSessions()
      .filter(
        (session) => !normalizedOwner || isAgentSessionOwnedBy(session, normalizedOwner)
      );
    const now = Date.now();
    const maxOrphanAge = 30 * 60 * 1000;

    for (const session of sessions) {
      const isInMemory = this.runningAgents.has(session.id);
      const ownerProcessRunning = isSessionOwnerRunning(session);
      if (
        !isInMemory &&
        ownerProcessRunning !== true &&
        session.status === 'failed' &&
        session.restartRecovery === undefined &&
        (session.result?.error === LEGACY_ORPHANED_SUBAGENT_ERROR ||
          session.result?.error === PROCESS_RESTART_SUBAGENT_ERROR)
      ) {
        await this.reconcileOrphanedSession(session);
        continue;
      }
      if (session.status === 'running') {
        const age = now - session.lastActiveAt;
        const legacySessionMayBeRunning =
          session.processId === undefined && age <= maxOrphanAge;

        if (
          !isInMemory &&
          ownerProcessRunning === false &&
          !legacySessionMayBeRunning
        ) {
          logger.warn(`Cleaning up orphaned agent session: ${session.id}`);
          await this.reconcileOrphanedSession(session);
        } else if (
          !isInMemory &&
          ownerProcessRunning === undefined &&
          !legacySessionMayBeRunning
        ) {
          await this.reconcileOrphanedSession(session);
        }
      }
    }
  }

  private async reconcileOrphanedSession(session: AgentSession): Promise<void> {
    const recoveredAt = Date.now();
    const projectPath =
      session.worktree?.workspaceRoot ??
      session.workspaceRoot ??
      session.parentProjectPath;
    if (!projectPath) {
      this.markRecoveryFailed(session.id, recoveredAt);
      return;
    }

    let lease: SessionLease;
    try {
      lease = await SessionLease.acquire(session.id, projectPath);
    } catch (error) {
      if (error instanceof SessionInUseError) return;
      this.markRecoveryFailed(session.id, recoveredAt);
      return;
    }

    try {
      await new ForegroundProcessLeaseStore(projectPath, session.id).reapOrphans();
      await BackgroundShellManager.getInstance().reapOrphanedSession(
        session.id,
        projectPath
      );
      const persistentStore = new PersistentStore(projectPath);
      await persistentStore.initialize();
      await persistentStore.recoverInterruptedTurn(session.id);
      const [events, recoveredMessages] = await Promise.all([
        persistentStore.loadEvents(session.id),
        SessionService.loadSessionModelContext(session.id, projectPath),
      ]);
      if (!events) {
        this.markRecoveryFailed(session.id, recoveredAt);
        return;
      }
      const messages = mergeRecoveredMessages(session.messages, recoveredMessages);
      const lifecycle = projectTurnLifecycle(events);
      const completed = lifecycle.lastTerminal?.type === 'turn_completed';
      const finalMessage = completed ? lastAssistantText(recoveredMessages) : '';
      const outcome = completed && finalMessage ? 'completed' : 'interrupted';
      const terminal = lifecycle.lastTerminal?.data;
      const worktree = await this.reconcileOrphanedWorktree(
        session,
        outcome === 'completed'
      );
      this.sessionStore.updateSession(session.id, {
        status: outcome === 'completed' ? 'completed' : 'failed',
        messages,
        result: {
          success: outcome === 'completed',
          message: finalMessage,
          ...(outcome === 'completed' ? {} : { error: PROCESS_RESTART_SUBAGENT_ERROR }),
        },
        completedAt: recoveredAt,
        processId: undefined,
        processIdentity: undefined,
        worktree,
        restartRecovery: { outcome, recoveredAt },
        ...(terminal
          ? {
              stats: {
                toolCalls: terminal.toolCallsCount,
                duration: terminal.durationMs,
              },
            }
          : {}),
      });
    } catch (error) {
      logger.warn(`Failed to reconcile orphaned agent ${session.id}`, error);
      this.markRecoveryFailed(session.id, recoveredAt);
    } finally {
      await lease.release().catch((error) => {
        logger.warn(`Failed to release recovered agent lease ${session.id}`, error);
      });
    }
  }

  private async reconcileOrphanedWorktree(
    session: AgentSession,
    success: boolean
  ): Promise<WorktreeSession | undefined> {
    if (!session.worktree) return undefined;
    try {
      await stat(session.worktree.worktreeRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      logger.warn(`Failed to inspect recovered worktree ${session.id}`, error);
      return session.worktree;
    }
    try {
      const lease = await subagentWorktreeLifecycle.prepare({
        agentId: session.id,
        sourceWorkspaceRoot:
          session.workspaceRoot ??
          session.parentProjectPath ??
          session.worktree.originalWorkspaceRoot,
        isolation: 'worktree',
        restoredWorktree: session.worktree,
      });
      const outcome = await subagentWorktreeLifecycle.finalize({
        agentId: session.id,
        lease,
        success,
      });
      return outcome.worktree;
    } catch (error) {
      logger.warn(`Failed to finalize recovered worktree ${session.id}`, error);
      return session.worktree;
    }
  }

  private markRecoveryFailed(agentId: string, recoveredAt: number): void {
    this.sessionStore.updateSession(agentId, {
      status: 'failed',
      result: {
        success: false,
        message: '',
        error: PROCESS_RESTART_SUBAGENT_RECOVERY_FAILED,
      },
      completedAt: recoveredAt,
      processId: undefined,
      processIdentity: undefined,
      restartRecovery: { outcome: 'failed', recoveredAt },
    });
  }

  async reconcileOrphanedSessions(owner?: AgentSessionOwner): Promise<void> {
    await this.cleanupOrphanedSessions(owner);
  }

  /**
   * 启动后台 Agent
   * @returns agent ID
   */
  startBackgroundAgent(options: StartBackgroundAgentOptions): string {
    const {
      config,
      description,
      prompt,
      parentSessionId,
      providerAdmissionOwnerId,
      parentProjectPath,
      permissionMode,
      reasoningEffort,
      serviceTier,
      responseVerbosity,
      communicationStyle,
      agentId,
      existingMessages,
      taskListId,
      teamId,
      workspaceRoot = getCwd(),
      isolation = config.isolation ?? 'none',
      restoredWorktree,
      rootAgentId,
      resumedFrom,
      resumeDepth = 0,
      agentResources,
      modelResources,
      lspResources,
      onEvent,
      onStarted,
      onCompleted,
    } = options;

    // 生成或使用已有的 agent ID
    const id = agentId || createSessionId('agent');
    if (this.runningAgents.has(id) || this.sessionStore.loadSession(id)) {
      throw new Error(`Subagent session already exists: ${id}`);
    }

    // 创建 AbortController 用于取消
    const abortController = new AbortController();

    // 创建会话记录
    const session: AgentSession = {
      schemaVersion: 2,
      id,
      subagentType: config.name,
      description,
      prompt,
      messages: existingMessages || [],
      status: 'running',
      background: true,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      processId: process.pid,
      processIdentity: captureProcessIdentity(process.pid),
      parentSessionId,
      providerAdmissionOwnerId: providerAdmissionOwnerId ?? parentSessionId,
      parentProjectPath,
      rootAgentId: rootAgentId ?? id,
      resumedFrom,
      resumeDepth,
      configSnapshot: createAgentSessionConfigSnapshot(config),
      taskListId,
      teamId,
      workspaceRoot,
      isolation,
      worktree: restoredWorktree,
    };

    // 保存会话
    this.sessionStore.saveSession(session);

    // 启动执行
    const startTime = Date.now();
    const promise = this.executeAgent(
      id,
      config,
      prompt,
      parentSessionId,
      providerAdmissionOwnerId ?? parentSessionId,
      permissionMode,
      reasoningEffort,
      serviceTier,
      responseVerbosity,
      communicationStyle,
      abortController.signal,
      existingMessages,
      taskListId,
      teamId,
      workspaceRoot,
      isolation,
      restoredWorktree,
      agentResources,
      modelResources,
      lspResources,
      onEvent,
      onStarted,
      onCompleted
    );

    // 记录运行时信息
    this.runningAgents.set(id, {
      id,
      promise,
      abortController,
      startTime,
    });

    // 执行完成后清理
    void promise.then(
      () => this.runningAgents.delete(id),
      () => this.runningAgents.delete(id)
    );

    logger.info(`Background agent started: ${id} (${config.name})`);
    return id;
  }

  /**
   * 执行 Agent（内部方法）
   */
  private async executeAgent(
    agentId: string,
    config: SubagentConfig,
    prompt: string,
    parentSessionId: string | undefined,
    providerAdmissionOwnerId: string | undefined,
    permissionMode: PermissionMode | undefined,
    reasoningEffort: ReasoningEffortSelection | undefined,
    serviceTier: ServiceTierSelection | undefined,
    responseVerbosity: ResponseVerbositySelection | undefined,
    communicationStyle: CommunicationStyleSelection | undefined,
    signal: AbortSignal,
    existingMessages?: Message[],
    taskListId?: string,
    teamId?: string,
    workspaceRoot: string = getCwd(),
    isolation: SubagentIsolationMode = 'none',
    restoredWorktree?: WorktreeSession,
    agentResources?: SessionAgentResources,
    modelResources?: SessionModelResources,
    lspResources?: SessionLspResources,
    onEvent?: (event: LoopEvent, agentId: string) => void | Promise<void>,
    onStarted?: (agentId: string) => void | Promise<void>,
    onCompleted?: (session: AgentSession) => void | Promise<void>
  ): Promise<SubagentResult> {
    const startTime = Date.now();
    let runtime: SessionRuntime | undefined;
    let agent: Agent | undefined;
    let lease: SubagentWorktreeLease | undefined;
    let worktreeFinalized = false;

    const finalizeWorktree = async (success: boolean) => {
      if (!lease || worktreeFinalized) return undefined;
      const outcome = await subagentWorktreeLifecycle.finalize({
        agentId,
        lease,
        success,
      });
      worktreeFinalized = true;
      this.sessionStore.updateSession(agentId, {
        worktree: outcome.worktree,
      });
      return outcome;
    };

    try {
      if (signal.aborted) {
        throw new Error('Agent execution was cancelled');
      }

      lease = await subagentWorktreeLifecycle.prepare({
        agentId,
        sourceWorkspaceRoot: workspaceRoot,
        isolation,
        restoredWorktree,
      });
      this.sessionStore.updateSession(agentId, {
        worktree: lease.worktree,
      });

      const appendSystemPrompt = config.systemPrompt?.trim();
      const modelId =
        config.model && config.model !== 'inherit' ? config.model : undefined;
      const effectivePermissionMode = config.permissionMode ?? permissionMode;
      const persistedSession = this.sessionStore.loadSession(agentId);
      runtime = await SessionRuntime.create({
        sessionId: agentId,
        workspaceRoot: lease.workspaceRoot,
        modelId,
        reasoningEffort,
        serviceTier,
        responseVerbosity,
        communicationStyle,
        agentResources,
        modelResources,
        lspResources,
        ...((existingMessages?.length ?? 0) > 0
          ? {
              sessionStart: {
                isResume: true,
                resumeSessionId: agentId,
              },
            }
          : {}),
        subagentInfo: parentSessionId
          ? {
              parentSessionId,
              providerAdmissionOwnerId:
                persistedSession?.providerAdmissionOwnerId ??
                providerAdmissionOwnerId ??
                parentSessionId,
              subagentType: config.name,
              isSidechain: false,
              resumedFrom: persistedSession?.resumedFrom,
              rootAgentId: persistedSession?.rootAgentId ?? agentId,
              resumeDepth: persistedSession?.resumeDepth ?? 0,
            }
          : undefined,
      });
      this.activeRuntimes.set(agentId, runtime);
      await onStarted?.(agentId);
      agent = await Agent.createWithRuntime(runtime, {
        sessionId: agentId,
        toolWhitelist: config.tools,
        toolBlacklist: [
          'EnterWorktree',
          'ExitWorktree',
          'TeamCreate',
          ...(config.disallowedTools ?? []),
        ],
        modelId,
        maxTurns: config.maxTurns,
        permissionMode: effectivePermissionMode,
        ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
      });

      const context = {
        messages: existingMessages || [],
        userId: 'subagent',
        sessionId: agentId,
        taskListId,
        workspaceRoot: lease.workspaceRoot,
        worktreeActive: Boolean(lease.worktree),
        permissionMode: effectivePermissionMode,
        subagentInfo: {
          parentSessionId: parentSessionId || '',
          providerAdmissionOwnerId:
            persistedSession?.providerAdmissionOwnerId ??
            providerAdmissionOwnerId ??
            parentSessionId,
          subagentType: config.name,
          isSidechain: false,
          resumedFrom: persistedSession?.resumedFrom,
          rootAgentId: persistedSession?.rootAgentId ?? agentId,
          resumeDepth: persistedSession?.resumeDepth ?? 0,
        },
      };

      const verificationCommands = new Set<string>();
      const modifiedFiles = new Set<string>();
      let lastActivityPersistedAt = startTime;
      const loopResult = await drainLoop(
        agent.chatStream(prompt, context, {
          signal,
          ...(config.name === GOAL_VERIFICATION_SUBAGENT_TYPE
            ? { outputSchema: GOAL_VERIFICATION_OUTPUT_SCHEMA }
            : isVerificationAuditSubagent(config.name)
              ? { outputSchema: INDEPENDENT_VERIFICATION_OUTPUT_SCHEMA }
              : {}),
        }),
        async (event) => {
          const now = Date.now();
          if (now - lastActivityPersistedAt >= SUBAGENT_ACTIVITY_PERSIST_INTERVAL_MS) {
            this.sessionStore.updateSession(agentId, {});
            lastActivityPersistedAt = now;
          }
          if (event.kind === 'tool_result' && 'function' in event.toolCall) {
            recordModifiedFiles(
              modifiedFiles,
              event.toolCall.function.name,
              event.result,
              context.workspaceRoot
            );
            recordVerificationEvidence(
              verificationCommands,
              event.toolCall.function.name,
              event.result,
              context.workspaceRoot
            );
          }
          try {
            await onEvent?.(event, agentId);
          } catch (eventError) {
            logger.warn(`Subagent event observer failed: ${agentId}`, eventError);
          }
        }
      );

      this.sessionStore.updateSession(agentId, {
        messages: context.messages,
      });

      const duration = Date.now() - startTime;
      const result: SubagentResult = loopResult.success
        ? {
            success: true,
            message: loopResult.finalMessage || '',
            agentId,
            verificationCommands: [...verificationCommands],
            verificationVerdict:
              config.name === GOAL_VERIFICATION_SUBAGENT_TYPE
                ? goalVerificationVerdictFromOutput(
                    loopResult.metadata?.structuredOutput
                  )
                : isVerificationAuditSubagent(config.name)
                  ? (independentVerificationVerdictFromOutput(
                      loopResult.metadata?.structuredOutput
                    ) ?? parseVerificationVerdict(loopResult.finalMessage))
                  : undefined,
            modifiedFiles: [...modifiedFiles],
            stats: {
              tokens: loopResult.metadata?.tokensUsed || 0,
              toolCalls: loopResult.metadata?.toolCallsCount || 0,
              duration,
            },
          }
        : {
            success: false,
            message: '',
            agentId,
            error: loopResult.error?.message || 'Unknown error',
            stats: { duration },
          };
      const worktreeOutcome = await finalizeWorktree(result.success);
      if (worktreeOutcome?.preserved) {
        result.worktreePath = worktreeOutcome.worktreePath;
        result.worktreeBranch = worktreeOutcome.worktreeBranch;
        result.worktree = worktreeOutcome.worktree;
      }

      const completedSession = this.sessionStore.markCompleted(
        agentId,
        {
          success: result.success,
          message: result.message,
          error: result.error,
          verificationCommands: result.verificationCommands,
          verificationVerdict: result.verificationVerdict,
          modifiedFiles: result.modifiedFiles,
        },
        result.stats
      );
      if (completedSession) {
        try {
          await onCompleted?.(completedSession);
        } catch (notificationError) {
          logger.warn(
            `Subagent completion observer failed: ${agentId}`,
            notificationError
          );
        }
      }

      logger.info(`Background agent completed: ${agentId} (success=${result.success})`);
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      let worktreeOutcome: Awaited<ReturnType<typeof finalizeWorktree>> | undefined;
      try {
        worktreeOutcome = await finalizeWorktree(false);
      } catch (finalizeError) {
        logger.warn(
          `Failed to preserve worktree for background agent ${agentId}`,
          finalizeError
        );
      }

      const completedSession = this.sessionStore.markCompleted(
        agentId,
        {
          success: false,
          message: '',
          error: errorMessage,
        },
        { duration }
      );
      if (completedSession) {
        try {
          await onCompleted?.(completedSession);
        } catch (notificationError) {
          logger.warn(
            `Subagent completion observer failed: ${agentId}`,
            notificationError
          );
        }
      }

      logger.warn(`Background agent failed: ${agentId}`, error);

      return {
        success: false,
        message: '',
        agentId,
        error: errorMessage,
        stats: { duration },
        worktreePath: worktreeOutcome?.worktreePath,
        worktreeBranch: worktreeOutcome?.worktreeBranch,
        worktree: worktreeOutcome?.worktree,
      };
    } finally {
      this.activeRuntimes.delete(agentId);
      try {
        if (agent && typeof agent.destroy === 'function') {
          await agent.destroy();
        }
      } finally {
        await runtime?.dispose();
      }
    }
  }

  /**
   * 获取 Agent 状态
   */
  getAgent(
    agentId: string,
    owner?: AgentSessionOwner | string
  ): AgentSession | undefined {
    const session = this.sessionStore.loadSession(agentId);
    if (!session || owner === undefined) return session;
    if (typeof owner === 'string') {
      return session.parentSessionId === owner ? session : undefined;
    }
    return isAgentSessionOwnedBy(session, owner) ? session : undefined;
  }

  /**
   * 检查 Agent 是否正在运行
   */
  isRunning(agentId: string): boolean {
    return this.runningAgents.has(agentId);
  }

  async enqueueSteering(
    agentId: string,
    content: string,
    owner?: AgentSessionOwner
  ): Promise<boolean> {
    if (owner && !this.getAgent(agentId, owner)) return false;
    const runtime = this.activeRuntimes.get(agentId);
    if (!runtime) return false;
    const result = await runtime.enqueueSteering(content, {
      allowBeforeTurn: true,
    });
    return result.accepted;
  }

  /**
   * 等待 Agent 完成
   * @param agentId Agent ID
   * @param timeout 超时时间（毫秒），0 表示无限等待
   * @returns Agent 会话，如果超时返回 undefined
   */
  async waitForCompletion(
    agentId: string,
    timeout: number = 30000,
    owner?: AgentSessionOwner | string
  ): Promise<AgentSession | undefined> {
    if (owner !== undefined && !this.getAgent(agentId, owner)) {
      return undefined;
    }
    const runtime = this.runningAgents.get(agentId);

    if (!runtime) {
      // 不在运行中，直接返回会话
      return this.getAgent(agentId, owner);
    }

    // 等待执行完成或超时
    if (timeout > 0) {
      const timeoutPromise = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), timeout)
      );

      const result = await Promise.race([runtime.promise, timeoutPromise]);

      if (result === 'timeout') {
        // 返回当前状态（仍在运行）
        return this.getAgent(agentId, owner);
      }
    } else {
      // 无限等待
      await runtime.promise;
    }

    // 返回最终状态
    return this.getAgent(agentId, owner);
  }

  /**
   * 恢复 Agent（用于 resume 功能）
   * @param agentId 要恢复的 agent ID
   * @param newPrompt 新的 prompt
   * @param config Subagent 配置
   * @returns 新的 agent ID（如果创建了新 agent）或原 ID（如果继续执行）
   */
  resumeAgent(options: ResumeAgentOptions): ResumeAgentResult | undefined {
    const {
      agentId,
      prompt,
      config,
      permissionMode,
      reasoningEffort,
      serviceTier,
      responseVerbosity,
      communicationStyle,
      newAgentId = createSessionId('agent'),
      agentResources,
      modelResources,
      lspResources,
      onEvent,
      onCompleted,
    } = options;
    const owner = normalizeAgentSessionOwner(options.owner);
    const session = this.getAgent(agentId, owner);

    if (!session) {
      logger.warn(`Cannot resume agent ${agentId}: session not found`);
      return undefined;
    }

    if (session.subagentType !== config.name) {
      logger.warn(
        `Cannot resume agent ${agentId}: requested type ${config.name} does not match ${session.subagentType}`
      );
      return undefined;
    }

    if (session.restartRecovery?.outcome === 'failed') {
      logger.warn(`Cannot resume agent ${agentId}: restart recovery failed`);
      return undefined;
    }

    // 如果仍在运行，不能恢复
    if (this.isRunning(agentId) || session.status === 'running') {
      logger.warn(`Cannot resume agent ${agentId}: still running`);
      return undefined;
    }

    if (newAgentId === agentId) {
      logger.warn(`Cannot resume agent ${agentId}: new run must use a new ID`);
      return undefined;
    }

    const effectiveConfig: SubagentConfig = session.configSnapshot
      ? { ...session.configSnapshot }
      : config;
    const resumedId = this.startBackgroundAgent({
      config: effectiveConfig,
      description: session.description,
      prompt,
      parentSessionId: owner.sessionId,
      providerAdmissionOwnerId: session.providerAdmissionOwnerId ?? owner.sessionId,
      parentProjectPath: owner.projectPath,
      permissionMode,
      reasoningEffort,
      serviceTier,
      responseVerbosity,
      communicationStyle,
      agentId: newAgentId,
      existingMessages: session.messages,
      taskListId: session.taskListId,
      teamId: session.teamId,
      workspaceRoot: session.workspaceRoot,
      isolation: session.isolation,
      restoredWorktree: session.worktree,
      rootAgentId: session.rootAgentId,
      resumedFrom: session.id,
      resumeDepth: session.resumeDepth + 1,
      agentResources,
      modelResources,
      lspResources,
      onEvent,
      onCompleted,
    });
    return { agentId: resumedId, source: session };
  }

  /**
   * 取消/终止 Agent
   */
  killAgent(agentId: string, owner?: AgentSessionOwner): boolean {
    if (owner && !this.getAgent(agentId, owner)) return false;
    const runtime = this.runningAgents.get(agentId);

    if (!runtime) {
      // 不在运行中
      const session = this.sessionStore.loadSession(agentId);
      if (session && session.status === 'running') {
        // 更新状态为已取消
        this.sessionStore.updateSession(agentId, { status: 'cancelled' });
      }
      return false;
    }

    // 发送取消信号
    runtime.abortController.abort();

    // 更新状态
    this.sessionStore.updateSession(agentId, { status: 'cancelled' });

    logger.info(`Background agent cancelled: ${agentId}`);
    return true;
  }

  /**
   * 列出所有后台 Agent
   */
  listAll(): AgentSession[] {
    return this.sessionStore.listSessions();
  }

  listForSession(owner: AgentSessionOwner | string): AgentSession[] {
    return this.sessionStore
      .listSessions()
      .filter((session) =>
        typeof owner === 'string'
          ? session.parentSessionId === owner
          : isAgentSessionOwnedBy(session, owner)
      );
  }

  /**
   * 列出运行中的 Agent
   */
  listRunning(): AgentSession[] {
    return this.sessionStore.listRunningSessions();
  }

  /**
   * 获取运行中 Agent 的数量
   */
  getRunningCount(): number {
    return this.runningAgents.size;
  }

  /**
   * 终止所有运行中的 Agent
   */
  killAll(): void {
    for (const [agentId] of this.runningAgents) {
      this.killAgent(agentId);
    }
  }

  /**
   * 清理过期会话
   */
  cleanupExpiredSessions(maxAgeMs?: number): number {
    return this.sessionStore.cleanupExpiredSessions(maxAgeMs);
  }

  cleanupExpiredSessionsForParent(
    owner: AgentSessionOwner | string,
    maxAgeMs: number = 7 * 24 * 60 * 60 * 1000
  ): number {
    const now = Date.now();
    let cleaned = 0;
    for (const session of this.listForSession(owner)) {
      if (session.status === 'running') continue;
      if (now - session.lastActiveAt <= maxAgeMs) continue;
      if (this.sessionStore.deleteSession(session.id)) cleaned++;
    }
    return cleaned;
  }
}

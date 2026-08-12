import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import type { SubagentInfoForContext } from '../../agent/types.js';
import type { ContentPart } from '../../services/ChatServiceInterface.js';
import { materializeSessionEvents } from '../../services/sessionRewind.js';
import type { JsonValue, MessageRole } from '../../store/types.js';
import { getCwd } from '../../utils/cwd.js';
import { getVersion } from '../../utils/packageInfo.js';
import {
  COMPACTION_CHECKPOINT_VERSION,
  type CompactionPersistenceMetadata,
  serializeCompactionReplacementMessages,
} from '../compactionCheckpoint.js';
import { SessionEventLog } from '../events/SessionEventLog.js';
import { projectTurnLifecycle } from '../events/turnLifecycle.js';
import type {
  ConversationContext,
  MessageInfo,
  MessagePersistenceMetadata,
  PartInfo,
  SessionContext,
  SessionEvent,
  SessionInfo,
  SessionInteractionRecoveryInfo,
  SessionInteractionRequestInfo,
  SessionInteractionResponseInfo,
  SessionReviewCompletionInfo,
  SessionReviewStartInfo,
  SessionTurnAbortInfo,
  SessionTurnCompletionInfo,
  SessionTurnFinalizationInfo,
  SessionTurnStartInfo,
  SubagentRunRef,
} from '../types.js';
import { JSONLStore } from './JSONLStore.js';
import {
  detectGitBranch,
  getProjectStoragePath,
  getSessionFilePath,
  getSessionInboxFilePath,
  listProjectDirectories,
} from './pathUtils.js';

class TurnLifecycleNoop extends Error {}

export const PROCESS_RESTART_TOOL_RESULT =
  'Tool execution was interrupted by a process restart. The operation may have ' +
  'partially completed. Inspect the workspace, running processes, and external ' +
  'state before deciding whether to retry it.';

export interface SessionTurnRecovery {
  turnId: string;
  outcome: 'completed' | 'aborted';
}

interface DurableToolCall {
  toolCallId: string;
  toolName: string;
}

const MAX_TURN_FINALIZATION_INPUTS = 20;
const MAX_TURN_FINALIZATION_TURNS = 10_000;
const MAX_TURN_FINALIZATION_TOOL_CALLS = 100_000;
const MAX_TURN_FINALIZATION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

function durableTurnFinalization(
  source: readonly SessionEvent[],
  turnId: string
): SessionTurnFinalizationInfo | undefined {
  const events = materializeSessionEvents(source);
  const turnStartIndex = events.findLastIndex(
    (event) => event.type === 'turn_started' && event.data.turnId === turnId
  );
  if (turnStartIndex < 0) return undefined;

  for (let index = events.length - 1; index > turnStartIndex; index--) {
    const event = events[index];
    if (event?.type !== 'message_created') continue;
    const metadata = event.data.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      continue;
    }
    const receipt = metadata.turnFinalization;
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      continue;
    }
    const inputMessageIds = receipt.inputMessageIds;
    const turnsCount = receipt.turnsCount;
    const toolCallsCount = receipt.toolCallsCount;
    const durationMs = receipt.durationMs;
    const validInputMessageIds = Array.isArray(inputMessageIds)
      ? inputMessageIds.filter(
          (messageId): messageId is string =>
            typeof messageId === 'string' &&
            messageId.length > 0 &&
            messageId.length <= 128
        )
      : [];
    if (
      receipt.turnId !== turnId ||
      turnId.length === 0 ||
      turnId.length > 128 ||
      !Array.isArray(inputMessageIds) ||
      inputMessageIds.length > MAX_TURN_FINALIZATION_INPUTS ||
      validInputMessageIds.length !== inputMessageIds.length ||
      typeof turnsCount !== 'number' ||
      !Number.isSafeInteger(turnsCount) ||
      turnsCount < 0 ||
      turnsCount > MAX_TURN_FINALIZATION_TURNS ||
      typeof toolCallsCount !== 'number' ||
      !Number.isSafeInteger(toolCallsCount) ||
      toolCallsCount < 0 ||
      toolCallsCount > MAX_TURN_FINALIZATION_TOOL_CALLS ||
      typeof durationMs !== 'number' ||
      !Number.isSafeInteger(durationMs) ||
      durationMs < 0 ||
      durationMs > MAX_TURN_FINALIZATION_DURATION_MS
    ) {
      continue;
    }
    return {
      turnId,
      inputMessageIds: [...new Set(validInputMessageIds)],
      turnsCount,
      toolCallsCount,
      durationMs,
    };
  }
  return undefined;
}

function durableToolCalls(
  source: readonly SessionEvent[],
  turnId?: string
): { all: DurableToolCall[]; orphaned: DurableToolCall[] } {
  const events = materializeSessionEvents(source);
  const turnStartIndex = turnId
    ? events.findLastIndex(
        (event) => event.type === 'turn_started' && event.data.turnId === turnId
      )
    : -1;
  if (turnId && turnStartIndex < 0) return { all: [], orphaned: [] };

  const calls = new Map<string, DurableToolCall>();
  const results = new Set<string>();
  const interactionCalls = new Set<string>();
  for (const event of events.slice(turnStartIndex + 1)) {
    if (event.type === 'interaction_requested') {
      interactionCalls.add(event.data.toolCallId);
      continue;
    }
    if (event.type !== 'part_created') continue;
    const payload =
      event.data.payload &&
      typeof event.data.payload === 'object' &&
      !Array.isArray(event.data.payload)
        ? (event.data.payload as Record<string, unknown>)
        : {};
    const toolCallId =
      typeof payload.toolCallId === 'string' ? payload.toolCallId : event.data.partId;
    if (event.data.partType === 'tool_call') {
      calls.set(toolCallId, {
        toolCallId,
        toolName: typeof payload.toolName === 'string' ? payload.toolName : 'unknown',
      });
    } else if (event.data.partType === 'tool_result') {
      results.add(toolCallId);
      results.add(event.data.partId);
      results.add(event.data.messageId);
    }
  }

  const all = [...calls.values()];
  return {
    all,
    orphaned: all.filter(
      (call) => !results.has(call.toolCallId) && !interactionCalls.has(call.toolCallId)
    ),
  };
}

/**
 * 持久化存储实现 - JSONL 格式
 * 存储路径: ~/.blade/projects/{escaped-path}/{sessionId}.jsonl
 */
export class PersistentStore {
  private readonly projectPath: string;
  private readonly maxSessions: number;
  private readonly version: string;

  constructor(
    projectPath: string = getCwd(),
    maxSessions: number = 100,
    version: string = getVersion()
  ) {
    this.projectPath = projectPath;
    this.maxSessions = maxSessions;
    this.version = version;
  }

  private createEvent<T extends SessionEvent['type']>(
    type: T,
    sessionId: string,
    data: Extract<SessionEvent, { type: T }>['data']
  ): SessionEvent {
    return {
      id: nanoid(),
      sessionId,
      projectPath: this.projectPath,
      timestamp: new Date().toISOString(),
      type,
      cwd: this.projectPath,
      gitBranch: detectGitBranch(this.projectPath),
      version: this.version,
      data,
    } as SessionEvent;
  }

  /** The single writer for a session's stream: persists + fans out atomically. */
  private log(sessionId: string): SessionEventLog {
    return SessionEventLog.for(sessionId, this.projectPath);
  }

  private async ensureSessionCreated(
    sessionId: string,
    subagentInfo?: SubagentInfoForContext
  ): Promise<void> {
    const filePath = getSessionFilePath(this.projectPath, sessionId);
    const store = new JSONLStore(filePath);
    const entries = await store.readAll();
    if (entries.length > 0) return;
    const now = new Date().toISOString();
    const sessionInfo: SessionInfo = {
      sessionId,
      rootId: subagentInfo?.parentSessionId ?? sessionId,
      parentId: subagentInfo?.parentSessionId,
      relationType: subagentInfo ? 'subagent' : undefined,
      resumedFrom: subagentInfo?.resumedFrom,
      rootAgentId: subagentInfo?.rootAgentId,
      resumeDepth: subagentInfo?.resumeDepth,
      title: undefined,
      status: 'running',
      taskStatus: subagentInfo ? 'running' : 'queued',
      taskFailure: null,
      agentType: subagentInfo?.subagentType,
      model: undefined,
      permission: undefined,
      createdAt: now,
      updatedAt: now,
    };
    const entry = this.createEvent('session_created', sessionId, sessionInfo);
    await this.log(sessionId).commit(entry);
  }

  private buildCompactionMetadata(metadata: CompactionPersistenceMetadata): JsonValue {
    const result: Record<string, JsonValue> = {
      trigger: metadata.trigger,
      preTokens: metadata.preTokens,
    };
    if (metadata.reason) result.reason = metadata.reason;
    if (metadata.strategy) result.strategy = metadata.strategy;
    if (metadata.postTokens !== undefined) result.postTokens = metadata.postTokens;
    if (metadata.filesIncluded) result.filesIncluded = metadata.filesIncluded;
    if (metadata.replacementMessages) {
      result.checkpointVersion = COMPACTION_CHECKPOINT_VERSION;
    }
    return result;
  }

  /**
   * 初始化存储目录
   */
  async initialize(): Promise<void> {
    try {
      const storagePath = getProjectStoragePath(this.projectPath);
      await fs.mkdir(storagePath, { recursive: true, mode: 0o755 });
      console.log(`[PersistentStore] 初始化存储目录: ${storagePath}`);
    } catch (error) {
      console.warn('[PersistentStore] 无法创建持久化存储目录:', error);
    }
  }

  /**
   * 保存消息到 JSONL 文件（追加模式）
   */
  async saveMessage(
    sessionId: string,
    messageRole: MessageRole,
    content: string | ContentPart[],
    parentUuid: string | null = null,
    metadata?: MessagePersistenceMetadata,
    subagentInfo?: SubagentInfoForContext,
    reasoningContent?: string
  ): Promise<string> {
    try {
      await this.ensureSessionCreated(sessionId, subagentInfo);
      const now = new Date().toISOString();
      const messageId = nanoid();
      const messageInfo: MessageInfo = {
        messageId,
        role: messageRole,
        parentMessageId: parentUuid ?? undefined,
        inboxMessageId: metadata?.inboxMessageId,
        createdAt: now,
        model: metadata?.model,
        usage: metadata?.usage,
        metadata: metadata
          ? (JSON.parse(JSON.stringify(metadata)) as JsonValue)
          : undefined,
      };
      const messageEntry = this.createEvent('message_created', sessionId, messageInfo);
      const reasoningEntries =
        messageRole === 'assistant' && reasoningContent?.trim()
          ? [
              this.createEvent('part_created', sessionId, {
                partId: nanoid(),
                messageId,
                partType: 'reasoning',
                payload: { text: reasoningContent },
                createdAt: now,
              }),
            ]
          : [];
      const partEntries =
        typeof content === 'string'
          ? [
              this.createEvent('part_created', sessionId, {
                partId: nanoid(),
                messageId,
                partType: 'text',
                payload: { text: content },
                createdAt: now,
              }),
            ]
          : content.map((part) =>
              this.createEvent('part_created', sessionId, {
                partId: nanoid(),
                messageId,
                partType: part.type === 'text' ? 'text' : 'image',
                payload:
                  part.type === 'text'
                    ? { text: part.text }
                    : {
                        mimeType:
                          extractMimeTypeFromDataUrl(part.image_url.url) ?? 'image/png',
                        dataUrl: part.image_url.url,
                      },
                createdAt: now,
              })
            );
      await this.log(sessionId).commitBatch([
        messageEntry,
        ...reasoningEntries,
        ...partEntries,
      ]);
      return messageId;
    } catch (error) {
      console.error(`[PersistentStore] 保存消息失败 (session: ${sessionId}):`, error);
      throw error;
    }
  }

  async acknowledgeInboxMessages(
    sessionId: string,
    messageIds: readonly string[]
  ): Promise<void> {
    if (messageIds.length === 0) return;
    await this.ensureSessionCreated(sessionId);
    const acknowledgedAt = new Date().toISOString();
    await this.log(sessionId).commit(
      this.createEvent('inbox_acknowledged', sessionId, {
        messageIds: [...messageIds],
        acknowledgedAt,
      })
    );
  }

  async saveTurnStart(sessionId: string, turn: SessionTurnStartInfo): Promise<void> {
    await this.ensureSessionCreated(sessionId);
    try {
      await this.log(sessionId).commitValidated((events) => {
        const projected = materializeSessionEvents(events);
        if (
          projected.some(
            (event) =>
              event.type === 'turn_started' && event.data.turnId === turn.turnId
          )
        ) {
          throw new TurnLifecycleNoop();
        }
        const active = projectTurnLifecycle(projected).active;
        if (active) {
          throw new Error(`Session already has an active turn: ${active.turnId}`);
        }
        return this.createEvent('turn_started', sessionId, turn);
      });
    } catch (error) {
      if (!(error instanceof TurnLifecycleNoop)) throw error;
    }
  }

  async saveTurnCompletion(
    sessionId: string,
    turn: SessionTurnCompletionInfo,
    inputMessageIds: readonly string[] = []
  ): Promise<void> {
    await this.ensureSessionCreated(sessionId);
    try {
      await this.log(sessionId).commitValidatedBatch((events) => {
        const projected = materializeSessionEvents(events);
        const acknowledgedIds = new Set(
          projected.flatMap((event) =>
            event.type === 'inbox_acknowledged' ? event.data.messageIds : []
          )
        );
        const missingIds = [...new Set(inputMessageIds)].filter(
          (messageId) => !acknowledgedIds.has(messageId)
        );
        const terminal = projected.findLast(
          (event) =>
            (event.type === 'turn_completed' || event.type === 'turn_aborted') &&
            event.data.turnId === turn.turnId
        );
        if (terminal) {
          if (terminal.type === 'turn_aborted' || missingIds.length === 0) {
            throw new TurnLifecycleNoop();
          }
          return [
            this.createEvent('inbox_acknowledged', sessionId, {
              messageIds: missingIds,
              acknowledgedAt: turn.completedAt,
            }),
          ];
        }

        const active = projectTurnLifecycle(projected).active;
        if (!active || active.turnId !== turn.turnId) {
          throw new Error(`Turn is not active: ${turn.turnId}`);
        }
        return [
          ...(missingIds.length > 0
            ? [
                this.createEvent('inbox_acknowledged', sessionId, {
                  messageIds: missingIds,
                  acknowledgedAt: turn.completedAt,
                }),
              ]
            : []),
          this.createEvent('turn_completed', sessionId, turn),
        ];
      });
    } catch (error) {
      if (!(error instanceof TurnLifecycleNoop)) throw error;
    }
  }

  async saveTurnAbort(sessionId: string, turn: SessionTurnAbortInfo): Promise<void> {
    await this.saveTurnTerminal(sessionId, 'turn_aborted', turn);
  }

  async recoverInterruptedTurn(
    sessionId: string
  ): Promise<SessionTurnRecovery | undefined> {
    await this.ensureSessionCreated(sessionId);
    let recovery: SessionTurnRecovery | undefined;
    try {
      await this.log(sessionId).commitValidatedBatch((events) => {
        const projected = materializeSessionEvents(events);
        const active = projectTurnLifecycle(projected).active;
        const toolCalls = durableToolCalls(projected);
        if (!active && toolCalls.orphaned.length === 0) {
          throw new TurnLifecycleNoop();
        }
        const finalization = active
          ? durableTurnFinalization(projected, active.turnId)
          : undefined;
        if (active && finalization && toolCalls.orphaned.length === 0) {
          recovery = { turnId: active.turnId, outcome: 'completed' };
          const acknowledgedIds = new Set(
            projected.flatMap((event) =>
              event.type === 'inbox_acknowledged' ? event.data.messageIds : []
            )
          );
          const missingIds = finalization.inputMessageIds.filter(
            (messageId) => !acknowledgedIds.has(messageId)
          );
          const completedAt = new Date().toISOString();
          return [
            ...(missingIds.length > 0
              ? [
                  this.createEvent('inbox_acknowledged', sessionId, {
                    messageIds: missingIds,
                    acknowledgedAt: completedAt,
                  }),
                ]
              : []),
            this.createEvent('turn_completed', sessionId, {
              turnId: active.turnId,
              completedAt,
              turnsCount: finalization.turnsCount,
              toolCallsCount: finalization.toolCallsCount,
              durationMs: finalization.durationMs,
            }),
          ];
        }
        recovery = active ? { turnId: active.turnId, outcome: 'aborted' } : undefined;
        const activeToolCalls = active
          ? durableToolCalls(projected, active.turnId).all.length
          : 0;
        const now = new Date().toISOString();
        const startedAt = active ? Date.parse(active.startedAt) : Number.NaN;
        const recoveryResults = toolCalls.orphaned.map((call) =>
          this.createEvent('part_created', sessionId, {
            partId: call.toolCallId,
            messageId: call.toolCallId,
            partType: 'tool_result',
            payload: {
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: null,
              error: PROCESS_RESTART_TOOL_RESULT,
              metadata: {
                processRestartRecovery: true,
                sideEffectsUncertain: true,
              },
            },
            createdAt: now,
          })
        );
        return active
          ? [
              ...recoveryResults,
              this.createEvent('turn_aborted', sessionId, {
                turnId: active.turnId,
                cause: 'process_restart',
                abortedAt: now,
                turnsCount: 0,
                toolCallsCount: activeToolCalls,
                durationMs: Number.isFinite(startedAt)
                  ? Math.max(0, Date.now() - startedAt)
                  : 0,
              }),
            ]
          : recoveryResults;
      });
    } catch (error) {
      if (!(error instanceof TurnLifecycleNoop)) throw error;
    }
    return recovery;
  }

  async saveInteractionRequest(
    sessionId: string,
    request: SessionInteractionRequestInfo
  ): Promise<void> {
    await this.ensureSessionCreated(sessionId);
    await this.log(sessionId).commitValidated((events) => {
      const duplicate = events.some(
        (event) =>
          event.type === 'interaction_requested' &&
          event.data.requestId === request.requestId
      );
      if (duplicate) {
        throw new Error(`Interaction request already exists: ${request.requestId}`);
      }
      return this.createEvent('interaction_requested', sessionId, request);
    });
  }

  async saveInteractionResponse(
    sessionId: string,
    response: SessionInteractionResponseInfo
  ): Promise<void> {
    await this.ensureSessionCreated(sessionId);
    await this.log(sessionId).commitValidated((events) => {
      const requested = events.some(
        (event) =>
          event.type === 'interaction_requested' &&
          event.data.requestId === response.requestId
      );
      if (!requested) {
        throw new Error(`Interaction request not found: ${response.requestId}`);
      }
      const duplicate = events.some(
        (event) =>
          event.type === 'interaction_responded' &&
          event.data.requestId === response.requestId
      );
      if (duplicate) {
        throw new Error(`Interaction already responded: ${response.requestId}`);
      }
      return this.createEvent('interaction_responded', sessionId, response);
    });
  }

  async saveInteractionRecovery(
    sessionId: string,
    recovery: SessionInteractionRecoveryInfo
  ): Promise<void> {
    await this.ensureSessionCreated(sessionId);
    await this.log(sessionId).commitValidated((events) => {
      const responded = events.some(
        (event) =>
          event.type === 'interaction_responded' &&
          event.data.requestId === recovery.requestId
      );
      if (!responded) {
        throw new Error(`Interaction response not found: ${recovery.requestId}`);
      }
      const duplicate = events.some(
        (event) =>
          event.type === 'interaction_recovered' &&
          event.data.requestId === recovery.requestId
      );
      if (duplicate) {
        throw new Error(`Interaction already recovered: ${recovery.requestId}`);
      }
      return this.createEvent('interaction_recovered', sessionId, recovery);
    });
  }

  async saveReviewStart(
    sessionId: string,
    review: SessionReviewStartInfo
  ): Promise<void> {
    await this.ensureSessionCreated(sessionId);
    await this.log(sessionId).commitValidated((events) => {
      const duplicate = events.some(
        (event) =>
          event.type === 'review_started' && event.data.reviewId === review.reviewId
      );
      if (duplicate) {
        throw new Error(`Review already exists: ${review.reviewId}`);
      }
      const active = events.some(
        (event) =>
          event.type === 'review_started' &&
          !events.some(
            (candidate) =>
              candidate.type === 'review_completed' &&
              candidate.data.reviewId === event.data.reviewId
          )
      );
      if (active) {
        throw new Error('Session already has an active review');
      }
      return this.createEvent('review_started', sessionId, review);
    });
  }

  async saveReviewCompletion(
    sessionId: string,
    review: SessionReviewCompletionInfo
  ): Promise<void> {
    await this.ensureSessionCreated(sessionId);
    await this.log(sessionId).commitValidated((events) => {
      const started = events.some(
        (event) =>
          event.type === 'review_started' && event.data.reviewId === review.reviewId
      );
      if (!started) {
        throw new Error(`Review not found: ${review.reviewId}`);
      }
      const duplicate = events.some(
        (event) =>
          event.type === 'review_completed' && event.data.reviewId === review.reviewId
      );
      if (duplicate) {
        throw new Error(`Review already completed: ${review.reviewId}`);
      }
      return this.createEvent('review_completed', sessionId, review);
    });
  }

  /**
   * 保存工具调用到 JSONL 文件
   */
  async saveToolUse(
    sessionId: string,
    toolName: string,
    toolInput: JsonValue,
    parentUuid: string | null = null,
    subagentInfo?: SubagentInfoForContext
  ): Promise<string> {
    try {
      await this.ensureSessionCreated(sessionId, subagentInfo);
      const now = new Date().toISOString();
      const messageId = parentUuid ?? nanoid();
      const entries: SessionEvent[] = [];
      if (!parentUuid) {
        const messageInfo: MessageInfo = {
          messageId,
          role: 'assistant',
          parentMessageId: undefined,
          createdAt: now,
        };
        entries.push(this.createEvent('message_created', sessionId, messageInfo));
      }
      const toolCallId = nanoid();
      const partInfo: PartInfo = {
        partId: toolCallId,
        messageId,
        partType: 'tool_call',
        payload: { toolCallId, toolName, input: toolInput },
        createdAt: now,
      };
      entries.push(this.createEvent('part_created', sessionId, partInfo));
      if (toolName === 'Task' && toolInput && typeof toolInput === 'object') {
        const subtaskInput = toolInput as Record<string, unknown>;
        const childSessionId =
          typeof subtaskInput.subagent_session_id === 'string'
            ? subtaskInput.subagent_session_id
            : undefined;
        const agentType =
          typeof subtaskInput.subagent_type === 'string'
            ? subtaskInput.subagent_type
            : undefined;
        if (childSessionId && agentType) {
          const subtaskPart: PartInfo = {
            partId: nanoid(),
            messageId,
            partType: 'subtask_ref',
            payload: {
              childSessionId,
              agentType,
              status: 'running',
              summary:
                typeof subtaskInput.description === 'string'
                  ? subtaskInput.description
                  : '',
              startedAt: now,
            },
            createdAt: now,
          };
          entries.push(this.createEvent('part_created', sessionId, subtaskPart));
        }
      }
      await this.log(sessionId).commitBatch(entries);
      return toolCallId;
    } catch (error) {
      console.error(
        `[PersistentStore] 保存工具调用失败 (session: ${sessionId}):`,
        error
      );
      throw error;
    }
  }

  /**
   * 保存工具结果到 JSONL 文件
   */
  async saveToolResult(
    sessionId: string,
    toolId: string,
    toolName: string,
    toolOutput: JsonValue,
    parentUuid: string | null = null,
    error?: string,
    subagentInfo?: SubagentInfoForContext,
    subagentRef?: SubagentRunRef,
    toolMetadata?: JsonValue
  ): Promise<string> {
    try {
      await this.ensureSessionCreated(sessionId, subagentInfo);
      const now = new Date().toISOString();
      const messageId = parentUuid ?? nanoid();
      const entries: SessionEvent[] = [];
      if (!parentUuid) {
        const messageInfo: MessageInfo = {
          messageId,
          role: 'assistant',
          parentMessageId: undefined,
          createdAt: now,
        };
        entries.push(this.createEvent('message_created', sessionId, messageInfo));
      }
      const toolResultPart: PartInfo = {
        partId: toolId,
        messageId,
        partType: 'tool_result',
        payload: {
          toolCallId: toolId,
          toolName,
          output: toolOutput,
          error: error ?? null,
          ...(toolMetadata === undefined ? {} : { metadata: toolMetadata }),
        },
        createdAt: now,
      };
      entries.push(this.createEvent('part_created', sessionId, toolResultPart));
      if (subagentRef) {
        const finishedAt = subagentRef.subagentStatus === 'running' ? null : now;
        const subtaskPart: PartInfo = {
          partId: nanoid(),
          messageId,
          partType: 'subtask_ref',
          payload: {
            childSessionId: subagentRef.subagentSessionId,
            agentType: subagentRef.subagentType,
            description: subagentRef.subagentDescription ?? '',
            status: subagentRef.subagentStatus,
            summary: subagentRef.subagentSummary ?? '',
            resumedFrom: subagentRef.subagentResumedFrom ?? null,
            rootAgentId: subagentRef.subagentRootId ?? subagentRef.subagentSessionId,
            resumeDepth: subagentRef.subagentResumeDepth ?? 0,
            verificationVerdict: subagentRef.verificationVerdict ?? null,
            startedAt: now,
            finishedAt,
          },
          createdAt: now,
        };
        entries.push(this.createEvent('part_created', sessionId, subtaskPart));
      }
      await this.log(sessionId).commitBatch(entries);
      return toolId;
    } catch (error) {
      console.error(
        `[PersistentStore] 保存工具结果失败 (session: ${sessionId}):`,
        error
      );
      throw error;
    }
  }

  /**
   * 保存压缩边界和总结消息到 JSONL
   * 用于上下文压缩功能
   *
   * @param sessionId 会话 ID
   * @param summary 压缩总结内容
   * @param metadata 压缩元数据（触发方式、token 数量、包含的文件等）
   * @param parentUuid 最后一条保留消息的 UUID（用于建立消息链）
   * @returns 总结消息的 UUID
   */
  async saveCompaction(
    sessionId: string,
    summary: string,
    metadata: CompactionPersistenceMetadata,
    parentUuid: string | null = null
  ): Promise<string> {
    try {
      await this.ensureSessionCreated(sessionId);
      const now = new Date().toISOString();
      const messageId = nanoid();
      const messageInfo: MessageInfo = {
        messageId,
        role: 'system',
        parentMessageId: parentUuid ?? undefined,
        createdAt: now,
      };
      const compactMetadata = this.buildCompactionMetadata(metadata);
      const partInfo: PartInfo = {
        partId: nanoid(),
        messageId,
        partType: 'summary',
        payload: {
          text: summary,
          metadata: compactMetadata,
          ...(metadata.replacementMessages
            ? {
                replacementMessages: serializeCompactionReplacementMessages(
                  metadata.replacementMessages
                ),
              }
            : {}),
        },
        createdAt: now,
      };
      const entries = [
        this.createEvent('message_created', sessionId, messageInfo),
        this.createEvent('part_created', sessionId, partInfo),
      ];
      await this.log(sessionId).commitBatch(entries);
      return messageId;
    } catch (error) {
      console.error(`[PersistentStore] 保存压缩失败 (session: ${sessionId}):`, error);
      throw error;
    }
  }

  /**
   * 保存会话初始化事件到 JSONL
   * 仅创建 session_created 事件，不写入空消息
   */
  async initSession(
    sessionId: string,
    subagentInfo?: SubagentInfoForContext
  ): Promise<void> {
    await this.ensureSessionCreated(sessionId, subagentInfo);
  }

  /**
   * 加载会话的原始 JSONL 事件流
   */
  async loadEvents(sessionId: string): Promise<SessionEvent[] | null> {
    try {
      const filePath = getSessionFilePath(this.projectPath, sessionId);
      const store = new JSONLStore(filePath);
      const entries = await store.readAll();
      return entries.length > 0 ? materializeSessionEvents(entries) : null;
    } catch {
      return null;
    }
  }

  /**
   * 加载会话上下文（从 JSONL 重建）
   */
  async loadSession(sessionId: string): Promise<SessionContext | null> {
    try {
      const filePath = getSessionFilePath(this.projectPath, sessionId);
      const store = new JSONLStore(filePath);

      const entries = materializeSessionEvents(await store.readAll());
      if (entries.length === 0) return null;
      const firstEntry = entries.find((entry) => entry.type === 'session_created');

      return {
        sessionId,
        userId: undefined,
        preferences: {},
        configuration: {},
        startTime: new Date(firstEntry?.timestamp ?? entries[0].timestamp).getTime(),
      };
    } catch {
      return null;
    }
  }

  /**
   * 加载对话上下文（从 JSONL 重建）
   */
  async loadConversation(sessionId: string): Promise<ConversationContext | null> {
    try {
      const filePath = getSessionFilePath(this.projectPath, sessionId);
      const store = new JSONLStore(filePath);

      const entries = materializeSessionEvents(await store.readAll());
      if (entries.length === 0) return null;
      const messageMap = new Map<
        string,
        { id: string; role: MessageRole; content: string; timestamp: number }
      >();
      for (const entry of entries) {
        if (entry.type === 'message_created') {
          messageMap.set(entry.data.messageId, {
            id: entry.data.messageId,
            role: entry.data.role,
            content: '',
            timestamp: new Date(entry.timestamp).getTime(),
          });
        }
        if (entry.type === 'part_created' && entry.data.partType === 'text') {
          const message = messageMap.get(entry.data.messageId);
          if (message) {
            const payload = entry.data.payload as { text?: string };
            message.content = payload.text ?? '';
          }
        }
        if (entry.type === 'part_created' && entry.data.partType === 'image') {
          const message = messageMap.get(entry.data.messageId);
          if (message) {
            message.content = message.content
              ? `${message.content}\n[Image]`
              : '[Image]';
          }
        }
      }
      const messages = Array.from(messageMap.values());
      const lastEntry = entries[entries.length - 1];
      const lastActivity = new Date(lastEntry.timestamp).getTime();

      return {
        messages,
        topics: [],
        lastActivity,
      };
    } catch {
      return null;
    }
  }

  /**
   * 获取所有会话列表
   */
  async listSessions(): Promise<string[]> {
    try {
      const storagePath = getProjectStoragePath(this.projectPath);
      const files = await fs.readdir(storagePath);
      return files
        .filter((file) => file.endsWith('.jsonl'))
        .map((file) => file.replace('.jsonl', ''))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * 获取会话摘要信息
   */
  async getSessionSummary(sessionId: string): Promise<{
    sessionId: string;
    lastActivity: number;
    messageCount: number;
    topics: string[];
  } | null> {
    try {
      const filePath = getSessionFilePath(this.projectPath, sessionId);
      const store = new JSONLStore(filePath);

      const stats = await store.getStats();
      if (!stats.exists) return null;

      const rawEntries = await store.readAll();
      if (rawEntries.length === 0) return null;
      const entries = materializeSessionEvents(rawEntries);

      const lastEntry = rawEntries[rawEntries.length - 1];
      const messageCount = entries.filter(
        (entry) =>
          entry.type === 'message_created' &&
          ['user', 'assistant'].includes(entry.data.role)
      ).length;

      return {
        sessionId,
        lastActivity: new Date(lastEntry.timestamp).getTime(),
        messageCount,
        topics: [],
      };
    } catch {
      return null;
    }
  }

  /**
   * 删除会话数据
   */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      const filePath = getSessionFilePath(this.projectPath, sessionId);
      const store = new JSONLStore(filePath);
      await store.delete();
      await fs
        .unlink(getSessionInboxFilePath(this.projectPath, sessionId))
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      // Best-effort：同步清理 SQLite 投影行（派生缓存，失败不影响 JSONL 真相）。
      try {
        const { getProjectionDb, removeSessionFromProjection } = await import(
          './sqlite/projection.js'
        );
        const db = await getProjectionDb();
        if (db) removeSessionFromProjection(db, sessionId, this.projectPath);
      } catch {
        // 忽略：下次 syncAll 会 GC。
      }
    } catch (error) {
      console.warn(`[PersistentStore] 删除会话失败 (session: ${sessionId}):`, error);
    }
  }

  /**
   * 清理旧会话（保持最近的N个会话）
   */
  async cleanupOldSessions(): Promise<void> {
    try {
      const sessions = await this.listSessions();
      if (sessions.length <= this.maxSessions) {
        return;
      }

      // 获取所有会话的摘要信息并按时间排序
      const sessionSummaries = await Promise.all(
        sessions.map((sessionId) => this.getSessionSummary(sessionId))
      );

      const validSummaries = sessionSummaries
        .filter((summary): summary is NonNullable<typeof summary> => summary !== null)
        .sort((a, b) => b.lastActivity - a.lastActivity);

      // 删除最旧的会话
      const sessionsToDelete = validSummaries
        .slice(this.maxSessions)
        .map((summary) => summary.sessionId);

      await Promise.all(
        sessionsToDelete.map((sessionId) => this.deleteSession(sessionId))
      );

      console.log(`[PersistentStore] 已清理 ${sessionsToDelete.length} 个旧会话`);
    } catch (error) {
      console.error('[PersistentStore] 清理旧会话失败:', error);
    }
  }

  private async saveTurnTerminal(
    sessionId: string,
    type: 'turn_completed' | 'turn_aborted',
    turn: SessionTurnCompletionInfo | SessionTurnAbortInfo
  ): Promise<void> {
    await this.ensureSessionCreated(sessionId);
    try {
      await this.log(sessionId).commitValidated((events) => {
        const projected = materializeSessionEvents(events);
        const duplicate = projected.some(
          (event) =>
            (event.type === 'turn_completed' || event.type === 'turn_aborted') &&
            event.data.turnId === turn.turnId
        );
        if (duplicate) throw new TurnLifecycleNoop();

        const active = projectTurnLifecycle(projected).active;
        if (!active || active.turnId !== turn.turnId) {
          throw new Error(`Turn is not active: ${turn.turnId}`);
        }
        return type === 'turn_completed'
          ? this.createEvent(
              'turn_completed',
              sessionId,
              turn as SessionTurnCompletionInfo
            )
          : this.createEvent('turn_aborted', sessionId, turn as SessionTurnAbortInfo);
      });
    } catch (error) {
      if (!(error instanceof TurnLifecycleNoop)) throw error;
    }
  }

  /**
   * 获取存储统计信息
   */
  async getStorageStats(): Promise<{
    totalSessions: number;
    totalSize: number;
    projectPath: string;
  }> {
    try {
      const sessions = await this.listSessions();
      let totalSize = 0;

      for (const sessionId of sessions) {
        const filePath = getSessionFilePath(this.projectPath, sessionId);
        const store = new JSONLStore(filePath);
        const stats = await store.getStats();
        totalSize += stats.size;
      }

      return {
        totalSessions: sessions.length,
        totalSize,
        projectPath: this.projectPath,
      };
    } catch {
      return {
        totalSessions: 0,
        totalSize: 0,
        projectPath: this.projectPath,
      };
    }
  }

  /**
   * 检查存储健康状态
   */
  async checkStorageHealth(): Promise<{
    isAvailable: boolean;
    canWrite: boolean;
    error?: string;
  }> {
    try {
      const storagePath = getProjectStoragePath(this.projectPath);

      // 尝试创建目录
      await fs.mkdir(storagePath, { recursive: true, mode: 0o755 });

      // 尝试写入测试文件
      const testFile = path.join(storagePath, '.health-check');
      await fs.writeFile(testFile, 'test', 'utf-8');
      await fs.unlink(testFile);

      return {
        isAvailable: true,
        canWrite: true,
      };
    } catch (error) {
      return {
        isAvailable: false,
        canWrite: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 获取所有项目列表
   */
  static async listAllProjects(): Promise<string[]> {
    return listProjectDirectories();
  }
}

function extractMimeTypeFromDataUrl(dataUrl: string): string | null {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return match?.[1] ?? null;
}

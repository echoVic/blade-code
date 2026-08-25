import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import type { BackgroundSubagentCompletion } from '../../agent/subagents/BackgroundSubagentCompletion.js';
import type { SubagentInfoForContext } from '../../agent/types.js';
import { removeBrowserSessionArtifacts } from '../../browser/BrowserArtifactStore.js';
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
import {
  findCurrentTokenBudgetHandoff,
  TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX,
  type TokenBudgetHandoffRecordedV1,
  type ValidTokenBudgetHandoffEvent,
} from '../TokenBudgetHandoff.js';
import {
  type ConversationContext,
  MAX_TURN_INPUT_MESSAGE_ID_CHARS,
  MAX_TURN_INPUT_MESSAGE_IDS,
  type MessageInfo,
  type MessagePersistenceMetadata,
  type PartInfo,
  parseTurnInputMessageIds,
  type SessionContext,
  type SessionEvent,
  type SessionGoalFinalizationInfo,
  type SessionInfo,
  type SessionInteractionRecoveryInfo,
  type SessionInteractionRequestInfo,
  type SessionInteractionResponseInfo,
  type SessionReviewCompletionInfo,
  type SessionReviewStartInfo,
  type SessionTurnAbortInfo,
  type SessionTurnCompletionInfo,
  type SessionTurnFinalizationInfo,
  type SessionTurnStartInfo,
  type SubagentRunRef,
  turnAbortAppliedAcknowledgements,
} from '../types.js';
import { JSONLStore } from './JSONLStore.js';
import {
  detectGitBranch,
  getBladeStorageRoot,
  getProjectStoragePath,
  getSessionFilePath,
  getSessionInboxFilePath,
  listProjectDirectories,
} from './pathUtils.js';

class TurnLifecycleNoop extends Error {}

export interface RecordedTokenBudgetHandoff {
  outcome: 'created' | 'existing';
  event: ValidTokenBudgetHandoffEvent;
}

export interface SuppressedTokenBudgetHandoff {
  outcome: 'suppressed';
  recordId: string;
}

export type RecordTokenBudgetHandoffResult =
  | RecordedTokenBudgetHandoff
  | SuppressedTokenBudgetHandoff;

export const PROCESS_RESTART_TOOL_RESULT =
  'Tool execution was interrupted by a process restart. The operation may have ' +
  'partially completed. Inspect the workspace, running processes, and external ' +
  'state before deciding whether to retry it.';

export interface SessionTurnRecovery {
  turnId: string;
  outcome: 'completed' | 'aborted';
  inputMessageIds: string[];
  hadSuccessfulToolResult: boolean;
  emptyFinalCorrectionSpent: boolean;
  finalization?: SessionTurnFinalizationInfo;
}

function durableEmptyFinalCorrectionSpent(
  projected: readonly SessionEvent[],
  turnId: string
): boolean {
  const turnStartIndex = projected.findLastIndex(
    (event) => event.type === 'turn_started' && event.data.turnId === turnId
  );
  if (turnStartIndex < 0) return false;
  return projected.slice(turnStartIndex + 1).some((event) => {
    if (event.type !== 'message_created' || event.data.role !== 'user') {
      return false;
    }
    const metadata = event.data.metadata;
    return (
      metadata !== null &&
      typeof metadata === 'object' &&
      !Array.isArray(metadata) &&
      metadata.clientVisible === false &&
      metadata.emptyFinalCorrection === true
    );
  });
}

function durableTurnInputMessageIds(
  projected: readonly SessionEvent[],
  turnId: string
): string[] {
  const turnStartIndex = projected.findLastIndex(
    (event) => event.type === 'turn_started' && event.data.turnId === turnId
  );
  if (turnStartIndex < 0) return [];
  const appliedIds: string[] = [];
  for (const event of projected.slice(turnStartIndex + 1)) {
    if (
      (event.type === 'turn_started' && event.data.turnId !== turnId) ||
      ((event.type === 'turn_completed' || event.type === 'turn_aborted') &&
        event.data.turnId === turnId)
    ) {
      break;
    }
    if (event.type !== 'message_created' || event.data.role !== 'user') continue;
    const metadata = event.data.metadata;
    const inboxMessageId =
      event.data.inboxMessageId !== undefined
        ? event.data.inboxMessageId
        : metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
          ? metadata.inboxMessageId
          : undefined;
    if (
      typeof inboxMessageId === 'string' &&
      inboxMessageId.length > 0 &&
      inboxMessageId.length <= MAX_TURN_INPUT_MESSAGE_ID_CHARS
    ) {
      appliedIds.push(inboxMessageId);
    }
  }
  return [...new Set(appliedIds)];
}

interface ParsedTurnAbortReceipt {
  inputMessageIds: string[];
  hadSuccessfulToolResult: boolean;
  emptyFinalCorrectionSpent: boolean;
}

function parseTurnAbortReceipt(value: unknown): ParsedTurnAbortReceipt | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  if (!('version' in value) || value.version !== 1) return undefined;
  const inputMessageIds =
    'inputMessageIds' in value
      ? parseTurnInputMessageIds(value.inputMessageIds)
      : undefined;
  if (
    !inputMessageIds ||
    !('hadSuccessfulToolResult' in value) ||
    typeof value.hadSuccessfulToolResult !== 'boolean' ||
    !('emptyFinalCorrectionSpent' in value) ||
    typeof value.emptyFinalCorrectionSpent !== 'boolean'
  ) {
    return undefined;
  }
  return {
    inputMessageIds,
    hadSuccessfulToolResult: value.hadSuccessfulToolResult,
    emptyFinalCorrectionSpent: value.emptyFinalCorrectionSpent,
  };
}

function acknowledgedInboxIds(projected: readonly SessionEvent[]): Set<string> {
  return new Set(
    projected.flatMap((event, index) => {
      if (event.type === 'inbox_acknowledged') return event.data.messageIds;
      if (event.type === 'turn_aborted') {
        return turnAbortAppliedAcknowledgements(projected, index);
      }
      return [];
    })
  );
}

function unacknowledgedTurnRecovery(
  source: readonly SessionEvent[],
  aborted: Extract<SessionEvent, { type: 'turn_aborted' }>,
  additionallyAcknowledged: readonly string[] = []
): SessionTurnRecovery | undefined {
  const receipt = parseTurnAbortReceipt(aborted.data.recovery);
  if (!receipt) return undefined;
  const acknowledged = acknowledgedInboxIds(source);
  for (const messageId of additionallyAcknowledged) {
    acknowledged.add(messageId);
  }
  const inputMessageIds = receipt.inputMessageIds.filter(
    (messageId) => !acknowledged.has(messageId)
  );
  if (inputMessageIds.length === 0) return undefined;
  return {
    turnId: aborted.data.turnId,
    outcome: 'aborted',
    inputMessageIds,
    hadSuccessfulToolResult: receipt.hadSuccessfulToolResult,
    emptyFinalCorrectionSpent: receipt.emptyFinalCorrectionSpent,
  };
}

function latestUnacknowledgedTurnRecovery(
  projected: readonly SessionEvent[]
): SessionTurnRecovery | undefined {
  for (let index = projected.length - 1; index >= 0; index--) {
    const event = projected[index];
    if (event.type !== 'turn_aborted') continue;
    const recovery = unacknowledgedTurnRecovery(projected, event);
    if (recovery) return recovery;
  }
  return undefined;
}

export interface SessionInterruptedToolCall {
  toolCallId: string;
  messageId: string;
  toolName: string;
  input: JsonValue;
}

export interface SessionAdoptedToolResult {
  toolCallId: string;
  toolName: string;
  output: JsonValue;
  error?: string;
  metadata?: JsonValue;
  subagentRef?: SubagentRunRef;
}

export interface SessionTurnRecoveryOptions {
  adoptedToolResults?: ReadonlyMap<string, SessionAdoptedToolResult>;
}

export interface SessionTurnAbortOptions {
  acknowledgeInputMessageIds?: readonly string[];
}

export interface SaveTurnAbortResult {
  recovery?: SessionTurnRecovery;
  acknowledgedInputMessageIds: string[];
}

export interface PersistBackgroundSubagentCompletionResult {
  eligible: boolean;
  acknowledged: boolean;
  persisted: boolean;
  messageId?: string;
}

type DurableToolCall = SessionInterruptedToolCall;

const MAX_TURN_FINALIZATION_TURNS = 10_000;
const MAX_TURN_FINALIZATION_TOOL_CALLS = 100_000;
const MAX_TURN_FINALIZATION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_GOAL_FINALIZATION_ID_CHARS = 128;
const MAX_GOAL_FINALIZATION_ATTEMPTS = 1_000_000;
const MAX_INITIALIZED_SESSIONS_PER_STORE = 256;

function parseGoalFinalization(
  value: unknown
): SessionGoalFinalizationInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const receipt = value as Record<string, unknown>;
  if (
    typeof receipt.goalId !== 'string' ||
    receipt.goalId.length === 0 ||
    receipt.goalId.length > MAX_GOAL_FINALIZATION_ID_CHARS ||
    typeof receipt.verificationAttempt !== 'number' ||
    !Number.isSafeInteger(receipt.verificationAttempt) ||
    receipt.verificationAttempt < 1 ||
    receipt.verificationAttempt > MAX_GOAL_FINALIZATION_ATTEMPTS ||
    typeof receipt.verifierSessionId !== 'string' ||
    receipt.verifierSessionId.length === 0 ||
    receipt.verifierSessionId.length > MAX_GOAL_FINALIZATION_ID_CHARS ||
    typeof receipt.evidenceSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(receipt.evidenceSha256) ||
    typeof receipt.goalUpdatedAt !== 'string' ||
    !Number.isFinite(Date.parse(receipt.goalUpdatedAt))
  ) {
    return undefined;
  }
  return {
    goalId: receipt.goalId,
    verificationAttempt: receipt.verificationAttempt,
    verifierSessionId: receipt.verifierSessionId,
    evidenceSha256: receipt.evidenceSha256,
    goalUpdatedAt: receipt.goalUpdatedAt,
  };
}

function parseTurnFinalization(
  event: Extract<SessionEvent, { type: 'message_created' }>,
  expectedTurnId?: string
): SessionTurnFinalizationInfo | undefined {
  const metadata = event.data.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  const receipt = (metadata as Record<string, unknown>).turnFinalization;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return undefined;
  }
  const record = receipt as Record<string, unknown>;
  const turnId = record.turnId;
  const inputMessageIds = record.inputMessageIds;
  const turnsCount = record.turnsCount;
  const toolCallsCount = record.toolCallsCount;
  const durationMs = record.durationMs;
  const validInputMessageIds = Array.isArray(inputMessageIds)
    ? inputMessageIds.filter(
        (messageId): messageId is string =>
          typeof messageId === 'string' &&
          messageId.length > 0 &&
          messageId.length <= MAX_TURN_INPUT_MESSAGE_ID_CHARS
      )
    : [];
  if (
    typeof turnId !== 'string' ||
    turnId.length === 0 ||
    turnId.length > 128 ||
    (expectedTurnId !== undefined && turnId !== expectedTurnId) ||
    !Array.isArray(inputMessageIds) ||
    inputMessageIds.length > MAX_TURN_INPUT_MESSAGE_IDS ||
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
    return undefined;
  }

  let goalFinalization: SessionGoalFinalizationInfo | undefined;
  if ('goalFinalization' in record) {
    goalFinalization = parseGoalFinalization(record.goalFinalization);
    if (!goalFinalization) return undefined;
  }
  return {
    turnId,
    inputMessageIds: [...new Set(validInputMessageIds)],
    turnsCount,
    toolCallsCount,
    durationMs,
    ...(goalFinalization ? { goalFinalization } : {}),
  };
}

function durableTurnFinalization(
  projected: readonly SessionEvent[],
  turnId: string
): SessionTurnFinalizationInfo | undefined {
  const turnStartIndex = projected.findLastIndex(
    (event) => event.type === 'turn_started' && event.data.turnId === turnId
  );
  if (turnStartIndex < 0) return undefined;

  for (let index = projected.length - 1; index > turnStartIndex; index--) {
    const event = projected[index];
    if (event?.type !== 'message_created') continue;
    const finalization = parseTurnFinalization(event, turnId);
    if (finalization) return finalization;
  }
  return undefined;
}

function latestGoalFinalization(
  projected: readonly SessionEvent[]
): { turnId: string; finalization: SessionTurnFinalizationInfo } | undefined {
  for (let index = projected.length - 1; index >= 0; index--) {
    const event = projected[index];
    if (event?.type !== 'message_created') continue;
    const finalization = parseTurnFinalization(event);
    if (!finalization?.goalFinalization) continue;
    const hasEarlierStart = projected
      .slice(0, index)
      .some(
        (candidate) =>
          candidate.type === 'turn_started' &&
          candidate.data.turnId === finalization.turnId
      );
    if (!hasEarlierStart) continue;
    return {
      turnId: finalization.turnId,
      finalization,
    };
  }
  return undefined;
}

function durableToolCalls(
  projected: readonly SessionEvent[],
  turnId?: string
): {
  all: DurableToolCall[];
  orphaned: DurableToolCall[];
  hadSuccessfulResult: boolean;
} {
  const turnStartIndex = turnId
    ? projected.findLastIndex(
        (event) => event.type === 'turn_started' && event.data.turnId === turnId
      )
    : -1;
  if (turnId && turnStartIndex < 0) {
    return { all: [], orphaned: [], hadSuccessfulResult: false };
  }

  const calls = new Map<string, DurableToolCall>();
  const results = new Set<string>();
  const successfulResults = new Set<string>();
  const interactionCalls = new Set<string>();
  for (const event of projected.slice(turnStartIndex + 1)) {
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
        messageId: event.data.messageId,
        toolName: typeof payload.toolName === 'string' ? payload.toolName : 'unknown',
        input: (payload.input ?? null) as JsonValue,
      });
    } else if (event.data.partType === 'tool_result') {
      results.add(toolCallId);
      results.add(event.data.partId);
      results.add(event.data.messageId);
      if (calls.has(toolCallId) && payload.error === null) {
        successfulResults.add(toolCallId);
      }
    }
  }

  const all = [...calls.values()];
  return {
    all,
    orphaned: all.filter(
      (call) => !results.has(call.toolCallId) && !interactionCalls.has(call.toolCallId)
    ),
    hadSuccessfulResult: all.some((call) => successfulResults.has(call.toolCallId)),
  };
}

/**
 * 持久化存储实现 - JSONL 格式
 * 存储路径: ~/.blade/projects/{escaped-path}/{sessionId}.jsonl
 */
export class PersistentStore {
  /** Shared only while first-access validation or creation is in flight. */
  private static readonly sessionInitializationRuns = new Map<string, Promise<void>>();

  private readonly projectPath: string;
  private readonly maxSessions: number;
  private readonly version: string;
  /** Positive per-facade cache; Runtime ownership prevents active-file deletion. */
  private readonly initializedSessions = new Set<string>();

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
    if (this.initializedSessions.delete(sessionId)) {
      this.initializedSessions.add(sessionId);
      return;
    }

    let initialization = PersistentStore.sessionInitializationRuns.get(filePath);
    if (!initialization) {
      initialization = this.initializeSessionFile(sessionId, filePath, subagentInfo);
      PersistentStore.sessionInitializationRuns.set(filePath, initialization);
    }

    try {
      await initialization;
      this.rememberInitializedSession(sessionId);
    } finally {
      if (PersistentStore.sessionInitializationRuns.get(filePath) === initialization) {
        PersistentStore.sessionInitializationRuns.delete(filePath);
      }
    }
  }

  private rememberInitializedSession(sessionId: string): void {
    this.initializedSessions.delete(sessionId);
    this.initializedSessions.add(sessionId);
    while (this.initializedSessions.size > MAX_INITIALIZED_SESSIONS_PER_STORE) {
      const oldest = this.initializedSessions.values().next().value;
      if (oldest === undefined) return;
      this.initializedSessions.delete(oldest);
    }
  }

  private async initializeSessionFile(
    sessionId: string,
    filePath: string,
    subagentInfo?: SubagentInfoForContext
  ): Promise<void> {
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
    if (metadata.preTokenSource) {
      result.preTokenSource = metadata.preTokenSource;
    }
    if (metadata.estimatedPendingTokens !== undefined) {
      result.estimatedPendingTokens = metadata.estimatedPendingTokens;
    }
    if (metadata.postTokens !== undefined) result.postTokens = metadata.postTokens;
    if (metadata.sampleAttempts !== undefined) {
      result.sampleAttempts = metadata.sampleAttempts;
    }
    if (metadata.inputReductions !== undefined) {
      result.inputReductions = metadata.inputReductions;
    }
    if (metadata.messagesOmitted !== undefined) {
      result.messagesOmitted = metadata.messagesOmitted;
    }
    if (metadata.filesOmitted !== undefined) {
      result.filesOmitted = metadata.filesOmitted;
    }
    if (metadata.imagesOmitted !== undefined) {
      result.imagesOmitted = metadata.imagesOmitted;
    }
    if (metadata.fallbackTargetTokens !== undefined) {
      result.fallbackTargetTokens = metadata.fallbackTargetTokens;
    }
    if (metadata.fallbackMessagesOmitted !== undefined) {
      result.fallbackMessagesOmitted = metadata.fallbackMessagesOmitted;
    }
    if (metadata.fallbackMessagesTruncated !== undefined) {
      result.fallbackMessagesTruncated = metadata.fallbackMessagesTruncated;
    }
    if (metadata.failureReason) result.failureReason = metadata.failureReason;
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

  async persistBackgroundSubagentCompletion(
    sessionId: string,
    completion: BackgroundSubagentCompletion
  ): Promise<PersistBackgroundSubagentCompletionResult> {
    if (
      completion.inboxMessageId !==
      `background-subagent-completion:${completion.childSessionId}`
    ) {
      return {
        eligible: false,
        acknowledged: false,
        persisted: false,
      };
    }
    await this.ensureSessionCreated(sessionId);
    let result: PersistBackgroundSubagentCompletionResult = {
      eligible: false,
      acknowledged: false,
      persisted: false,
    };
    await this.log(sessionId).commitValidatedBatch((events) => {
      const projected = materializeSessionEvents(events);
      const acknowledged = projected.some(
        (event) =>
          event.type === 'inbox_acknowledged' &&
          event.data.messageIds.includes(completion.inboxMessageId)
      );
      const existingMessage = projected.find(
        (event): event is Extract<SessionEvent, { type: 'message_created' }> =>
          event.type === 'message_created' &&
          event.data.inboxMessageId === completion.inboxMessageId
      );
      const taskCall = projected.findLast(
        (event): event is Extract<SessionEvent, { type: 'part_created' }> => {
          if (
            event.type !== 'part_created' ||
            event.data.partType !== 'tool_call' ||
            !event.data.payload ||
            typeof event.data.payload !== 'object' ||
            Array.isArray(event.data.payload)
          ) {
            return false;
          }
          const payload = event.data.payload as Record<string, unknown>;
          if (
            payload.toolName !== 'Task' ||
            !payload.input ||
            typeof payload.input !== 'object' ||
            Array.isArray(payload.input)
          ) {
            return false;
          }
          const input = payload.input as Record<string, unknown>;
          const resumeFrom = input.resume_from ?? input.resume;
          return (
            input.run_in_background === true &&
            input.subagent_session_id === completion.childSessionId &&
            input.description === completion.subagentRef.subagentDescription &&
            (input.subagent_type === undefined ||
              input.subagent_type === completion.subagentRef.subagentType) &&
            (input.resume_from === undefined ||
              input.resume === undefined ||
              input.resume_from === input.resume) &&
            (resumeFrom === undefined
              ? completion.subagentRef.subagentResumedFrom === undefined
              : resumeFrom === completion.subagentRef.subagentResumedFrom)
          );
        }
      );
      if (!taskCall) {
        result = {
          eligible: false,
          acknowledged,
          persisted: false,
          ...(existingMessage ? { messageId: existingMessage.data.messageId } : {}),
        };
        return [];
      }

      if (acknowledged) {
        result = {
          eligible: true,
          acknowledged: true,
          persisted: false,
          ...(existingMessage ? { messageId: existingMessage.data.messageId } : {}),
        };
        return [];
      }

      const terminalRef = projected.find(
        (event): event is Extract<SessionEvent, { type: 'part_created' }> =>
          event.type === 'part_created' &&
          event.data.partType === 'subtask_ref' &&
          event.data.payload !== null &&
          typeof event.data.payload === 'object' &&
          !Array.isArray(event.data.payload) &&
          event.data.payload.childSessionId === completion.childSessionId &&
          event.data.payload.status === completion.subagentRef.subagentStatus
      );
      if (existingMessage && terminalRef) {
        result = {
          eligible: true,
          acknowledged: false,
          persisted: false,
          messageId: existingMessage.data.messageId,
        };
        return [];
      }

      const now = new Date().toISOString();
      const messageId = existingMessage?.data.messageId ?? nanoid();
      const entries: SessionEvent[] = [];
      if (!existingMessage) {
        const messageInfo: MessageInfo = {
          messageId,
          role: 'user',
          inboxMessageId: completion.inboxMessageId,
          createdAt: now,
          metadata: JSON.parse(JSON.stringify(completion.metadata)) as JsonValue,
        };
        entries.push(this.createEvent('message_created', sessionId, messageInfo));
        entries.push(
          this.createEvent('part_created', sessionId, {
            partId: nanoid(),
            messageId,
            partType: 'text',
            payload: { text: completion.content },
            createdAt: now,
          })
        );
      }
      if (!terminalRef) {
        const runningRef = projected.findLast(
          (event): event is Extract<SessionEvent, { type: 'part_created' }> =>
            event.type === 'part_created' &&
            event.data.partType === 'subtask_ref' &&
            event.data.messageId === taskCall.data.messageId &&
            event.data.payload !== null &&
            typeof event.data.payload === 'object' &&
            !Array.isArray(event.data.payload) &&
            event.data.payload.childSessionId === completion.childSessionId
        );
        const runningPayload =
          runningRef?.data.payload &&
          typeof runningRef.data.payload === 'object' &&
          !Array.isArray(runningRef.data.payload)
            ? runningRef.data.payload
            : undefined;
        entries.push(
          this.createEvent('part_created', sessionId, {
            partId: nanoid(),
            messageId: taskCall.data.messageId,
            partType: 'subtask_ref',
            payload: {
              childSessionId: completion.subagentRef.subagentSessionId,
              agentType: completion.subagentRef.subagentType,
              description: completion.subagentRef.subagentDescription ?? '',
              status: completion.subagentRef.subagentStatus,
              summary: completion.subagentRef.subagentSummary ?? '',
              resumedFrom: completion.subagentRef.subagentResumedFrom ?? null,
              rootAgentId:
                completion.subagentRef.subagentRootId ??
                completion.subagentRef.subagentSessionId,
              resumeDepth: completion.subagentRef.subagentResumeDepth ?? 0,
              verificationVerdict: completion.subagentRef.verificationVerdict ?? null,
              startedAt:
                typeof runningPayload?.startedAt === 'string'
                  ? runningPayload.startedAt
                  : now,
              finishedAt: now,
            },
            createdAt: now,
          })
        );
      }
      result = {
        eligible: true,
        acknowledged: false,
        persisted: entries.length > 0,
        messageId,
      };
      return entries;
    });
    return result;
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

  async saveTurnAbort(
    sessionId: string,
    turn: SessionTurnAbortInfo,
    options: SessionTurnAbortOptions = {}
  ): Promise<SaveTurnAbortResult> {
    const acknowledgementIds = options.acknowledgeInputMessageIds ?? [];
    const parsedAcknowledgementIds = parseTurnInputMessageIds(acknowledgementIds);
    if (!parsedAcknowledgementIds) {
      throw new Error('Invalid turn abort acknowledgement input message IDs');
    }
    const uniqueAcknowledgementIds = parsedAcknowledgementIds;
    await this.ensureSessionCreated(sessionId);
    let recovery: SessionTurnRecovery | undefined;
    let acknowledgedInputMessageIds: string[] = [];
    try {
      await this.log(sessionId).commitValidatedBatch((events) => {
        const projected = materializeSessionEvents(events);
        const acknowledgedIds = acknowledgedInboxIds(projected);
        const existingTerminal = projected.findLast(
          (
            event
          ): event is Extract<
            SessionEvent,
            { type: 'turn_completed' | 'turn_aborted' }
          > =>
            (event.type === 'turn_completed' || event.type === 'turn_aborted') &&
            event.data.turnId === turn.turnId
        );
        if (existingTerminal) {
          if (existingTerminal.type === 'turn_completed') {
            recovery = undefined;
            acknowledgedInputMessageIds = [];
            throw new TurnLifecycleNoop();
          }
          const terminalReceipt = parseTurnAbortReceipt(existingTerminal.data.recovery);
          const eligibleAcknowledgementIds = terminalReceipt
            ? uniqueAcknowledgementIds.filter((messageId) =>
                terminalReceipt.inputMessageIds.includes(messageId)
              )
            : [];
          const missingTerminalAcknowledgementIds = eligibleAcknowledgementIds.filter(
            (messageId) => !acknowledgedIds.has(messageId)
          );
          acknowledgedInputMessageIds = eligibleAcknowledgementIds;
          recovery = unacknowledgedTurnRecovery(
            projected,
            existingTerminal,
            eligibleAcknowledgementIds
          );
          if (missingTerminalAcknowledgementIds.length === 0) {
            throw new TurnLifecycleNoop();
          }
          return [
            this.createEvent('inbox_acknowledged', sessionId, {
              messageIds: missingTerminalAcknowledgementIds,
              acknowledgedAt: turn.abortedAt,
            }),
          ];
        }
        const active = projectTurnLifecycle(projected).active;
        if (!active || active.turnId !== turn.turnId) {
          throw new Error(`Turn is not active: ${turn.turnId}`);
        }
        const toolEvidence = durableToolCalls(projected, active.turnId);
        const durableInputMessageIds = durableTurnInputMessageIds(
          projected,
          active.turnId
        );
        const priorRecovery = latestUnacknowledgedTurnRecovery(projected);
        const requestedRecoveryIds = new Set(turn.recovery?.inputMessageIds ?? []);
        const inheritedInputMessageIds = priorRecovery
          ? priorRecovery.inputMessageIds.filter((messageId) =>
              requestedRecoveryIds.has(messageId)
            )
          : [];
        const inputMessageIds = [
          ...new Set([...durableInputMessageIds, ...inheritedInputMessageIds]),
        ];
        const receipt = {
          version: 1 as const,
          inputMessageIds,
          hadSuccessfulToolResult:
            toolEvidence.hadSuccessfulResult ||
            turn.recovery?.hadSuccessfulToolResult === true,
          emptyFinalCorrectionSpent:
            durableEmptyFinalCorrectionSpent(projected, active.turnId) ||
            turn.recovery?.emptyFinalCorrectionSpent === true,
        };
        recovery = {
          turnId: turn.turnId,
          outcome: 'aborted',
          inputMessageIds: receipt.inputMessageIds,
          hadSuccessfulToolResult: receipt.hadSuccessfulToolResult,
          emptyFinalCorrectionSpent: receipt.emptyFinalCorrectionSpent,
        };
        const eligibleAcknowledgementIds = uniqueAcknowledgementIds.filter(
          (messageId) => inputMessageIds.includes(messageId)
        );
        const missingEligibleAcknowledgementIds = eligibleAcknowledgementIds.filter(
          (messageId) => !acknowledgedIds.has(messageId)
        );
        acknowledgedInputMessageIds = eligibleAcknowledgementIds;
        const postCommitAcknowledgedIds = new Set(acknowledgedIds);
        for (const messageId of eligibleAcknowledgementIds) {
          postCommitAcknowledgedIds.add(messageId);
        }
        const recoverableInputMessageIds = receipt.inputMessageIds.filter(
          (messageId) => !postCommitAcknowledgedIds.has(messageId)
        );
        recovery =
          recoverableInputMessageIds.length > 0
            ? {
                turnId: turn.turnId,
                outcome: 'aborted',
                inputMessageIds: recoverableInputMessageIds,
                hadSuccessfulToolResult: receipt.hadSuccessfulToolResult,
                emptyFinalCorrectionSpent: receipt.emptyFinalCorrectionSpent,
              }
            : undefined;
        const { acknowledgedInputMessageIds: _ignored, ...abortInfo } = turn;
        const terminalEvent = this.createEvent('turn_aborted', sessionId, {
          ...abortInfo,
          ...(eligibleAcknowledgementIds.length > 0
            ? { acknowledgedInputMessageIds: eligibleAcknowledgementIds }
            : {}),
          recovery: receipt,
        });
        return [
          terminalEvent,
          ...(missingEligibleAcknowledgementIds.length > 0
            ? [
                this.createEvent('inbox_acknowledged', sessionId, {
                  messageIds: missingEligibleAcknowledgementIds,
                  acknowledgedAt: turn.abortedAt,
                }),
              ]
            : []),
        ];
      });
    } catch (error) {
      if (!(error instanceof TurnLifecycleNoop)) throw error;
    }
    return {
      ...(recovery ? { recovery } : {}),
      acknowledgedInputMessageIds,
    };
  }

  async loadInterruptedToolCalls(
    sessionId: string
  ): Promise<SessionInterruptedToolCall[]> {
    const events = await this.loadEvents(sessionId);
    if (!events) return [];
    const projected = materializeSessionEvents(events);
    const active = projectTurnLifecycle(projected).active;
    return active
      ? durableToolCalls(projected, active.turnId).orphaned.map((call) => ({
          ...call,
          input: structuredClone(call.input),
        }))
      : [];
  }

  async loadBackgroundTaskChildIds(sessionId: string): Promise<Set<string>> {
    const events = await this.loadEvents(sessionId);
    if (!events) return new Set();
    const childIds = materializeSessionEvents(events).flatMap((event) => {
      if (
        event.type !== 'part_created' ||
        event.data.partType !== 'tool_call' ||
        !event.data.payload ||
        typeof event.data.payload !== 'object' ||
        Array.isArray(event.data.payload)
      ) {
        return [];
      }
      const payload = event.data.payload as Record<string, unknown>;
      if (
        payload.toolName !== 'Task' ||
        !payload.input ||
        typeof payload.input !== 'object' ||
        Array.isArray(payload.input)
      ) {
        return [];
      }
      const input = payload.input as Record<string, unknown>;
      return input.run_in_background === true &&
        typeof input.subagent_session_id === 'string'
        ? [input.subagent_session_id]
        : [];
    });
    return new Set(childIds);
  }

  async recoverInterruptedTurn(
    sessionId: string,
    options: SessionTurnRecoveryOptions = {}
  ): Promise<SessionTurnRecovery | undefined> {
    await this.ensureSessionCreated(sessionId);
    let recovery: SessionTurnRecovery | undefined;
    try {
      await this.log(sessionId).commitValidatedBatch((events) => {
        const projected = materializeSessionEvents(events);
        const active = projectTurnLifecycle(projected).active;
        const toolCalls = durableToolCalls(projected);
        if (!active && toolCalls.orphaned.length === 0) {
          recovery = latestUnacknowledgedTurnRecovery(projected);
          if (recovery) return [];
          throw new TurnLifecycleNoop();
        }
        const finalization = active
          ? durableTurnFinalization(projected, active.turnId)
          : undefined;
        if (active && finalization && toolCalls.orphaned.length === 0) {
          const activeToolEvidence = durableToolCalls(projected, active.turnId);
          recovery = {
            turnId: active.turnId,
            outcome: 'completed',
            inputMessageIds: finalization.inputMessageIds,
            hadSuccessfulToolResult: activeToolEvidence.hadSuccessfulResult,
            emptyFinalCorrectionSpent: durableEmptyFinalCorrectionSpent(
              projected,
              active.turnId
            ),
            finalization,
          };
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
        const activeToolEvidence = active
          ? durableToolCalls(projected, active.turnId)
          : undefined;
        const hadSuccessfulAdoptedToolResult =
          activeToolEvidence?.orphaned.some((call) => {
            const adopted = options.adoptedToolResults?.get(call.toolCallId);
            return (
              adopted?.toolCallId === call.toolCallId &&
              adopted.toolName === call.toolName &&
              adopted.error === undefined
            );
          }) ?? false;
        const activeInputMessageIds = new Set(active?.inputMessageIds ?? []);
        const priorRecovery = active
          ? latestUnacknowledgedTurnRecovery(projected)
          : undefined;
        const inheritedInputMessageIds = priorRecovery
          ? priorRecovery.inputMessageIds.filter((messageId) =>
              activeInputMessageIds.has(messageId)
            )
          : [];
        const inheritedPriorRecovery = inheritedInputMessageIds.length > 0;
        const activeDurableInputMessageIds = active
          ? durableTurnInputMessageIds(projected, active.turnId)
          : [];
        recovery = active
          ? {
              turnId: active.turnId,
              outcome: 'aborted',
              inputMessageIds: [
                ...new Set([
                  ...activeDurableInputMessageIds,
                  ...inheritedInputMessageIds,
                ]),
              ],
              hadSuccessfulToolResult:
                (activeToolEvidence?.hadSuccessfulResult ?? false) ||
                hadSuccessfulAdoptedToolResult ||
                (inheritedPriorRecovery &&
                  priorRecovery?.hadSuccessfulToolResult === true),
              emptyFinalCorrectionSpent:
                durableEmptyFinalCorrectionSpent(projected, active.turnId) ||
                (inheritedPriorRecovery &&
                  priorRecovery?.emptyFinalCorrectionSpent === true),
            }
          : undefined;
        const activeToolCalls = active ? (activeToolEvidence?.all.length ?? 0) : 0;
        const now = new Date().toISOString();
        const startedAt = active ? Date.parse(active.startedAt) : Number.NaN;
        const recoveryResults = toolCalls.orphaned.flatMap((call) => {
          const adopted = options.adoptedToolResults?.get(call.toolCallId);
          const validAdoption =
            adopted?.toolCallId === call.toolCallId &&
            adopted.toolName === call.toolName
              ? adopted
              : undefined;
          const resultEvent = this.createEvent('part_created', sessionId, {
            partId: call.toolCallId,
            messageId: validAdoption ? call.messageId : call.toolCallId,
            partType: 'tool_result',
            payload: validAdoption
              ? {
                  toolCallId: call.toolCallId,
                  toolName: call.toolName,
                  output: validAdoption.output,
                  error: validAdoption.error ?? null,
                  ...(validAdoption.metadata === undefined
                    ? {}
                    : { metadata: validAdoption.metadata }),
                }
              : {
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
          });
          if (!validAdoption?.subagentRef) return [resultEvent];
          const ref = validAdoption.subagentRef;
          return [
            resultEvent,
            this.createEvent('part_created', sessionId, {
              partId: nanoid(),
              messageId: call.messageId,
              partType: 'subtask_ref',
              payload: {
                childSessionId: ref.subagentSessionId,
                agentType: ref.subagentType,
                description: ref.subagentDescription ?? '',
                status: ref.subagentStatus,
                summary: ref.subagentSummary ?? '',
                resumedFrom: ref.subagentResumedFrom ?? null,
                rootAgentId: ref.subagentRootId ?? ref.subagentSessionId,
                resumeDepth: ref.subagentResumeDepth ?? 0,
                verificationVerdict: ref.verificationVerdict ?? null,
                startedAt: now,
                finishedAt: now,
              },
              createdAt: now,
            }),
          ];
        });
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
                recovery: recovery
                  ? {
                      version: 1,
                      inputMessageIds: recovery.inputMessageIds,
                      hadSuccessfulToolResult: recovery.hadSuccessfulToolResult,
                      emptyFinalCorrectionSpent: recovery.emptyFinalCorrectionSpent,
                    }
                  : undefined,
              }),
            ]
          : recoveryResults;
      });
    } catch (error) {
      if (!(error instanceof TurnLifecycleNoop)) throw error;
    }
    return recovery;
  }

  async loadLatestGoalFinalization(
    sessionId: string
  ): Promise<
    { turnId: string; finalization: SessionTurnFinalizationInfo } | undefined
  > {
    const events = await this.loadEvents(sessionId);
    return events ? latestGoalFinalization(events) : undefined;
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
    subagentInfo?: SubagentInfoForContext,
    providerToolCallId?: string
  ): Promise<string> {
    try {
      if (
        providerToolCallId !== undefined &&
        (providerToolCallId.length === 0 || providerToolCallId.length > 512)
      ) {
        throw new Error('Provider tool call identity must contain 1-512 characters');
      }
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
      const toolCallId = providerToolCallId ?? nanoid();
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
      await this.log(sessionId).commitValidatedBatch((events) => {
        const terminalRef =
          subagentRef?.subagentStatus === 'running'
            ? materializeSessionEvents(events).findLast(
                (event): event is Extract<SessionEvent, { type: 'part_created' }> =>
                  event.type === 'part_created' &&
                  event.data.partType === 'subtask_ref' &&
                  event.data.payload !== null &&
                  typeof event.data.payload === 'object' &&
                  !Array.isArray(event.data.payload) &&
                  event.data.payload.childSessionId === subagentRef.subagentSessionId &&
                  (event.data.payload.status === 'completed' ||
                    event.data.payload.status === 'failed' ||
                    event.data.payload.status === 'cancelled')
              )
            : undefined;
        const terminalPayload = terminalRef?.data.payload as
          | Record<string, JsonValue>
          | undefined;
        const metadataBase =
          toolMetadata &&
          typeof toolMetadata === 'object' &&
          !Array.isArray(toolMetadata)
            ? toolMetadata
            : {};
        const effectiveToolMetadata = terminalPayload
          ? {
              ...metadataBase,
              subagentSessionId: terminalPayload.childSessionId,
              subagentType: terminalPayload.agentType,
              description: terminalPayload.description,
              subagentStatus: terminalPayload.status,
              subagentSummary: terminalPayload.summary,
              subagentResumedFrom: terminalPayload.resumedFrom,
              subagentRootId: terminalPayload.rootAgentId,
              subagentResumeDepth: terminalPayload.resumeDepth,
              verificationVerdict: terminalPayload.verificationVerdict,
            }
          : toolMetadata;
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
            ...(effectiveToolMetadata === undefined
              ? {}
              : { metadata: effectiveToolMetadata }),
          },
          createdAt: now,
        };
        entries.push(this.createEvent('part_created', sessionId, toolResultPart));
        if (subagentRef && !terminalRef) {
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
        return entries;
      });
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

  async recordTokenBudgetHandoff(
    sessionId: string,
    payload: Omit<TokenBudgetHandoffRecordedV1, 'messageId' | 'createdAt'>
  ): Promise<RecordTokenBudgetHandoffResult> {
    await this.ensureSessionCreated(sessionId);
    let current = findCurrentTokenBudgetHandoff([]);
    const stamped = await this.log(sessionId).commitValidatedBatch((events) => {
      current = findCurrentTokenBudgetHandoff(materializeSessionEvents(events));
      if (current.kind !== 'none') return [];

      const createdAt = new Date().toISOString();
      return [
        this.createEvent('token_budget_handoff_recorded', sessionId, {
          ...payload,
          messageId: `${TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX}${nanoid()}`,
          createdAt,
        }),
      ];
    });

    if (current.kind === 'valid') {
      return { outcome: 'existing', event: current.event };
    }
    if (current.kind === 'suppressed') {
      return { outcome: 'suppressed', recordId: current.recordId };
    }
    if (stamped.length !== 1) {
      throw new Error('Token budget handoff commit produced an impossible result');
    }
    const event = findCurrentTokenBudgetHandoff(stamped);
    if (event.kind !== 'valid') {
      throw new Error('Token budget handoff commit produced an invalid event');
    }
    return { outcome: 'created', event: event.event };
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
    this.initializedSessions.delete(sessionId);
    try {
      const filePath = getSessionFilePath(this.projectPath, sessionId);
      const store = new JSONLStore(filePath);
      await store.delete();
      await fs
        .unlink(getSessionInboxFilePath(this.projectPath, sessionId))
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      await removeBrowserSessionArtifacts(
        this.projectPath,
        sessionId,
        getBladeStorageRoot()
      );
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
    } finally {
      this.initializedSessions.delete(sessionId);
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

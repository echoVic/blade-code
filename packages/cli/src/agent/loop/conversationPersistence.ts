/**
 * conversationPersistence — 统一封装会话持久化操作
 *
 * 从 executeLoopGenerator 中提取的 JSONL 持久化逻辑，
 * 统一 contextMgr 获取与错误日志处理。
 */

import { deriveSessionTitleFromContent } from '../../api/sessionTitle.js';
import type { CompactionPersistenceMetadata } from '../../context/compactionCheckpoint.js';
import type {
  MessagePersistenceMetadata,
  SubagentRunRef,
} from '../../context/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { Bus } from '../../server/bus.js';
import type { ContentPart, Message } from '../../services/ChatServiceInterface.js';
import { SessionService } from '../../services/SessionService.js';
import type { JsonValue } from '../../store/types.js';
import type { ProjectRuleReference } from '../resources/WorkspaceProjectRules.js';
import type { ChatContext, UserMessageContent } from '../types.js';
import type { ConversationState } from './ConversationState.js';
import type { LoopDependencies } from './types.js';

const logger = createLogger(LogCategory.AGENT);

/**
 * Sessions we've already attempted to auto-title this process. Keeps the
 * backfill to a single metadata read per session and never re-derives once a
 * title exists. Cleared naturally on process restart (idempotent by design:
 * we only ever write when the persisted title is still blank).
 */
const autoTitledSessions = new Set<string>();

/**
 * Best-effort semantic title backfill for the first user message.
 *
 * Runs on the shared agent loop, so CLI and ACP sessions get the same
 * intent-derived titles the Web surface applies at creation time. Fire-and-forget
 * and fully guarded: any failure is swallowed, and we only ever write when the
 * persisted title is still empty.
 */
async function maybeBackfillSessionTitle(
  context: ChatContext,
  message: UserMessageContent
): Promise<void> {
  const sessionId = context.sessionId;
  // Subagent turns and continuations should never rename the parent session.
  if (!sessionId || context.subagentInfo) return;
  if (autoTitledSessions.has(sessionId)) return;
  // Bound the guard set for long-lived servers; the persisted-title check below
  // keeps behavior correct even if an entry is later evicted.
  if (autoTitledSessions.size >= 5000) autoTitledSessions.clear();
  autoTitledSessions.add(sessionId);

  try {
    const projectPath = context.workspaceRoot;
    const metadata = await SessionService.findSessionMetadata(sessionId, projectPath);
    if (!metadata) return;
    if (metadata.title && metadata.title.trim()) return; // respect existing titles

    const title = deriveSessionTitleFromContent(message);
    if (!title) return;
    await SessionService.updateSessionMetadata(sessionId, metadata.projectPath, {
      title,
    });
    // Broadcast so every connected surface (Web sidebar, other tabs) reflects
    // the freshly derived title without a manual refresh.
    Bus.publish({ sessionId, projectPath: metadata.projectPath }, 'session.updated', {
      title,
    });
  } catch (error) {
    logger.debug?.('[Loop] 自动生成会话标题失败:', error);
  }
}

export const INTERRUPTED_TURN_MARKER = `<turn_aborted>
The previous turn was interrupted. Commands or tool calls may have partially completed; inspect the workspace and running processes before retrying.
</turn_aborted>`;

export const DURABLE_TOOL_USE_FAILURE_MESSAGE =
  'Tool execution was blocked because its durable call record could not be ' +
  'committed. No tool side effect was started.';

export const DURABLE_TOOL_RESULT_FAILURE_MESSAGE =
  'Tool execution completed, but its durable result record could not be committed. ' +
  'Further model and tool execution was stopped. The operation may have completed; ' +
  'inspect external state before retrying.';

export type DurableConversationPersistencePhase = 'user_message' | 'assistant_message';

export class DurableConversationPersistenceError extends Error {
  constructor(
    readonly phase: DurableConversationPersistencePhase,
    options?: ErrorOptions
  ) {
    super(
      phase === 'user_message'
        ? 'Conversation input could not be committed. No further model request was started.'
        : 'Model output could not be committed. The run was stopped before any further model request or successful completion.',
      options
    );
    this.name = 'DurableConversationPersistenceError';
  }
}

/** 获取 ContextManager（可能为 undefined） */
function getContextMgr(deps: LoopDependencies) {
  return deps.executionEngine?.getContextManager();
}

/**
 * 保存用户消息到 JSONL。
 * 空白纯文本消息会被跳过。
 */
export async function saveUserMessage(
  deps: LoopDependencies,
  context: ChatContext,
  message: UserMessageContent,
  parentUuid: string | null = null,
  metadata?: MessagePersistenceMetadata,
  options: { required?: boolean } = {}
): Promise<string | null> {
  const required = options.required ?? deps.executionEngine !== undefined;
  try {
    const contextMgr = getContextMgr(deps);
    const hasPersistableContent =
      typeof message === 'string'
        ? message.trim() !== ''
        : (message as ContentPart[]).some((part) =>
            part.type === 'text' ? part.text.trim() !== '' : true
          );
    if (contextMgr && context.sessionId && hasPersistableContent) {
      const uuid = await contextMgr.saveMessage(
        context.sessionId,
        'user',
        message,
        parentUuid,
        metadata,
        context.subagentInfo
      );
      if (required && !uuid) {
        throw new Error('Durable user-message commit returned no identity');
      }
      // Backfill a semantic title from the first user message (best-effort).
      if (metadata?.clientVisible !== false) {
        void maybeBackfillSessionTitle(context, message);
      }
      return uuid;
    }
    if (required && context.sessionId && hasPersistableContent) {
      throw new Error('Durable user-message storage is unavailable');
    }
  } catch (error) {
    logger.warn('[Loop] 保存用户消息失败:', error);
    if (required) {
      throw new DurableConversationPersistenceError('user_message', {
        cause: error,
      });
    }
  }
  return null;
}

/**
 * 保存助手消息到 JSONL。
 * 空白内容会被跳过。
 */
export async function saveAssistantMessage(
  deps: LoopDependencies,
  context: ChatContext,
  content: string,
  parentUuid: string | null,
  reasoningContent?: string,
  metadata?: MessagePersistenceMetadata,
  options: { required?: boolean } = {}
): Promise<string | null> {
  const required = options.required ?? deps.executionEngine !== undefined;
  try {
    const contextMgr = getContextMgr(deps);
    const hasPersistableContent = Boolean(content.trim() || reasoningContent?.trim());
    if (contextMgr && context.sessionId && hasPersistableContent) {
      const uuid = await contextMgr.saveMessage(
        context.sessionId,
        'assistant',
        content,
        parentUuid,
        metadata,
        context.subagentInfo,
        reasoningContent
      );
      if (required && !uuid) {
        throw new Error('Durable assistant-message commit returned no identity');
      }
      return uuid;
    }
    if (required && context.sessionId && hasPersistableContent) {
      throw new Error('Durable assistant-message storage is unavailable');
    }
  } catch (error) {
    logger.warn('[Loop] 保存助手消息失败:', error);
    if (required) {
      throw new DurableConversationPersistenceError('assistant_message', {
        cause: error,
      });
    }
  }
  return null;
}

/** Persist a model-visible recovery boundary without exposing it in resumed UI history. */
export async function saveInterruptedTurnMarker(
  deps: LoopDependencies,
  context: ChatContext,
  parentUuid: string | null
): Promise<string | null> {
  try {
    const contextMgr = getContextMgr(deps);
    if (contextMgr && context.sessionId) {
      return await contextMgr.saveMessage(
        context.sessionId,
        'system',
        INTERRUPTED_TURN_MARKER,
        parentUuid,
        undefined,
        context.subagentInfo
      );
    }
  } catch (error) {
    logger.warn('[Loop] 保存中断边界失败:', error);
  }
  return null;
}

export async function saveContextualProjectRulesMarker(
  deps: LoopDependencies,
  context: ChatContext,
  references: readonly ProjectRuleReference[],
  triggerPaths: readonly string[],
  parentUuid: string | null
): Promise<string | null> {
  try {
    const contextMgr = getContextMgr(deps);
    if (!contextMgr || !context.sessionId || references.length === 0) {
      return null;
    }
    return await contextMgr.saveMessage(
      context.sessionId,
      'system',
      `<contextual-project-instructions-ref count="${references.length}" />`,
      parentUuid,
      {
        contextualProjectRules: true,
        ruleReferences: JSON.parse(
          JSON.stringify(references.map((item) => ({ ...item })))
        ) as JsonValue,
        triggerPaths: [...triggerPaths],
      },
      context.subagentInfo
    );
  } catch (error) {
    logger.warn('[Loop] 保存 contextual project rules provenance 失败:', error);
  }
  return null;
}

/**
 * 保存工具调用到 JSONL。
 */
export async function saveToolUse(
  deps: LoopDependencies,
  context: ChatContext,
  toolName: string,
  params: JsonValue,
  parentUuid: string | null,
  options: { required?: boolean; providerToolCallId?: string } = {}
): Promise<string | null> {
  try {
    const contextMgr = getContextMgr(deps);
    if (contextMgr && context.sessionId) {
      const toolCallId = await contextMgr.saveToolUse(
        context.sessionId,
        toolName,
        params,
        parentUuid,
        context.subagentInfo,
        options.providerToolCallId
      );
      if (options.required && !toolCallId) {
        throw new Error('Durable tool-use commit returned no identity');
      }
      return toolCallId;
    }
    if (options.required && context.sessionId) {
      throw new Error('Durable tool-use storage is unavailable');
    }
  } catch (error) {
    logger.warn('[Loop] 保存工具调用失败:', error);
    if (options.required) throw error;
  }
  return null;
}

/**
 * 保存工具结果到 JSONL。
 */
export async function saveToolResult(
  deps: LoopDependencies,
  context: ChatContext,
  toolId: string,
  toolName: string,
  toolOutput: JsonValue,
  parentUuid: string | null,
  error?: string,
  subagentRef?: SubagentRunRef,
  toolMetadata?: JsonValue,
  options: { required?: boolean } = {}
): Promise<string | null> {
  try {
    const contextMgr = getContextMgr(deps);
    if (contextMgr && context.sessionId) {
      const resultId = await contextMgr.saveToolResult(
        context.sessionId,
        toolId,
        toolName,
        toolOutput,
        parentUuid,
        error,
        context.subagentInfo,
        subagentRef,
        toolMetadata
      );
      if (options.required && !resultId) {
        throw new Error('Durable tool-result commit returned no identity');
      }
      return resultId;
    }
    if (options.required && context.sessionId) {
      throw new Error('Durable tool-result storage is unavailable');
    }
  } catch (error_) {
    logger.warn('[Loop] 保存工具结果失败:', error_);
    if (options.required) throw error_;
  }
  return null;
}

/**
 * 保存压缩数据到 JSONL。
 */
export async function saveCompaction(
  deps: LoopDependencies,
  context: ChatContext,
  summary: string,
  metadata: CompactionPersistenceMetadata,
  options: { required?: boolean } = {}
): Promise<string | null> {
  try {
    const contextMgr = getContextMgr(deps);
    if (contextMgr && context.sessionId) {
      const checkpointId = await contextMgr.saveCompaction(
        context.sessionId,
        summary,
        metadata,
        null
      );
      if (options.required && !checkpointId) {
        throw new Error('Compaction checkpoint commit returned no identity');
      }
      return checkpointId || null;
    }
    if (options.required && context.sessionId) {
      throw new Error('Compaction checkpoint storage is unavailable');
    }
  } catch (error) {
    logger.warn('[Loop] 保存压缩数据失败:', error);
    if (options.required) throw error;
  }
  return null;
}

export interface PersistTurnContinuationParams {
  deps: LoopDependencies;
  context: ChatContext;
  state: ConversationState;
  assistantContent: string;
  assistantReasoningContent?: string;
  lastMessageUuid: string | null;
  controlPrompt?: string;
  controlMetadata?: MessagePersistenceMetadata;
}

export async function persistTurnContinuation(
  params: PersistTurnContinuationParams
): Promise<string | null> {
  const {
    deps,
    context,
    state,
    assistantContent,
    assistantReasoningContent,
    lastMessageUuid,
    controlPrompt,
    controlMetadata,
  } = params;

  state.appendAssistant({
    role: 'assistant',
    content: assistantContent,
    reasoningContent: assistantReasoningContent,
  });

  let uuid = lastMessageUuid;
  const assistantUuid = await saveAssistantMessage(
    deps,
    context,
    assistantContent,
    uuid,
    assistantReasoningContent
  );
  if (assistantUuid) uuid = assistantUuid;

  if (controlPrompt !== undefined) {
    const controlMsg: Message = { role: 'user', content: controlPrompt };
    if (controlMetadata) {
      controlMsg.metadata = controlMetadata as unknown as JsonValue;
    }
    state.appendControl('user', controlMsg);
    const userUuid = await saveUserMessage(
      deps,
      context,
      controlMsg.content as string,
      uuid,
      controlMetadata
    );
    if (userUuid) uuid = userUuid;
  }

  return uuid;
}

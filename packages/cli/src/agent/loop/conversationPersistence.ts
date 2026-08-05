/**
 * conversationPersistence — 统一封装会话持久化操作
 *
 * 从 executeLoopGenerator 中提取的 JSONL 持久化逻辑，
 * 统一 contextMgr 获取与错误日志处理。
 */

import type { SubagentRunRef } from '../../context/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import type { ContentPart } from '../../services/ChatServiceInterface.js';
import type { JsonValue } from '../../store/types.js';
import type { ChatContext, UserMessageContent } from '../types.js';
import type { LoopDependencies } from './types.js';

const logger = createLogger(LogCategory.AGENT);

export const INTERRUPTED_TURN_MARKER = `<turn_aborted>
The previous turn was interrupted. Commands or tool calls may have partially completed; inspect the workspace and running processes before retrying.
</turn_aborted>`;

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
  metadata?: { inboxMessageId?: string }
): Promise<string | null> {
  try {
    const contextMgr = getContextMgr(deps);
    const hasPersistableContent =
      typeof message === 'string'
        ? message.trim() !== ''
        : (message as ContentPart[]).some((part) =>
            part.type === 'text' ? part.text.trim() !== '' : true
          );
    if (contextMgr && context.sessionId && hasPersistableContent) {
      return await contextMgr.saveMessage(
        context.sessionId,
        'user',
        message,
        parentUuid,
        metadata,
        context.subagentInfo
      );
    }
  } catch (error) {
    logger.warn('[Loop] 保存用户消息失败:', error);
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
  parentUuid: string | null
): Promise<string | null> {
  try {
    const contextMgr = getContextMgr(deps);
    if (contextMgr && context.sessionId && content.trim()) {
      return await contextMgr.saveMessage(
        context.sessionId,
        'assistant',
        content,
        parentUuid,
        undefined,
        context.subagentInfo
      );
    }
  } catch (error) {
    logger.warn('[Loop] 保存助手消息失败:', error);
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

/**
 * 保存工具调用到 JSONL。
 */
export async function saveToolUse(
  deps: LoopDependencies,
  context: ChatContext,
  toolName: string,
  params: JsonValue,
  parentUuid: string | null
): Promise<string | null> {
  try {
    const contextMgr = getContextMgr(deps);
    if (contextMgr && context.sessionId) {
      return await contextMgr.saveToolUse(
        context.sessionId,
        toolName,
        params,
        parentUuid,
        context.subagentInfo
      );
    }
  } catch (error) {
    logger.warn('[Loop] 保存工具调用失败:', error);
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
  subagentRef?: SubagentRunRef
): Promise<string | null> {
  try {
    const contextMgr = getContextMgr(deps);
    if (contextMgr && context.sessionId) {
      return await contextMgr.saveToolResult(
        context.sessionId,
        toolId,
        toolName,
        toolOutput,
        parentUuid,
        error,
        context.subagentInfo,
        subagentRef
      );
    }
  } catch (error_) {
    logger.warn('[Loop] 保存工具结果失败:', error_);
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
  metadata: {
    trigger: 'auto' | 'manual';
    preTokens: number;
    postTokens?: number;
    filesIncluded?: string[];
  }
): Promise<string | null> {
  try {
    const contextMgr = getContextMgr(deps);
    if (contextMgr && context.sessionId) {
      return await contextMgr.saveCompaction(
        context.sessionId,
        summary,
        metadata,
        null
      );
    }
  } catch (error) {
    logger.warn('[Loop] 保存压缩数据失败:', error);
  }
  return null;
}

/**
 * 上下文压缩服务
 * 负责协调整个压缩流程：分析文件、生成总结、创建压缩消息
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { PermissionMode } from '../config/types.js';
import { HookManager } from '../hooks/HookManager.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { consolidateAfterCompaction } from '../memory/MemoryConsolidation.js';
import {
  createChatServiceAsync,
  type Message,
  type UsageInfo,
} from '../services/ChatServiceInterface.js';
import {
  classifyProviderRetry,
  computeProviderRetryDelay,
  isProviderContextLimitError,
} from '../services/pi/providerRetry.js';
import { FileAccessTracker } from '../tools/builtin/file/FileAccessTracker.js';
import { abortableSleep, isAbortError } from '../utils/abort.js';
import { getCwd } from '../utils/cwd.js';
import { PathSecurity } from '../utils/pathSecurity.js';
import {
  compactionMessageText,
  compactionMessageUnits,
  planFallbackMessages,
  resolveCompactionTargetTokens,
} from './CompactionFallback.js';
import type { CompactionFailureReason } from './compactionCheckpoint.js';
import { FileAnalyzer, type FileContent } from './FileAnalyzer.js';
import { stripTokenBudgetHandoffMessages } from './TokenBudgetHandoff.js';
import { TokenCounter } from './TokenCounter.js';

const logger = createLogger(LogCategory.CONTEXT);

/**
 * 压缩选项
 */
export interface CompactionOptions {
  /** 触发方式：自动或手动 */
  trigger: 'auto' | 'manual';
  /** 模型名称 */
  modelName: string;
  /** pi-ai provider ID */
  modelProvider?: string;
  /** 上下文窗口大小（从 config.maxContextTokens 传入） */
  maxContextTokens: number;
  /** API Key（可选，默认使用环境变量） */
  apiKey?: string;
  /** Base URL（可选，默认使用环境变量） */
  baseURL?: string;
  /** 真实的 preTokens（可选，来自 LLM usage，比估算更准确） */
  actualPreTokens?: number;
  /** 会话 ID（用于 hooks） */
  sessionId?: string;
  /** 权限模式（用于 hooks） */
  permissionMode?: PermissionMode;
  /** 中止信号：abort 时抛 AbortError，让调用方知道是"被取消"而非"压缩失败" */
  signal?: AbortSignal;
  /** 当前未完成的用户请求；压缩后以有界 checkpoint 确定性保留 */
  activeTask?: string;
  /** 当前 active workspace；相对文件引用必须按它解析 */
  workspaceRoot?: string;
  /** Whether compaction may inspect or execute hooks for a host workspace. */
  workspaceAccess?: 'full' | 'none';
}

/**
 * 压缩结果
 */
export interface CompactionResult {
  /** 是否成功 */
  success: boolean;
  /** 总结内容 */
  summary: string;
  /** 压缩前 token 数 */
  preTokens: number;
  /** 压缩后 token 数 */
  postTokens: number;
  /** 包含的文件列表 */
  filesIncluded: string[];
  /** 压缩后的消息列表（用于发送给 LLM） */
  compactedMessages: Message[];
  /** compact_boundary 消息（用于保存到 JSONL） */
  boundaryMessage: Message;
  /** summary 消息（用于保存到 JSONL） */
  summaryMessage: Message;
  /** 错误信息（如果失败） */
  error?: string;
  /** 生成压缩摘要所消耗的模型 usage */
  usage?: UsageInfo;
  /** 摘要模型实际调用次数；本地 circuit-open fallback 为 0 */
  sampleAttempts?: number;
  /** context overflow 后实际执行的输入缩减次数 */
  inputReductions?: number;
  /** 为适配摘要窗口而从模型输入中省略的消息数 */
  messagesOmitted?: number;
  /** 为适配摘要窗口而从模型输入中省略的可重读文件数 */
  filesOmitted?: number;
  /** 摘要请求中替换为固定占位符的图片数 */
  imagesOmitted?: number;
  /** deterministic fallback 的 post-compact token 目标 */
  fallbackTargetTokens?: number;
  /** deterministic fallback 从 replacement tail 省略的源消息数 */
  fallbackMessagesOmitted?: number;
  /** deterministic fallback 为满足目标而缩减载荷的保留消息数 */
  fallbackMessagesTruncated?: number;
  /** fallback 的稳定失败分类 */
  failureReason?: CompactionFailureReason;
}

const sessionFailures = new Map<string, number>();
const MAX_CONSECUTIVE_FAILURES = 3;
export const MAX_COMPACTION_SAMPLE_ATTEMPTS = 3;
export {
  MAX_COMPACTION_CONTEXT_RATIO,
  MAX_COMPACTION_RESULT_RATIO,
  MAX_COMPACTION_TARGET_TOKENS,
  MIN_COMPACTION_EFFECTIVENESS_TOKENS,
} from './CompactionFallback.js';

class CompactionSamplingError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly failureReason: Exclude<CompactionFailureReason, 'circuit_open'>,
    readonly inputReductions: number,
    readonly messagesOmitted: number,
    readonly filesOmitted: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'CompactionSamplingError';
  }
}

function mergeUsage(
  accumulated: UsageInfo | undefined,
  current: UsageInfo | undefined
): UsageInfo | undefined {
  if (!current) return accumulated;
  if (!accumulated) return { ...current };
  const sumOptional = (
    left: number | undefined,
    right: number | undefined
  ): number | undefined =>
    left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
  const reasoningTokens = sumOptional(
    accumulated.reasoningTokens,
    current.reasoningTokens
  );
  const cacheCreationInputTokens = sumOptional(
    accumulated.cacheCreationInputTokens,
    current.cacheCreationInputTokens
  );
  const cacheReadInputTokens = sumOptional(
    accumulated.cacheReadInputTokens,
    current.cacheReadInputTokens
  );
  const costUsd = sumOptional(accumulated.costUsd, current.costUsd);
  const promptCacheBreak = current.promptCacheBreak ?? accumulated.promptCacheBreak;
  return {
    promptTokens: accumulated.promptTokens + current.promptTokens,
    completionTokens: accumulated.completionTokens + current.completionTokens,
    totalTokens: accumulated.totalTokens + current.totalTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(promptCacheBreak ? { promptCacheBreak } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

class CompactionBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompactionBlockedError';
  }
}

export function isCompactionBlockedError(
  error: unknown
): error is CompactionBlockedError {
  return error instanceof CompactionBlockedError;
}

const CONTINUATION_LEDGER_HEADINGS = [
  'Objective and constraints',
  'Decisions and rationale',
  'Workspace mutations',
  'Verification evidence',
  'Active tasks and background work',
  'Open risks or blockers',
  'Exact next action',
] as const;

type ContinuationLedgerHeading = (typeof CONTINUATION_LEDGER_HEADINGS)[number];

interface ExactContinuationRecord {
  heading: ContinuationLedgerHeading;
  payload: string;
}

const EXACT_CONTINUATION_RECORD_PATTERN =
  /^EXACT CONTINUATION RECORD \[([^\]\r\n]{1,64})\] :: ([^\r\n]{1,2048})$/gm;
const MAX_EXACT_CONTINUATION_RECORDS = 32;
const MAX_EXACT_CONTINUATION_RECORD_CHARS = 16_384;

function normalizedLedgerHeading(value: string): ContinuationLedgerHeading | undefined {
  const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase();
  return CONTINUATION_LEDGER_HEADINGS.find(
    (heading) => heading.toLowerCase() === normalized
  );
}

function messageText(message: Message): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
}

export function extractExactContinuationRecords(
  messages: readonly Message[]
): ExactContinuationRecord[] {
  const records: ExactContinuationRecord[] = [];
  const identities = new Set<string>();
  let retainedChars = 0;

  for (const message of messages) {
    if (isCompactSummaryMessage(message)) continue;
    const content = messageText(message);
    for (const match of content.matchAll(EXACT_CONTINUATION_RECORD_PATTERN)) {
      const heading = match[1] ? normalizedLedgerHeading(match[1]) : undefined;
      const payload = match[2]?.trim();
      if (!heading || !payload) continue;
      const identity = `${heading}\0${payload}`;
      if (identities.has(identity)) continue;
      if (
        records.length >= MAX_EXACT_CONTINUATION_RECORDS ||
        retainedChars + payload.length > MAX_EXACT_CONTINUATION_RECORD_CHARS
      ) {
        return records;
      }
      identities.add(identity);
      retainedChars += payload.length;
      records.push({ heading, payload });
    }
  }
  return records;
}

function normalizedLedgerLine(line: string): string {
  return line
    .trim()
    .replace(/^(?:[-+*]|\d+[.)])\s+/, '')
    .trim();
}

export function reconcileExactContinuationRecords(
  summary: string,
  messages: readonly Message[]
): string {
  const records = extractExactContinuationRecords(messages);
  if (records.length === 0) return summary;

  const protectedPayloads = records.map((record) => record.payload);
  const sections = new Map<ContinuationLedgerHeading, string[]>(
    CONTINUATION_LEDGER_HEADINGS.map((heading) => [heading, []])
  );
  let current: ContinuationLedgerHeading | undefined;

  for (const line of summary.split(/\r?\n/)) {
    const headingMatch = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (headingMatch) {
      current = headingMatch[1] ? normalizedLedgerHeading(headingMatch[1]) : undefined;
      continue;
    }
    const normalized = normalizedLedgerLine(line);
    if (!normalized) continue;
    if (protectedPayloads.some((payload) => normalized.includes(payload))) {
      continue;
    }
    (sections.get(current ?? 'Objective and constraints') ?? []).push(line.trim());
  }

  for (const record of records) {
    sections.get(record.heading)?.push(`- ${record.payload}`);
  }

  return CONTINUATION_LEDGER_HEADINGS.map((heading) => {
    const lines = sections.get(heading) ?? [];
    return [
      `## ${heading}`,
      ...(lines.length > 0 ? lines : ['- No evidence observed.']),
    ].join('\n');
  }).join('\n\n');
}

function escapeReservedLedgerHeadings(content: string): string {
  return CONTINUATION_LEDGER_HEADINGS.reduce(
    (escaped, heading) =>
      escaped.replaceAll(heading, heading.replaceAll(' ', '\\u0020')),
    content
  );
}

function isCompactSummaryMessage(message: Message): boolean {
  const metadata = message.metadata;
  return (
    metadata !== null &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    metadata.isCompactSummary === true
  );
}

function compactionSessionKey(workspaceRoot?: string, sessionId?: string): string {
  return JSON.stringify([path.resolve(workspaceRoot ?? getCwd()), sessionId ?? null]);
}

const DEFAULT_COMPACTION_MESSAGE_CHARS = 5_000;
const MIN_COMPACTION_MESSAGE_CHARS = 625;

interface CompactionSampleInput {
  messages: Message[];
  fileContents: FileContent[];
  maxMessageChars: number;
  inputReductions: number;
  messagesOmitted: number;
  filesOmitted: number;
}

function countCompactionImages(messages: readonly Message[]): number {
  return messages.reduce(
    (count, message) =>
      count +
      (Array.isArray(message.content)
        ? message.content.filter((part) => part.type === 'image_url').length
        : 0),
    0
  );
}

function reduceCompactionSampleInput(
  input: CompactionSampleInput
): CompactionSampleInput | undefined {
  const currentChars = buildCompactionPrompt(input.messages, input.fileContents, {
    maxMessageChars: input.maxMessageChars,
  }).length;

  let nextMessages = input.messages;
  let nextFiles = input.fileContents;
  let nextMaxMessageChars = input.maxMessageChars;
  let omittedMessages = input.messagesOmitted;
  let omittedFiles = input.filesOmitted;

  if (nextFiles.length > 0) {
    omittedFiles += nextFiles.length;
    nextFiles = [];
  } else {
    const units = compactionMessageUnits(nextMessages);
    if (units.length > 1) {
      const dropCount = Math.min(
        units.length - 1,
        Math.max(1, Math.ceil(units.length * 0.25))
      );
      const dropped = units.slice(0, dropCount).flat();
      nextMessages = units.slice(dropCount).flat();
      omittedMessages += dropped.length;
    } else if (nextMaxMessageChars > MIN_COMPACTION_MESSAGE_CHARS) {
      nextMaxMessageChars = Math.max(
        MIN_COMPACTION_MESSAGE_CHARS,
        Math.floor(nextMaxMessageChars / 2)
      );
    } else {
      return undefined;
    }
  }

  const next: CompactionSampleInput = {
    messages: nextMessages,
    fileContents: nextFiles,
    maxMessageChars: nextMaxMessageChars,
    inputReductions: input.inputReductions + 1,
    messagesOmitted: omittedMessages,
    filesOmitted: omittedFiles,
  };
  const nextChars = buildCompactionPrompt(next.messages, next.fileContents, {
    maxMessageChars: next.maxMessageChars,
  }).length;
  return nextChars < currentChars ? next : undefined;
}

/**
 * 构建面向继续执行的有界压缩 prompt。
 */
export function buildCompactionPrompt(
  messages: readonly Message[],
  fileContents: readonly FileContent[],
  options: { maxMessageChars?: number } = {}
): string {
  const maxMessageChars = options.maxMessageChars ?? DEFAULT_COMPACTION_MESSAGE_CHARS;
  const messagesText = messages
    .map((msg, index) => {
      const role = msg.role || 'unknown';
      const rawContent = compactionMessageText(msg);
      const content = isCompactSummaryMessage(msg)
        ? escapeReservedLedgerHeadings(rawContent)
        : rawContent;
      const truncatedContent =
        content.length > maxMessageChars
          ? content.substring(0, maxMessageChars) + '...'
          : content;

      return `[${index + 1}] ${role}: ${truncatedContent}`;
    })
    .join('\n\n');

  const filesText = fileContents
    .map((file) => `### ${file.path}\n\`\`\`\n${file.content}\n\`\`\``)
    .join('\n\n');

  const instructions = `Your task is to create a bounded continuation ledger that lets another coding-agent invocation resume the active work without losing the execution frontier.

Use <analysis> tags to privately check the retained evidence before producing the ledger. Follow these hard rules:
- distinguish observed facts from intended work; label plans, pending work, and unverified claims explicitly.
- preserve exact commands, tool arguments, and final-response constraints when necessary for continuation.
- never mark unfinished work complete.
- never convert a plan into a completed mutation.
- never invent successful verification, completed work, file changes, or background-agent results.
- never include credentials or hidden control messages.
- never include raw reasoning in the summary.
- omit unrelated historical detail and prefer the most recent authoritative evidence.
- when source evidence explicitly labels a literal as an exact continuation record and names one of the seven ledger headings, copy that literal verbatim as one standalone list item under the named heading. The explicit source syntax is 'EXACT CONTINUATION RECORD [<heading>] :: <payload>'.
- Only <payload>, the text after the exact delimiter :: , belongs in the ledger item. Do not copy the record label or heading annotation into the item.
- Do not omit, rewrite, split, decorate, relocate, reorder, or append text to an exact continuation record. Do not infer or auto-repair a missing record, payload, status, or heading assignment. Credential and hidden-control exclusions remain higher priority.

Inside <summary>, use exactly these seven headings in this order, with each heading appearing exactly once. If the transcript has no evidence for a heading, state that no evidence was observed rather than inventing it.

${CONTINUATION_LEDGER_HEADINGS.map((heading) => `## ${heading}`).join('\n')}`;

  return `${instructions}

## Conversation History

${messagesText}

${fileContents.length > 0 ? `## Important Files\n\n${filesText}\n\n` : ''}Respond with one <analysis> section followed by one <summary> section. The summary must obey the ledger contract above.`;
}

/**
 * Compaction Service - 上下文压缩服务
 */
export class CompactionService {
  /** 保留比例（20%） */
  private static readonly RETAIN_PERCENT = 0.2;

  /** Active task checkpoint 的最大长度，避免把超长原始输入重新塞回上下文。 */
  private static readonly ACTIVE_TASK_MAX_CHARS = 6_000;

  /**
   * 执行压缩
   *
   * @param messages - 消息列表
   * @param options - 压缩选项
   * @returns 压缩结果
   */
  static async compact(
    messages: Message[],
    options: CompactionOptions
  ): Promise<CompactionResult> {
    const sourceMessages = stripTokenBudgetHandoffMessages(messages);

    // 快速路径：如果 signal 已 aborted，立即抛出 AbortError
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // 优先使用传入的真实 preTokens（来自 LLM usage），否则使用估算
    const removedHandoffMarker = sourceMessages.length !== messages.length;
    const estimatedSourceTokens = TokenCounter.countTokens(
      sourceMessages,
      options.modelName
    );
    let preTokens: number;
    let tokenSource: 'actual (from LLM usage)' | 'estimated';
    if (!removedHandoffMarker && options.actualPreTokens !== undefined) {
      preTokens = options.actualPreTokens;
      tokenSource = 'actual (from LLM usage)';
    } else {
      preTokens = estimatedSourceTokens;
      tokenSource = 'estimated';
    }
    logger.debug(`[CompactionService] preTokens source: ${tokenSource}`);

    // 执行 Compaction Hook（压缩前）
    // Hook 可以阻止压缩
    let blockReason: string | undefined;
    let completedSampleAttempts = 0;
    let imagesOmitted = 0;
    if (options.workspaceAccess !== 'none') {
      try {
        const hookManager = HookManager.getInstance();
        const hookResult = await hookManager.executeCompactionHooks(options.trigger, {
          projectDir: options.workspaceRoot ?? getCwd(),
          sessionId: options.sessionId || 'unknown',
          permissionMode: options.permissionMode || PermissionMode.DEFAULT,
          messagesBefore: sourceMessages.length,
          tokensBefore: preTokens,
        });

        // 如果 hook 返回 blockCompaction: true，阻止压缩
        if (hookResult.blockCompaction) {
          blockReason = hookResult.blockReason || 'Compaction blocked by hook';
        }

        // 如果有警告，记录日志
        if (hookResult.warning) {
          logger.warn(
            `[CompactionService] Compaction hook warning: ${hookResult.warning}`
          );
        }
      } catch (hookError) {
        // Hook 执行失败不应阻止压缩
        logger.warn('[CompactionService] Compaction hook execution failed:', hookError);
      }
    }
    if (blockReason) {
      logger.debug(`[CompactionService] Compaction hook 阻止压缩: ${blockReason}`);
      throw new CompactionBlockedError(blockReason);
    }

    const sessionKey = compactionSessionKey(options.workspaceRoot, options.sessionId);
    const failures = sessionFailures.get(sessionKey) ?? 0;
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      logger.warn(
        `[CompactionService] Circuit breaker open (${failures} consecutive failures for session ${options.sessionId ?? 'unknown'}), using fallback`
      );
      return this.fallbackCompact(
        sourceMessages,
        options,
        preTokens,
        new Error('Circuit breaker open'),
        0,
        'circuit_open',
        0,
        0,
        0,
        0
      );
    }

    try {
      logger.debug('[CompactionService] 开始压缩，消息数:', sourceMessages.length);
      logger.debug('[CompactionService] 压缩前 tokens:', preTokens);

      // 1. 分析并读取重点文件
      const fileRefs =
        options.workspaceAccess === 'none'
          ? []
          : FileAnalyzer.analyzeFiles(sourceMessages);
      const filePaths = fileRefs.map((f) => f.path);
      logger.debug('[CompactionService] 提取重点文件:', filePaths);

      const fileContents = await FileAnalyzer.readFilesContent(
        filePaths,
        options.workspaceRoot
      );
      logger.debug('[CompactionService] 成功读取文件:', fileContents.length);

      // 2. 生成总结
      imagesOmitted = countCompactionImages(sourceMessages);
      const generated = await this.generateSummary(
        sourceMessages,
        fileContents,
        options
      );
      completedSampleAttempts = generated.attempts;
      const summary = reconcileExactContinuationRecords(
        generated.summary,
        sourceMessages
      );
      logger.debug('[CompactionService] 生成总结，长度:', summary.length);

      // 3. 计算保留范围并过滤孤儿 tool 消息
      const retainCount = Math.ceil(sourceMessages.length * this.RETAIN_PERCENT);
      const candidateMessages = sourceMessages.slice(-retainCount);

      // 收集保留消息中所有 tool_call 的 ID
      const availableToolCallIds = new Set<string>();
      for (const msg of candidateMessages) {
        if (msg.role === 'assistant' && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            availableToolCallIds.add(tc.id);
          }
        }
      }

      // 过滤掉孤儿 tool 消息（tool_call_id 对应的 assistant 消息已被压缩）
      const retainedMessages = candidateMessages.filter((msg) => {
        if (msg.role === 'tool' && msg.tool_call_id) {
          return availableToolCallIds.has(msg.tool_call_id);
        }
        return true; // 保留其他所有消息
      });

      logger.debug('[CompactionService] 保留消息数:', retainCount);
      logger.debug('[CompactionService] 过滤后保留消息数:', retainedMessages.length);

      // 4. 创建压缩消息
      const boundaryMessageId = nanoid();
      const boundaryMessage = this.createBoundaryMessage(
        boundaryMessageId,
        options.trigger,
        preTokens
      );

      const summaryMessageId = nanoid();
      const summaryMessage = this.createSummaryMessage(summaryMessageId, summary);

      // 5. 构建新消息列表（用于发送给 LLM）
      const compactedMessages = [summaryMessage, ...retainedMessages];

      // === Post-Compact 上下文恢复 ===
      const restorationMessage =
        options.workspaceAccess === 'none'
          ? null
          : await this.buildFileRestorationMessage(
              options.workspaceRoot,
              options.sessionId
            );
      if (restorationMessage) {
        compactedMessages.push(restorationMessage);
      }
      const activeTaskMessage = this.buildActiveTaskMessage(options.activeTask);
      if (activeTaskMessage) {
        compactedMessages.push(activeTaskMessage);
      }

      const postTokens = TokenCounter.countTokens(compactedMessages, options.modelName);
      const maxEffectivePostTokens = resolveCompactionTargetTokens(
        estimatedSourceTokens,
        options.maxContextTokens
      );
      if (postTokens > maxEffectivePostTokens) {
        const error = new Error(
          `Compaction output retained ${postTokens} estimated tokens; maximum is ${maxEffectivePostTokens}`
        );
        sessionFailures.set(sessionKey, (sessionFailures.get(sessionKey) ?? 0) + 1);
        logger.warn('[CompactionService] 摘要缩减不足，使用降级策略', {
          estimatedSourceTokens,
          postTokens,
          maxEffectivePostTokens,
        });
        return this.fallbackCompact(
          sourceMessages,
          options,
          preTokens,
          error,
          generated.attempts,
          'insufficient_reduction',
          generated.inputReductions,
          generated.messagesOmitted,
          generated.filesOmitted,
          imagesOmitted,
          generated.usage
        );
      }

      logger.debug('[CompactionService] 压缩完成！');
      logger.debug(
        '[CompactionService] Token 变化:',
        preTokens,
        '->',
        postTokens,
        `(-${((1 - postTokens / preTokens) * 100).toFixed(1)}%)`
      );

      sessionFailures.delete(sessionKey);

      // 非阻塞记忆巩固：从被丢弃的消息中提取 learnings
      const discardedMessages = sourceMessages.slice(
        0,
        sourceMessages.length - retainCount
      );
      consolidateAfterCompaction(discardedMessages, {
        workspaceRoot: options.workspaceRoot ?? getCwd(),
        workspaceAccess: options.workspaceAccess,
      }).catch((_) => void _);

      return {
        success: true,
        summary,
        preTokens,
        postTokens,
        filesIncluded:
          generated.filesOmitted > 0 ? [] : fileContents.map((file) => file.path),
        compactedMessages,
        boundaryMessage,
        summaryMessage,
        usage: generated.usage,
        sampleAttempts: generated.attempts,
        inputReductions: generated.inputReductions,
        messagesOmitted: generated.messagesOmitted,
        filesOmitted: generated.filesOmitted,
        imagesOmitted,
      };
    } catch (error) {
      // AbortError（宽口径）: 用户取消/interrupt，不应计入失败次数也不应走 fallback
      if (isAbortError(error)) {
        throw error;
      }
      sessionFailures.set(sessionKey, (sessionFailures.get(sessionKey) ?? 0) + 1);
      logger.error('[CompactionService] 压缩失败，使用降级策略', error);
      return this.fallbackCompact(
        sourceMessages,
        options,
        preTokens,
        error,
        error instanceof CompactionSamplingError
          ? error.attempts
          : completedSampleAttempts,
        error instanceof CompactionSamplingError
          ? error.failureReason
          : 'deterministic',
        error instanceof CompactionSamplingError ? error.inputReductions : 0,
        error instanceof CompactionSamplingError ? error.messagesOmitted : 0,
        error instanceof CompactionSamplingError ? error.filesOmitted : 0,
        imagesOmitted
      );
    }
  }

  /**
   * 生成总结（调用 LLM）
   *
   * @param messages - 消息列表
   * @param fileContents - 文件内容列表
   * @param options - 压缩选项
   * @returns 总结内容
   */
  private static async generateSummary(
    messages: Message[],
    fileContents: FileContent[],
    options: CompactionOptions
  ): Promise<{
    summary: string;
    usage?: UsageInfo;
    attempts: number;
    inputReductions: number;
    messagesOmitted: number;
    filesOmitted: number;
  }> {
    logger.debug('[CompactionService] 使用压缩模型:', options.modelName);

    // 预检查：如果 signal 已 aborted，不发起 LLM 调用
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // 创建 ChatService
    const chatService = await createChatServiceAsync({
      apiKey: options.apiKey || process.env.BLADE_API_KEY,
      baseUrl: options.baseURL || process.env.BLADE_BASE_URL,
      model: options.modelName,
      temperature: 0,
      maxOutputTokens: 8000, // 压缩输出限制
      timeout: 60000,
      maxRetries: 0,
      provider: options.modelProvider ?? 'openai',
    });

    let usage: UsageInfo | undefined;
    let sampleInput: CompactionSampleInput = {
      messages,
      fileContents,
      maxMessageChars: DEFAULT_COMPACTION_MESSAGE_CHARS,
      inputReductions: 0,
      messagesOmitted: 0,
      filesOmitted: 0,
    };
    for (let attempt = 1; attempt <= MAX_COMPACTION_SAMPLE_ATTEMPTS; attempt++) {
      try {
        const prompt = buildCompactionPrompt(
          sampleInput.messages,
          sampleInput.fileContents,
          { maxMessageChars: sampleInput.maxMessageChars }
        );
        const response = await chatService.chat(
          [{ role: 'user', content: prompt }],
          [], // 不传递工具参数
          options.signal, // 传递 abort signal
          {
            providerAdmission: {
              sessionId:
                options.sessionId ??
                `compaction:${compactionSessionKey(options.workspaceRoot)}`,
              ownerId:
                options.sessionId ??
                `compaction:${compactionSessionKey(options.workspaceRoot)}`,
              requestClass: 'foreground',
            },
          }
        );
        usage = mergeUsage(usage, response.usage);

        // 提取 <summary> 标签内容
        const content = response.content || '';
        const summaryMatch = content.match(/<summary>([\s\S]*?)<\/summary>/);
        const summary = (summaryMatch ? summaryMatch[1] : content).trim();
        if (summary) {
          if (!summaryMatch) {
            logger.warn('[CompactionService] 总结格式不正确，使用完整响应');
          }
          return {
            summary,
            usage,
            attempts: attempt,
            inputReductions: sampleInput.inputReductions,
            messagesOmitted: sampleInput.messagesOmitted,
            filesOmitted: sampleInput.filesOmitted,
          };
        }

        if (attempt === MAX_COMPACTION_SAMPLE_ATTEMPTS) {
          throw new CompactionSamplingError(
            'Compaction summary was empty after bounded retries',
            attempt,
            'empty_exhausted',
            sampleInput.inputReductions,
            sampleInput.messagesOmitted,
            sampleInput.filesOmitted
          );
        }
        logger.warn(
          `[CompactionService] 摘要响应为空，准备重试 (${attempt}/${MAX_COMPACTION_SAMPLE_ATTEMPTS})`
        );
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (error instanceof CompactionSamplingError) throw error;
        if (isProviderContextLimitError(error)) {
          const reduced =
            attempt < MAX_COMPACTION_SAMPLE_ATTEMPTS
              ? reduceCompactionSampleInput(sampleInput)
              : undefined;
          if (!reduced) {
            throw new CompactionSamplingError(
              error instanceof Error ? error.message : String(error),
              attempt,
              'context_exhausted',
              sampleInput.inputReductions,
              sampleInput.messagesOmitted,
              sampleInput.filesOmitted,
              { cause: error }
            );
          }
          sampleInput = reduced;
          logger.warn(
            `[CompactionService] 摘要输入超出窗口，缩减后重试 (${attempt}/${MAX_COMPACTION_SAMPLE_ATTEMPTS})`
          );
          continue;
        }
        const retryable = classifyProviderRetry(error).retryable;
        if (!retryable || attempt === MAX_COMPACTION_SAMPLE_ATTEMPTS) {
          throw new CompactionSamplingError(
            error instanceof Error ? error.message : String(error),
            attempt,
            retryable ? 'transient_exhausted' : 'deterministic',
            sampleInput.inputReductions,
            sampleInput.messagesOmitted,
            sampleInput.filesOmitted,
            { cause: error }
          );
        }
        logger.warn(
          `[CompactionService] 摘要采样瞬态失败，准备重试 (${attempt}/${MAX_COMPACTION_SAMPLE_ATTEMPTS})`
        );
      }
      const delayMs = computeProviderRetryDelay(attempt, undefined, { random: 0 });
      await abortableSleep(delayMs, options.signal, { throwOnAbort: true });
    }

    throw new CompactionSamplingError(
      'Compaction summary retry loop exhausted',
      MAX_COMPACTION_SAMPLE_ATTEMPTS,
      'transient_exhausted',
      sampleInput.inputReductions,
      sampleInput.messagesOmitted,
      sampleInput.filesOmitted
    );
  }

  /**
   * 创建 compact_boundary 消息
   *
   * @param parentId - 父消息 ID
   * @param trigger - 触发方式
   * @param preTokens - 压缩前 token 数
   * @returns boundary 消息
   */
  private static createBoundaryMessage(
    parentId: string,
    trigger: 'auto' | 'manual',
    preTokens: number
  ): Message {
    return {
      id: nanoid(),
      role: 'system',
      content: 'Conversation compacted',
      // 使用 metadata 存储额外信息
      metadata: {
        type: 'system',
        subtype: 'compact_boundary',
        parentId,
        compactMetadata: {
          trigger,
          preTokens,
        },
      },
    } as Message;
  }

  /**
   * 创建 summary 消息
   *
   * @param parentId - 父消息 ID（compact_boundary 的 ID）
   * @param summary - 总结内容
   * @returns summary 消息
   */
  private static createSummaryMessage(parentId: string, summary: string): Message {
    return {
      id: nanoid(),
      role: 'user',
      content: summary,
      metadata: {
        parentId,
        isCompactSummary: true,
      },
    } as Message;
  }

  /**
   * 获取最近访问的文件路径
   * 从 FileAccessTracker 中获取按访问时间降序排列的文件
   *
   * @param limit - 最多返回的文件数量
   * @returns 去重的文件路径列表
   */
  private static async getRecentlyAccessedFiles(
    limit: number,
    workspaceRoot?: string,
    sessionId?: string
  ): Promise<string[]> {
    const tracker = FileAccessTracker.getInstance();

    // 按最后访问时间降序排序
    const sorted = tracker
      .getTrackedRecords()
      .filter((record) => !sessionId || record.sessionId === sessionId)
      .sort((left, right) => right.accessTime - left.accessTime);

    const eligible: string[] = [];
    for (const record of sorted) {
      if (
        workspaceRoot &&
        !(await PathSecurity.isWithinWorkspaceResolved(record.filePath, workspaceRoot))
      ) {
        continue;
      }
      if (!eligible.includes(record.filePath)) {
        eligible.push(record.filePath);
      }
      if (eligible.length >= limit) break;
    }
    return eligible;
  }

  /**
   * 构建文件恢复消息
   * 读取最近访问的文件内容，构建 system-reminder 格式的恢复消息
   *
   * @returns 恢复消息，如果没有可恢复的文件则返回 null
   */
  private static async buildFileRestorationMessage(
    workspaceRoot?: string,
    sessionId?: string
  ): Promise<Message | null> {
    const recentFiles = await this.getRecentlyAccessedFiles(
      5,
      workspaceRoot,
      sessionId
    );
    if (recentFiles.length === 0) {
      return null;
    }

    const fileRestorations: string[] = [];

    for (const filePath of recentFiles) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        const preview = lines.slice(0, 200).join('\n');
        const truncated =
          lines.length > 200 ? `\n... (${lines.length - 200} more lines)` : '';
        fileRestorations.push(
          `<file path="${filePath}" lines="${lines.length}">\n${preview}${truncated}\n</file>`
        );
      } catch {
        // 文件可能已被删除，静默跳过
      }
    }

    if (fileRestorations.length === 0) {
      return null;
    }

    const restorationContent = [
      '<system-reminder>',
      'Post-compaction file restoration.' +
        ' These files were recently accessed' +
        ' in the conversation:',
      ...fileRestorations,
      '</system-reminder>',
    ].join('\n');

    logger.debug('[CompactionService] Post-compact 恢复文件:', recentFiles.length);

    return {
      id: nanoid(),
      role: 'user',
      content: restorationContent,
      metadata: {
        isPostCompactRestoration: true,
      },
    } as Message;
  }

  private static buildActiveTaskMessage(activeTask?: string): Message | null {
    if (!activeTask) return null;

    const maxChars = this.ACTIVE_TASK_MAX_CHARS;
    const headChars = Math.floor(maxChars * 0.75);
    const checkpoint =
      activeTask.length <= maxChars
        ? activeTask
        : [
            activeTask.slice(0, headChars),
            '\n...[active task checkpoint truncated]...\n',
            activeTask.slice(-(maxChars - headChars)),
          ].join('');

    return {
      id: nanoid(),
      role: 'user',
      content: [
        '<system-reminder>',
        'Post-compaction active task checkpoint. This preserves the user request, not execution status.',
        'Continue from the authoritative statuses in the compaction ledger and retained tail; never repeat actions already marked complete, applied, or passed.',
        'Treat failed actions as historical evidence and follow the pending exact next action, which may require a corrected retry.',
        "Preserve the request's exact literals and constraints:",
        checkpoint,
        'Resume only the pending exact next action. After it succeeds, obey any exact final-response protocol literally and add no unrequested text.',
        '</system-reminder>',
      ].join('\n'),
      metadata: {
        isPostCompactActiveTask: true,
      },
    } as Message;
  }

  /**
   * 降级策略：按 token 预算保留最近完整消息单元
   *
   * @param messages - 消息列表
   * @param options - 压缩选项
   * @param preTokens - 压缩前 token 数
   * @param error - 错误信息
   * @returns 压缩结果
   */
  private static fallbackCompact(
    messages: Message[],
    options: CompactionOptions,
    preTokens: number,
    error: unknown,
    sampleAttempts: number,
    failureReason: CompactionFailureReason,
    inputReductions: number,
    messagesOmitted: number,
    filesOmitted: number,
    imagesOmitted: number,
    usage?: UsageInfo
  ): CompactionResult {
    const boundaryMessageId = nanoid();
    const boundaryMessage = this.createBoundaryMessage(
      boundaryMessageId,
      options.trigger,
      preTokens
    );

    const errorMsg = error instanceof Error ? error.message : String(error);
    const summaryMessageId = nanoid();
    const fallbackSummary = reconcileExactContinuationRecords(
      '[Automatic compaction failed; using bounded fallback]\n\n' +
        'The exact continuation records and retained tail are authoritative for ' +
        'execution status. Do not repeat actions marked complete, applied, or ' +
        'passed. Treat failed actions as historical evidence and execute only the ' +
        'pending exact next action, which may require a corrected retry, before ' +
        'claiming completion. After pending work succeeds, obey exact final-response ' +
        'constraints from the preserved request literally.',
      messages
    );
    const summaryMessage = this.createSummaryMessage(summaryMessageId, fallbackSummary);

    const activeTaskMessage = this.buildActiveTaskMessage(options.activeTask);
    const fixedMessages = [
      summaryMessage,
      ...(activeTaskMessage ? [activeTaskMessage] : []),
    ];
    const fallbackPlan = planFallbackMessages(messages, fixedMessages, {
      maxContextTokens: options.maxContextTokens,
      modelName: options.modelName,
      preservedActiveTask:
        options.activeTask && options.activeTask.length <= this.ACTIVE_TASK_MAX_CHARS
          ? options.activeTask
          : undefined,
    });
    const compactedMessages = [
      summaryMessage,
      ...fallbackPlan.messages,
      ...(activeTaskMessage ? [activeTaskMessage] : []),
    ];
    const postTokens = TokenCounter.countTokens(compactedMessages, options.modelName);
    if (postTokens > fallbackPlan.targetTokens) {
      throw new Error(
        `Fallback compaction retained ${postTokens} estimated tokens; target is ${fallbackPlan.targetTokens}`
      );
    }

    return {
      success: false,
      summary:
        typeof summaryMessage.content === 'string'
          ? summaryMessage.content
          : summaryMessage.content
              .filter((p) => p.type === 'text')
              .map((p) => (p as { text: string }).text)
              .join('\n'),
      preTokens,
      postTokens,
      filesIncluded: [],
      compactedMessages,
      boundaryMessage,
      summaryMessage,
      error: errorMsg,
      usage,
      sampleAttempts,
      inputReductions,
      messagesOmitted,
      filesOmitted,
      imagesOmitted,
      fallbackTargetTokens: fallbackPlan.targetTokens,
      fallbackMessagesOmitted: fallbackPlan.messagesOmitted,
      fallbackMessagesTruncated: fallbackPlan.messagesTruncated,
      failureReason,
    };
  }
}

export function resetCompactionCircuitBreaker(
  sessionId?: string,
  workspaceRoot?: string
): void {
  if (!sessionId && !workspaceRoot) {
    sessionFailures.clear();
    return;
  }

  if (workspaceRoot) {
    sessionFailures.delete(compactionSessionKey(workspaceRoot, sessionId));
    return;
  }

  for (const key of sessionFailures.keys()) {
    const [, keySessionId] = JSON.parse(key) as [string, string | null];
    if (keySessionId === sessionId) {
      sessionFailures.delete(key);
    }
  }
}

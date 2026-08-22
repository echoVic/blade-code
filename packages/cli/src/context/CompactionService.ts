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
import { FileAccessTracker } from '../tools/builtin/file/FileAccessTracker.js';
import { isAbortError } from '../utils/abort.js';
import { getCwd } from '../utils/cwd.js';
import { PathSecurity } from '../utils/pathSecurity.js';
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
}

const sessionFailures = new Map<string, number>();
const MAX_CONSECUTIVE_FAILURES = 3;

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

/**
 * 构建面向继续执行的有界压缩 prompt。
 */
export function buildCompactionPrompt(
  messages: readonly Message[],
  fileContents: readonly FileContent[]
): string {
  const messagesText = messages
    .map((msg, index) => {
      const role = msg.role || 'unknown';
      const rawContent =
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const content = isCompactSummaryMessage(msg)
        ? escapeReservedLedgerHeadings(rawContent)
        : rawContent;
      const maxLength = 5_000;
      const truncatedContent =
        content.length > maxLength ? content.substring(0, maxLength) + '...' : content;

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
  /** 压缩阈值百分比（80%） */
  private static readonly THRESHOLD_PERCENT = 0.8;

  /** 保留比例（20%） */
  private static readonly RETAIN_PERCENT = 0.2;

  /** 降级时保留比例（30%） */
  private static readonly FALLBACK_RETAIN_PERCENT = 0.3;

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
    let preTokens: number;
    let tokenSource: 'actual (from LLM usage)' | 'estimated';
    if (!removedHandoffMarker && options.actualPreTokens !== undefined) {
      preTokens = options.actualPreTokens;
      tokenSource = 'actual (from LLM usage)';
    } else {
      preTokens = TokenCounter.countTokens(sourceMessages, options.modelName);
      tokenSource = 'estimated';
    }
    logger.debug(`[CompactionService] preTokens source: ${tokenSource}`);

    // 执行 Compaction Hook（压缩前）
    // Hook 可以阻止压缩
    let blockReason: string | undefined;
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
        new Error('Circuit breaker open')
      );
    }

    try {
      logger.debug('[CompactionService] 开始压缩，消息数:', sourceMessages.length);
      logger.debug('[CompactionService] 压缩前 tokens:', preTokens);

      // 1. 分析并读取重点文件
      const fileRefs = FileAnalyzer.analyzeFiles(sourceMessages);
      const filePaths = fileRefs.map((f) => f.path);
      logger.debug('[CompactionService] 提取重点文件:', filePaths);

      const fileContents = await FileAnalyzer.readFilesContent(
        filePaths,
        options.workspaceRoot
      );
      logger.debug('[CompactionService] 成功读取文件:', fileContents.length);

      // 2. 生成总结
      const generated = await this.generateSummary(
        sourceMessages,
        fileContents,
        options
      );
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
      const restorationMessage = await this.buildFileRestorationMessage(
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
      consolidateAfterCompaction(discardedMessages).catch((_) => void _);

      return {
        success: true,
        summary,
        preTokens,
        postTokens,
        filesIncluded: fileContents.map((file) => file.path),
        compactedMessages,
        boundaryMessage,
        summaryMessage,
        usage: generated.usage,
      };
    } catch (error) {
      // AbortError（宽口径）: 用户取消/interrupt，不应计入失败次数也不应走 fallback
      if (isAbortError(error)) {
        throw error;
      }
      sessionFailures.set(sessionKey, (sessionFailures.get(sessionKey) ?? 0) + 1);
      logger.error('[CompactionService] 压缩失败，使用降级策略', error);
      return this.fallbackCompact(sourceMessages, options, preTokens, error);
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
  ): Promise<{ summary: string; usage?: UsageInfo }> {
    const prompt = buildCompactionPrompt(messages, fileContents);

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
      provider: options.modelProvider ?? 'openai',
    });

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

    // 提取 <summary> 标签内容
    const content = response.content || '';
    const summaryMatch = content.match(/<summary>([\s\S]*?)<\/summary>/);

    if (!summaryMatch) {
      logger.warn('[CompactionService] 总结格式不正确，使用完整响应');
      return { summary: content, usage: response.usage };
    }

    return { summary: summaryMatch[1].trim(), usage: response.usage };
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
        'Post-compaction active task checkpoint. Continue this user-authored request; preserve its exact literals and constraints:',
        checkpoint,
        '</system-reminder>',
      ].join('\n'),
      metadata: {
        isPostCompactActiveTask: true,
      },
    } as Message;
  }

  /**
   * 降级策略：简单截断
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
    error: unknown
  ): CompactionResult {
    const retainCount = Math.ceil(messages.length * this.FALLBACK_RETAIN_PERCENT);
    const candidateMessages = messages.slice(-retainCount);

    // 收集保留消息中所有 tool_call 的 ID
    const availableToolCallIds = new Set<string>();
    for (const msg of candidateMessages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          availableToolCallIds.add(tc.id);
        }
      }
    }

    // 过滤掉孤儿 tool 消息
    const retainedMessages = candidateMessages.filter((msg) => {
      if (msg.role === 'tool' && msg.tool_call_id) {
        return availableToolCallIds.has(msg.tool_call_id);
      }
      return true;
    });

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
        'The retained tail and active-task checkpoint are authoritative. ' +
        'Re-establish pending mutations, verification status, and the exact next ' +
        'action from retained evidence before claiming completion.',
      messages
    );
    const summaryMessage = this.createSummaryMessage(summaryMessageId, fallbackSummary);

    const compactedMessages = [summaryMessage, ...retainedMessages];
    const activeTaskMessage = this.buildActiveTaskMessage(options.activeTask);
    if (activeTaskMessage) {
      compactedMessages.push(activeTaskMessage);
    }
    const postTokens = TokenCounter.countTokens(compactedMessages, options.modelName);

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

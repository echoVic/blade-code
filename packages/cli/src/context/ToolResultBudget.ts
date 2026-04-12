/**
 * ToolResultBudget — 工具结果大小控制
 *
 * 当工具结果超过阈值时，将完整内容持久化到磁盘，
 * 只保留预览 + 文件路径引用。防止上下文膨胀。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { nanoid } from 'nanoid';

const DEFAULT_MAX_RESULT_CHARS = 100_000;
const PREVIEW_CHARS = 2000;
const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000;

/**
 * 消息级工具结果聚合预算
 *
 * 防止并行工具在同一轮中产生过多总输出。
 * 例如 5 个 Grep 各返回 50K，总计 250K 超出 200K 限制。
 */
export class MessageBudgetTracker {
  private currentChars = 0;

  /** 追踪已使用的字符数 */
  track(chars: number): void {
    this.currentChars += chars;
  }

  /** 返回剩余可用字符数 */
  remaining(): number {
    return Math.max(
      0,
      MAX_TOOL_RESULTS_PER_MESSAGE_CHARS - this.currentChars,
    );
  }

  /** 是否已超出预算 */
  isExhausted(): boolean {
    return (
      this.currentChars >= MAX_TOOL_RESULTS_PER_MESSAGE_CHARS
    );
  }

  /** 每轮开始时重置 */
  reset(): void {
    this.currentChars = 0;
  }
}

export interface BudgetOptions {
  /** 单个工具结果的最大字符数（默认 100K） */
  maxCharsPerResult?: number;
  /** 预览字符数（默认 2000） */
  previewChars?: number;
  /** 持久化目录（默认 ~/.blade/tool-results/） */
  outputDir?: string;
  /** 消息级聚合预算追踪器 */
  messageBudget?: MessageBudgetTracker;
}

/**
 * 检查并截断过大的工具结果内容
 *
 * @param content - 工具结果内容（string 或 object）
 * @param toolName - 工具名称（用于文件命名）
 * @param options - 配置选项
 * @returns 处理后的内容（可能被截断）
 */
export function applyToolResultBudget(
  content: string | object,
  toolName: string,
  options?: BudgetOptions,
): string | object {
  const maxChars =
    options?.maxCharsPerResult ?? DEFAULT_MAX_RESULT_CHARS;
  const previewChars = options?.previewChars ?? PREVIEW_CHARS;
  const messageBudget = options?.messageBudget;

  const contentStr =
    typeof content === 'string'
      ? content
      : JSON.stringify(content, null, 2);

  // --- per-tool 预算检查 ---
  if (contentStr.length <= maxChars) {
    // per-tool 预算内，检查消息级预算
    return applyMessageBudget(
      content,
      contentStr,
      toolName,
      previewChars,
      messageBudget,
      options,
    );
  }

  // 超出 per-tool 预算，持久化完整内容到磁盘
  const outputDir =
    options?.outputDir ??
    path.join(os.homedir(), '.blade', 'tool-results');

  const fileName = `${toolName}-${nanoid(8)}.txt`;
  const filePath = path.join(outputDir, fileName);

  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(filePath, contentStr, 'utf-8');
  } catch {
    const truncated =
      contentStr.slice(0, maxChars) +
      `\n\n... (truncated, ${contentStr.length} total chars)`;
    if (messageBudget) {
      messageBudget.track(truncated.length);
    }
    return truncated;
  }

  const preview = contentStr.slice(0, previewChars);
  const result =
    `Result too large (${contentStr.length} chars).` +
    ` Full output saved to: ${filePath}\n\n` +
    `Preview:\n${preview}\n\n` +
    `... (${contentStr.length - previewChars} more chars in file)`;

  if (messageBudget) {
    messageBudget.track(result.length);
  }
  return result;
}

/**
 * 消息级预算检查（内部辅助函数）
 *
 * 当内容在 per-tool 预算内时，进一步检查是否会超出
 * 消息级聚合预算，必要时截断并持久化到磁盘。
 */
function applyMessageBudget(
  original: string | object,
  contentStr: string,
  toolName: string,
  previewChars: number,
  messageBudget: MessageBudgetTracker | undefined,
  options: BudgetOptions | undefined,
): string | object {
  if (!messageBudget) {
    return original; // 无消息预算追踪，原样返回
  }

  const remaining = messageBudget.remaining();

  // 消息预算已耗尽
  if (remaining <= 0) {
    const truncated = contentStr.slice(0, previewChars);
    const result = persistAndSummarize(
      contentStr,
      truncated,
      toolName,
      options,
      '[Message budget exhausted. Full output saved to disk.]',
    );
    messageBudget.track(
      typeof result === 'string' ? result.length : previewChars,
    );
    return result;
  }

  // 内容会超出消息剩余预算
  if (contentStr.length > remaining) {
    const allowed = Math.max(previewChars, remaining);
    const truncated = contentStr.slice(0, allowed);
    const result = persistAndSummarize(
      contentStr,
      truncated,
      toolName,
      options,
      `... (truncated by message budget,` +
        ` ${contentStr.length} total chars)`,
    );
    messageBudget.track(
      typeof result === 'string' ? result.length : allowed,
    );
    return result;
  }

  // 在消息预算内
  messageBudget.track(contentStr.length);
  return original;
}

/**
 * 持久化完整内容到磁盘并返回截断结果（内部辅助函数）
 */
function persistAndSummarize(
  fullContent: string,
  truncated: string,
  toolName: string,
  options: BudgetOptions | undefined,
  suffix: string,
): string {
  const outputDir =
    options?.outputDir ??
    path.join(os.homedir(), '.blade', 'tool-results');
  const fileName = `${toolName}-${nanoid(8)}.txt`;
  const filePath = path.join(outputDir, fileName);

  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(filePath, fullContent, 'utf-8');
    return (
      `${truncated}\n\n${suffix}` +
      `\nFull output saved to: ${filePath}`
    );
  } catch {
    return `${truncated}\n\n${suffix}`;
  }
}

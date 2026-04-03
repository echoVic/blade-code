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

export interface BudgetOptions {
  /** 单个工具结果的最大字符数（默认 100K） */
  maxCharsPerResult?: number;
  /** 预览字符数（默认 2000） */
  previewChars?: number;
  /** 持久化目录（默认 ~/.blade/tool-results/） */
  outputDir?: string;
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
  options?: BudgetOptions
): string | object {
  const maxChars = options?.maxCharsPerResult ?? DEFAULT_MAX_RESULT_CHARS;
  const previewChars = options?.previewChars ?? PREVIEW_CHARS;

  const contentStr = typeof content === 'string'
    ? content
    : JSON.stringify(content, null, 2);

  if (contentStr.length <= maxChars) {
    return content; // Within budget, return as-is
  }

  // Persist full content to disk
  const outputDir = options?.outputDir ?? path.join(os.homedir(), '.blade', 'tool-results');

  const fileName = `${toolName}-${nanoid(8)}.txt`;
  const filePath = path.join(outputDir, fileName);

  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(filePath, contentStr, 'utf-8');
  } catch {
    return contentStr.slice(0, maxChars) + `\n\n... (truncated, ${contentStr.length} total chars)`;
  }

  const preview = contentStr.slice(0, previewChars);
  return (
    `Result too large (${contentStr.length} chars). Full output saved to: ${filePath}\n\n` +
    `Preview:\n${preview}\n\n... (${contentStr.length - previewChars} more chars in file)`
  );
}

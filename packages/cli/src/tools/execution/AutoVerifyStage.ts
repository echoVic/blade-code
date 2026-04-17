/**
 * AutoVerifyStage — 自动验证传感器
 *
 * 在 Edit/Write 工具执行后自动运行类型检查,
 * 将与修改文件相关的错误注入 LLM 上下文。
 *
 * Pipeline 位置: PostHook -> **AutoVerify** -> Formatting
 *
 * 优化 (Phase 3):
 * - 通过 VerifyQueue 做并发合并 + 短期缓存 + 增量 tsc + monorepo 感知
 * - 仍同步等待结果 (保持 Agent 下一步能看到错误),但连续 Edit 大幅提速
 */

import path from 'node:path';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { getCwd } from '../../utils/cwd.js';
import type { PipelineStage, ToolExecution } from '../types/index.js';
import { VerifyQueue, type VerifyResult } from './VerifyQueue.js';

const logger = createLogger(LogCategory.EXECUTION);

/** 触发自动验证的工具 */
const TRIGGER_TOOLS = new Set(['Edit', 'Write']);

/** 单次注入的最大错误行数 */
const MAX_ERROR_LINES = 15;

/**
 * 从类型检查输出中过滤与指定文件相关的错误
 */
function filterErrorsForFile(output: string, filePath: string): string[] {
  const lines = output.split('\n');
  const fileName = path.basename(filePath);
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);

  return lines.filter(
    (line) => line.includes(fileName) || line.includes(absPath)
  );
}

export class AutoVerifyStage implements PipelineStage {
  readonly name = 'auto-verify';

  constructor(private readonly queue: VerifyQueue = VerifyQueue.getInstance()) {}

  async process(execution: ToolExecution): Promise<void> {
    // 1. 仅对 Edit/Write 触发
    if (!TRIGGER_TOOLS.has(execution.toolName)) return;

    // 2. 仅对成功的执行触发
    const result = execution.getResult();
    if (!result || !result.success) return;

    // 3. 提取文件路径
    const filePath =
      (execution.params.file_path as string) ||
      (execution.params.path as string);
    if (!filePath) return;

    // 4. 跑类型检查 (通过 queue 合并 + 缓存)
    const searchRoot = execution.context.workspaceRoot || getCwd();
    let verify: VerifyResult | null;
    try {
      verify = await this.queue.verify(filePath, searchRoot);
    } catch (err) {
      logger.debug(
        `[AutoVerify] verify failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    if (!verify) return; // 无 tsconfig

    if (verify.timedOut) {
      logger.info(
        `[AutoVerify] type-check timed out in ${verify.workspaceRoot}`
      );
      return;
    }
    if (!verify.hasErrors || !verify.rawOutput.trim()) return;

    // 5. 过滤与修改文件相关的错误
    const relevantErrors = filterErrorsForFile(verify.rawOutput, filePath);
    if (relevantErrors.length === 0) return;

    // 6. 截断并注入
    const truncated = relevantErrors.slice(0, MAX_ERROR_LINES);
    const suffix =
      relevantErrors.length > MAX_ERROR_LINES
        ? `\n... (还有 ${relevantErrors.length - MAX_ERROR_LINES} 个错误)`
        : '';

    const context =
      `\n\n---\n**Auto-Verify: type-check errors in ${path.basename(filePath)}:**\n` +
      '```\n' +
      truncated.join('\n') +
      suffix +
      '\n```';

    const currentContent =
      typeof result.llmContent === 'string'
        ? result.llmContent
        : result.llmContent
          ? JSON.stringify(result.llmContent)
          : '';
    result.llmContent = `${currentContent}${context}`;

    logger.info(
      `[AutoVerify] injected ${relevantErrors.length} errors (${path.basename(filePath)})`
    );
  }
}

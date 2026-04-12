/**
 * AutoVerifyStage — 自动验证传感器
 *
 * 在 Edit/Write 工具执行后自动运行类型检查，
 * 将与修改文件相关的错误注入 LLM 上下文。
 *
 * Pipeline 位置: PostHook -> **AutoVerify** -> Formatting
 *
 * 这是 Harness Engineering "计算型传感器"模式的实现，
 * 提供即时反馈使 Agent 能自我修正错误。
 */

import { execSync } from 'child_process';
import path from 'path';
import { existsSync } from 'fs';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { getCwd } from '../../utils/cwd.js';
import type { PipelineStage, ToolExecution } from '../types/index.js';

const logger = createLogger(LogCategory.EXECUTION);

/** 触发自动验证的工具 */
const TRIGGER_TOOLS = new Set(['Edit', 'Write']);

/** 类型检查超时 (ms) */
const TYPE_CHECK_TIMEOUT = 10_000;

/** 单次注入的最大错误行数 */
const MAX_ERROR_LINES = 15;

/**
 * 检测项目的类型检查命令
 */
function detectTypeCheckCommand(workspaceRoot: string): string | null {
  // TypeScript
  if (existsSync(path.join(workspaceRoot, 'tsconfig.json'))) {
    // 优先使用 bun（如果 package.json 有 type-check 脚本）
    try {
      const pkgPath = path.join(workspaceRoot, 'package.json');
      if (existsSync(pkgPath)) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pkg = require(pkgPath);
        if (pkg.scripts?.['type-check']) {
          return 'bun run type-check';
        }
      }
    } catch {
      // ignore
    }
    return 'npx tsc --noEmit';
  }
  return null;
}

/**
 * 从类型检查输出中过滤与指定文件相关的错误
 */
function filterErrorsForFile(
  output: string,
  filePath: string,
): string[] {
  const lines = output.split('\n');
  const fileName = path.basename(filePath);
  const relPath = filePath.startsWith('/')
    ? filePath
    : path.resolve(filePath);

  return lines.filter((line) => {
    // TypeScript 错误格式: src/foo.ts(10,5): error TS2345: ...
    // 或: src/foo.ts:10:5 - error TS2345: ...
    return line.includes(fileName) || line.includes(relPath);
  });
}

/**
 * 自动验证 Pipeline Stage
 *
 * 在 Edit/Write 工具执行后自动运行类型检查，
 * 将相关错误追加到工具结果的 llmContent 中。
 */
export class AutoVerifyStage implements PipelineStage {
  readonly name = 'auto-verify';

  async process(execution: ToolExecution): Promise<void> {
    // 1. 仅对 Edit/Write 触发
    if (!TRIGGER_TOOLS.has(execution.toolName)) {
      return;
    }

    // 2. 仅对成功的执行触发
    const result = execution.getResult();
    if (!result || !result.success) {
      return;
    }

    // 3. 提取文件路径
    const filePath =
      (execution.params.file_path as string) ||
      (execution.params.path as string);
    if (!filePath) {
      return;
    }

    // 4. 检测类型检查命令
    const workspaceRoot = execution.context.workspaceRoot || getCwd();
    const typeCheckCmd = detectTypeCheckCommand(workspaceRoot);
    if (!typeCheckCmd) {
      return;
    }

    // 5. 运行类型检查（静默失败）
    try {
      execSync(typeCheckCmd, {
        cwd: workspaceRoot,
        timeout: TYPE_CHECK_TIMEOUT,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // 类型检查通过，无需注入
    } catch (error) {
      // execSync 在退出码非 0 时抛异常
      const execError = error as {
        stdout?: string;
        stderr?: string;
        status?: number;
      };
      const output = execError.stdout || execError.stderr || '';

      if (!output.trim()) {
        return;
      }

      // 6. 过滤与修改文件相关的错误
      const relevantErrors = filterErrorsForFile(output, filePath);
      if (relevantErrors.length === 0) {
        return;
      }

      // 7. 截断并注入
      const truncated = relevantErrors.slice(0, MAX_ERROR_LINES);
      const errorText = truncated.join('\n');
      const suffix =
        relevantErrors.length > MAX_ERROR_LINES
          ? `\n... (还有 ${relevantErrors.length - MAX_ERROR_LINES} 个错误)`
          : '';

      const context =
        `\n\n---\n**Auto-Verify: type-check errors in ${path.basename(filePath)}:**\n` +
        '```\n' +
        errorText +
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
        `[AutoVerify] 检测到 ${relevantErrors.length} 个类型错误 (${path.basename(filePath)})`,
      );
    }
  }
}

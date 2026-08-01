/**
 * AutoVerifyStage — 自动验证传感器
 *
 * 在 Edit/Write 工具执行后自动运行类型检查,
 * 将与修改文件相关的错误注入 LLM 上下文。
 *
 * Pipeline 位置: PostHook -> **AutoVerify** -> Formatting
 *
 * 验证层级:
 * 1. TypeScript 类型检查 (via VerifyQueue)
 * 2. Lint 快速检查 (biome check, 仅对修改文件)
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { getCwd } from '../../utils/cwd.js';
import type { PipelineStage, ToolExecution } from '../types/index.js';
import { VerifyQueue, type VerifyResult } from './VerifyQueue.js';

const execFileAsync = promisify(execFile);
const logger = createLogger(LogCategory.EXECUTION);

/** 触发自动验证的工具 */
const TRIGGER_TOOLS = new Set(['Edit', 'Write']);

/** 单次注入的最大错误行数 */
const MAX_ERROR_LINES = 15;

/** Lint 检查超时 */
const LINT_TIMEOUT_MS = 5000;

/** 单文件测试超时 */
const TEST_TIMEOUT_MS = 15000;

/** 测试输出最大行数 */
const MAX_TEST_OUTPUT_LINES = 10;

/**
 * 从类型检查输出中过滤与指定文件相关的错误
 */
function filterErrorsForFile(output: string, filePath: string): string[] {
  const lines = output.split('\n');
  const fileName = path.basename(filePath);
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);

  return lines.filter((line) => line.includes(fileName) || line.includes(absPath));
}

/**
 * 对单个文件运行 biome lint（快速，不需要全项目扫描）
 */
async function runLintCheck(filePath: string, cwd: string): Promise<string | null> {
  try {
    await execFileAsync('npx', ['biome', 'lint', '--max-diagnostics=5', filePath], {
      cwd,
      timeout: LINT_TIMEOUT_MS,
      encoding: 'utf-8',
    });
    return null;
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; killed?: boolean };
    if (execErr.killed) return null;
    const output = (execErr.stdout || '') + (execErr.stderr || '');
    if (output.includes('error')) return output.trim();
    return null;
  }
}

/**
 * Run a single test file and return failure output (if any)
 */
async function runTestFile(testPath: string, cwd: string): Promise<string | null> {
  try {
    await execFileAsync('npx', ['vitest', 'run', '--reporter=dot', testPath], {
      cwd,
      timeout: TEST_TIMEOUT_MS,
      encoding: 'utf-8',
    });
    return null;
  } catch (err: unknown) {
    const execErr = err as {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      code?: number;
    };
    if (execErr.killed) return null;
    if (execErr.code === 0) return null;
    const output = (execErr.stdout || '') + (execErr.stderr || '');
    if (!output.trim()) return null;
    const lines = output.split('\n');
    const failLines = lines.filter(
      (l) =>
        l.includes('FAIL') ||
        l.includes('Error') ||
        l.includes('✗') ||
        l.includes('expected')
    );
    if (failLines.length === 0) return null;
    return failLines.slice(0, MAX_TEST_OUTPUT_LINES).join('\n');
  }
}

/**
 * Find a related test file for the given source file.
 * Common patterns: foo.ts -> foo.test.ts, foo.spec.ts, __tests__/foo.test.ts
 */
function findRelatedTestFile(filePath: string): string | null {
  if (
    filePath.includes('.test.') ||
    filePath.includes('.spec.') ||
    filePath.includes('__tests__')
  ) {
    return null;
  }

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);

  const candidates = [
    path.join(dir, `${base}.test${ext}`),
    path.join(dir, `${base}.spec${ext}`),
    path.join(dir, '__tests__', `${base}.test${ext}`),
    path.join(dir, '..', 'tests', `${base}.test${ext}`),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export class AutoVerifyStage implements PipelineStage {
  readonly name = 'auto-verify';

  constructor(private readonly queue: VerifyQueue = VerifyQueue.getInstance()) {}

  async process(execution: ToolExecution): Promise<void> {
    if (!TRIGGER_TOOLS.has(execution.toolName)) return;

    const result = execution.getResult();
    if (!result || !result.success) return;

    const filePath =
      (execution.params.file_path as string) || (execution.params.path as string);
    if (!filePath) return;

    const searchRoot = execution.context.workspaceRoot || getCwd();
    const diagnostics: string[] = [];

    // 1. Type check (via VerifyQueue)
    try {
      const verify: VerifyResult | null = await this.queue.verify(filePath, searchRoot);
      if (verify && !verify.timedOut && verify.hasErrors) {
        const relevantErrors = filterErrorsForFile(verify.rawOutput, filePath);
        if (relevantErrors.length > 0) {
          const truncated = relevantErrors.slice(0, MAX_ERROR_LINES);
          diagnostics.push(
            `Type errors:\n${truncated.join('\n')}` +
              (relevantErrors.length > MAX_ERROR_LINES
                ? `\n... (+${relevantErrors.length - MAX_ERROR_LINES} more)`
                : '')
          );
        }
      }
    } catch (err) {
      logger.debug(
        `[AutoVerify] type-check failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // 2. Lint check (biome, single file)
    if (
      filePath.endsWith('.ts') ||
      filePath.endsWith('.tsx') ||
      filePath.endsWith('.js')
    ) {
      const lintOutput = await runLintCheck(filePath, searchRoot);
      if (lintOutput) {
        const lines = lintOutput.split('\n').slice(0, 5);
        diagnostics.push(`Lint errors:\n${lines.join('\n')}`);
      }
    }

    // 3. Test execution — run related test or self if editing a test file
    const isTestFile = filePath.includes('.test.') || filePath.includes('.spec.');
    const testFileToRun = isTestFile ? filePath : findRelatedTestFile(filePath);

    if (testFileToRun) {
      const testOutput = await runTestFile(testFileToRun, searchRoot);
      if (testOutput) {
        diagnostics.push(
          `Test failures (${path.basename(testFileToRun)}):\n${testOutput}`
        );
      } else if (!isTestFile && testFileToRun) {
        diagnostics.push(`Related test: ${testFileToRun}`);
      }
    }

    if (diagnostics.length === 0) return;

    const context =
      `\n\n---\n**Auto-Verify: issues in ${path.basename(filePath)}:**\n` +
      '```\n' +
      diagnostics.join('\n\n') +
      '\n```';

    const currentContent =
      typeof result.llmContent === 'string'
        ? result.llmContent
        : result.llmContent
          ? JSON.stringify(result.llmContent)
          : '';
    result.llmContent = `${currentContent}${context}`;

    logger.info(
      `[AutoVerify] injected ${diagnostics.length} diagnostic(s) (${path.basename(filePath)})`
    );
  }
}

import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { join, relative } from 'path';
import picomatch from 'picomatch';
import { z } from 'zod';
import { getCwd } from '../../../utils/cwd.js';
import { DEFAULT_EXCLUDE_DIRS } from '../../../utils/filePatterns.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, GrepMetadata, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';

/**
 * 搜索策略枚举
 */
enum SearchStrategy {
  RIPGREP = 'ripgrep',
  GIT_GREP = 'git-grep',
  SYSTEM_GREP = 'system-grep',
  FALLBACK = 'fallback',
}

/**
 * 搜索结果条目
 */
interface GrepMatch {
  file_path: string;
  line_number?: number;
  content?: string;
  context_before?: string[];
  context_after?: string[];
  count?: number;
}

/**
 * 获取平台特定的 ripgrep 路径
 */
function getPlatformRipgrepPath(): string | null {
  const platform = process.platform;
  const arch = process.arch;

  const platformMap: Record<string, string> = {
    'darwin-arm64': 'darwin-arm64/rg',
    'darwin-x64': 'darwin-x64/rg',
    'linux-arm64': 'linux-arm64/rg',
    'linux-x64': 'linux-x64/rg',
    'win32-x64': 'win32-x64/rg.exe',
  };

  const key = `${platform}-${arch}`;
  const relativePath = platformMap[key];

  if (!relativePath) {
    return null;
  }

  // 尝试从模块安装目录查找（用于 npm 包）
  try {
    const moduleDir = new URL(
      '../../../../vendor/ripgrep/' + relativePath,
      import.meta.url
    ).pathname;
    if (existsSync(moduleDir)) {
      return moduleDir;
    }
  } catch {
    // 忽略错误
  }

  return null;
}

/**
 * 获取 ripgrep 可执行文件路径
 * 优先级:
 * 1. 系统安装的 rg（优先使用，可能是最新版本）
 * 2. 项目内置的 vendor/ripgrep 中的二进制文件（性能最优）
 * 3. @vscode/ripgrep 包提供的 rg（可选依赖，作为备选）
 */
function getRipgrepPath(): string | null {
  // 策略 1: 尝试使用系统安装的 ripgrep
  try {
    const cmd =
      process.platform === 'win32'
        ? 'where rg'
        : 'command -v rg 2>/dev/null || which rg 2>/dev/null';
    const out = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)[0]
      .trim();
    if (out) {
      return out;
    }
  } catch {
    // 系统 rg 不可用，继续尝试其他策略
  }

  // 策略 2: 尝试使用内置的 vendor ripgrep
  const vendorRg = getPlatformRipgrepPath();
  if (vendorRg && existsSync(vendorRg)) {
    return vendorRg;
  }

  // 策略 3: 尝试使用 @vscode/ripgrep（可选依赖）
  // 注意：这里使用同步的 require 是安全的，因为它是可选依赖
  // 如果不存在，catch 块会捕获错误
  try {
    // @ts-ignore - 可选依赖可能不存在
    const vsRipgrep = require('@vscode/ripgrep');
    if (vsRipgrep?.rgPath && existsSync(vsRipgrep.rgPath)) {
      return vsRipgrep.rgPath;
    }
  } catch {
    // @vscode/ripgrep 不可用，继续尝试其他策略
  }

  return null;
}

/**
 * 检查是否在 git 仓库中
 */
async function isGitRepository(path: string): Promise<boolean> {
  try {
    execSync('git rev-parse --git-dir', {
      cwd: path,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查系统 grep 是否可用
 */
function isSystemGrepAvailable(): boolean {
  try {
    execSync('grep --version', {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 执行 ripgrep 搜索
 */
async function executeRipgrep(
  args: string[],
  outputMode: string,
  signal: AbortSignal,
  updateOutput?: (output: string) => void
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const rgPath = getRipgrepPath();
  if (!rgPath) {
    throw new Error('ripgrep not available');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(rgPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code || 0,
      });
    });

    child.on('error', (error) => {
      reject(error);
    });

    // 处理中止信号
    const abortHandler = () => {
      child.kill('SIGTERM');
      reject(new Error('搜索被用户中止'));
    };

    signal.addEventListener('abort', abortHandler);

    child.on('close', () => {
      signal.removeEventListener('abort', abortHandler);
    });
  });
}

/**
 * 执行 git grep 搜索（降级策略 1）
 */
async function executeGitGrep(
  pattern: string,
  path: string,
  options: {
    caseInsensitive?: boolean;
    glob?: string;
    contextLines?: number;
  },
  signal: AbortSignal
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = ['grep', '-n']; // -n 显示行号

  if (options.caseInsensitive) {
    args.push('-i');
  }

  if (options.contextLines !== undefined) {
    args.push(`-C${options.contextLines}`);
  }

  args.push('-e', pattern);

  // git grep 不直接支持 glob，但可以使用 -- 限制路径
  if (options.glob) {
    args.push('--', options.glob);
  }

  return new Promise((resolve, reject) => {
    const process = spawn('git', args, {
      cwd: path,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    process.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    process.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code || 0,
      });
    });

    process.on('error', (error) => {
      reject(error);
    });

    const abortHandler = () => {
      process.kill('SIGTERM');
      reject(new Error('搜索被用户中止'));
    };

    signal.addEventListener('abort', abortHandler);

    process.on('close', () => {
      signal.removeEventListener('abort', abortHandler);
    });
  });
}

/**
 * 执行系统 grep 搜索（降级策略 2）
 */
async function executeSystemGrep(
  pattern: string,
  path: string,
  options: {
    caseInsensitive?: boolean;
    contextLines?: number;
  },
  signal: AbortSignal
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = ['-rn']; // -r 递归, -n 显示行号

  if (options.caseInsensitive) {
    args.push('-i');
  }

  if (options.contextLines !== undefined) {
    args.push(`-C${options.contextLines}`);
  }

  // 排除常见目录
  for (const dir of DEFAULT_EXCLUDE_DIRS) {
    args.push('--exclude-dir=' + dir.replace(/^\./, ''));
  }

  args.push('-e', pattern, path);

  return new Promise((resolve, reject) => {
    const process = spawn('grep', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    process.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    process.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code || 0,
      });
    });

    process.on('error', (error) => {
      reject(error);
    });

    const abortHandler = () => {
      process.kill('SIGTERM');
      reject(new Error('搜索被用户中止'));
    };

    signal.addEventListener('abort', abortHandler);

    process.on('close', () => {
      signal.removeEventListener('abort', abortHandler);
    });
  });
}

/**
 * 纯 JavaScript 实现的搜索（最终降级方案）
 */
async function executeFallbackGrep(
  pattern: string,
  path: string,
  options: {
    caseInsensitive?: boolean;
    glob?: string;
    multiline?: boolean;
  },
  signal: AbortSignal
): Promise<{ matches: GrepMatch[]; totalFiles: number }> {
  const matches: GrepMatch[] = [];
  const regex = new RegExp(pattern, options.caseInsensitive ? 'gi' : 'g');

  // 获取所有文件
  const files = await getAllFiles(path, signal);
  let processedFiles = 0;

  for (const file of files) {
    signal.throwIfAborted();

    // 检查是否应该排除此文件
    if (shouldExcludeFile(file)) {
      continue;
    }

    // 如果指定了 glob，检查是否匹配
    if (options.glob && !matchGlob(file, options.glob)) {
      continue;
    }

    try {
      const content = await readFile(file, 'utf-8');
      const lines = content.split('\n');

      lines.forEach((line, index) => {
        if (regex.test(line)) {
          matches.push({
            file_path: relative(path, file),
            line_number: index + 1,
            content: line,
          });
        }
      });

      processedFiles++;
    } catch (_error) {
      // 忽略无法读取的文件
      continue;
    }
  }

  return { matches, totalFiles: processedFiles };
}

/**
 * 递归获取所有文件
 */
async function getAllFiles(dir: string, signal: AbortSignal): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentPath: string) {
    signal.throwIfAborted();

    try {
      const entries = await readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        signal.throwIfAborted();

        const fullPath = join(currentPath, entry.name);

        if (entry.isDirectory()) {
          // 检查是否应该排除此目录
          if (!shouldExcludeFile(fullPath)) {
            await walk(fullPath);
          }
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    } catch (_error) {
      // 忽略无法访问的目录
    }
  }

  await walk(dir);
  return files;
}

/**
 * 检查文件/目录是否应该被排除
 */
function shouldExcludeFile(path: string): boolean {
  for (const pattern of DEFAULT_EXCLUDE_DIRS) {
    if (path.includes(pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * 使用 picomatch 进行 glob 匹配
 */
function matchGlob(filePath: string, pattern: string): boolean {
  const isMatch = picomatch(pattern);
  return isMatch(filePath);
}

/**
 * 构建 ripgrep 命令参数
 */
function buildRipgrepArgs(options: {
  pattern: string;
  path: string;
  glob?: string;
  type?: string;
  output_mode: string;
  case_insensitive: boolean;
  line_numbers: boolean;
  context_before?: number;
  context_after?: number;
  context?: number;
  head_limit?: number;
  offset?: number;
  multiline: boolean;
}): string[] {
  const args: string[] = [];

  // 基本选项
  if (options.case_insensitive) {
    args.push('-i');
  }

  if (options.multiline) {
    args.push('-U', '--multiline-dotall');
  }

  // 输出模式
  switch (options.output_mode) {
    case 'files_with_matches':
      args.push('-l');
      break;
    case 'count':
      args.push('-c');
      break;
    case 'content':
      if (options.line_numbers) {
        args.push('-n');
      }
      break;
  }

  // 上下文行
  if (options.context !== undefined && options.output_mode === 'content') {
    args.push('-C', options.context.toString());
  } else {
    if (options.context_before !== undefined && options.output_mode === 'content') {
      args.push('-B', options.context_before.toString());
    }
    if (options.context_after !== undefined && options.output_mode === 'content') {
      args.push('-A', options.context_after.toString());
    }
  }

  // 文件类型过滤
  if (options.type) {
    args.push('--type', options.type);
  }

  // 默认排除常见目录
  for (const dir of DEFAULT_EXCLUDE_DIRS) {
    args.push('--glob', `!${dir}/**`);
  }

  // 用户自定义 Glob 模式
  if (options.glob) {
    args.push('--glob', options.glob);
  }

  // 结果限制
  if (options.head_limit !== undefined) {
    const totalLimit = (options.offset ?? 0) + options.head_limit;
    args.push('-m', totalLimit.toString());
  }

  // 搜索模式
  args.push(options.pattern);

  // 搜索路径
  args.push(options.path);

  return args;
}

/**
 * 解析 ripgrep/git grep/system grep 输出
 */
function parseGrepOutput(output: string, outputMode: string): GrepMatch[] {
  if (!output.trim()) {
    return [];
  }

  const lines = output.trim().split('\n');
  const matches: GrepMatch[] = [];

  switch (outputMode) {
    case 'files_with_matches':
      return lines.map((line) => ({
        file_path: line.trim(),
      }));

    case 'count':
      return lines.map((line) => {
        const [filePath, count] = line.split(':');
        return {
          file_path: filePath,
          count: parseInt(count, 10),
        };
      });

    case 'content':
      for (const line of lines) {
        const match = parseContentLine(line);
        if (match) {
          matches.push(match);
        }
      }
      return matches;

    default:
      return [];
  }
}

/**
 * 解析内容行
 */
function parseContentLine(line: string): GrepMatch | null {
  // 匹配格式: filename:line_number:content 或 filename:content
  const colonIndex = line.indexOf(':');
  if (colonIndex === -1) return null;

  const filePath = line.substring(0, colonIndex);
  const remainder = line.substring(colonIndex + 1);

  // 检查是否有行号
  const secondColonIndex = remainder.indexOf(':');
  if (
    secondColonIndex !== -1 &&
    /^\d+$/.test(remainder.substring(0, secondColonIndex))
  ) {
    // 有行号的格式
    const lineNumber = parseInt(remainder.substring(0, secondColonIndex), 10);
    const content = remainder.substring(secondColonIndex + 1);

    return {
      file_path: filePath,
      line_number: lineNumber,
      content: content,
    };
  } else {
    // 无行号的格式
    return {
      file_path: filePath,
      content: remainder,
    };
  }
}

/**
 * GrepTool - 内容搜索工具
 * 支持多级降级策略：ripgrep -> git grep -> system grep -> JavaScript fallback
 */
export const grepTool = createTool({
  name: 'Grep',
  displayName: '内容搜索',
  kind: ToolKind.ReadOnly,
  isConcurrencySafe: true, // 纯读操作，无副作用

  // Zod Schema 定义
  schema: z.object({
    pattern: ToolSchemas.pattern({
      description: 'The regular expression pattern to search for in file contents',
    }),
    path: z
      .string()
      .optional()
      .describe(
        'File or directory to search in (rg PATH). Defaults to current working directory'
      ),
    glob: z
      .string()
      .optional()
      .describe(
        'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob'
      ),
    type: z
      .string()
      .optional()
      .describe(
        'File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types'
      ),
    output_mode: z
      .enum(['content', 'files_with_matches', 'count'])
      .default('files_with_matches')
      .describe(
        'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches"'
      ),
    '-i': z.boolean().optional().describe('Case insensitive search (rg -i)'),
    '-n': z
      .boolean()
      .default(true)
      .describe(
        'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true'
      ),
    '-B': ToolSchemas.nonNegativeInt()
      .optional()
      .describe(
        'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise'
      ),
    '-A': ToolSchemas.nonNegativeInt()
      .optional()
      .describe(
        'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise'
      ),
    '-C': ToolSchemas.nonNegativeInt()
      .optional()
      .describe(
        'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise'
      ),
    head_limit: ToolSchemas.positiveInt()
      .optional()
      .describe(
        'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults based on "cap" experiment value: 0 (unlimited), 20, or 100'
      ),
    offset: ToolSchemas.nonNegativeInt()
      .optional()
      .describe(
        'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0'
      ),
    multiline: z
      .boolean()
      .default(false)
      .describe(
        'Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false'
      ),
  }),

  // 工具描述（对齐 Claude Code 官方）
  description: {
    short: 'A powerful search tool built on ripgrep',
    long: `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use Grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command. The Grep tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Use Task tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\`
`,
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const {
      pattern,
      path = getCwd(),
      glob,
      type,
      output_mode,
      '-i': caseInsensitive,
      '-n': lineNumbers = true,
      '-B': contextBefore,
      '-A': contextAfter,
      '-C': contextLines,
      head_limit,
      offset,
      multiline,
    } = params;
    const { updateOutput } = context;
    const signal = context.signal ?? new AbortController().signal;

    try {
      updateOutput?.(`使用智能搜索策略查找模式 "${pattern}"...`);

      let result: { stdout: string; stderr: string; exitCode: number } | null = null;
      let strategy: SearchStrategy = SearchStrategy.RIPGREP;
      let matches: GrepMatch[] = [];

      // 策略 1: 尝试使用 ripgrep
      const rgPath = getRipgrepPath();
      if (rgPath) {
        try {
          updateOutput?.(`使用 ripgrep (${rgPath})`);

          const args = buildRipgrepArgs({
            pattern,
            path,
            glob,
            type,
            output_mode,
            case_insensitive: caseInsensitive ?? false,
            line_numbers: lineNumbers,
            context_before: contextBefore,
            context_after: contextAfter,
            context: contextLines,
            head_limit,
            offset,
            multiline: multiline ?? false,
          });

          result = await executeRipgrep(args, output_mode, signal, updateOutput);
          strategy = SearchStrategy.RIPGREP;
        } catch {
          updateOutput?.(`[WARN] ripgrep 失败，尝试降级策略...`);
          result = null;
        }
      }

      // 策略 2: 降级到 git grep (如果在 git 仓库中)
      if (!result && (await isGitRepository(path))) {
        try {
          updateOutput?.(`使用 git grep`);

          result = await executeGitGrep(
            pattern,
            path,
            {
              caseInsensitive: caseInsensitive ?? false,
              glob,
              contextLines,
            },
            signal
          );
          strategy = SearchStrategy.GIT_GREP;
        } catch {
          updateOutput?.(`[WARN] git grep 失败，继续尝试其他策略...`);
          result = null;
        }
      }

      // 策略 3: 降级到系统 grep
      if (!result && isSystemGrepAvailable()) {
        try {
          updateOutput?.(`使用系统 grep`);

          result = await executeSystemGrep(
            pattern,
            path,
            {
              caseInsensitive: caseInsensitive ?? false,
              contextLines,
            },
            signal
          );
          strategy = SearchStrategy.SYSTEM_GREP;
        } catch {
          updateOutput?.(`[WARN] 系统 grep 失败，使用纯 JavaScript 实现...`);
          result = null;
        }
      }

      // 策略 4: 最终降级到纯 JavaScript 实现
      if (!result) {
        updateOutput?.(`使用纯 JavaScript 搜索实现`);

        const fallbackResult = await executeFallbackGrep(
          pattern,
          path,
          {
            caseInsensitive: caseInsensitive ?? false,
            glob,
            multiline: multiline ?? false,
          },
          signal
        );

        matches = fallbackResult.matches;
        strategy = SearchStrategy.FALLBACK;

        // 为了统一处理，创建一个假的 result 对象
        result = {
          stdout: '', // 不使用
          stderr: '',
          exitCode: 0,
        };
      } else {
        // 解析 grep 输出
        matches = parseGrepOutput(result.stdout, output_mode);
      }

      // 应用 offset 裁剪（如果指定）
      const originalTotal = matches.length;
      if (offset !== undefined && offset > 0) {
        matches = matches.slice(offset);
      }

      // 应用 head_limit 裁剪（如果指定）
      if (head_limit !== undefined && matches.length > head_limit) {
        matches = matches.slice(0, head_limit);
      }

      const metadata: GrepMetadata = {
        search_pattern: pattern,
        search_path: path,
        output_mode,
        case_insensitive: caseInsensitive ?? false,
        total_matches: matches.length,
        original_total: originalTotal,
        offset: offset,
        head_limit: head_limit,
        strategy,
        exit_code: result?.exitCode,
      };

      if (result && result.exitCode !== 0 && result.stderr) {
        return {
          success: false,
          llmContent: `Search execution failed: ${result.stderr}`,
          metadata: {
            ...metadata,
            summary: `搜索失败: ${result.stderr}`,
          },
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: result.stderr,
          },
        };
      }

      return {
        success: true,
        llmContent: matches,
        metadata: {
          ...metadata,
          summary:
            matches.length > 0
              ? `搜索 "${pattern}" 找到 ${matches.length} 个文件`
              : `搜索 "${pattern}" 未找到匹配`,
        },
      };
    } catch (error) {
      const err = error as Error;
      if (err.name === 'AbortError') {
        return {
          success: false,
          llmContent: 'Search aborted',
          metadata: {
            summary: `搜索失败: 操作被中止`,
          },
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
        };
      }

      return {
        success: false,
        llmContent: `Search failed: ${err.message}`,
        metadata: {
          summary: `搜索失败: ${err.message}`,
        },
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: err.message,
          details: err,
        },
      };
    }
  },

  version: '3.0.0',
  category: '搜索工具',
  tags: ['search', 'grep', 'ripgrep', 'regex', 'text', 'fallback'],

  /**
   * 提取签名内容：返回搜索模式
   */
  extractSignatureContent: (params) => params.pattern,

  /**
   * 抽象权限规则：返回通配符模式
   */
  abstractPermissionRule: () => '*',
});

import { spawn } from 'child_process';
import { z } from 'zod';
import { DEFAULT_EXCLUDE_DIRS } from '../../../utils/filePatterns.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';

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
 * GrepTool - 内容搜索工具
 * 使用新的 Zod 验证设计
 */
export const grepTool = createTool({
  name: 'Grep',
  displayName: '内容搜索',
  kind: ToolKind.Search,

  // Zod Schema 定义
  schema: z.object({
    pattern: ToolSchemas.pattern({
      description: 'Regex pattern to search for',
    }),
    path: z
      .string()
      .optional()
      .describe('Search path (optional, defaults to current working directory)'),
    glob: ToolSchemas.glob().optional(),
    type: z
      .string()
      .optional()
      .describe('File type filter (e.g., js, py, rust, go, java)'),
    output_mode: z
      .enum(['content', 'files_with_matches', 'count'])
      .default('files_with_matches')
      .describe(
        'Output mode: content shows matching lines; files_with_matches shows file paths; count shows match counts'
      ),
    case_insensitive: z.boolean().default(false).describe('Case insensitive (-i)'),
    line_numbers: z
      .boolean()
      .default(false)
      .describe('Show line numbers (content mode only)'),
    context_before: ToolSchemas.nonNegativeInt()
      .optional()
      .describe('Number of lines to show before each match (content mode, -B)'),
    context_after: ToolSchemas.nonNegativeInt()
      .optional()
      .describe('Number of lines to show after each match (content mode, -A)'),
    context: ToolSchemas.nonNegativeInt()
      .optional()
      .describe(
        'Number of context lines before and after each match (content mode, -C)'
      ),
    head_limit: ToolSchemas.positiveInt()
      .optional()
      .describe('Limit the maximum number of output lines/files/count entries'),
    multiline: z
      .boolean()
      .default(false)
      .describe('Enable multiline mode where . matches newlines (-U)'),
  }),

  // 工具描述
  description: {
    short:
      'Ripgrep-based powerful text search tool supporting regex and multiple output formats',
    long: `Perform fast text search using ripgrep (rg). Supports regex, file-type filters, context display, and other advanced features.`,
    usageNotes: [
      'ALWAYS use the Grep tool for content search; NEVER invoke grep or rg as a Bash command',
      'pattern uses ripgrep syntax (not standard grep)',
      'Supports three output modes: content (matching lines), files_with_matches (file paths), count (match counts)',
      'Default output mode is files_with_matches',
      'content mode supports -A/-B/-C to show context lines',
      'content mode supports -n to show line numbers',
      'Automatically excludes .git, node_modules, dist, etc.',
      'head_limit can cap the number of results',
      'multiline enables cross-line matching',
    ],
    examples: [
      {
        description: 'Search files containing specific text',
        params: {
          pattern: 'TODO',
          output_mode: 'files_with_matches',
        },
      },
      {
        description: 'Search and display matching lines (with line numbers)',
        params: {
          pattern: 'function\\s+\\w+',
          output_mode: 'content',
          line_numbers: true,
        },
      },
      {
        description: 'Search and display context',
        params: {
          pattern: 'error',
          output_mode: 'content',
          context: 3,
        },
      },
      {
        description: 'Search only TypeScript files',
        params: {
          pattern: 'interface',
          type: 'ts',
        },
      },
      {
        description: 'Filter files using glob',
        params: {
          pattern: 'import',
          glob: '*.{ts,tsx}',
        },
      },
    ],
    important: [
      'pattern uses ripgrep syntax; literal braces must be escaped (e.g., interface\\{\\})',
      'multiline mode impacts performance; use only when cross-line matching is needed',
      'head_limit applies to all output modes',
      'If ripgrep is not installed, the tool will return an error',
    ],
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const {
      pattern,
      path = process.cwd(),
      glob,
      type,
      output_mode,
      case_insensitive,
      line_numbers,
      context_before,
      context_after,
      context: contextLines,
      head_limit,
      multiline,
    } = params;
    const { updateOutput } = context;
    const signal = context.signal ?? new AbortController().signal;

    try {
      updateOutput?.(`使用 ripgrep 搜索模式 "${pattern}"...`);

      // 构建 ripgrep 命令参数
      const args = buildRipgrepArgs({
        pattern,
        path,
        glob,
        type,
        output_mode,
        case_insensitive,
        line_numbers,
        context_before,
        context_after,
        context: contextLines,
        head_limit,
        multiline,
      });

      signal.throwIfAborted();

      // 执行 ripgrep 搜索
      const result = await executeRipgrep(args, signal, updateOutput);

      const matches = parseRipgrepOutput(result.stdout, output_mode);

      const metadata: Record<string, any> = {
        search_pattern: pattern,
        search_path: path,
        output_mode,
        case_insensitive,
        total_matches: matches.length,
        command_executed: `rg ${args.join(' ')}`,
        exit_code: result.exitCode,
        stderr: result.stderr,
      };

      if (result.exitCode !== 0 && result.stderr) {
        return {
          success: false,
          llmContent: `ripgrep execution failed: ${result.stderr}`,
          displayContent: `❌ ripgrep 执行失败: ${result.stderr}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: result.stderr,
          },
        };
      }

      const displayMessage = formatDisplayMessage(metadata);

      return {
        success: true,
        llmContent: matches,
        displayContent: displayMessage,
        metadata,
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          llmContent: 'Search aborted',
          displayContent: '⚠️ 搜索被用户中止',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
        };
      }

      return {
        success: false,
        llmContent: `Search failed: ${error.message}`,
        displayContent: `❌ 搜索失败: ${error.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error.message,
          details: error,
        },
      };
    }
  },

  version: '2.0.0',
  category: '搜索工具',
  tags: ['search', 'grep', 'ripgrep', 'regex', 'text'],

  /**
   * 提取签名内容：返回搜索模式
   */
  extractSignatureContent: (params) => params.pattern,

  /**
   * 抽象权限规则：返回通配符模式
   */
  abstractPermissionRule: () => '*',
});

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
    args.push('-m', options.head_limit.toString());
  }

  // 搜索模式
  args.push(options.pattern);

  // 搜索路径
  args.push(options.path);

  return args;
}

/**
 * 执行 ripgrep 搜索
 */
async function executeRipgrep(
  args: string[],
  signal: AbortSignal,
  updateOutput?: (output: string) => void
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const process = spawn('rg', args, {
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
      if (error.message.includes('ENOENT')) {
        reject(
          new Error(
            'ripgrep (rg) 未安装或不在 PATH 中。请安装 ripgrep: https://github.com/BurntSushi/ripgrep'
          )
        );
      } else {
        reject(error);
      }
    });

    // 处理中止信号
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
 * 解析 ripgrep 输出
 */
function parseRipgrepOutput(output: string, outputMode: string): GrepMatch[] {
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
 * 格式化显示消息
 */
function formatDisplayMessage(metadata: Record<string, any>): string {
  const { search_pattern, search_path, output_mode, total_matches } = metadata;

  let message = `✅ 在 ${search_path} 中搜索 "${search_pattern}"`;

  switch (output_mode) {
    case 'files_with_matches':
      message += `\n📁 找到 ${total_matches} 个包含匹配内容的文件`;
      break;
    case 'count':
      message += `\n🔢 统计了 ${total_matches} 个文件的匹配数量`;
      break;
    case 'content':
      message += `\n📝 找到 ${total_matches} 个匹配行`;
      break;
  }

  return message;
}

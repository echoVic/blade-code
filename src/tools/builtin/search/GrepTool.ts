import { spawn } from 'child_process';
import { DeclarativeTool } from '../../base/DeclarativeTool.js';
import { BaseToolInvocation } from '../../base/ToolInvocation.js';
import type {
  ConfirmationDetails,
  JSONSchema7,
  ToolInvocation,
  ToolResult,
} from '../../types/index.js';
import { ToolKind } from '../../types/index.js';

/**
 * Grep搜索参数接口
 */
interface GrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: 'content' | 'files_with_matches' | 'count';
  case_insensitive?: boolean;
  line_numbers?: boolean;
  context_before?: number;
  context_after?: number;
  context?: number;
  head_limit?: number;
  multiline?: boolean;
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
 * Grep工具调用实现
 */
class GrepToolInvocation extends BaseToolInvocation<GrepParams> {
  constructor(params: GrepParams) {
    super('grep', params);
  }

  getDescription(): string {
    const { pattern, path, output_mode } = this.params;
    const searchPath = path || '当前目录';
    const mode =
      output_mode === 'files_with_matches'
        ? '文件列表'
        : output_mode === 'count'
          ? '匹配计数'
          : '内容搜索';
    return `在 ${searchPath} 中搜索 "${pattern}" (${mode})`;
  }

  getAffectedPaths(): string[] {
    return [this.params.path || process.cwd()];
  }

  async shouldConfirm(): Promise<ConfirmationDetails | null> {
    // 内容搜索操作通常不需要确认
    return null;
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    try {
      this.validateParams();
      this.checkAbortSignal(signal);

      const {
        pattern,
        path = process.cwd(),
        glob,
        type,
        output_mode = 'files_with_matches',
        case_insensitive = false,
        line_numbers = false,
        context_before,
        context_after,
        context,
        head_limit,
        multiline = false,
      } = this.params;

      updateOutput?.(`使用ripgrep搜索模式 "${pattern}"...`);

      // 构建ripgrep命令参数
      const args = this.buildRipgrepArgs({
        pattern,
        path,
        glob,
        type,
        output_mode,
        case_insensitive,
        line_numbers,
        context_before,
        context_after,
        context,
        head_limit,
        multiline,
      });

      this.checkAbortSignal(signal);

      // 执行ripgrep搜索
      const result = await this.executeRipgrep(args, signal, updateOutput);

      const matches = this.parseRipgrepOutput(result.stdout, output_mode);

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
        return this.createErrorResult(`ripgrep执行失败: ${result.stderr}`);
      }

      const displayMessage = this.formatDisplayMessage(metadata);

      return this.createSuccessResult(matches, displayMessage, metadata);
    } catch (error: any) {
      return this.createErrorResult(error);
    }
  }

  private buildRipgrepArgs(options: {
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
        args.push('-l'); // 只显示文件名
        break;
      case 'count':
        args.push('-c'); // 显示匹配计数
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

    // Glob模式
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

  private async executeRipgrep(
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
              'ripgrep (rg) 未安装或不在PATH中。请安装ripgrep: https://github.com/BurntSushi/ripgrep'
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

  private parseRipgrepOutput(output: string, outputMode: string): GrepMatch[] {
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
          const match = this.parseContentLine(line);
          if (match) {
            matches.push(match);
          }
        }
        return matches;

      default:
        return [];
    }
  }

  private parseContentLine(line: string): GrepMatch | null {
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

  private formatDisplayMessage(metadata: Record<string, any>): string {
    const { search_pattern, search_path, output_mode, total_matches } = metadata;

    let message = `在 ${search_path} 中搜索 "${search_pattern}"`;

    switch (output_mode) {
      case 'files_with_matches':
        message += `\n找到 ${total_matches} 个包含匹配内容的文件`;
        break;
      case 'count':
        message += `\n统计了 ${total_matches} 个文件的匹配数量`;
        break;
      case 'content':
        message += `\n找到 ${total_matches} 个匹配行`;
        break;
    }

    return message;
  }
}

/**
 * Grep内容搜索工具
 * 基于ripgrep的强大内容搜索工具
 */
export class GrepTool extends DeclarativeTool<GrepParams> {
  constructor() {
    const schema: JSONSchema7 = {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '要搜索的正则表达式模式',
        },
        path: {
          type: 'string',
          description: '搜索路径（可选，默认当前工作目录）',
        },
        glob: {
          type: 'string',
          description: 'Glob模式过滤文件（如 "*.js", "*.{ts,tsx}"）',
        },
        type: {
          type: 'string',
          description: '文件类型过滤（如 js, py, rust, go, java等）',
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          default: 'files_with_matches',
          description:
            '输出模式：content显示匹配行，files_with_matches显示文件路径，count显示匹配计数',
        },
        case_insensitive: {
          type: 'boolean',
          default: false,
          description: '忽略大小写',
        },
        line_numbers: {
          type: 'boolean',
          default: false,
          description: '显示行号（仅content模式有效）',
        },
        context_before: {
          type: 'integer',
          minimum: 0,
          description: '显示匹配行之前的行数（仅content模式有效）',
        },
        context_after: {
          type: 'integer',
          minimum: 0,
          description: '显示匹配行之后的行数（仅content模式有效）',
        },
        context: {
          type: 'integer',
          minimum: 0,
          description: '显示匹配行前后的行数（仅content模式有效）',
        },
        head_limit: {
          type: 'integer',
          minimum: 1,
          description: '限制输出的最大行数/文件数/计数条目数',
        },
        multiline: {
          type: 'boolean',
          default: false,
          description: '启用多行模式，允许.匹配换行符',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    };

    super(
      'grep',
      '内容搜索',
      '基于ripgrep的强大文本内容搜索工具，支持正则表达式和多种输出格式',
      ToolKind.Search,
      schema,
      false, // 搜索操作不需要确认
      '1.0.0',
      '搜索工具',
      ['search', 'grep', 'ripgrep', 'regex', 'text']
    );
  }

  build(params: GrepParams): ToolInvocation<GrepParams> {
    // 验证参数
    const pattern = this.validateString(params.pattern, 'pattern', {
      required: true,
      minLength: 1,
    });

    let path: string | undefined;
    if (params.path !== undefined) {
      path = this.validateString(params.path, 'path', {
        required: false,
        minLength: 1,
      });
    }

    let glob: string | undefined;
    if (params.glob !== undefined) {
      glob = this.validateString(params.glob, 'glob', {
        required: false,
        minLength: 1,
      });
    }

    let type: string | undefined;
    if (params.type !== undefined) {
      type = this.validateString(params.type, 'type', {
        required: false,
        minLength: 1,
      });
    }

    const outputMode = params.output_mode || 'files_with_matches';
    if (!['content', 'files_with_matches', 'count'].includes(outputMode)) {
      this.createValidationError(
        'output_mode',
        '输出模式必须是 content、files_with_matches 或 count 之一',
        outputMode
      );
    }

    const caseInsensitive = this.validateBoolean(
      params.case_insensitive ?? false,
      'case_insensitive'
    );
    const lineNumbers = this.validateBoolean(
      params.line_numbers ?? false,
      'line_numbers'
    );
    const multiline = this.validateBoolean(params.multiline ?? false, 'multiline');

    let contextBefore: number | undefined;
    if (params.context_before !== undefined) {
      contextBefore = this.validateNumber(params.context_before, 'context_before', {
        min: 0,
        integer: true,
      });
    }

    let contextAfter: number | undefined;
    if (params.context_after !== undefined) {
      contextAfter = this.validateNumber(params.context_after, 'context_after', {
        min: 0,
        integer: true,
      });
    }

    let context: number | undefined;
    if (params.context !== undefined) {
      context = this.validateNumber(params.context, 'context', {
        min: 0,
        integer: true,
      });
    }

    let headLimit: number | undefined;
    if (params.head_limit !== undefined) {
      headLimit = this.validateNumber(params.head_limit, 'head_limit', {
        min: 1,
        integer: true,
      });
    }

    const validatedParams: GrepParams = {
      pattern,
      ...(path !== undefined && { path }),
      ...(glob !== undefined && { glob }),
      ...(type !== undefined && { type }),
      output_mode: outputMode as 'content' | 'files_with_matches' | 'count',
      case_insensitive: caseInsensitive,
      line_numbers: lineNumbers,
      ...(contextBefore !== undefined && { context_before: contextBefore }),
      ...(contextAfter !== undefined && { context_after: contextAfter }),
      ...(context !== undefined && { context }),
      ...(headLimit !== undefined && { head_limit: headLimit }),
      multiline,
    };

    return new GrepToolInvocation(validatedParams);
  }
}

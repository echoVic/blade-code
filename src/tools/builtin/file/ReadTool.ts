import { promises as fs } from 'fs';
import { extname } from 'path';
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
 * 文件读取参数接口
 */
interface ReadParams {
  file_path: string;
  offset?: number;
  limit?: number;
  encoding?: 'utf8' | 'base64' | 'binary';
}

/**
 * 文件读取工具调用实现
 */
class ReadToolInvocation extends BaseToolInvocation<ReadParams> {
  constructor(params: ReadParams) {
    super('read', params);
  }

  getDescription(): string {
    const { file_path, offset, limit } = this.params;
    let desc = `读取文件 ${file_path}`;
    if (offset !== undefined) {
      desc += ` (从第${offset + 1}行开始`;
      if (limit !== undefined) {
        desc += `，最多${limit}行`;
      }
      desc += ')';
    }
    return desc;
  }

  getAffectedPaths(): string[] {
    return [this.params.file_path];
  }

  async shouldConfirm(): Promise<ConfirmationDetails | null> {
    // 读取操作通常不需要确认
    return null;
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    try {
      this.validateParams();
      this.checkAbortSignal(signal);

      const { file_path, offset, limit, encoding = 'utf8' } = this.params;

      updateOutput?.('开始读取文件...');

      // 检查文件是否存在
      try {
        await fs.access(file_path);
      } catch (error) {
        return this.createErrorResult(`文件不存在: ${file_path}`);
      }

      this.checkAbortSignal(signal);

      // 获取文件统计信息
      const stats = await fs.stat(file_path);

      if (stats.isDirectory()) {
        return this.createErrorResult(`无法读取目录: ${file_path}`);
      }

      // 获取文件扩展名以确定处理方式
      const ext = extname(file_path).toLowerCase();
      const isTextFile = this.isTextFile(ext);
      const isBinaryFile = this.isBinaryFile(ext);

      let content: string;
      const metadata: Record<string, any> = {
        file_path,
        file_size: stats.size,
        file_type: ext,
        last_modified: stats.mtime.toISOString(),
        encoding: encoding,
      };

      if (isBinaryFile && encoding === 'utf8') {
        // 对于二进制文件，自动切换到base64编码
        updateOutput?.('检测到二进制文件，使用base64编码...');
        content = await fs.readFile(file_path, 'base64');
        metadata.encoding = 'base64';
        metadata.is_binary = true;
      } else {
        // 读取文件内容
        const buffer = await fs.readFile(file_path);

        if (encoding === 'base64') {
          content = buffer.toString('base64');
        } else if (encoding === 'binary') {
          content = buffer.toString('binary');
        } else {
          content = buffer.toString('utf8');
        }
      }

      this.checkAbortSignal(signal);

      // 如果指定了偏移量和限制，处理行级切片
      if (
        (offset !== undefined || limit !== undefined) &&
        encoding === 'utf8' &&
        isTextFile
      ) {
        const lines = content.split('\n');
        const startLine = offset || 0;
        const endLine = limit !== undefined ? startLine + limit : lines.length;

        const selectedLines = lines.slice(startLine, endLine);
        content = selectedLines
          .map((line, index) => {
            const lineNumber = startLine + index + 1;
            return `${lineNumber.toString().padStart(6)}→${line}`;
          })
          .join('\n');

        metadata.lines_read = selectedLines.length;
        metadata.total_lines = lines.length;
        metadata.start_line = startLine + 1;
        metadata.end_line = Math.min(endLine, lines.length);
      }

      const displayMessage = this.formatDisplayMessage(file_path, metadata);

      return this.createSuccessResult(content, displayMessage, metadata);
    } catch (error: any) {
      return this.createErrorResult(error);
    }
  }

  private isTextFile(ext: string): boolean {
    const textExtensions = [
      '.txt',
      '.md',
      '.js',
      '.ts',
      '.jsx',
      '.tsx',
      '.json',
      '.xml',
      '.html',
      '.htm',
      '.css',
      '.scss',
      '.sass',
      '.less',
      '.yml',
      '.yaml',
      '.toml',
      '.ini',
      '.cfg',
      '.py',
      '.rb',
      '.php',
      '.java',
      '.cpp',
      '.c',
      '.h',
      '.hpp',
      '.rs',
      '.go',
      '.sh',
      '.bash',
      '.zsh',
      '.fish',
      '.ps1',
      '.bat',
      '.cmd',
      '.sql',
      '.graphql',
      '.vue',
      '.svelte',
      '.astro',
      '.dockerfile',
      '.gitignore',
      '.env',
    ];
    return textExtensions.includes(ext) || ext === '';
  }

  private isBinaryFile(ext: string): boolean {
    const binaryExtensions = [
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.bmp',
      '.svg',
      '.ico',
      '.webp',
      '.mp3',
      '.wav',
      '.mp4',
      '.avi',
      '.mov',
      '.wmv',
      '.flv',
      '.webm',
      '.pdf',
      '.doc',
      '.docx',
      '.xls',
      '.xlsx',
      '.ppt',
      '.pptx',
      '.zip',
      '.tar',
      '.gz',
      '.rar',
      '.7z',
      '.exe',
      '.dll',
      '.so',
      '.ttf',
      '.otf',
      '.woff',
      '.woff2',
      '.eot',
    ];
    return binaryExtensions.includes(ext);
  }

  private formatDisplayMessage(
    filePath: string,
    metadata: Record<string, any>
  ): string {
    let message = `成功读取文件: ${filePath}`;

    if (metadata.file_size) {
      message += ` (${this.formatFileSize(metadata.file_size)})`;
    }

    if (metadata.lines_read !== undefined) {
      message += `\n读取了 ${metadata.lines_read} 行 (第${metadata.start_line}-${metadata.end_line}行，共${metadata.total_lines}行)`;
    }

    if (metadata.is_binary) {
      message += '\n文件以base64编码显示';
    }

    return message;
  }

  private formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)}${units[unitIndex]}`;
  }
}

/**
 * 文件读取工具
 * 支持文本文件、图片、PDF等多种格式
 */
export class ReadTool extends DeclarativeTool<ReadParams> {
  constructor() {
    const schema: JSONSchema7 = {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '要读取的文件路径（绝对路径）',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: '开始读取的行号（可选，仅对文本文件有效）',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          description: '读取的行数（可选，仅对文本文件有效）',
        },
        encoding: {
          type: 'string',
          enum: ['utf8', 'base64', 'binary'],
          default: 'utf8',
          description: '文件编码方式',
        },
      },
      required: ['file_path'],
      additionalProperties: false,
    };

    super(
      'read',
      '文件读取',
      '读取本地文件系统中的文件，支持文本、图片、PDF等多种格式',
      ToolKind.Read,
      schema,
      false, // 读取操作通常不需要确认
      '1.0.0',
      '文件操作',
      ['file', 'io', 'read']
    );
  }

  build(params: ReadParams): ToolInvocation<ReadParams> {
    // 验证参数
    const filePath = this.validateString(params.file_path, 'file_path', {
      required: true,
      minLength: 1,
    });

    let offset: number | undefined;
    if (params.offset !== undefined) {
      offset = this.validateNumber(params.offset, 'offset', {
        min: 0,
        integer: true,
      });
    }

    let limit: number | undefined;
    if (params.limit !== undefined) {
      limit = this.validateNumber(params.limit, 'limit', {
        min: 1,
        integer: true,
      });
    }

    const encoding = params.encoding || 'utf8';
    if (!['utf8', 'base64', 'binary'].includes(encoding)) {
      this.createValidationError(
        'encoding',
        '编码格式必须是 utf8、base64 或 binary 之一',
        encoding
      );
    }

    const validatedParams: ReadParams = {
      file_path: filePath,
      ...(offset !== undefined && { offset }),
      ...(limit !== undefined && { limit }),
      encoding: encoding as 'utf8' | 'base64' | 'binary',
    };

    return new ReadToolInvocation(validatedParams);
  }
}

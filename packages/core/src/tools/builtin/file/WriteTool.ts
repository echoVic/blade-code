import { promises as fs } from 'fs';
import { dirname } from 'path';
import { DeclarativeTool } from '../../base/DeclarativeTool.js';
import { BaseToolInvocation } from '../../base/ToolInvocation.js';
import type { 
  ToolInvocation, 
  ToolResult, 
  JSONSchema7,
  ConfirmationDetails 
} from '../../types/index.js';
import { ToolKind } from '../../types/index.js';

/**
 * 文件写入参数接口
 */
interface WriteParams {
  file_path: string;
  content: string;
  encoding?: 'utf8' | 'base64' | 'binary';
  create_directories?: boolean;
  backup?: boolean;
}

/**
 * 文件写入工具调用实现
 */
class WriteToolInvocation extends BaseToolInvocation<WriteParams> {
  constructor(params: WriteParams) {
    super('write', params);
  }

  getDescription(): string {
    const { file_path } = this.params;
    return `写入文件 ${file_path}`;
  }

  getAffectedPaths(): string[] {
    return [this.params.file_path];
  }

  async shouldConfirm(): Promise<ConfirmationDetails | null> {
    const { file_path } = this.params;
    
    try {
      // 检查文件是否已存在
      await fs.access(file_path);
      
      // 文件存在，需要确认覆盖
      return {
        type: 'edit',
        title: '确认文件覆盖',
        message: `文件 ${file_path} 已存在，确认要覆盖吗？`,
        risks: [
          '现有文件内容将被完全替换',
          '此操作不可撤销（除非有备份）'
        ],
        affectedFiles: [file_path]
      };
    } catch {
      // 文件不存在，不需要确认
      return null;
    }
  }

  async execute(signal: AbortSignal, updateOutput?: (output: string) => void): Promise<ToolResult> {
    try {
      this.validateParams();
      this.checkAbortSignal(signal);

      const { 
        file_path, 
        content, 
        encoding = 'utf8',
        create_directories = true,
        backup = false
      } = this.params;

      updateOutput?.('开始写入文件...');

      // 检查并创建目录
      if (create_directories) {
        const dir = dirname(file_path);
        try {
          await fs.mkdir(dir, { recursive: true });
        } catch (error: any) {
          if (error.code !== 'EEXIST') {
            throw error;
          }
        }
      }

      this.checkAbortSignal(signal);

      // 创建备份（如果文件存在且启用备份）
      let backupPath: string | undefined;
      if (backup) {
        try {
          await fs.access(file_path);
          backupPath = `${file_path}.backup.${Date.now()}`;
          await fs.copyFile(file_path, backupPath);
          updateOutput?.(`已创建备份: ${backupPath}`);
        } catch {
          // 文件不存在，无需备份
        }
      }

      this.checkAbortSignal(signal);

      // 根据编码写入文件
      let writeBuffer: Buffer;
      
      if (encoding === 'base64') {
        writeBuffer = Buffer.from(content, 'base64');
      } else if (encoding === 'binary') {
        writeBuffer = Buffer.from(content, 'binary');
      } else {
        writeBuffer = Buffer.from(content, 'utf8');
      }

      await fs.writeFile(file_path, writeBuffer);

      this.checkAbortSignal(signal);

      // 验证写入是否成功
      const stats = await fs.stat(file_path);
      
      const metadata: Record<string, any> = {
        file_path,
        content_size: content.length,
        file_size: stats.size,
        encoding,
        created_directories: create_directories,
        backup_created: backup && backupPath !== undefined,
        backup_path: backupPath,
        last_modified: stats.mtime.toISOString()
      };

      const displayMessage = this.formatDisplayMessage(file_path, metadata);
      
      return this.createSuccessResult(
        { file_path, size: stats.size, modified: stats.mtime.toISOString() },
        displayMessage,
        metadata
      );

    } catch (error: any) {
      return this.createErrorResult(error);
    }
  }

  private formatDisplayMessage(filePath: string, metadata: Record<string, any>): string {
    let message = `成功写入文件: ${filePath}`;
    
    if (metadata.file_size !== undefined) {
      message += ` (${this.formatFileSize(metadata.file_size)})`;
    }
    
    if (metadata.backup_created) {
      message += `\n已创建备份: ${metadata.backup_path}`;
    }
    
    if (metadata.encoding !== 'utf8') {
      message += `\n使用编码: ${metadata.encoding}`;
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
 * 文件写入工具
 * 提供安全的文件写入功能，支持备份和目录创建
 */
export class WriteTool extends DeclarativeTool<WriteParams> {
  constructor() {
    const schema: JSONSchema7 = {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '要写入的文件路径（绝对路径）'
        },
        content: {
          type: 'string',
          description: '要写入的文件内容'
        },
        encoding: {
          type: 'string',
          enum: ['utf8', 'base64', 'binary'],
          default: 'utf8',
          description: '文件编码方式'
        },
        create_directories: {
          type: 'boolean',
          default: true,
          description: '是否自动创建不存在的目录'
        },
        backup: {
          type: 'boolean',
          default: false,
          description: '是否在覆盖文件前创建备份'
        }
      },
      required: ['file_path', 'content'],
      additionalProperties: false
    };

    super(
      'write',
      '文件写入',
      '将内容写入到本地文件系统，支持自动创建目录和备份功能',
      ToolKind.Edit,
      schema,
      true, // 写入操作需要确认（特别是覆盖现有文件时）
      '1.0.0',
      '文件操作',
      ['file', 'io', 'write', 'create']
    );
  }

  build(params: WriteParams): ToolInvocation<WriteParams> {
    // 验证参数
    const filePath = this.validateString(params.file_path, 'file_path', { 
      required: true,
      minLength: 1
    });

    const content = this.validateString(params.content, 'content', { 
      required: true
    });

    const encoding = params.encoding || 'utf8';
    if (!['utf8', 'base64', 'binary'].includes(encoding)) {
      this.createValidationError('encoding', '编码格式必须是 utf8、base64 或 binary 之一', encoding);
    }

    const createDirectories = this.validateBoolean(params.create_directories ?? true, 'create_directories');
    const backup = this.validateBoolean(params.backup ?? false, 'backup');

    const validatedParams: WriteParams = {
      file_path: filePath,
      content,
      encoding: encoding as 'utf8' | 'base64' | 'binary',
      create_directories: createDirectories,
      backup
    };

    return new WriteToolInvocation(validatedParams);
  }
}
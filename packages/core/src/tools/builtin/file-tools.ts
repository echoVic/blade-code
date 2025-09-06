import { promises as fs } from 'fs';
import { dirname, join, resolve } from 'path';
import { ErrorFactory, globalErrorMonitor } from '../../error/index.js';
import {
  CommandPreCheckResult,
  ConfirmableToolBase,
  ConfirmationOptions,
  RiskLevel,
} from '../base/ConfirmableToolBase.js';

/**
 * 文件读取工具
 */
export class FileReadTool extends ConfirmableToolBase {
  readonly name = 'file_read';
  readonly description = '读取文件内容';
  readonly category = 'filesystem';
  readonly tags = ['file', 'read', 'content'];

  readonly parameters = {
    path: {
      type: 'string' as const,
      required: true,
      description: '文件路径',
    },
    encoding: {
      type: 'string' as const,
      required: false,
      description: '文件编码',
      enum: ['utf8', 'base64', 'hex'],
      default: 'utf8',
    },
    maxSize: {
      type: 'number' as const,
      required: false,
      description: '最大文件大小（字节）',
      default: 1024 * 1024, // 1MB
    },
    skipConfirmation: {
      type: 'boolean' as const,
      required: false,
      description: '跳过用户确认直接执行',
      default: true,
    },
  };

  protected async buildCommand(params: Record<string, any>): Promise<string> {
    // 文件读取不需要构建命令
    return '';
  }

  protected getConfirmationOptions(params: Record<string, any>): ConfirmationOptions {
    return {
      skipConfirmation: true,
      riskLevel: RiskLevel.SAFE,
      showPreview: false,
      timeout: 5000,
    };
  }

  protected async preCheckCommand(
    _command: string,
    _workingDirectory: string,
    params: Record<string, any>
  ): Promise<CommandPreCheckResult> {
    const { path } = params;
    try {
      const resolvedPath = resolve(path);
      await fs.access(resolvedPath);
      return { valid: true };
    } catch (error: any) {
      return {
        valid: false,
        message: `文件不存在或无法访问: ${error.message}`,
      };
    }
  }

  protected getExecutionDescription(params: Record<string, any>): string {
    return `读取文件: ${params.path}`;
  }

  protected async postProcessResult(
    _result: { stdout: string; stderr: string },
    params: Record<string, any>
  ): Promise<any> {
    const { path, encoding, maxSize } = params;

    try {
      const resolvedPath = resolve(path);
      const stats = await fs.stat(resolvedPath);

      if (!stats.isFile()) {
        throw new Error('指定路径不是文件');
      }

      if (stats.size > maxSize) {
        throw new Error(`文件太大 (${stats.size} 字节)，超过限制 (${maxSize} 字节)`);
      }

      const content = await fs.readFile(resolvedPath, encoding as BufferEncoding);

      return {
        success: true,
        data: {
          path: resolvedPath,
          content,
          encoding,
          size: stats.size,
          modified: stats.mtime,
          created: stats.birthtime,
        },
      };
    } catch (error: any) {
      const fileSystemError = ErrorFactory.createFileSystemError(
        'FILE_READ_FAILED',
        `文件读取失败: ${error.message}`,
        {
          context: { path, encoding },
          retryable: true,
          suggestions: ['检查文件路径是否正确', '确认文件权限设置', '确认文件未被其他程序占用'],
        }
      );

      globalErrorMonitor.monitor(fileSystemError);

      return {
        success: false,
        error: fileSystemError.message,
      };
    }
  }
}

/**
 * 文件写入工具
 */
export class FileWriteTool extends ConfirmableToolBase {
  readonly name = 'file_write';
  readonly description = '写入文件内容';
  readonly category = 'filesystem';
  readonly tags = ['file', 'write', 'content'];

  readonly parameters = {
    path: {
      type: 'string' as const,
      required: true,
      description: '文件路径',
    },
    content: {
      type: 'string' as const,
      required: true,
      description: '要写入的内容',
    },
    encoding: {
      type: 'string' as const,
      required: false,
      description: '文件编码',
      enum: ['utf8', 'base64', 'hex'],
      default: 'utf8',
    },
    createDirs: {
      type: 'boolean' as const,
      required: false,
      description: '是否创建父目录',
      default: true,
    },
    skipConfirmation: {
      type: 'boolean' as const,
      required: false,
      description: '跳过用户确认直接执行',
      default: false,
    },
  };

  protected async buildCommand(params: Record<string, any>): Promise<string> {
    // 文件写入不需要构建命令
    return '';
  }

  protected getConfirmationOptions(params: Record<string, any>): ConfirmationOptions {
    return {
      skipConfirmation: params.skipConfirmation || false,
      riskLevel: RiskLevel.MODERATE,
      showPreview: true,
      timeout: 10000,
    };
  }

  protected async preCheckCommand(
    _command: string,
    _workingDirectory: string,
    params: Record<string, any>
  ): Promise<CommandPreCheckResult> {
    const { path, createDirs } = params;

    try {
      const resolvedPath = resolve(path);
      const dir = dirname(resolvedPath);

      // 检查父目录是否存在
      try {
        await fs.access(dir);
      } catch {
        if (!createDirs) {
          return {
            valid: false,
            message: `父目录不存在: ${dir}`,
            suggestions: [
              {
                command: `mkdir -p "${dir}"`,
                description: '创建父目录',
                riskLevel: RiskLevel.SAFE,
              },
            ],
          };
        }
      }

      return { valid: true };
    } catch (error: any) {
      return {
        valid: false,
        message: `预检查失败: ${error.message}`,
      };
    }
  }

  protected getExecutionDescription(params: Record<string, any>): string {
    return `写入文件: ${params.path}`;
  }

  protected async postProcessResult(
    _result: { stdout: string; stderr: string },
    params: Record<string, any>
  ): Promise<any> {
    const { path, content, encoding, createDirs } = params;

    try {
      const resolvedPath = resolve(path);

      if (createDirs) {
        const dir = dirname(resolvedPath);
        await fs.mkdir(dir, { recursive: true });
      }

      await fs.writeFile(resolvedPath, content, encoding as BufferEncoding);

      const stats = await fs.stat(resolvedPath);

      return {
        success: true,
        data: {
          path: resolvedPath,
          size: stats.size,
          modified: stats.mtime,
          created: stats.birthtime,
        },
      };
    } catch (error: any) {
      const fileSystemError = ErrorFactory.createFileSystemError(
        'FILE_WRITE_FAILED',
        `文件写入失败: ${error.message}`,
        {
          context: { path },
          retryable: true,
          suggestions: ['检查文件路径是否正确', '确认写入权限', '检查磁盘空间'],
        }
      );

      globalErrorMonitor.monitor(fileSystemError);

      return {
        success: false,
        error: fileSystemError.message,
      };
    }
  }
}

/**
 * 文件列表工具
 */
export class FileListTool extends ConfirmableToolBase {
  readonly name = 'file_list';
  readonly description = '列出目录内容';
  readonly category = 'filesystem';
  readonly tags = ['file', 'list', 'directory'];

  readonly parameters = {
    path: {
      type: 'string' as const,
      required: false,
      description: '目录路径',
      default: '.',
    },
    recursive: {
      type: 'boolean' as const,
      required: false,
      description: '是否递归列出',
      default: false,
    },
    skipConfirmation: {
      type: 'boolean' as const,
      required: false,
      description: '跳过用户确认直接执行',
      default: true,
    },
  };

  protected async buildCommand(params: Record<string, any>): Promise<string> {
    // 文件列表不需要构建命令
    return '';
  }

  protected getConfirmationOptions(params: Record<string, any>): ConfirmationOptions {
    return {
      skipConfirmation: true,
      riskLevel: RiskLevel.SAFE,
      showPreview: false,
      timeout: 5000,
    };
  }

  protected async preCheckCommand(
    _command: string,
    _workingDirectory: string,
    params: Record<string, any>
  ): Promise<CommandPreCheckResult> {
    const { path } = params;
    try {
      const resolvedPath = resolve(path);
      const stats = await fs.stat(resolvedPath);

      if (!stats.isDirectory()) {
        return {
          valid: false,
          message: '指定路径不是目录',
        };
      }

      return { valid: true };
    } catch (error: any) {
      return {
        valid: false,
        message: `目录不存在或无法访问: ${error.message}`,
      };
    }
  }

  protected getExecutionDescription(params: Record<string, any>): string {
    const { path, recursive } = params;
    return `${recursive ? '递归' : ''}列出目录: ${path}`;
  }

  protected async postProcessResult(
    _result: { stdout: string; stderr: string },
    params: Record<string, any>
  ): Promise<any> {
    const { path, recursive } = params;

    try {
      const resolvedPath = resolve(path);

      const processDir = async (dirPath: string): Promise<any[]> => {
        const items = await fs.readdir(dirPath);
        const results: any[] = [];

        for (const item of items) {
          const fullPath = join(dirPath, item);
          const stats = await fs.stat(fullPath);

          const itemInfo = {
            name: item,
            path: fullPath,
            type: stats.isDirectory() ? 'directory' : 'file',
            size: stats.size,
            modified: stats.mtime,
            created: stats.birthtime,
          };

          results.push(itemInfo);

          if (recursive && stats.isDirectory()) {
            const subItems = await processDir(fullPath);
            results.push(...subItems);
          }
        }

        return results;
      };

      const items = await processDir(resolvedPath);

      return {
        success: true,
        data: {
          path: resolvedPath,
          items,
          count: items.length,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: `列出目录失败: ${error.message}`,
      };
    }
  }
}

// 统一导出所有文件工具
export const FILE_TOOLS = [FileReadTool, FileWriteTool, FileListTool];

// 导出工具实例
export const fileRead = new FileReadTool();
export const fileWrite = new FileWriteTool();
export const fileList = new FileListTool();

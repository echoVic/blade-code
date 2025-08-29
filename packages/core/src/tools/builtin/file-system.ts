import { promises as fs } from 'fs';
import { basename, dirname, extname, join, resolve } from 'path';
import {
  CommandPreCheckResult,
  ConfirmableToolBase,
  ConfirmationOptions,
  RiskLevel,
} from '../base/ConfirmableToolBase.js';
import type { ToolDefinition } from '../types.js';

/**
 * 文件读取工具
 */
const fileReadTool: ToolDefinition = {
  name: 'file_read',
  description: '读取文件内容',
  version: '1.0.0',
  category: 'filesystem',
  tags: ['file', 'read', 'content'],
  parameters: {
    path: {
      type: 'string',
      description: '文件路径',
      required: true,
    },
    encoding: {
      type: 'string',
      description: '文件编码',
      enum: ['utf8', 'base64', 'hex'],
      default: 'utf8',
    },
    maxSize: {
      type: 'number',
      description: '最大文件大小（字节）',
      default: 1024 * 1024, // 1MB
    },
  },
  required: ['path'],
  async execute(params) {
    const { path, encoding, maxSize } = params;

    try {
      const resolvedPath = resolve(path);

      // 检查文件是否存在
      const stats = await fs.stat(resolvedPath);

      if (!stats.isFile()) {
        return {
          success: false,
          error: '指定路径不是文件',
        };
      }

      // 检查文件大小
      if (stats.size > maxSize) {
        return {
          success: false,
          error: `文件太大 (${stats.size} 字节)，超过限制 (${maxSize} 字节)`,
        };
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
      return {
        success: false,
        error: `文件读取失败: ${error.message}`,
      };
    }
  },
};

/**
 * 文件写入工具 (基于 ConfirmableToolBase)
 * 写入文件内容，带用户确认功能
 */
class FileWriteTool extends ConfirmableToolBase {
  readonly name = 'file_write';
  readonly description = '写入文件内容（需要用户确认）';
  readonly category = 'filesystem';
  readonly tags = ['file', 'write', 'create'];

  readonly parameters = {
    path: {
      type: 'string' as const,
      required: true,
      description: '文件路径',
    },
    content: {
      type: 'string' as const,
      required: true,
      description: '文件内容',
    },
    encoding: {
      type: 'string' as const,
      required: false,
      description: '文件编码',
      default: 'utf8',
    },
    createDirectories: {
      type: 'boolean' as const,
      required: false,
      description: '是否创建目录结构',
      default: true,
    },
    overwrite: {
      type: 'boolean' as const,
      required: false,
      description: '是否覆盖已存在的文件',
      default: false,
    },
    skipConfirmation: {
      type: 'boolean' as const,
      required: false,
      description: '跳过用户确认直接执行',
      default: false,
    },
    riskLevel: {
      type: 'string' as const,
      required: false,
      description: '风险级别：safe, moderate, high, critical',
      default: 'moderate',
    },
  };

  readonly required = ['path', 'content'];

  /**
   * 预处理参数
   */
  protected async preprocessParameters(params: Record<string, any>): Promise<Record<string, any>> {
    const { path, content } = params;

    // 验证路径安全性
    if (path.includes('..') || path.startsWith('/') || path.includes('\\')) {
      // 允许相对路径但需要确认
      if (path.includes('..')) {
        throw new Error('不允许使用相对路径（..）');
      }
    }

    // 验证内容长度
    if (content.length > 10 * 1024 * 1024) {
      // 10MB
      throw new Error('文件内容过大（超过10MB）');
    }

    return params;
  }

  /**
   * 构建命令描述（非实际命令）
   */
  protected async buildCommand(params: Record<string, any>): Promise<string> {
    const { path, content, encoding, overwrite } = params;

    return `写入文件: ${path} (${content.length}字符, ${encoding}编码${overwrite ? ', 覆盖模式' : ''})`;
  }

  /**
   * 获取确认选项
   */
  protected getConfirmationOptions(params: Record<string, any>): ConfirmationOptions {
    const baseOptions = super.getConfirmationOptions(params);

    let riskLevel = RiskLevel.MODERATE;
    let confirmMessage = '';

    if (params.overwrite) {
      riskLevel = RiskLevel.HIGH;
      confirmMessage = `⚠️  将覆盖文件 "${params.path}"，是否继续？`;
    } else {
      riskLevel = RiskLevel.MODERATE;
      confirmMessage = `写入文件 "${params.path}"？`;
    }

    return {
      ...baseOptions,
      riskLevel,
      confirmMessage,
    };
  }

  /**
   * 预检查命令
   */
  protected async preCheckCommand(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _command: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _workingDirectory: string,
    params: Record<string, any>
  ): Promise<CommandPreCheckResult> {
    try {
      const resolvedPath = resolve(params.path);

      // 检查文件是否已存在
      try {
        await fs.access(resolvedPath);
        if (!params.overwrite) {
          return {
            valid: false,
            message: `文件 "${params.path}" 已存在`,
            suggestions: [
              {
                command: `写入文件: ${params.path} (覆盖模式)`,
                description: '覆盖已存在的文件',
                riskLevel: RiskLevel.HIGH,
              },
            ],
          };
        }
      } catch {
        // 文件不存在，可以继续
      }

      // 检查目录是否存在
      const dir = dirname(resolvedPath);
      try {
        await fs.access(dir);
      } catch {
        if (!params.createDirectories) {
          return {
            valid: false,
            message: `目录 "${dir}" 不存在`,
            suggestions: [
              {
                command: `写入文件: ${params.path} (创建目录)`,
                description: '自动创建目录结构',
                riskLevel: RiskLevel.MODERATE,
              },
            ],
          };
        }
      }

      return { valid: true };
    } catch (error: any) {
      return {
        valid: false,
        message: `文件预检查失败: ${error.message}`,
      };
    }
  }

  /**
   * 获取执行描述
   */
  protected getExecutionDescription(params: Record<string, any>): string {
    const { path, content, encoding, overwrite, createDirectories } = params;

    let description = `写入文件: ${path} (${content.length}字符, ${encoding}编码)`;

    if (overwrite) {
      description += ' - 覆盖模式';
    }

    if (createDirectories) {
      description += ' - 自动创建目录';
    }

    return description;
  }

  /**
   * 获取执行预览
   */
  protected async getExecutionPreview(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _command: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _workingDirectory: string,
    params: Record<string, any>
  ): Promise<string> {
    const { path, content } = params;
    const resolvedPath = resolve(path);

    let preview = `文件路径: ${resolvedPath}\n`;
    preview += `内容长度: ${content.length} 字符\n`;

    if (content.length <= 200) {
      preview += `内容预览:\n${content}`;
    } else {
      preview += `内容预览:\n${content.substring(0, 200)}...(已截断)`;
    }

    return preview;
  }

  /**
   * 执行文件写入
   */
  protected async executeCommand(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _command: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _workingDirectory: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: ConfirmationOptions,
    params: Record<string, any>
  ) {
    const { path, content, encoding, createDirectories } = params;

    try {
      const resolvedPath = resolve(path);

      // 创建目录结构
      if (createDirectories) {
        const dir = dirname(resolvedPath);
        await fs.mkdir(dir, { recursive: true });
      }

      await fs.writeFile(resolvedPath, content, encoding as BufferEncoding);

      // 获取文件信息
      const stats = await fs.stat(resolvedPath);

      return {
        success: true,
        data: {
          path: resolvedPath,
          size: stats.size,
          encoding,
          created: stats.birthtime,
          modified: stats.mtime,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: `文件写入失败: ${error.message}`,
      };
    }
  }
}

// 创建 file_write 工具实例
const fileWriteTool = new FileWriteTool();

/**
 * 目录列表工具
 */
const directoryListTool: ToolDefinition = {
  name: 'directory_list',
  description: '列出目录内容',
  version: '1.0.0',
  category: 'filesystem',
  tags: ['directory', 'list', 'files'],
  parameters: {
    path: {
      type: 'string',
      description: '目录路径',
      default: '.',
    },
    recursive: {
      type: 'boolean',
      description: '是否递归列出子目录',
      default: false,
    },
    includeHidden: {
      type: 'boolean',
      description: '是否包含隐藏文件',
      default: false,
    },
    fileTypes: {
      type: 'array',
      description: '文件类型过滤',
      items: {
        type: 'string',
      },
    },
  },
  async execute(params) {
    const { path, recursive, includeHidden, fileTypes } = params;

    try {
      const resolvedPath = resolve(path);

      // 检查路径是否存在且为目录
      const stats = await fs.stat(resolvedPath);
      if (!stats.isDirectory()) {
        return {
          success: false,
          error: '指定路径不是目录',
        };
      }

      const files: any[] = [];

      async function listDirectory(dirPath: string, depth = 0): Promise<void> {
        const items = await fs.readdir(dirPath);

        for (const item of items) {
          // 跳过隐藏文件
          if (!includeHidden && item.startsWith('.')) {
            continue;
          }

          const itemPath = join(dirPath, item);
          const itemStats = await fs.stat(itemPath);
          const relativePath = itemPath.replace(resolvedPath, '').replace(/^[/\\]/, '');

          const fileInfo = {
            name: item,
            path: itemPath,
            relativePath: relativePath || item,
            type: itemStats.isDirectory() ? 'directory' : 'file',
            size: itemStats.size,
            modified: itemStats.mtime,
            created: itemStats.birthtime,
            extension: itemStats.isFile() ? extname(item) : null,
            depth,
          };

          // 文件类型过滤
          if (fileTypes && fileTypes.length > 0 && itemStats.isFile()) {
            const ext = extname(item).toLowerCase();
            if (!fileTypes.includes(ext)) {
              continue;
            }
          }

          files.push(fileInfo);

          // 递归处理子目录
          if (recursive && itemStats.isDirectory()) {
            await listDirectory(itemPath, depth + 1);
          }
        }
      }

      await listDirectory(resolvedPath);

      // 统计信息
      const stats_summary = {
        total: files.length,
        files: files.filter(f => f.type === 'file').length,
        directories: files.filter(f => f.type === 'directory').length,
        totalSize: files.filter(f => f.type === 'file').reduce((sum, f) => sum + f.size, 0),
      };

      return {
        success: true,
        data: {
          path: resolvedPath,
          files,
          stats: stats_summary,
          options: {
            recursive,
            includeHidden,
            fileTypes,
          },
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: `目录列表失败: ${error.message}`,
      };
    }
  },
};

/**
 * 文件信息工具
 */
const fileInfoTool: ToolDefinition = {
  name: 'file_info',
  description: '获取文件或目录详细信息',
  version: '1.0.0',
  category: 'filesystem',
  tags: ['file', 'info', 'stats'],
  parameters: {
    path: {
      type: 'string',
      description: '文件或目录路径',
      required: true,
    },
  },
  required: ['path'],
  async execute(params) {
    const { path } = params;

    try {
      const resolvedPath = resolve(path);
      const stats = await fs.stat(resolvedPath);

      const info = {
        path: resolvedPath,
        name: basename(resolvedPath),
        directory: dirname(resolvedPath),
        extension: stats.isFile() ? extname(resolvedPath) : null,
        type: stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other',
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
        permissions: {
          readable: true, // Node.js doesn't provide easy access to detailed permissions
          writable: true,
          executable: stats.isFile() && (stats.mode & parseInt('111', 8)) !== 0,
        },
        timestamps: {
          created: stats.birthtime,
          modified: stats.mtime,
          accessed: stats.atime,
          changed: stats.ctime,
        },
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        isSymbolicLink: stats.isSymbolicLink(),
        mode: stats.mode.toString(8),
        uid: stats.uid,
        gid: stats.gid,
      };

      return {
        success: true,
        data: info,
      };
    } catch (error: any) {
      return {
        success: false,
        error: `获取文件信息失败: ${error.message}`,
      };
    }
  },
};

/**
 * 格式化文件大小
 */
function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * 导出所有文件系统工具
 */
export const fileSystemTools: ToolDefinition[] = [
  fileReadTool,
  fileWriteTool,
  directoryListTool,
  fileInfoTool,
];

import { z } from 'zod';
import { promises as fs } from 'fs';
import { createTool } from '../../core/createTool.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';
import { ToolKind, ToolErrorType } from '../../types/index.js';
import type { ToolResult, ConfirmationDetails } from '../../types/index.js';
import type { ExecutionContext } from '../../types/index.js';

/**
 * EditTool - 文件编辑工具
 * 使用新的 Zod 验证设计
 */
export const editTool = createTool({
  name: 'Edit',
  displayName: '文件编辑',
  kind: ToolKind.Edit,

  // Zod Schema 定义
  schema: z.object({
    file_path: ToolSchemas.filePath({
      description: '要编辑的文件路径（必须是绝对路径）',
    }),
    old_string: z
      .string()
      .min(1, '要替换的字符串不能为空')
      .describe('要替换的字符串内容'),
    new_string: z.string().describe('新的字符串内容（可以为空字符串）'),
    replace_all: z
      .boolean()
      .default(false)
      .describe('是否替换所有匹配项（默认只替换第一个）'),
  }),

  // 工具描述
  description: {
    short: '在文件中进行精确的字符串替换，支持替换单个或所有匹配项',
    long: `提供精确的字符串搜索和替换功能。默认只替换第一个匹配项，可通过 replace_all 参数替换所有匹配项。`,
    usageNotes: [
      'file_path 必须是绝对路径',
      'old_string 必须在文件中存在，否则操作失败',
      'old_string 必须是唯一的（或使用 replace_all），避免误替换',
      '替换时会保留原文件的缩进和格式',
      'new_string 和 old_string 不能相同',
      '替换前建议先用 Read 工具确认文件内容',
      '替换操作会直接修改文件，无法撤销',
    ],
    examples: [
      {
        description: '替换第一个匹配项',
        params: {
          file_path: '/path/to/file.ts',
          old_string: 'const foo = 1;',
          new_string: 'const foo = 2;',
        },
      },
      {
        description: '替换所有匹配项',
        params: {
          file_path: '/path/to/file.ts',
          old_string: 'console.log',
          new_string: 'logger.info',
          replace_all: true,
        },
      },
      {
        description: '删除内容（new_string 为空）',
        params: {
          file_path: '/path/to/file.ts',
          old_string: '// TODO: remove this\n',
          new_string: '',
        },
      },
    ],
    important: [
      '使用 Edit 工具前必须先用 Read 工具读取文件',
      '如果 old_string 在文件中不唯一，必须提供更大的上下文或使用 replace_all',
      'Edit 操作会保留 Read 工具输出中的缩进（行号前缀之后的内容）',
      '替换多行内容时，old_string 必须包含完整的换行符',
      '如果文件不存在，操作会失败',
    ],
  },

  // 需要用户确认
  requiresConfirmation: async (params): Promise<ConfirmationDetails | null> => {
    const { file_path, old_string, replace_all } = params;

    try {
      // 读取文件内容预览替换操作
      const content = await fs.readFile(file_path, 'utf8');
      const matches = findMatches(content, old_string);

      if (matches.length === 0) {
        return {
          type: 'edit',
          title: '未找到匹配内容',
          message: `在文件 ${file_path} 中未找到要替换的内容`,
          risks: ['操作将不会进行任何更改'],
          affectedFiles: [file_path],
        };
      }

      const replaceCount = replace_all ? matches.length : 1;
      return {
        type: 'edit',
        title: '确认文件编辑',
        message: `将在 ${file_path} 中${replace_all ? '替换所有' : '替换首个'}匹配项 (共找到${matches.length}处)`,
        risks: [
          `将替换 ${replaceCount} 处匹配项`,
          '此操作将直接修改文件',
          '建议先备份重要文件',
        ],
        affectedFiles: [file_path],
      };
    } catch (error) {
      return {
        type: 'edit',
        title: '文件访问错误',
        message: `无法读取文件 ${file_path}: ${(error as Error).message}`,
        risks: ['文件可能不存在或无权访问'],
        affectedFiles: [file_path],
      };
    }
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { file_path, old_string, new_string, replace_all } = params;
    const { signal, updateOutput } = context;

    try {
      updateOutput?.('开始读取文件...');

      // 读取文件内容
      let content: string;
      try {
        content = await fs.readFile(file_path, 'utf8');
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return {
            success: false,
            llmContent: `文件不存在: ${file_path}`,
            displayContent: `❌ 文件不存在: ${file_path}`,
            error: {
              type: ToolErrorType.EXECUTION_ERROR,
              message: `文件不存在`,
            },
          };
        }
        throw error;
      }

      signal.throwIfAborted();

      // 验证字符串不能相同
      if (old_string === new_string) {
        return {
          success: false,
          llmContent: '新字符串与旧字符串相同，无需进行替换',
          displayContent: '⚠️ 新字符串与旧字符串相同，无需进行替换',
          error: {
            type: ToolErrorType.VALIDATION_ERROR,
            message: '新旧字符串相同',
          },
        };
      }

      // 查找匹配项
      const matches = findMatches(content, old_string);

      if (matches.length === 0) {
        return {
          success: false,
          llmContent: `在文件中未找到要替换的字符串: "${old_string}"`,
          displayContent: `❌ 在文件中未找到要替换的字符串: "${old_string.substring(0, 50)}${old_string.length > 50 ? '...' : ''}"`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '未找到匹配内容',
          },
        };
      }

      updateOutput?.(`找到 ${matches.length} 个匹配项，开始替换...`);

      // 执行替换
      let newContent: string;
      let replacedCount: number;

      if (replace_all) {
        // 替换所有匹配项
        newContent = content.split(old_string).join(new_string);
        replacedCount = matches.length;
      } else {
        // 只替换第一个匹配项
        const firstMatchIndex = content.indexOf(old_string);
        newContent =
          content.substring(0, firstMatchIndex) +
          new_string +
          content.substring(firstMatchIndex + old_string.length);
        replacedCount = 1;
      }

      signal.throwIfAborted();

      // 写入文件
      await fs.writeFile(file_path, newContent, 'utf8');

      // 验证写入成功
      const stats = await fs.stat(file_path);

      const metadata: Record<string, any> = {
        file_path,
        matches_found: matches.length,
        replacements_made: replacedCount,
        replace_all,
        old_string_length: old_string.length,
        new_string_length: new_string.length,
        original_size: content.length,
        new_size: newContent.length,
        size_diff: newContent.length - content.length,
        last_modified: stats.mtime.toISOString(),
      };

      const displayMessage = formatDisplayMessage(metadata);

      return {
        success: true,
        llmContent: {
          file_path,
          replacements: replacedCount,
          total_matches: matches.length,
        },
        displayContent: displayMessage,
        metadata,
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          llmContent: '文件编辑被中止',
          displayContent: '⚠️ 文件编辑被用户中止',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
        };
      }

      return {
        success: false,
        llmContent: `编辑文件失败: ${error.message}`,
        displayContent: `❌ 编辑文件失败: ${error.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error.message,
          details: error,
        },
      };
    }
  },

  version: '2.0.0',
  category: '文件操作',
  tags: ['file', 'edit', 'replace', 'modify'],
});

/**
 * 查找所有匹配项的位置
 */
function findMatches(content: string, searchString: string): number[] {
  const matches: number[] = [];
  let index = content.indexOf(searchString);

  while (index !== -1) {
    matches.push(index);
    index = content.indexOf(searchString, index + 1);
  }

  return matches;
}

/**
 * 格式化显示消息
 */
function formatDisplayMessage(metadata: Record<string, any>): string {
  const { file_path, matches_found, replacements_made, replace_all, size_diff } = metadata;

  let message = `✅ 成功编辑文件: ${file_path}`;
  message += `\n📝 替换了 ${replacements_made} 个匹配项`;

  if (!replace_all && matches_found > 1) {
    message += ` (共找到 ${matches_found} 个匹配项)`;
  }

  if (size_diff !== 0) {
    const sizeChange = size_diff > 0 ? `增加${size_diff}` : `减少${Math.abs(size_diff)}`;
    message += `\n📊 文件大小${sizeChange}个字符`;
  }

  return message;
}

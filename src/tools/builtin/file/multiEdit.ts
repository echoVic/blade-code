import { promises as fs } from 'fs';
import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';

/**
 * 编辑操作 Schema
 */
const EditOperationSchema = z.object({
  old_string: z.string().min(1, '要替换的字符串不能为空'),
  new_string: z.string(),
  replace_all: z.boolean().default(false),
});

/**
 * 批量编辑参数 Schema
 */
const MultiEditParamsSchema = z.object({
  file_path: ToolSchemas.filePath({ description: '要编辑的文件绝对路径' }),
  edits: z
    .array(EditOperationSchema)
    .min(1, '至少需要一个编辑操作')
    .describe('编辑操作列表，按顺序执行'),
});

type MultiEditParams = z.infer<typeof MultiEditParamsSchema>;
type EditOperation = z.infer<typeof EditOperationSchema>;

/**
 * 分析编辑操作预览
 */
function _analyzeEdits(content: string, edits: EditOperation[]) {
  let totalMatches = 0;
  let totalReplacements = 0;
  let successfulEdits = 0;

  for (const edit of edits) {
    const matches = findMatches(content, edit.old_string);
    if (matches.length > 0) {
      successfulEdits++;
      totalMatches += matches.length;
      totalReplacements += edit.replace_all ? matches.length : 1;
    }
  }

  return { totalMatches, totalReplacements, successfulEdits };
}

/**
 * 查找所有匹配位置
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
 * 应用单个编辑操作
 */
function applyEdit(content: string, edit: EditOperation) {
  const matches = findMatches(content, edit.old_string);

  if (matches.length === 0) {
    throw new Error(`未找到要替换的字符串: "${edit.old_string}"`);
  }

  let newContent: string;
  let replacementsMade: number;

  if (edit.replace_all) {
    newContent = content.split(edit.old_string).join(edit.new_string);
    replacementsMade = matches.length;
  } else {
    const firstMatchIndex = content.indexOf(edit.old_string);
    newContent =
      content.substring(0, firstMatchIndex) +
      edit.new_string +
      content.substring(firstMatchIndex + edit.old_string.length);
    replacementsMade = 1;
  }

  return {
    newContent,
    matchesFound: matches.length,
    replacementsMade,
  };
}

/**
 * 批量编辑工具
 * 在单个文件中执行多个编辑操作
 */
export const multiEditTool = createTool({
  name: 'MultiEdit',
  displayName: '批量编辑',
  kind: ToolKind.Edit,
  schema: MultiEditParamsSchema,

  description: {
    short: '在单个文件中按顺序执行多个字符串替换操作',
    usageNotes: [
      'file_path 必须是绝对路径',
      '编辑操作按数组顺序依次执行，后续编辑基于前面编辑的结果',
      '每个编辑操作的 old_string 必须唯一匹配或使用 replace_all 参数',
      '如果 replace_all 为 false（默认），只替换第一个匹配项',
      '如果 replace_all 为 true，替换所有匹配项',
      '建议先备份重要文件',
      '操作失败的编辑会被跳过，但不影响后续编辑',
    ],
    important: [
      '此操作会直接修改文件内容',
      '编辑操作是有序的，后续编辑会基于前面编辑的结果',
      '如果某个编辑操作找不到匹配内容，该操作会失败',
    ],
    examples: [
      {
        description: '批量替换多个变量名',
        params: {
          file_path: '/path/to/file.ts',
          edits: [
            { old_string: 'oldName1', new_string: 'newName1' },
            { old_string: 'oldName2', new_string: 'newName2' },
          ],
        },
      },
      {
        description: '替换所有匹配项',
        params: {
          file_path: '/path/to/config.json',
          edits: [
            {
              old_string: 'http://localhost',
              new_string: 'https://api.example.com',
              replace_all: true,
            },
          ],
        },
      },
    ],
  },

  version: '1.0.0',
  category: '文件操作',
  tags: ['file', 'edit', 'batch', 'multi', 'replace'],

  async execute(
    params: MultiEditParams,
    context: ExecutionContext
  ): Promise<ToolResult> {
    const { file_path, edits } = params;
    const { signal, updateOutput } = context;

    updateOutput?.('开始读取文件...');

    // 读取文件内容
    let content: string;
    try {
      content = await fs.readFile(file_path, 'utf8');
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error(`文件不存在: ${file_path}`);
      }
      throw error;
    }

    if (signal?.aborted) {
      throw new Error('操作已取消');
    }

    updateOutput?.(`开始执行 ${edits.length} 个编辑操作...`);

    // 按顺序执行编辑操作
    let currentContent = content;
    const operationResults: Array<{
      index: number;
      operation: EditOperation;
      success: boolean;
      matchesFound: number;
      replacementsMade: number;
      error?: string;
    }> = [];

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];

      updateOutput?.(`执行编辑操作 ${i + 1}/${edits.length}...`);

      try {
        const result = applyEdit(currentContent, edit);
        currentContent = result.newContent;

        operationResults.push({
          index: i,
          operation: edit,
          success: true,
          matchesFound: result.matchesFound,
          replacementsMade: result.replacementsMade,
        });

        if (signal?.aborted) {
          throw new Error('操作已取消');
        }
      } catch (error: any) {
        operationResults.push({
          index: i,
          operation: edit,
          success: false,
          matchesFound: 0,
          replacementsMade: 0,
          error: error.message,
        });
      }
    }

    // 写入文件
    updateOutput?.('写入修改后的文件...');
    await fs.writeFile(file_path, currentContent, 'utf8');

    // 验证写入成功
    const stats = await fs.stat(file_path);

    const successfulOperations = operationResults.filter((r) => r.success);
    const totalReplacements = successfulOperations.reduce(
      (sum, r) => sum + r.replacementsMade,
      0
    );

    const failedOperations = edits.length - successfulOperations.length;
    const sizeDiff = currentContent.length - content.length;

    const metadata = {
      file_path,
      total_operations: edits.length,
      successful_operations: successfulOperations.length,
      failed_operations: failedOperations,
      total_replacements: totalReplacements,
      original_size: content.length,
      new_size: currentContent.length,
      size_diff: sizeDiff,
      operation_results: operationResults,
      last_modified: stats.mtime.toISOString(),
    };

    const displayMessage = formatDisplayMessage(file_path, metadata);

    return {
      success: true,
      llmContent: {
        file_path,
        operations_completed: successfulOperations.length,
        total_replacements: totalReplacements,
        operations_failed: failedOperations,
      },
      displayContent: displayMessage,
      metadata,
    };
  },
});

/**
 * 格式化显示消息
 */
function formatDisplayMessage(
  filePath: string,
  metadata: Record<string, unknown>
): string {
  const { successful_operations, failed_operations, total_replacements, size_diff } =
    metadata as {
      successful_operations: number;
      failed_operations: number;
      total_replacements: number;
      size_diff: number;
    };

  let message = `成功批量编辑文件: ${filePath}`;
  message += `\n完成 ${successful_operations} 个编辑操作`;

  if (failed_operations > 0) {
    message += ` (${failed_operations} 个操作失败)`;
  }

  message += `\n总共替换了 ${total_replacements} 处内容`;

  if (size_diff !== 0) {
    const sizeChange =
      size_diff > 0 ? `增加${size_diff}` : `减少${Math.abs(size_diff)}`;
    message += `\n文件大小${sizeChange}个字符`;
  }

  return message;
}

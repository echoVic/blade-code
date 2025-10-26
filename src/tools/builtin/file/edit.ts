import * as Diff from 'diff';
import { promises as fs } from 'fs';
import { extname } from 'path';
import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';
import { FileAccessTracker } from './FileAccessTracker.js';
import { SnapshotManager } from './SnapshotManager.js';

/**
 * EditTool - 文件编辑工具
 * 使用新的 Zod 验证设计
 */
export const editTool = createTool({
  name: 'Edit',
  displayName: '文件编辑',
  kind: ToolKind.Edit,
  strict: true, // 启用 OpenAI Structured Outputs
  isConcurrencySafe: false, // 文件编辑不支持并发

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

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { file_path, old_string, new_string, replace_all } = params;
    const { signal, updateOutput, sessionId, messageId } = context;

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

      // Read-Before-Write 验证（如果有 sessionId）
      // 始终使用宽松模式（仅警告）
      if (sessionId) {
        const tracker = FileAccessTracker.getInstance();

        // 检查文件是否已读取
        if (!tracker.hasFileBeenRead(file_path, sessionId)) {
          console.warn(
            `[EditTool] 警告：文件 ${file_path} 未通过 Read 工具读取`
          );
        }

        // 检查文件是否在读取后被修改
        const modificationCheck = await tracker.checkFileModification(file_path);
        if (modificationCheck.modified) {
          console.warn(`[EditTool] 警告：${modificationCheck.message}`);
        }
      }

      // 创建快照（如果有 sessionId 和 messageId）
      if (sessionId && messageId) {
        try {
          const snapshotManager = new SnapshotManager({ sessionId });
          await snapshotManager.initialize();
          await snapshotManager.createSnapshot(file_path, messageId);
        } catch (error) {
          console.warn('[EditTool] 创建快照失败:', error);
          // 快照失败不中断编辑操作，只记录警告
        }
      }

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

      // 智能匹配并查找匹配项
      const actualString = smartMatch(content, old_string);

      if (!actualString) {
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

      // 使用实际匹配的字符串查找所有位置
      const matches = findMatches(content, old_string);

      // 增强多重匹配警告
      if (matches.length > 1 && !replace_all) {
        // 计算每个匹配项的行号
        const lines = content.split('\n');
        let currentPos = 0;
        const matchLocations: { line: number; column: number }[] = [];

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
          const line = lines[lineNum];
          const lineStart = currentPos;
          const lineEnd = currentPos + line.length;

          // matches 是索引数组
          for (const matchIndex of matches) {
            if (matchIndex >= lineStart && matchIndex < lineEnd) {
              matchLocations.push({
                line: lineNum + 1,
                column: matchIndex - lineStart + 1,
              });
            }
          }

          currentPos = lineEnd + 1; // +1 for newline character
        }

        // 生成警告消息
        const locationsList = matchLocations
          .map((loc) => `行 ${loc.line}:${loc.column}`)
          .join(', ');

        updateOutput?.(
          `⚠️ 警告：找到 ${matches.length} 个匹配项（位于 ${locationsList}），将只替换第一个。` +
            `\n提示：使用 replace_all=true 替换所有匹配项，或提供更多上下文以精确匹配。`
        );
      } else {
        updateOutput?.(`找到 ${matches.length} 个匹配项，开始替换...`);
      }

      // 执行替换（使用实际匹配的字符串）
      let newContent: string;
      let replacedCount: number;

      if (replace_all) {
        // 替换所有匹配项
        newContent = content.split(actualString).join(new_string);
        replacedCount = matches.length;
      } else {
        // 只替换第一个匹配项
        const firstMatchIndex = content.indexOf(actualString);
        newContent =
          content.substring(0, firstMatchIndex) +
          new_string +
          content.substring(firstMatchIndex + actualString.length);
        replacedCount = 1;
      }

      signal.throwIfAborted();

      // 写入文件
      await fs.writeFile(file_path, newContent, 'utf8');

      // 验证写入成功
      const stats = await fs.stat(file_path);

      // 生成差异片段（仅显示第一个替换的上下文）
      const diffSnippet = generateDiffSnippet(
        content,
        newContent,
        actualString,
        new_string,
        4 // 上下文行数
      );

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
        snapshot_created: !!(sessionId && messageId), // 是否创建了快照
        session_id: sessionId,
        message_id: messageId,
        diff_snippet: diffSnippet, // 添加差异片段
      };

      const displayMessage = formatDisplayMessage(metadata, diffSnippet);

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

  /**
   * 提取签名内容：返回文件路径
   */
  extractSignatureContent: (params) => params.file_path,

  /**
   * 抽象权限规则：返回扩展名通配符格式
   */
  abstractPermissionRule: (params) => {
    const ext = extname(params.file_path);
    return ext ? `**/*${ext}` : '**/*';
  },
});

/**
 * 智能引号标准化
 * 将智能引号转换为普通引号
 *
 * @param text 要标准化的文本
 * @returns 标准化后的文本
 */
function normalizeQuotes(text: string): string {
  return text
    .replaceAll('\u2018', "'") // ' → '
    .replaceAll('\u2019', "'") // ' → '
    .replaceAll('\u201c', '"') // " → "
    .replaceAll('\u201d', '"'); // " → "
}

/**
 * 智能匹配字符串
 * 渐进式匹配：先直接匹配，失败后标准化匹配
 *
 * @param content 文件内容
 * @param searchString 要搜索的字符串
 * @returns 匹配的字符串（保留原文件中的实际字符）或 null
 */
function smartMatch(content: string, searchString: string): string | null {
  // 第一步：直接匹配
  if (content.includes(searchString)) {
    return searchString;
  }

  // 第二步：标准化引号后匹配
  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedContent = normalizeQuotes(content);

  const index = normalizedContent.indexOf(normalizedSearch);
  if (index !== -1) {
    // 返回原文件中的实际字符串（保持格式）
    return content.substring(index, index + searchString.length);
  }

  return null;
}

/**
 * 查找所有匹配项的位置
 */
function findMatches(content: string, searchString: string): number[] {
  // 先尝试智能匹配
  const actualString = smartMatch(content, searchString);
  if (!actualString) {
    return []; // 未找到匹配
  }

  // 使用实际匹配的字符串查找所有位置
  const matches: number[] = [];
  let index = content.indexOf(actualString);

  while (index !== -1) {
    matches.push(index);
    index = content.indexOf(actualString, index + 1);
  }

  return matches;
}

/**
 * 生成差异片段（使用 unified diff 格式，显示替换前后的代码上下文）
 */
function generateDiffSnippet(
  oldContent: string,
  newContent: string,
  oldString: string,
  newString: string,
  contextLines: number = 4
): string | null {
  // 找到第一个替换位置
  const firstMatchIndex = oldContent.indexOf(oldString);
  if (firstMatchIndex === -1) return null;

  // 计算替换位置的行号
  const beforeLines = oldContent.substring(0, firstMatchIndex).split('\n');
  const matchLine = beforeLines.length - 1;

  // 分割旧内容和新内容为行数组
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // 计算显示范围（考虑替换可能改变行数）
  const oldStringLines = oldString.split('\n');
  const newStringLines = newString.split('\n');
  const startLine = Math.max(0, matchLine - contextLines);
  const oldEndLine = Math.min(oldLines.length, matchLine + oldStringLines.length + contextLines);
  const newEndLine = Math.min(newLines.length, matchLine + newStringLines.length + contextLines);

  // 提取上下文片段
  const oldSnippet = oldLines.slice(startLine, oldEndLine).join('\n');
  const newSnippet = newLines.slice(startLine, newEndLine).join('\n');

  // 使用 diff 库生成 unified diff
  const patch = Diff.createPatch(
    'file',
    oldSnippet,
    newSnippet,
    '',
    '',
    { context: contextLines }
  );

  // 返回特殊格式，包含 patch 和行号信息
  // 使用特殊分隔符，方便前端识别为 diff 内容
  return `\n<<<DIFF>>>\n${JSON.stringify({
    patch,
    startLine: startLine + 1,
    matchLine: matchLine + 1,
  })}\n<<</DIFF>>>\n`;
}

/**
 * 格式化显示消息
 */
function formatDisplayMessage(
  metadata: Record<string, any>,
  diffSnippet?: string | null
): string {
  const { file_path, matches_found, replacements_made, replace_all, size_diff } =
    metadata;

  let message = `✅ 成功编辑文件: ${file_path}`;
  message += `\n📝 替换了 ${replacements_made} 个匹配项`;

  if (!replace_all && matches_found > 1) {
    message += ` (共找到 ${matches_found} 个匹配项)`;
  }

  if (size_diff !== 0) {
    const sizeChange =
      size_diff > 0 ? `增加${size_diff}` : `减少${Math.abs(size_diff)}`;
    message += `\n📊 文件大小${sizeChange}个字符`;
  }

  // 添加差异片段
  if (diffSnippet) {
    message += diffSnippet;
  }

  return message;
}

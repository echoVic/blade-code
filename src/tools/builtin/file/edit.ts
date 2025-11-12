import { promises as fs } from 'fs';
import { extname } from 'path';
import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';
import { generateDiffSnippetWithMatch } from './diffUtils.js';
import { FileAccessTracker } from './FileAccessTracker.js';
import { SnapshotManager } from './SnapshotManager.js';
import {
  unescapeString,
  flexibleMatch,
  MatchStrategy,
  type MatchResult,
} from './editCorrector.js';

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
    short: '在文件中进行精确的字符串替换',
    long: `Performs exact string replacements in files. Supports replacing a single occurrence or all occurrences with the replace_all parameter.`,
    usageNotes: [
      'You must use your Read tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.',
      'When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.',
      'ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.',
      '**The edit will FAIL if old_string is not unique in the file.** Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.',
      'Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.',
    ],
    examples: [
      {
        description: '替换唯一的字符串',
        params: {
          file_path: '/path/to/file.ts',
          old_string:
            'function calculateTotal(items: Item[]) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}',
          new_string:
            'function calculateTotal(items: Item[]) {\n  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n}',
        },
      },
      {
        description: '使用 replace_all 重命名变量',
        params: {
          file_path: '/path/to/file.ts',
          old_string: 'oldVariableName',
          new_string: 'newVariableName',
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
      '**必须先使用 Read 工具读取文件**，否则编辑会失败',
      '**如果 old_string 不唯一，编辑会失败**。请提供更多上下文或使用 replace_all',
      '从 Read 工具输出复制内容时，确保保留精确的缩进（忽略行号前缀）',
      '替换多行内容时，old_string 必须包含完整的换行符',
      'new_string 和 old_string 不能相同',
    ],
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { file_path, old_string, new_string, replace_all } = params;
    const { updateOutput, sessionId, messageId } = context;
    const signal = context.signal ?? new AbortController().signal;

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

      // Read-Before-Write 验证（对齐 Claude Code 官方：强制模式）
      if (sessionId) {
        const tracker = FileAccessTracker.getInstance();

        // 检查文件是否已读取（强制失败）
        if (!tracker.hasFileBeenRead(file_path, sessionId)) {
          return {
            success: false,
            llmContent: `You must use your Read tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.`,
            displayContent: `❌ 编辑失败：必须先使用 Read 工具读取文件\n\n请先用 Read 工具查看文件内容，再进行编辑。`,
            error: {
              type: ToolErrorType.VALIDATION_ERROR,
              message: 'File not read before edit',
            },
          };
        }

        // 🔴 检查文件是否被外部程序修改
        const externalModCheck = await tracker.checkExternalModification(file_path);
        if (externalModCheck.isExternal) {
          return {
            success: false,
            llmContent: `The file has been modified by an external program since you last read it. You must use the Read tool again to see the current content before editing.\n\nDetails: ${externalModCheck.message}`,
            displayContent: `❌ 编辑失败：文件已被外部程序修改\n\n${externalModCheck.message}\n\n💡 请重新使用 Read 工具读取最新内容后再编辑`,
            error: {
              type: ToolErrorType.VALIDATION_ERROR,
              message: 'File modified externally',
              details: { externalModification: externalModCheck.message },
            },
          };
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
      const matchResult = smartMatch(content, old_string);

      if (!matchResult.matched) {
        // 🔥 生成富文本错误信息,帮助 LLM 快速恢复
        const errorDetails = generateRichErrorMessage(content, old_string, file_path);

        return {
          success: false,
          llmContent: errorDetails.llmContent,
          displayContent: errorDetails.displayContent,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '未找到匹配内容',
            details: errorDetails.metadata,
          },
        };
      }

      const actualString = matchResult.matched;

      // 记录使用的匹配策略（用于调试和优化）
      if (matchResult.strategy !== MatchStrategy.EXACT) {
        console.log(`[SmartEdit] 使用策略: ${matchResult.strategy}`);
      }

      // 使用实际匹配的字符串查找所有位置
      const matches = findMatches(content, old_string);

      // 🔴 对齐 Claude Code 官方：多重匹配时直接失败
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

        // 生成位置列表
        const locationsList = matchLocations
          .map((loc) => `行 ${loc.line}:${loc.column}`)
          .join(', ');

        // 直接失败（对齐 Claude Code 官方行为）
        return {
          success: false,
          llmContent: `The edit will FAIL if old_string is not unique in the file. Found ${matches.length} matches at: ${locationsList}. Either provide a larger string with more surrounding context to make it unique or use replace_all=true.`,
          displayContent: `❌ 编辑失败：old_string 不唯一\n\n找到 ${matches.length} 个匹配项:\n${locationsList}\n\n💡 解决方案:\n1. 提供更多周围代码以确保唯一性\n2. 或使用 replace_all=true 替换所有匹配项`,
          error: {
            type: ToolErrorType.VALIDATION_ERROR,
            message: 'old_string is not unique',
            details: { matches: matchLocations, count: matches.length },
          },
        };
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

      // 🔴 更新文件访问记录（记录编辑操作）
      if (sessionId) {
        const tracker = FileAccessTracker.getInstance();
        await tracker.recordFileEdit(file_path, sessionId, 'edit');
      }

      // 验证写入成功
      const stats = await fs.stat(file_path);

      // 生成差异片段（仅显示第一个替换的上下文）
      const diffSnippet = generateDiffSnippetWithMatch(
        content,
        newContent,
        actualString,
        new_string,
        4 // 上下文行数
      );

      // 生成 summary 用于流式显示
      const fileName = file_path.split('/').pop() || file_path;
      const summary =
        replacedCount === 1
          ? `替换 1 处匹配到 ${fileName}`
          : `替换 ${replacedCount} 处匹配到 ${fileName}`;

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
        summary, // 🆕 流式显示摘要
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
 * 渐进式匹配：依次尝试多种策略
 *
 * @param content 文件内容
 * @param searchString 要搜索的字符串
 * @returns { matched: string | null, strategy: MatchStrategy }
 */
function smartMatch(content: string, searchString: string): MatchResult {
  // 策略 1: 精确匹配
  if (content.includes(searchString)) {
    return { matched: searchString, strategy: MatchStrategy.EXACT };
  }

  // 策略 2: 标准化引号后匹配
  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedContent = normalizeQuotes(content);

  const quoteIndex = normalizedContent.indexOf(normalizedSearch);
  if (quoteIndex !== -1) {
    // 返回原文件中的实际字符串（保持格式）
    const actualString = content.substring(quoteIndex, quoteIndex + searchString.length);
    return { matched: actualString, strategy: MatchStrategy.NORMALIZE_QUOTES };
  }

  // 策略 3: 反转义后匹配
  const unescaped = unescapeString(searchString);
  if (unescaped !== searchString && content.includes(unescaped)) {
    return { matched: unescaped, strategy: MatchStrategy.UNESCAPE };
  }

  // 策略 4: 弹性缩进匹配
  const flexible = flexibleMatch(content, searchString);
  if (flexible) {
    return { matched: flexible, strategy: MatchStrategy.FLEXIBLE };
  }

  // 所有策略都失败
  return { matched: null, strategy: MatchStrategy.FAILED };
}

/**
 * 查找所有匹配项的位置
 */
function findMatches(content: string, searchString: string): number[] {
  // 先尝试智能匹配
  const matchResult = smartMatch(content, searchString);
  if (!matchResult.matched) {
    return []; // 未找到匹配
  }

  const actualString = matchResult.matched;

  // 使用实际匹配的字符串查找所有位置
  const matches: number[] = [];
  let index = content.indexOf(actualString);

  while (index !== -1) {
    matches.push(index);
    index = content.indexOf(actualString, index + 1);
  }

  return matches;
}

// diff 生成函数已移动到 diffUtils.ts，供 Edit 和 Write 工具共享

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

/**
 * 生成富文本错误信息
 * 当 Edit 工具匹配失败时,提供详细的上下文和恢复建议
 */
function generateRichErrorMessage(
  fileContent: string,
  searchString: string,
  filePath: string
): {
  llmContent: string;
  displayContent: string;
  metadata: Record<string, any>;
} {
  const lines = fileContent.split('\n');
  const totalLines = lines.length;

  // 1. 计算搜索字符串的预期位置(基于模糊匹配)
  const fuzzyMatches = findFuzzyMatches(fileContent, searchString, 3);

  // 2. 提取文件摘录(显示前后各10行)
  let excerptStartLine = 0;
  let excerptEndLine = Math.min(20, totalLines);

  // 如果找到模糊匹配,以最佳匹配为中心
  if (fuzzyMatches.length > 0) {
    const bestMatch = fuzzyMatches[0];
    excerptStartLine = Math.max(0, bestMatch.lineNumber - 10);
    excerptEndLine = Math.min(totalLines, bestMatch.lineNumber + 10);
  }

  const excerptLines = lines.slice(excerptStartLine, excerptEndLine);
  const excerpt = excerptLines
    .map((line, idx) => {
      const lineNum = excerptStartLine + idx + 1;
      return `    ${lineNum.toString().padStart(4)}: ${line}`;
    })
    .join('\n');

  // 3. 生成 LLM 可读的错误信息
  let llmContent = `String not found in file.

File: ${filePath}
Total lines: ${totalLines}

`;

  // 显示搜索字符串(截断长文本)
  const searchPreview =
    searchString.length > 300
      ? searchString.substring(0, 300) + '\n... (truncated)'
      : searchString;

  llmContent += `You tried to match:\n${searchPreview}\n\n`;

  // 显示文件摘录
  if (fuzzyMatches.length > 0) {
    llmContent += `File content around possible matches (lines ${excerptStartLine + 1}-${excerptEndLine}):\n${excerpt}\n\n`;
  } else {
    llmContent += `File content preview (lines ${excerptStartLine + 1}-${excerptEndLine}):\n${excerpt}\n\n`;
  }

  // 显示模糊匹配建议
  if (fuzzyMatches.length > 0) {
    llmContent += `Possible similar matches found:\n`;
    fuzzyMatches.forEach((match, idx) => {
      const preview =
        match.text.length > 100 ? match.text.substring(0, 100) + '...' : match.text;
      llmContent += `  ${idx + 1}. Line ${match.lineNumber} (similarity: ${Math.round(match.similarity * 100)}%)\n     ${preview.replace(/\n/g, '\\n')}\n`;
    });
    llmContent += '\n';
  }

  // 提供恢复建议
  llmContent += `Recovery suggestions:
1. Use the Read tool to verify the current file content
2. Check for typos, whitespace differences, or quote mismatches
3. Provide more surrounding context to make the match unique
4. If the code structure is different than expected, consider using the Write tool instead

Common issues:
- Line breaks: Ensure \\n characters match exactly
- Indentation: Spaces vs tabs mismatch
- Smart quotes: " " vs " (use straight quotes)
- Outdated mental model: File may have changed since you last read it`;

  // 4. 生成用户可读的显示信息
  let displayContent = `❌ Edit 失败: 未找到匹配的字符串

文件: ${filePath}
搜索字符串长度: ${searchString.length} 字符
`;

  if (fuzzyMatches.length > 0) {
    displayContent += `\n💡 找到 ${fuzzyMatches.length} 个相似匹配项:\n`;
    fuzzyMatches.forEach((match, idx) => {
      displayContent += `  ${idx + 1}. 第 ${match.lineNumber} 行 (相似度: ${Math.round(match.similarity * 100)}%)\n`;
    });
  } else {
    displayContent += '\n⚠️ 未找到相似的匹配项\n';
  }

  displayContent += `\n📄 文件内容摘录 (${excerptStartLine + 1}-${excerptEndLine} 行):\n${excerpt}\n`;
  displayContent += `\n🔧 建议:\n`;
  displayContent += `  1. 使用 Read 工具重新读取文件\n`;
  displayContent += `  2. 检查空格、换行符、引号是否完全匹配\n`;
  displayContent += `  3. 提供更多上下文代码确保唯一性`;

  return {
    llmContent,
    displayContent,
    metadata: {
      searchStringLength: searchString.length,
      fuzzyMatches: fuzzyMatches.map((m) => ({
        line: m.lineNumber,
        similarity: m.similarity,
        preview: m.text.substring(0, 100),
      })),
      excerptRange: [excerptStartLine + 1, excerptEndLine],
      totalLines,
    },
  };
}

/**
 * 查找模糊匹配项
 * 使用 Levenshtein 距离计算相似度
 */
function findFuzzyMatches(
  fileContent: string,
  searchString: string,
  maxResults: number = 3
): Array<{ text: string; lineNumber: number; similarity: number }> {
  const lines = fileContent.split('\n');
  const searchLines = searchString.split('\n');

  // 如果搜索字符串是单行,按行匹配
  if (searchLines.length === 1) {
    const matches = lines
      .map((line, idx) => ({
        text: line,
        lineNumber: idx + 1,
        similarity: calculateSimilarity(searchString.trim(), line.trim()),
      }))
      .filter((m) => m.similarity > 0.5) // 相似度阈值
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, maxResults);

    return matches;
  }

  // 如果搜索字符串是多行,按窗口匹配
  const windowSize = searchLines.length;
  const matches: Array<{ text: string; lineNumber: number; similarity: number }> = [];

  for (let i = 0; i <= lines.length - windowSize; i++) {
    const window = lines.slice(i, i + windowSize).join('\n');
    const similarity = calculateSimilarity(searchString, window);

    if (similarity > 0.5) {
      matches.push({
        text: window,
        lineNumber: i + 1,
        similarity,
      });
    }
  }

  return matches.sort((a, b) => b.similarity - a.similarity).slice(0, maxResults);
}

/**
 * 计算两个字符串的相似度(简化版 Levenshtein)
 * 返回 0-1 之间的值,1 表示完全相同
 */
function calculateSimilarity(str1: string, str2: string): number {
  // 标准化:移除多余空格,统一引号
  const normalize = (s: string) =>
    s
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[""]/g, '"')
      .replace(/['']/g, "'");

  const s1 = normalize(str1);
  const s2 = normalize(str2);

  if (s1 === s2) return 1.0;

  // 计算 Levenshtein 距离
  const len1 = s1.length;
  const len2 = s2.length;

  if (len1 === 0) return len2 === 0 ? 1.0 : 0.0;
  if (len2 === 0) return 0.0;

  // 使用简化算法:只计算前 200 个字符(性能优化)
  const maxLen = 200;
  const substr1 = s1.substring(0, maxLen);
  const substr2 = s2.substring(0, maxLen);

  const distance = levenshteinDistance(substr1, substr2);
  const maxLength = Math.max(substr1.length, substr2.length);

  return 1 - distance / maxLength;
}

/**
 * Levenshtein 距离算法
 */
function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;

  // 创建距离矩阵
  const matrix: number[][] = Array(len1 + 1)
    .fill(null)
    .map(() => Array(len2 + 1).fill(0));

  // 初始化第一行和第一列
  for (let i = 0; i <= len1; i++) matrix[i][0] = i;
  for (let j = 0; j <= len2; j++) matrix[0][j] = j;

  // 填充矩阵
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1, // 删除
        matrix[i][j - 1] + 1, // 插入
        matrix[i - 1][j - 1] + cost // 替换
      );
    }
  }

  return matrix[len1][len2];
}

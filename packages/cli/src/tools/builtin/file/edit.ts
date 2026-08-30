import { basename, extname } from 'path';
import {
  ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
  AcpRemoteFileBoundaryError,
} from '../../../acp/AcpFileRequestCoordinator.js';
import {
  AcpFileSystemCapabilityError,
  AcpFileSystemService,
} from '../../../acp/AcpFileSystemService.js';
import {
  getAcpFileSystemService,
  isAcpMode,
  isAcpRemoteFileSystem,
} from '../../../acp/AcpServiceContext.js';
import {
  AcpRemoteMutationError,
  commitVerifiedRemoteTextMutation,
} from '../../../acp/RemoteTextMutation.js';
import { Default, Type } from '../../../schema/index.js';
import { getFileSystemService } from '../../../services/FileSystemService.js';
import { createTool } from '../../core/createTool.js';
import type {
  EditErrorMetadata,
  EditMetadata,
  ExecutionContext,
  NodeError,
  ToolResult,
} from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/toolSchemas.js';
import { generateDiffSnippetWithMatch } from './diffUtils.js';
import {
  blockAnchorMatch,
  flexibleMatch,
  lineTrimMatch,
  type MatchResult,
  MatchStrategy,
  unescapeString,
  whitespaceNormalizeMatch,
} from './editCorrector.js';
import { FileAccessTracker } from './FileAccessTracker.js';
import { SnapshotManager, type SnapshotMetadata } from './SnapshotManager.js';

/**
 * EditTool - File edit tool
 * Uses the TypeBox validation design
 */
export const editTool = createTool({
  name: 'Edit',
  displayName: 'File Edit',
  kind: ToolKind.Write,
  strict: true, // 启用 OpenAI Structured Outputs
  isConcurrencySafe: false, // 文件编辑不支持并发
  parallelism: 'shared', // 不同路径并行；同路径由 FileLockManager 串行
  affectedPaths: (params) => [params.file_path],

  schema: Type.Object({
    file_path: ToolSchemas.filePath({
      description: 'Absolute path of the file to edit',
    }),
    old_string: Type.String({
      minLength: 1,
      description: 'String to replace',
    }),
    new_string: Type.String({
      description: 'Replacement string (can be empty)',
    }),
    replace_all: Default(
      Type.Boolean({
        description: 'Replace all matches (default: first only)',
      }),
      false
    ),
  }),

  // 工具描述（对齐 Claude Code 官方）
  description: {
    short: 'Performs exact string replacements in files',
    long: `Performs exact string replacements in files.`,
    usageNotes: [
      'You must use your Read tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.',
      'When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.',
      'ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.',
      'Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.',
      'The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.',
      'Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.',
    ],
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { file_path, old_string, new_string, replace_all } = params;
    const { updateOutput, sessionId, messageId } = context;
    const signal = context.signal ?? new AbortController().signal;

    try {
      updateOutput?.('Starting to read file...');

      // 获取文件系统服务（ACP 或本地）
      const useAcp = isAcpMode(sessionId);
      const remoteFileSystem = isAcpRemoteFileSystem(sessionId);
      const fsService = useAcp
        ? getAcpFileSystemService(sessionId)
        : getFileSystemService();

      if (remoteFileSystem) {
        if (!(fsService instanceof AcpFileSystemService)) {
          return {
            success: false,
            llmContent: 'File edit failed: internal ACP remote filesystem mismatch',
            error: {
              type: ToolErrorType.EXECUTION_ERROR,
              message: 'ACP remote filesystem mismatch',
            },
            metadata: {
              file_path,
              sideEffectsUncertain: false,
            },
          };
        }
        return executeRemoteEdit(
          fsService,
          {
            file_path,
            old_string,
            new_string,
            replace_all,
          },
          signal,
          updateOutput
        );
      }

      // 读取文件内容（统一使用 FileSystemService）
      let content: string;
      try {
        if (useAcp) {
          updateOutput?.('通过 IDE 读取文件...');
        }
        content = await fsService.readTextFile(file_path);
      } catch (error) {
        const nodeError = error as NodeError;
        if (nodeError.code === 'ENOENT' || nodeError.message?.includes('not found')) {
          return {
            success: false,
            llmContent: `File not found: ${file_path}`,
            error: {
              type: ToolErrorType.EXECUTION_ERROR,
              message: `文件不存在`,
            },
          };
        }
        throw error;
      }

      if (typeof signal.throwIfAborted === 'function') {
        signal.throwIfAborted();
      }

      // Read-Before-Write 验证（对齐 Claude Code 官方：强制模式）
      if (sessionId) {
        const tracker = FileAccessTracker.getInstance();

        // 检查文件是否已读取（强制失败）
        if (!tracker.hasFileBeenRead(file_path, sessionId)) {
          return {
            success: false,
            llmContent: `You must use your Read tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.`,
            error: {
              type: ToolErrorType.VALIDATION_ERROR,
              message: 'File not read before edit',
            },
            metadata: {
              requiresRead: true,
            },
          };
        }

        // 检查文件是否被外部程序修改
        const externalModCheck = await tracker.checkExternalModification(
          file_path,
          sessionId
        );
        if (externalModCheck.isExternal) {
          return {
            success: false,
            llmContent: `The file has been modified by an external program since you last read it. You must use the Read tool again to see the current content before editing.\n\nDetails: ${externalModCheck.message}`,
            error: {
              type: ToolErrorType.VALIDATION_ERROR,
              message: 'File modified externally',
              details: { externalModification: externalModCheck.message },
            },
          };
        }
      }

      // 验证字符串不能相同
      if (old_string === new_string) {
        return {
          success: false,
          llmContent: 'New string is identical; no replacement needed',
          error: {
            type: ToolErrorType.VALIDATION_ERROR,
            message: '新旧字符串相同',
          },
        };
      }

      // 智能匹配并查找匹配项
      const matchResult = smartMatch(content, old_string);

      if (!matchResult.matched) {
        // 生成富文本错误信息,帮助 LLM 快速恢复
        const errorDetails = generateRichErrorMessage(content, old_string, file_path);

        return {
          success: false,
          llmContent: errorDetails.llmContent,
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

      // 使用实际匹配的字符串查找所有位置（传入已匹配的字符串，避免重复 smartMatch）
      const matches = findMatchesWithActual(content, actualString);

      // 对齐 Claude Code 官方：多重匹配时直接失败
      if (matches.length > 1 && !replace_all) {
        // 计算每个匹配项的行号和上下文预览
        const lines = content.split('\n');
        let currentPos = 0;
        const matchLocations: { line: number; column: number; context: string }[] = [];

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
          const line = lines[lineNum];
          const lineStart = currentPos;
          const lineEnd = currentPos + line.length;

          // matches 是索引数组
          for (const matchIndex of matches) {
            if (matchIndex >= lineStart && matchIndex < lineEnd) {
              // 获取周围1行作为上下文预览
              const contextStart = Math.max(0, lineNum - 1);
              const contextEnd = Math.min(lines.length - 1, lineNum + 1);
              const contextLines = lines.slice(contextStart, contextEnd + 1);
              const contextPreview = contextLines
                .map((l) => l.trim())
                .join(' ')
                .slice(0, 80); // 限制长度

              matchLocations.push({
                line: lineNum + 1,
                column: matchIndex - lineStart + 1,
                context: contextPreview,
              });
            }
          }

          currentPos = lineEnd + 1; // +1 for newline character
        }

        // LLM 友好的错误消息（引导性、鼓励重试）
        const llmMessage = [
          `[WARN] EDIT PAUSED: old_string matches ${matches.length} locations (must be unique).`,
          ``,
          `**Matches found at:**`,
          ...matchLocations.map((loc, idx) => ` ${idx + 1}. Line ${loc.line}`),
          ``,
          `**Action Required:** Add 3-5 lines of surrounding context to make old_string unique.`,
          ``,
          `**Tips for quick success:**`,
          `• Include the function/class name that wraps the target code`,
          `• Add 2-3 lines before and after the target`,
          `• Include unique comments or variable names nearby`,
          `• Or use replace_all=true to change all ${matches.length} occurrences`,
          ``,
          `**Auto-retry expected** - This usually resolves in 1-2 attempts.`,
        ].join('\n');

        // 直接失败（对齐 Claude Code 官方行为）
        return {
          success: false,
          llmContent: llmMessage,
          error: {
            type: ToolErrorType.VALIDATION_ERROR,
            message: 'old_string is not unique',
            details: {
              matches: matchLocations.map((loc) => ({
                line: loc.line,
                column: loc.column,
              })),
              count: matches.length,
            },
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

      if (typeof signal.throwIfAborted === 'function') {
        signal.throwIfAborted();
      }

      let snapshotManager: SnapshotManager | undefined;
      let snapshotMetadata: SnapshotMetadata | undefined;
      let snapshotCreated = false;
      if (!useAcp && sessionId && messageId) {
        try {
          snapshotManager = new SnapshotManager({
            sessionId,
            workspaceRoot: context.workspaceRoot,
          });
          await snapshotManager.initialize();
          snapshotMetadata = await snapshotManager.createSnapshot(file_path, messageId);
        } catch (error) {
          console.warn('[EditTool] 创建快照失败:', error);
          snapshotManager = undefined;
          snapshotMetadata = undefined;
        }
      }

      // 写入文件（统一使用 FileSystemService）
      if (useAcp) {
        updateOutput?.('通过 IDE 写入文件...');
      }
      try {
        await fsService.writeTextFile(file_path, newContent);
      } catch (error) {
        if (snapshotManager && snapshotMetadata) {
          await snapshotManager
            .discardSnapshot(file_path, snapshotMetadata)
            .catch((cleanupError) =>
              console.warn('[EditTool] 丢弃未完成快照失败:', cleanupError)
            );
        }
        throw error;
      }

      if (snapshotManager && snapshotMetadata) {
        try {
          await snapshotManager.recordPostEditState(file_path, snapshotMetadata);
          snapshotCreated = true;
        } catch (error) {
          console.warn('[EditTool] 完成快照失败:', error);
          await snapshotManager
            .discardSnapshot(file_path, snapshotMetadata)
            .catch((cleanupError) =>
              console.warn('[EditTool] 丢弃未完成快照失败:', cleanupError)
            );
        }
      }

      // 更新文件访问记录（记录编辑操作）
      if (sessionId) {
        const tracker = FileAccessTracker.getInstance();
        await tracker.recordFileEdit(file_path, sessionId, 'edit');
      }

      // 验证写入成功（统一使用 FileSystemService）
      const stats = await fsService.stat(file_path);

      // 生成差异片段（仅显示第一个替换的上下文）
      const diffSnippet = generateDiffSnippetWithMatch(
        content,
        newContent,
        actualString,
        new_string,
        4 // 上下文行数
      );

      // 生成 summary 用于流式显示
      const fileName = basename(file_path);
      const summary =
        replacedCount === 1
          ? `替换 1 处匹配到 ${fileName}`
          : `替换 ${replacedCount} 处匹配到 ${fileName}`;

      const metadata: EditMetadata = {
        file_path,
        matches_found: matches.length,
        replacements_made: replacedCount,
        replace_all,
        old_string_length: old_string.length,
        new_string_length: new_string.length,
        original_size: content.length,
        new_size: newContent.length,
        size_diff: newContent.length - content.length,
        last_modified:
          stats?.mtime instanceof Date ? stats.mtime.toISOString() : undefined,
        snapshot_created: snapshotCreated,
        session_id: sessionId,
        message_id: messageId,
        diff_snippet: diffSnippet,
        summary,
        kind: 'edit',
        oldContent: content,
        newContent: newContent,
      };

      return {
        success: true,
        llmContent: diffSnippet
          ? `Edited ${file_path} (${replacedCount} replacement${replacedCount > 1 ? 's' : ''}):\n${diffSnippet}`
          : `Edited ${file_path} (${replacedCount} replacement${replacedCount > 1 ? 's' : ''})`,
        metadata,
      };
    } catch (error) {
      const nodeError = error as NodeError;
      if (nodeError.name === 'AbortError') {
        return {
          success: false,
          llmContent: 'File edit aborted',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
        };
      }

      return {
        success: false,
        llmContent: `File edit failed: ${nodeError.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: nodeError.message,
          details: nodeError,
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
    .replaceAll('\u2018', "'") // ' -> '
    .replaceAll('\u2019', "'") // ' -> '
    .replaceAll('\u201c', '"') // " -> "
    .replaceAll('\u201d', '"'); // " -> "
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

  // 策略 2: 行尾空白修剪匹配
  const lineTrimmed = lineTrimMatch(content, searchString);
  if (lineTrimmed) {
    return { matched: lineTrimmed, strategy: MatchStrategy.LINE_TRIM };
  }

  // 策略 3: 标准化引号后匹配
  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedContent = normalizeQuotes(content);

  const quoteIndex = normalizedContent.indexOf(normalizedSearch);
  if (quoteIndex !== -1) {
    const actualString = content.substring(
      quoteIndex,
      quoteIndex + searchString.length
    );
    return { matched: actualString, strategy: MatchStrategy.NORMALIZE_QUOTES };
  }

  // 策略 4: 反转义后匹配
  const unescaped = unescapeString(searchString);
  if (unescaped !== searchString && content.includes(unescaped)) {
    return { matched: unescaped, strategy: MatchStrategy.UNESCAPE };
  }

  // 策略 5: 空白归一化匹配
  const wsNormalized = whitespaceNormalizeMatch(content, searchString);
  if (wsNormalized) {
    return { matched: wsNormalized, strategy: MatchStrategy.WHITESPACE_NORMALIZE };
  }

  // 策略 6: 弹性缩进匹配
  const flexible = flexibleMatch(content, searchString);
  if (flexible) {
    return { matched: flexible, strategy: MatchStrategy.FLEXIBLE };
  }

  // 策略 7: 块锚点匹配（首尾行精确 + 中间行相似度）
  const blockAnchored = blockAnchorMatch(content, searchString);
  if (blockAnchored) {
    return { matched: blockAnchored, strategy: MatchStrategy.BLOCK_ANCHOR };
  }

  // 所有策略都失败
  return { matched: null, strategy: MatchStrategy.FAILED };
}

/**
 * 查找所有匹配项的位置（非重叠匹配）
 * 与实际替换方式保持一致：split/join 或 substring 都是非重叠的
 *
 * 示例：
 * - content = 'aaaa', searchString = 'aa'
 * - 重叠匹配会找到 3 个：位置 0, 1, 2
 * - 非重叠匹配只找到 2 个：位置 0, 2（与 split/join 一致）
 */
function _findMatches(content: string, searchString: string): number[] {
  // 先尝试智能匹配
  const matchResult = smartMatch(content, searchString);
  if (!matchResult.matched) {
    return []; // 未找到匹配
  }

  return findMatchesWithActual(content, matchResult.matched);
}

/**
 * 使用已知的匹配字符串查找所有位置（避免重复 smartMatch）
 * 内部辅助函数，用于优化性能
 */
function findMatchesWithActual(content: string, actualString: string): number[] {
  // 防御性检查：空字符串会导致死循环
  if (actualString.length === 0) {
    return [];
  }

  // 使用非重叠匹配：每次找到后跳过整个匹配长度
  // 这与 split/join 和 substring 替换方式一致
  const matches: number[] = [];
  let index = content.indexOf(actualString);

  while (index !== -1) {
    matches.push(index);
    // 跳过整个匹配长度，避免重叠（对齐实际替换行为）
    index = content.indexOf(actualString, index + actualString.length);
  }

  return matches;
}

// diff 生成函数已移动到 diffUtils.ts，供 Edit 和 Write 工具共享

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
  metadata: EditErrorMetadata;
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
      return ` ${lineNum.toString().padStart(4)}: ${line}`;
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
      llmContent += ` ${idx + 1}. Line ${match.lineNumber} (similarity: ${Math.round(match.similarity * 100)}%)\n ${preview.replace(/\n/g, '\\n')}\n`;
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

  return {
    llmContent,
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

async function executeRemoteEdit(
  fsService: AcpFileSystemService,
  params: {
    file_path: string;
    old_string: string;
    new_string: string;
    replace_all: boolean;
  },
  signal: AbortSignal,
  updateOutput?: (content: string) => void
): Promise<ToolResult> {
  const { file_path, old_string, new_string, replace_all } = params;
  const deadlineAt = Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS;
  const stableMetadata = {
    file_path,
    sideEffectsUncertain: false,
  } satisfies Pick<EditMetadata, 'file_path' | 'sideEffectsUncertain'>;

  try {
    fsService.assertTextMutationCapabilities();
  } catch (error) {
    if (error instanceof AcpFileSystemCapabilityError) {
      return {
        success: false,
        llmContent: `ACP remote Edit requires ${error.operation} capability.`,
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: `ACP remote filesystem does not support ${error.operation}`,
        },
        metadata: stableMetadata,
      };
    }
    throw error;
  }

  signal.throwIfAborted?.();
  const requiresReadBoundary = (error: unknown): boolean =>
    error instanceof AcpRemoteFileBoundaryError &&
    Boolean(
      (error as AcpRemoteFileBoundaryError & { requiresRead?: boolean }).requiresRead
    );
  let lease: ReturnType<AcpFileSystemService['tryAcquireMutationLease']>;
  try {
    lease = fsService.tryAcquireMutationLease([file_path]);
  } catch (error) {
    if (requiresReadBoundary(error)) {
      return {
        success: false,
        llmContent:
          'Remote file state is uncertain for this path. Use Read on the same file to refresh remote state before retrying Edit.',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: 'Remote file state requires a fresh Read before mutation',
        },
        metadata: {
          file_path,
          write_acknowledged: false,
          write_verified: false,
          sideEffectsUncertain: true,
          requiresRead: true,
        },
      };
    }
    if (error instanceof AcpRemoteFileBoundaryError && error.reason === 'busy') {
      return {
        success: false,
        llmContent:
          'Remote file is busy with another in-flight mutation. Wait for it to settle before retrying Edit.',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: 'Remote file is busy',
        },
        metadata: stableMetadata,
      };
    }
    throw error;
  }
  let previous:
    | Awaited<ReturnType<AcpFileSystemService['readTextFileIfExists']>>
    | undefined;
  try {
    previous = await fsService.readTextFileIfExists(file_path, {
      signal,
      deadlineAt,
      purpose: 'preflight',
      lease,
    });
  } catch {
    lease.release();
    return {
      success: false,
      llmContent: 'File edit failed: Unable to read remote file before edit',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'Unable to read remote file before edit',
      },
      metadata: stableMetadata,
    };
  }
  if (!previous.exists) {
    lease.release();
    return {
      success: false,
      llmContent: `File not found: ${file_path}`,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: '文件不存在',
      },
      metadata: stableMetadata,
    };
  }

  const accessStatus = fsService.checkRemoteAccess(file_path, previous.content);
  if (accessStatus === 'missing') {
    lease.release();
    return {
      success: false,
      llmContent:
        'You must use your Read tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.',
      error: {
        type: ToolErrorType.VALIDATION_ERROR,
        message: 'File not read before edit',
      },
      metadata: {
        ...stableMetadata,
        requiresRead: true,
      },
    };
  }

  if (accessStatus === 'modified') {
    lease.release();
    return {
      success: false,
      llmContent:
        'The file has been modified externally since the last successful Read. Use Read again before editing.',
      error: {
        type: ToolErrorType.VALIDATION_ERROR,
        message: 'File modified externally',
      },
      metadata: stableMetadata,
    };
  }

  if (old_string === new_string) {
    lease.release();
    return {
      success: false,
      llmContent: 'New string is identical; no replacement needed',
      error: {
        type: ToolErrorType.VALIDATION_ERROR,
        message: '新旧字符串相同',
      },
      metadata: stableMetadata,
    };
  }

  const content = previous.content;
  const matchResult = smartMatch(content, old_string);
  if (!matchResult.matched) {
    lease.release();
    const errorDetails = generateRichErrorMessage(content, old_string, file_path);
    return {
      success: false,
      llmContent: errorDetails.llmContent,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: '未找到匹配内容',
        details: errorDetails.metadata,
      },
      metadata: stableMetadata,
    };
  }

  const actualString = matchResult.matched;
  const matches = findMatchesWithActual(content, actualString);
  if (matches.length > 1 && !replace_all) {
    lease.release();
    const lines = content.split('\n');
    let currentPos = 0;
    const matchLocations: { line: number; column: number; context: string }[] = [];

    for (let lineNum = 0; lineNum < lines.length; lineNum += 1) {
      const line = lines[lineNum];
      const lineStart = currentPos;
      const lineEnd = currentPos + line.length;
      for (const matchIndex of matches) {
        if (matchIndex >= lineStart && matchIndex < lineEnd) {
          const contextStart = Math.max(0, lineNum - 1);
          const contextEnd = Math.min(lines.length - 1, lineNum + 1);
          const contextPreview = lines
            .slice(contextStart, contextEnd + 1)
            .map((value) => value.trim())
            .join(' ')
            .slice(0, 80);
          matchLocations.push({
            line: lineNum + 1,
            column: matchIndex - lineStart + 1,
            context: contextPreview,
          });
        }
      }
      currentPos = lineEnd + 1;
    }

    return {
      success: false,
      llmContent: [
        `[WARN] EDIT PAUSED: old_string matches ${matches.length} locations (must be unique).`,
        '',
        '**Matches found at:**',
        ...matchLocations.map((loc, index) => ` ${index + 1}. Line ${loc.line}`),
        '',
        '**Action Required:** Add 3-5 lines of surrounding context to make old_string unique.',
      ].join('\n'),
      error: {
        type: ToolErrorType.VALIDATION_ERROR,
        message: 'old_string is not unique',
        details: {
          matches: matchLocations.map((loc) => ({
            line: loc.line,
            column: loc.column,
          })),
          count: matches.length,
        },
      },
      metadata: stableMetadata,
    };
  }

  let newContent: string;
  let replacedCount: number;
  if (replace_all) {
    newContent = content.split(actualString).join(new_string);
    replacedCount = matches.length;
  } else {
    const firstMatchIndex = content.indexOf(actualString);
    newContent =
      content.substring(0, firstMatchIndex) +
      new_string +
      content.substring(firstMatchIndex + actualString.length);
    replacedCount = 1;
  }

  updateOutput?.('通过 IDE 写入文件...');
  try {
    const receipt = await commitVerifiedRemoteTextMutation({
      service: fsService,
      lease,
      filePath: file_path,
      previous,
      intendedContent: newContent,
      operation: 'edit',
      signal,
      deadlineAt,
    });
    if (receipt.writeVerified) {
      lease.commitVerified();
    }
    const diffSnippet = generateDiffSnippetWithMatch(
      content,
      newContent,
      actualString,
      new_string,
      4
    );
    const metadata: EditMetadata = {
      file_path,
      matches_found: matches.length,
      replacements_made: replacedCount,
      replace_all,
      old_string_length: old_string.length,
      new_string_length: new_string.length,
      original_size: content.length,
      new_size: newContent.length,
      size_diff: newContent.length - content.length,
      snapshot_created: false,
      diff_snippet: diffSnippet,
      summary:
        replacedCount === 1
          ? `替换 1 处匹配到 ${basename(file_path)}`
          : `替换 ${replacedCount} 处匹配到 ${basename(file_path)}`,
      kind: 'edit',
      oldContent: content,
      newContent,
      write_acknowledged: receipt.writeAcknowledged,
      write_verified: receipt.writeVerified,
      sideEffectsUncertain: receipt.sideEffectsUncertain,
      requiresRead: receipt.requiresRead || undefined,
    };

    return {
      success: true,
      llmContent: diffSnippet
        ? `Edited ${file_path} (${replacedCount} replacement${replacedCount > 1 ? 's' : ''}):\n${diffSnippet}`
        : `Edited ${file_path} (${replacedCount} replacement${replacedCount > 1 ? 's' : ''})`,
      metadata,
    };
  } catch (error) {
    if (error instanceof AcpRemoteMutationError && error.requiresRead) {
      return {
        success: false,
        llmContent:
          'Remote file state is uncertain for this path. Use Read on the same file to refresh remote state before retrying Edit.',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: 'Remote file state requires a fresh Read before mutation',
        },
        metadata: {
          file_path,
          matches_found: matches.length,
          replacements_made: replacedCount,
          replace_all,
          old_string_length: old_string.length,
          new_string_length: new_string.length,
          original_size: content.length,
          new_size: newContent.length,
          size_diff: newContent.length - content.length,
          snapshot_created: false,
          kind: 'edit',
          oldContent: content,
          newContent,
          write_acknowledged: error.writeAcknowledged,
          write_verified: error.writeVerified,
          sideEffectsUncertain: error.sideEffectsUncertain,
          requiresRead: true,
        },
      };
    }
    if (error instanceof AcpRemoteMutationError) {
      return {
        success: false,
        llmContent: `File edit failed: ${error.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error.message,
        },
        metadata: {
          file_path,
          matches_found: matches.length,
          replacements_made: replacedCount,
          replace_all,
          old_string_length: old_string.length,
          new_string_length: new_string.length,
          original_size: content.length,
          new_size: newContent.length,
          size_diff: newContent.length - content.length,
          snapshot_created: false,
          kind: 'edit',
          oldContent: content,
          newContent,
          write_acknowledged: error.writeAcknowledged,
          write_verified: error.writeVerified,
          sideEffectsUncertain: error.sideEffectsUncertain,
          requiresRead: error.requiresRead || undefined,
        },
      };
    }
    throw error;
  } finally {
    lease.release();
  }
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
  // 标准化:移除多余空格,统一引号（包括智能引号）
  const normalize = (s: string) =>
    s
      .trim()
      .replace(/\s+/g, ' ')
      // 统一智能双引号 (\u201c \u201d) 和直引号 (") -> "
      .replace(/[\u201c\u201d"]/g, '"')
      // 统一智能单引号 (\u2018 \u2019) 和直引号 (') -> '
      .replace(/[\u2018\u2019']/g, "'");

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

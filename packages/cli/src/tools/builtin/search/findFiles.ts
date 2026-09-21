import { Default, Type } from '../../../schema/index.js';
import { fileNameIndex } from '../../../services/FileNameIndex.js';
import { getCwd } from '../../../utils/cwd.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';

export const findFilesTool = createTool({
  name: 'FindFiles',
  displayName: 'Fuzzy File Search',
  kind: ToolKind.ReadOnly,
  isConcurrencySafe: true,
  isRetrySafe: true,

  schema: Type.Object({
    query: Type.String({
      minLength: 1,
      maxLength: 256,
      description: 'A fuzzy file name or relative path query',
    }),
    max_results: Default(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        description: 'Maximum number of matching files to return',
      }),
      20
    ),
  }),

  description: {
    short: 'Fuzzy-search file names and relative paths in the workspace',
    long: `Fuzzy-search file names and relative paths in the workspace. Use this when you remember only part of a file name or path. Use Glob for wildcard patterns and Grep for file contents.`,
    usageNotes: [
      'Use FindFiles when the exact file path is unknown',
      'Results are ranked by fuzzy path similarity and respect ignore rules',
      'Use the returned relative paths with Read or Edit',
    ],
  },

  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const query = params.query.trim();
    const workspaceRoot = context.workspaceRoot ?? getCwd();
    const signal = context.signal ?? new AbortController().signal;

    if (!query) {
      return {
        success: false,
        llmContent: 'File name query must not be empty',
        metadata: {
          summary: 'File name search failed: empty query',
        },
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: 'File name query must not be empty',
        },
      };
    }

    try {
      context.updateOutput?.(`Fuzzy-searching file names for "${query}"...`);
      const matches = await fileNameIndex.search(query, {
        cwd: workspaceRoot,
        limit: params.max_results + 1,
        signal,
      });
      const truncated = matches.length > params.max_results;
      const returnedMatches = matches.slice(0, params.max_results);
      const llmContent =
        returnedMatches.length === 0
          ? `No files found matching "${query}"`
          : `Found ${returnedMatches.length} file(s) matching "${query}"${truncated ? ' (truncated)' : ''}:\n\n${returnedMatches.map((match) => `- ${match.path}`).join('\n')}\n\nUse the paths above for Read or Edit operations.`;

      return {
        success: true,
        llmContent,
        metadata: {
          query,
          returned_matches: returnedMatches.length,
          max_results: params.max_results,
          truncated,
          matches: returnedMatches,
          summary: `Found ${returnedMatches.length} file(s) matching "${query}"`,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        llmContent:
          signal.aborted || (error instanceof Error && error.name === 'AbortError')
            ? 'File name search aborted'
            : `File name search failed: ${message}`,
        metadata: {
          summary:
            signal.aborted || (error instanceof Error && error.name === 'AbortError')
              ? 'File name search aborted'
              : `File name search failed: ${message}`,
        },
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message,
        },
      };
    }
  },

  version: '1.0.0',
  category: '搜索工具',
  tags: ['file', 'search', 'fuzzy', 'path'],
  extractSignatureContent: (params) => params.query,
  abstractPermissionRule: () => '*',
});

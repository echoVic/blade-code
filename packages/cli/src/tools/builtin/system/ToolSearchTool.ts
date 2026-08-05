/**
 * ToolSearchTool — 工具搜索与延迟加载
 *
 * 用于按需加载 deferred 工具的完整 schema。
 * AI 通过此工具搜索并获取工具的完整参数定义。
 */

import { Default, Type } from '../../../schema/index.js';
import { createTool } from '../../core/createTool.js';
import type {
  ExecutionContext,
  FunctionDeclaration,
  ToolResult,
} from '../../types/index.js';
import { ToolKind } from '../../types/index.js';

export const toolSearchTool = createTool({
  name: 'ToolSearch',
  displayName: 'Tool Search',
  kind: ToolKind.ReadOnly,
  isConcurrencySafe: true,

  schema: Type.Object({
    query: Type.String({
      description:
        'Search query. Use "select:Read,Edit,Grep" for exact selection, or keywords for fuzzy search.',
    }),
    max_results: Default(
      Type.Number({
        description: 'Maximum results to return (default 5)',
      }),
      5
    ),
  }),

  description: {
    short: 'Search and load deferred tool schemas',
    long: [
      'Fetches full schema definitions for deferred tools so',
      'they can be called. Deferred tools appear by name in',
      '<available-deferred-tools> messages. Until fetched, only',
      'the name is known — there is no parameter schema, so',
      'the tool cannot be invoked.',
    ].join(' '),
    usageNotes: [
      'Use "select:Read,Edit,Grep" to fetch exact tools by name',
      'Use keywords to search by tool name or description',
      'Once loaded via ToolSearch, a tool becomes callable',
    ],
    examples: [
      {
        description: 'Load specific tools by name',
        params: { query: 'select:WebFetch,WebSearch', max_results: 5 },
      },
      {
        description: 'Search for notebook-related tools',
        params: { query: 'notebook jupyter', max_results: 5 },
      },
    ],
  },

  async execute(
    params: { query: string; max_results: number },
    context: ExecutionContext
  ): Promise<ToolResult> {
    const { query, max_results } = params;
    const registry = context.toolRegistry;

    if (!registry) {
      return {
        success: false,
        llmContent: 'Tool registry not available in execution context.',
      };
    }

    let matchedTools: Array<{
      name: string;
      declaration: FunctionDeclaration;
    }> = [];

    if (query.startsWith('select:')) {
      // 精确选择模式
      const names = query
        .slice('select:'.length)
        .split(',')
        .map((n) => n.trim());
      for (const name of names) {
        const tool = registry.get(name);
        if (tool) {
          matchedTools.push({
            name: tool.name,
            declaration: tool.getFunctionDeclaration(),
          });
        }
      }
    } else {
      // 模糊搜索模式
      const results = registry.search(query);
      matchedTools = results.slice(0, max_results).map((tool) => ({
        name: tool.name,
        declaration: tool.getFunctionDeclaration(),
      }));
    }

    if (matchedTools.length === 0) {
      return {
        success: true,
        llmContent: `No tools found matching "${query}".`,
      };
    }

    // 标记工具为已加载（如果有 deferredToolManager）
    if (context.deferredToolManager) {
      for (const { name } of matchedTools) {
        context.deferredToolManager.markLoaded(name);
      }
    }

    // 格式化为 <functions> 块
    const functionsBlock = matchedTools
      .map(({ declaration }) => `<function>${JSON.stringify(declaration)}</function>`)
      .join('\n');

    return {
      success: true,
      llmContent: `<functions>\n${functionsBlock}\n</functions>`,
      metadata: {
        summary: `加载了 ${matchedTools.length} 个工具 schema`,
      },
    };
  },
});

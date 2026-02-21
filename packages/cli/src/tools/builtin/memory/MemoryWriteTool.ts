/**
 * MemoryWriteTool - 写入项目记忆文件
 */

import { z } from 'zod';
import { AutoMemoryManager } from '../../../memory/AutoMemoryManager.js';
import { createTool } from '../../core/createTool.js';
import type { ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';

/** 禁止写入的敏感关键词 */
const SENSITIVE_PATTERNS = [
  /password\s*[:=]/i,
  /token\s*[:=]/i,
  /secret\s*[:=]/i,
  /api[_-]?key\s*[:=]/i,
  /private[_-]?key/i,
];

export const memoryWriteTool = createTool({
  name: 'MemoryWrite',
  displayName: 'Memory Write',
  kind: ToolKind.Write,

  schema: z.object({
    topic: z
      .string()
      .describe(
        'Topic name to write to (e.g., "debugging", "patterns", "MEMORY" for the index). Without .md extension.'
      ),
    content: z.string().describe('Content to write to the memory file'),
    mode: z
      .enum(['overwrite', 'append'])
      .default('append')
      .describe('Write mode: "append" adds to existing content, "overwrite" replaces it'),
  }),

  description: {
    short: 'Save project knowledge to persistent auto memory',
    long: `Saves notes and learnings to the project's persistent auto memory. Use this to record useful project knowledge that should survive across sessions — build commands, code patterns, debugging insights, architecture notes, and user preferences.`,
    usageNotes: [
      'Use topic="MEMORY" to update the index file (keep it concise, under 200 lines)',
      'Use descriptive topic names for detailed notes (e.g., "debugging", "api-conventions")',
      'Default mode is "append" — adds to existing content',
      'Use "overwrite" mode to replace the entire topic file',
      'Do NOT save sensitive data (passwords, tokens, API keys)',
    ],
    examples: [
      {
        description: 'Save a debugging insight',
        params: {
          topic: 'debugging',
          content:
            '## Redis connection timeout\nThe test suite requires a local Redis instance. Start with `docker compose up redis`.',
        },
      },
      {
        description: 'Update the memory index',
        params: {
          topic: 'MEMORY',
          content:
            '# Project Memory\n\n- Build: `pnpm build`\n- Test: `pnpm test`\n- See debugging.md for common issues',
          mode: 'overwrite',
        },
      },
    ],
  },

  async execute(params): Promise<ToolResult> {
    const { topic, content, mode } = params;
    const projectPath = process.cwd();

    // 安全检查：拒绝写入敏感信息
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(content)) {
        const msg = `Refused: content appears to contain sensitive data (matched ${pattern}). Do not save passwords, tokens, or API keys to memory.`;
        return {
          success: false,
          llmContent: msg,
          displayContent: msg,
          error: { message: msg, type: ToolErrorType.VALIDATION_ERROR },
        };
      }
    }

    const manager = new AutoMemoryManager(projectPath);

    if (topic === 'MEMORY') {
      await manager.updateIndex(content, mode);
    } else {
      await manager.writeTopic(topic, content, mode);
    }

    const action = mode === 'overwrite' ? 'Written' : 'Appended';
    const msg = `${action} to memory/${topic}.md (${content.length} chars)`;
    return { success: true, llmContent: msg, displayContent: msg };
  },
});

/**
 * MemoryReadTool - 读取项目记忆文件
 */

import { z } from 'zod';
import { AutoMemoryManager } from '../../../memory/AutoMemoryManager.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolKind } from '../../types/index.js';

export const memoryReadTool = createTool({
  name: 'MemoryRead',
  displayName: 'Memory Read',
  kind: ToolKind.ReadOnly,

  schema: z.object({
    topic: z
      .string()
      .describe(
        'Topic name to read (e.g., "debugging", "patterns", "MEMORY" for the index, "_list" to list all topics). Without .md extension.'
      ),
  }),

  description: {
    short: 'Read a topic file from project auto memory',
    long: `Reads a topic file from the project's persistent auto memory directory. Use this to retrieve detailed notes that were saved in previous sessions. The MEMORY.md index is automatically loaded at session start, but topic files need to be read on demand.`,
    usageNotes: [
      'Use topic="MEMORY" to read the full MEMORY.md index',
      'Use topic="_list" to list all available memory files',
      'Topic files are stored at ~/.blade/projects/{project}/memory/{topic}.md',
    ],
    examples: [
      {
        description: 'Read debugging notes',
        params: { topic: 'debugging' },
      },
      {
        description: 'Read the full MEMORY.md index',
        params: { topic: 'MEMORY' },
      },
      {
        description: 'List all memory topics',
        params: { topic: '_list' },
      },
    ],
  },

  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { topic } = params;
    const projectPath = context.workspaceRoot || process.cwd();
    const manager = new AutoMemoryManager(projectPath);

    // 列出所有主题
    if (topic === '_list') {
      const topics = await manager.listTopics();
      if (topics.length === 0) {
        const msg = 'No memory files found. Use MemoryWrite to save project knowledge.';
        return { success: true, llmContent: msg, displayContent: msg };
      }
      const list = topics
        .map((t) => `- ${t.name}.md (${t.size} bytes, updated ${t.lastModified.toISOString()})`)
        .join('\n');
      const msg = `Memory files:\n${list}`;
      return { success: true, llmContent: msg, displayContent: msg };
    }

    const content = await manager.readTopic(topic);
    if (content === null) {
      const msg = `Memory topic "${topic}" not found. Use topic="_list" to see available topics.`;
      return { success: true, llmContent: msg, displayContent: msg };
    }

    return { success: true, llmContent: content, displayContent: content };
  },
});

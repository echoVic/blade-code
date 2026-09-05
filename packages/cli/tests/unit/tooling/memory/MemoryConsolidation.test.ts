import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoMemoryManager } from '../../../../src/memory/AutoMemoryManager.js';
import {
  commitMemoryConsolidation,
  MAX_MEMORY_CONSOLIDATION_ENTRIES,
  MAX_MEMORY_CONSOLIDATION_ENTRY_CHARS,
  MAX_MEMORY_CONSOLIDATION_TOTAL_CHARS,
  planMemoryConsolidation,
} from '../../../../src/memory/MemoryConsolidation.js';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';

describe('MemoryConsolidation', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.BLADE_AUTO_MEMORY;
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true })));
  });

  it('extracts supported markers in source order and normalizes whitespace', () => {
    const plan = planMemoryConsolidation([
      { role: 'user', content: '记住： use   pnpm for packages' },
      { role: 'user', content: 'convention: tools use a Tool suffix' },
      { role: 'user', content: '教训： verify the generated route table' },
      {
        role: 'assistant',
        content:
          'Fixed: Wrap JSON parsing so malformed arguments cannot crash the loop',
      },
    ]);

    expect(plan).toEqual({
      entries: [
        { topic: 'preferences', content: 'use pnpm for packages' },
        { topic: 'conventions', content: 'tools use a Tool suffix' },
        { topic: 'lessons', content: 'verify the generated route table' },
        {
          topic: 'debugging',
          content: 'Wrap JSON parsing so malformed arguments cannot crash the loop',
        },
      ],
      rejectedSensitive: 0,
    });
  });

  it('does not inspect tool output, metadata, reasoning, or image URLs', () => {
    const plan = planMemoryConsolidation([
      { role: 'tool', content: 'Error: reusable failure', tool_call_id: 'tc-1' },
      {
        role: 'assistant',
        content: 'No reusable marker here',
        reasoningContent: 'Fixed: reasoning must stay private forever',
        metadata: { note: 'lesson: metadata must stay private' },
        tool_calls: [
          {
            id: 'tc-1',
            type: 'function',
            function: { name: 'Bash', arguments: '{"note":"lesson: private"}' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'ordinary visible text' },
          { type: 'image_url', image_url: { url: 'lesson: private image URL' } },
        ],
      },
    ]);

    expect(plan).toEqual({ entries: [], rejectedSensitive: 0 });
  });

  it('deduplicates normalized entries and rejects sensitive candidates', () => {
    const plan = planMemoryConsolidation([
      { role: 'user', content: '约定：run   bun test' },
      { role: 'user', content: '约定: run bun test' },
      { role: 'user', content: '记住：token = private-value' },
    ]);

    expect(plan).toEqual({
      entries: [{ topic: 'conventions', content: 'run bun test' }],
      rejectedSensitive: 1,
    });
    expect(JSON.stringify(plan)).not.toContain('private-value');
  });

  it('enforces per-entry, entry-count, and total-character bounds', () => {
    const messages: Message[] = Array.from(
      {
        length: MAX_MEMORY_CONSOLIDATION_ENTRIES + 10,
      },
      (_, index) => ({
        role: 'user',
        content: `lesson: ${index}-${'x'.repeat(MAX_MEMORY_CONSOLIDATION_ENTRY_CHARS * 2)}`,
      })
    );

    const plan = planMemoryConsolidation(messages);
    expect(plan.entries.length).toBeLessThanOrEqual(MAX_MEMORY_CONSOLIDATION_ENTRIES);
    expect(plan.entries.every((entry) => [...entry.content].length <= 500)).toBe(true);
    expect(
      plan.entries.reduce((sum, entry) => sum + [...entry.content].length, 0)
    ).toBe(MAX_MEMORY_CONSOLIDATION_TOTAL_CHARS);
  });

  it('commits to the explicit workspace and returns content-free metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blade-consolidation-'));
    roots.push(root);
    const plan = planMemoryConsolidation([
      { role: 'user', content: 'convention: use the explicit workspace' },
    ]);

    const result = await commitMemoryConsolidation(plan, { workspaceRoot: root });

    expect(result).toEqual({
      outcome: 'written',
      entries: 1,
      topics: ['conventions'],
    });
    const memory = new AutoMemoryManager(root);
    expect(await memory.readTopic('conventions')).toContain(
      'use the explicit workspace'
    );
  });

  it.each([
    { name: 'environment disabled', env: '0', workspaceAccess: 'full' as const },
    { name: 'remote workspace', env: undefined, workspaceAccess: 'none' as const },
  ])('does not write when $name', async ({ env, workspaceAccess }) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'blade-consolidation-disabled-')
    );
    roots.push(root);
    if (env !== undefined) process.env.BLADE_AUTO_MEMORY = env;

    const result = await commitMemoryConsolidation(
      planMemoryConsolidation([
        { role: 'user', content: 'convention: do not persist this entry' },
      ]),
      { workspaceRoot: root, workspaceAccess }
    );

    expect(result).toEqual({ outcome: 'disabled', entries: 0, topics: [] });
    expect(await new AutoMemoryManager(root).listTopics()).toEqual([]);
  });

  it('maps storage failures to a content-free result', async () => {
    vi.spyOn(AutoMemoryManager.prototype, 'appendUniqueEntries').mockRejectedValueOnce(
      Object.assign(new Error('secret workspace path'), { code: 'EIO' })
    );

    await expect(
      commitMemoryConsolidation(
        planMemoryConsolidation([
          { role: 'user', content: 'convention: keep runtime errors bounded' },
        ]),
        { workspaceRoot: '/private/workspace' }
      )
    ).resolves.toEqual({ outcome: 'failed', entries: 0, topics: [] });
  });
});

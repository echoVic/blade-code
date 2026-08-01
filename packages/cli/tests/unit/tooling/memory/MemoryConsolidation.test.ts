import { describe, expect, it } from 'vitest';
import { extractLearnings } from '../../../../src/memory/MemoryConsolidation.js';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';

describe('MemoryConsolidation', () => {
  describe('extractLearnings', () => {
    it('should extract user-marked preferences', () => {
      const messages: Message[] = [
        { role: 'user', content: '记住：始终使用 pathe 而非 path' },
      ];

      const learnings = extractLearnings(messages);
      expect(learnings.has('preferences')).toBe(true);
      expect(learnings.get('preferences')![0]).toContain('pathe');
    });

    it('should extract convention markers', () => {
      const messages: Message[] = [
        { role: 'user', content: 'convention: 工具类以 Tool 后缀命名' },
      ];

      const learnings = extractLearnings(messages);
      expect(learnings.has('conventions')).toBe(true);
      expect(learnings.get('conventions')![0]).toContain('Tool 后缀');
    });

    it('should extract error resolution patterns from assistant', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content:
            '修复: 将 JSON.parse 包裹在 try-catch 中以防止格式错误的工具参数导致循环崩溃',
        },
      ];

      const learnings = extractLearnings(messages);
      expect(learnings.has('debugging')).toBe(true);
    });

    it('should extract tool error patterns', () => {
      const messages: Message[] = [
        {
          role: 'tool',
          content: 'Error: ENOENT: no such file or directory, open /foo/bar.ts',
          tool_call_id: 'tc_1',
        },
      ];

      const learnings = extractLearnings(messages);
      expect(learnings.has('debugging')).toBe(true);
    });

    it('should return empty map for unrelated messages', () => {
      const messages: Message[] = [
        { role: 'user', content: '请帮我写一个函数' },
        { role: 'assistant', content: '好的，这是实现：...' },
      ];

      const learnings = extractLearnings(messages);
      expect(learnings.size).toBe(0);
    });

    it('should limit debugging entries to 5', () => {
      const messages: Message[] = Array.from({ length: 10 }, (_, i) => ({
        role: 'tool' as const,
        content: `Error: Some recurring error pattern number ${i} that keeps happening`,
        tool_call_id: `tc_${i}`,
      }));

      const learnings = extractLearnings(messages);
      const debugging = learnings.get('debugging') ?? [];
      expect(debugging.length).toBeLessThanOrEqual(5);
    });
  });
});

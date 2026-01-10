/**
 * TokenCounter 单元测试
 */

import { describe, expect, it } from 'vitest';
import { TokenCounter } from '../../../src/context/TokenCounter.js';
import type { Message } from '../../../src/services/ChatServiceInterface.js';

describe('TokenCounter', () => {
  const modelName = 'gpt-4';

  describe('countTokens', () => {
    it('should count tokens for simple user message', () => {
      const messages: Message[] = [{ role: 'user', content: 'Hello world' }];
      const count = TokenCounter.countTokens(messages, modelName);
      expect(count).toBeGreaterThan(0);
    });

    it('should count tokens for multiple messages', () => {
      const messages: Message[] = [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hello' },
      ];
      const count = TokenCounter.countTokens(messages, modelName);
      expect(count).toBeGreaterThan(0);
    });

    it('should handle tool calls', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: '', // content can be empty for tool calls
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'test', arguments: '{}' },
            },
          ],
        },
      ];
      const count = TokenCounter.countTokens(messages, modelName);
      expect(count).toBeGreaterThan(0);
    });
  });

  describe('shouldCompact', () => {
    it('should return true when tokens exceed threshold', () => {
      // Mock countTokens via simple message construction
      // Construct a large message
      const largeContent = 'word '.repeat(1000);
      const messages: Message[] = [{ role: 'user', content: largeContent }];

      // Max tokens 100, threshold 0.8 -> 80
      // 1000 words >> 80 tokens
      const result = TokenCounter.shouldCompact(messages, modelName, 100, 0.8);
      expect(result).toBe(true);
    });

    it('should return false when tokens are within limit', () => {
      const messages: Message[] = [{ role: 'user', content: 'short' }];
      // Max tokens 10000
      const result = TokenCounter.shouldCompact(messages, modelName, 10000, 0.8);
      expect(result).toBe(false);
    });
  });
});

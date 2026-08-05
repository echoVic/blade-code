import { describe, expect, it } from 'vitest';
import {
  createTestChatService,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
} from './testConfig.js';

const enabledModels = isRealApiTestEnabled() ? getEnabledModelConfigs() : [];

describe.skipIf(enabledModels.length === 0)('Real API Chat Completion', () => {
  describe.each(enabledModels)('$name ($provider)', (modelConfig) => {
    it('should complete a basic chat request', async () => {
      const service = createTestChatService(modelConfig);
      const result = await service.chat([
        {
          role: 'system',
          content: 'You are a helpful assistant. Reply with exactly "hello".',
        },
        { role: 'user', content: 'Say hello' },
      ]);

      expect(result.content).toBeTruthy();
      expect(result.content.toLowerCase().replace(/[^a-z]/g, '')).toContain('hello');
      expect(result.usage).toBeDefined();
      expect(result.usage!.promptTokens).toBeGreaterThan(0);
      expect(result.usage!.completionTokens).toBeGreaterThan(0);
    }, 120000);

    it('should handle multi-turn conversation', async () => {
      const service = createTestChatService(modelConfig);
      const result = await service.chat([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is 2+2? Reply with just the number.' },
        { role: 'assistant', content: '4' },
        { role: 'user', content: 'And what is 3+5? Reply with just the number.' },
      ]);

      expect(result.content).toBeTruthy();
      expect(result.content).toContain('8');
    }, 120000);

    it('should respect system prompt instructions', async () => {
      const service = createTestChatService(modelConfig);
      const result = await service.chat([
        { role: 'system', content: 'Always respond in uppercase.' },
        { role: 'user', content: 'say hello' },
      ]);

      expect(result.content).toBeTruthy();
      expect(result.content).toBe(result.content.toUpperCase());
    }, 120000);
  });
});

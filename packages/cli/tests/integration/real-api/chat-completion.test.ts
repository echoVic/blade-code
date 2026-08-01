import { generateText } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  getEnabledModelConfigs,
  isRealApiTestEnabled,
  REAL_API_OUTPUT_BUDGET,
} from './testConfig.js';

const enabledModels = isRealApiTestEnabled() ? getEnabledModelConfigs() : [];

describe.skipIf(enabledModels.length === 0)('Real API Chat Completion', () => {
  describe.each(enabledModels)('$name ($provider)', (modelConfig) => {
    it('should complete a basic chat request', async () => {
      const model = modelConfig.createModel();
      const result = await generateText({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant. Reply with exactly "hello".',
          },
          { role: 'user', content: 'Say hello' },
        ],
        maxOutputTokens: REAL_API_OUTPUT_BUDGET,
        temperature: 0,
      });

      expect(result.text).toBeTruthy();
      expect(result.text.toLowerCase().replace(/[^a-z]/g, '')).toContain('hello');
      expect(result.usage).toBeDefined();
      expect(result.usage!.inputTokens).toBeGreaterThan(0);
      expect(result.usage!.outputTokens).toBeGreaterThan(0);
    }, 120000);

    it('should handle multi-turn conversation', async () => {
      const model = modelConfig.createModel();
      const result = await generateText({
        model,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'What is 2+2? Reply with just the number.' },
          { role: 'assistant', content: '4' },
          { role: 'user', content: 'And what is 3+5? Reply with just the number.' },
        ],
        maxOutputTokens: REAL_API_OUTPUT_BUDGET,
        temperature: 0,
      });

      expect(result.text).toBeTruthy();
      expect(result.text).toContain('8');
    }, 120000);

    it('should respect system prompt instructions', async () => {
      const model = modelConfig.createModel();
      const result = await generateText({
        model,
        messages: [
          { role: 'system', content: 'Always respond in uppercase.' },
          { role: 'user', content: 'say hello' },
        ],
        maxOutputTokens: REAL_API_OUTPUT_BUDGET,
        temperature: 0,
      });

      expect(result.text).toBeTruthy();
      expect(result.text).toBe(result.text.toUpperCase());
    }, 120000);
  });
});

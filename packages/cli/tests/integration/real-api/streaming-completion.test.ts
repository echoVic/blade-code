import { describe, expect, it } from 'vitest';
import {
  createTestChatService,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
} from './testConfig.js';

const enabledModels = isRealApiTestEnabled() ? getEnabledModelConfigs() : [];

describe.skipIf(enabledModels.length === 0)('Real API Streaming Completion', () => {
  describe.each(enabledModels)('$name ($provider)', (modelConfig) => {
    it('should stream text deltas', async () => {
      const service = createTestChatService(modelConfig);
      const result = service.streamChat([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Say hello world in one sentence.' },
      ]);

      const chunks: string[] = [];
      for await (const part of result) {
        if (part.content) chunks.push(part.content);
      }

      expect(chunks.length).toBeGreaterThan(0);
      const fullText = chunks.join('');
      expect(fullText.trim()).toBeTruthy();
    }, 120000);

    it('should deliver finish event with usage', async () => {
      const service = createTestChatService(modelConfig);
      const result = service.streamChat([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is 2+2? Reply with just the number.' },
      ]);

      let finishEvent: {
        finishReason?: string;
        usage?: { promptTokens?: number; completionTokens?: number };
      } | null = null;
      for await (const part of result) {
        if (part.finishReason) finishEvent = part;
      }

      expect(finishEvent).not.toBeNull();
      expect(finishEvent!.finishReason).toBe('stop');
      expect(finishEvent!.usage).toBeDefined();
      const inputTokens = finishEvent!.usage?.promptTokens ?? 0;
      expect(inputTokens).toBeGreaterThan(0);
    }, 120000);

    it('should collect full text via text stream', async () => {
      const service = createTestChatService(modelConfig);
      const result = service.streamChat([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Tell me a short story about a robot.' },
      ]);

      let collectedText = '';
      for await (const part of result) collectedText += part.content ?? '';
      expect(collectedText).toBeTruthy();
      expect(collectedText.length).toBeGreaterThan(10);
    }, 120000);

    it('should handle multi-turn streaming', async () => {
      const service = createTestChatService(modelConfig);
      const result = service.streamChat([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is the capital of France?' },
        { role: 'assistant', content: 'Paris' },
        { role: 'user', content: 'And what is its population (approx)?' },
      ]);

      const chunks: string[] = [];
      for await (const part of result) {
        if (part.content) chunks.push(part.content);
      }

      const fullText = chunks.join('');
      expect(fullText.trim()).toBeTruthy();
    }, 120000);
  });
});

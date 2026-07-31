import { streamText } from 'ai';
import { describe, expect, it } from 'vitest';
import { getEnabledModelConfigs, isRealApiTestEnabled } from './testConfig.js';

const enabledModels = isRealApiTestEnabled() ? getEnabledModelConfigs() : [];

describe.skipIf(enabledModels.length === 0)('Real API Streaming Completion', () => {
  describe.each(enabledModels)('$name ($provider)', (modelConfig) => {
    it('should stream text deltas', async () => {
      const model = modelConfig.createModel();
      const result = streamText({
        model,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Say hello world in one sentence.' },
        ],
        maxOutputTokens: 100,
        temperature: 0,
      });

      const chunks: string[] = [];
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          chunks.push(part.text);
        }
      }

      expect(chunks.length).toBeGreaterThan(0);
      const fullText = chunks.join('');
      expect(fullText.trim()).toBeTruthy();
    }, 120000);

    it('should deliver finish event with usage', async () => {
      const model = modelConfig.createModel();
      const result = streamText({
        model,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'What is 2+2? Reply with just the number.' },
        ],
        maxOutputTokens: 50,
        temperature: 0,
      });

      let finishEvent: {
        finishReason?: string;
        totalUsage?: {
          promptTokens?: number;
          completionTokens?: number;
          totalTokens?: number;
        };
      } | null = null;
      for await (const part of result.fullStream) {
        if (part.type === 'finish') {
          finishEvent = part as unknown as typeof finishEvent;
        }
      }

      expect(finishEvent).not.toBeNull();
      expect(finishEvent!.finishReason).toBe('stop');
      expect(finishEvent!.totalUsage).toBeDefined();
      const usage = finishEvent!.totalUsage as Record<string, number>;
      const inputTokens = usage.promptTokens || usage.inputTokens || 0;
      expect(inputTokens).toBeGreaterThan(0);
    }, 120000);

    it('should collect full text via text stream', async () => {
      const model = modelConfig.createModel();
      const result = streamText({
        model,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Tell me a short story about a robot.' },
        ],
        maxOutputTokens: 200,
        temperature: 0.7,
      });

      const collectedText = await result.text;
      expect(collectedText).toBeTruthy();
      expect(collectedText.length).toBeGreaterThan(10);
    }, 120000);

    it('should handle multi-turn streaming', async () => {
      const model = modelConfig.createModel();
      const result = streamText({
        model,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'What is the capital of France?' },
          { role: 'assistant', content: 'Paris' },
          { role: 'user', content: 'And what is its population (approx)?' },
        ],
        maxOutputTokens: 100,
        temperature: 0,
      });

      const chunks: string[] = [];
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          chunks.push(part.text);
        }
      }

      const fullText = chunks.join('');
      expect(fullText.trim()).toBeTruthy();
    }, 120000);
  });
});

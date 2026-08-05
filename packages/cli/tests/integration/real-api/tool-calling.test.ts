import { describe, expect, it } from 'vitest';
import { StringEnum, Type } from '../../../src/schema/index.js';
import {
  createTestChatService,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
} from './testConfig.js';

const calculatorTool = {
  name: 'calculate',
  description: 'Calculate the result of a math expression',
  parameters: Type.Object({
    expression: Type.String({ description: 'Math expression to calculate' }),
  }),
};

const weatherTool = {
  name: 'getWeather',
  description: 'Get the current weather for a given city',
  parameters: Type.Object({
    city: Type.String({ description: 'City name' }),
    unit: Type.Optional(StringEnum(['celsius', 'fahrenheit'])),
  }),
};

const enabledModels = isRealApiTestEnabled() ? getEnabledModelConfigs() : [];

describe.skipIf(enabledModels.length === 0)('Real API Tool Calling', () => {
  describe.each(enabledModels)('$name ($provider)', (modelConfig) => {
    it('should call a tool with generateText', async () => {
      const service = createTestChatService(modelConfig);
      const result = await service.chat(
        [
          {
            role: 'system',
            content:
              'You are a helpful assistant. Use the calculate tool when asked math questions.',
          },
          { role: 'user', content: 'What is 15 * 23?' },
        ],
        [calculatorTool]
      );

      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls!.length).toBeGreaterThan(0);
      const call = result.toolCalls![0];
      expect('function' in call && call.function.name).toBe('calculate');
      expect(
        JSON.parse('function' in call ? call.function.arguments : '{}')
      ).toHaveProperty('expression');
    }, 120000);

    it('should call a tool with streamText', async () => {
      const service = createTestChatService(modelConfig);
      const result = service.streamChat(
        [
          {
            role: 'system',
            content:
              'You are a helpful assistant. Use the getWeather tool when asked about weather.',
          },
          { role: 'user', content: 'What is the weather in Beijing?' },
        ],
        [weatherTool]
      );

      const toolCalls: Array<{
        toolCallId: string;
        toolName: string;
        input: unknown;
      }> = [];
      for await (const part of result) {
        for (const call of part.toolCalls ?? []) {
          if (!call.id || call.type !== 'function' || !('function' in call)) continue;
          const fn = call.function;
          if (!fn?.name) continue;
          toolCalls.push({
            toolCallId: call.id,
            toolName: fn.name,
            input: JSON.parse(fn.arguments ?? '{}'),
          });
        }
      }

      expect(toolCalls.length).toBeGreaterThan(0);
      expect(toolCalls[0].toolName).toBe('getWeather');
      expect(toolCalls[0].input).toHaveProperty('city');
    }, 120000);

    it('should handle multiple tools', async () => {
      const service = createTestChatService(modelConfig);
      const result = await service.chat(
        [
          {
            role: 'system',
            content:
              'You are a helpful assistant. Use the appropriate tool for each question.',
          },
          {
            role: 'user',
            content: 'What is 15 * 23 and what is the weather in Shanghai?',
          },
        ],
        [calculatorTool, weatherTool]
      );

      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls!.length).toBeGreaterThanOrEqual(1);
      const toolNames = result
        .toolCalls!.filter((call) => 'function' in call)
        .map((call) => call.function.name);
      expect(toolNames.includes('calculate') || toolNames.includes('getWeather')).toBe(
        true
      );
    }, 120000);
  });
});

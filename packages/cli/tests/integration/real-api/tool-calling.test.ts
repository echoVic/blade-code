import { generateText, jsonSchema, streamText } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  getEnabledModelConfigs,
  isRealApiTestEnabled,
  REAL_API_OUTPUT_BUDGET,
} from './testConfig.js';

const calculatorTool = {
  description: 'Calculate the result of a math expression',
  inputSchema: jsonSchema({
    type: 'object' as const,
    properties: {
      expression: { type: 'string', description: 'Math expression to calculate' },
    },
    required: ['expression'],
  }),
};

const weatherTool = {
  description: 'Get the current weather for a given city',
  inputSchema: jsonSchema({
    type: 'object' as const,
    properties: {
      city: { type: 'string', description: 'City name' },
      unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
    },
    required: ['city'],
  }),
};

const enabledModels = isRealApiTestEnabled() ? getEnabledModelConfigs() : [];

describe.skipIf(enabledModels.length === 0)('Real API Tool Calling', () => {
  describe.each(enabledModels)('$name ($provider)', (modelConfig) => {
    it('should call a tool with generateText', async () => {
      const model = modelConfig.createModel();
      const result = await generateText({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful assistant. Use the calculate tool when asked math questions.',
          },
          { role: 'user', content: 'What is 15 * 23?' },
        ],
        tools: { calculate: calculatorTool },
        maxOutputTokens: REAL_API_OUTPUT_BUDGET,
        temperature: 0,
      });

      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls!.length).toBeGreaterThan(0);
      expect(result.toolCalls![0].toolName).toBe('calculate');
      expect(result.toolCalls![0].input).toHaveProperty('expression');
    }, 120000);

    it('should call a tool with streamText', async () => {
      const model = modelConfig.createModel();
      const result = streamText({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful assistant. Use the getWeather tool when asked about weather.',
          },
          { role: 'user', content: 'What is the weather in Beijing?' },
        ],
        tools: { getWeather: weatherTool },
        maxOutputTokens: REAL_API_OUTPUT_BUDGET,
        temperature: 0,
      });

      const toolCalls: Array<{
        toolCallId: string;
        toolName: string;
        input: unknown;
      }> = [];
      for await (const part of result.fullStream) {
        if (part.type === 'tool-call') {
          toolCalls.push({
            toolCallId: (part as { toolCallId: string }).toolCallId,
            toolName: (part as { toolName: string }).toolName,
            input: (part as { input: unknown }).input,
          });
        }
      }

      expect(toolCalls.length).toBeGreaterThan(0);
      expect(toolCalls[0].toolName).toBe('getWeather');
      expect(toolCalls[0].input).toHaveProperty('city');
    }, 120000);

    it('should handle multiple tools', async () => {
      const model = modelConfig.createModel();
      const result = await generateText({
        model,
        messages: [
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
        tools: { calculate: calculatorTool, getWeather: weatherTool },
        maxOutputTokens: REAL_API_OUTPUT_BUDGET,
        temperature: 0,
      });

      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls!.length).toBeGreaterThanOrEqual(1);
      const toolNames = result.toolCalls!.map((tc) => tc.toolName);
      expect(toolNames.includes('calculate') || toolNames.includes('getWeather')).toBe(
        true
      );
    }, 120000);
  });
});

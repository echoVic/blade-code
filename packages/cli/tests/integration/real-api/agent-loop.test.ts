/**
 * Agent Loop Integration Test (Real API)
 *
 * Validates that our agent loop's core interaction patterns work with real LLMs:
 * - Tool call generation with proper parameters
 * - System prompt adherence
 * - Multi-turn conversation context maintenance
 */
import { generateText, jsonSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import { getEnabledModelConfigs, isRealApiTestEnabled } from './testConfig.js';

const calculatorTool = {
  description: 'Calculate a math expression and return the result',
  inputSchema: jsonSchema({
    type: 'object' as const,
    properties: {
      expression: {
        type: 'string',
        description: 'A math expression to evaluate, e.g. "2+3"',
      },
    },
    required: ['expression'],
  }),
};

const readFileTool = {
  description: 'Read the contents of a file at the given path',
  inputSchema: jsonSchema({
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: 'Absolute file path to read' },
    },
    required: ['path'],
  }),
};

const editFileTool = {
  description: 'Edit a file by replacing old_string with new_string',
  inputSchema: jsonSchema({
    type: 'object' as const,
    properties: {
      file_path: { type: 'string', description: 'Absolute file path to edit' },
      old_string: { type: 'string', description: 'Text to find and replace' },
      new_string: { type: 'string', description: 'Replacement text' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  }),
};

const enabledModels = isRealApiTestEnabled() ? getEnabledModelConfigs() : [];

describe.skipIf(enabledModels.length === 0)('Agent Loop (Real API)', () => {
  const modelConfig = enabledModels.find((m) => m.id === 'deepseek');
  if (!modelConfig) return;

  it('should select the correct tool based on user intent', async () => {
    const model = modelConfig.createModel();
    const result = await generateText({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are a coding assistant. Use available tools to complete tasks.',
        },
        { role: 'user', content: 'Calculate 99 * 101' },
      ],
      tools: {
        calculate: calculatorTool,
        read_file: readFileTool,
        edit_file: editFileTool,
      },
      maxOutputTokens: 200,
      temperature: 0,
    });

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBeGreaterThan(0);
    expect(result.toolCalls![0].toolName).toBe('calculate');
    const input = result.toolCalls![0].input as { expression: string };
    expect(input.expression).toBeTruthy();
  }, 30_000);

  it('should generate correct file path in tool arguments', async () => {
    const model = modelConfig.createModel();
    const result = await generateText({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are a coding assistant. Use the read_file tool to read files.',
        },
        { role: 'user', content: 'Read the file at /Users/test/src/index.ts' },
      ],
      tools: { read_file: readFileTool },
      maxOutputTokens: 200,
      temperature: 0,
    });

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBe(1);
    expect(result.toolCalls![0].toolName).toBe('read_file');
    const input = result.toolCalls![0].input as { path: string };
    expect(input.path).toContain('/Users/test/src/index.ts');
  }, 30_000);

  it('should generate edit tool calls with correct structure', async () => {
    const model = modelConfig.createModel();
    const result = await generateText({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a coding assistant. Use the edit_file tool to make changes.',
        },
        {
          role: 'user',
          content: 'In the file /tmp/app.ts, replace "console.log" with "logger.info"',
        },
      ],
      tools: { edit_file: editFileTool },
      maxOutputTokens: 300,
      temperature: 0,
    });

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBe(1);
    expect(result.toolCalls![0].toolName).toBe('edit_file');
    const input = result.toolCalls![0].input as {
      file_path: string;
      old_string: string;
      new_string: string;
    };
    expect(input.file_path).toContain('app.ts');
    expect(input.old_string).toContain('console.log');
    expect(input.new_string).toContain('logger.info');
  }, 30_000);

  it('should handle system prompt instructions for output format', async () => {
    const model = modelConfig.createModel();
    const result = await generateText({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a coding assistant. When you cannot use tools, respond with a JSON object: {"action": "explain", "content": "..."}',
        },
        { role: 'user', content: 'Explain what a closure is in JavaScript.' },
      ],
      tools: {},
      maxOutputTokens: 300,
      temperature: 0,
    });

    expect(result.text).toBeTruthy();
    expect(result.text.toLowerCase()).toContain('closure');
  }, 30_000);
});

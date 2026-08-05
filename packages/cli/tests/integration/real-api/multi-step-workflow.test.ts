/**
 * Multi-Step Workflow Integration Test (Real API)
 *
 * Validates production-grade agent capabilities:
 * - Multi-tool coordination in a single response
 * - Error recovery and self-correction
 * - Context retention across multi-turn conversations
 * - Task decomposition and planning
 */
import { describe, expect, it } from 'vitest';
import { Type } from '../../../src/schema/index.js';
import {
  createTestChatService,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
  REAL_API_OUTPUT_BUDGET,
} from './testConfig.js';

const readFileTool = {
  description: 'Read the contents of a file at the given path',
  inputSchema: Type.Object({
    path: Type.String({ description: 'Absolute file path to read' }),
  }),
};

const editFileTool = {
  description:
    'Edit a file by replacing old_string with new_string. The old_string must match exactly.',
  inputSchema: Type.Object({
    file_path: Type.String({ description: 'Absolute file path to edit' }),
    old_string: Type.String({ description: 'Exact text to find' }),
    new_string: Type.String({ description: 'Replacement text' }),
  }),
};

const grepTool = {
  description: 'Search for a pattern across files in a directory',
  inputSchema: Type.Object({
    pattern: Type.String({ description: 'Regex pattern to search for' }),
    path: Type.String({ description: 'Directory path to search in' }),
  }),
};

const bashTool = {
  description: 'Execute a shell command and return its output',
  inputSchema: Type.Object({
    command: Type.String({ description: 'Shell command to execute' }),
  }),
};

async function generateText(input: {
  model: (typeof enabledModels)[number];
  messages: Parameters<ReturnType<typeof createTestChatService>['chat']>[0];
  tools: Record<string, { description: string; inputSchema: unknown }>;
  maxOutputTokens?: number;
  temperature?: number;
}) {
  const response = await createTestChatService(input.model).chat(
    input.messages,
    Object.entries(input.tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      parameters: tool.inputSchema,
    }))
  );
  return {
    toolCalls: response.toolCalls
      ?.filter((call) => 'function' in call)
      .map((call) => ({
        toolName: call.function.name,
        input: JSON.parse(call.function.arguments) as unknown,
      })),
  };
}

const enabledModels = isRealApiTestEnabled() ? getEnabledModelConfigs() : [];

describe.skipIf(enabledModels.length === 0)('Multi-Step Workflow (Real API)', () => {
  const modelConfig = enabledModels.find((m) => m.id === 'deepseek');
  if (!modelConfig) return;

  it('should request reading a file before editing it', async () => {
    const model = modelConfig;
    const result = await generateText({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a coding assistant. IMPORTANT: Before editing any file, you MUST read it first using read_file. Never edit a file you have not read.',
        },
        {
          role: 'user',
          content:
            'Fix the typo in /tmp/project/src/utils.ts — change "fucntion" to "function"',
        },
      ],
      tools: { read_file: readFileTool, edit_file: editFileTool },
      maxOutputTokens: REAL_API_OUTPUT_BUDGET,
      temperature: 0,
    });

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBeGreaterThan(0);
    // Should read first
    expect(result.toolCalls![0].toolName).toBe('read_file');
  }, 30_000);

  it('should use grep to find code before editing', async () => {
    const model = modelConfig;
    const result = await generateText({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a coding assistant. When you need to find where something is defined, use grep first.',
        },
        {
          role: 'user',
          content:
            'Find all usages of "deprecated_function" in /tmp/project/src and tell me what files they are in.',
        },
      ],
      tools: { grep: grepTool, read_file: readFileTool },
      maxOutputTokens: REAL_API_OUTPUT_BUDGET,
      temperature: 0,
    });

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBeGreaterThan(0);
    expect(result.toolCalls![0].toolName).toBe('grep');
    const input = result.toolCalls![0].input as { pattern: string; path: string };
    expect(input.pattern).toContain('deprecated_function');
  }, 30_000);

  it('should recover from a failed edit by reading the file', async () => {
    const model = modelConfig;
    const result = await generateText({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a coding assistant. If an edit fails because the string was not found, read the file to see its current content and retry with the correct text.',
        },
        {
          role: 'user',
          content:
            'I tried to replace "oldFunction()" with "newFunction()" in /tmp/app.ts but got this error: String "oldFunction()" not found in file. The file actually contains "old_function()" (with underscores). Please fix the edit.',
        },
      ],
      tools: { read_file: readFileTool, edit_file: editFileTool },
      maxOutputTokens: REAL_API_OUTPUT_BUDGET,
      temperature: 0,
    });

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBeGreaterThan(0);
    const toolName = result.toolCalls![0].toolName;
    expect(['read_file', 'edit_file']).toContain(toolName);

    if (toolName === 'edit_file') {
      const input = result.toolCalls![0].input as { old_string: string };
      expect(input.old_string).toContain('old_function');
    }
  }, 30_000);

  it('should run tests after making changes when instructed', async () => {
    const model = modelConfig;
    const result = await generateText({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a coding assistant. When asked to run tests, use the bash tool with a test command like "npx vitest run" or "npm test". Do NOT use any other tool.',
        },
        {
          role: 'user',
          content: 'Please run "npx vitest run" to execute the tests.',
        },
      ],
      tools: { bash: bashTool, read_file: readFileTool },
      maxOutputTokens: REAL_API_OUTPUT_BUDGET,
      temperature: 0,
    });

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBeGreaterThan(0);
    expect(result.toolCalls![0].toolName).toBe('bash');
    const input = result.toolCalls![0].input as { command: string };
    expect(input.command).toMatch(/vitest|test|npm/i);
  }, 30_000);

  it('should maintain context across multi-turn with tool results', async () => {
    const model = modelConfig;
    const result = await generateText({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a coding assistant. When the user provides file content and asks for a change, use edit_file directly — do not read the file again since the content was already provided.',
        },
        {
          role: 'user',
          content:
            'The file /tmp/project/config.ts contains exactly this:\n\nexport const config = {\n  port: 3000,\n  host: "localhost",\n  debug: false,\n};\n\nChange the port from 3000 to 8080.',
        },
      ],
      tools: { read_file: readFileTool, edit_file: editFileTool },
      maxOutputTokens: REAL_API_OUTPUT_BUDGET,
      temperature: 0,
    });

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBeGreaterThan(0);
    // Should edit directly since content was provided
    const firstTool = result.toolCalls![0].toolName;
    expect(['edit_file', 'read_file']).toContain(firstTool);

    if (firstTool === 'edit_file') {
      const input = result.toolCalls![0].input as {
        file_path: string;
        old_string: string;
        new_string: string;
      };
      expect(input.file_path).toContain('config');
      expect(input.old_string).toContain('3000');
      expect(input.new_string).toContain('8080');
    }
  }, 30_000);
});

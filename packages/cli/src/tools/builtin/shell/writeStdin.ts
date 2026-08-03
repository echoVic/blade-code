import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { BackgroundShellManager } from './BackgroundShellManager.js';

const MAX_STDIN_BYTES = 64 * 1024;

const writeStdinSchema = z
  .object({
    shell_id: z.string().min(1).describe('Background shell ID returned by Bash'),
    data: z
      .string()
      .refine((value) => Buffer.byteLength(value) <= MAX_STDIN_BYTES, {
        message: `data must be at most ${MAX_STDIN_BYTES} bytes`,
      })
      .describe('Exact text to write. Include a newline when the process expects one.'),
    close_stdin: z
      .boolean()
      .default(false)
      .describe('Close stdin after writing so programs waiting for EOF can finish'),
  })
  .refine(({ data, close_stdin }) => data.length > 0 || close_stdin, {
    message: 'data cannot be empty unless close_stdin is true',
    path: ['data'],
  });

export const writeStdinTool = createTool({
  name: 'WriteStdin',
  displayName: 'Write to Shell',
  kind: ToolKind.Execute,
  isConcurrencySafe: false,
  schema: writeStdinSchema,

  description: {
    short: 'Writes input to a running background Bash shell',
    long: `
- Writes exact text to a background shell started by Bash with run_in_background=true
- Use the shell_id returned by Bash; shells are private to the active session
- Include a newline in data for line-oriented prompts or REPLs
- Set close_stdin=true when the program must receive EOF before it can finish
- Use TaskOutput afterward to wait for and read the process output
`.trim(),
  },

  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    if (!context.sessionId) {
      return {
        success: false,
        llmContent: 'WriteStdin requires an active session',
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: 'Active session is required to write shell input',
        },
        metadata: { summary: 'Cannot write Shell input without a session' },
      };
    }

    const result = await BackgroundShellManager.getInstance().writeInput(
      params.shell_id,
      context.sessionId,
      params.data,
      params.close_stdin
    );

    if (!result) {
      return {
        success: false,
        llmContent: `Shell not found: ${params.shell_id}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: 'Shell ID does not exist or is no longer available',
        },
        metadata: { summary: `Shell not found: ${params.shell_id}` },
      };
    }

    if (!result.success) {
      return {
        success: false,
        llmContent: {
          shell_id: params.shell_id,
          status: result.status,
          stdin_closed: result.stdinClosed,
          error: result.errorMessage,
        },
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: result.errorMessage || 'Failed to write Shell stdin',
        },
        metadata: { ...result, summary: `Failed to write Shell: ${params.shell_id}` },
      };
    }

    return {
      success: true,
      llmContent: {
        shell_id: params.shell_id,
        status: result.status,
        bytes_written: result.bytesWritten,
        stdin_closed: result.stdinClosed,
      },
      metadata: {
        ...result,
        shell_id: params.shell_id,
        summary: `Sent ${result.bytesWritten} bytes to Shell: ${params.shell_id}`,
      },
    };
  },

  version: '1.0.0',
  category: '命令工具',
  tags: ['bash', 'shell', 'stdin', 'interactive'],
  extractSignatureContent: (params) => params.shell_id,
  abstractPermissionRule: () => '*',
});

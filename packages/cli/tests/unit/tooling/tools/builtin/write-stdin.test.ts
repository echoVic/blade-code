import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBuiltinTools } from '../../../../../src/tools/builtin/index.js';

const shellManagerMocks = vi.hoisted(() => ({
  writeInput: vi.fn(),
}));

vi.mock('../../../../../src/tools/builtin/shell/BackgroundShellManager.js', () => ({
  BackgroundShellManager: {
    getInstance: () => ({ writeInput: shellManagerMocks.writeInput }),
  },
}));

vi.mock('../../../../../src/mcp/McpRegistry.js', () => ({
  McpRegistry: {
    getInstance: () => ({ getAvailableTools: async () => [] }),
  },
}));

async function getWriteStdinTool() {
  const tool = (await getBuiltinTools({ sessionId: 'session-a' })).find(
    (candidate) => candidate.name === 'WriteStdin'
  );
  expect(tool).toBeDefined();
  if (!tool) throw new Error('WriteStdin tool is not registered');
  return tool;
}

describe('WriteStdin tool', () => {
  beforeEach(() => {
    shellManagerMocks.writeInput.mockReset();
  });

  it('is not retry-safe because stdin writes are externally visible', async () => {
    expect((await getWriteStdinTool()).isRetrySafe).toBe(false);
  });

  it('writes input to a shell owned by the active session', async () => {
    shellManagerMocks.writeInput.mockResolvedValue({
      success: true,
      status: 'running',
      bytesWritten: 6,
      stdinClosed: false,
    });
    const tool = await getWriteStdinTool();

    const result = await tool.execute(
      { shell_id: 'bash_owned', data: 'hello\n', close_stdin: false },
      undefined,
      { sessionId: 'session-a' }
    );

    expect(shellManagerMocks.writeInput).toHaveBeenCalledWith(
      'bash_owned',
      'session-a',
      'hello\n',
      false
    );
    expect(result).toMatchObject({
      success: true,
      llmContent: {
        shell_id: 'bash_owned',
        bytes_written: 6,
        stdin_closed: false,
      },
      metadata: { summary: 'Sent 6 bytes to Shell: bash_owned' },
    });
  });

  it('fails closed without an active session', async () => {
    const tool = await getWriteStdinTool();

    const result = await tool.execute(
      { shell_id: 'bash_owned', data: 'hello\n', close_stdin: false },
      undefined,
      {}
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('validation_error');
    expect(shellManagerMocks.writeInput).not.toHaveBeenCalled();
  });

  it('does not reveal whether another session owns the shell', async () => {
    shellManagerMocks.writeInput.mockResolvedValue(undefined);
    const tool = await getWriteStdinTool();

    const result = await tool.execute(
      { shell_id: 'bash_private', data: 'hello\n', close_stdin: true },
      undefined,
      { sessionId: 'session-other' }
    );

    expect(result.success).toBe(false);
    expect(result.llmContent).toBe('Shell not found: bash_private');
    expect(result.error?.message).not.toContain('session');
  });
});

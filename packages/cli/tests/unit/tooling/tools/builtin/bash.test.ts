import { spawn } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { bashTool } from '../../../../../src/tools/builtin/shell/bash.js';

describe('Bash Tool', () => {
  beforeAll(async () => {
    const childProcess =
      await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawn).mockImplementation(childProcess.spawn);
  });

  it('reports a non-zero foreground exit as a tool failure', async () => {
    const result = await bashTool.execute({
      command:
        'node -e \"process.stderr.write(\\\"expected failure\\\"); process.exit(7)\"',
      timeout: 10_000,
      env: {},
      run_in_background: false,
    });

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('execution_error');
    expect(result.error?.message).toContain('Command exited with code 7');
    expect(result.error?.message).toContain('stderr:\nexpected failure');
    expect(result.llmContent).toMatchObject({
      stderr: 'expected failure',
      exit_code: 7,
    });
    expect(result.metadata).toMatchObject({
      exit_code: 7,
      has_stderr: true,
    });
  });
});

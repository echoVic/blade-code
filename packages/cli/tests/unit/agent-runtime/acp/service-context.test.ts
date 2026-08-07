import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AcpServiceContext,
  getAcpFileSystemService,
  getTerminalService,
} from '../../../../src/acp/AcpServiceContext.js';

function connection(label: string) {
  return {
    readTextFile: vi.fn(
      async ({ path, sessionId }: { path: string; sessionId: string }) => ({
        content: `${label}:${sessionId}:${path}`,
      })
    ),
    writeTextFile: vi.fn(async () => undefined),
    createTerminal: vi.fn(
      async ({ sessionId, cwd }: { sessionId: string; cwd?: string }) => ({
        currentOutput: vi.fn(async () => ({
          output: `${label}:${sessionId}:${cwd ?? ''}`,
        })),
        waitForExit: vi.fn(async () => ({ exitCode: 0 })),
        kill: vi.fn(async () => undefined),
        release: vi.fn(async () => undefined),
      })
    ),
  };
}

describe('AcpServiceContext session isolation', () => {
  afterEach(() => {
    AcpServiceContext.destroySession('session-a');
    AcpServiceContext.destroySession('session-b');
  });

  it('resolves file services by session instead of the global current session', async () => {
    const connectionA = connection('a');
    const connectionB = connection('b');
    const capabilities = {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    };

    AcpServiceContext.initializeSession(
      connectionA as never,
      'session-a',
      capabilities as never,
      '/workspace/a'
    );
    AcpServiceContext.initializeSession(
      connectionB as never,
      'session-b',
      capabilities as never,
      '/workspace/b'
    );
    AcpServiceContext.setCurrentSession('session-b');

    await expect(
      getAcpFileSystemService('session-a').readTextFile('/workspace/a/file.ts')
    ).resolves.toBe('a:session-a:/workspace/a/file.ts');
    await expect(
      getAcpFileSystemService('session-b').readTextFile('/workspace/b/file.ts')
    ).resolves.toBe('b:session-b:/workspace/b/file.ts');

    await expect(
      getTerminalService('session-a').execute('git status', {
        cwd: '/workspace/a',
      })
    ).resolves.toMatchObject({
      success: true,
      stdout: 'a:session-a:/workspace/a',
    });
    expect(connectionA.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-a',
        cwd: '/workspace/a',
      })
    );
  });
});

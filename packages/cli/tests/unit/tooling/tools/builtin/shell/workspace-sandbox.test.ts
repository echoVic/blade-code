import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicWorkspaceSandboxBackend,
  type SandboxedCommand,
  type WorkspaceSandboxBackend,
  WorkspaceSandboxBoundaryError,
  type WorkspaceSandboxRuntime,
  WorkspaceSandboxUnavailableError,
  WorkspaceWriteSandbox,
} from '../../../../../../src/tools/builtin/shell/WorkspaceWriteSandbox.js';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blade-workspace-sandbox-'));
  tempRoots.push(root);
  return root;
}

function makeRuntime(
  overrides: Partial<WorkspaceSandboxRuntime> = {}
): WorkspaceSandboxRuntime {
  return {
    isSupportedPlatform: vi.fn(async () => true),
    checkDependencies: vi.fn(async () => ({ errors: [], warnings: [] })),
    getDefaultWritePaths: vi.fn(async () => []),
    initialize: vi.fn(async () => undefined),
    updateConfig: vi.fn(),
    wrapWithSandboxArgv: vi.fn(async () => ({
      argv: ['/bin/bash', '-c', 'sandboxed-command'],
      env: { SANDBOX_RUNTIME: '1' },
    })),
    cleanupAfterCommand: vi.fn(),
    reset: vi.fn(async () => undefined),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('WorkspaceWriteSandbox', () => {
  it('canonicalizes the workspace and cwd before delegating', async () => {
    const root = await makeTempRoot();
    const workspaceRoot = path.join(root, 'workspace');
    const cwd = path.join(workspaceRoot, 'packages', 'demo');
    await mkdir(cwd, { recursive: true });
    const prepare = vi.fn(
      async (): Promise<SandboxedCommand> => ({
        executable: '/bin/bash',
        args: ['-c', 'sandboxed-command'],
        env: {},
        sandboxed: true,
        cleanup: () => undefined,
      })
    );
    const backend: WorkspaceSandboxBackend = { prepare };
    const sandbox = new WorkspaceWriteSandbox(backend);

    await sandbox.prepare({
      command: 'npm test',
      cwd,
      workspaceRoot,
    });

    expect(prepare).toHaveBeenCalledWith({
      command: 'npm test',
      cwd: await realpath(cwd),
      workspaceRoot: await realpath(workspaceRoot),
      signal: undefined,
    });
  });

  it('rejects lexical and symlink cwd escapes before invoking the backend', async () => {
    const root = await makeTempRoot();
    const workspaceRoot = path.join(root, 'workspace');
    const outsideRoot = path.join(root, 'outside');
    await mkdir(workspaceRoot);
    await mkdir(outsideRoot);
    await symlink(outsideRoot, path.join(workspaceRoot, 'linked'), 'dir');
    const prepare = vi.fn();
    const sandbox = new WorkspaceWriteSandbox({ prepare });

    await expect(
      sandbox.prepare({
        command: 'pwd',
        cwd: outsideRoot,
        workspaceRoot,
      })
    ).rejects.toBeInstanceOf(WorkspaceSandboxBoundaryError);
    await expect(
      sandbox.prepare({
        command: 'pwd',
        cwd: path.join(workspaceRoot, 'linked'),
        workspaceRoot,
      })
    ).rejects.toBeInstanceOf(WorkspaceSandboxBoundaryError);
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe('AnthropicWorkspaceSandboxBackend', () => {
  it('allows writes only to the workspace and dedicated temp root', async () => {
    const root = await makeTempRoot();
    const workspaceRoot = path.join(root, 'workspace');
    const tempRoot = path.join(root, 'sandbox-temp');
    await mkdir(workspaceRoot);
    const canonicalWorkspace = await realpath(workspaceRoot);
    const runtime = makeRuntime();
    let wrappedTmpDir: string | undefined;
    vi.mocked(runtime.wrapWithSandboxArgv).mockImplementation(async () => {
      wrappedTmpDir = process.env.CLAUDE_CODE_TMPDIR;
      return {
        argv: ['/bin/bash', '-c', 'sandboxed-command'],
        env: { SANDBOX_RUNTIME: '1' },
      };
    });
    const originalTmpDir = process.env.CLAUDE_CODE_TMPDIR;
    const backend = new AnthropicWorkspaceSandboxBackend({
      runtime,
      tempRoot,
      defaultWritePaths: ['/dev/null', '/tmp/claude', '/home/user/.npm/_logs'],
    });

    const command = await backend.prepare({
      command: 'npm test',
      cwd: canonicalWorkspace,
      workspaceRoot: canonicalWorkspace,
    });

    expect(runtime.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        network: {
          allowedDomains: ['*'],
          deniedDomains: [],
          strictAllowlist: true,
        },
        filesystem: {
          denyRead: [],
          allowRead: [],
          allowWrite: [],
          denyWrite: [],
        },
      })
    );
    expect(runtime.wrapWithSandboxArgv).toHaveBeenCalledWith(
      'npm test',
      expect.any(String),
      expect.objectContaining({
        filesystem: {
          denyRead: [],
          allowRead: [],
          allowWrite: [canonicalWorkspace, await realpath(tempRoot)],
          denyWrite: ['/tmp/claude', '/home/user/.npm/_logs'],
        },
        git: {
          safeDirectories: [canonicalWorkspace],
        },
      }),
      undefined,
      canonicalWorkspace
    );
    expect(command).toEqual(
      expect.objectContaining({
        executable: '/bin/bash',
        args: ['-c', 'sandboxed-command'],
        sandboxed: true,
        env: expect.objectContaining({
          SANDBOX_RUNTIME: '1',
          TMPDIR: expect.stringContaining('sandbox-temp'),
          XDG_CACHE_HOME: expect.stringContaining('sandbox-temp'),
        }),
      })
    );
    expect(wrappedTmpDir).toBe(path.join(await realpath(tempRoot), 'tmp'));
    expect(process.env.CLAUDE_CODE_TMPDIR).toBe(originalTmpDir);

    command.cleanup();
    expect(runtime.cleanupAfterCommand).toHaveBeenCalledOnce();
  });

  it('denies workspace writes for verification commands', async () => {
    const root = await makeTempRoot();
    const workspaceRoot = path.join(root, 'workspace');
    const tempRoot = path.join(root, 'sandbox-temp');
    await mkdir(workspaceRoot);
    const canonicalWorkspace = await realpath(workspaceRoot);
    const runtimeExecutable = await realpath(process.execPath);
    const runtime = makeRuntime();
    const backend = new AnthropicWorkspaceSandboxBackend({
      runtime,
      tempRoot,
      defaultWritePaths: ['/dev/null', '/home/user/.npm/_logs'],
    });

    const command = await backend.prepare({
      command: 'npm test',
      cwd: canonicalWorkspace,
      workspaceRoot: canonicalWorkspace,
      access: 'workspace-read-only',
    });

    expect(runtime.wrapWithSandboxArgv).toHaveBeenCalledWith(
      'npm test',
      expect.any(String),
      expect.objectContaining({
        network: {
          allowedDomains: [],
          deniedDomains: [],
          strictAllowlist: true,
        },
        filesystem: {
          denyRead: expect.arrayContaining([path.resolve(os.homedir())]),
          allowRead: [canonicalWorkspace, runtimeExecutable, await realpath(tempRoot)],
          allowWrite: [await realpath(tempRoot)],
          denyWrite: [canonicalWorkspace, '/home/user/.npm/_logs'],
        },
      }),
      undefined,
      canonicalWorkspace
    );
    expect(runtime.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        network: expect.objectContaining({ allowedDomains: [] }),
      })
    );

    command.cleanup();
    expect(runtime.updateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        network: expect.objectContaining({ allowedDomains: ['*'] }),
      })
    );
  });

  it('fails closed when the platform or dependencies cannot enforce sandboxing', async () => {
    const root = await makeTempRoot();
    const workspaceRoot = path.join(root, 'workspace');
    await mkdir(workspaceRoot);
    const unsupportedRuntime = makeRuntime({
      isSupportedPlatform: vi.fn(async () => false),
    });
    const missingDependencyRuntime = makeRuntime({
      checkDependencies: vi.fn(async () => ({
        errors: ['bubblewrap not found'],
        warnings: [],
      })),
    });

    await expect(
      new AnthropicWorkspaceSandboxBackend({
        runtime: unsupportedRuntime,
        tempRoot: path.join(root, 'unsupported-temp'),
      }).prepare({
        command: 'npm test',
        cwd: workspaceRoot,
        workspaceRoot,
      })
    ).rejects.toBeInstanceOf(WorkspaceSandboxUnavailableError);
    await expect(
      new AnthropicWorkspaceSandboxBackend({
        runtime: missingDependencyRuntime,
        tempRoot: path.join(root, 'missing-dependency-temp'),
      }).prepare({
        command: 'npm test',
        cwd: workspaceRoot,
        workspaceRoot,
      })
    ).rejects.toThrow('bubblewrap not found');

    expect(unsupportedRuntime.wrapWithSandboxArgv).not.toHaveBeenCalled();
    expect(missingDependencyRuntime.wrapWithSandboxArgv).not.toHaveBeenCalled();
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoVerifyRuntime } from '../../../../../src/tools/execution/AutoVerify.js';
import type { ToolResult } from '../../../../../src/tools/types/index.js';

function createWorkspace(script = 'tsc --noEmit'): {
  workspace: string;
  source: string;
} {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'blade-auto-verify-'));
  const source = path.join(workspace, 'source.ts');
  writeFileSync(path.join(workspace, 'tsconfig.json'), '{}\n');
  writeFileSync(
    path.join(workspace, 'package.json'),
    `${JSON.stringify({ scripts: { 'type-check': script } }, null, 2)}\n`
  );
  writeFileSync(source, 'export const value = missingValue;\n');
  return { workspace, source };
}

function successfulResult(): ToolResult {
  return {
    success: true,
    llmContent: 'File updated',
  };
}

describe('AutoVerifyRuntime', () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('requires an explicit trust decision before executing a package script', async () => {
    const { workspace, source } = createWorkspace();
    workspaces.push(workspace);
    const runCommand = vi.fn();
    const runtime = new AutoVerifyRuntime({
      sessionId: 'untrusted-session',
      workspaceRoot: workspace,
      projectRoot: workspace,
      environment: {},
      resolveTrust: async () => false,
      isRemoteSession: () => false,
      runCommand,
    });

    await runtime.verify(
      'Write',
      { file_path: source },
      { workspaceRoot: workspace },
      successfulResult()
    );

    expect(runCommand).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it('never executes a local verifier for an ACP-owned file', async () => {
    const { workspace, source } = createWorkspace();
    workspaces.push(workspace);
    const runCommand = vi.fn();
    const runtime = new AutoVerifyRuntime({
      sessionId: 'acp-session',
      workspaceRoot: workspace,
      projectRoot: workspace,
      environment: {},
      resolveTrust: async () => true,
      isRemoteSession: () => true,
      runCommand,
    });

    await runtime.verify(
      'Edit',
      { file_path: source },
      { workspaceRoot: workspace },
      successfulResult()
    );

    expect(runCommand).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it('injects bounded file-specific type errors through a Session queue', async () => {
    const { workspace, source } = createWorkspace();
    workspaces.push(workspace);
    const runCommand = vi.fn().mockResolvedValue({
      stdout: `${source}(1,22): error TS2304: Cannot find name 'missingValue'.`,
      stderr: '',
      exitCode: 1,
      timedOut: false,
    });
    const runtime = new AutoVerifyRuntime({
      sessionId: 'trusted-session',
      workspaceRoot: workspace,
      projectRoot: workspace,
      environment: { SESSION_MARKER: 'isolated' },
      resolveTrust: async () => true,
      isRemoteSession: () => false,
      runCommand,
    });
    const result = successfulResult();

    await runtime.verify(
      'Write',
      { file_path: source },
      { workspaceRoot: workspace },
      result
    );

    expect(runCommand).toHaveBeenCalledWith(
      'npm',
      ['run', 'type-check'],
      workspace,
      10_000,
      expect.any(AbortSignal)
    );
    expect(result.llmContent).toContain('TS2304');
    await runtime.dispose();
  });

  it('verifies one ApplyPatch transaction and filters diagnostics for every file', async () => {
    const { workspace, source } = createWorkspace();
    workspaces.push(workspace);
    const second = path.join(workspace, 'second.ts');
    writeFileSync(second, 'export const second = missingSecond;\n');
    const runCommand = vi.fn().mockResolvedValue({
      stdout: `${second}(1,23): error TS2304: Cannot find name 'missingSecond'.`,
      stderr: '',
      exitCode: 1,
      timedOut: false,
    });
    const runtime = new AutoVerifyRuntime({
      sessionId: 'patch-session',
      workspaceRoot: workspace,
      projectRoot: workspace,
      environment: {},
      resolveTrust: async () => true,
      isRemoteSession: () => false,
      runCommand,
    });
    const result: ToolResult = {
      success: true,
      llmContent: 'Patch applied',
      metadata: {
        kind: 'patch',
        changes: [
          { path: source, newContent: 'changed' },
          { path: second, newContent: 'changed' },
        ],
      },
    };

    await runtime.verify('ApplyPatch', {}, { workspaceRoot: workspace }, result);

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(result.llmContent).toContain('2 patched files');
    expect(result.llmContent).toContain('missingSecond');
    await runtime.dispose();
  });

  it('aborts and awaits an in-flight verifier during Session disposal', async () => {
    const { workspace, source } = createWorkspace();
    workspaces.push(workspace);
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      commandStarted = resolve;
    });
    let commandSignal: AbortSignal | undefined;
    const runCommand = vi.fn(
      async (
        _command: string,
        _args: string[],
        _cwd: string,
        _timeoutMs: number,
        signal?: AbortSignal
      ) => {
        commandSignal = signal;
        commandStarted();
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
          if (signal?.aborted) resolve();
        });
        return {
          stdout: '',
          stderr: '',
          exitCode: 1,
          timedOut: false,
        };
      }
    );
    const runtime = new AutoVerifyRuntime({
      sessionId: 'dispose-session',
      workspaceRoot: workspace,
      projectRoot: workspace,
      environment: {},
      resolveTrust: async () => true,
      isRemoteSession: () => false,
      runCommand,
    });
    const verification = runtime.verify(
      'Write',
      { file_path: source },
      { workspaceRoot: workspace },
      successfulResult()
    );

    await started;
    await runtime.dispose();
    await verification;

    expect(commandSignal?.aborted).toBe(true);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});

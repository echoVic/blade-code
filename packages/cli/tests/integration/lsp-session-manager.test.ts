import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LspSessionManager } from '../../src/lsp/LspSessionManager.js';
import { createLspTool } from '../../src/tools/builtin/lsp/index.js';
import { executeToolInvocation } from '../../src/tools/execution/ToolInvocationRunner.js';
import type { ToolResult } from '../../src/tools/types/index.js';

const fixture = path.resolve(import.meta.dirname, '../support/fake-lsp-server.mjs');

vi.unmock('child_process');
vi.unmock('node:child_process');

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('Session-scoped LSP integration', () => {
  const roots: string[] = [];
  const managers: LspSessionManager[] = [];

  afterEach(async () => {
    await Promise.allSettled(managers.splice(0).map((manager) => manager.dispose()));
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  async function createFixture(label: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), `blade-lsp-${label}-`));
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    const source = path.join(workspace, 'source.ts');
    const trace = path.join(root, 'trace.jsonl');
    const pidFile = path.join(root, 'server.pid');
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(workspace, { recursive: true })
    );
    await writeFile(source, 'const value = missingSymbol;\n');
    return { root, workspace, source, trace, pidFile };
  }

  function createManager(
    fixtureState: Awaited<ReturnType<typeof createFixture>>,
    sessionId: string,
    remote = false,
    serverEnvironment: Record<string, string> = {}
  ) {
    const manager = new LspSessionManager({
      sessionId,
      workspaceRoot: fixtureState.workspace,
      environment: { LSP_SESSION_MARKER: sessionId },
      isRemoteSession: () => remote,
      servers: {
        typescript: {
          command: process.execPath,
          args: [fixture],
          extensionToLanguage: { '.ts': 'typescript' },
          env: {
            LSP_TRACE_FILE: fixtureState.trace,
            LSP_PID_FILE: fixtureState.pidFile,
            ...serverEnvironment,
          },
          settings: { blade: { fixture: true } },
          diagnosticWaitTimeout: 2_000,
          startupTimeout: 5_000,
          shutdownTimeout: 2_000,
          requestTimeout: 5_000,
          maxRestarts: 1,
        },
      },
    });
    managers.push(manager);
    return manager;
  }

  it('shares one real stdio server across queries and post-edit diagnostics', async () => {
    const state = await createFixture('protocol');
    const manager = createManager(state, 'lsp-session-a');
    const writeResult: ToolResult = {
      success: true,
      llmContent: 'File updated',
      metadata: {},
    };

    await manager.afterToolUse('Write', { file_path: state.source }, writeResult, {
      sessionId: 'lsp-session-a',
      workspaceRoot: state.workspace,
    });

    expect(String(writeResult.llmContent)).toContain('<new-diagnostics>');
    expect(String(writeResult.llmContent)).toContain('FAKE1001');
    expect(writeResult.metadata?.lsp_diagnostic_count).toBe(1);

    const tool = createLspTool(manager);
    const definition = await tool.execute({
      operation: 'goToDefinition',
      filePath: state.source,
      line: 1,
      character: 7,
      query: '',
    });
    const hover = await tool.execute({
      operation: 'hover',
      filePath: state.source,
      line: 1,
      character: 7,
      query: '',
    });
    const incoming = await tool.execute({
      operation: 'incomingCalls',
      filePath: state.source,
      line: 1,
      character: 7,
      query: '',
    });

    expect(definition.success).toBe(true);
    expect(definition.llmContent).toContain('source.ts:2:3');
    expect(hover.llmContent).toContain('FakeType');
    expect(incoming.llmContent).toContain('caller');

    const deletedFile = path.join(state.workspace, 'deleted.ts');
    const patchedFile = path.join(state.workspace, 'patched.ts');
    await writeFile(deletedFile, 'export const deleted = true;\n');
    await tool.execute({
      operation: 'hover',
      filePath: deletedFile,
      line: 1,
      character: 7,
      query: '',
    });
    await rm(deletedFile);
    await writeFile(patchedFile, 'const value = missingSymbol;\n');
    const patchResult: ToolResult = {
      success: true,
      llmContent: 'Patch applied',
      metadata: {
        kind: 'patch',
        changes: [
          { path: deletedFile, oldContent: 'x', newContent: null },
          {
            path: patchedFile,
            oldContent: null,
            newContent: 'const value = missingSymbol;\n',
          },
        ],
      },
    };
    await manager.afterToolUse('ApplyPatch', {}, patchResult, {
      sessionId: 'lsp-session-a',
      workspaceRoot: state.workspace,
    });
    expect(String(patchResult.llmContent)).toContain('FAKE1001');

    expect(manager.getStatus()).toMatchObject([
      {
        name: 'typescript',
        state: 'running',
        restartCount: 0,
        extensions: ['.ts'],
      },
    ]);

    const pid = Number(await readFile(state.pidFile, 'utf8'));
    await expect
      .poll(async () => (await readFile(state.trace, 'utf8')).includes('"didClose"'))
      .toBe(true);
    const traceBeforeDispose = (await readFile(state.trace, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(traceBeforeDispose).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'initialize',
          cwd: manager.workspacePath,
          sessionId: 'lsp-session-a',
          sessionMarker: 'lsp-session-a',
        }),
        expect.objectContaining({ event: 'didOpen' }),
        expect.objectContaining({ event: 'didChange' }),
        expect.objectContaining({ event: 'didSave' }),
        expect.objectContaining({ event: 'didClose' }),
      ])
    );

    await manager.dispose();
    await expect.poll(() => processExists(pid)).toBe(false);
    expect(await readFile(state.trace, 'utf8')).toContain('"event":"exit"');
  });

  it('isolates server processes by Session and disables local LSP for ACP', async () => {
    const first = await createFixture('first');
    const second = await createFixture('second');
    const remote = await createFixture('remote');
    const managerA = createManager(first, 'session-a');
    const managerB = createManager(second, 'session-b');
    const remoteManager = createManager(remote, 'session-acp', true);

    await Promise.all([
      managerA.query({
        operation: 'hover',
        filePath: first.source,
        line: 1,
        character: 7,
      }),
      managerB.query({
        operation: 'hover',
        filePath: second.source,
        line: 1,
        character: 7,
      }),
    ]);

    await expect(
      remoteManager.query({
        operation: 'hover',
        filePath: remote.source,
        line: 1,
        character: 7,
      })
    ).rejects.toThrow('ACP-owned remote files');
    await expect(access(remote.pidFile)).rejects.toThrow();

    const traceA = await readFile(first.trace, 'utf8');
    const traceB = await readFile(second.trace, 'utf8');
    expect(traceA).toContain('"sessionId":"session-a"');
    expect(traceA).not.toContain('session-b');
    expect(traceB).toContain('"sessionId":"session-b"');
    expect(traceB).not.toContain('session-a');

    const [pidA, pidB] = await Promise.all([
      readFile(first.pidFile, 'utf8').then(Number),
      readFile(second.pidFile, 'utf8').then(Number),
    ]);
    expect(pidA).not.toBe(pidB);
    await Promise.all([
      managerA.dispose(),
      managerB.dispose(),
      remoteManager.dispose(),
    ]);
    await expect.poll(() => processExists(pidA)).toBe(false);
    await expect.poll(() => processExists(pidB)).toBe(false);
  });

  it('retries a transient LSP failure identified only by errno', async () => {
    const state = await createFixture('transient-retry');
    const manager = createManager(state, 'session-transient-retry');
    const query = vi.spyOn(manager, 'query').mockRejectedValueOnce(
      Object.assign(new Error('resource temporarily unavailable'), {
        code: 'EAGAIN',
      })
    );
    const tool = createLspTool(manager);

    const result = await executeToolInvocation(
      tool.build({
        operation: 'hover',
        filePath: state.source,
        line: 1,
        character: 7,
        query: '',
      }),
      {}
    );

    expect(result).toMatchObject({
      success: true,
      metadata: { retriedAttempts: 1 },
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('restarts one crashed server and cancels bounded requests', async () => {
    const crashState = await createFixture('crash');
    const crashFile = path.join(crashState.root, 'crashed-once');
    const crashChildPidFile = path.join(crashState.root, 'crash-child.pid');
    const crashManager = createManager(crashState, 'session-crash', false, {
      LSP_CRASH_ONCE_FILE: crashFile,
      LSP_CRASH_CHILD_PID_FILE: crashChildPidFile,
    });
    const hover = {
      operation: 'hover' as const,
      filePath: crashState.source,
      line: 1,
      character: 7,
    };

    await expect(crashManager.query(hover)).rejects.toThrow();
    await expect.poll(() => crashManager.getStatus()[0]?.state).toBe('error');
    const firstPid = Number(await readFile(crashState.pidFile, 'utf8'));
    const crashChildPid = Number(await readFile(crashChildPidFile, 'utf8'));
    await expect(crashManager.query(hover)).resolves.toMatchObject({
      operation: 'hover',
      serverName: 'typescript',
    });
    const secondPid = Number(await readFile(crashState.pidFile, 'utf8'));
    expect(secondPid).not.toBe(firstPid);
    expect(crashManager.getStatus()[0]?.restartCount).toBe(1);
    await expect.poll(() => processExists(crashChildPid)).toBe(false);

    const delayState = await createFixture('cancel');
    const delayManager = createManager(delayState, 'session-cancel', false, {
      LSP_HOVER_DELAY_MS: '1000',
    });
    const controller = new AbortController();
    const delayed = delayManager.query(
      {
        operation: 'hover',
        filePath: delayState.source,
        line: 1,
        character: 7,
      },
      controller.signal
    );
    setTimeout(() => controller.abort(), 30);
    await expect(delayed).rejects.toThrow('aborted');

    await Promise.all([crashManager.dispose(), delayManager.dispose()]);
  });
});

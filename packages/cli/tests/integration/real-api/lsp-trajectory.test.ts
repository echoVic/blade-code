import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../../src/agent/Agent.js';
import { drainLoop, type LoopEvent } from '../../../src/agent/loop/index.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import type { ChatContext } from '../../../src/agent/types.js';
import { setCwdState } from '../../../src/bootstrap/state.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { PermissionMode } from '../../../src/config/types.js';
import { resetWorkspaceIdentityCache } from '../../../src/security/WorkspaceIdentity.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { getState } from '../../../src/store/vanilla.js';
import { getCwd } from '../../../src/utils/cwd.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveForkQualificationModels,
} from './testConfig.js';

const gpt = isRealApiTestEnabled()
  ? resolveForkQualificationModels(process.env).find((model) => model.id === 'gpt')
  : undefined;
const describeReal = gpt ? describe.sequential : describe.skip;
const fakeServer = path.resolve(
  import.meta.dirname,
  '../../support/fake-lsp-server.mjs'
);

describeReal('Session LSP trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it('uses semantic queries and receives post-edit diagnostics', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-lsp-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const storageRoot = path.join(root, 'storage');
    const source = path.join(workspace, 'source.ts');
    const diagnosticTarget = path.join(workspace, 'diagnostic.ts');
    const trace = path.join(root, 'lsp-trace.jsonl');
    const pidFile = path.join(root, 'lsp.pid');
    await mkdir(path.join(workspace, '.blade'), { recursive: true });
    await mkdir(path.join(home, '.blade'), { recursive: true });
    await writeFile(source, 'export const value = "ready";\n');

    const originalCwd = getCwd();
    const originalConfig = getState().config.config;
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    let runtime: SessionRuntime | undefined;
    let agent: Agent | undefined;

    try {
      process.env.BLADE_STORAGE_ROOT = storageRoot;
      setCwdState(workspace);
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();

      await writeFile(
        path.join(home, '.blade', 'config.json'),
        `${JSON.stringify(buildRealApiRuntimeConfig(gpt), null, 2)}\n`
      );
      await writeFile(
        path.join(workspace, '.blade', 'config.json'),
        `${JSON.stringify(
          {
            lspServers: {
              qualification: {
                command: process.execPath,
                args: [fakeServer],
                extensionToLanguage: { '.ts': 'typescript' },
                env: {
                  LSP_TRACE_FILE: trace,
                  LSP_PID_FILE: pidFile,
                },
                diagnosticWaitTimeout: 2_000,
              },
            },
          },
          null,
          2
        )}\n`
      );
      await WorkspaceTrustService.getInstance().trust(workspace);
      const config = await ConfigManager.getInstance().initialize();
      getState().config.actions.setConfig(config);

      const sessionId = `real-lsp-${Date.now()}`;
      runtime = await SessionRuntime.create({ sessionId, workspaceRoot: workspace });
      agent = await Agent.createWithRuntime(runtime, {
        sessionId,
        toolWhitelist: ['ToolSearch', 'LSP', 'Write'],
        permissionMode: PermissionMode.YOLO,
        maxTurns: 8,
      });
      const context: ChatContext = {
        messages: [],
        userId: 'real-lsp-qualification',
        sessionId,
        workspaceRoot: workspace,
        permissionMode: PermissionMode.YOLO,
      };
      const queryEvents: LoopEvent[] = [];
      const query = await drainLoop(
        agent.chatStream(
          [
            'Call ToolSearch to load the LSP code-intelligence tool.',
            `Then call LSP exactly once with operation hover for ${source}, line 1, character 14.`,
            'Do not use text search or Bash.',
            'If the LSP result contains FakeType, reply exactly LSP_QUERY_OK.',
          ].join(' '),
          context,
          { stream: true }
        ),
        (event) => {
          queryEvents.push(event);
        }
      );
      expect(query.success).toBe(true);
      expect(query.finalMessage).toContain('LSP_QUERY_OK');
      const lspResults = queryEvents.filter(
        (event): event is Extract<LoopEvent, { kind: 'tool_result' }> =>
          event.kind === 'tool_result' &&
          'function' in event.toolCall &&
          event.toolCall.function.name === 'LSP'
      );
      expect(lspResults).toHaveLength(1);
      expect(JSON.stringify(lspResults[0]?.result.llmContent)).toContain('FakeType');

      const diagnosticEvents: LoopEvent[] = [];
      const diagnostic = await drainLoop(
        agent.chatStream(
          [
            `Call Write exactly once to create ${diagnosticTarget} with:`,
            'const value = missingSymbol;',
            'Do not call LSP, Bash, or any other tool.',
            'If the Write result contains FAKE1001, reply exactly LSP_DIAGNOSTIC_OK.',
          ].join(' '),
          context,
          { stream: true }
        ),
        (event) => {
          diagnosticEvents.push(event);
        }
      );
      const writes = diagnosticEvents.filter(
        (event): event is Extract<LoopEvent, { kind: 'tool_result' }> =>
          event.kind === 'tool_result' &&
          'function' in event.toolCall &&
          event.toolCall.function.name === 'Write'
      );
      expect(diagnostic.success).toBe(true);
      expect(diagnostic.finalMessage).toContain('LSP_DIAGNOSTIC_OK');
      expect(writes).toHaveLength(1);
      expect(JSON.stringify(writes[0]?.result.llmContent)).toContain('FAKE1001');
      expect((await readFile(diagnosticTarget, 'utf8')).trim()).toBe(
        'const value = missingSymbol;'
      );
      expect(await access(trace)).toBeUndefined();
      const pid = Number(await readFile(pidFile, 'utf8'));
      assertNoSecrets({ query, diagnostic, queryEvents, diagnosticEvents }, [
        gpt.apiKey,
      ]);

      await agent.destroy();
      agent = undefined;
      await runtime.dispose();
      runtime = undefined;
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
      expect(await readFile(trace, 'utf8')).toContain('"event":"exit"');
    } finally {
      await agent?.destroy().catch(() => undefined);
      await runtime?.dispose().catch(() => undefined);
      homedirSpy.mockRestore();
      setCwdState(originalCwd);
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});

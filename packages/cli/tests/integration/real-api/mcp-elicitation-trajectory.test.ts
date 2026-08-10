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
  '../../support/fake-mcp-elicitation-server.mjs'
);

describeReal('MCP elicitation trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it('lets a real GPT tool call consume form input and continue coding', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-mcp-elicitation-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const output = path.join(workspace, 'release-profile.txt');
    const pidFile = path.join(root, 'mcp.pid');
    await mkdir(path.join(workspace, '.blade'), { recursive: true });
    await mkdir(path.join(home, '.blade'), { recursive: true });

    const originalCwd = getCwd();
    const originalConfig = getState().config.config;
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    let runtime: SessionRuntime | undefined;
    let agent: Agent | undefined;
    try {
      process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
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
            mcpServers: {
              elicitation: {
                type: 'stdio',
                command: process.execPath,
                args: [fakeServer],
                env: {
                  MCP_ELICITATION_PID_FILE: pidFile,
                },
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

      const sessionId = `real-mcp-elicitation-${Date.now()}`;
      runtime = await SessionRuntime.create({ sessionId, workspaceRoot: workspace });
      agent = await Agent.createWithRuntime(runtime, {
        sessionId,
        toolWhitelist: ['ToolSearch', 'mcp__elicitation__collect_profile', 'Write'],
        permissionMode: PermissionMode.YOLO,
        maxTurns: 8,
      });
      const elicitationRequests: unknown[] = [];
      const context: ChatContext = {
        messages: [],
        userId: 'real-mcp-elicitation-qualification',
        sessionId,
        workspaceRoot: workspace,
        permissionMode: PermissionMode.YOLO,
        confirmationHandler: {
          requestConfirmation: async (details) => {
            expect(details.type).toBe('mcpElicitation');
            elicitationRequests.push(details.mcpElicitation);
            return {
              approved: true,
              elicitation: {
                action: 'accept',
                content: {
                  channel: 'stable',
                  notifications: true,
                  retries: 2,
                  owner: 'release-owner@example.test',
                },
              },
            };
          },
        },
      };
      const events: LoopEvent[] = [];
      const result = await drainLoop(
        agent.chatStream(
          [
            'First call ToolSearch to load mcp__elicitation__collect_profile.',
            'Then call mcp__elicitation__collect_profile exactly once and use the returned JSON profile.',
            'The selected values are available only in that MCP result; do not invent them.',
            `Then call Write exactly once to create ${output}.`,
            'Write one key=value line for channel, notifications, retries, and owner,',
            'in that exact key order, followed by one final newline.',
            'Do not call any other tool.',
            'After Write succeeds, reply exactly MCP_ELICITATION_REAL_OK.',
          ].join(' '),
          context,
          { stream: true }
        ),
        (event) => {
          events.push(event);
        }
      );

      expect(result.success).toBe(true);
      expect(result.finalMessage).toContain('MCP_ELICITATION_REAL_OK');
      const toolResults = events.filter(
        (event): event is Extract<LoopEvent, { kind: 'tool_result' }> =>
          event.kind === 'tool_result' && 'function' in event.toolCall
      );
      expect(toolResults.map((event) => event.toolCall.function.name)).toEqual([
        'ToolSearch',
        'mcp__elicitation__collect_profile',
        'Write',
      ]);
      expect(elicitationRequests).toHaveLength(1);
      expect(elicitationRequests[0]).toMatchObject({
        serverName: 'elicitation',
        mode: 'form',
      });
      await expect(readFile(output, 'utf8')).resolves.toBe(
        [
          'channel=stable',
          'notifications=true',
          'retries=2',
          'owner=release-owner@example.test',
          '',
        ].join('\n')
      );
      await expect(access(pidFile)).resolves.toBeUndefined();
      const pid = Number(await readFile(pidFile, 'utf8'));
      assertNoSecrets({ result, events, elicitationRequests }, [gpt.apiKey]);

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

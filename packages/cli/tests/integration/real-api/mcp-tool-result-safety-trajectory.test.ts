import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
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
  '../../support/fake-mcp-tool-result-server.mjs'
);

describeReal('MCP tool result safety trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it('lets a real GPT consume safe rich output and read a private large-result artifact', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-mcp-result-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const output = path.join(workspace, 'mcp-result-proof.txt');
    const pidFile = path.join(root, 'mcp.pid');
    const traceFile = path.join(root, 'mcp-trace.jsonl');
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
              results: {
                type: 'stdio',
                command: process.execPath,
                args: [fakeServer],
                env: {
                  MCP_TOOL_RESULT_PID_FILE: pidFile,
                  MCP_TOOL_RESULT_TRACE_FILE: traceFile,
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

      const sessionId = `real-mcp-result-${Date.now()}`;
      runtime = await SessionRuntime.create({ sessionId, workspaceRoot: workspace });
      agent = await Agent.createWithRuntime(runtime, {
        sessionId,
        toolWhitelist: [
          'ToolSearch',
          'mcp__results__rich_result',
          'mcp__results__large_result',
          'Read',
          'Write',
        ],
        permissionMode: PermissionMode.YOLO,
        maxTurns: 14,
      });
      const context: ChatContext = {
        messages: [],
        userId: 'real-mcp-result-qualification',
        sessionId,
        workspaceRoot: workspace,
        permissionMode: PermissionMode.YOLO,
      };
      const events: LoopEvent[] = [];
      const result = await drainLoop(
        agent.chatStream(
          [
            'Follow this exact sequence and do not call any other tool.',
            'Call ToolSearch exactly once with query "select:mcp__results__rich_result,mcp__results__large_result" and max_results 10.',
            'Call mcp__results__rich_result and record RICH_TEXT_MARKER, RESOURCE_TEXT_MARKER, STRUCTURED_RESULT_MARKER, and that binary content is represented only by size and sha256.',
            'Call mcp__results__large_result. Its result contains a private absolute artifact path.',
            'Call Read exactly once with that exact artifact path and no offset or limit. Record LARGE_TAIL_MARKER from the artifact.',
            `Call Write exactly once to create ${output} with exactly these five lines followed by one newline:`,
            'text=RICH_TEXT_MARKER',
            'resource=RESOURCE_TEXT_MARKER',
            'structured=STRUCTURED_RESULT_MARKER',
            'large=LARGE_TAIL_MARKER',
            'binary=sha256-only',
            'After Write succeeds, reply exactly MCP_RESULT_SAFETY_REAL_OK.',
          ].join(' '),
          context,
          { stream: true }
        ),
        (event) => {
          events.push(event);
        }
      );

      expect(result.success).toBe(true);
      expect(result.finalMessage).toContain('MCP_RESULT_SAFETY_REAL_OK');
      expect((await readFile(output, 'utf8')).trimEnd()).toBe(
        [
          'text=RICH_TEXT_MARKER',
          'resource=RESOURCE_TEXT_MARKER',
          'structured=STRUCTURED_RESULT_MARKER',
          'large=LARGE_TAIL_MARKER',
          'binary=sha256-only',
        ].join('\n')
      );

      const toolResults = events.filter(
        (event): event is Extract<LoopEvent, { kind: 'tool_result' }> =>
          event.kind === 'tool_result'
      );
      const rich = toolResults.find(
        (event) =>
          'function' in event.toolCall &&
          event.toolCall.function.name === 'mcp__results__rich_result'
      );
      const large = toolResults.find(
        (event) =>
          'function' in event.toolCall &&
          event.toolCall.function.name === 'mcp__results__large_result'
      );
      expect(rich?.result.metadata?.mcpResult).toMatchObject({
        artifactCount: 2,
        binaryOmitted: true,
      });
      expect(large?.result.metadata?.mcpResult).toMatchObject({
        artifactCount: 1,
        truncated: true,
      });
      const artifactPath = (
        large?.result.metadata?.mcpResult as {
          artifacts?: Array<{ path?: string; kind?: string }>;
        }
      )?.artifacts?.find((artifact) => artifact.kind === 'text')?.path;
      expect(artifactPath).toBeDefined();
      expect((await stat(artifactPath!)).mode & 0o777).toBe(0o600);

      const serialized = JSON.stringify({ result, events });
      expect(serialized).not.toContain(
        Buffer.from('BINARY_IMAGE_SECRET').toString('base64')
      );
      expect(serialized).not.toContain('META_SECRET');
      assertNoSecrets({ result, events }, [gpt.apiKey]);

      await expect(access(pidFile)).resolves.toBeUndefined();
      const pid = Number(await readFile(pidFile, 'utf8'));
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
  }, 240_000);
});

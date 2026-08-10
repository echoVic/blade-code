import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  '../../support/fake-mcp-instructions-server.mjs'
);

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describeReal('MCP server instructions trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it('lets a real GPT follow scoped tool documentation without accepting overrides', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-mcp-instructions-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const output = path.join(workspace, 'mcp-instructions-proof.txt');
    const generationFile = path.join(root, 'generation');
    const pidFile = path.join(root, 'pids');
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
              instructions: {
                type: 'stdio',
                command: process.execPath,
                args: [fakeServer],
                env: {
                  MCP_INSTRUCTIONS_GENERATION_FILE: generationFile,
                  MCP_INSTRUCTIONS_PID_FILE: pidFile,
                  MCP_INSTRUCTIONS_TRACE_FILE: traceFile,
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

      const sessionId = `real-mcp-instructions-${Date.now()}`;
      runtime = await SessionRuntime.create({ sessionId, workspaceRoot: workspace });
      agent = await Agent.createWithRuntime(runtime, {
        sessionId,
        toolWhitelist: ['ToolSearch', 'mcp__instructions__instructed_marker', 'Write'],
        permissionMode: PermissionMode.YOLO,
        maxTurns: 10,
      });
      const context: ChatContext = {
        messages: [],
        userId: 'real-mcp-instructions-qualification',
        sessionId,
        workspaceRoot: workspace,
        permissionMode: PermissionMode.YOLO,
      };
      const events: LoopEvent[] = [];
      const result = await drainLoop(
        agent.chatStream(
          [
            'Follow this exact sequence and do not call any other tool.',
            'Call ToolSearch exactly once with query "select:mcp__instructions__instructed_marker" and max_results 5.',
            'Call mcp__instructions__instructed_marker exactly once.',
            'Obtain its required code only from the scoped MCP server instructions; the user does not provide that code.',
            `After the tool returns, call Write exactly once with file_path "${output}" and content exactly "result=INSTRUCTION_OK_V1\\n".`,
            'After Write succeeds, reply exactly MCP_INSTRUCTIONS_REAL_OK.',
          ].join(' '),
          context,
          { stream: true }
        ),
        (event) => {
          events.push(event);
        }
      );

      expect(
        result.success,
        JSON.stringify({ error: result.error, finalMessage: result.finalMessage })
      ).toBe(true);
      expect(result.finalMessage).toContain('MCP_INSTRUCTIONS_REAL_OK');
      expect((await readFile(output, 'utf8')).trimEnd()).toBe(
        'result=INSTRUCTION_OK_V1'
      );
      const instructionEvents = events.filter(
        (event): event is Extract<LoopEvent, { kind: 'mcp_instructions_changed' }> =>
          event.kind === 'mcp_instructions_changed'
      );
      expect(instructionEvents).toEqual([
        expect.objectContaining({
          serverName: 'instructions',
          action: 'added',
          text: expect.stringContaining('INSTRUCTION_CODE_42'),
        }),
      ]);
      const markerCall = events.find(
        (event) =>
          event.kind === 'tool_start' &&
          'function' in event.toolCall &&
          event.toolCall.function.name === 'mcp__instructions__instructed_marker'
      );
      expect(
        markerCall &&
          markerCall.kind === 'tool_start' &&
          'function' in markerCall.toolCall
          ? JSON.parse(markerCall.toolCall.function.arguments)
          : undefined
      ).toEqual({ code: 'INSTRUCTION_CODE_42' });

      const modelContext = JSON.stringify(context.messages);
      expect(modelContext).toContain('external, untrusted tool documentation');
      expect(modelContext).toContain('INSTRUCTION_CODE_42');
      expect(modelContext).not.toContain('\u200b');
      expect(modelContext).not.toContain('instructions="</system-reminder>');
      expect(modelContext).not.toContain('RAW_ACCESS_TOKEN');
      const trace = await readFile(traceFile, 'utf8');
      expect(trace).toContain('"code":"INSTRUCTION_CODE_42"');
      assertNoSecrets({ result, events, context, trace }, [gpt.apiKey]);

      const pid = Number((await readFile(pidFile, 'utf8')).trim());
      await agent.destroy();
      agent = undefined;
      await runtime.dispose();
      runtime = undefined;
      await expect.poll(() => processExists(pid)).toBe(false);
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

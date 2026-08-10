import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpSession } from '../../../src/acp/Session.js';
import { Agent } from '../../../src/agent/Agent.js';
import { drainLoop } from '../../../src/agent/loop/index.js';
import type { LoopEvent } from '../../../src/agent/loop/types.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import type { ChatContext, LoopResult } from '../../../src/agent/types.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { type BladeConfig, PermissionMode } from '../../../src/config/types.js';
import { resetWorkspaceIdentityCache } from '../../../src/security/WorkspaceIdentity.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { Bus } from '../../../src/server/bus.js';
import { SessionRoutes } from '../../../src/server/routes/session.js';
import { getState } from '../../../src/store/vanilla.js';
import { createMockACPClient } from '../../support/mocks/mockACPClient.js';
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
const ENV_NAME = 'WORKSPACE_RUNTIME_MARKER';

async function writeWorkspaceConfig(
  workspace: string,
  config: BladeConfig,
  marker: string
) {
  await mkdir(path.join(workspace, '.blade'), { recursive: true });
  await writeFile(
    path.join(workspace, '.blade', 'config.json'),
    `${JSON.stringify(
      {
        currentModelId: config.currentModelId,
        models: config.models,
        modelProviders: config.modelProviders,
        env: { [ENV_NAME]: marker },
        maxTurns: 4,
        permissionMode: 'yolo',
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function runEnvironmentProbe(
  runtime: SessionRuntime,
  agent: Agent,
  expected: string
): Promise<{ events: LoopEvent[]; result: LoopResult }> {
  const context: ChatContext = {
    messages: [],
    sessionId: runtime.sessionId,
    userId: 'workspace-environment-qualification',
    workspaceRoot: runtime.workspaceRoot,
    permissionMode: PermissionMode.YOLO,
  };
  const command = `node -e "process.stdout.write(process.env.${ENV_NAME} || 'missing')"`;
  const generator = agent.chatStream(
    [
      `Call Bash exactly once with command ${JSON.stringify(command)}.`,
      `The required external value is available only in ${ENV_NAME}.`,
      'Do not invent the value and do not call any other tool.',
      'After Bash succeeds, return exactly its stdout.',
    ].join(' '),
    context,
    { stream: true }
  );
  const events: LoopEvent[] = [];
  const result = await drainLoop(generator, (event) => {
    events.push(event);
  });
  const bashResults = events.filter(
    (event): event is Extract<LoopEvent, { kind: 'tool_result' }> =>
      event.kind === 'tool_result' &&
      'function' in event.toolCall &&
      event.toolCall.function.name === 'Bash'
  );
  expect(bashResults).toHaveLength(1);
  expect(JSON.stringify(bashResults[0]?.result.llmContent)).toContain(expected);
  return { events, result };
}

async function waitForWebCompletion(
  sessionId: string,
  projectPath: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for Web environment probe'));
    }, 180_000);
    const unsubscribe = Bus.subscribe((event) => {
      if (event.sessionId !== sessionId || event.projectPath !== projectPath) return;
      if (event.type === 'session.completed') {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      } else if (event.type === 'session.error') {
        clearTimeout(timeout);
        unsubscribe();
        reject(
          new Error(String(event.properties.error ?? 'Web environment probe failed'))
        );
      }
    });
  });
}

function environmentFilePrompt(filename: string): string {
  const command =
    `node -e "require('node:fs').writeFileSync('${filename}', ` +
    `process.env.${ENV_NAME} || 'missing')"`;
  return [
    `Call Bash exactly once with command ${JSON.stringify(command)}.`,
    `The required external value is available only in ${ENV_NAME}.`,
    'Do not invent the value and do not call any other tool.',
    'Finish after Bash succeeds.',
  ].join(' ');
}

describeReal('workspace runtime environment trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
  const originalMarker = process.env[ENV_NAME];

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
    if (originalMarker === undefined) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = originalMarker;
  });

  it('keeps Bash environment immutable and isolated across live workspaces', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-runtime-env-'));
    const workspaceA = path.join(root, 'project-a');
    const workspaceB = path.join(root, 'project-b');
    const markerA = `RUNTIME_ENV_A_${Date.now()}`;
    const markerB = `RUNTIME_ENV_B_${Date.now()}`;
    const hostMarker = `HOST_ENV_${Date.now()}`;
    const originalConfig = getState().config.config;
    const startupConfig = buildRealApiRuntimeConfig(gpt);
    let runtimeA: SessionRuntime | undefined;
    let runtimeB: SessionRuntime | undefined;
    let agentA: Agent | undefined;
    let agentB: Agent | undefined;

    try {
      process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
      process.env[ENV_NAME] = hostMarker;
      await Promise.all([
        writeWorkspaceConfig(workspaceA, startupConfig, markerA),
        writeWorkspaceConfig(workspaceB, startupConfig, markerB),
      ]);
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      await Promise.all([
        WorkspaceTrustService.getInstance().trust(workspaceA),
        WorkspaceTrustService.getInstance().trust(workspaceB),
      ]);
      getState().config.actions.setConfig({
        ...startupConfig,
        permissionMode: PermissionMode.YOLO,
        hooks: { ...startupConfig.hooks, enabled: false },
      });

      [runtimeA, runtimeB] = await Promise.all([
        SessionRuntime.create({
          sessionId: `runtime-env-a-${Date.now()}`,
          workspaceRoot: workspaceA,
        }),
        SessionRuntime.create({
          sessionId: `runtime-env-b-${Date.now()}`,
          workspaceRoot: workspaceB,
        }),
      ]);
      [agentA, agentB] = await Promise.all([
        Agent.createWithRuntime(runtimeA, {
          sessionId: runtimeA.sessionId,
          toolWhitelist: ['Bash'],
          maxTurns: 4,
        }),
        Agent.createWithRuntime(runtimeB, {
          sessionId: runtimeB.sessionId,
          toolWhitelist: ['Bash'],
          maxTurns: 4,
        }),
      ]);

      await Promise.all([
        writeWorkspaceConfig(workspaceA, startupConfig, 'MUTATED_A'),
        writeWorkspaceConfig(workspaceB, startupConfig, 'MUTATED_B'),
      ]);
      const traceA = await runEnvironmentProbe(runtimeA, agentA, markerA);
      const traceB = await runEnvironmentProbe(runtimeB, agentB, markerB);
      const serializedA = JSON.stringify(traceA);
      const serializedB = JSON.stringify(traceB);

      expect(traceA.result.success).toBe(true);
      expect(traceB.result.success).toBe(true);
      expect(runtimeA.getConfig().maxTurns).toBe(4);
      expect(runtimeB.getConfig().maxTurns).toBe(4);
      expect(serializedA).not.toContain(markerB);
      expect(serializedA).not.toContain(hostMarker);
      expect(serializedB).not.toContain(markerA);
      expect(serializedB).not.toContain(hostMarker);
      assertNoSecrets({ traceA, traceB }, [gpt.apiKey]);
    } finally {
      await Promise.allSettled([agentA?.destroy(), agentB?.destroy()]);
      await Promise.allSettled([runtimeA?.dispose(), runtimeB?.dispose()]);
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it('propagates the owning workspace environment through Web and ACP', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-surface-env-'));
    const webWorkspace = path.join(root, 'web-project');
    const acpWorkspace = path.join(root, 'acp-project');
    const webMarker = `WEB_ENV_${Date.now()}`;
    const acpMarker = `ACP_ENV_${Date.now()}`;
    const webOutput = 'web-runtime-env.txt';
    const acpOutput = 'acp-runtime-env.txt';
    const originalConfig = getState().config.config;
    const startupConfig = buildRealApiRuntimeConfig(gpt);
    const app = SessionRoutes();
    const acpSessionId = `acp-runtime-env-${Date.now()}`;
    const acpSession = new AcpSession(
      acpSessionId,
      acpWorkspace,
      createMockACPClient() as never,
      {}
    );
    let webSessionId = '';

    try {
      process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
      await Promise.all([
        writeWorkspaceConfig(webWorkspace, startupConfig, webMarker),
        writeWorkspaceConfig(acpWorkspace, startupConfig, acpMarker),
      ]);
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      await Promise.all([
        WorkspaceTrustService.getInstance().trust(webWorkspace),
        WorkspaceTrustService.getInstance().trust(acpWorkspace),
      ]);
      getState().config.actions.setConfig({
        ...startupConfig,
        permissionMode: PermissionMode.YOLO,
        hooks: { ...startupConfig.hooks, enabled: false },
      });

      const created = await app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectPath: webWorkspace,
          title: 'Web environment qualification',
        }),
      });
      expect(created.status).toBe(200);
      webSessionId = ((await created.json()) as { sessionId: string }).sessionId;
      let webError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const webCompletion = waitForWebCompletion(webSessionId, webWorkspace);
        const submitted = await app.request(`/${webSessionId}/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content: environmentFilePrompt(webOutput),
            projectPath: webWorkspace,
            permissionMode: 'yolo',
          }),
        });
        expect(submitted.status).toBe(202);
        try {
          await webCompletion;
          webError = undefined;
          break;
        } catch (error) {
          webError = error;
        }
      }
      if (webError) throw webError;

      await acpSession.initialize();
      await acpSession.setMode('yolo');
      let acpValue: string | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const acpResult = await acpSession.prompt({
          sessionId: acpSessionId,
          prompt: [
            {
              type: 'text',
              text: environmentFilePrompt(acpOutput),
            },
          ],
        });
        expect(acpResult.stopReason).toBe('end_turn');
        try {
          acpValue = await readFile(path.join(acpWorkspace, acpOutput), 'utf8');
          break;
        } catch (error) {
          if (
            attempt > 0 ||
            !(error instanceof Error) ||
            !('code' in error) ||
            error.code !== 'ENOENT'
          ) {
            throw error;
          }
        }
      }

      expect(await readFile(path.join(webWorkspace, webOutput), 'utf8')).toBe(
        webMarker
      );
      expect(acpValue).toBe(acpMarker);
    } finally {
      await acpSession.destroy().catch(() => undefined);
      if (webSessionId) {
        await app.request(
          `/${webSessionId}?projectPath=${encodeURIComponent(webWorkspace)}`,
          { method: 'DELETE' }
        );
      }
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await rm(root, { recursive: true, force: true });
    }
  }, 360_000);
});

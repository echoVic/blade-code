import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcpSession } from '../../../src/acp/Session.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import type { RuntimeConfig } from '../../../src/config/types.js';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import { createSessionRouteController } from '../../../src/server/routes/session.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import { createMockACPClient } from '../../support/mocks/mockACPClient.js';
import {
  buildRealApiRuntimeConfig,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
  type TestModelConfig,
} from './testConfig.js';

const enabledModels = isRealApiTestEnabled() ? getEnabledModelConfigs() : [];
const deepseek = enabledModels.find((model) => model.id === 'deepseek');
const gpt = enabledModels.find((model) => model.id === 'gpt');
const claude = enabledModels.find((model) => model.id === 'claude');
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
let originalConfig: RuntimeConfig | null = null;

interface Fixture {
  root: string;
  workspace: string;
  sessionId: string;
  sessionFile: string;
  token: string;
  runtime: SessionRuntime;
}

function configureModel(model: TestModelConfig): void {
  const config = buildRealApiRuntimeConfig(model);
  config.models = config.models.map((entry) => ({
    ...entry,
    overrides: {
      ...entry.overrides,
      maxOutputTokens: 128,
      maxRetries: 0,
    },
  }));
  config.providerForegroundRecoveryMs = 0;
  config.mcpEnabled = false;
  config.mcpServers = {};
  getState().config.actions.setConfig(config);
}

async function createFixture(
  model: TestModelConfig,
  surface: string
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), `blade-side-${surface}-`));
  const workspace = path.join(root, 'workspace');
  const storageRoot = path.join(root, 'storage');
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(storageRoot, { recursive: true }),
  ]);
  process.env.BLADE_STORAGE_ROOT = storageRoot;
  configureModel(model);

  const sessionId = `side-${surface}-${randomUUID()}`;
  const token = `SIDE_${surface.toUpperCase()}_${randomUUID().replaceAll('-', '')}`;
  await SessionService.createSessionMetadata(sessionId, workspace, {
    title: `Side conversation ${surface}`,
    taskStatus: 'completed',
    selectedModelId: getState().config.config?.currentModelId,
  });
  const runtime = await runWithCwdOverride(workspace, () =>
    SessionRuntime.create({ sessionId, workspaceRoot: workspace })
  );
  await runtime
    .getExecutionEngine()
    .getContextManager()
    .saveMessage(
      sessionId,
      'user',
      `The public test marker for this conversation is ${token}.`,
      null
    );

  return {
    root,
    workspace,
    sessionId,
    sessionFile: getSessionFilePath(workspace, sessionId),
    token,
    runtime,
  };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await fixture.runtime.dispose().catch(() => undefined);
  await rm(fixture.root, { recursive: true, force: true });
}

beforeAll(() => {
  if (enabledModels.length === 0) return;
  originalConfig = getState().config.config;
});

afterAll(() => {
  if (originalConfig) getState().config.actions.setConfig(originalConfig);
  if (originalStorageRoot === undefined) {
    delete process.env.BLADE_STORAGE_ROOT;
  } else {
    process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  }
});

describe.skipIf(!deepseek)('Side conversation runtime trajectory (real API)', () => {
  it('answers from durable context without changing its JSONL', async () => {
    if (!deepseek) throw new Error('DeepSeek configuration is unavailable');
    const fixture = await createFixture(deepseek, 'runtime');

    try {
      const before = await readFile(fixture.sessionFile);
      const result = await fixture.runtime.askSideQuestion(
        'What is the public test marker from the earlier user message? Reply with only that marker.'
      );

      expect(result.response).toContain(fixture.token);
      expect(await readFile(fixture.sessionFile)).toEqual(before);
    } finally {
      await cleanupFixture(fixture);
    }
  }, 240_000);
});

describe.skipIf(!gpt)('Side conversation Web route trajectory (real API)', () => {
  it('returns a transient answer without creating a run or transcript entry', async () => {
    if (!gpt) throw new Error('GPT configuration is unavailable');
    const fixture = await createFixture(gpt, 'web');
    await fixture.runtime.dispose();
    const controller = createSessionRouteController();

    try {
      const before = await readFile(fixture.sessionFile);
      const response = await runWithCwdOverride(fixture.workspace, () =>
        controller.app.request(`/${fixture.sessionId}/side-question`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            question:
              'What is the public test marker from the earlier user message? Reply with only that marker.',
            projectPath: fixture.workspace,
          }),
        })
      );
      const payload = (await response.json()) as {
        response?: string;
        error?: unknown;
      };

      expect(response.status, JSON.stringify(payload)).toBe(200);
      expect(payload.response).toContain(fixture.token);
      expect(await readFile(fixture.sessionFile)).toEqual(before);
    } finally {
      await controller.shutdown();
      await cleanupFixture(fixture);
    }
  }, 240_000);
});

describe.skipIf(!claude)('Side conversation ACP trajectory (real API)', () => {
  it('returns /btw output without changing ACP history or durable JSONL', async () => {
    if (!claude) throw new Error('Claude configuration is unavailable');
    const fixture = await createFixture(claude, 'acp');
    await fixture.runtime.dispose();
    const client = createMockACPClient();
    const session = new AcpSession(
      fixture.sessionId,
      fixture.workspace,
      client as never,
      undefined,
      {
        initialMessages: await SessionService.loadSession(
          fixture.sessionId,
          fixture.workspace
        ),
      }
    );

    try {
      await runWithCwdOverride(fixture.workspace, () => session.initialize());
      client.sessionUpdates.length = 0;
      const before = await readFile(fixture.sessionFile);
      const response = await runWithCwdOverride(fixture.workspace, () =>
        session.prompt({
          sessionId: fixture.sessionId,
          prompt: [
            {
              type: 'text',
              text: '/btw What is the public test marker from the earlier user message? Reply with only that marker.',
            },
          ],
        })
      );
      const output = client.sessionUpdates
        .map((notification) => notification.update)
        .filter((update) => update.sessionUpdate === 'agent_message_chunk')
        .map((update) => (update.content.type === 'text' ? update.content.text : ''))
        .join('');

      expect(response.stopReason).toBe('end_turn');
      expect(output).toContain(fixture.token);
      expect(await readFile(fixture.sessionFile)).toEqual(before);
    } finally {
      await session.destroy().catch(() => undefined);
      await cleanupFixture(fixture);
    }
  }, 240_000);
});

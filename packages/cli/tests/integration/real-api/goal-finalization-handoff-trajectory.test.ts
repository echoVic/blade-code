import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHeadless } from '../../../src/commands/headless.js';
import { HeadlessJsonlEventSchema } from '../../../src/commands/headlessEvents.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { getSessionInboxFilePath } from '../../../src/context/storage/pathUtils.js';
import { GoalStore } from '../../../src/goals/GoalStore.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import { runGoalFinalizationAcpDriver } from '../../support/goalFinalizationAcpDriver.js';
import { runGoalFinalizationPtyDriver } from '../../support/goalFinalizationPtyDriver.js';
import { runGoalFinalizationWebDriver } from '../../support/goalFinalizationWebDriver.js';
import {
  type RecordingProviderProxy,
  startRecordingProviderProxy,
} from '../../support/recordingProviderProxy.js';
import {
  type GoalFinalizationHandoffFixture,
  seedGoalFinalizationHandoffFixture,
} from './goalFinalizationHandoffFixture.js';
import {
  buildRealApiRuntimeConfig,
  expandDeepSeekModelMatrix,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
  isReleaseMatrix,
} from './testConfig.js';

const models = isRealApiTestEnabled()
  ? expandDeepSeekModelMatrix(
      getEnabledModelConfigs().filter((config) => config.id === 'deepseek')
    )
  : [];
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
const originalProviderBaseUrl = process.env.BLADE_BASE_URL;
let originalConfig: RuntimeConfig | null = null;

interface PreparedFixture {
  root: string;
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  followupPrompt: string;
  expectedFollowup: string;
  fixture: GoalFinalizationHandoffFixture;
  proxy: RecordingProviderProxy;
}

async function prepareFixture(
  model: (typeof models)[number],
  surface: 'headless' | 'acp' | 'pty' | 'web'
): Promise<PreparedFixture> {
  if (!model.baseURL) throw new Error(`Missing Provider base URL for ${model.model}`);
  const root = await mkdtemp(path.join(os.tmpdir(), `blade-goal-${surface}-`));
  const workspace = path.join(root, 'project');
  const storageRoot = path.join(root, 'storage');
  const home = path.join(root, 'home');
  const proxy = await startRecordingProviderProxy(model.baseURL);
  const config = {
    ...buildRealApiRuntimeConfig({ ...model, baseURL: proxy.baseUrl }),
    permissionMode: PermissionMode.YOLO,
  };
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(storageRoot, { recursive: true }),
    mkdir(path.join(home, '.blade'), { recursive: true }),
  ]);
  await writeFile(
    path.join(home, '.blade', 'config.json'),
    `${JSON.stringify(
      {
        currentModelId: config.currentModelId,
        models: config.models,
        modelProviders: config.modelProviders,
        permissionMode: PermissionMode.YOLO,
        hooks: { enabled: false },
        disableAllHooks: true,
        mcpServers: {},
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  process.env.BLADE_STORAGE_ROOT = storageRoot;
  process.env.BLADE_BASE_URL = proxy.baseUrl;
  getState().config.actions.setConfig(config);
  const sessionId = `goal-handoff-${surface}-${model.model}-${Date.now()}`;
  const marker = `${surface.toUpperCase()}_${model.model
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/g, '_')}`;
  const fixture = await runWithCwdOverride(workspace, () =>
    seedGoalFinalizationHandoffFixture({
      workspace,
      sessionId,
      marker,
    })
  );
  const expectedFollowup = `FOLLOWUP_${marker}`;
  const followupPrompt = [
    'Do not use tools.',
    'Reply with exactly one token formed by concatenating these quoted segments',
    `without separators: ${JSON.stringify('FOLLOWUP_')} ${JSON.stringify(marker)}.`,
  ].join(' ');
  if (followupPrompt.includes(expectedFollowup)) {
    throw new Error('Goal follow-up prompt contains its complete response marker');
  }
  return {
    root,
    workspace,
    storageRoot,
    home,
    sessionId,
    followupPrompt,
    expectedFollowup,
    fixture,
    proxy,
  };
}

async function assertDurableCompletion(input: PreparedFixture): Promise<void> {
  await expect(
    new GoalStore(input.workspace, input.sessionId).get()
  ).resolves.toMatchObject({
    goalId: input.fixture.goalId,
    status: 'complete',
    completionVerification: {
      status: 'pass',
      verifierSessionId: expect.any(String),
      evidenceSha256: 'a'.repeat(64),
    },
  });
  await expect(
    access(getSessionInboxFilePath(input.workspace, input.sessionId))
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(input.fixture.artifactPath, 'utf8')).toBe(
    `${input.fixture.artifactMarker}\n`
  );

  const events = await new PersistentStore(input.workspace).loadEvents(input.sessionId);
  expect(
    events?.filter(
      (event) =>
        event.type === 'turn_completed' && event.data.turnId === input.fixture.turnId
    )
  ).toHaveLength(1);
  expect(
    events?.filter(
      (event) =>
        event.type === 'turn_aborted' && event.data.turnId === input.fixture.turnId
    )
  ).toHaveLength(0);
  expect(
    events?.filter(
      (event) =>
        event.type === 'inbox_acknowledged' &&
        event.data.messageIds.includes(input.fixture.inputMessageId)
    )
  ).toHaveLength(1);
  expect(
    events?.filter((event) => {
      if (event.type !== 'message_created') return false;
      const metadata = event.data.metadata;
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return false;
      }
      const finalization = metadata.turnFinalization;
      return (
        finalization !== null &&
        typeof finalization === 'object' &&
        !Array.isArray(finalization) &&
        finalization.goalFinalization !== undefined
      );
    })
  ).toHaveLength(1);

  const messages = await SessionService.loadSession(input.sessionId, input.workspace);
  expect(
    messages.filter(
      (message) =>
        message.role === 'assistant' &&
        JSON.stringify(message.content).includes(input.fixture.finalResponse)
    )
  ).toHaveLength(1);
  expect(input.proxy.requestBodies.length).toBeGreaterThanOrEqual(1);
  for (const body of input.proxy.requestBodies) {
    const payload = JSON.parse(body) as {
      messages?: Array<{ content?: unknown }>;
    };
    const messageText = (payload.messages ?? [])
      .map((message) =>
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content)
      )
      .join('\n');
    expect(messageText).toContain(input.followupPrompt);
  }
}

async function cleanupFixture(input: PreparedFixture): Promise<void> {
  await input.proxy.close().catch(() => undefined);
  await rm(input.root, { recursive: true, force: true });
  if (originalProviderBaseUrl === undefined) {
    delete process.env.BLADE_BASE_URL;
  } else {
    process.env.BLADE_BASE_URL = originalProviderBaseUrl;
  }
}

beforeAll(() => {
  if (models.length > 0) originalConfig = getState().config.config;
});

afterAll(() => {
  if (originalConfig) getState().config.actions.setConfig(originalConfig);
  if (originalStorageRoot === undefined) {
    delete process.env.BLADE_STORAGE_ROOT;
  } else {
    process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  }
  if (originalProviderBaseUrl === undefined) {
    delete process.env.BLADE_BASE_URL;
  } else {
    process.env.BLADE_BASE_URL = originalProviderBaseUrl;
  }
});

describe
  .skipIf(models.length === 0)
  .sequential('durable Goal finalization handoff (real API)', () => {
    for (const model of models) {
      it(`${model.model} replays recovered completion through Headless`, async () => {
        const prepared = await prepareFixture(model, 'headless');
        let recoveryOutput = '';
        let recoveryError = '';
        let followupOutput = '';
        let followupError = '';
        try {
          const recoveryExit = await runWithCwdOverride(prepared.workspace, () =>
            runHeadless(
              {
                headless: true,
                outputFormat: 'jsonl',
                resume: prepared.sessionId,
                maxTurns: 2,
                permissionMode: PermissionMode.YOLO,
              },
              {
                stdout: {
                  write(chunk: string) {
                    recoveryOutput += chunk;
                    return true;
                  },
                },
                stderr: {
                  write(chunk: string) {
                    recoveryError += chunk;
                    return true;
                  },
                },
              },
              { stdin: Readable.from([]) as NodeJS.ReadStream }
            )
          );
          expect(
            recoveryExit,
            recoveryError.replaceAll(model.apiKey, '[redacted]')
          ).toBe(0);
          expect(prepared.proxy.requestBodies).toHaveLength(0);
          const recoveryEvents = recoveryOutput
            .split('\n')
            .filter(Boolean)
            .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
          expect(recoveryEvents).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'goal',
                goal_id: prepared.fixture.goalId,
                status: 'complete',
              }),
              expect.objectContaining({
                type: 'content',
                content: prepared.fixture.finalResponse,
              }),
            ])
          );

          const followupExit = await runWithCwdOverride(prepared.workspace, () =>
            runHeadless(
              {
                headless: true,
                outputFormat: 'jsonl',
                resume: prepared.sessionId,
                message: prepared.followupPrompt,
                maxTurns: 2,
                permissionMode: PermissionMode.YOLO,
                allowedTools: [],
              },
              {
                stdout: {
                  write(chunk: string) {
                    followupOutput += chunk;
                    return true;
                  },
                },
                stderr: {
                  write(chunk: string) {
                    followupError += chunk;
                    return true;
                  },
                },
              }
            )
          );
          expect(
            followupExit,
            followupError.replaceAll(model.apiKey, '[redacted]')
          ).toBe(0);
          const followupEvents = followupOutput
            .split('\n')
            .filter(Boolean)
            .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
          expect(
            followupEvents
              .flatMap((event) =>
                event.type === 'content_delta'
                  ? [event.delta]
                  : event.type === 'content'
                    ? [event.content]
                    : []
              )
              .join('')
          ).toContain(prepared.expectedFollowup);
          expect(
            `${recoveryOutput}\n${recoveryError}\n${followupOutput}`
          ).not.toContain(model.apiKey);
          await assertDurableCompletion(prepared);
        } finally {
          await cleanupFixture(prepared);
        }
      }, 240_000);

      it(`${model.model} replays recovered completion through ACP session/load`, async () => {
        const prepared = await prepareFixture(model, 'acp');
        try {
          const evidence = await runGoalFinalizationAcpDriver({
            workspace: prepared.workspace,
            sessionId: prepared.sessionId,
            expectedInitial: prepared.fixture.finalResponse,
            followupPrompt: prepared.followupPrompt,
            expectedFollowup: prepared.expectedFollowup,
            secret: model.apiKey,
          });
          expect(evidence.initialText).toContain(prepared.fixture.finalResponse);
          expect(evidence.followupText).toContain(prepared.expectedFollowup);
          await assertDurableCompletion(prepared);
        } finally {
          await cleanupFixture(prepared);
        }
      }, 240_000);

      it.skipIf(isReleaseMatrix())(
        `${model.model} replays recovered completion through the real TUI raw PTY`,
        async () => {
          const prepared = await prepareFixture(model, 'pty');
          try {
            const evidence = await runGoalFinalizationPtyDriver({
              workspace: prepared.workspace,
              storageRoot: prepared.storageRoot,
              home: prepared.home,
              sessionId: prepared.sessionId,
              expectedInitial: prepared.fixture.finalResponse,
              followupPrompt: prepared.followupPrompt,
              expectedFollowup: prepared.expectedFollowup,
              secret: model.apiKey,
            });
            expect(evidence).toMatchObject({
              sawInitial: true,
              sawCompleteGoal: true,
              sawFollowup: true,
            });
            await assertDurableCompletion(prepared);
          } finally {
            await cleanupFixture(prepared);
          }
        },
        240_000
      );

      it(`${model.model} replays recovered completion through production Web GUI`, async () => {
        const prepared = await prepareFixture(model, 'web');
        try {
          const evidence = await runGoalFinalizationWebDriver({
            workspace: prepared.workspace,
            storageRoot: prepared.storageRoot,
            home: prepared.home,
            sessionId: prepared.sessionId,
            expectedInitial: prepared.fixture.finalResponse,
            followupPrompt: prepared.followupPrompt,
            expectedFollowup: prepared.expectedFollowup,
            secret: model.apiKey,
          });
          expect(evidence).toEqual({
            initialVisible: true,
            completeGoalVisible: true,
            followupVisible: true,
            visibleAfterReload: true,
            browserFaults: [],
          });
          await assertDurableCompletion(prepared);
        } finally {
          await cleanupFixture(prepared);
        }
      }, 240_000);
    }
  });

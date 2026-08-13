import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentSessionStore } from '../../../src/agent/subagents/AgentSessionStore.js';
import { runHeadless } from '../../../src/commands/headless.js';
import { HeadlessJsonlEventSchema } from '../../../src/commands/headlessEvents.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { getSessionInboxFilePath } from '../../../src/context/storage/pathUtils.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import {
  type RecordingProviderProxy,
  startRecordingProviderProxy,
} from '../../support/recordingProviderProxy.js';
import { runSubagentResultAdoptionAcpDriver } from '../../support/subagentResultAdoptionAcpDriver.js';
import { runSubagentResultAdoptionPtyDriver } from '../../support/subagentResultAdoptionPtyDriver.js';
import { runSubagentResultAdoptionWebDriver } from '../../support/subagentResultAdoptionWebDriver.js';
import {
  resetSubagentAdoptionState,
  type SubagentResultAdoptionFixture,
  seedSubagentResultAdoptionFixture,
} from './subagentResultAdoptionFixture.js';
import {
  buildRealApiRuntimeConfig,
  expandDeepSeekModelMatrix,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
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
  fixture: SubagentResultAdoptionFixture;
  proxy: RecordingProviderProxy;
  seedRequestCount: number;
  childSidecarPath: string;
  childSidecarBefore: string;
}

async function prepareFixture(
  model: (typeof models)[number],
  surface: 'headless' | 'acp' | 'pty' | 'web'
): Promise<PreparedFixture> {
  if (!model.baseURL) throw new Error(`Missing Provider base URL for ${model.model}`);
  const root = await mkdtemp(path.join(os.tmpdir(), `blade-adoption-${surface}-`));
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
  const sessionId = `adoption-${surface}-${model.model}-${Date.now()}`;
  const marker = `${surface.toUpperCase()}_${model.model
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/g, '_')}`;
  const fixture = await runWithCwdOverride(workspace, () =>
    seedSubagentResultAdoptionFixture({
      workspace,
      sessionId,
      marker,
      modelId: config.currentModelId,
    })
  );
  const childSidecarPath = path.join(
    storageRoot,
    'agents',
    'sessions',
    `${fixture.childSessionId}.json`
  );
  const childSidecarBefore = await readFile(childSidecarPath, 'utf8');
  const seedRequestCount = proxy.requestBodies.length;
  if (seedRequestCount < 1) {
    throw new Error('Real child did not call the recording Provider proxy');
  }
  resetSubagentAdoptionState();
  return {
    root,
    workspace,
    storageRoot,
    home,
    sessionId,
    fixture,
    proxy,
    seedRequestCount,
    childSidecarPath,
    childSidecarBefore,
  };
}

async function assertAdoption(input: PreparedFixture): Promise<void> {
  await expect(
    access(getSessionInboxFilePath(input.workspace, input.sessionId))
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(input.childSidecarPath, 'utf8')).toBe(input.childSidecarBefore);

  const events = await new PersistentStore(input.workspace).loadEvents(input.sessionId);
  const adoptedResults = events?.filter(
    (event) =>
      event.type === 'part_created' &&
      event.data.partType === 'tool_result' &&
      event.data.partId === input.fixture.toolCallId &&
      event.data.payload !== null &&
      typeof event.data.payload === 'object' &&
      !Array.isArray(event.data.payload) &&
      event.data.payload.metadata !== null &&
      typeof event.data.payload.metadata === 'object' &&
      !Array.isArray(event.data.payload.metadata) &&
      event.data.payload.metadata.subagentResultAdopted === true
  );
  expect(adoptedResults).toHaveLength(1);
  expect(JSON.stringify(adoptedResults)).toContain(input.fixture.childMarker);
  expect(JSON.stringify(adoptedResults)).toContain('"sideEffectsUncertain":false');
  expect(JSON.stringify(events)).not.toContain(
    'Tool execution was interrupted by a process restart'
  );
  expect(
    events?.filter(
      (event) =>
        event.type === 'turn_aborted' && event.data.turnId === input.fixture.turnId
    )
  ).toHaveLength(1);
  expect(
    events?.filter(
      (event) =>
        event.type === 'inbox_acknowledged' &&
        event.data.messageIds.includes(input.fixture.inputMessageId)
    )
  ).toHaveLength(1);

  const messages = await SessionService.loadSession(input.sessionId, input.workspace);
  expect(
    messages.filter(
      (message) =>
        message.role === 'assistant' &&
        JSON.stringify(message.content).includes(input.fixture.parentResponse)
    )
  ).toHaveLength(1);
  const sessions = AgentSessionStore.getInstance()
    .listSessions()
    .filter(
      (session) =>
        session.parentSessionId === input.sessionId &&
        session.parentProjectPath === input.workspace
    );
  expect(sessions).toEqual([
    expect.objectContaining({
      id: input.fixture.childSessionId,
      status: 'completed',
      result: expect.objectContaining({
        message: expect.stringContaining(input.fixture.childMarker),
      }),
    }),
  ]);

  const resumedRequests = input.proxy.requestBodies.slice(input.seedRequestCount);
  expect(resumedRequests.length).toBeGreaterThanOrEqual(1);
  for (const body of resumedRequests) {
    expect(body).toContain(input.fixture.childMarker);
  }
}

async function cleanupFixture(input: PreparedFixture): Promise<void> {
  resetSubagentAdoptionState();
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
  resetSubagentAdoptionState();
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
  .sequential('durable completed-subagent result adoption (real API)', () => {
    for (const model of models) {
      it(`${model.model} adopts through Headless`, async () => {
        const prepared = await prepareFixture(model, 'headless');
        let stdout = '';
        let stderr = '';
        try {
          const exitCode = await runWithCwdOverride(prepared.workspace, () =>
            runHeadless(
              {
                headless: true,
                outputFormat: 'jsonl',
                resume: prepared.sessionId,
                maxTurns: 3,
                permissionMode: PermissionMode.YOLO,
                allowedTools: [],
              },
              {
                stdout: {
                  write(chunk: string) {
                    stdout += chunk;
                    return true;
                  },
                },
                stderr: {
                  write(chunk: string) {
                    stderr += chunk;
                    return true;
                  },
                },
              },
              { stdin: Readable.from([]) as NodeJS.ReadStream }
            )
          );
          expect(exitCode, stderr.replaceAll(model.apiKey, '[redacted]')).toBe(0);
          const events = stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
          expect(
            events
              .flatMap((event) =>
                event.type === 'content_delta'
                  ? [event.delta]
                  : event.type === 'content'
                    ? [event.content]
                    : []
              )
              .join('')
          ).toContain(prepared.fixture.parentResponse);
          expect(`${stdout}\n${stderr}`).not.toContain(model.apiKey);
          await assertAdoption(prepared);
        } finally {
          await cleanupFixture(prepared);
        }
      }, 300_000);

      it(`${model.model} adopts through ACP session/load`, async () => {
        const prepared = await prepareFixture(model, 'acp');
        try {
          const evidence = await runSubagentResultAdoptionAcpDriver({
            workspace: prepared.workspace,
            sessionId: prepared.sessionId,
            expectedResponse: prepared.fixture.parentResponse,
            secret: model.apiKey,
          });
          expect(evidence.finalText).toContain(prepared.fixture.parentResponse);
          await assertAdoption(prepared);
        } finally {
          await cleanupFixture(prepared);
        }
      }, 300_000);

      it(`${model.model} adopts through the real TUI raw PTY`, async () => {
        const prepared = await prepareFixture(model, 'pty');
        try {
          const evidence = await runSubagentResultAdoptionPtyDriver({
            workspace: prepared.workspace,
            storageRoot: prepared.storageRoot,
            home: prepared.home,
            sessionId: prepared.sessionId,
            childMarker: prepared.fixture.childMarker,
            parentResponse: prepared.fixture.parentResponse,
            secret: model.apiKey,
          });
          expect(evidence).toMatchObject({
            sawChild: true,
            sawParent: true,
          });
          await assertAdoption(prepared);
        } finally {
          await cleanupFixture(prepared);
        }
      }, 300_000);

      it(`${model.model} adopts through production Web GUI`, async () => {
        const prepared = await prepareFixture(model, 'web');
        try {
          const evidence = await runSubagentResultAdoptionWebDriver({
            workspace: prepared.workspace,
            storageRoot: prepared.storageRoot,
            home: prepared.home,
            sessionId: prepared.sessionId,
            childSessionId: prepared.fixture.childSessionId,
            childMarker: prepared.fixture.childMarker,
            parentResponse: prepared.fixture.parentResponse,
            secret: model.apiKey,
          });
          expect(evidence).toEqual({
            childVisible: true,
            parentVisible: true,
            visibleAfterReload: true,
            browserFaults: [],
          });
          await assertAdoption(prepared);
        } finally {
          await cleanupFixture(prepared);
        }
      }, 300_000);
    }
  });

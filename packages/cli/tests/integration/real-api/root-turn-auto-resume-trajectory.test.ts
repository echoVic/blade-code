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
import { getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import { runRootTurnAutoResumeAcpDriver } from '../../support/rootTurnAutoResumeAcpDriver.js';
import { runRootTurnAutoResumePtyDriver } from '../../support/rootTurnAutoResumePtyDriver.js';
import { runRootTurnAutoResumeWebDriver } from '../../support/rootTurnAutoResumeWebDriver.js';
import { seedRootTurnAutoResumeFixture } from './rootTurnAutoResumeFixture.js';
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
let originalConfig: RuntimeConfig | null = null;

async function prepareExternalSurfaceFixture(
  model: (typeof models)[number],
  surface: 'acp' | 'pty' | 'web',
  runtimeConfig?: RuntimeConfig
) {
  const root = await mkdtemp(path.join(os.tmpdir(), `blade-root-${surface}-`));
  const workspace = path.join(root, 'project');
  const storageRoot = path.join(root, 'storage');
  const home = path.join(root, 'home');
  const config: RuntimeConfig = {
    ...(runtimeConfig ?? buildRealApiRuntimeConfig(model)),
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
  getState().config.actions.setConfig(config);
  const sessionId = `root-${surface}-${model.model}-${Date.now()}`;
  const marker = `${surface.toUpperCase()}_${model.model
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/g, '_')}`;
  const fixture = await runWithCwdOverride(workspace, () =>
    seedRootTurnAutoResumeFixture({
      workspace,
      sessionId,
      marker,
    })
  );
  return {
    root,
    workspace,
    storageRoot,
    home,
    sessionId,
    marker,
    fixture,
  };
}

async function assertSingleRecoveredWrite(
  workspace: string,
  sessionId: string,
  orphanToolCallId: string
): Promise<void> {
  const transcript = await new PersistentStore(workspace).loadEvents(sessionId);
  expect(
    transcript?.filter(
      (event) =>
        event.type === 'part_created' &&
        event.data.partType === 'tool_call' &&
        event.data.payload !== null &&
        typeof event.data.payload === 'object' &&
        !Array.isArray(event.data.payload) &&
        event.data.payload.toolName === 'Write'
    )
  ).toHaveLength(1);
  expect(
    transcript?.filter(
      (event) =>
        event.type === 'part_created' &&
        event.data.partType === 'tool_call' &&
        event.data.payload !== null &&
        typeof event.data.payload === 'object' &&
        !Array.isArray(event.data.payload) &&
        event.data.payload.toolName === 'Read'
    )
  ).toHaveLength(1);
  expect(
    transcript?.filter(
      (event) =>
        event.type === 'part_created' &&
        event.data.partType === 'tool_result' &&
        event.data.partId === orphanToolCallId
    )
  ).toHaveLength(1);
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
});

describe
  .skipIf(models.length === 0)
  .sequential('durable root-turn attention-gated recovery (real API)', () => {
    for (const model of models) {
      it(`${model.model} requires explicit input before headless recovery`, async () => {
        const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-root-resume-'));
        const storageRoot = path.join(workspace, '.blade-storage');
        const sessionId = `root-auto-resume-${model.model}-${Date.now()}`;
        const marker = `AUTO_RESUME_${model.model
          .toUpperCase()
          .replaceAll(/[^A-Z0-9]+/g, '_')}`;
        let blockedStdout = '';
        let stdout = '';
        let stderr = '';

        try {
          process.env.BLADE_STORAGE_ROOT = storageRoot;
          getState().config.actions.setConfig({
            ...buildRealApiRuntimeConfig(model),
            permissionMode: PermissionMode.YOLO,
          });
          const fixture = await runWithCwdOverride(workspace, () =>
            seedRootTurnAutoResumeFixture({
              workspace,
              sessionId,
              marker,
            })
          );

          const blockedExitCode = await runWithCwdOverride(workspace, () =>
            runHeadless(
              {
                headless: true,
                outputFormat: 'jsonl',
                resume: sessionId,
                maxTurns: 4,
                permissionMode: PermissionMode.YOLO,
                allowedTools: ['Read', 'Write'],
              },
              {
                stdout: {
                  write(chunk: string) {
                    blockedStdout += chunk;
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
          const blockedEvents = blockedStdout
            .split('\n')
            .filter(Boolean)
            .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
          expect(blockedExitCode, stderr.replaceAll(model.apiKey, '[redacted]')).toBe(
            2
          );
          expect(blockedEvents).toContainEqual({
            event_version: 1,
            type: 'turn_recovery',
            state: 'requires_attention',
            turn_id: expect.any(String),
            input_message_count: 1,
            reason: 'interrupted_tool_call',
          });
          expect(
            blockedEvents.filter(
              (event) => event.type === 'content_delta' || event.type === 'tool_start'
            )
          ).toHaveLength(0);
          await expect(
            access(getSessionInboxFilePath(workspace, sessionId))
          ).resolves.toBeUndefined();

          const exitCode = await runWithCwdOverride(workspace, () =>
            runHeadless(
              {
                headless: true,
                outputFormat: 'jsonl',
                resume: sessionId,
                maxTurns: 4,
                permissionMode: PermissionMode.YOLO,
                allowedTools: ['Read', 'Write'],
                message:
                  'I inspected the workspace and external state. Continue safely ' +
                  'without repeating any write or other side effect.',
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
              }
            )
          );
          const events = stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
          const response = events
            .filter((event) => event.type === 'content_delta')
            .map((event) => event.delta)
            .join('');

          expect(exitCode, stderr.replaceAll(model.apiKey, '[redacted]')).toBe(0);
          expect(response).toContain(fixture.expectedResponse);
          expect(
            events.filter(
              (event) => event.type === 'tool_start' && event.tool_name === 'Read'
            )
          ).toHaveLength(1);
          expect(
            events.filter(
              (event) =>
                event.type === 'tool_start' &&
                ['Write', 'Edit', 'ApplyPatch', 'Bash'].includes(event.tool_name ?? '')
            )
          ).toHaveLength(0);
          expect(await readFile(fixture.markerPath, 'utf8')).toBe(`${marker}\n`);
          await expect(
            access(getSessionInboxFilePath(workspace, sessionId))
          ).rejects.toMatchObject({ code: 'ENOENT' });

          const transcript = await new PersistentStore(workspace).loadEvents(sessionId);
          await assertSingleRecoveredWrite(
            workspace,
            sessionId,
            fixture.orphanToolCallId
          );
          expect(
            transcript?.filter(
              (event) =>
                event.type === 'message_created' &&
                event.data.role === 'user' &&
                event.data.inboxMessageId === fixture.inputMessageId
            )
          ).toHaveLength(1);
          expect(`${blockedStdout}\n${stdout}\n${stderr}`).not.toContain(model.apiKey);
        } finally {
          await rm(workspace, { recursive: true, force: true });
        }
      }, 240_000);

      it(`${model.model} gates recovery through ACP session/load`, async () => {
        const prepared = await prepareExternalSurfaceFixture(model, 'acp');
        try {
          const evidence = await runRootTurnAutoResumeAcpDriver({
            workspace: prepared.workspace,
            home: prepared.home,
            sessionId: prepared.sessionId,
            expected: prepared.fixture.expectedResponse,
            secret: model.apiKey,
          });
          expect(evidence.finalText).toContain(prepared.fixture.expectedResponse);
          expect(evidence.attentionProjected).toBe(true);
          expect(
            evidence.updates.filter(
              (notification) =>
                notification.update.sessionUpdate === 'tool_call' &&
                notification.update.title.includes('Read')
            )
          ).toHaveLength(1);
          expect(
            evidence.updates.filter((notification) => {
              const update = notification.update;
              if (update.sessionUpdate !== 'tool_call') return false;
              return (
                ['Write', 'Edit', 'ApplyPatch', 'Bash'].some((toolName) =>
                  update.title.includes(toolName)
                ) && update.status !== 'failed'
              );
            })
          ).toHaveLength(0);
          expect(
            evidence.updates.filter(
              (notification) =>
                notification.update.sessionUpdate === 'user_message_chunk' &&
                notification.update.content.type === 'text' &&
                notification.update.content.text.includes(prepared.marker)
            )
          ).toHaveLength(1);
          expect(await readFile(prepared.fixture.markerPath, 'utf8')).toBe(
            `${prepared.marker}\n`
          );
          await expect(
            access(getSessionInboxFilePath(prepared.workspace, prepared.sessionId))
          ).rejects.toMatchObject({ code: 'ENOENT' });
          await assertSingleRecoveredWrite(
            prepared.workspace,
            prepared.sessionId,
            prepared.fixture.orphanToolCallId
          );
        } finally {
          await rm(prepared.root, { recursive: true, force: true });
        }
      }, 240_000);

      it(`${model.model} gates recovery through the real TUI raw PTY`, async () => {
        const prepared = await prepareExternalSurfaceFixture(model, 'pty');
        try {
          const evidence = await runRootTurnAutoResumePtyDriver({
            workspace: prepared.workspace,
            storageRoot: prepared.storageRoot,
            home: prepared.home,
            sessionId: prepared.sessionId,
            inputMessageId: prepared.fixture.inputMessageId,
            expected: prepared.fixture.expectedResponse,
            secret: model.apiKey,
          });
          expect(evidence.sawExpected).toBe(true);
          expect(evidence.sawAttention).toBe(true);
          expect(await readFile(prepared.fixture.markerPath, 'utf8')).toBe(
            `${prepared.marker}\n`
          );
          await expect(
            access(getSessionInboxFilePath(prepared.workspace, prepared.sessionId))
          ).rejects.toMatchObject({ code: 'ENOENT' });
          await assertSingleRecoveredWrite(
            prepared.workspace,
            prepared.sessionId,
            prepared.fixture.orphanToolCallId
          );
        } finally {
          await rm(prepared.root, { recursive: true, force: true });
        }
      }, 240_000);

      it(`${model.model} gates recovery through production Web GUI and reload`, async () => {
        const prepared = await prepareExternalSurfaceFixture(model, 'web');
        try {
          const evidence = await runRootTurnAutoResumeWebDriver({
            workspace: prepared.workspace,
            storageRoot: prepared.storageRoot,
            home: prepared.home,
            sessionId: prepared.sessionId,
            expected: prepared.fixture.expectedResponse,
            secret: model.apiKey,
          });
          expect(evidence).toMatchObject({
            attentionVisible: true,
            attentionVisibleAfterReload: true,
            markerVisible: true,
            markerVisibleAfterReload: true,
            composerVisible: true,
            browserFaults: [],
          });
          expect(await readFile(prepared.fixture.markerPath, 'utf8')).toBe(
            `${prepared.marker}\n`
          );
          await expect(
            access(getSessionInboxFilePath(prepared.workspace, prepared.sessionId))
          ).rejects.toMatchObject({ code: 'ENOENT' });
          await assertSingleRecoveredWrite(
            prepared.workspace,
            prepared.sessionId,
            prepared.fixture.orphanToolCallId
          );
        } finally {
          await rm(prepared.root, { recursive: true, force: true });
        }
      }, 240_000);
    }
  });

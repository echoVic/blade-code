import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BladeAgent } from '../../../src/acp/BladeAgent.js';
import { runHeadless } from '../../../src/commands/headless.js';
import { PermissionMode } from '../../../src/config/types.js';
import { Logger } from '../../../src/logging/Logger.js';
import { Bus } from '../../../src/server/bus.js';
import { createSessionRouteController } from '../../../src/server/routes/session.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
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

function writePrompt(fileName: string, marker: string): string {
  return [
    `Use Write exactly once to create ${fileName}.`,
    `The complete file content must be exactly ${marker} followed by one newline.`,
    'Do not call any other tool.',
    `After Write succeeds, reply exactly ${marker}.`,
  ].join(' ');
}

async function waitForWebCompletion(
  sessionId: string,
  projectPath: string
): Promise<{ promise: Promise<void>; cancel(): void }> {
  let unsubscribe: () => void = () => undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for permission recovery Web run'));
    }, 210_000);
    unsubscribe = Bus.subscribe((event) => {
      if (event.sessionId !== sessionId || event.projectPath !== projectPath) return;
      if (event.type === 'permission.asked') {
        clearTimeout(timeout);
        unsubscribe();
        reject(new Error('Recovered YOLO Web session unexpectedly requested approval'));
      } else if (event.type === 'session.completed') {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      } else if (event.type === 'session.error') {
        clearTimeout(timeout);
        unsubscribe();
        reject(new Error(String(event.properties.error ?? 'Web run failed')));
      }
    });
  });
  return {
    promise,
    cancel() {
      if (timeout) clearTimeout(timeout);
      unsubscribe();
    },
  };
}

describeReal('Session permission mode recovery trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  async function createFixture(surface: 'web' | 'acp' | 'headless') {
    if (!gpt) throw new Error('GPT qualification channel is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-mode-recovery-'));
    const workspace = path.join(root, surface);
    const originalConfig = getState().config.config;
    const baseConfig = buildRealApiRuntimeConfig(gpt);
    const config = {
      ...baseConfig,
      permissionMode: PermissionMode.DEFAULT,
      models: baseConfig.models.map((model) => ({
        ...model,
        overrides: {
          ...model.overrides,
          timeout: 180_000,
          maxRetries: 0,
        },
      })),
    };
    process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
    await mkdir(workspace, { recursive: true });
    getState().config.actions.setConfig(config);
    const sessionId = `mode-${surface}-${Date.now()}`;
    await SessionService.createSessionMetadata(sessionId, workspace, {
      taskStatus: 'completed',
      selectedModelId: config.currentModelId,
      permissionMode: 'yolo',
    });
    return { root, workspace, originalConfig, config, sessionId };
  }

  it('restores durable YOLO for a Web cold start', async () => {
    if (!gpt) throw new Error('GPT qualification channel is unavailable');
    const fixture = await createFixture('web');
    const controller = createSessionRouteController();
    const app = controller.app;
    const loggerError = vi.spyOn(Logger.prototype, 'error');
    let webCompletion: Awaited<ReturnType<typeof waitForWebCompletion>> | undefined;

    try {
      webCompletion = await waitForWebCompletion(fixture.sessionId, fixture.workspace);
      const webResponse = await runWithCwdOverride(fixture.workspace, () =>
        app.request(`/${fixture.sessionId}/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content: writePrompt('web-mode.txt', 'WEB_MODE_RECOVERED'),
            projectPath: fixture.workspace,
          }),
        })
      );
      if (webResponse.status !== 202) webCompletion.cancel();
      expect(
        webResponse.status,
        JSON.stringify({
          body: await webResponse.clone().text(),
          errors: loggerError.mock.calls.map((call) =>
            call.map((value) =>
              value instanceof Error
                ? {
                    name: value.name,
                    message: value.message,
                    stack: value.stack,
                  }
                : value
            )
          ),
        }).replaceAll(gpt.apiKey, '[redacted]')
      ).toBe(202);
      await webCompletion.promise;
      expect(await readFile(path.join(fixture.workspace, 'web-mode.txt'), 'utf8')).toBe(
        'WEB_MODE_RECOVERED\n'
      );
      const metadata = await SessionService.findSessionMetadata(
        fixture.sessionId,
        fixture.workspace
      );
      expect(metadata).toMatchObject({ permissionMode: 'yolo' });
      assertNoSecrets(metadata, [gpt.apiKey]);
    } finally {
      try {
        webCompletion?.cancel();
        await Promise.resolve(
          app.request(
            `/${fixture.sessionId}/abort?projectPath=${encodeURIComponent(
              fixture.workspace
            )}`,
            { method: 'POST' }
          )
        ).catch(() => undefined);
        await Promise.resolve(
          app.request(
            `/${fixture.sessionId}?projectPath=${encodeURIComponent(
              fixture.workspace
            )}`,
            { method: 'DELETE' }
          )
        ).catch(() => undefined);
      } finally {
        try {
          await controller.shutdown('permission mode Web qualification cleanup');
        } finally {
          loggerError.mockRestore();
          if (fixture.originalConfig) {
            getState().config.actions.setConfig(fixture.originalConfig);
          }
          await rm(fixture.root, { recursive: true, force: true });
        }
      }
    }
  }, 240_000);

  it('restores durable YOLO for an ACP cold start', async () => {
    if (!gpt) throw new Error('GPT qualification channel is unavailable');
    const fixture = await createFixture('acp');
    const acpClient = createMockACPClient();
    const acpAgent = new BladeAgent(acpClient as never);

    try {
      const acpSetup = await runWithCwdOverride(fixture.workspace, () =>
        acpAgent.loadSession({
          sessionId: fixture.sessionId,
          cwd: fixture.workspace,
          mcpServers: [],
        })
      );
      expect(acpSetup.modes?.currentModeId).toBe('yolo');
      const acpResponse = await runWithCwdOverride(fixture.workspace, () =>
        acpAgent.prompt({
          sessionId: fixture.sessionId,
          prompt: [
            {
              type: 'text',
              text: writePrompt('acp-mode.txt', 'ACP_MODE_RECOVERED'),
            },
          ],
        })
      );
      expect(acpResponse.stopReason).toBe('end_turn');
      expect(acpClient.permissionRequests).toHaveLength(0);
      const acpHostFile = await readFile(
        path.join(fixture.workspace, 'acp-mode.txt'),
        'utf8'
      ).catch(() => undefined);
      const acpClientFile = [...acpClient.files.values()].find(
        (value) => value === 'ACP_MODE_RECOVERED\n'
      );
      expect(
        acpHostFile ?? acpClientFile,
        JSON.stringify(acpClient.sessionUpdates).replaceAll(gpt.apiKey, '[redacted]')
      ).toBe('ACP_MODE_RECOVERED\n');
      assertNoSecrets(
        {
          metadata: await SessionService.findSessionMetadata(
            fixture.sessionId,
            fixture.workspace
          ),
          setup: acpSetup,
          updates: acpClient.sessionUpdates,
        },
        [gpt.apiKey]
      );
    } finally {
      await acpAgent.destroy().catch(() => undefined);
      if (fixture.originalConfig) {
        getState().config.actions.setConfig(fixture.originalConfig);
      }
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 240_000);

  it('restores durable YOLO for a headless cold start', async () => {
    if (!gpt) throw new Error('GPT qualification channel is unavailable');
    const fixture = await createFixture('headless');

    try {
      const stdout = { write: (_chunk: string) => true };
      const stderrChunks: string[] = [];
      const stderr = {
        write: (chunk: string) => {
          stderrChunks.push(String(chunk));
          return true;
        },
      };
      const headlessExit = await runWithCwdOverride(fixture.workspace, () =>
        runHeadless(
          {
            headless: true,
            message: writePrompt('headless-mode.txt', 'HEADLESS_MODE_RECOVERED'),
            resume: fixture.sessionId,
          },
          { stdout, stderr }
        )
      );
      expect(
        headlessExit,
        stderrChunks.join('').replaceAll(gpt.apiKey, '[redacted]')
      ).toBe(0);
      expect(
        await readFile(path.join(fixture.workspace, 'headless-mode.txt'), 'utf8')
      ).toBe('HEADLESS_MODE_RECOVERED\n');
      expect(stderrChunks.join('')).not.toContain('requires user confirmation');
      const metadata = await SessionService.findSessionMetadata(
        fixture.sessionId,
        fixture.workspace
      );
      expect(metadata).toMatchObject({ permissionMode: 'yolo' });
      assertNoSecrets(
        {
          metadata,
          stderr: stderrChunks,
        },
        [gpt.apiKey]
      );
    } finally {
      if (fixture.originalConfig) {
        getState().config.actions.setConfig(fixture.originalConfig);
      }
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 240_000);
});

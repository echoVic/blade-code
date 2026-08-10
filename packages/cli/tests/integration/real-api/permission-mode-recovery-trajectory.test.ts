import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BladeAgent } from '../../../src/acp/BladeAgent.js';
import { PermissionMode } from '../../../src/config/types.js';
import { Logger } from '../../../src/logging/Logger.js';
import { runHeadless } from '../../../src/commands/headless.js';
import { Bus } from '../../../src/server/bus.js';
import { SessionRoutes } from '../../../src/server/routes/session.js';
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
    }, 180_000);
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

  it('restores durable YOLO across Web, ACP, and headless cold starts', async () => {
    if (!gpt) throw new Error('GPT qualification channel is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-mode-recovery-'));
    const webWorkspace = path.join(root, 'web');
    const acpWorkspace = path.join(root, 'acp');
    const headlessWorkspace = path.join(root, 'headless');
    const originalConfig = getState().config.config;
    const config = {
      ...buildRealApiRuntimeConfig(gpt),
      permissionMode: PermissionMode.DEFAULT,
    };
    const app = SessionRoutes();
    const loggerError = vi.spyOn(Logger.prototype, 'error');
    const acpClient = createMockACPClient();
    const acpAgent = new BladeAgent(acpClient as never);
    const evidence: Record<string, unknown> = {};

    try {
      process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
      await Promise.all(
        [webWorkspace, acpWorkspace, headlessWorkspace].map((workspace) =>
          mkdir(workspace, { recursive: true })
        )
      );
      getState().config.actions.setConfig(config);

      const webSessionId = `mode-web-${Date.now()}`;
      await SessionService.createSessionMetadata(webSessionId, webWorkspace, {
        taskStatus: 'completed',
        selectedModelId: config.currentModelId,
        permissionMode: 'yolo',
      });
      const webCompletion = await waitForWebCompletion(webSessionId, webWorkspace);
      const webResponse = await runWithCwdOverride(webWorkspace, () =>
        app.request(`/${webSessionId}/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content: writePrompt('web-mode.txt', 'WEB_MODE_RECOVERED'),
            projectPath: webWorkspace,
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
      expect(await readFile(path.join(webWorkspace, 'web-mode.txt'), 'utf8')).toBe(
        'WEB_MODE_RECOVERED\n'
      );
      evidence.web = await SessionService.findSessionMetadata(
        webSessionId,
        webWorkspace
      );
      await app.request(
        `/${webSessionId}?projectPath=${encodeURIComponent(webWorkspace)}`,
        { method: 'DELETE' }
      );

      const acpSessionId = `mode-acp-${Date.now()}`;
      await SessionService.createSessionMetadata(acpSessionId, acpWorkspace, {
        taskStatus: 'completed',
        selectedModelId: config.currentModelId,
        permissionMode: 'yolo',
      });
      const acpSetup = await runWithCwdOverride(acpWorkspace, () =>
        acpAgent.loadSession({
          sessionId: acpSessionId,
          cwd: acpWorkspace,
          mcpServers: [],
        })
      );
      expect(acpSetup.modes?.currentModeId).toBe('yolo');
      const acpResponse = await runWithCwdOverride(acpWorkspace, () =>
        acpAgent.prompt({
          sessionId: acpSessionId,
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
        path.join(acpWorkspace, 'acp-mode.txt'),
        'utf8'
      ).catch(() => undefined);
      const acpClientFile = [...acpClient.files.values()].find(
        (value) => value === 'ACP_MODE_RECOVERED\n'
      );
      expect(
        acpHostFile ?? acpClientFile,
        JSON.stringify(acpClient.sessionUpdates).replaceAll(gpt.apiKey, '[redacted]')
      ).toBe('ACP_MODE_RECOVERED\n');
      evidence.acp = {
        setup: acpSetup,
        updates: acpClient.sessionUpdates,
      };
      await acpAgent.destroy();

      const headlessSessionId = `mode-headless-${Date.now()}`;
      await SessionService.createSessionMetadata(headlessSessionId, headlessWorkspace, {
        taskStatus: 'completed',
        selectedModelId: config.currentModelId,
        permissionMode: 'yolo',
      });
      const stdout = { write: (_chunk: string) => true };
      const stderrChunks: string[] = [];
      const stderr = {
        write: (chunk: string) => {
          stderrChunks.push(String(chunk));
          return true;
        },
      };
      const headlessExit = await runWithCwdOverride(headlessWorkspace, () =>
        runHeadless(
          {
            headless: true,
            message: writePrompt('headless-mode.txt', 'HEADLESS_MODE_RECOVERED'),
            resume: headlessSessionId,
          },
          { stdout, stderr }
        )
      );
      expect(headlessExit).toBe(0);
      expect(
        await readFile(path.join(headlessWorkspace, 'headless-mode.txt'), 'utf8')
      ).toBe('HEADLESS_MODE_RECOVERED\n');
      expect(stderrChunks.join('')).not.toContain('requires user confirmation');
      evidence.headless = await SessionService.findSessionMetadata(
        headlessSessionId,
        headlessWorkspace
      );

      expect(evidence.web).toMatchObject({ permissionMode: 'yolo' });
      expect(evidence.headless).toMatchObject({ permissionMode: 'yolo' });
      assertNoSecrets(evidence, [gpt.apiKey]);
    } finally {
      await acpAgent.destroy().catch(() => undefined);
      loggerError.mockRestore();
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await rm(root, { recursive: true, force: true });
    }
  }, 360_000);
});

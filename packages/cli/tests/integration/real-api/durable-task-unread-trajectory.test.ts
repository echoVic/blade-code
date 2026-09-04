import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PermissionMode } from '../../../src/config/types.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { runDurableTaskUnreadWebDriver } from '../../support/durableTaskUnreadWebDriver.js';
import { startRecordingProviderProxy } from '../../support/recordingProviderProxy.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
} from './testConfig.js';

const enabled = isRealApiTestEnabled();
const models = enabled ? resolveRequiredDeepSeekQualificationModels() : [];
if (enabled && process.env.REAL_API_RELEASE_MATRIX !== '1') {
  throw new Error('Durable unread qualification requires REAL_API_RELEASE_MATRIX=1');
}

function modelMarker(model: string): string {
  return model.toUpperCase().replaceAll(/[^A-Z0-9]+/g, '_');
}

async function waitForProviderHold(
  heldRequestNumbers: readonly number[],
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (heldRequestNumbers.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for the real Provider request hold');
}

const describeDurableUnread = enabled ? describe.sequential : describe.skip;

describeDurableUnread('Durable task unread Web trajectory (real API)', () => {
  it.skipIf(enabled)('requires the real API release matrix', () => undefined);

  for (const model of models) {
    it(`${model.model} recovers a missed terminal result in production Chromium`, async () => {
      if (!model.baseURL)
        throw new Error(`Missing Provider base URL for ${model.model}`);
      const root = await mkdtemp('/tmp/bladedurableunread');
      const workspace = path.join(root, 'workspace');
      const siblingWorkspace = path.join(root, 'sibling');
      const storageRoot = path.join(root, 'storage');
      const home = path.join(root, 'home');
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(siblingWorkspace, { recursive: true }),
        mkdir(storageRoot, { recursive: true }),
        mkdir(path.join(home, '.blade'), { recursive: true }),
      ]);
      await writeFile(
        path.join(workspace, 'README.md'),
        '# Durable unread real Provider fixture\n'
      );

      const proxy = await startRecordingProviderProxy(model.baseURL, {
        holdRequestNumber: 1,
        holdMs: 240_000,
      });
      const runtimeConfig = buildRealApiRuntimeConfig({
        ...model,
        baseURL: proxy.baseUrl,
      });
      const configuredModel = runtimeConfig.models[0];
      if (!configuredModel) throw new Error('Real API runtime model is missing');
      const modelId = runtimeConfig.currentModelId;
      await writeFile(
        path.join(home, '.blade', 'config.json'),
        `${JSON.stringify(
          {
            currentModelId: modelId,
            models: [
              {
                ...configuredModel,
                overrides: {
                  ...configuredModel.overrides,
                  maxRetries: 0,
                },
              },
            ],
            modelProviders: runtimeConfig.modelProviders,
            permissionMode: PermissionMode.YOLO,
            maxTurns: 4,
            providerRequestConcurrency: 1,
            providerRequestAdmissionMs: 120_000,
            providerForegroundRecoveryMs: 0,
            hooks: { enabled: false },
            disableAllHooks: true,
            mcpServers: {},
          },
          null,
          2
        )}\n`,
        { mode: 0o600 }
      );

      const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
      try {
        process.env.BLADE_STORAGE_ROOT = storageRoot;
        const marker = `DURABLE_UNREAD_${modelMarker(model.model)}_${Date.now()}`;
        const evidence = await runDurableTaskUnreadWebDriver({
          workspace,
          storageRoot,
          home,
          model: model.model,
          modelId,
          marker,
          secret: model.apiKey,
          seedSibling: async (backgroundTask) => {
            await SessionService.createSessionMetadata(
              backgroundTask.sessionId,
              siblingWorkspace,
              { title: `Unread sibling ${model.model}`, taskStatus: 'completed' }
            );
            return {
              sessionId: backgroundTask.sessionId,
              projectPath: siblingWorkspace,
            };
          },
          releaseProvider: proxy.releaseHeld,
          waitForProviderHold: (timeoutMs) =>
            waitForProviderHold(proxy.heldRequestNumbers, timeoutMs),
        });

        expect(proxy.forwardedRequestNumbers).toContain(1);
        expect(proxy.injectedRequestNumbers).toEqual([]);
        expect(proxy.requestLifecycle).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ requestNumber: 1, phase: 'upstream_started' }),
            expect.objectContaining({ requestNumber: 1, phase: 'headers_received' }),
            expect.objectContaining({ requestNumber: 1, phase: 'body_completed' }),
          ])
        );
        expect(evidence).toMatchObject({
          model: model.model,
          frameworkRetries: 0,
          modelMaxRetries: 0,
          statusSequence: ['running', 'completed'],
          unreadAfterMissedCompletion: {
            browserUnread: true,
            siblingUnread: true,
            titleCount: 2,
          },
          unreadAfterReload: {
            browserUnread: true,
            siblingUnread: true,
            titleCount: 2,
          },
          titleCountAfterReload: 2,
          siblingUnreadPreserved: true,
          browserFaults: [],
          serverFaults: [],
          leakedSecrets: [],
        });
        expect(evidence.selectedAfterClick).toEqual(evidence.backgroundTask);
        expect(evidence.selectedBefore).not.toEqual(evidence.backgroundTask);
        expect(evidence.durationMs).toBeGreaterThan(0);
        assertNoSecrets(evidence, [model.apiKey]);
        console.log(
          `[durable-task-unread] ${JSON.stringify({
            ...evidence,
            providerRequests: proxy.forwardedRequestNumbers.length,
          })}`
        );
      } finally {
        proxy.releaseHeld();
        await proxy.close();
        if (originalStorageRoot === undefined) {
          delete process.env.BLADE_STORAGE_ROOT;
        } else {
          process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
        }
        await rm(root, { recursive: true, force: true });
      }
    }, 300_000);
  }
});

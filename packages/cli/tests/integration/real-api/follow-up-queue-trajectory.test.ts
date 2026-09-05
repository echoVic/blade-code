import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, type TestContext } from 'vitest';
import { PermissionMode } from '../../../src/config/types.js';
import { runFollowUpQueuePtyDriver } from '../../support/followUpQueuePtyDriver.js';
import { runFollowUpQueueWebDriver } from '../../support/followUpQueueWebDriver.js';
import { startRecordingProviderProxy } from '../../support/recordingProviderProxy.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
} from './testConfig.js';

const execFileAsync = promisify(execFile);
const enabled = isRealApiTestEnabled();
const models = enabled ? resolveRequiredDeepSeekQualificationModels() : [];
const surfaces = ['web', 'tui', 'acp'] as const;
const cliEntry = path.resolve(import.meta.dirname, '../../../dist/blade.js');
const acpRunner = path.resolve(
  import.meta.dirname,
  '../../support/followUpQueueAcpRunner.ts'
);

if (enabled && process.env.REAL_API_RELEASE_MATRIX !== '1') {
  throw new Error('Follow-up queue qualification requires REAL_API_RELEASE_MATRIX=1');
}

function frameworkRetryBudget(context: TestContext): number {
  const retry = context.task.retry;
  return typeof retry === 'number' ? retry : (retry?.count ?? 0);
}

function marker(model: string, surface: string, label: string): string {
  return `FOLLOW_UP_${model}_${surface}_${label}_${Date.now()}`
    .toUpperCase()
    .replaceAll(/[^A-Z0-9_]+/g, '_');
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)}`);
}

function assertProviderOrder(
  bodies: readonly string[],
  firstMarker: string,
  movedMarker: string,
  deletedMarker: string
): void {
  expect(bodies).toHaveLength(2);
  const consumed = bodies[1]!;
  expect(consumed.indexOf(firstMarker)).toBeGreaterThanOrEqual(0);
  expect(consumed.indexOf(movedMarker)).toBeGreaterThan(consumed.indexOf(firstMarker));
  expect(consumed).not.toContain(deletedMarker);
  expect(count(consumed, firstMarker)).toBe(1);
  expect(count(consumed, movedMarker)).toBe(1);
}

const describeTrajectory =
  enabled && process.platform !== 'win32' ? describe.sequential : describe.skip;

describeTrajectory('durable follow-up queue surface matrix (real API)', () => {
  it.skipIf(enabled)('requires the real API release matrix', () => undefined);

  for (const model of models) {
    for (const surface of surfaces) {
      it(`${model.model} controls follow-ups through ${surface}`, async (context) => {
        const frameworkRetries = frameworkRetryBudget(context);
        expect(frameworkRetries).toBe(0);
        if (!model.baseURL) throw new Error(`Missing base URL for ${model.model}`);
        await access(cliEntry);
        const root = await mkdtemp(path.join(os.tmpdir(), 'blade-follow-up-real-'));
        const workspacePath = path.join(root, 'workspace');
        const storageRoot = path.join(root, 'storage');
        const home = path.join(root, 'home');
        const providerHoldFile = path.join(root, 'provider-hold');
        const providerReleaseFile = path.join(root, 'provider-release');
        const proxy = await startRecordingProviderProxy(model.baseURL, {
          holdRequestNumber: 1,
          holdMs: 240_000,
          onHold: async () => {
            await writeFile(providerHoldFile, 'held\n', { mode: 0o600 });
          },
        });
        let releaseWatcher: Promise<void> | undefined;
        try {
          await Promise.all([
            mkdir(workspacePath, { recursive: true }),
            mkdir(storageRoot, { recursive: true }),
            mkdir(path.join(home, '.blade'), { recursive: true }),
          ]);
          const workspace = await realpath(workspacePath);
          const runtime = buildRealApiRuntimeConfig({
            ...model,
            baseURL: proxy.baseUrl,
          });
          const baseModel = runtime.models[0];
          if (!baseModel) throw new Error('Follow-up model configuration is absent');
          const configuredModel = {
            ...baseModel,
            overrides: { ...baseModel.overrides, maxRetries: 0 },
          };
          expect(configuredModel.overrides?.maxRetries).toBe(0);
          await writeFile(
            path.join(home, '.blade', 'config.json'),
            `${JSON.stringify(
              {
                currentModelId: runtime.currentModelId,
                models: [configuredModel],
                modelProviders: runtime.modelProviders,
                permissionMode: PermissionMode.YOLO,
                maxTurns: 4,
                hooks: { enabled: false },
                disableAllHooks: true,
                mcpServers: {},
              },
              null,
              2
            )}\n`,
            { mode: 0o600 }
          );

          const firstMarker = marker(model.model, surface, 'A');
          const deletedMarker = marker(model.model, surface, 'B_DELETE');
          const movedMarker = marker(model.model, surface, 'C_MOVE');
          const expectedOutput = marker(model.model, surface, 'DONE');
          const activeMovedInput = `${movedMarker}. Now output exactly ${expectedOutput} and nothing else.`;
          const primaryPrompt = [
            'Wait for later instructions and then answer briefly.',
            `When asked for a final marker, output exactly ${expectedOutput}.`,
          ].join(' ');
          let evidence: unknown;

          if (surface === 'web') {
            evidence = await runFollowUpQueueWebDriver({
              workspace,
              storageRoot,
              home,
              primaryPrompt,
              firstMarker,
              deletedMarker,
              movedMarker: activeMovedInput,
              expectedOutput,
              providerApiKey: model.apiKey,
              secrets: [model.apiKey],
              waitForProviderHold: () => waitForFile(providerHoldFile, 30_000),
              releaseProvider: proxy.releaseHeld,
            });
          } else if (surface === 'tui') {
            evidence = await runFollowUpQueuePtyDriver({
              workspace,
              storageRoot,
              home,
              sessionId: `follow-up-${surface}-${Date.now()}`,
              primaryPrompt,
              firstMarker,
              deletedMarker,
              movedMarker: activeMovedInput,
              expectedOutput,
              providerApiKey: model.apiKey,
              secrets: [model.apiKey],
              waitForProviderHold: () => waitForFile(providerHoldFile, 30_000),
              releaseProvider: proxy.releaseHeld,
              timeoutMs: 240_000,
            });
          } else {
            releaseWatcher = waitForFile(providerReleaseFile, 60_000).then(() => {
              proxy.releaseHeld();
            });
            const encoded = Buffer.from(
              JSON.stringify({
                cliEntry,
                workspace,
                home,
                storageRoot,
                primaryPrompt,
                firstMarker,
                deletedMarker,
                movedMarker: activeMovedInput,
                expectedOutput,
                providerHoldFile,
                providerReleaseFile,
                secret: model.apiKey,
              }),
              'utf8'
            ).toString('base64');
            const result = await execFileAsync('bun', [acpRunner], {
              cwd: path.resolve(import.meta.dirname, '../../..'),
              env: {
                ...process.env,
                BLADE_FOLLOW_UP_ACP_INPUT: encoded,
              },
              timeout: 240_000,
              maxBuffer: 256 * 1024,
              killSignal: 'SIGKILL',
            });
            await releaseWatcher;
            evidence = JSON.parse(result.stdout);
          }

          if (surface === 'acp') {
            expect(proxy.requestBodies).toHaveLength(2);
            const consumed = proxy.requestBodies[1]!;
            expect(consumed.indexOf(firstMarker)).toBeGreaterThanOrEqual(0);
            expect(consumed.indexOf(movedMarker)).toBeGreaterThan(
              consumed.indexOf(firstMarker)
            );
            expect(count(consumed, firstMarker)).toBe(1);
            expect(count(consumed, movedMarker)).toBe(1);
          } else {
            assertProviderOrder(
              proxy.requestBodies,
              firstMarker,
              activeMovedInput,
              deletedMarker
            );
          }
          const record = evidence as Record<string, unknown>;
          expect(record.success).toBe(true);
          expect(record.cleanupComplete).toBe(true);
          expect(record.leakedSecrets).toEqual([]);
          const releaseEvidence = {
            model: model.model,
            surface,
            frameworkRetries,
            modelMaxRetries: 0,
            providerRequests: proxy.requestBodies.length,
            setupRequests: 1,
            queueConsumptionRequests: 1,
            appliedOrder: [firstMarker, movedMarker],
            deletedMarkerObservedUpstream: proxy.requestBodies.some((body) =>
              body.includes(deletedMarker)
            ),
            cleanupComplete: record.cleanupComplete,
            leakedSecrets: record.leakedSecrets,
          };
          expect(releaseEvidence).toMatchObject({
            frameworkRetries: 0,
            modelMaxRetries: 0,
            providerRequests: 2,
            setupRequests: 1,
            queueConsumptionRequests: 1,
            appliedOrder: [firstMarker, movedMarker],
            deletedMarkerObservedUpstream: false,
            cleanupComplete: true,
            leakedSecrets: [],
          });
          assertNoSecrets({ evidence, releaseEvidence }, [model.apiKey]);
          console.log(`[follow-up-queue] ${JSON.stringify(releaseEvidence)}`);
        } finally {
          proxy.releaseHeld();
          await releaseWatcher?.catch(() => undefined);
          await proxy.close().catch(() => undefined);
          await rm(root, { recursive: true, force: true });
        }
      }, 300_000);
    }
  }
});

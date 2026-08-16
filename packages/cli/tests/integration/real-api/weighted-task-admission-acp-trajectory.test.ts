import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  type ProcessIdentity,
  processIdentityMatches,
} from '../../../src/utils/process/ProcessIdentity.js';
import { startRecordingProviderProxy } from '../../support/recordingProviderProxy.js';
import { findSessionTranscript } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  expandDeepSeekModelMatrix,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
} from './testConfig.js';

const execFileAsync = promisify(execFile);
const models = isRealApiTestEnabled()
  ? expandDeepSeekModelMatrix(
      getEnabledModelConfigs().filter((config) => config.id === 'deepseek')
    )
  : [];
const runner = path.resolve(
  import.meta.dirname,
  '../../support/weightedTaskAdmissionAcpRunner.ts'
);
const cliEntry = path.resolve(import.meta.dirname, '../../../dist/blade.js');

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

describe
  .skipIf(!isRealApiTestEnabled())
  .sequential('bounded weighted task admission ACP control', () => {
    it.each(
      models
    )('$model rejects an overweight task Session before Provider traffic', async (model) => {
      if (!model.baseURL) {
        throw new Error(`Missing Provider base URL for ${model.model}`);
      }
      const root = await mkdtemp(
        path.join(os.tmpdir(), `blade-weighted-task-acp-${safeSlug(model.model)}-`)
      );
      const home = path.join(root, 'home');
      const storageRoot = path.join(root, 'storage');
      const workspace = path.join(root, 'workspace');
      const providerHoldPath = path.join(root, 'provider-hold-ready');
      const providerReleasePath = path.join(root, 'provider-release-ready');
      const proxy = await startRecordingProviderProxy(model.baseURL, {
        holdRequestNumber: 1,
        holdMs: 120_000,
        onHold: async () => {
          await writeFile(providerHoldPath, 'ready\n');
        },
      });
      const config = buildRealApiRuntimeConfig({
        ...model,
        baseURL: proxy.baseUrl,
      });
      const primaryMarker = `WEIGHTED_TASK_ACP_PRIMARY_${Date.now()}`;
      const rejectedMarker = `WEIGHTED_TASK_ACP_REJECTED_${Date.now()}`;
      const queuedMarker = `WEIGHTED_TASK_ACP_QUEUED_${Date.now()}`;
      try {
        await Promise.all([
          mkdir(path.join(home, '.blade'), { recursive: true }),
          mkdir(storageRoot, { recursive: true }),
          mkdir(workspace, { recursive: true }),
        ]);
        await writeFile(
          path.join(home, '.blade', 'config.json'),
          `${JSON.stringify(
            {
              currentModelId: config.currentModelId,
              models: config.models,
              modelProviders: config.modelProviders,
              permissionMode: 'yolo',
              maxConcurrentTasks: 1,
              maxQueuedTasks: 100,
              maxQueuedTaskBytes: 64 * 1024,
              providerCircuitBreakerOpenMs: 0,
              hooks: { enabled: false },
              disableAllHooks: true,
              mcpServers: {},
            },
            null,
            2
          )}\n`,
          { mode: 0o600 }
        );
        const encoded = Buffer.from(
          JSON.stringify({
            cliEntry,
            workspace,
            home,
            storageRoot,
            providerHoldPath,
            providerReleasePath,
            primaryMarker,
            rejectedMarker,
            queuedMarker,
            secret: model.apiKey,
          }),
          'utf8'
        ).toString('base64');
        let stdout = '';
        let stderr = '';
        const runnerResult = execFileAsync('bun', [runner], {
          cwd: path.resolve(import.meta.dirname, '../../..'),
          env: {
            ...process.env,
            BLADE_WEIGHTED_TASK_ACP_INPUT: encoded,
          },
          timeout: 240_000,
          maxBuffer: 1024 * 1024,
          killSignal: 'SIGKILL',
        });
        await waitFor(async () => {
          try {
            await access(providerReleasePath);
            return true;
          } catch {
            return false;
          }
        }, 'Weighted task ACP runner did not finish rejection and normal queueing');
        proxy.releaseHeld();
        try {
          const result = await runnerResult;
          stdout = result.stdout;
          stderr = result.stderr;
        } catch (error) {
          const failure = error as Error & { stdout?: string; stderr?: string };
          stdout = failure.stdout ?? stdout;
          stderr = failure.stderr ?? stderr;
        }

        const evidence = JSON.parse(stdout.trim()) as {
          success?: unknown;
          error?: unknown;
          primarySessionId?: unknown;
          rejectedSessionId?: unknown;
          queuedSessionId?: unknown;
          rejectedMetadata?: unknown;
          queuedMetadata?: unknown;
          rejectedPromptFailed?: unknown;
          output?: unknown;
          processes?: Array<{ pid: number; identity: ProcessIdentity }>;
        };
        expect(
          evidence.success,
          `${String(evidence.error)}\n${stderr.replaceAll(model.apiKey, '[redacted]')}`
        ).toBe(true);
        expect(evidence.rejectedPromptFailed).toBe(true);
        expect(evidence.rejectedMetadata).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              'blade/taskStatus': 'failed',
              'blade/taskFailure': expect.objectContaining({
                code: 'capacity',
                retryable: true,
                resource: 'pending_bytes',
              }),
            }),
          ])
        );
        expect(evidence.queuedMetadata).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              'blade/taskStatus': 'queued',
              'blade/taskQueuePosition': 1,
            }),
            expect.objectContaining({
              'blade/taskStatus': 'running',
            }),
          ])
        );

        expect(proxy.requestBodies.length).toBeGreaterThanOrEqual(2);
        expect(proxy.requestBodies.join('\n')).toContain(primaryMarker);
        expect(proxy.requestBodies.join('\n')).toContain(queuedMarker);
        expect(
          proxy.requestBodies.every((body) => !body.includes(rejectedMarker))
        ).toBe(true);
        expect(proxy.maxInFlight).toBe(1);
        expect(proxy.heldRequestNumbers).toEqual([1]);
        const [primaryTranscript, rejectedTranscript, queuedTranscript] =
          await Promise.all([
            readFile(
              findSessionTranscript(storageRoot, String(evidence.primarySessionId)),
              'utf8'
            ),
            readFile(
              findSessionTranscript(storageRoot, String(evidence.rejectedSessionId)),
              'utf8'
            ),
            readFile(
              findSessionTranscript(storageRoot, String(evidence.queuedSessionId)),
              'utf8'
            ),
          ]);
        expect(
          `${primaryTranscript}${rejectedTranscript}${queuedTranscript}`
        ).not.toContain(rejectedMarker);
        expect(JSON.stringify(evidence)).not.toContain(model.apiKey);
        for (const process of evidence.processes ?? []) {
          expect(processIdentityMatches(process.pid, process.identity)).toBe(false);
        }
      } finally {
        proxy.releaseHeld();
        await proxy.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 300_000);
  });

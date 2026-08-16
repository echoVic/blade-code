import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  '../../support/weightedProviderAdmissionAcpRunner.ts'
);
const cliEntry = path.resolve(import.meta.dirname, '../../../dist/blade.js');

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

describe
  .skipIf(!isRealApiTestEnabled())
  .sequential('bounded weighted Provider admission ACP control', () => {
    it.each(models)(
      '$model rejects a second real ACP Session before Provider traffic',
      async (model) => {
        if (!model.baseURL)
          throw new Error(`Missing Provider base URL for ${model.model}`);
        const root = await mkdtemp(
          path.join(
            os.tmpdir(),
            `blade-weighted-admission-acp-${safeSlug(model.model)}-`
          )
        );
        const home = path.join(root, 'home');
        const storageRoot = path.join(root, 'storage');
        const workspace = path.join(root, 'workspace');
        const barrierPath = path.join(root, 'provider-hold-ready');
        const proxy = await startRecordingProviderProxy(model.baseURL, {
          holdRequestNumber: 1,
          holdMs: 10_000,
          onHold: async () => {
            await writeFile(barrierPath, 'ready\n');
          },
        });
        const config = buildRealApiRuntimeConfig({
          ...model,
          baseURL: proxy.baseUrl,
        });
        const primaryMarker = `WEIGHTED_ACP_PRIMARY_${Date.now()}`;
        const secondaryMarker = `WEIGHTED_ACP_SECONDARY_${Date.now()}`;
        try {
          await Promise.all([
            mkdir(path.join(home, '.blade'), { recursive: true }),
            mkdir(storageRoot, { recursive: true }),
            mkdir(workspace, { recursive: true }),
          ]);
          await writeFile(
            path.join(workspace, 'AGENTS.md'),
            `# Weighted admission fixture\n\n<!-- ${'a'.repeat(
              30 * 1024
            )} -->\nFollow the current user request exactly.\n`
          );
          await writeFile(
            path.join(home, '.blade', 'config.json'),
            `${JSON.stringify(
              {
                currentModelId: config.currentModelId,
                models: config.models,
                modelProviders: config.modelProviders,
                permissionMode: 'yolo',
                providerRequestConcurrency: 1,
                providerRequestAdmissionMs: 120_000,
                providerRequestPendingBytes: 64 * 1024,
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
              barrierPath,
              primaryMarker,
              secondaryMarker,
              secret: model.apiKey,
            }),
            'utf8'
          ).toString('base64');
          let stdout = '';
          let stderr = '';
          try {
            const result = await execFileAsync('bun', [runner], {
              cwd: path.resolve(import.meta.dirname, '../../..'),
              env: {
                ...process.env,
                BLADE_WEIGHTED_ADMISSION_ACP_INPUT: encoded,
              },
              timeout: 180_000,
              maxBuffer: 1024 * 1024,
              killSignal: 'SIGKILL',
            });
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
            secondarySessionId?: unknown;
            metadata?: unknown;
            secondaryRejected?: unknown;
            output?: unknown;
            processes?: Array<{ pid: number; identity: ProcessIdentity }>;
          };
          expect(
            evidence.success,
            `${String(evidence.error)}\n${stderr.replaceAll(model.apiKey, '[redacted]')}`
          ).toBe(true);
          expect(evidence.secondaryRejected).toBe(true);
          expect(evidence.primarySessionId).toBeTypeOf('string');
          expect(evidence.secondarySessionId).toBeTypeOf('string');
          expect(evidence.metadata).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                phase: 'rejected',
                requestClass: 'foreground',
                resource: 'pending_bytes',
                reason: 'queue_full',
              }),
              null,
            ])
          );

          expect(proxy.requestBodies.length).toBeGreaterThanOrEqual(1);
          expect(
            proxy.requestBodies.every((body) => !body.includes(secondaryMarker))
          ).toBe(true);
          expect(proxy.maxInFlight).toBe(1);
          expect(proxy.heldRequestNumbers).toEqual([1]);
          expect(
            (proxy.requestFinishedAt[0] ?? 0) - (proxy.requestStartedAt[0] ?? 0)
          ).toBeGreaterThanOrEqual(9_500);
          const [primaryTranscript, secondaryTranscript] = await Promise.all([
            readFile(
              findSessionTranscript(storageRoot, String(evidence.primarySessionId)),
              'utf8'
            ),
            readFile(
              findSessionTranscript(storageRoot, String(evidence.secondarySessionId)),
              'utf8'
            ),
          ]);
          expect(`${primaryTranscript}${secondaryTranscript}`).not.toContain(
            'provider_admission'
          );
          expect(JSON.stringify(evidence)).not.toContain(model.apiKey);
          for (const process of evidence.processes ?? []) {
            expect(processIdentityMatches(process.pid, process.identity)).toBe(false);
          }
        } finally {
          await proxy.close();
          await rm(root, { recursive: true, force: true });
        }
      },
      240_000
    );
  });

import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
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
  '../../support/sessionRuntimeResidencyAcpRunner.ts'
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

async function readTree(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  const values: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      values.push(await readTree(entryPath));
    } else if (entry.isFile()) {
      values.push(await readFile(entryPath, 'utf8').catch(() => ''));
    }
  }
  return values.join('\n');
}

describe
  .skipIf(!isRealApiTestEnabled())
  .sequential('bounded Session Runtime residency ACP control', () => {
    it.each(
      models
    )('$model releases one active resident through standard session/close', async (model) => {
      if (!model.baseURL) {
        throw new Error(`Missing Provider base URL for ${model.model}`);
      }
      const root = await mkdtemp(
        path.join(os.tmpdir(), `blade-session-residency-acp-${safeSlug(model.model)}-`)
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
      const primaryMarker = `SESSION_RESIDENCY_ACP_A_${Date.now()}`;
      const rejectedMarker = `SESSION_RESIDENCY_ACP_REJECTED_${Date.now()}`;
      const secondaryMarker = `SESSION_RESIDENCY_ACP_B_${Date.now()}`;
      const followUpMarker = `SESSION_RESIDENCY_ACP_A_FOLLOWUP_${Date.now()}`;
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
              maxResidentSessionRuntimes: 1,
              sessionRuntimeIdleMs: 30_000,
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
            secondaryMarker,
            followUpMarker,
            secret: model.apiKey,
          }),
          'utf8'
        ).toString('base64');
        let stdout = '';
        let stderr = '';
        let capacityBoundaryAt = 0;
        const runnerResult = execFileAsync('bun', [runner], {
          cwd: path.resolve(import.meta.dirname, '../../..'),
          env: {
            ...process.env,
            BLADE_SESSION_RESIDENCY_ACP_INPUT: encoded,
          },
          timeout: 240_000,
          maxBuffer: 1024 * 1024,
          killSignal: 'SIGKILL',
        }).then(
          (result) => ({ kind: 'result' as const, result }),
          (error: Error & { stdout?: string; stderr?: string }) => ({
            kind: 'error' as const,
            error,
          })
        );
        const boundaryOrExit = await Promise.race([
          waitFor(async () => {
            try {
              await access(providerReleasePath);
              return true;
            } catch {
              return false;
            }
          }, 'Session residency ACP runner did not reach the close boundary').then(
            () => ({ kind: 'boundary' as const })
          ),
          runnerResult.then((outcome) => ({
            kind: 'exit' as const,
            outcome,
          })),
        ]);
        if (boundaryOrExit.kind === 'exit') {
          const earlyStdout =
            boundaryOrExit.outcome.kind === 'result'
              ? boundaryOrExit.outcome.result.stdout
              : (boundaryOrExit.outcome.error.stdout ?? '');
          const earlyStderr =
            boundaryOrExit.outcome.kind === 'result'
              ? boundaryOrExit.outcome.result.stderr
              : (boundaryOrExit.outcome.error.stderr ?? '');
          throw new Error(
            `Session residency ACP runner exited before the close boundary:\n${earlyStdout}\n${earlyStderr}`.replaceAll(
              model.apiKey,
              '[redacted]'
            )
          );
        }
        capacityBoundaryAt = Date.now();
        expect(proxy.requestBodies).toHaveLength(1);
        expect(proxy.maxInFlight).toBe(1);
        expect(proxy.requestBodies[0]).toContain(primaryMarker);
        expect(proxy.requestBodies[0]).not.toContain(rejectedMarker);
        proxy.releaseHeld();
        const outcome = await runnerResult;
        if (outcome.kind === 'result') {
          stdout = outcome.result.stdout;
          stderr = outcome.result.stderr;
        } else {
          stdout = outcome.error.stdout ?? stdout;
          stderr = outcome.error.stderr ?? stderr;
        }

        const evidence = JSON.parse(stdout.trim()) as {
          success?: unknown;
          error?: unknown;
          primarySessionId?: unknown;
          secondarySessionId?: unknown;
          primaryPromptKind?: unknown;
          capacityMessage?: unknown;
          output?: unknown;
          processes?: Array<{ pid: number; identity: ProcessIdentity }>;
        };
        expect(
          evidence.success,
          `${String(evidence.error)}\n${stderr.replaceAll(model.apiKey, '[redacted]')}`
        ).toBe(true);
        expect(evidence.capacityMessage).toContain('Session runtime capacity is full');
        expect(['result', 'error']).toContain(evidence.primaryPromptKind);

        expect(proxy.requestBodies.join('\n')).toContain(primaryMarker);
        expect(proxy.requestBodies.join('\n')).toContain(secondaryMarker);
        expect(proxy.requestBodies.join('\n')).toContain(followUpMarker);
        expect(
          proxy.requestBodies.every((body) => !body.includes(rejectedMarker))
        ).toBe(true);
        expect(
          proxy.requestStartedAt
            .slice(1)
            .every((startedAt) => startedAt >= capacityBoundaryAt)
        ).toBe(true);
        expect(proxy.heldRequestNumbers).toEqual([1]);

        const [primaryTranscript, secondaryTranscript, storageText] = await Promise.all(
          [
            readFile(
              findSessionTranscript(storageRoot, String(evidence.primarySessionId)),
              'utf8'
            ),
            readFile(
              findSessionTranscript(storageRoot, String(evidence.secondarySessionId)),
              'utf8'
            ),
            readTree(storageRoot),
          ]
        );
        expect(primaryTranscript).toContain(primaryMarker);
        expect(primaryTranscript).toContain(followUpMarker);
        expect(secondaryTranscript).toContain(secondaryMarker);
        expect(storageText).not.toContain(rejectedMarker);
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

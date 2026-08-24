import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { HookManager } from '../../../src/hooks/HookManager.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { ensureStoreInitialized, getState } from '../../../src/store/vanilla.js';
import { removeTestDirectory } from '../../support/helpers/removeTestDirectory.js';
import { runTokenBudgetHandoffAcpDriver } from '../../support/tokenBudgetHandoffAcpDriver.js';
import { runTokenBudgetHandoffHeadlessDriver } from '../../support/tokenBudgetHandoffHeadlessDriver.js';
import { runTokenBudgetHandoffPtyDriver } from '../../support/tokenBudgetHandoffPtyDriver.js';
import { runTokenBudgetHandoffWebDriver } from '../../support/tokenBudgetHandoffWebDriver.js';
import {
  assertLargePromptOffloadEvidence,
  createLargePromptOffloadFixture,
  formatLargePromptProxyDiagnostic,
  startLargePromptRecordingProxy,
} from './largePromptOffloadHarness.js';
import {
  assertNoSecrets,
  extractDurableToolTrace,
  finalAssistantText,
  findSessionTranscript,
  readSessionEvents,
} from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  REAL_API_OUTPUT_BUDGET,
  resolveRequiredDeepSeekQualificationModels,
  type TestModelConfig,
} from './testConfig.js';
import { formatTokenBudgetTranscriptDiagnostic } from './tokenBudgetHandoffHarness.js';

const execFileAsync = promisify(execFile);
const surfaces = ['headless', 'pty', 'web', 'acp'] as const;
const SURFACE_TIMEOUT_MS = 270_000;
const models = isRealApiTestEnabled()
  ? resolveRequiredDeepSeekQualificationModels()
  : [];
const matrix = models.flatMap((model) =>
  surfaces.map((surface) => ({
    model,
    surface,
    qualificationId: `${model.qualificationId}:${surface}`,
  }))
);
if (isRealApiTestEnabled() && matrix.length !== 8) {
  throw new Error(
    `Large-prompt offload matrix must contain 8 cells, got ${matrix.length}`
  );
}

let originalConfig: RuntimeConfig | null = null;
let hooksWereEnabled = false;

function restoreEnvironment(snapshot: ReadonlyMap<string, string>): void {
  for (const name of Object.keys(process.env)) {
    if (!snapshot.has(name)) delete process.env[name];
  }
  for (const [name, value] of snapshot) process.env[name] = value;
}

async function initializeWorkspace(workspace: string): Promise<string> {
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# Large prompt offload\n');
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.email', 'blade@example.test'], {
    cwd: workspace,
  });
  await execFileAsync('git', ['config', 'user.name', 'Blade Test'], {
    cwd: workspace,
  });
  await execFileAsync('git', ['add', '.'], { cwd: workspace });
  await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: workspace });
  return realpath(workspace);
}

async function writeRuntimeConfig(
  home: string,
  model: TestModelConfig
): Promise<RuntimeConfig> {
  const baseConfig = buildRealApiRuntimeConfig(model);
  const config: RuntimeConfig = {
    ...baseConfig,
    models: baseConfig.models.map((candidate) => ({
      ...candidate,
      overrides: {
        ...candidate.overrides,
        maxRetries: 0,
        maxOutputTokens: REAL_API_OUTPUT_BUDGET,
        temperature: 0,
        timeout: 150_000,
        streamIdleTimeout: 150_000,
      },
    })),
    permissionMode: PermissionMode.YOLO,
  };
  await mkdir(path.join(home, '.blade'), { recursive: true });
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
  return config;
}

function assertDurableTrace(
  storageRoot: string,
  sessionId: string,
  hiddenMarker: string,
  finalMarker: string
): void {
  const events = readSessionEvents(findSessionTranscript(storageRoot, sessionId));
  const userMessage = events.find(
    (event) =>
      event.type === 'message_created' &&
      event.data.role === 'user' &&
      event.data.metadata !== undefined
  );
  if (userMessage?.type !== 'message_created') {
    throw new Error('Large-prompt durable user message is missing');
  }
  const metadata = userMessage.data.metadata;
  const artifact =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata.userPromptArtifact
      : undefined;
  if (
    !artifact ||
    typeof artifact !== 'object' ||
    Array.isArray(artifact) ||
    typeof artifact.id !== 'string' ||
    !/^[a-f0-9]{64}$/.test(artifact.id) ||
    artifact.sha256 !== artifact.id
  ) {
    throw new Error('Large-prompt durable artifact reference is invalid');
  }

  const trace = extractDurableToolTrace(events);
  if (
    trace.length === 0 ||
    trace.some((record) => record.toolName !== 'ReadPromptArtifact') ||
    !trace.some(
      (record) =>
        record.error === null && JSON.stringify(record.output).includes(hiddenMarker)
    ) ||
    trace.some((record) => {
      const input =
        record.input && typeof record.input === 'object' && !Array.isArray(record.input)
          ? (record.input as Record<string, unknown>)
          : undefined;
      return input?.artifact_id !== artifact.id;
    })
  ) {
    throw new Error('Large-prompt durable tool trace is invalid');
  }
  if (finalAssistantText(events) !== finalMarker) {
    throw new Error('Large-prompt durable final response is not exact');
  }
}

beforeAll(async () => {
  if (!isRealApiTestEnabled()) return;
  await ensureStoreInitialized();
  originalConfig = getState().config.config;
  hooksWereEnabled = HookManager.getInstance().isEnabled();
  HookManager.getInstance().disable();
});

afterAll(() => {
  if (!isRealApiTestEnabled()) return;
  if (originalConfig) getState().config.actions.setConfig(originalConfig);
  if (hooksWereEnabled) HookManager.getInstance().enable();
  WorkspaceTrustService.resetInstance();
});

describe
  .skipIf(!isRealApiTestEnabled())
  .sequential('durable large-prompt offload release matrix', () => {
    it.each(matrix)(
      '$qualificationId',
      async ({ model, surface }) => {
        const environment = new Map(
          Object.entries(process.env).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, value] as const]
          )
        );
        const root = await mkdtemp(
          path.join(os.tmpdir(), `blade-large-prompt-${model.model}-${surface}-`)
        );
        const home = path.join(root, 'home');
        const storageRoot = path.join(root, 'storage');
        const workspace = await initializeWorkspace(path.join(root, 'project'));
        const nonce = randomBytes(16).toString('hex');
        const fixture = createLargePromptOffloadFixture(workspace, nonce);
        const proxy = await startLargePromptRecordingProxy(
          model.baseURL ?? 'https://api.deepseek.com',
          fixture.hiddenMarker
        );
        let cellError: unknown;
        let sessionId = `large-prompt-${surface}-${nonce}`;
        try {
          await Promise.all([
            mkdir(home, { recursive: true }),
            mkdir(storageRoot, { recursive: true }),
          ]);
          process.env.HOME = home;
          process.env.BLADE_STORAGE_ROOT = storageRoot;
          process.env.BLADE_AUTO_MEMORY = '0';
          process.env.BLADE_TELEMETRY_DISABLED = '1';
          process.env.DEEPSEEK_API_KEY = model.apiKey;
          process.env.DEEPSEEK_BASE_URL = model.baseURL ?? 'https://api.deepseek.com';
          process.env.DEEPSEEK_MODELS = models
            .map((candidate) => candidate.model)
            .join(',');
          const runtimeConfig = await writeRuntimeConfig(home, {
            ...model,
            baseURL: proxy.baseURL,
          });

          let surfaceEvidence: unknown;
          if (surface === 'headless') {
            getState().config.actions.setConfig(runtimeConfig);
            WorkspaceTrustService.resetInstance();
            await WorkspaceTrustService.getInstance().trust(workspace);
            surfaceEvidence = await runTokenBudgetHandoffHeadlessDriver({
              fixture,
              sessionId,
              home,
              storageRoot,
              providerRequestCount: () => proxy.evidence().requests.length,
              secrets: [model.apiKey],
              timeoutMs: SURFACE_TIMEOUT_MS,
            });
          } else if (surface === 'pty') {
            surfaceEvidence = await runTokenBudgetHandoffPtyDriver({
              fixture,
              sessionId,
              home,
              storageRoot,
              providerRequestCount: () => proxy.evidence().requests.length,
              secrets: [model.apiKey],
              timeoutMs: SURFACE_TIMEOUT_MS,
            });
          } else if (surface === 'web') {
            const evidence = await runTokenBudgetHandoffWebDriver({
              root,
              model: model.model,
              proxyBaseURL: proxy.baseURL,
              fixture,
              providerRequestCount: () => proxy.evidence().requests.length,
              providerEvidence: proxy.tokenBudgetEvidence,
              secrets: [model.apiKey],
              timeoutMs: SURFACE_TIMEOUT_MS,
              reloadDuringRun: false,
              modelMaxRetries: 0,
              modelMaxOutputTokens: REAL_API_OUTPUT_BUDGET,
              modelTemperature: 0,
            });
            sessionId = evidence.sessionId;
            surfaceEvidence = evidence;
          } else {
            const evidence = await runTokenBudgetHandoffAcpDriver({
              fixture,
              home,
              storageRoot,
              providerRequestCount: () => proxy.evidence().requests.length,
              secrets: [model.apiKey],
              timeoutMs: SURFACE_TIMEOUT_MS,
            });
            sessionId = evidence.sessionId;
            surfaceEvidence = evidence;
          }

          expect(surfaceEvidence).toMatchObject({
            surface,
            sessionId,
            finalMarkerSeen: true,
            faults: [],
          });
          const proxyEvidence = proxy.evidence();
          assertLargePromptOffloadEvidence(proxyEvidence);
          assertDurableTrace(
            storageRoot,
            sessionId,
            fixture.hiddenMarker,
            fixture.finalMarker
          );
          assertNoSecrets({ surfaceEvidence, proxyEvidence }, [model.apiKey]);
        } catch (error) {
          let transcriptDiagnostic = 'unavailable';
          try {
            transcriptDiagnostic = formatTokenBudgetTranscriptDiagnostic({
              events: readSessionEvents(findSessionTranscript(storageRoot, sessionId)),
              expectedFinal: fixture.finalMarker,
              surfaceFinalSeen: false,
            });
          } catch {
            // The Session may not have reached durable transcript creation.
          }
          const message =
            error instanceof Error ? error.message : 'unknown surface failure';
          cellError = new Error(
            `${message}; provider=${formatLargePromptProxyDiagnostic(
              proxy.evidence()
            )}; transcript=${transcriptDiagnostic}`
          );
        } finally {
          await proxy.close().catch((error) => {
            cellError ??= error;
          });
          if (originalConfig) getState().config.actions.setConfig(originalConfig);
          WorkspaceTrustService.resetInstance();
          restoreEnvironment(environment);
          await removeTestDirectory(root).catch((error) => {
            cellError ??= error;
          });
        }
        if (cellError !== undefined) throw cellError;
      },
      300_000
    );
  });

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { getProjectStoragePath } from '../../../src/context/storage/pathUtils.js';
import {
  deriveTokenBudgetSnapshot,
  resolveCompactionOutputReserve,
  TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX,
  TOKEN_BUDGET_HANDOFF_TAG,
} from '../../../src/context/TokenBudgetHandoff.js';
import { HookManager } from '../../../src/hooks/HookManager.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { resolveModelConfig } from '../../../src/services/pi/resolveModelConfig.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { ensureStoreInitialized, getState } from '../../../src/store/vanilla.js';
import { removeTestDirectory } from '../../support/helpers/removeTestDirectory.js';
import { runTokenBudgetHandoffAcpDriver } from '../../support/tokenBudgetHandoffAcpDriver.js';
import { runTokenBudgetHandoffHeadlessDriver } from '../../support/tokenBudgetHandoffHeadlessDriver.js';
import { startTokenBudgetHandoffProxy } from '../../support/tokenBudgetHandoffProxy.js';
import { runTokenBudgetHandoffPtyDriver } from '../../support/tokenBudgetHandoffPtyDriver.js';
import { runTokenBudgetHandoffWebDriver } from '../../support/tokenBudgetHandoffWebDriver.js';
import { assertNoForegroundLeases } from './foregroundBoundedOutputHarness.js';
import {
  assertNoSecrets,
  findSessionTranscript,
  readSessionEvents,
} from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
  type TestModelConfig,
} from './testConfig.js';
import { createTokenBudgetHandoffFixture } from './tokenBudgetHandoffFixture.js';
import {
  assertTokenBudgetEvidenceSafe,
  assertTokenBudgetRequestSequenceWithTranscript,
  assertTokenBudgetTranscript,
} from './tokenBudgetHandoffHarness.js';

const execFileAsync = promisify(execFile);
const ACP_DRIVER_TOTAL_BUDGET_MS = 270_000;
const surfaces = ['headless', 'pty', 'web', 'acp'] as const;
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
    `Token-budget handoff matrix must contain 8 cells, got ${matrix.length}`
  );
}
if (
  isRealApiTestEnabled() &&
  new Set(matrix.map((cell) => cell.qualificationId)).size !== 8
) {
  throw new Error('Token-budget handoff qualification IDs must be unique');
}

let originalConfig: RuntimeConfig | null = null;
let hooksWereEnabled = false;

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function restoreEnvironment(snapshot: ReadonlyMap<string, string>): void {
  for (const name of Object.keys(process.env)) {
    if (!snapshot.has(name)) delete process.env[name];
  }
  for (const [name, value] of snapshot) process.env[name] = value;
}

async function initializeWorkspace(workspace: string): Promise<string> {
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# Token budget handoff\n');
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
  const config = {
    ...buildRealApiRuntimeConfig(model),
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

function deriveTargets(model: TestModelConfig): {
  handoffPromptTokens: number;
  compactionPromptTokens: number;
} {
  const config = buildRealApiRuntimeConfig(model);
  const selected = config.models[0];
  if (!selected) throw new Error('Token-budget model config is missing');
  const resolved = resolveModelConfig(selected, config, 'off');
  const maxContextTokens = resolved.model.contextWindow;
  const maxOutputTokens = resolveCompactionOutputReserve({
    maxContextTokens,
    maxOutputTokens: resolved.chat.maxOutputTokens,
    configuredMaxOutputTokens: config.maxOutputTokens,
  });
  const snapshot = deriveTokenBudgetSnapshot({
    contextTokens: 0,
    maxContextTokens,
    maxOutputTokens,
  });
  if (
    snapshot.handoffThreshold === undefined ||
    snapshot.compactionThreshold === undefined
  ) {
    throw new Error('Token-budget model thresholds are unavailable');
  }
  return {
    // Keep Provider prompt usage one token below each boundary. The model's
    // completion usage must carry the projected context across the threshold
    // before the next Provider request.
    handoffPromptTokens: snapshot.handoffThreshold - 1,
    compactionPromptTokens: snapshot.compactionThreshold - 1,
  };
}

async function assertNoSessionLease(workspace: string): Promise<void> {
  const lockRoot = path.join(getProjectStoragePath(workspace), '.locks');
  const locks = await readdir(lockRoot).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  });
  if (locks.length !== 0) {
    throw new Error('Token-budget Session lease remained after qualification');
  }
}

beforeAll(async () => {
  if (!isRealApiTestEnabled()) return;
  await ensureStoreInitialized();
  originalConfig = getState().config.config;
  const hooks = HookManager.getInstance();
  hooksWereEnabled = hooks.isEnabled();
  hooks.disable();
});

afterAll(() => {
  if (!isRealApiTestEnabled()) return;
  if (originalConfig) getState().config.actions.setConfig(originalConfig);
  if (hooksWereEnabled) HookManager.getInstance().enable();
  WorkspaceTrustService.resetInstance();
});

describe
  .skipIf(!isRealApiTestEnabled())
  .sequential('durable token-budget handoff release matrix', () => {
    it.each(matrix)(
      '$qualificationId',
      async ({ model, surface }) => {
        const environment = new Map(
          Object.entries(process.env).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, value] as const]
          )
        );
        const root = await mkdtemp(
          path.join(
            os.tmpdir(),
            `blade-token-budget-${safeSlug(model.model)}-${surface}-`
          )
        );
        const home = path.join(root, 'home');
        const storageRoot = path.join(root, 'storage');
        const workspaceInput = path.join(root, 'project');
        let proxy: Awaited<ReturnType<typeof startTokenBudgetHandoffProxy>> | undefined;
        let cellError: unknown;
        try {
          await Promise.all([
            mkdir(home, { recursive: true }),
            mkdir(storageRoot, { recursive: true }),
            mkdir(workspaceInput, { recursive: true }),
          ]);
          const workspace = await initializeWorkspace(workspaceInput);
          process.env.HOME = home;
          process.env.BLADE_STORAGE_ROOT = storageRoot;
          process.env.BLADE_AUTO_MEMORY = '0';
          process.env.BLADE_TELEMETRY_DISABLED = '1';

          const targets = deriveTargets(model);
          const expectCompactionFallback = model.model === 'deepseek-v4-flash';
          proxy = await startTokenBudgetHandoffProxy(
            model.baseURL ?? 'https://api.deepseek.com',
            {
              ...targets,
              markerTag: TOKEN_BUDGET_HANDOFF_TAG,
              compactionFailureSequence: expectCompactionFallback
                ? ['context_overflow', 'transient', 'transient']
                : ['context_overflow', 'transient'],
            }
          );
          const runtimeConfig = await writeRuntimeConfig(home, {
            ...model,
            baseURL: proxy.baseURL,
          });
          const nonce = randomBytes(16).toString('hex');
          const fixture = await createTokenBudgetHandoffFixture(workspace, nonce);
          let sessionId = `token-budget-${surface}-${nonce}`;
          const providerRequestCount = (): number =>
            proxy?.evidence().requests.length ?? 0;
          let surfaceEvidence: unknown;

          if (surface === 'headless') {
            await ensureStoreInitialized();
            getState().config.actions.setConfig(runtimeConfig);
            WorkspaceTrustService.resetInstance();
            await WorkspaceTrustService.getInstance().trust(workspace);
            surfaceEvidence = await runTokenBudgetHandoffHeadlessDriver({
              fixture,
              sessionId,
              home,
              storageRoot,
              providerRequestCount,
              secrets: [model.apiKey],
              timeoutMs: 270_000,
            });
          } else if (surface === 'pty') {
            surfaceEvidence = await runTokenBudgetHandoffPtyDriver({
              fixture,
              sessionId,
              home,
              storageRoot,
              providerRequestCount,
              secrets: [model.apiKey],
              timeoutMs: 270_000,
            });
          } else if (surface === 'acp') {
            const evidence = await runTokenBudgetHandoffAcpDriver({
              fixture,
              home,
              storageRoot,
              providerRequestCount,
              secrets: [model.apiKey],
              timeoutMs: ACP_DRIVER_TOTAL_BUDGET_MS,
            });
            sessionId = evidence.sessionId;
            surfaceEvidence = evidence;
          } else {
            const evidence = await runTokenBudgetHandoffWebDriver({
              root,
              model: model.model,
              proxyBaseURL: proxy.baseURL,
              fixture,
              providerRequestCount,
              providerEvidence: () =>
                proxy?.evidence() ?? { requests: [], maxInFlight: 0 },
              secrets: [model.apiKey],
              timeoutMs: 270_000,
            });
            sessionId = evidence.sessionId;
            surfaceEvidence = evidence;
          }

          const proxyEvidence = proxy.evidence();
          const transcriptPath = findSessionTranscript(storageRoot, sessionId);
          const events = readSessionEvents(transcriptPath);
          assertTokenBudgetRequestSequenceWithTranscript({
            evidence: proxyEvidence,
            targets,
            events,
            expectedFinal: fixture.finalMarker,
            surfaceFinalSeen: true,
            expectCompactionStepDown: true,
            expectCompactionFallback,
          });
          assertTokenBudgetTranscript(events, fixture, {
            expectedSampleAttempts: 3,
            expectedInputReductions: 1,
            expectCompactionFallback,
          });
          const publicMessages = await SessionService.loadSession(sessionId, workspace);
          const finalAssistant = publicMessages.findLast(
            (message) => message.role === 'assistant'
          );
          if (finalAssistant?.content !== fixture.finalMarker) {
            throw new Error('Token-budget public history final marker is not exact');
          }
          assertNoSecrets(publicMessages, [
            TOKEN_BUDGET_HANDOFF_TAG,
            TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX,
            'token_budget_handoff_recorded',
            'Context rollover is approaching',
          ]);
          const marker = events.find(
            (event) => event.type === 'token_budget_handoff_recorded'
          );
          if (
            marker?.type !== 'token_budget_handoff_recorded' ||
            typeof marker.data.messageId !== 'string' ||
            !marker.data.messageId.startsWith(TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX)
          ) {
            throw new Error('Token-budget durable marker identity is invalid');
          }
          assertNoSecrets(events, [model.apiKey]);
          assertTokenBudgetEvidenceSafe({ surfaceEvidence, proxyEvidence }, [
            model.apiKey,
          ]);
          await Promise.all([
            assertNoForegroundLeases(workspace, sessionId),
            assertNoSessionLease(workspace),
          ]);
        } catch (error) {
          cellError = error;
        } finally {
          await proxy?.close().catch((error) => {
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

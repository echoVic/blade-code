import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { HookManager } from '../../../src/hooks/HookManager.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { ensureStoreInitialized, getState } from '../../../src/store/vanilla.js';
import {
  assertForegroundBoundedOutputDurableMetadata,
  assertForegroundBoundedOutputEvidenceSafe,
  assertForegroundBoundedOutputToolTrace,
  assertNoForegroundLeases,
  assertOwnedProcessesGone,
} from './foregroundBoundedOutputHarness.js';
import { createForegroundBoundedOutputFixture } from './foregroundBoundedOutputFixture.js';
import {
  extractDurableToolTrace,
  findSessionTranscript,
  readSessionEvents,
} from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
  type TestModelConfig,
} from './testConfig.js';
import { runForegroundBoundedOutputAcpDriver } from '../../support/foregroundBoundedOutputAcpDriver.js';
import { runForegroundBoundedOutputHeadlessDriver } from '../../support/foregroundBoundedOutputHeadlessDriver.js';
import { runForegroundBoundedOutputPtyDriver } from '../../support/foregroundBoundedOutputPtyDriver.js';
import { runForegroundBoundedOutputWebDriver } from '../../support/foregroundBoundedOutputWebDriver.js';

const execFileAsync = promisify(execFile);
const surfaces = ['headless', 'acp', 'pty', 'web'] as const;
const models = isRealApiTestEnabled()
  ? resolveRequiredDeepSeekQualificationModels()
  : [];
const matrix = models.flatMap((model) =>
  surfaces.map((surface) => ({ model, surface }))
);
if (isRealApiTestEnabled() && matrix.length !== 8) {
  throw new Error(
    `Bounded ordered egress matrix must contain 8 cells, got ${matrix.length}`
  );
}

let originalConfig: RuntimeConfig | null = null;
let hooksWereEnabled = false;

beforeAll(() => {
  if (!isRealApiTestEnabled()) return;
  originalConfig = getState().config.config;
  const hooks = HookManager.getInstance();
  hooksWereEnabled = hooks.isEnabled();
  hooks.disable();
});

afterAll(() => {
  if (originalConfig) getState().config.actions.setConfig(originalConfig);
  if (hooksWereEnabled) HookManager.getInstance().enable();
  WorkspaceTrustService.resetInstance();
});

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function initializeWorkspace(workspace: string): Promise<string> {
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# Bounded output matrix\n');
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
    maxQueuedTaskBytes: 64 * 1024,
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
        maxQueuedTaskBytes: 64 * 1024,
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

describe
  .skipIf(!isRealApiTestEnabled())
  .sequential('bounded foreground output release matrix', () => {
    it.each(matrix)('$model.model × $surface', async ({ model, surface }) => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), `blade-bounded-${safeSlug(model.model)}-${surface}-`)
      );
      const home = path.join(root, 'home');
      const storage = path.join(root, 'storage');
      const workspaceInput =
        surface === 'web' ? path.join(root, 'project') : path.join(root, 'workspace');
      let sessionId = `bounded-${safeSlug(model.model)}-${surface}-${Date.now()}`;
      const previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
      const previousHome = process.env.HOME;
      const previousAutoMemory = process.env.BLADE_AUTO_MEMORY;
      try {
        await Promise.all([
          mkdir(home, { recursive: true }),
          mkdir(storage, { recursive: true }),
          mkdir(workspaceInput, { recursive: true }),
        ]);
        const workspace =
          surface === 'web'
            ? await realpath(workspaceInput)
            : await initializeWorkspace(workspaceInput);
        const nonce = `${safeSlug(model.model)}_${surface}_${Date.now()}`;
        const fixture = await createForegroundBoundedOutputFixture(workspace, nonce);
        let evidence: unknown;

        if (surface === 'web') {
          const web = await runForegroundBoundedOutputWebDriver({
            root,
            model: model.model,
            fixture,
            secrets: [model.apiKey],
            timeoutMs: 180_000,
          });
          sessionId = web.sessionId;
          evidence = web;
        } else {
          const runtimeConfig = await writeRuntimeConfig(home, model);
          process.env.HOME = home;
          process.env.BLADE_STORAGE_ROOT = storage;
          process.env.BLADE_AUTO_MEMORY = '0';
          if (surface === 'pty') {
            evidence = await runForegroundBoundedOutputPtyDriver({
              workspace,
              storageRoot: storage,
              home,
              sessionId,
              fixture,
              secret: model.apiKey,
              timeoutMs: 210_000,
            });
          } else if (surface === 'headless') {
            evidence = await runForegroundBoundedOutputHeadlessDriver({
              workspace,
              sessionId,
              fixture,
            });
          } else {
            await ensureStoreInitialized();
            getState().config.actions.setConfig(runtimeConfig);
            WorkspaceTrustService.resetInstance();
            await WorkspaceTrustService.getInstance().trust(workspace);
            const acp = await runForegroundBoundedOutputAcpDriver({
              workspace,
              fixture,
              secret: model.apiKey,
              timeoutMs: 180_000,
            });
            sessionId = acp.sessionId;
            assertOwnedProcessesGone(acp.processes);
            evidence = acp;
          }
        }

        const transcriptPath = findSessionTranscript(storage, sessionId);
        const events = readSessionEvents(transcriptPath);
        const trace = extractDurableToolTrace(events);
        const transport = surface === 'acp' ? 'acp' : 'local';
        assertForegroundBoundedOutputToolTrace(trace, fixture, transport);
        assertForegroundBoundedOutputDurableMetadata(events, transport);
        assertForegroundBoundedOutputEvidenceSafe(
          { evidence, trace, events },
          fixture,
          [model.apiKey]
        );
        await assertNoForegroundLeases(workspace, sessionId);
        expect(evidence).toBeTruthy();
      } finally {
        if (previousStorageRoot === undefined) {
          delete process.env.BLADE_STORAGE_ROOT;
        } else {
          process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
        }
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousAutoMemory === undefined) delete process.env.BLADE_AUTO_MEMORY;
        else process.env.BLADE_AUTO_MEMORY = previousAutoMemory;
        WorkspaceTrustService.resetInstance();
        await rm(root, { recursive: true, force: true });
      }
    }, 240_000);
  });

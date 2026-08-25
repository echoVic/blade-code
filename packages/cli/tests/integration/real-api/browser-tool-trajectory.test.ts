import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getBrowserProcessPool } from '../../../src/browser/BrowserProcessPool.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { HookManager } from '../../../src/hooks/HookManager.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { ensureStoreInitialized, getState } from '../../../src/store/vanilla.js';
import { runBrowserToolAcpDriver } from '../../support/browserToolAcpDriver.js';
import { runBrowserToolHeadlessDriver } from '../../support/browserToolHeadlessDriver.js';
import { runBrowserToolPtyDriver } from '../../support/browserToolPtyDriver.js';
import { runBrowserToolWebDriver } from '../../support/browserToolWebDriver.js';
import { removeTestDirectory } from '../../support/helpers/removeTestDirectory.js';
import { createBrowserToolFixture } from './browser-tool-fixture.js';
import { assertNoForegroundLeases } from './foregroundBoundedOutputHarness.js';
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
  resolveRequiredDeepSeekQualificationModels,
  type TestModelConfig,
} from './testConfig.js';

const execFileAsync = promisify(execFile);
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
  throw new Error(`Browser Tool matrix must contain 8 cells, got ${matrix.length}`);
}

const expectedTools = [
  'ToolSearch',
  'BrowserNavigate',
  'BrowserSnapshot',
  'BrowserInteract',
  'BrowserWait',
  'BrowserInspect',
  'BrowserPage',
] as const;

let originalConfig: RuntimeConfig | null = null;
let hooksWereEnabled = false;

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function browserCacheRoot(): string {
  let current = path.dirname(chromium.executablePath());
  while (path.dirname(current) !== current) {
    if (path.basename(current) === 'ms-playwright') return current;
    current = path.dirname(current);
  }
  throw new Error('Unable to locate the qualified Playwright browser cache');
}

function restoreEnvironment(snapshot: ReadonlyMap<string, string>): void {
  for (const name of Object.keys(process.env)) {
    if (!snapshot.has(name)) delete process.env[name];
  }
  for (const [name, value] of snapshot) process.env[name] = value;
}

async function initializeWorkspace(workspace: string): Promise<string> {
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# Browser Tool matrix\n');
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

function assertBrowserToolTrace(
  trace: ReturnType<typeof extractDurableToolTrace>,
  fixtureOrigin: string
): void {
  const names = trace.map((record) => record.toolName);
  expect(names.filter((name) => name === 'ToolSearch')).toHaveLength(1);
  const missing = expectedTools.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `Browser Tool trace is missing ${missing.join(', ')}; trace=${JSON.stringify(
        names
      )}`
    );
  }
  expect(new Set(names).size).toBeLessThanOrEqual(expectedTools.length);
  expect(names.every((name) => expectedTools.includes(name as never))).toBe(true);
  const failures = trace.filter((record) => record.error !== null);
  for (const failure of failures) {
    const index = trace.indexOf(failure);
    const recoverySnapshotIndex = trace.findIndex(
      (record, candidateIndex) =>
        candidateIndex > index &&
        record.toolName === 'BrowserSnapshot' &&
        record.error === null
    );
    const recoveredInteraction = trace.find(
      (record, candidateIndex) =>
        candidateIndex > recoverySnapshotIndex &&
        record.toolName === 'BrowserInteract' &&
        record.error === null
    );
    if (
      failure.toolName !== 'BrowserInteract' ||
      !failure.error?.includes('snapshot is stale') ||
      recoverySnapshotIndex < 0 ||
      !recoveredInteraction
    ) {
      throw new Error(
        `Browser Tool trace contains an unrecovered failure: ${JSON.stringify({
          toolName: failure.toolName,
          input: failure.input,
          error: failure.error,
        })}`
      );
    }
  }

  const search = trace.find((record) => record.toolName === 'ToolSearch');
  expect(search?.input).toMatchObject({
    query:
      'select:BrowserNavigate,BrowserSnapshot,BrowserInteract,BrowserWait,BrowserInspect,BrowserPage',
    max_results: 6,
  });
  for (const navigation of trace.filter(
    (record) => record.toolName === 'BrowserNavigate'
  )) {
    const input = navigation.input as Record<string, unknown>;
    if (input.action === 'goto') {
      expect(String(input.url)).toMatch(
        new RegExp(`^${fixtureOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`)
      );
    }
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
  .sequential('native Browser Tool release matrix', () => {
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
            `blade-browser-tool-${safeSlug(model.model)}-${surface}-`
          )
        );
        const home = path.join(root, 'home');
        const storageRoot = path.join(root, 'storage');
        const workspaceInput = path.join(root, 'workspace');
        const nonce = `browser_nonce_${randomBytes(12).toString('hex')}`;
        const fixture = await createBrowserToolFixture(nonce);
        let sessionId = `browser-tool-${surface}-${nonce}`;
        let evidence: unknown;
        try {
          await Promise.all([
            mkdir(home, { recursive: true }),
            mkdir(storageRoot, { recursive: true }),
            mkdir(workspaceInput, { recursive: true }),
          ]);
          const workspace = await initializeWorkspace(workspaceInput);
          const runtimeConfig = await writeRuntimeConfig(home, model);
          process.env.HOME = home;
          process.env.BLADE_STORAGE_ROOT = storageRoot;
          process.env.BLADE_AUTO_MEMORY = '0';
          process.env.BLADE_TELEMETRY_DISABLED = '1';
          process.env.PLAYWRIGHT_BROWSERS_PATH = browserCacheRoot();

          if (surface === 'pty') {
            evidence = await runBrowserToolPtyDriver({
              workspace,
              storageRoot,
              home,
              sessionId,
              fixture,
              secret: model.apiKey,
            });
          } else if (surface === 'web') {
            const web = await runBrowserToolWebDriver({
              workspace,
              storageRoot,
              home,
              fixture,
              secret: model.apiKey,
            });
            sessionId = web.sessionId;
            evidence = web;
          } else {
            getState().config.actions.setConfig(runtimeConfig);
            WorkspaceTrustService.resetInstance();
            await WorkspaceTrustService.getInstance().trust(workspace);
            if (surface === 'headless') {
              evidence = await runBrowserToolHeadlessDriver({
                workspace,
                sessionId,
                fixture,
              });
            } else {
              const acp = await runBrowserToolAcpDriver({
                workspace,
                fixture,
                secret: model.apiKey,
              });
              sessionId = acp.sessionId;
              evidence = acp;
            }
          }

          const transcriptPath = findSessionTranscript(storageRoot, sessionId);
          const events = readSessionEvents(transcriptPath);
          const trace = extractDurableToolTrace(events);
          assertBrowserToolTrace(trace, fixture.origin);
          assertNoSecrets({ evidence, trace, events }, [model.apiKey]);
          expect(finalAssistantText(events)).toContain(fixture.finalMarker);
          expect(evidence).toBeTruthy();
          expect(fixture.requests()).toEqual(expect.arrayContaining(['/', '/second']));
          await assertNoForegroundLeases(workspace, sessionId);
          if (surface === 'headless' || surface === 'acp') {
            expect(getBrowserProcessPool().stats()).toMatchObject({
              contexts: 0,
              running: false,
            });
          }
        } finally {
          await fixture.close();
          restoreEnvironment(environment);
          WorkspaceTrustService.resetInstance();
          await removeTestDirectory(root);
        }
      },
      300_000
    );
  });

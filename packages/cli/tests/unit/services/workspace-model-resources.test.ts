import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveWorkspaceModelResources,
  snapshotWorkspaceModelResources,
} from '../../../src/agent/resources/WorkspaceModelResources.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import type { BladeConfig } from '../../../src/config/types.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { getPiModelCatalog } from '../../../src/services/pi/PiModelCatalog.js';
import { createPiRuntime } from '../../../src/services/pi/modelRuntime.js';
import { resolveModelConfig } from '../../../src/services/pi/resolveModelConfig.js';

const PROVIDER_ID = 'shared-channel';
const MODEL_ID = 'project-model';

async function writeProjectConfig(root: string, marker: string) {
  await fs.mkdir(path.join(root, '.blade'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.blade', 'config.json'),
    `${JSON.stringify(
      {
        currentModelId: MODEL_ID,
        env: {
          WORKSPACE_ENV: marker,
          SHARED_ENV: `shared-${marker}`,
        },
        maxTurns: marker === 'a' ? 11 : 12,
        maxConcurrentTasks: marker === 'a' ? 1 : 2,
        maxQueuedTasks: marker === 'a' ? 10 : 20,
        maxQueuedTaskBytes: marker === 'a' ? 64 * 1024 : 128 * 1024,
        permissionMode: marker === 'a' ? 'yolo' : 'plan',
        disableAllHooks: marker === 'b',
        modelProviders: {
          [PROVIDER_ID]: {
            name: `Channel ${marker}`,
            baseUrl: `https://${marker}.example.test/v1`,
            wireApi: 'openai-completions',
          },
        },
        models: [
          {
            id: MODEL_ID,
            displayName: `Model ${marker}`,
            provider: PROVIDER_ID,
            model: 'gpt-4.1',
          },
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

describe('workspace model resources', () => {
  let tempRoot: string;
  let workspaceA: string;
  let workspaceB: string;
  let originalHome: string | undefined;
  let originalStorageRoot: string | undefined;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'blade-model-resources-'));
    workspaceA = path.join(tempRoot, 'project-a');
    workspaceB = path.join(tempRoot, 'project-b');
    originalHome = process.env.HOME;
    originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
    process.env.HOME = path.join(tempRoot, 'home');
    process.env.BLADE_STORAGE_ROOT = path.join(tempRoot, 'storage');
    await Promise.all([
      writeProjectConfig(workspaceA, 'a'),
      writeProjectConfig(workspaceB, 'b'),
    ]);
    ConfigManager.resetInstance();
    WorkspaceTrustService.resetInstance();
    await Promise.all([
      WorkspaceTrustService.getInstance().trust(workspaceA),
      WorkspaceTrustService.getInstance().trust(workspaceB),
    ]);
  });

  afterEach(async () => {
    getPiModelCatalog().configureModelProviders({}, []);
    ConfigManager.resetInstance();
    WorkspaceTrustService.resetInstance();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('keeps same-id provider endpoints isolated after disk and global catalog changes', async () => {
    const managedHook = () => ({ continue: true });
    const startupConfig: BladeConfig = {
      ...structuredClone(DEFAULT_CONFIG),
      currentModelId: 'startup-model',
      modelProviders: {
        'startup-channel': {
          name: 'Startup channel',
          baseUrl: 'https://startup.example.test/v1',
          wireApi: 'openai-completions',
        },
      },
      models: [
        {
          id: 'startup-model',
          provider: 'startup-channel',
          model: 'gpt-4.1',
        },
      ],
      env: {
        STARTUP_ONLY_ENV: 'startup',
        SHARED_ENV: 'startup',
      },
      maxConcurrentTasks: 7,
      maxQueuedTasks: 77,
      maxQueuedTaskBytes: 16 * 1024 * 1024,
    };
    (startupConfig.hooks as unknown as Record<string, unknown>).managedFunctionFixture =
      { handler: managedHook };
    const [resolvedA, resolvedB] = await Promise.all([
      resolveWorkspaceModelResources(workspaceA, startupConfig),
      resolveWorkspaceModelResources(workspaceB, startupConfig),
    ]);
    const sessionA = snapshotWorkspaceModelResources(resolvedA);
    const sessionB = snapshotWorkspaceModelResources(resolvedB);

    await Promise.all([
      writeProjectConfig(workspaceA, 'changed-a'),
      writeProjectConfig(workspaceB, 'changed-b'),
    ]);
    getPiModelCatalog().configureModelProviders(
      {
        [PROVIDER_ID]: {
          name: 'Global channel',
          baseUrl: 'https://global.example.test/v1',
          wireApi: 'openai-completions',
        },
      },
      sessionA.config.models
    );

    const modelA = sessionA.config.models[0]!;
    const modelB = sessionB.config.models[0]!;
    const chatA = resolveModelConfig(
      modelA,
      sessionA.config,
      'off',
      sessionA.catalog
    ).chat;
    const chatB = resolveModelConfig(
      modelB,
      sessionB.config,
      'off',
      sessionB.catalog
    ).chat;

    expect(sessionA.config.modelProviders[PROVIDER_ID]?.baseUrl).toBe(
      'https://a.example.test/v1'
    );
    expect(sessionB.config.modelProviders[PROVIDER_ID]?.baseUrl).toBe(
      'https://b.example.test/v1'
    );
    expect(sessionA.config.modelProviders['startup-channel']).toBeUndefined();
    expect(sessionB.config.modelProviders['startup-channel']).toBeUndefined();
    expect(sessionA.config.env).toEqual({
      WORKSPACE_ENV: 'a',
      SHARED_ENV: 'shared-a',
    });
    expect(sessionB.config.env).toEqual({
      WORKSPACE_ENV: 'b',
      SHARED_ENV: 'shared-b',
    });
    expect(sessionA.config.maxTurns).toBe(11);
    expect(sessionB.config.maxTurns).toBe(12);
    expect(sessionA.config.permissionMode).toBe('yolo');
    expect(sessionB.config.permissionMode).toBe('plan');
    expect(sessionA.config.disableAllHooks).toBe(false);
    expect(sessionB.config.disableAllHooks).toBe(true);
    expect(sessionA.config.maxConcurrentTasks).toBe(7);
    expect(sessionB.config.maxConcurrentTasks).toBe(7);
    expect(sessionA.config.maxQueuedTasks).toBe(77);
    expect(sessionB.config.maxQueuedTasks).toBe(77);
    expect(sessionA.config.maxQueuedTaskBytes).toBe(16 * 1024 * 1024);
    expect(sessionB.config.maxQueuedTaskBytes).toBe(16 * 1024 * 1024);
    expect(process.env.WORKSPACE_ENV).toBeUndefined();
    expect(createPiRuntime(chatA).model.baseUrl).toBe('https://a.example.test/v1');
    expect(createPiRuntime(chatB).model.baseUrl).toBe('https://b.example.test/v1');
    expect(chatA.modelCatalog).not.toBe(chatB.modelCatalog);
    expect(
      (
        sessionA.config.hooks as unknown as {
          managedFunctionFixture: { handler: unknown };
        }
      ).managedFunctionFixture.handler
    ).toBe(managedHook);
  });

  it('rejects untrusted project environment while allowing hook disablement', async () => {
    const workspace = path.join(tempRoot, 'project-untrusted');
    await writeProjectConfig(workspace, 'untrusted');
    await fs.writeFile(
      path.join(workspace, '.blade', 'settings.local.json'),
      JSON.stringify({
        env: { UNTRUSTED_ENV: 'blocked' },
        maxTurns: 3,
        permissionMode: 'yolo',
        disableAllHooks: true,
      }),
      'utf8'
    );
    const startupConfig = structuredClone(DEFAULT_CONFIG);
    startupConfig.env = { STARTUP_ONLY_ENV: 'startup' };
    startupConfig.maxTurns = 42;

    const settings = await ConfigManager.getInstance().loadWorkspaceRuntimeSettings(
      workspace,
      startupConfig
    );

    expect(settings.env).toEqual({});
    expect(settings.maxTurns).toBe(DEFAULT_CONFIG.maxTurns);
    expect(settings.permissionMode).toBe(DEFAULT_CONFIG.permissionMode);
    expect(settings.disableAllHooks).toBe(true);
  });

  it('fails closed for invalid trusted environment names', async () => {
    const workspace = path.join(tempRoot, 'project-invalid-env');
    await writeProjectConfig(workspace, 'invalid');
    const configPath = path.join(workspace, '.blade', 'settings.local.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ env: { 'INVALID-NAME': 'value' } }),
      'utf8'
    );
    await WorkspaceTrustService.getInstance().trust(workspace);

    await expect(
      ConfigManager.getInstance().loadWorkspaceRuntimeSettings(
        workspace,
        structuredClone(DEFAULT_CONFIG)
      )
    ).rejects.toThrow('Invalid environment variable name');
  });
});

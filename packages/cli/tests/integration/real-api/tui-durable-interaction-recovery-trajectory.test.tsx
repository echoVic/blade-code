// @vitest-environment jsdom

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import { HookManager } from '../../../src/hooks/HookManager.js';
import { resetWorkspaceIdentityCache } from '../../../src/security/WorkspaceIdentity.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { SessionService } from '../../../src/services/SessionService.js';
import {
  ensureStoreInitialized,
  getState,
  vanillaStore,
} from '../../../src/store/vanilla.js';
import { useCommandHandler } from '../../../src/ui/hooks/useCommandHandler.js';
import {
  type RecordingProviderProxy,
  startRecordingProviderProxy,
} from '../../support/recordingProviderProxy.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
} from './testConfig.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const models = isRealApiTestEnabled()
  ? resolveRequiredDeepSeekQualificationModels(process.env)
  : [];
const describeReal = models.length > 0 ? describe.sequential : describe.skip;
let originalConfig: RuntimeConfig | null = null;
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
const PROVIDER_KEY_PREFIXES = [
  'BLADE_MODEL_API_KEY_',
  'BLADE_REAL_API_PROVIDER_KEY_',
] as const;

async function writeCredentialFreeWorkspaceConfig(
  workspace: string,
  config: RuntimeConfig
): Promise<void> {
  const configDir = path.join(workspace, '.blade');
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, 'config.json'),
    `${JSON.stringify(
      {
        currentModelId: config.currentModelId,
        models: config.models,
        modelProviders: config.modelProviders,
        permissionMode: config.permissionMode,
        providerForegroundRecoveryMs: 0,
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
}

function snapshotProviderKeyEnvironment(): Map<string, string> {
  return new Map(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        PROVIDER_KEY_PREFIXES.some((prefix) => entry[0].startsWith(prefix))
    )
  );
}

function restoreProviderKeyEnvironment(snapshot: ReadonlyMap<string, string>): void {
  for (const name of Object.keys(process.env)) {
    if (PROVIDER_KEY_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      delete process.env[name];
    }
  }
  for (const [name, value] of snapshot) process.env[name] = value;
}

beforeAll(async () => {
  await ensureStoreInitialized();
  originalConfig = getState().config.config;
});

afterAll(() => {
  if (originalConfig) getState().config.actions.setConfig(originalConfig);
  if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
  else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
});

describeReal('TUI durable pending-resume retry trajectory (real API)', () => {
  for (const model of models) {
    it(`${model.model} retries one safe pending resume after a real Provider failure`, {
      retry: 0,
      timeout: 240_000,
    }, async () => {
      if (!model.baseURL) throw new Error(`${model.model} base URL is unavailable`);
      const originalProviderKeyEnvironment = snapshotProviderKeyEnvironment();
      const sessionId = `tui-retry-${model.model}-${Date.now()}`;
      const marker = `TUI_PENDING_RESUME_RECOVERED_${model.model.replace(/[^a-z0-9]/gi, '_')}`;
      const prompt = [
        'Do not call or mention any tools.',
        `Reply with exactly ${marker}`,
        'Do not add punctuation, markdown, explanation, or any other text.',
      ].join(' ');
      const originalStore = getState();
      const hookManager = HookManager.getInstance();
      const hooksWereEnabled = hookManager.isEnabled();
      let workspace: string | undefined;
      let proxy: RecordingProviderProxy | undefined;
      let container: HTMLDivElement | undefined;
      let root: ReactDOM.Root | undefined;
      let hook: ReturnType<typeof useCommandHandler> | undefined;
      let seedRuntime: SessionRuntime | undefined;

      function Harness() {
        hook = useCommandHandler(undefined, undefined, undefined, 2);
        return null;
      }

      try {
        const createdWorkspace = await mkdtemp(
          path.join(os.tmpdir(), 'blade-tui-retry-')
        );
        workspace = createdWorkspace;
        const storageRoot = path.join(createdWorkspace, '.blade-storage');
        const startedProxy = await startRecordingProviderProxy(model.baseURL, {
          inject503Once: { path: '/v1/chat/completions', retryAfterMs: 0 },
        });
        proxy = startedProxy;
        const baseConfig = buildRealApiRuntimeConfig({
          ...model,
          baseURL: startedProxy.baseUrl,
        });
        const config: RuntimeConfig = {
          ...baseConfig,
          permissionMode: PermissionMode.DEFAULT,
          providerForegroundRecoveryMs: 0,
          hooks: { ...baseConfig.hooks, enabled: false },
          disableAllHooks: true,
          mcpServers: {},
          models: baseConfig.models.map((entry) => ({
            ...entry,
            overrides: { ...entry.overrides, maxRetries: 0 },
          })),
        };
        container = document.createElement('div');
        document.body.appendChild(container);
        const mountedRoot = ReactDOM.createRoot(container);
        root = mountedRoot;
        process.env.BLADE_STORAGE_ROOT = storageRoot;
        hookManager.disable();
        getState().config.actions.setConfig(config);
        await writeCredentialFreeWorkspaceConfig(createdWorkspace, config);
        WorkspaceTrustService.resetInstance();
        resetWorkspaceIdentityCache();
        await WorkspaceTrustService.getInstance().trust(createdWorkspace);
        await SessionService.createSessionMetadata(sessionId, createdWorkspace, {
          title: 'TUI pending-resume retry qualification',
          taskStatus: 'completed',
          selectedModelId: config.currentModelId,
          permissionMode: 'default',
        });
        seedRuntime = await SessionRuntime.create({
          sessionId,
          workspaceRoot: createdWorkspace,
          permissionMode: PermissionMode.DEFAULT,
          mcpServers: {},
          agents: [],
        });
        const queued = await seedRuntime.enqueueSteering(prompt, {
          allowBeforeTurn: true,
        });
        expect(queued).toMatchObject({ accepted: true, delivery: 'next_turn' });
        if (!queued.messageId) throw new Error('Seed inbox message ID is missing');
        await new PersistentStore(createdWorkspace).saveMessage(
          sessionId,
          'user',
          prompt,
          null,
          { inboxMessageId: queued.messageId }
        );
        await seedRuntime.dispose();
        seedRuntime = undefined;

        vanillaStore.setState((state) => ({
          ...state,
          session: {
            ...state.session,
            sessionId,
            workspaceRoot: createdWorkspace,
            messages: [],
            restoredContextMessages: null,
            error: null,
          },
          command: {
            ...state.command,
            isProcessing: false,
            abortController: null,
            pendingCommands: [],
          },
        }));

        await act(async () => {
          mountedRoot.render(<Harness />);
          await Promise.resolve();
        });

        await vi.waitFor(
          async () => {
            expect(
              await SessionRuntime.hasPendingInbox(createdWorkspace, sessionId)
            ).toBe(false);
            expect(getState().command.isProcessing).toBe(false);
            expect(
              getState().session.messages.filter(
                (message) => message.role === 'assistant' && message.content === marker
              )
            ).toHaveLength(1);
          },
          { timeout: 220_000, interval: 100 }
        );

        const store = new PersistentStore(createdWorkspace);
        const events = (await store.loadEvents(sessionId)) ?? [];
        const transcript = await readFile(
          getSessionFilePath(createdWorkspace, sessionId),
          'utf8'
        );
        const lifecycleForForwarded = startedProxy.requestLifecycle.filter(
          (entry) => entry.requestNumber === startedProxy.forwardedRequestNumbers[0]
        );
        expect(startedProxy.injectedRequestNumbers).toEqual([1]);
        expect(startedProxy.forwardedRequestNumbers).toHaveLength(1);
        expect(lifecycleForForwarded).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ phase: 'headers_received', statusClass: 2 }),
            expect.objectContaining({ phase: 'body_completed' }),
            expect.objectContaining({ phase: 'downstream_ended' }),
          ])
        );
        expect(events.filter((event) => event.type === 'turn_started')).toHaveLength(2);
        expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(1);
        expect(events.filter((event) => event.type === 'turn_completed')).toHaveLength(
          1
        );
        expect(
          events.filter((event) => event.type === 'inbox_acknowledged')
        ).toHaveLength(1);
        const assistantText = getState()
          .session.messages.filter((message) => message.role === 'assistant')
          .map((message) => message.content);
        expect(assistantText).toEqual([marker]);
        expect(getState().session.error).toBeNull();
        assertNoSecrets(
          {
            transcript,
            requestPaths: startedProxy.requestPaths,
            requestLifecycle: startedProxy.requestLifecycle,
          },
          [model.apiKey]
        );
      } finally {
        await seedRuntime?.dispose().catch(() => undefined);
        await hook?.cleanupAgent().catch(() => undefined);
        if (root) {
          await act(async () => {
            root?.unmount();
            await Promise.resolve();
          }).catch(() => undefined);
        }
        container?.remove();
        vanillaStore.setState(originalStore, true);
        if (originalConfig) getState().config.actions.setConfig(originalConfig);
        if (hooksWereEnabled) hookManager.enable();
        else hookManager.disable();
        WorkspaceTrustService.resetInstance();
        resetWorkspaceIdentityCache();
        if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
        else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
        restoreProviderKeyEnvironment(originalProviderKeyEnvironment);
        await proxy?.close().catch(() => undefined);
        if (workspace) await rm(workspace, { recursive: true, force: true });
      }
    });
  }
});

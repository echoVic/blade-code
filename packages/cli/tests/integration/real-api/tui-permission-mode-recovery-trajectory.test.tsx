// @vitest-environment jsdom

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { usePermissionMode, useSessionId } from '../../../src/store/selectors/index.js';
import { getState, vanillaStore } from '../../../src/store/vanilla.js';
import { useAgent } from '../../../src/ui/hooks/useAgent.js';
import { activateSessionSelection } from '../../../src/ui/utils/sessionActivation.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveForkQualificationModels,
} from './testConfig.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const gpt = isRealApiTestEnabled()
  ? resolveForkQualificationModels(process.env).find((model) => model.id === 'gpt')
  : undefined;
const describeReal = gpt ? describe.sequential : describe.skip;
let originalConfig: RuntimeConfig | null = null;
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

beforeAll(() => {
  if (gpt) originalConfig = getState().config.config;
});

afterAll(() => {
  if (originalConfig) getState().config.actions.setConfig(originalConfig);
  if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
  else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
});

describeReal('TUI permission mode recovery trajectory (real API)', () => {
  it('restores durable YOLO through TUI activation before a real Write', async () => {
    if (!gpt) throw new Error('GPT qualification channel is unavailable');
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-tui-mode-'));
    const storageRoot = path.join(workspace, '.blade-storage');
    const sessionId = `tui-mode-${Date.now()}`;
    const target = path.join(workspace, 'tui-mode.txt');
    const config = {
      ...buildRealApiRuntimeConfig(gpt),
      permissionMode: PermissionMode.DEFAULT,
    };
    const originalStore = getState();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);
    let hook: ReturnType<typeof useAgent> | undefined;
    let mode: PermissionMode | undefined;

    function Harness() {
      const activeSessionId = useSessionId();
      const activeMode = usePermissionMode();
      mode = activeMode;
      hook = useAgent({
        sessionId: activeSessionId,
        workspaceRoot: workspace,
        modelId: config.currentModelId,
        permissionMode: activeMode,
        maxTurns: 4,
      });
      return null;
    }

    try {
      process.env.BLADE_STORAGE_ROOT = storageRoot;
      getState().config.actions.setConfig(config);
      const metadata = await SessionService.createSessionMetadata(
        sessionId,
        workspace,
        {
          taskStatus: 'completed',
          selectedModelId: config.currentModelId,
          permissionMode: 'yolo',
        }
      );
      await activateSessionSelection(
        { intent: 'resume', session: metadata },
        workspace,
        getState().session.actions,
        async () => undefined
      );
      expect(getState().config.config?.permissionMode).toBe(PermissionMode.YOLO);

      await act(async () => {
        root.render(<Harness />);
        await Promise.resolve();
      });
      expect(mode).toBe(PermissionMode.YOLO);
      const agent = await runWithCwdOverride(workspace, () => hook?.createAgent());
      if (!agent) throw new Error('TUI permission recovery Agent was not created');

      const result = await runWithCwdOverride(workspace, () =>
        agent.chat(
          [
            `Use Write exactly once to create ${target}.`,
            'Write exactly TUI_MODE_RECOVERED followed by one newline.',
            'Do not call any other tool.',
            'After Write succeeds, reply exactly TUI_MODE_RECOVERED.',
          ].join(' '),
          {
            messages: [],
            userId: 'tui-mode-recovery',
            sessionId,
            workspaceRoot: workspace,
            permissionMode: mode,
          },
          { maxTurns: 4, stream: true }
        )
      );

      expect(result.success).toBe(true);
      expect(await readFile(target, 'utf8')).toBe('TUI_MODE_RECOVERED\n');
      await expect(
        SessionService.findSessionMetadata(sessionId, workspace)
      ).resolves.toMatchObject({ permissionMode: 'yolo' });
      assertNoSecrets(result, [gpt.apiKey]);
    } finally {
      await hook?.cleanupAgent().catch(() => undefined);
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      container.remove();
      vanillaStore.setState(originalStore, true);
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
      else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
      await rm(workspace, { recursive: true, force: true });
    }
  }, 240_000);
});

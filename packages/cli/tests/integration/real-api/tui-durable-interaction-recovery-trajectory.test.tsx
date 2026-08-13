// @vitest-environment jsdom

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import { SessionInteractionService } from '../../../src/services/SessionInteractionService.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { usePermissionMode, useSessionId } from '../../../src/store/selectors/index.js';
import { getState, vanillaStore } from '../../../src/store/vanilla.js';
import type { ConfirmationHandler } from '../../../src/tools/types/ExecutionTypes.js';
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

describeReal('TUI durable interaction recovery trajectory (real API)', () => {
  it('replays a cold question through the TUI hook and performs a real Write', async () => {
    if (!gpt) throw new Error('GPT qualification channel is unavailable');
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-tui-interaction-'));
    const storageRoot = path.join(workspace, '.blade-storage');
    const sessionId = `tui-interaction-${Date.now()}`;
    const target = path.join(workspace, 'tui-selected-channel.txt');
    const config = {
      ...buildRealApiRuntimeConfig(gpt),
      permissionMode: PermissionMode.DEFAULT,
    };
    const originalStore = getState();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);
    const confirmationHandler: ConfirmationHandler = {
      requestConfirmation: vi.fn(async () => ({
        approved: true,
        answers: { Channel: 'Stable' },
      })),
    };
    let hook: ReturnType<typeof useAgent> | undefined;
    let activeMode: PermissionMode | undefined;

    function Harness() {
      const activeSessionId = useSessionId();
      activeMode = usePermissionMode();
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
      const store = new PersistentStore(workspace);
      await store.saveMessage(
        sessionId,
        'user',
        [
          'A Channel question will be recovered by the TUI.',
          `After the recovered answer, call Write exactly once with file_path=${JSON.stringify(
            target
          )}.`,
          'Set content to the selected label followed by exactly one newline.',
          'That Write is the only allowed tool call. Never call AskUserQuestion again.',
          'Do not emit assistant text or end the turn before Write succeeds.',
          'After Write succeeds, reply exactly TUI_INTERACTION_RECOVERED.',
        ].join(' ')
      );
      const toolCallId = await store.saveToolUse(sessionId, 'AskUserQuestion', {
        questions: [
          {
            header: 'Channel',
            question: 'Which release channel?',
            multiSelect: false,
            options: [
              { label: 'Stable', description: 'Stable release' },
              { label: 'Canary', description: 'Canary release' },
            ],
          },
        ],
      });
      await SessionInteractionService.request(
        {
          sessionId,
          projectPath: workspace,
          toolCallId,
          toolName: 'AskUserQuestion',
        },
        {
          type: 'askUserQuestion',
          message: 'Choose a release channel',
          questions: [
            {
              header: 'Channel',
              question: 'Which release channel?',
              multiSelect: false,
              options: [
                { label: 'Stable', description: 'Stable release' },
                { label: 'Canary', description: 'Canary release' },
              ],
            },
          ],
        }
      );
      const refreshed = await SessionService.findSessionMetadata(sessionId, workspace);
      if (!refreshed) throw new Error('TUI interaction session metadata is missing');
      await activateSessionSelection(
        { intent: 'resume', session: refreshed ?? metadata },
        workspace,
        getState().session.actions,
        async () => undefined
      );
      await SessionInteractionService.resolvePendingWithHandler(
        workspace,
        sessionId,
        confirmationHandler
      );

      await act(async () => {
        root.render(<Harness />);
        await Promise.resolve();
      });
      const agent = await runWithCwdOverride(workspace, () => hook?.createAgent());
      if (!agent) throw new Error('TUI interaction recovery Agent was not created');
      const restoredMessages = await SessionService.loadSession(sessionId, workspace);
      const result = await runWithCwdOverride(workspace, () =>
        agent.chat(
          '',
          {
            messages: restoredMessages,
            userId: 'tui-interaction-recovery',
            sessionId,
            workspaceRoot: workspace,
            permissionMode: activeMode,
          },
          { maxTurns: 4, stream: true, pendingInputOnly: true }
        )
      );
      expect(result.success).toBe(true);
      expect(await readFile(target, 'utf8')).toBe('Stable\n');
      await expect(
        SessionService.findSessionMetadata(sessionId, workspace)
      ).resolves.toMatchObject({ pendingInteraction: undefined });
      assertNoSecrets(
        {
          transcript: await readFile(
            getSessionFilePath(workspace, sessionId),
            'utf8'
          ).catch(() => ''),
        },
        [gpt.apiKey]
      );
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

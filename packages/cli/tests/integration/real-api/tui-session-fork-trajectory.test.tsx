// @vitest-environment jsdom

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import { subagentRegistry } from '../../../src/agent/subagents/SubagentRegistry.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import type { SessionEvent } from '../../../src/context/types.js';
import { HookManager } from '../../../src/hooks/HookManager.js';
import { SkillRegistry } from '../../../src/skills/SkillRegistry.js';
import { useSessionId } from '../../../src/store/selectors/index.js';
import {
  ensureStoreInitialized,
  getState,
  vanillaStore,
} from '../../../src/store/vanilla.js';
import { useCommandHandler } from '../../../src/ui/hooks/useCommandHandler.js';
import type { ResolvedInput } from '../../../src/ui/hooks/useInputBuffer.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import {
  assertForkChildToolTrace,
  assertForkLineage,
  assertForkParentToolTrace,
  assertNoSecrets,
  assertParentUnchanged,
  cleanupForkFixture,
  createForkFixture,
  extractDurableToolTrace,
  findSessionTranscript,
  readSessionEvents,
} from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveForkQualificationModels,
} from './testConfig.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const enabled = isRealApiTestEnabled();
const modelConfigs = enabled
  ? resolveForkQualificationModels(process.env, { requiredDeepSeek: true })
  : [];

function safeModelLabel(
  modelConfig: (typeof modelConfigs)[number],
  ordinal: number
): string {
  const digest = createHash('sha256')
    .update(modelConfig.model)
    .digest('hex')
    .slice(0, 12);
  return `${modelConfig.id}-${ordinal + 1}-${digest}`;
}

function resolvedInput(text: string): ResolvedInput {
  return {
    text,
    displayText: text,
    images: [],
    parts: [{ type: 'text', text }],
  };
}

function assertDurableParentTrace(
  events: readonly SessionEvent[],
  memoryPath: string
): void {
  assertForkParentToolTrace(extractDurableToolTrace(events), memoryPath);
}

function assertDurableChildTrace(
  events: readonly SessionEvent[],
  afterEventCount: number,
  resultPath: string,
  expectedBytes: string
): void {
  assertForkChildToolTrace(
    extractDurableToolTrace(events, { afterEventCount }),
    resultPath,
    expectedBytes
  );
}

function assertUiFinal(content: unknown, marker: string, nonce: string): void {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('TUI final response must be non-empty text');
  }
  if (content.includes(marker) || content.includes(nonce)) {
    throw new Error('TUI final response exposed fixture material');
  }
}

function createResolvedConfig(
  modelConfig: (typeof modelConfigs)[number]
): RuntimeConfig {
  const base = buildRealApiRuntimeConfig(modelConfig);
  return {
    ...base,
    permissionMode: PermissionMode.YOLO,
    hooks: { ...base.hooks, enabled: false },
    disableAllHooks: true,
    mcpServers: {},
    allowedTools: ['Read'],
  };
}

function initializeIsolatedExtensions(
  fixture: ReturnType<typeof createForkFixture>
): void {
  const userSkillsDir = path.join(fixture.storageRoot, 'isolated-skills');
  const claudeUserSkillsDir = path.join(fixture.storageRoot, 'isolated-claude-skills');
  const projectSkillsDir = path.join(fixture.workspace, '.blade', 'skills');
  const claudeProjectSkillsDir = path.join(fixture.workspace, '.claude', 'skills');
  const skillCreatorDir = path.join(userSkillsDir, 'skill-creator');
  for (const directory of [
    skillCreatorDir,
    claudeUserSkillsDir,
    projectSkillsDir,
    claudeProjectSkillsDir,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(
    path.join(skillCreatorDir, 'SKILL.md'),
    '---\nname: skill-creator\ndescription: Local deterministic fixture.\n---\n\n# Fixture\n'
  );
  SkillRegistry.resetInstance();
  SkillRegistry.getInstance({
    cwd: fixture.workspace,
    userSkillsDir,
    claudeUserSkillsDir,
    projectSkillsDir,
    claudeProjectSkillsDir,
  });
  subagentRegistry.clear();
  subagentRegistry.loadBuiltinAgents();
}

function resetStore(parentId: string): void {
  const oldController = getState().command.abortController;
  if (oldController && !oldController.signal.aborted) oldController.abort('test-reset');
  vanillaStore.setState((state) => ({
    ...state,
    session: {
      ...state.session,
      sessionId: parentId,
      messages: [],
      restoredContextMessages: null,
      restoredVisibleMessageCount: 0,
      error: null,
      currentThinkingContent: null,
      currentStreamingMessageId: null,
      currentStreamingChunks: [],
      currentStreamingLines: [],
      currentStreamingTail: '',
      currentStreamingLineCount: 0,
      currentStreamingVersion: 0,
      finalizingStreamingMessageId: null,
    },
    command: {
      ...state.command,
      isProcessing: false,
      abortController: null,
      pendingCommands: [],
      recoveredSteeringCount: 0,
    },
    app: {
      ...state.app,
      activeModal: 'none',
      sessionSelectorData: undefined,
      tasks: [],
      thinkingModeEnabled: false,
      subagentProgress: null,
      subagentProgresses: {},
    },
  }));
}

async function proveLeaseReleased(
  sessionId: string,
  workspace: string,
  modelId: string
): Promise<void> {
  const replacement = await SessionRuntime.create({
    sessionId,
    workspaceRoot: workspace,
    modelId,
    mcpServers: {},
    agents: [],
  });
  await replacement.dispose();
}

const describeTuiTrajectory = enabled ? describe.sequential : describe.skip;

describeTuiTrajectory('TUI durable fork trajectory (real API)', () => {
  if (modelConfigs.length === 0) {
    it('requires REAL_API_TEST=1', () => undefined);
  }
  for (const [modelIndex, modelConfig] of modelConfigs.entries()) {
    const modelLabel = safeModelLabel(modelConfig, modelIndex);
    it(`${modelLabel} switches to a fresh child hook and completes inherited Write/Bash work`, async () => {
      const fixture = createForkFixture('tui', modelLabel);
      const marker = `TUI_FORK_MARKER_${fixture.nonce}`;
      const expectedBytes = `${marker}\n`;
      const memoryPath = path.join(fixture.workspace, 'memory.txt');
      const resultPath = path.join(fixture.workspace, 'result.txt');
      const parentId = `tui-parent-${Date.now()}-${fixture.nonce.slice(-8)}`;
      const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
      const originalAutoMemory = process.env.BLADE_AUTO_MEMORY;
      const hookManager = HookManager.getInstance();
      const hooksWereEnabled = hookManager.isEnabled();
      const originalStoreState = getState();
      let originalConfig: RuntimeConfig | null = null;
      let root: ReactDOM.Root | undefined;
      let container: HTMLDivElement | undefined;
      let mounted = false;
      let latest:
        | {
            sessionId: string;
            renderVersion: number;
            hook: ReturnType<typeof useCommandHandler>;
          }
        | undefined;
      let renderVersion = 0;

      assertNoSecrets({ marker, expectedBytes, parentId }, [modelConfig.apiKey]);

      function Harness() {
        const sessionId = useSessionId();
        const hook = useCommandHandler(
          undefined,
          'Deterministic qualification: obey exact tool sequence and never reveal file contents in final prose.',
          undefined,
          8
        );
        renderVersion += 1;
        latest = { sessionId, renderVersion, hook };
        return null;
      }

      try {
        process.env.BLADE_STORAGE_ROOT = fixture.storageRoot;
        process.env.BLADE_AUTO_MEMORY = '0';
        hookManager.disable();
        initializeIsolatedExtensions(fixture);
        await ensureStoreInitialized();
        originalConfig = getState().config.config;
        const runtimeConfig = createResolvedConfig(modelConfig);
        getState().config.actions.setConfig(runtimeConfig);
        resetStore(parentId);
        writeFileSync(memoryPath, expectedBytes);

        await runWithCwdOverride(fixture.workspace, async () => {
          container = document.createElement('div');
          document.body.appendChild(container);
          root = ReactDOM.createRoot(container);
          await act(async () => {
            root?.render(<Harness />);
          });
          mounted = true;
          if (!latest) throw new Error('TUI harness did not render');

          await act(async () => {
            await latest?.hook.executeCommand(
              resolvedInput(
                [
                  `Use Read exactly once on the exact absolute path ${memoryPath}.`,
                  'Remember its complete content for a later fork.',
                  'Never repeat the file content in final prose; briefly confirm completion after Read succeeds.',
                ].join(' ')
              )
            );
          });
          expect(getState().command.isProcessing).toBe(false);
          expect(getState().session.error).toBeNull();
          const parentPath = findSessionTranscript(fixture.storageRoot, parentId);
          const parentEvents = readSessionEvents(parentPath);
          assertDurableParentTrace(parentEvents, memoryPath);
          const parentBeforeFork = readFileSync(parentPath, 'utf8');
          const parentAssistantContents = getState()
            .session.messages.filter((message) => message.role === 'assistant')
            .map((message) => message.content);
          assertUiFinal(parentAssistantContents.at(-1), marker, fixture.nonce);
          const versionBeforeFork = latest.renderVersion;
          const parentHook = latest.hook;

          await act(async () => {
            await parentHook.executeCommand(resolvedInput(`/fork ${parentId}`));
          });
          await vi.waitFor(
            () => {
              expect(getState().session.sessionId).not.toBe(parentId);
              expect(latest?.sessionId).toBe(getState().session.sessionId);
              expect(latest?.renderVersion).toBeGreaterThan(versionBeforeFork);
            },
            { timeout: 10_000 }
          );
          if (!latest || latest.hook === parentHook) {
            throw new Error('Fork did not produce a fresh child hook closure');
          }
          const childId = latest.sessionId;
          const childHook = latest.hook;
          const inheritedMessages = getState().session.restoredContextMessages;
          expect(inheritedMessages).not.toBeNull();
          expect(
            inheritedMessages?.some(
              (message) =>
                message.role === 'assistant' &&
                message.tool_calls?.some(
                  (toolCall) =>
                    'function' in toolCall && toolCall.function.name === 'Read'
                )
            )
          ).toBe(true);
          const childPath = findSessionTranscript(fixture.storageRoot, childId);
          const childSnapshot = readSessionEvents(childPath);
          rmSync(memoryPath);
          if (existsSync(memoryPath)) {
            throw new Error('Source memory fixture still exists before child turn');
          }

          getState().config.actions.updateConfig({
            allowedTools: ['Write', 'Bash'],
          });
          await act(async () => {
            await childHook.executeCommand(
              resolvedInput(
                [
                  'Recover the complete marker from the inherited Read result.',
                  `Use Write exactly once on the exact absolute path ${resultPath} with that marker and exactly one trailing newline.`,
                  'Then use Bash exactly once with command `wc -c result.txt`.',
                  'Use no other command, never repeat the marker in final prose, and briefly confirm completion.',
                ].join(' ')
              )
            );
          });

          const childEvents = readSessionEvents(childPath);
          const childRaw = readFileSync(childPath, 'utf8');
          assertDurableChildTrace(
            childEvents,
            childSnapshot.length,
            resultPath,
            expectedBytes
          );
          const uiMessages = getState().session.messages;
          assertNoSecrets(
            {
              uiMessages,
              inheritedMessages,
              childEvents,
              childRaw,
              parentBeforeFork,
            },
            [modelConfig.apiKey]
          );
          if (readFileSync(resultPath, 'utf8') !== expectedBytes) {
            throw new Error('TUI child result bytes did not match exact contract');
          }
          const childAssistantContents = uiMessages
            .filter((message) => message.role === 'assistant')
            .map((message) => message.content);
          assertUiFinal(childAssistantContents.at(-1), marker, fixture.nonce);
          assertParentUnchanged(parentBeforeFork, parentPath);
          assertForkLineage(childEvents, {
            childId,
            parentId,
            rootId: parentId,
          });
          expect(childEvents.length).toBeGreaterThan(childSnapshot.length);
          expect(getState().command).toMatchObject({
            isProcessing: false,
            pendingCommands: [],
            abortController: null,
          });
          expect(getState().session.error).toBeNull();

          await childHook.cleanupAgent();
          await proveLeaseReleased(
            childId,
            fixture.workspace,
            runtimeConfig.currentModelId
          );
          await proveLeaseReleased(
            parentId,
            fixture.workspace,
            runtimeConfig.currentModelId
          );
        });
      } finally {
        await runWithCwdOverride(fixture.workspace, async () => {
          if (latest) await latest.hook.cleanupAgent().catch(() => undefined);
          if (mounted && root) {
            await act(async () => root?.unmount());
            mounted = false;
          }
        });
        container?.remove();
        vanillaStore.setState(originalStoreState, true);
        if (originalConfig) getState().config.actions.setConfig(originalConfig);
        SkillRegistry.resetInstance();
        subagentRegistry.clear();
        subagentRegistry.loadBuiltinAgents();
        if (hooksWereEnabled) hookManager.enable();
        if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
        else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
        if (originalAutoMemory === undefined) delete process.env.BLADE_AUTO_MEMORY;
        else process.env.BLADE_AUTO_MEMORY = originalAutoMemory;
        cleanupForkFixture(fixture);
      }
    }, 360_000);
  }
});

// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../../../../src/config/types.js';

const mocks = vi.hoisted(() => ({
  appActions: {
    setReasoningEffort: vi.fn(),
    setServiceTier: vi.fn(),
    setResponseVerbosity: vi.fn(),
    setCommunicationStyle: vi.fn(),
  },
  createAgent: vi.fn(),
  createRuntime: vi.fn(),
  findMetadata: vi.fn(),
  loadSession: vi.fn(),
  registerCleanup: vi.fn(),
  updateMetadata: vi.fn(),
}));

vi.mock('../../../../../src/agent/Agent.js', () => ({
  Agent: {
    create: mocks.createAgent,
    createWithRuntime: mocks.createAgent,
  },
}));

vi.mock('../../../../../src/agent/runtime/SessionRuntime.js', () => ({
  SessionRuntime: { create: mocks.createRuntime },
}));

vi.mock('../../../../../src/services/GracefulShutdown.js', () => ({
  registerCleanup: mocks.registerCleanup,
}));

vi.mock('../../../../../src/services/SessionService.js', () => ({
  SessionMissingCreationError: class SessionMissingCreationError extends Error {},
  SessionService: {
    findSessionMetadata: mocks.findMetadata,
    loadSession: mocks.loadSession,
    updateSessionMetadata: mocks.updateMetadata,
  },
}));

vi.mock('../../../../../src/services/CodeReviewService.js', () => ({
  CodeReviewService: {
    recoverInterrupted: vi.fn(),
    start: vi.fn(),
    list: vi.fn(),
  },
  renderCodeReview: vi.fn(),
}));

vi.mock('../../../../../src/store/vanilla.js', () => ({
  appActions: () => mocks.appActions,
  vanillaStore: {
    getState: () => ({
      app: {
        actions: {
          startSubagentProgress: vi.fn(),
          updateSubagentTool: vi.fn(),
          completeSubagentProgress: vi.fn(),
        },
      },
    }),
  },
}));

vi.mock('../../../../../src/utils/cwd.js', () => ({
  getCwd: () => '/workspace',
}));

import { useAgent } from '../../../../../src/ui/hooks/useAgent.js';

function resolved(value: unknown = undefined) {
  return vi.fn().mockResolvedValue(value);
}

function createRuntime() {
  const configuration = (selection: string) => ({
    selection,
    effective: selection,
    supported: [selection],
  });
  const runtime = {
    sessionId: 'session-1',
    workspaceRoot: '/workspace',
    getCurrentModelId: vi.fn(() => 'model-1'),
    getReasoningConfiguration: vi.fn(() => configuration('off')),
    resolveReasoningConfiguration: vi.fn(configuration),
    getServiceTierConfiguration: vi.fn(() => configuration('auto')),
    resolveServiceTierConfiguration: vi.fn(configuration),
    getResponseVerbosityConfiguration: vi.fn(() => configuration('auto')),
    resolveResponseVerbosityConfiguration: vi.fn(configuration),
    getCommunicationStyleConfiguration: vi.fn(() => ({
      ...configuration('auto'),
      name: 'Auto',
      description: 'Default',
      source: 'built-in',
    })),
    resolveCommunicationStyleConfiguration: vi.fn((selection: string) => ({
      ...configuration(selection),
      name: selection,
      description: selection,
      source: 'built-in',
    })),
    hasTurnOwner: vi.fn(() => false),
    refresh: resolved(),
    dispose: resolved(),
    enqueueSteering: resolved({ accepted: true, turnId: 'turn-1', queued: 1 }),
    getFollowUpQueueSnapshot: resolved({
      version: 'a'.repeat(64),
      pending: 0,
      mutable: 0,
      locked: 0,
      internal: 0,
      items: [],
    }),
    mutateFollowUpQueue: resolved({
      snapshot: {
        version: 'b'.repeat(64),
        pending: 0,
        mutable: 0,
        locked: 0,
        internal: 0,
        items: [],
      },
    }),
    askSideQuestion: resolved({ response: 'answer', durationMs: 1 }),
    executeUserShellCommand: resolved({ executionId: 'shell-1' }),
    getTurnRecoveryAssessment: vi.fn(() => ({ state: 'none' })),
    listRewindCheckpoints: resolved([]),
    rewindSession: resolved({ messages: [], restoredFiles: [] }),
    listSubagents: vi.fn(() => []),
    resumeSubagent: vi.fn(() => ({
      source: { id: 'source' },
      session: {
        id: 'child',
        subagentType: 'explorer',
        description: 'inspect',
      },
    })),
    getMcpContentCatalog: vi.fn(() => ({
      revision: 1,
      resources: [],
      resourceTemplates: [],
      prompts: [],
    })),
    refreshMcpContentCatalogs: resolved(),
    getMcpPrompt: resolved({ messages: [] }),
    completeMcpArgument: resolved({ values: [], hasMore: false }),
    listMcpTasks: vi.fn(() => []),
    getMcpTask: vi.fn(),
    cancelMcpTask: resolved(),
    getMcpLogs: vi.fn(() => ({ revision: 0, entries: [] })),
    setMcpLoggingLevel: resolved(),
    getMcpInstructions: vi.fn(() => ({ revision: 0, instructions: [] })),
  };
  return runtime;
}

describe('useAgent', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let hook: ReturnType<typeof useAgent>;
  let runtime: ReturnType<typeof createRuntime>;
  const agent = { destroy: resolved() };

  function Harness() {
    hook = useAgent({
      sessionId: 'session-1',
      workspaceRoot: '/workspace',
      modelId: 'model-1',
      permissionMode: PermissionMode.DEFAULT,
      reasoningEffort: 'off',
      serviceTier: 'auto',
      responseVerbosity: 'auto',
      communicationStyle: 'auto',
    });
    return null;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    runtime = createRuntime();
    mocks.createRuntime.mockResolvedValue(runtime);
    mocks.createAgent.mockResolvedValue(agent);
    mocks.findMetadata.mockResolvedValue({
      selectedModelId: 'model-1',
      permissionMode: 'default',
      reasoningEffort: 'off',
      serviceTier: 'auto',
      responseVerbosity: 'auto',
      communicationStyle: 'auto',
    });
    mocks.loadSession.mockResolvedValue([]);
    mocks.updateMetadata.mockImplementation(
      async (_sessionId: string, _workspaceRoot: string, update: object) => ({
        selectedModelId: 'model-1',
        permissionMode: 'default',
        reasoningEffort: 'off',
        serviceTier: 'auto',
        responseVerbosity: 'auto',
        communicationStyle: 'auto',
        ...update,
      })
    );
    mocks.registerCleanup.mockReturnValue(vi.fn());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('owns one runtime while exposing every session operation', async () => {
    await expect(hook.createAgent()).resolves.toBe(agent);
    await expect(hook.createAgent()).resolves.toBe(agent);
    expect(mocks.createRuntime).toHaveBeenCalledOnce();

    await expect(hook.steerActiveTurn('steer')).resolves.toMatchObject({
      accepted: true,
    });
    await expect(hook.enqueueSessionInput('follow up')).resolves.toMatchObject({
      queued: 1,
    });
    await expect(hook.getFollowUpQueue()).resolves.toMatchObject({ pending: 0 });
    await expect(
      hook.mutateFollowUpQueue({
        expectedVersion: 'a'.repeat(64),
        operation: { type: 'remove', messageId: 'message-1' },
      })
    ).resolves.toHaveProperty('snapshot');
    await expect(hook.askSideQuestion('why?')).resolves.toMatchObject({
      response: 'answer',
    });
    await expect(hook.executeUserShellCommand('pwd')).resolves.toMatchObject({
      executionId: 'shell-1',
    });
    expect(hook.getTurnRecoveryAssessment()).toEqual({ state: 'none' });

    await expect(hook.listRewindCheckpoints()).resolves.toEqual([]);
    await expect(
      hook.rewindSession({
        targetMessageId: 'message-1',
        mode: 'conversation',
      })
    ).resolves.toHaveProperty('messages');
    await expect(hook.listSubagents()).resolves.toEqual([]);
    await expect(hook.resumeSubagent('source', 'continue')).resolves.toHaveProperty(
      'session.id',
      'child'
    );

    await expect(hook.getMcpContentCatalog()).resolves.toHaveProperty('revision', 1);
    await hook.refreshMcpContentCatalogs('docs');
    await expect(hook.getMcpPrompt('docs', 'prompt', {})).resolves.toHaveProperty(
      'messages'
    );
    await expect(
      hook.completeMcpArgument('docs', {
        reference: { type: 'prompt', name: 'prompt' },
        argument: { name: 'environment', value: 'pro' },
      })
    ).resolves.toHaveProperty('values');
    await expect(hook.listMcpTasks()).resolves.toEqual([]);
    await expect(hook.getMcpTask('task')).resolves.toBeUndefined();
    await expect(hook.cancelMcpTask('task')).resolves.toBeUndefined();
    await expect(hook.getMcpLogs()).resolves.toHaveProperty('revision', 0);
    await hook.setMcpLoggingLevel('docs', 'info');
    await expect(hook.getMcpInstructions()).resolves.toHaveProperty('revision', 0);

    await expect(hook.getReasoningConfiguration()).resolves.toHaveProperty(
      'selection',
      'off'
    );
    await expect(hook.setReasoningEffort('low')).resolves.toBeDefined();
    await expect(hook.getServiceTierConfiguration()).resolves.toBeDefined();
    await expect(hook.setServiceTier('standard')).resolves.toBeDefined();
    await expect(hook.getResponseVerbosityConfiguration()).resolves.toBeDefined();
    await expect(hook.setResponseVerbosity('high')).resolves.toBeDefined();
    await expect(hook.getCommunicationStyleConfiguration()).resolves.toBeDefined();
    await expect(hook.setCommunicationStyle('pragmatic')).resolves.toBeDefined();

    await hook.cleanupAgent();
    await hook.cleanupAgent();
    expect(agent.destroy).toHaveBeenCalledTimes(2);
    expect(runtime.dispose).toHaveBeenCalledTimes(2);
  });
});

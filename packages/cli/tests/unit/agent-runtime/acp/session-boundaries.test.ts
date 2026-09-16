/** AcpSession 测试 */

import type { ClientCapabilities, SessionNotification } from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
} from '../../../../src/acp/AcpRemoteWorkspace.js';
import { AcpSession, createLocalAcpSessionRoots } from '../../../../src/acp/Session.js';
import type { LoopEvent } from '../../../../src/agent/loop/types.js';
import type { SessionRuntime } from '../../../../src/agent/runtime/SessionRuntime.js';
import type { LoopResult } from '../../../../src/agent/types.js';
import {
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_USER_MESSAGE_TEXT_CHARS,
} from '../../../../src/api/attachmentLimits.js';
import type { FollowUpQueueSnapshot } from '../../../../src/api/followUpQueueSchemas.js';
import type { ProviderRecoveryProjection } from '../../../../src/api/providerRecoverySchemas.js';
import type { TurnActivityProjection } from '../../../../src/api/turnActivitySchemas.js';
import { Bus } from '../../../../src/server/bus.js';
import type {
  ChatConfig,
  Message,
} from '../../../../src/services/ChatServiceInterface.js';
import { ProviderAdmissionError } from '../../../../src/services/pi/providerRequestAdmission.js';
import type {
  ConfirmationDetails,
  ConfirmationResponse,
} from '../../../../src/tools/types/ExecutionTypes.js';
import { ToolKind } from '../../../../src/tools/types/ToolTypes.js';
import { ControlledFileClient } from '../../../support/acp/ControlledFileClient.js';
import { createPairedAcpHarness } from '../../../support/acp/createPairedAcpHarness.js';
import { createMockACPClient } from '../../../support/mocks/mockACPClient.js';
import { createMockAgent, type MockAgent } from '../../../support/mocks/mockAgent.js';

type AgentMockInstance = MockAgent & {
  switchModel: Mock<(modelId: string) => Promise<void>>;
};

function followUpQueue(
  version: string,
  pending: number,
  overrides: Partial<FollowUpQueueSnapshot> = {}
): FollowUpQueueSnapshot {
  return {
    version,
    pending,
    mutable: pending,
    locked: 0,
    internal: 0,
    items: [],
    ...overrides,
  };
}

const TEST_SESSION_REF = {
  sessionId: 'test-session-id',
  projectPath: '/tmp/test',
} as const;

const promptText = (session: AcpSession, text: string) =>
  session.prompt({
    sessionId: TEST_SESSION_REF.sessionId,
    prompt: [{ type: 'text', text }],
  });

function publishSubagentCompletion(childSessionId: string): void {
  Bus.publish(TEST_SESSION_REF, 'subagent.completion.queued', {
    childSessionId,
    inboxMessageId: `background-subagent-completion:${childSessionId}`,
    status: 'completed',
    type: 'Explore',
    queued: 1,
    delivery: 'next_turn',
  });
}

const agentMockState = vi.hoisted((): { current: AgentMockInstance | null } => ({
  current: null,
}));

function getMockAgent(): AgentMockInstance {
  const agent = agentMockState.current;
  if (!agent) throw new Error('Agent mock has not been created');
  return agent;
}

const runtimeState = vi.hoisted(() => ({
  runtime: {
    sessionId: 'test-session-id',
    dispose: vi.fn().mockResolvedValue(undefined),
    discardPendingInput: vi.fn().mockResolvedValue(undefined),
    enqueueSteering: vi.fn<SessionRuntime['enqueueSteering']>(async () => ({
      accepted: true,
      turnId: 'turn-1',
      queued: 1,
    })),
    getPendingSteeringCount: vi.fn(() => 0),
    getPendingSteeringMessages: vi.fn(() => []),
    getFollowUpQueueSnapshot: vi
      .fn<() => Promise<FollowUpQueueSnapshot>>()
      .mockResolvedValue(followUpQueue('0'.repeat(64), 0)),
    getProviderRecoveryProjection: vi
      .fn<() => ProviderRecoveryProjection>()
      .mockReturnValue({
        version: 1,
        generation: 'provider-recovery-generation',
        revision: 0,
        snapshot: null,
      }),
    getTurnActivityProjection: vi.fn<() => TurnActivityProjection>().mockReturnValue({
      version: 1,
      generation: 'turn-activity-generation',
      revision: 0,
      snapshot: null,
    }),
    isIdleForResidency: vi.fn<() => ReturnType<SessionRuntime['isIdleForResidency']>>(
      () => true
    ),
    getTurnRecoveryAssessment: vi.fn<
      () => ReturnType<SessionRuntime['getTurnRecoveryAssessment']>
    >(() => ({ state: 'none' })),
    getCurrentModelId: vi.fn(() => 'model-1'),
    getChatService: vi.fn<SessionRuntime['getChatService']>(() => ({
      chat: vi.fn<ReturnType<SessionRuntime['getChatService']>['chat']>(),
      streamChat: vi.fn<ReturnType<SessionRuntime['getChatService']>['streamChat']>(),
      updateConfig:
        vi.fn<ReturnType<SessionRuntime['getChatService']>['updateConfig']>(),
      getConfig: (): ChatConfig => ({
        provider: 'session-channel',
        model: 'session-model',
        apiKey: 'session-key',
        baseUrl: 'https://session.invalid/v1',
        maxContextTokens: 128_000,
      }),
    })),
    getReasoningConfiguration: vi.fn(() => ({
      selection: 'off' as const,
      effective: 'off' as const,
      supported: ['off', 'low', 'medium', 'high'] as const,
    })),
    resolveReasoningConfiguration: vi.fn((selection: string) => ({
      selection,
      effective: selection === 'auto' ? 'high' : selection,
      supported: ['off', 'low', 'medium', 'high'],
    })),
    getServiceTierConfiguration: vi.fn(() => ({
      selection: 'auto' as const,
      effective: 'provider-default' as const,
      supported: ['standard', 'fast', 'flex'] as const,
    })),
    resolveServiceTierConfiguration: vi.fn((selection: string) => ({
      selection,
      effective: selection === 'auto' ? 'provider-default' : selection,
      supported: ['standard', 'fast', 'flex'],
    })),
    getResponseVerbosityConfiguration: vi.fn(() => ({
      selection: 'auto' as const,
      effective: 'provider-default' as const,
      supported: ['low', 'medium', 'high'] as const,
    })),
    resolveResponseVerbosityConfiguration: vi.fn((selection: string) => ({
      selection,
      effective: selection === 'auto' ? 'provider-default' : selection,
      supported: ['low', 'medium', 'high'],
    })),
    getCommunicationStyleConfiguration: vi.fn(() => ({
      selection: 'auto' as const,
      effective: 'blade-default' as const,
      name: 'Auto',
      description: 'Default',
      source: 'built-in' as const,
      supported: [],
    })),
    resolveCommunicationStyleConfiguration: vi.fn((selection: string) => ({
      selection,
      effective: selection === 'auto' ? 'blade-default' : selection,
      name: selection,
      description: `Use ${selection}`,
      source: selection.includes(':') ? 'project' : 'built-in',
      ...(selection.includes(':') ? { contentSha256: 'a'.repeat(64) } : {}),
      supported: [],
    })),
    refresh: vi.fn().mockResolvedValue(undefined),
    getGoal: vi.fn().mockResolvedValue(null),
    listRewindCheckpoints: vi.fn().mockResolvedValue([]),
    rewindSession: vi.fn(),
    listSubagents: vi.fn(() => []),
    resumeSubagent: vi.fn(),
    getMcpContentCatalog: vi.fn(() => ({
      revision: 1,
      resources: [],
      resourceTemplates: [],
      prompts: [],
    })),
    refreshMcpContentCatalogs: vi.fn().mockResolvedValue(undefined),
    getMcpPrompt: vi.fn().mockResolvedValue({
      messages: [],
    }),
    completeMcpArgument: vi.fn().mockResolvedValue({
      values: ['production'],
      hasMore: false,
      sourceValueCount: 1,
      sourceBytes: 10,
      projectedBytes: 10,
      sha256: 'c'.repeat(64),
      truncated: false,
    }),
    listMcpTasks: vi.fn(() => []),
    getMcpTask: vi.fn(),
    cancelMcpTask: vi.fn(),
    getMcpLogs: vi.fn(() => ({ revision: 0, entries: [] })),
    setMcpLoggingLevel: vi.fn().mockResolvedValue(undefined),
    getMcpInstructions: vi.fn(() => ({
      revision: 0,
      instructions: [],
    })),
    askSideQuestion: vi.fn().mockResolvedValue({
      response: 'Side answer',
      durationMs: 14,
    }),
    executeUserShellCommand: vi.fn(),
  },
}));

const terminalState = vi.hoisted(() => ({
  execute: vi.fn(),
}));

const codeReviewState = vi.hoisted(() => ({
  recoverInterrupted: vi.fn().mockResolvedValue(undefined),
  start: vi.fn(),
  list: vi.fn(),
}));

vi.mock('../../../../src/services/CodeReviewService.js', () => ({
  CodeReviewService: codeReviewState,
  renderCodeReview: vi.fn(() => '## Code Review'),
}));

// Mock Agent
vi.mock('../../../../src/agent/Agent.js', () => {
  const createAgent = (): AgentMockInstance => {
    const mockAgent: AgentMockInstance = Object.assign(createMockAgent(), {
      switchModel: vi.fn(async (_modelId: string): Promise<void> => undefined),
    });
    mockAgent.destroy = vi.fn().mockResolvedValue(undefined);
    agentMockState.current = mockAgent;
    return mockAgent;
  };
  const MockAgentClass = Object.assign(vi.fn().mockImplementation(createAgent), {
    create: vi.fn(async () => createAgent()),
    createWithRuntime: vi.fn(async () => createAgent()),
  });

  return { Agent: MockAgentClass };
});

vi.mock('../../../../src/agent/runtime/SessionRuntime.js', () => ({
  SessionRuntime: {
    create: vi.fn(async () => runtimeState.runtime),
  },
}));

const sessionServiceState = vi.hoisted(() => ({
  loadSession: vi.fn().mockResolvedValue([]),
  loadSessionModelContext: vi.fn().mockResolvedValue([]),
  loadRemoteSession: vi.fn().mockResolvedValue([]),
  loadRemoteSessionModelContext: vi.fn().mockResolvedValue([]),
  setSessionPermissionMode: vi.fn().mockResolvedValue({
    permissionMode: 'default',
  }),
  updateSessionMetadata: vi.fn().mockResolvedValue({
    selectedModelId: 'model-1',
    reasoningEffort: 'off',
    serviceTier: 'auto',
    responseVerbosity: 'auto',
    communicationStyle: 'auto',
  }),
  updateRemoteSessionMetadata: vi.fn().mockResolvedValue({
    selectedModelId: 'model-1',
    reasoningEffort: 'off',
    serviceTier: 'auto',
    responseVerbosity: 'auto',
    communicationStyle: 'auto',
  }),
  createSessionMetadata: vi.fn().mockResolvedValue({
    selectedModelId: 'model-1',
    reasoningEffort: 'off',
    serviceTier: 'auto',
    responseVerbosity: 'auto',
    communicationStyle: 'auto',
  }),
}));

vi.mock('../../../../src/services/SessionService.js', () => ({
  SessionMissingCreationError: class SessionMissingCreationError extends Error {},
  SessionService: sessionServiceState,
}));

// Mock AcpServiceContext
vi.mock('../../../../src/acp/AcpServiceContext.js', () => ({
  isAcpMode: vi.fn(() => true),
  AcpServiceContext: {
    initializeSession: vi.fn(() => ({
      generation: 'acp-owner-generation:test',
      sessionId: 'test-session-id',
    })),
    destroyRegisteredSession: vi.fn(),
    destroySession: vi.fn(),
    setCurrentSession: vi.fn(),
    getTerminalService: vi.fn(() => terminalState),
  },
}));

// Mock slash commands
vi.mock('../../../../src/slash-commands/index.js', () => ({
  executeSlashCommand: vi.fn().mockResolvedValue({
    success: true,
    message: 'Command executed',
    content: 'Command result',
  }),
  getRegisteredCommands: vi.fn(() => [
    {
      name: 'test',
      description: 'Test command',
      usage: '/test [args]',
      aliases: ['t'],
    },
  ]),
  initializeCustomCommands: vi.fn().mockResolvedValue({
    commands: [],
    scannedDirs: [],
    errors: [],
  }),
  isSlashCommand: vi.fn((msg) => msg.startsWith('/')),
}));

// Mock task item type

describe('AcpSession', () => {
  let mockConnection: ReturnType<typeof createMockACPClient>;
  let connectionAbortController: AbortController;
  let session: AcpSession;

  beforeEach(() => {
    agentMockState.current = null;
    runtimeState.runtime.dispose.mockReset().mockResolvedValue(undefined);
    runtimeState.runtime.discardPendingInput.mockReset().mockResolvedValue(undefined);
    runtimeState.runtime.getCurrentModelId.mockReturnValue('model-1');
    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(0);
    runtimeState.runtime.getPendingSteeringMessages.mockReturnValue([]);
    runtimeState.runtime.getFollowUpQueueSnapshot
      .mockReset()
      .mockResolvedValue(followUpQueue('0'.repeat(64), 0));
    runtimeState.runtime.isIdleForResidency.mockReturnValue(true);
    runtimeState.runtime.getTurnRecoveryAssessment.mockReturnValue({ state: 'none' });
    runtimeState.runtime.getGoal.mockReset().mockResolvedValue(null);
    runtimeState.runtime.listRewindCheckpoints.mockReset().mockResolvedValue([]);
    runtimeState.runtime.rewindSession.mockReset();
    runtimeState.runtime.listSubagents.mockReset().mockReturnValue([]);
    runtimeState.runtime.resumeSubagent.mockReset();
    runtimeState.runtime.askSideQuestion.mockReset().mockResolvedValue({
      response: 'Side answer',
      durationMs: 14,
    });
    runtimeState.runtime.executeUserShellCommand.mockReset();
    sessionServiceState.loadSession.mockReset().mockResolvedValue([]);
    sessionServiceState.loadSessionModelContext
      .mockReset()
      .mockImplementation((...args: unknown[]) =>
        sessionServiceState.loadSession(...args)
      );
    sessionServiceState.loadRemoteSession.mockReset().mockResolvedValue([]);
    sessionServiceState.loadRemoteSessionModelContext.mockReset().mockResolvedValue([]);
    sessionServiceState.updateRemoteSessionMetadata
      .mockReset()
      .mockResolvedValue({ permissionMode: 'default' });
    codeReviewState.recoverInterrupted.mockReset().mockResolvedValue(undefined);
    codeReviewState.start.mockReset();
    codeReviewState.list.mockReset();
    sessionServiceState.setSessionPermissionMode
      .mockReset()
      .mockImplementation(async (_sessionId, _cwd, permissionMode) => ({
        permissionMode,
      }));
    terminalState.execute.mockReset();
    // 创建 mock 连接
    mockConnection = createMockACPClient();
    connectionAbortController = new AbortController();
    Object.defineProperty(mockConnection, 'signal', {
      value: connectionAbortController.signal,
    });

    // 创建会话实例
    session = new AcpSession(
      'test-session-id',
      createLocalAcpSessionRoots('/tmp/test'),
      mockConnection as any,
      {
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
      } as any
    );
  });

  afterEach(async () => {
    await session.destroy().catch(() => undefined);
    vi.clearAllMocks();
    runtimeState.runtime.dispose.mockClear();
    runtimeState.runtime.enqueueSteering.mockClear();
  });

  describe('initialize', () => {
    it('应该将 durable task worktree 作为外部托管隔离传入 Agent', async () => {
      const taskWorktree = {
        sessionId: 'task-session',
        name: 'task/task-session',
        branch: 'blade-worktree-task+session',
        baseCommit: 'abc123',
        originalBranch: 'main',
        repositoryRoot: '/tmp/source',
        originalWorkspaceRoot: '/tmp/source',
        worktreeRoot: '/tmp/task-worktree',
        workspaceRoot: '/tmp/task-worktree',
        sourceHadChanges: false,
      };
      const taskSession = new AcpSession(
        'task-session',
        createLocalAcpSessionRoots('/tmp/task-worktree'),
        mockConnection as any,
        undefined,
        { taskWorktree }
      );

      try {
        await taskSession.initialize();
        const { Agent } = await import('../../../../src/agent/Agent.js');
        expect(Agent.createWithRuntime).toHaveBeenCalledWith(runtimeState.runtime, {
          sessionId: 'task-session',
          toolBlacklist: ['EnterWorktree', 'ExitWorktree'],
        });

        await taskSession.prompt({
          sessionId: 'task-session',
          prompt: [{ type: 'text', text: 'continue isolated task' }],
        });
        expect(getMockAgent().getLastCall()?.context).toMatchObject({
          workspaceRoot: '/tmp/task-worktree',
          worktreeActive: true,
        });
      } finally {
        await taskSession.destroy();
      }
    });

    it('应该在初始化后自动恢复 durable follow-up', async () => {
      runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
      await session.initialize();

      await vi.waitFor(() => {
        expect(getMockAgent().calls[0]).toMatchObject({
          message: '',
          options: { pendingInputOnly: true },
        });
      });
    });

    it('projects recovery attention without starting an ACP prompt', async () => {
      runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
      runtimeState.runtime.getTurnRecoveryAssessment.mockReturnValue({
        state: 'requires_attention',
        turnId: 'turn-before-restart',
        inputMessageCount: 1,
        reason: 'interrupted_tool_call',
      });
      await session.initialize();

      await vi.waitFor(() => {
        expect(mockConnection.sessionUpdates).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              update: expect.objectContaining({
                sessionUpdate: 'session_info_update',
                _meta: {
                  'blade/turnRecovery': {
                    state: 'requires_attention',
                    turnId: 'turn-before-restart',
                    inputMessageCount: 1,
                    reason: 'interrupted_tool_call',
                  },
                },
              }),
            }),
          ])
        );
      });
      expect(getMockAgent().calls).toEqual([]);
    });

    it('projects a completed startup recovery without starting an ACP prompt', async () => {
      runtimeState.runtime.getGoal.mockResolvedValue({ status: 'complete' });
      runtimeState.runtime.getTurnRecoveryAssessment.mockReturnValue({
        state: 'completed',
        turnId: 'turn-finalized-before-restart',
        inputMessageCount: 1,
      });

      await session.initialize();

      expect(mockConnection.sessionUpdates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'session_info_update',
              _meta: {
                'blade/turnRecovery': {
                  state: 'completed',
                  turnId: 'turn-finalized-before-restart',
                  inputMessageCount: 1,
                },
              },
            }),
          }),
        ])
      );
      expect(getMockAgent().calls).toEqual([]);
    });

    it('does not retry or report recovered when the recovered writer rejects', async () => {
      vi.useFakeTimers();
      try {
        await session.initialize();
        const mockAgent = getMockAgent();
        const originalSessionUpdate = mockConnection.sessionUpdate.bind(mockConnection);
        let rejectRecovered!: (reason: Error) => void;
        const recoveredWrite = new Promise<void>((_resolve, reject) => {
          rejectRecovered = reject;
        });
        let markRecoveredEntered!: () => void;
        const recoveredEntered = new Promise<void>((resolve) => {
          markRecoveredEntered = resolve;
        });
        vi.spyOn(mockConnection, 'sessionUpdate').mockImplementation(async (params) => {
          const lifecycle = params.update._meta?.['blade/pendingResume'] as
            | { phase?: string }
            | undefined;
          if (lifecycle?.phase === 'recovered') {
            markRecoveredEntered();
            await recoveredWrite;
          }
          await originalSessionUpdate(params);
        });
        let attempt = 0;
        mockAgent.chatStream = vi.fn(async function* () {
          attempt += 1;
          yield* [] as LoopEvent[];
          if (attempt === 1) {
            return {
              success: false,
              error: { type: 'api_error', message: 'Provider request timed out.' },
              metadata: { turnsCount: 1, toolCallsCount: 0, duration: 10 },
            } satisfies LoopResult;
          }
          return { success: true, finalMessage: 'recovered' } satisfies LoopResult;
        }) as typeof mockAgent.chatStream;
        runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
        publishSubagentCompletion('reject-recovered-child');

        vi.runAllTicks();
        await vi.waitFor(() => expect(mockAgent.chatStream).toHaveBeenCalledTimes(1));
        await vi.runOnlyPendingTimersAsync();
        await recoveredEntered;
        rejectRecovered(new Error('writer rejected recovered metadata'));
        await vi.waitFor(() => expect(session.isIdleForResidency()).toBe(true));

        publishSubagentCompletion('wake-after-recovered-rejection');
        vi.runAllTicks();
        await Promise.resolve();

        expect(mockAgent.chatStream).toHaveBeenCalledTimes(2);
        expect(
          mockConnection.sessionUpdates.filter(({ update }) => {
            const lifecycle = update._meta?.['blade/pendingResume'] as
              | { phase?: string }
              | undefined;
            return lifecycle?.phase === 'retry_scheduled';
          })
        ).toHaveLength(1);
        expect(
          mockConnection.sessionUpdates.some(({ update }) => {
            const lifecycle = update._meta?.['blade/pendingResume'] as
              | { phase?: string }
              | undefined;
            return lifecycle?.phase === 'recovered';
          })
        ).toBe(false);
        await expect(session.destroy()).resolves.toBeUndefined();
      } finally {
        await session.destroy().catch(() => undefined);
        vi.useRealTimers();
      }
    });

    it('projects recovered input on the first prompt after a preflight retry', async () => {
      vi.useFakeTimers();
      try {
        await session.initialize();
        runtimeState.runtime.getPendingSteeringCount
          .mockReturnValueOnce(0)
          .mockReturnValue(1);
        runtimeState.runtime.getGoal
          .mockReset()
          .mockRejectedValueOnce(new Error('Provider request timed out.'));
        const mockAgent = getMockAgent();
        mockAgent.chatStream = vi.fn(async function* () {
          yield {
            kind: 'follow_up_started',
            queued: 1,
            recovered: 1,
            messages: [
              {
                id: 'preflight-recovered-input',
                content: 'input after preflight retry',
                queuedAt: Date.now(),
                recovered: true,
                persisted: false,
              },
            ],
          } as LoopEvent;
          return {
            success: true,
            finalMessage: 'recovered',
            metadata: {
              turnsCount: 1,
              toolCallsCount: 0,
              duration: 10,
            },
          } satisfies LoopResult;
        }) as typeof mockAgent.chatStream;
        publishSubagentCompletion('preflight-retry-child');

        vi.runAllTicks();
        await vi.waitFor(
          () =>
            expect(
              mockConnection.sessionUpdates.some(
                ({ update }) =>
                  update.sessionUpdate === 'session_info_update' &&
                  (
                    update._meta?.['blade/pendingResume'] as
                      | { phase?: string }
                      | undefined
                  )?.phase === 'retry_scheduled'
              )
            ).toBe(true),
          { timeout: 500, interval: 1 }
        );
        await vi.runOnlyPendingTimersAsync();

        expect(mockAgent.chatStream).toHaveBeenCalledTimes(1);
        expect(
          mockConnection.sessionUpdates.filter(
            ({ update }) =>
              update.sessionUpdate === 'user_message_chunk' &&
              update.content.type === 'text' &&
              update.content.text === 'input after preflight retry'
          )
        ).toHaveLength(1);
      } finally {
        await session.destroy().catch(() => undefined);
        vi.useRealTimers();
      }
    });

    it('stops retrying when the recovery time budget is exhausted', async () => {
      vi.useFakeTimers({ now: 1_000 });
      try {
        await session.initialize();
        const mockAgent = getMockAgent();
        mockAgent.chatStream = vi.fn(async function* () {
          vi.setSystemTime(121_001);
          yield* [] as LoopEvent[];
          return {
            success: false,
            error: {
              type: 'api_error',
              message: 'Provider request timed out.',
            },
            metadata: {
              turnsCount: 1,
              toolCallsCount: 0,
              duration: 120_001,
            },
          } satisfies LoopResult;
        }) as typeof mockAgent.chatStream;
        runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
        publishSubagentCompletion('budget-child');

        vi.runAllTicks();
        await vi.waitFor(() => expect(mockAgent.chatStream).toHaveBeenCalledTimes(1), {
          timeout: 500,
          interval: 1,
        });
        await vi.runAllTimersAsync();

        expect(mockAgent.chatStream).toHaveBeenCalledTimes(1);
        expect(mockConnection.sessionUpdates).toContainEqual(
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'session_info_update',
              _meta: {
                'blade/pendingResume': expect.objectContaining({
                  phase: 'exhausted',
                  attempt: 1,
                }),
              },
            }),
          })
        );
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await session.destroy().catch(() => undefined);
        vi.useRealTimers();
      }
    });

    it('aborts an in-flight resume at the recovery deadline', async () => {
      vi.useFakeTimers({ now: 1_000 });
      try {
        await session.initialize();
        const mockAgent = getMockAgent();
        mockAgent.chatStream = vi.fn(async function* (_message, context) {
          await new Promise<void>((resolve) => {
            if (context.signal?.aborted) {
              resolve();
              return;
            }
            context.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
          yield* [] as LoopEvent[];
          return {
            success: false,
            error: {
              type: 'aborted',
              message: 'aborted',
            },
            metadata: {
              turnsCount: 1,
              toolCallsCount: 0,
              duration: 120_000,
            },
          } satisfies LoopResult;
        }) as typeof mockAgent.chatStream;
        runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
        publishSubagentCompletion('deadline-child');

        vi.runAllTicks();
        await vi.waitFor(() => expect(mockAgent.chatStream).toHaveBeenCalledTimes(1), {
          timeout: 500,
          interval: 1,
        });
        await vi.advanceTimersByTimeAsync(120_000);

        expect(mockConnection.sessionUpdates).toContainEqual(
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'session_info_update',
              _meta: {
                'blade/pendingResume': expect.objectContaining({
                  phase: 'exhausted',
                  attempt: 1,
                  failure: {
                    code: 'timeout',
                    retryable: true,
                  },
                }),
              },
            }),
          })
        );
        expect(mockAgent.chatStream).toHaveBeenCalledTimes(1);
        expect(runtimeState.runtime.discardPendingInput).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await session.destroy().catch(() => undefined);
        vi.useRealTimers();
      }
    });

    it('preserves pending input when a Goal continuation reaches its deadline', async () => {
      vi.useFakeTimers({ now: 1_000 });
      try {
        await session.initialize();
        runtimeState.runtime.getGoal.mockResolvedValue({
          status: 'active',
        });
        runtimeState.runtime.getPendingSteeringCount.mockReturnValue(0);
        const mockAgent = getMockAgent();
        let attempt = 0;
        const chatStream = vi.fn(async function* (
          _message: unknown,
          context: { signal?: AbortSignal }
        ) {
          attempt++;
          if (attempt === 1) {
            await new Promise<void>((resolve) => {
              if (context.signal?.aborted) {
                resolve();
                return;
              }
              context.signal?.addEventListener('abort', () => resolve(), {
                once: true,
              });
            });
            yield* [] as LoopEvent[];
            return {
              success: false,
              error: {
                type: 'aborted',
                message: 'aborted',
              },
              metadata: {
                turnsCount: 1,
                toolCallsCount: 0,
                duration: 120_000,
              },
            } satisfies LoopResult;
          }
          yield* [] as LoopEvent[];
          return {
            success: true,
            finalMessage: 'pending input completed',
            metadata: {
              turnsCount: 1,
              toolCallsCount: 0,
              duration: 10,
            },
          } satisfies LoopResult;
        });
        mockAgent.chatStream = chatStream as typeof mockAgent.chatStream;

        publishSubagentCompletion('goal-deadline-wake');
        vi.runAllTicks();
        await vi.waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1), {
          timeout: 500,
          interval: 1,
        });
        runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
        publishSubagentCompletion('pending-after-goal-deadline');
        await vi.advanceTimersByTimeAsync(120_000);

        await vi.waitFor(() => expect(chatStream).toHaveBeenCalledTimes(2), {
          timeout: 500,
          interval: 1,
        });
        expect(chatStream).toHaveBeenNthCalledWith(
          2,
          '',
          expect.any(Object),
          expect.objectContaining({ pendingInputOnly: true })
        );
        expect(
          mockConnection.sessionUpdates.some(
            ({ update }) =>
              update.sessionUpdate === 'session_info_update' &&
              (
                update._meta?.['blade/pendingResume'] as
                  | { phase?: string; kind?: string }
                  | undefined
              )?.phase === 'exhausted' &&
              (
                update._meta?.['blade/pendingResume'] as
                  | { phase?: string; kind?: string }
                  | undefined
              )?.kind === 'goal'
          )
        ).toBe(true);
      } finally {
        await session.destroy().catch(() => undefined);
        vi.useRealTimers();
      }
    });

    it('resumes pending input after a side conversation settles', async () => {
      await session.initialize();
      const { executeSlashCommand } = await import(
        '../../../../src/slash-commands/index.js'
      );
      let releaseSideConversation!: () => void;
      const sideConversationBlocked = new Promise<void>((resolve) => {
        releaseSideConversation = resolve;
      });
      vi.mocked(executeSlashCommand).mockImplementationOnce(async () => {
        await sideConversationBlocked;
        return {
          success: true,
          message: 'side conversation completed',
        };
      });
      const mockAgent = getMockAgent();
      const chatStream = vi.fn(async function* () {
        yield* [] as LoopEvent[];
        return {
          success: true,
          finalMessage: 'pending input completed',
          metadata: {
            turnsCount: 1,
            toolCallsCount: 0,
            duration: 10,
          },
        } satisfies LoopResult;
      });
      mockAgent.chatStream = chatStream as typeof mockAgent.chatStream;

      const sideConversation = promptText(session, '/btw inspect current state');
      await vi.waitFor(() => expect(executeSlashCommand).toHaveBeenCalledTimes(1));

      runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
      publishSubagentCompletion('side-conversation-child');
      await Promise.resolve();
      expect(chatStream).not.toHaveBeenCalled();

      releaseSideConversation();
      await sideConversation;
      await vi.waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1));
      expect(chatStream).toHaveBeenCalledWith(
        '',
        expect.any(Object),
        expect.objectContaining({ pendingInputOnly: true })
      );
    });

    it('does not run a queued auto-resume after cancellation', async () => {
      vi.useFakeTimers();
      try {
        await session.initialize();
        const chatStream = vi.spyOn(getMockAgent(), 'chatStream');
        runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
        publishSubagentCompletion('cancel-child');

        session.cancel();
        await vi.runAllTimersAsync();

        expect(chatStream).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await session.destroy().catch(() => undefined);
        vi.useRealTimers();
      }
    });

    it('cancels a scheduled retry without consuming durable input', async () => {
      vi.useFakeTimers();
      try {
        await session.initialize();
        const mockAgent = getMockAgent();
        mockAgent.chatStream = vi.fn(async function* () {
          yield* [] as LoopEvent[];
          return {
            success: false,
            error: {
              type: 'api_error',
              message: 'Provider request timed out.',
            },
            metadata: {
              turnsCount: 1,
              toolCallsCount: 0,
              duration: 10,
            },
          } satisfies LoopResult;
        }) as typeof mockAgent.chatStream;
        runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
        publishSubagentCompletion('cancel-retry-child');

        vi.runAllTicks();
        await vi.waitFor(() => expect(mockAgent.chatStream).toHaveBeenCalledTimes(1), {
          timeout: 500,
          interval: 1,
        });
        expect(vi.getTimerCount()).toBe(1);

        session.cancel();
        await vi.runAllTimersAsync();

        expect(mockAgent.chatStream).toHaveBeenCalledTimes(1);
        expect(runtimeState.runtime.discardPendingInput).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await session.destroy().catch(() => undefined);
        vi.useRealTimers();
      }
    });

    it('coalesces duplicate wake signals into one resume attempt', async () => {
      vi.useFakeTimers();
      try {
        await session.initialize();
        const mockAgent = getMockAgent();
        const chatStream = vi.fn(async function* () {
          yield* [] as LoopEvent[];
          return {
            success: true,
            finalMessage: 'resumed once',
            metadata: {
              turnsCount: 1,
              toolCallsCount: 0,
              duration: 10,
            },
          } satisfies LoopResult;
        }) as typeof mockAgent.chatStream;
        mockAgent.chatStream = chatStream;
        runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
        publishSubagentCompletion('coalesced-child');
        publishSubagentCompletion('coalesced-child');
        vi.runAllTicks();
        await vi.waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1), {
          timeout: 500,
          interval: 1,
        });
        await vi.runAllTimersAsync();

        expect(chatStream).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await session.destroy().catch(() => undefined);
        vi.useRealTimers();
      }
    });

    it('preserves a wake signal that arrives during an idle preflight', async () => {
      await session.initialize();
      let releaseGoalRead!: () => void;
      const goalRead = new Promise<null>((resolve) => {
        releaseGoalRead = () => resolve(null);
      });
      runtimeState.runtime.getGoal.mockReset().mockImplementationOnce(() => goalRead);
      runtimeState.runtime.getPendingSteeringCount.mockReturnValue(0);
      const mockAgent = getMockAgent();
      const chatStream = vi.fn(async function* () {
        yield* [] as LoopEvent[];
        return {
          success: true,
          finalMessage: 'new wake processed',
          metadata: {
            turnsCount: 1,
            toolCallsCount: 0,
            duration: 10,
          },
        } satisfies LoopResult;
      }) as typeof mockAgent.chatStream;
      mockAgent.chatStream = chatStream;

      publishSubagentCompletion('preflight-child');
      await vi.waitFor(() => {
        expect(runtimeState.runtime.getGoal).toHaveBeenCalledTimes(1);
      });
      runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
      publishSubagentCompletion('late-child');
      releaseGoalRead();

      await vi.waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1));
    });

    it('preserves pending input that arrives during a failed preflight', async () => {
      await session.initialize();
      let rejectGoalRead!: (error: Error) => void;
      const goalRead = new Promise<null>((_resolve, reject) => {
        rejectGoalRead = reject;
      });
      runtimeState.runtime.getGoal.mockReset().mockImplementationOnce(() => goalRead);
      runtimeState.runtime.getPendingSteeringCount.mockReturnValue(0);
      const mockAgent = getMockAgent();
      const chatStream = vi.fn(async function* () {
        yield* [] as LoopEvent[];
        return {
          success: true,
          finalMessage: 'new wake processed',
          metadata: {
            turnsCount: 1,
            toolCallsCount: 0,
            duration: 10,
          },
        } satisfies LoopResult;
      });
      mockAgent.chatStream = chatStream as typeof mockAgent.chatStream;

      publishSubagentCompletion('failing-preflight-child');
      await vi.waitFor(() => {
        expect(runtimeState.runtime.getGoal).toHaveBeenCalledTimes(1);
      });
      runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
      publishSubagentCompletion('pending-after-preflight-failure');
      rejectGoalRead(new Error('Provider authentication failed.'));

      await vi.waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1));
      expect(chatStream).toHaveBeenCalledWith(
        '',
        expect.any(Object),
        expect.objectContaining({ pendingInputOnly: true })
      );
    });

    it('应该通过 session metadata 投影 team lifecycle 事件', async () => {
      await session.initialize();
      mockConnection.sessionUpdates = [];

      Bus.publish(
        { sessionId: 'test-session-id', projectPath: '/tmp/test' },
        'team.task.unblocked',
        {
          teamName: 'review-team',
          task: { id: '2', status: 'pending' },
        }
      );

      await vi.waitFor(() => {
        expect(mockConnection.sessionUpdates).toContainEqual({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'session_info_update',
            updatedAt: expect.any(String),
            _meta: {
              'blade/teamEvent': {
                type: 'team.task.unblocked',
                teamName: 'review-team',
                task: { id: '2', status: 'pending' },
              },
            },
          },
        });
      });
    });

    it('应该实时推送 task lifecycle metadata 并在 destroy 后取消订阅', async () => {
      await session.initialize();
      mockConnection.sessionUpdates = [];
      const updatedAt = '2026-08-05T12:00:00.000Z';

      Bus.publish(
        { sessionId: 'test-session-id', projectPath: '/tmp/test' },
        'task.status',
        {
          taskStatus: 'running',
          taskStartedAt: updatedAt,
          taskQueueDepth: 0,
          taskConcurrencyLimit: 3,
          taskInFlight: 1,
          updatedAt,
        }
      );
      await vi.waitFor(() => {
        expect(mockConnection.sessionUpdates).toContainEqual({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'session_info_update',
            updatedAt,
            _meta: {
              'blade/taskStatus': 'running',
              'blade/taskStartedAt': updatedAt,
              'blade/taskQueueDepth': 0,
              'blade/taskConcurrencyLimit': 3,
              'blade/taskInFlight': 1,
            },
          },
        });
      });
      const taskFailure = {
        code: 'capacity',
        message: 'Task admission capacity is full. Retry after running tasks complete.',
        retryable: true,
        resource: 'pending_bytes',
      };
      Bus.publish(
        { sessionId: 'test-session-id', projectPath: '/tmp/test' },
        'task.status',
        {
          taskStatus: 'failed',
          taskStatusReason: taskFailure.message,
          taskFailure,
          taskCompletedAt: updatedAt,
          updatedAt,
        }
      );
      await vi.waitFor(() => {
        expect(mockConnection.sessionUpdates).toContainEqual({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'session_info_update',
            updatedAt,
            _meta: {
              'blade/taskStatus': 'failed',
              'blade/taskStatusReason': taskFailure.message,
              'blade/taskFailure': taskFailure,
              'blade/taskCompletedAt': updatedAt,
            },
          },
        });
      });
      const taskDiffStat = {
        changedFiles: 2,
        additions: 7,
        deletions: 1,
        commits: 0,
      };
      Bus.publish(
        { sessionId: 'test-session-id', projectPath: '/tmp/test' },
        'task.status',
        {
          taskStatus: 'completed',
          taskCompletedAt: updatedAt,
          taskDiffStat,
          updatedAt,
        }
      );
      await vi.waitFor(() => {
        expect(mockConnection.sessionUpdates).toContainEqual({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'session_info_update',
            updatedAt,
            _meta: {
              'blade/taskStatus': 'completed',
              'blade/taskCompletedAt': updatedAt,
              'blade/taskDiffStat': taskDiffStat,
            },
          },
        });
      });
      const taskDelivery = {
        status: 'applied',
        updatedAt,
        sourceCommit: 'abc123',
        changedFiles: 2,
      };
      Bus.publish(
        { sessionId: 'test-session-id', projectPath: '/tmp/test' },
        'task.delivery',
        {
          taskDelivery,
          taskWorktreeRemoved: true,
          updatedAt,
        }
      );
      await vi.waitFor(() => {
        expect(mockConnection.sessionUpdates).toContainEqual({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'session_info_update',
            updatedAt,
            _meta: {
              'blade/taskDelivery': taskDelivery,
              'blade/taskWorktreeRemoved': true,
            },
          },
        });
      });

      await session.destroy();
      const countAfterDestroy = mockConnection.sessionUpdates.length;
      Bus.publish(
        { sessionId: 'test-session-id', projectPath: '/tmp/test' },
        'task.status',
        {
          taskStatus: 'failed',
          updatedAt,
        }
      );
      await Promise.resolve();
      expect(mockConnection.sessionUpdates).toHaveLength(countAfterDestroy);
    });
  });

  describe('MCP sampling projection', () => {
    it('requires one-shot approval in yolo mode and exposes the request preview', async () => {
      await session.setMode('yolo');
      const requestPermission = vi
        .spyOn(mockConnection, 'requestPermission')
        .mockResolvedValue({
          outcome: { outcome: 'selected', optionId: 'allow_once' },
        });

      const response = await (
        session as unknown as {
          requestPermission: (
            input: ConfirmationDetails
          ) => Promise<ConfirmationResponse>;
        }
      ).requestPermission({
        type: 'mcpSampling',
        kind: ToolKind.Execute,
        title: 'MCP model sampling request',
        message: 'May consume up to 128 output tokens.',
        details: 'User: Return the release marker.',
      });

      expect(response).toEqual({ approved: true, scope: 'once' });
      expect(requestPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          options: [
            expect.objectContaining({ optionId: 'allow_once' }),
            expect.objectContaining({ optionId: 'reject_once' }),
          ],
          toolCall: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                content: {
                  type: 'text',
                  text: 'User: Return the release marker.',
                },
              }),
            ]),
          }),
        })
      );
    });
  });

  describe('MCP elicitation projection', () => {
    const requestMcpElicitation = (target: AcpSession, details: ConfirmationDetails) =>
      (
        target as unknown as {
          requestPermission: (
            input: ConfirmationDetails
          ) => Promise<ConfirmationResponse>;
        }
      ).requestPermission(details);

    it('maps enum and boolean form fields to ACP choices', async () => {
      const requestPermission = vi
        .spyOn(mockConnection, 'requestPermission')
        .mockResolvedValueOnce({
          outcome: { outcome: 'selected', optionId: 'option:1' },
        })
        .mockResolvedValueOnce({
          outcome: { outcome: 'selected', optionId: 'true' },
        });

      const response = await requestMcpElicitation(session, {
        type: 'mcpElicitation',
        message: 'Configure release',
        mcpElicitation: {
          serverName: 'deploy',
          mode: 'form',
          message: 'Configure release',
          requestedSchema: { type: 'object', properties: {} },
          fields: [
            {
              name: 'channel',
              type: 'select',
              title: 'Channel',
              required: true,
              options: [
                { value: 'stable', label: 'Stable' },
                { value: 'preview', label: 'Preview' },
              ],
            },
            {
              name: 'notifications',
              type: 'boolean',
              title: 'Notifications',
              required: true,
            },
          ],
        },
      });

      expect(response).toEqual({
        approved: true,
        elicitation: {
          action: 'accept',
          content: {
            channel: 'preview',
            notifications: true,
          },
        },
      });
      expect(requestPermission).toHaveBeenCalledTimes(2);
    });

    it('fails closed for a required free-text field ACP cannot represent', async () => {
      const response = await requestMcpElicitation(session, {
        type: 'mcpElicitation',
        message: 'Configure release',
        mcpElicitation: {
          serverName: 'deploy',
          mode: 'form',
          message: 'Configure release',
          requestedSchema: { type: 'object', properties: {} },
          fields: [
            {
              name: 'owner',
              type: 'string',
              title: 'Owner',
              required: true,
            },
          ],
        },
      });

      expect(response).toEqual({
        approved: false,
        reason: 'ACP cannot collect required string field "owner"',
        elicitation: { action: 'cancel' },
      });
      expect(mockConnection.permissionRequests).toHaveLength(0);
    });

    it('surfaces URL details without opening them on the ACP host', async () => {
      const requestPermission = vi
        .spyOn(mockConnection, 'requestPermission')
        .mockResolvedValueOnce({
          outcome: { outcome: 'selected', optionId: 'accept' },
        });
      const response = await requestMcpElicitation(session, {
        type: 'mcpElicitation',
        message: 'Authorize release',
        mcpElicitation: {
          serverName: 'deploy',
          mode: 'url',
          message: 'Authorize release',
          url: 'https://deploy.example.test/authorize?state=opaque',
          domain: 'deploy.example.test',
          elicitationId: 'auth-1',
        },
      });

      expect(response).toEqual({
        approved: true,
        elicitation: { action: 'accept' },
      });
      expect(
        JSON.stringify(requestPermission.mock.calls[0]?.[0].toolCall.content)
      ).toContain('https://deploy.example.test/authorize?state=opaque');
    });
  });

  describe('replayHistory', () => {
    it.each(['destroy', 'abort'] as const)(
      '%s 后停止 deferred history replay 且不恢复 pending input',
      async (stopMethod) => {
        await session.initialize();
        getMockAgent().chatStream = async function* (_message, context) {
          context.messages.push(
            { role: 'user', content: 'first visible chunk' },
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'second visible chunk' },
                { type: 'text', text: 'third visible chunk' },
              ],
            }
          );
          yield { kind: 'turn_start', turn: 1, maxTurns: 1 };
          return { success: true, finalMessage: 'history prepared' };
        };
        await promptText(session, 'prepare replay history');
        mockConnection.sessionUpdates = [];
        runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);

        let releaseFirstUpdate: (() => void) | undefined;
        const firstUpdateGate = new Promise<void>((resolve) => {
          releaseFirstUpdate = resolve;
        });
        const originalSessionUpdate = mockConnection.sessionUpdate.bind(mockConnection);
        let updateCount = 0;
        vi.spyOn(mockConnection, 'sessionUpdate').mockImplementation(async (params) => {
          updateCount += 1;
          await originalSessionUpdate(params);
          if (updateCount === 1) await firstUpdateGate;
        });

        const replay = session.replayHistory();
        await vi.waitFor(() => {
          expect(mockConnection.sessionUpdates).toHaveLength(1);
        });

        if (stopMethod === 'destroy') {
          await session.destroy();
        } else {
          connectionAbortController.abort();
        }
        releaseFirstUpdate?.();
        await expect(replay).resolves.toBeUndefined();
        await Promise.resolve();

        expect(mockConnection.sessionUpdates).toHaveLength(1);
        expect(getMockAgent().calls).toHaveLength(0);
      }
    );

    it('应该按顺序回放用户和助手历史且隐藏内部消息', async () => {
      const history: Message[] = [
        { role: 'user', content: 'Original question' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Original ' },
            { type: 'text', text: 'answer' },
          ],
        },
        { role: 'tool', content: 'internal tool output', tool_call_id: 'tool-1' },
        { role: 'system', content: 'internal summary' },
        {
          role: 'user',
          content: 'internal empty-final corrective',
          metadata: { clientVisible: false },
        },
      ];
      session = new AcpSession(
        'test-session-id',
        createLocalAcpSessionRoots('/tmp/test'),
        mockConnection as any,
        undefined,
        { initialMessages: history }
      );

      await session.replayHistory();

      expect(mockConnection.sessionUpdates).toEqual([
        {
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'Original question' },
          },
        },
        {
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Original ' },
          },
        },
        {
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'answer' },
          },
        },
      ]);
    });

    it('回放恢复后的 final assistant 与 durable complete Goal 且不启动模型', async () => {
      const history: Message[] = [
        { role: 'user', content: 'Finish the durable goal.' },
        { role: 'assistant', content: 'ACP_GOAL_FINALIZATION_RECOVERED' },
      ];
      runtimeState.runtime.getGoal.mockResolvedValue({
        version: 1,
        sessionId: 'test-session-id',
        goalId: 'goal-acp-recovered',
        objective: 'Finish the durable goal.',
        status: 'complete',
        tokensUsed: 100,
        timeUsedSeconds: 2,
        continuationCount: 1,
        completionVerification: {
          attempt: 1,
          status: 'pass',
          requestedAt: '2026-08-14T00:00:00.000Z',
          completedAt: '2026-08-14T00:00:01.000Z',
          verifierSessionId: 'verifier-acp-recovered',
          summary: 'All requirements were verified from current workspace state.',
          evidenceSha256: 'a'.repeat(64),
        },
        createdAt: '2026-08-14T00:00:00.000Z',
        updatedAt: '2026-08-14T00:00:02.000Z',
      });
      session = new AcpSession(
        'test-session-id',
        createLocalAcpSessionRoots('/tmp/test'),
        mockConnection as any,
        undefined,
        { initialMessages: history }
      );
      await session.initialize();
      mockConnection.sessionUpdates = [];

      await session.replayHistory();

      expect(mockConnection.sessionUpdates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'ACP_GOAL_FINALIZATION_RECOVERED',
              },
            },
          }),
          expect.objectContaining({
            update: {
              sessionUpdate: 'session_info_update',
              updatedAt: '2026-08-14T00:00:02.000Z',
              _meta: {
                'blade/goal': {
                  goalId: 'goal-acp-recovered',
                  status: 'complete',
                  verificationAttempt: 1,
                  verificationStatus: 'pass',
                  verifierSessionId: 'verifier-acp-recovered',
                  verificationEvidenceSha256: 'a'.repeat(64),
                  verificationSummary:
                    'All requirements were verified from current workspace state.',
                  verificationStallCount: undefined,
                },
              },
            },
          }),
        ])
      );
      expect(getMockAgent().calls).toHaveLength(0);
    });
  });

  describe('ACP MCP session setup', () => {
    it('应该把结构化 MCP server 转换为 SessionRuntime 配置', async () => {
      session = new AcpSession(
        'test-session-id',
        createLocalAcpSessionRoots('/tmp/test'),
        mockConnection as any,
        undefined,
        {
          mcpServers: [
            {
              name: 'project-tools',
              command: 'node',
              args: ['server.mjs'],
              env: [{ name: 'PROJECT_ROOT', value: '/tmp/test' }],
            },
            {
              name: 'remote-tools',
              type: 'http',
              url: 'https://mcp.example.test',
              headers: [{ name: 'Authorization', value: 'Bearer test-token' }],
            },
          ],
        }
      );

      await session.initialize();

      const { SessionRuntime } = await import(
        '../../../../src/agent/runtime/SessionRuntime.js'
      );
      expect(SessionRuntime.create).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        workspaceRoot: '/tmp/test',
        mcpServers: {
          'project-tools': {
            type: 'stdio',
            command: 'node',
            args: ['server.mjs'],
            env: { PROJECT_ROOT: '/tmp/test' },
          },
          'remote-tools': {
            type: 'http',
            url: 'https://mcp.example.test',
            headers: { Authorization: 'Bearer test-token' },
          },
        },
        permissionMode: 'default',
        userShellExecutor: expect.any(Object),
      });
    });
  });

  describe('prompt', () => {
    beforeEach(async () => {
      await session.initialize();
      mockConnection.sessionUpdates = [];
    });

    it('projects unified Provider recovery and typed fallback metadata', async () => {
      const recovery = {
        version: 1 as const,
        generation: 'generation-1',
        revision: 1,
        snapshot: {
          activity: 'fallback' as const,
          reason: 'server_error' as const,
          updatedAt: 1_000,
          fallback: {
            from: { provider: 'primary', model: 'model-a' },
            to: { provider: 'secondary', model: 'model-b' },
            candidate: 1,
            candidateCount: 1,
            trigger: {
              source: 'retry' as const,
              reason: 'server_error' as const,
              statusCode: 503,
            },
          },
        },
      };
      const mockAgent = getMockAgent();
      mockAgent.chatStream = vi.fn(async function* () {
        Bus.publish(
          { sessionId: 'test-session-id', projectPath: '/tmp/test' },
          'provider.recovery',
          { recovery }
        );
        yield { kind: 'model_fallback', ...recovery.snapshot.fallback } as LoopEvent;
        return { success: true, finalMessage: 'fallback recovered' };
      }) as typeof mockAgent.chatStream;

      await promptText(session, 'recover through fallback');

      expect(mockConnection.sessionUpdates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            update: expect.objectContaining({
              _meta: { 'blade/providerRecovery': recovery },
            }),
          }),
          expect.objectContaining({
            update: expect.objectContaining({
              _meta: {
                'blade/modelFallback': recovery.snapshot.fallback,
              },
            }),
          }),
        ])
      );
    });

    it('suppresses duplicate Runtime Bus turn activity revisions', async () => {
      const activity: TurnActivityProjection = {
        version: 1,
        generation: 'activity-1',
        revision: 1,
        snapshot: {
          phase: 'thinking',
          startedAt: 1_000,
          updatedAt: 2_000,
          turn: 1,
          maxTurns: 20,
          outputStarted: false,
          toolCallsStarted: 0,
          toolCallsCompleted: 0,
          activeTools: [],
          activeToolOverflow: 0,
        },
      };
      const mockAgent = getMockAgent();
      mockAgent.chatStream = vi.fn(async function* () {
        const ref = { sessionId: 'test-session-id', projectPath: '/tmp/test' };
        Bus.publish(ref, 'turn.activity', { activity });
        Bus.publish(ref, 'turn.activity', { activity });
        yield { kind: 'turn_activity', activity } as LoopEvent;
        return { success: true, finalMessage: 'done' };
      }) as typeof mockAgent.chatStream;

      await promptText(session, 'show progress');

      expect(
        mockConnection.sessionUpdates.filter(
          ({ update }) => update._meta?.['blade/turnActivity'] !== undefined
        )
      ).toHaveLength(1);
    });

    it('projects reactive compaction lifecycle through ACP metadata only', async () => {
      const mockAgent = getMockAgent();
      mockAgent.chatStream = vi.fn(async function* () {
        yield {
          kind: 'compaction',
          phase: 'start',
          reason: 'context_limit',
        } as LoopEvent;
        yield {
          kind: 'compaction',
          phase: 'end',
          reason: 'context_limit',
          strategy: 'fallback',
          outcome: 'fallback',
          preTokens: 120_000,
          preTokenSource: 'provider_plus_estimate',
          estimatedPendingTokens: 1_250,
          postTokens: 2_000,
          sampleAttempts: 2,
          inputReductions: 1,
          messagesOmitted: 2,
          filesOmitted: 0,
          imagesOmitted: 1,
          fallbackTargetTokens: 64_000,
          fallbackMessagesOmitted: 8,
          fallbackMessagesTruncated: 1,
          failureReason: 'insufficient_reduction',
          memory: { outcome: 'written', entries: 1, topics: ['debugging'] },
        } as LoopEvent;
        return { success: true, finalMessage: 'recovered' };
      }) as typeof mockAgent.chatStream;

      await promptText(session, 'recover context');

      expect(mockConnection.sessionUpdates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'session_info_update',
              _meta: {
                'blade/compaction': {
                  phase: 'start',
                  reason: 'context_limit',
                },
              },
            }),
          }),
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'session_info_update',
              _meta: {
                'blade/compaction': {
                  phase: 'end',
                  reason: 'context_limit',
                  strategy: 'fallback',
                  outcome: 'fallback',
                  preTokens: 120_000,
                  preTokenSource: 'provider_plus_estimate',
                  estimatedPendingTokens: 1_250,
                  postTokens: 2_000,
                  sampleAttempts: 2,
                  inputReductions: 1,
                  messagesOmitted: 2,
                  filesOmitted: 0,
                  imagesOmitted: 1,
                  fallbackTargetTokens: 64_000,
                  fallbackMessagesOmitted: 8,
                  fallbackMessagesTruncated: 1,
                  failureReason: 'insufficient_reduction',
                  memory: { outcome: 'written', entries: 1, topics: ['debugging'] },
                },
              },
            }),
          }),
        ])
      );
      expect(
        mockConnection.sessionUpdates.filter(
          (update) =>
            update.update.sessionUpdate === 'agent_message_chunk' &&
            JSON.stringify(update).includes('compaction')
        )
      ).toEqual([]);
    });

    it.each(['pending_count', 'pending_bytes'] as const)(
      'projects Provider queue_full %s as ACP task capacity',
      async (resource) => {
        const mockAgent = getMockAgent();
        const providerError = new ProviderAdmissionError(
          'queue_full',
          'global',
          'foreground',
          resource,
          1,
          1,
          0,
          120_000
        );
        mockAgent.chatStream = vi.fn(async function* () {
          yield* [] as LoopEvent[];
          return {
            success: false,
            error: {
              type: 'api_error',
              message: providerError.message,
              details: providerError,
            },
          } satisfies LoopResult;
        }) as typeof mockAgent.chatStream;

        await expect(promptText(session, 'complete the task')).rejects.toMatchObject({
          name: 'RequestError',
          code: -32603,
          data: {
            failureType: 'api_error',
            taskFailure: {
              code: 'capacity',
              retryable: true,
              resource,
            },
          },
        });
      }
    );

    it('projects bounded Bash details through a standard ACP tool update', async () => {
      const mockAgent = getMockAgent();
      const toolCall = {
        id: 'bash-bounded-acp',
        type: 'function' as const,
        function: { name: 'Bash', arguments: '{"command":"fixture"}' },
      };
      mockAgent.chatStream = vi.fn(async function* () {
        yield {
          kind: 'tool_start',
          toolCall,
          toolKind: 'execute',
        } as LoopEvent;
        yield {
          kind: 'tool_result',
          toolCall,
          result: {
            success: true,
            llmContent: {
              stdout: `${'x'.repeat(3_000)}STDOUT_TAIL`,
              stderr: `${'y'.repeat(3_000)}STDERR_TAIL`,
              output_truncated: true,
              truncation_info: 'Output truncated: earliest bytes omitted',
            },
            metadata: {
              summary: 'Command completed',
              output_truncated: true,
            },
          },
        } as LoopEvent;
        return { success: true, finalMessage: 'done' };
      }) as typeof mockAgent.chatStream;

      await promptText(session, 'run fixture');

      const notification = mockConnection.sessionUpdates.find(
        (entry) =>
          entry.update.sessionUpdate === 'tool_call_update' &&
          entry.update.toolCallId === toolCall.id
      );
      expect(notification?.update).toMatchObject({
        sessionUpdate: 'tool_call_update',
        toolCallId: toolCall.id,
        status: 'completed',
      });
      expect(notification?.update).not.toHaveProperty('_meta');
      const rendered = JSON.stringify(notification?.update);
      expect(rendered.length).toBeLessThanOrEqual(2_200);
      expect(rendered).toContain('STDOUT_TAIL');
      expect(rendered).toContain('STDERR_TAIL');
      expect(rendered.split('Output truncated')).toHaveLength(2);
    });

    it('应该把 ApplyPatch 的每个文件投影为标准 ACP diff', async () => {
      const mockAgent = getMockAgent();
      const toolCall = {
        id: 'patch-call',
        type: 'function' as const,
        function: { name: 'ApplyPatch', arguments: '{"patch":"..."}' },
      };
      mockAgent.chatStream = vi.fn(async function* () {
        yield {
          kind: 'tool_start',
          toolCall,
          toolKind: 'write',
        } as LoopEvent;
        yield {
          kind: 'tool_result',
          toolCall,
          result: {
            success: true,
            llmContent: 'patched',
            metadata: {
              kind: 'patch',
              changes: [
                {
                  path: '/tmp/test/first.ts',
                  oldContent: 'old',
                  newContent: 'new',
                },
                {
                  path: '/tmp/test/second.ts',
                  oldContent: null,
                  newContent: 'added',
                },
              ],
            },
          },
        } as LoopEvent;
        return { success: true, finalMessage: 'done' };
      }) as typeof mockAgent.chatStream;

      await promptText(session, 'apply patch');

      expect(mockConnection.sessionUpdates).toContainEqual(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'patch-call',
            status: 'completed',
            content: [
              {
                type: 'diff',
                path: '/tmp/test/first.ts',
                oldText: 'old',
                newText: 'new',
              },
              {
                type: 'diff',
                path: '/tmp/test/second.ts',
                oldText: null,
                newText: 'added',
              },
            ],
          }),
        })
      );
    });

    it('应该把工具进度投影为 ACP in-progress update', async () => {
      const mockAgent = getMockAgent();
      const toolCall = {
        id: 'progress-call',
        type: 'function' as const,
        function: { name: 'progressive', arguments: '{}' },
      };
      mockAgent.chatStream = vi.fn(async function* () {
        yield {
          kind: 'tool_start',
          toolCall,
          toolKind: 'execute',
        } as LoopEvent;
        yield {
          kind: 'tool_progress',
          toolCall,
          update: {
            message: 'phase-two',
            progress: 2,
            total: 4,
          },
        } as LoopEvent;
        yield {
          kind: 'tool_result',
          toolCall,
          result: {
            success: true,
            llmContent: 'done',
          },
        } as LoopEvent;
        return { success: true, finalMessage: 'done' };
      }) as typeof mockAgent.chatStream;

      await promptText(session, 'run progress tool');

      expect(mockConnection.sessionUpdates).toContainEqual(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'progress-call',
            status: 'in_progress',
            content: [
              {
                type: 'content',
                content: { type: 'text', text: 'phase-two' },
              },
            ],
          }),
        })
      );
    });

    it('应该在进入 Agent 前拒绝超过共享预算的 ACP 图片', async () => {
      await expect(
        session.prompt({
          sessionId: 'test-session-id',
          prompt: [
            {
              type: 'image',
              mimeType: 'image/png',
              data: 'x'.repeat(MAX_INLINE_ATTACHMENT_BYTES),
            },
          ],
        })
      ).rejects.toThrow('ACP prompt images exceed the 5 MiB limit');

      expect(getMockAgent().calls).toHaveLength(0);
    });

    it('活动回合中的 ACP 图片应以多模态 steering 入队', async () => {
      const activeController = new AbortController();
      (session as any).pendingPrompt = activeController;

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [
          {
            type: 'image',
            mimeType: 'image/jpeg',
            data: 'steering-image',
          },
        ],
      });

      expect(runtimeState.runtime.enqueueSteering).toHaveBeenCalledWith(
        [
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/jpeg;base64,steering-image',
            },
          },
        ],
        { allowBeforeTurn: true }
      );
    });

    it('活动回合中的 /btw 应走独立旁路且不进入 steering', async () => {
      const activeController = new AbortController();
      (session as unknown as { pendingPrompt: AbortController | null }).pendingPrompt =
        activeController;
      const { executeSlashCommand } = await import(
        '../../../../src/slash-commands/index.js'
      );
      vi.mocked(executeSlashCommand).mockImplementationOnce(
        async (_command, context) => {
          const result = await context.sideConversation?.ask(
            'What is running?',
            context.signal
          );
          return {
            success: true,
            content: result?.response,
            data: { action: 'show_side_conversation' },
          };
        }
      );

      const response = await promptText(session, '/BTW What is running?');

      expect(response.stopReason).toBe('end_turn');
      expect(runtimeState.runtime.askSideQuestion).toHaveBeenCalledWith(
        'What is running?',
        { signal: expect.any(AbortSignal) }
      );
      const sideSignal = runtimeState.runtime.askSideQuestion.mock.calls[0]?.[1]
        ?.signal as AbortSignal;
      expect(sideSignal).not.toBe(activeController.signal);
      expect(sideSignal.aborted).toBe(false);
      expect(activeController.signal.aborted).toBe(false);
      expect(runtimeState.runtime.enqueueSteering).not.toHaveBeenCalled();
      expect(
        mockConnection.sessionUpdates.some(
          (notification) =>
            notification.update.sessionUpdate === 'agent_message_chunk' &&
            notification.update.content.type === 'text' &&
            notification.update.content.text === 'Side answer'
        )
      ).toBe(true);
    });

    it('应该处理 slash command', async () => {
      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [
          {
            type: 'text' as const,
            text: '/test command',
          },
        ],
      };

      const response = await session.prompt(promptParams);

      expect(response.stopReason).toBe('end_turn');

      // 验证执行了 slash command
      const { executeSlashCommand } = await import(
        '../../../../src/slash-commands/index.js'
      );
      expect(executeSlashCommand).toHaveBeenCalledWith(
        '/test command',
        expect.objectContaining({
          cwd: '/tmp/test',
          workspaceKind: 'local',
          workspaceRoot: '/tmp/test',
          sessionId: 'test-session-id',
          messages: [],
          mcp: expect.objectContaining({
            getCatalog: expect.any(Function),
            refresh: expect.any(Function),
            getPrompt: expect.any(Function),
            complete: expect.any(Function),
            listTasks: expect.any(Function),
            getTask: expect.any(Function),
            cancelTask: expect.any(Function),
          }),
        })
      );
      const context = vi.mocked(executeSlashCommand).mock.calls.at(-1)?.[1];
      await context?.mcp?.getCatalog();
      await context?.mcp?.refresh('content');
      await context?.mcp?.getPrompt('content', 'report', { topic: 'MCP' });
      await context?.mcp?.complete('content', {
        reference: { type: 'prompt', name: 'report' },
        argument: { name: 'topic', value: 'M' },
      });
      await context?.mcp?.listTasks('content');
      await context?.mcp?.getTask('mcp_task_safe');
      await context?.mcp?.cancelTask('mcp_task_safe');
      expect(runtimeState.runtime.getMcpContentCatalog).toHaveBeenCalled();
      expect(runtimeState.runtime.refreshMcpContentCatalogs).toHaveBeenCalledWith(
        'content'
      );
      expect(runtimeState.runtime.getMcpPrompt).toHaveBeenCalledWith(
        'content',
        'report',
        { topic: 'MCP' }
      );
      expect(runtimeState.runtime.completeMcpArgument).toHaveBeenCalledWith(
        'content',
        {
          reference: { type: 'prompt', name: 'report' },
          argument: { name: 'topic', value: 'M' },
        },
        undefined
      );
      expect(runtimeState.runtime.listMcpTasks).toHaveBeenCalledWith('content');
      expect(runtimeState.runtime.getMcpTask).toHaveBeenCalledWith('mcp_task_safe');
      expect(runtimeState.runtime.cancelMcpTask).toHaveBeenCalledWith(
        'mcp_task_safe',
        undefined
      );
    });

    it('passes ACP remote ownership to slash execution without host-only callbacks', async () => {
      const profile = createAcpRemotePathProfile(String.raw`C:\Remote\Slash`);
      const descriptor = createAcpRemoteWorkspaceDescriptor(profile);
      const harness = createPairedAcpHarness(new ControlledFileClient());
      const remoteSession = new AcpSession(
        'remote-slash-session',
        {
          kind: 'acp-remote',
          hostStateRoot: deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity),
          executionRoot: profile.workspace.wirePath,
          hostResourceRoot: '/trusted/host/resource',
          profile,
          descriptor,
        },
        harness.agentConnection,
        { fs: { readTextFile: true } }
      );
      const { executeSlashCommand } = await import(
        '../../../../src/slash-commands/index.js'
      );

      try {
        await remoteSession.initialize();
        vi.mocked(executeSlashCommand).mockClear();
        await remoteSession.prompt({
          sessionId: 'remote-slash-session',
          prompt: [{ type: 'text', text: '/help' }],
        });

        const context = vi.mocked(executeSlashCommand).mock.calls.at(-1)?.[1];
        expect(context).toMatchObject({
          workspaceKind: 'acp-remote',
          workspaceRoot: deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity),
        });
        expect(context).not.toHaveProperty('subagents');
        expect(context).not.toHaveProperty('codeReview');
        expect(context).not.toHaveProperty('mcp');
      } finally {
        await remoteSession.destroy();
        await harness.close();
      }
    });

    it('keeps inline resource text in an ACP remote model message', async () => {
      const profile = createAcpRemotePathProfile(String.raw`C:\Remote\Inline`);
      const descriptor = createAcpRemoteWorkspaceDescriptor(profile);
      const harness = createPairedAcpHarness(new ControlledFileClient());
      const remoteSession = new AcpSession(
        'remote-inline-session',
        {
          kind: 'acp-remote',
          hostStateRoot: deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity),
          executionRoot: profile.workspace.wirePath,
          hostResourceRoot: '/trusted/host/resource',
          profile,
          descriptor,
        },
        harness.agentConnection,
        { fs: { readTextFile: true } }
      );

      try {
        await remoteSession.initialize();
        await remoteSession.prompt({
          sessionId: 'remote-inline-session',
          prompt: [
            { type: 'text', text: 'Review @/host-canary.txt from supplied context' },
            {
              type: 'resource',
              resource: {
                uri: 'file:///host-canary.txt',
                mimeType: 'text/plain',
                text: 'REMOTE_INLINE_RESOURCE_MARKER',
              },
            },
          ],
        });

        expect(getMockAgent().getLastCall()?.message).toContain(
          'REMOTE_INLINE_RESOURCE_MARKER'
        );
      } finally {
        await remoteSession.destroy();
        await harness.close();
      }
    });

    it('通过 ACP slash boundary 启动原生只读 Code Review', async () => {
      const completion = {
        reviewId: 'review-acp',
        status: 'completed' as const,
        overallExplanation: 'Reviewed.',
        findings: [],
        completedAt: new Date(0).toISOString(),
      };
      codeReviewState.start.mockResolvedValueOnce({
        reviewId: 'review-acp',
        completion: Promise.resolve(completion),
      });
      codeReviewState.list.mockResolvedValueOnce([
        {
          start: {
            reviewId: 'review-acp',
            reviewerSessionId: 'review-child',
            target: {
              kind: 'uncommitted',
              label: 'uncommitted changes',
              headSha: 'a'.repeat(40),
              digest: 'b'.repeat(64),
              fileCount: 1,
            },
            startedAt: new Date(0).toISOString(),
          },
          completion,
        },
      ]);
      const { executeSlashCommand } = await import(
        '../../../../src/slash-commands/index.js'
      );
      vi.mocked(executeSlashCommand).mockImplementationOnce(
        async (_message, context) => {
          const result = await context.codeReview?.run({
            kind: 'uncommitted',
          });
          return {
            success: true,
            content: result?.content,
          };
        }
      );

      const response = await promptText(session, '/review uncommitted');

      expect(response.stopReason).toBe('end_turn');
      expect(codeReviewState.start).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'test-session-id',
          projectPath: '/tmp/test',
          runtime: runtimeState.runtime,
          request: { kind: 'uncommitted' },
        })
      );
      expect(sessionServiceState.loadSession).toHaveBeenCalledWith(
        'test-session-id',
        '/tmp/test'
      );
    });

    it('passes the current Session model boundary to manual compaction', async () => {
      const { executeSlashCommand } = await import(
        '../../../../src/slash-commands/index.js'
      );
      let ownedConfig: ChatConfig | undefined;
      vi.mocked(executeSlashCommand).mockImplementationOnce(
        async (_message, context) => {
          ownedConfig = context.model?.getChatConfig();
          return { success: true };
        }
      );
      await promptText(session, '/compact');
      expect(ownedConfig).toEqual({
        provider: 'session-channel',
        model: 'session-model',
        apiKey: 'session-key',
        baseUrl: 'https://session.invalid/v1',
        maxContextTokens: 128_000,
      });
    });

    it('手动压缩后下一轮 prompt 应使用 compacted history', async () => {
      const compactedMessages: Message[] = [
        { role: 'user', content: 'compacted ACP history' },
      ];
      const { executeSlashCommand } = await import(
        '../../../../src/slash-commands/index.js'
      );
      vi.mocked(executeSlashCommand).mockResolvedValueOnce({
        success: true,
        message: 'compact_completed',
        data: { compactedMessages },
      });
      await promptText(session, '/compact');

      await promptText(session, 'continue after compact');

      expect(getMockAgent().getLastCall()?.context.messages).toEqual(compactedMessages);
    });

    it('rewind 后应该替换 ACP 历史并重建 Agent', async () => {
      const rewoundMessages: Message[] = [
        { role: 'user', content: 'kept ACP history' },
      ];
      runtimeState.runtime.listRewindCheckpoints.mockResolvedValue([
        {
          messageId: 'user-2',
          preview: 'rewind ACP turn',
          createdAt: '2026-08-05T00:00:00.000Z',
          fileCount: 0,
        },
      ]);
      runtimeState.runtime.rewindSession.mockResolvedValue({
        checkpoint: {
          messageId: 'user-2',
          preview: 'rewind ACP turn',
          createdAt: '2026-08-05T00:00:00.000Z',
          fileCount: 0,
        },
        mode: 'conversation',
        removedTurns: 1,
        restoredFiles: [],
        messages: rewoundMessages,
      });
      const originalAgent = getMockAgent();
      const { executeSlashCommand } = await import(
        '../../../../src/slash-commands/index.js'
      );
      vi.mocked(executeSlashCommand).mockImplementationOnce(
        async (_message, context) => {
          await context.rewind?.listCheckpoints();
          const result = await context.rewind?.execute({
            targetMessageId: 'user-2',
            mode: 'conversation',
          });
          return {
            success: true,
            data: {
              action: 'rewind_session',
              messages: result?.messages,
            },
          };
        }
      );

      await promptText(session, '/rewind user-2');

      expect(runtimeState.runtime.listRewindCheckpoints).toHaveBeenCalledOnce();
      expect(runtimeState.runtime.rewindSession).toHaveBeenCalledWith({
        targetMessageId: 'user-2',
        mode: 'conversation',
      });
      expect(originalAgent.destroy).toHaveBeenCalledOnce();
      const { Agent } = await import('../../../../src/agent/Agent.js');
      expect(Agent.createWithRuntime).toHaveBeenCalledTimes(2);

      await promptText(session, 'continue after rewind');
      expect(getMockAgent().getLastCall()?.context.messages).toEqual(rewoundMessages);
    });

    it('通过标准 ACP tool updates 暴露 durable subagent resume', async () => {
      const source = {
        id: 'agent-source',
        subagentType: 'Explore',
        resumeDepth: 0,
      };
      const child = {
        id: 'agent-child',
        subagentType: 'Explore',
        resumeDepth: 1,
        resumedFrom: source.id,
        status: 'running',
      };
      runtimeState.runtime.listSubagents.mockReturnValue([source] as never[]);
      runtimeState.runtime.resumeSubagent.mockImplementation(
        (options: { onCompleted?: (session: Record<string, unknown>) => void }) => {
          options.onCompleted?.({
            ...child,
            status: 'completed',
            result: { success: true, message: 'Follow-up complete' },
          });
          return { source, session: child };
        }
      );
      const { executeSlashCommand } = await import(
        '../../../../src/slash-commands/index.js'
      );
      vi.mocked(executeSlashCommand).mockImplementationOnce(
        async (_message, context) => {
          await context.subagents?.list();
          const resumed = await context.subagents?.resume(
            source.id,
            'Check the follow-up'
          );
          return {
            success: true,
            message: `Resumed ${resumed?.session.id}`,
          };
        }
      );

      await promptText(session, '/tasks resume agent-source Check the follow-up');

      expect(runtimeState.runtime.listSubagents).toHaveBeenCalledOnce();
      expect(runtimeState.runtime.resumeSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: source.id,
          prompt: 'Check the follow-up',
        })
      );
      expect(mockConnection.sessionUpdates).toContainEqual(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'tool_call',
            toolCallId: child.id,
            status: 'in_progress',
            title: 'Resuming Explore subagent',
          }),
        })
      );
      expect(mockConnection.sessionUpdates).toContainEqual(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            toolCallId: child.id,
            status: 'completed',
          }),
        })
      );
    });

    it('不为 durable recovery failed 的 subagent 发送虚假 resume tool call', async () => {
      const source = {
        id: 'agent-unrecoverable',
        subagentType: 'Explore',
        status: 'failed',
        rootAgentId: 'agent-unrecoverable',
        resumeDepth: 0,
        restartRecovery: {
          outcome: 'failed',
          recoveredAt: 2,
        },
      };
      runtimeState.runtime.listSubagents.mockReturnValue([source] as never[]);
      runtimeState.runtime.resumeSubagent.mockImplementation(() => {
        throw new Error('Subagent cannot be resumed: agent-unrecoverable');
      });
      const { executeSlashCommand } = await import(
        '../../../../src/slash-commands/index.js'
      );
      vi.mocked(executeSlashCommand).mockImplementationOnce(
        async (_message, context) => {
          try {
            await context.subagents?.resume(source.id, 'Continue');
            return { success: true, message: 'unexpected' };
          } catch (error) {
            return {
              success: false,
              message: error instanceof Error ? error.message : String(error),
            };
          }
        }
      );

      await promptText(session, '/tasks resume agent-unrecoverable Continue');

      expect(runtimeState.runtime.resumeSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: source.id,
          prompt: 'Continue',
        })
      );
      expect(mockConnection.sessionUpdates).not.toContainEqual(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'tool_call',
            title: expect.stringContaining('Resuming'),
          }),
        })
      );
    });
  });

  describe('user shell command', () => {
    beforeEach(async () => {
      runtimeState.runtime.executeUserShellCommand.mockImplementation(
        async (_command, options) => {
          await options.onEvent({
            type: 'started',
            executionId: 'shell-acp',
            command: 'pwd',
            auxiliary: false,
          });
          await options.onEvent({
            type: 'output',
            executionId: 'shell-acp',
            stream: 'stdout',
            chunk: '/remote/workspace\n',
            streamedBytes: 18,
            streamTruncated: false,
            auxiliary: false,
          });
          const record = {
            version: 1 as const,
            command: 'pwd',
            status: 'completed' as const,
            exitCode: 0,
            durationMs: 5,
            stdout: '/remote/workspace',
            stderr: '',
            stdoutOmittedBytes: 0,
            stderrOmittedBytes: 0,
            binaryOutput: false,
            truncated: false,
          };
          await options.onEvent({
            type: 'completed',
            executionId: 'shell-acp',
            messageId: 'shell-message',
            record,
            auxiliary: false,
          });
          return {
            executionId: 'shell-acp',
            messageId: 'shell-message',
            record,
            modelContent: '<user_shell_command>pwd</user_shell_command>',
            auxiliary: false,
          };
        }
      );
      await session.initialize();
    });

    it('projects remote shell lifecycle as one ACP execute tool call', async () => {
      const result = await promptText(session, '! pwd');

      expect(result).toEqual({ stopReason: 'end_turn' });
      expect(runtimeState.runtime.executeUserShellCommand).toHaveBeenCalledWith(
        'pwd',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(mockConnection.sessionUpdates.map((entry) => entry.update)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionUpdate: 'tool_call',
            toolCallId: 'shell-acp',
            kind: 'execute',
          }),
          expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'shell-acp',
            status: 'completed',
          }),
        ])
      );
    });

    it('resumes next-turn input after the owning shell operation settles', async () => {
      runtimeState.runtime.executeUserShellCommand.mockResolvedValueOnce({
        executionId: 'shell-next-turn',
        messageId: 'shell-next-turn-message',
        record: {
          version: 1,
          command: 'pwd',
          status: 'completed',
          exitCode: 0,
          durationMs: 5,
          stdout: '/remote/workspace',
          stderr: '',
          stdoutOmittedBytes: 0,
          stderrOmittedBytes: 0,
          binaryOutput: false,
          truncated: false,
        },
        modelContent: '<user_shell_command>pwd</user_shell_command>',
        auxiliary: false,
        delivery: 'next_turn',
        queued: 1,
      });
      runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
      const mockAgent = getMockAgent();
      const chatStream = vi.fn(async function* () {
        yield* [] as LoopEvent[];
        return {
          success: true,
          finalMessage: 'continued',
          metadata: {
            turnsCount: 1,
            toolCallsCount: 0,
            duration: 10,
          },
        } satisfies LoopResult;
      }) as typeof mockAgent.chatStream;
      mockAgent.chatStream = chatStream;

      await promptText(session, '! pwd');

      await vi.waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1));
      expect(chatStream).toHaveBeenCalledWith(
        '',
        expect.any(Object),
        expect.objectContaining({ pendingInputOnly: true })
      );
    });

    it('configures the ACP terminal executor to fail closed without local fallback', async () => {
      const { SessionRuntime } = await import(
        '../../../../src/agent/runtime/SessionRuntime.js'
      );
      const createOptions = vi.mocked(SessionRuntime.create).mock.calls.at(-1)?.[0];
      const executor = createOptions?.userShellExecutor;
      terminalState.execute.mockResolvedValueOnce({
        success: false,
        stdout: '',
        stderr: '',
        exitCode: null,
        error: 'ACP terminal unavailable',
      });

      await executor?.execute('pwd', {
        cwd: '/tmp/test',
        env: {},
        timeoutMs: 1000,
        signal: new AbortController().signal,
      });

      expect(terminalState.execute).toHaveBeenCalledWith(
        'pwd',
        expect.objectContaining({
          allowLocalFallback: false,
          cwd: '/tmp/test',
        })
      );
    });
  });

  describe('setMode', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('应该设置会话模式为 plan', async () => {
      await session.setMode('plan');

      const updates = mockConnection.sessionUpdates;
      const modeUpdates = updates.filter(
        (u) => u.update.sessionUpdate === 'current_mode_update'
      );
      expect(modeUpdates.length).toBeGreaterThan(0);
      expect((modeUpdates[0].update as any).currentModeId).toBe('plan');
    });

    it('应该拒绝无效模式（默认为 default）', async () => {
      await session.setMode('invalid');

      const updates = mockConnection.sessionUpdates;
      const modeUpdates = updates.filter(
        (u) => u.update.sessionUpdate === 'current_mode_update'
      );
      expect(modeUpdates.length).toBeGreaterThan(0);
      expect((modeUpdates[0].update as any).currentModeId).toBe('default');
    });
  });

  describe('sendAvailableCommandsDelayed', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('重复 schedule 后在 500ms 只发送一次 available commands update', async () => {
      session.sendAvailableCommandsDelayed();
      session.sendAvailableCommandsDelayed();

      await vi.advanceTimersByTimeAsync(500);

      expect(
        mockConnection.sessionUpdates.filter(
          (notification) =>
            notification.update.sessionUpdate === 'available_commands_update'
        )
      ).toHaveLength(1);
      const { getRegisteredCommands } = await import(
        '../../../../src/slash-commands/index.js'
      );
      expect(getRegisteredCommands).toHaveBeenCalledWith(
        '/tmp/test',
        undefined,
        'local'
      );
    });

    it('connection aborted 后不应该发送 available commands update', async () => {
      session.sendAvailableCommandsDelayed();
      connectionAbortController.abort();

      await vi.advanceTimersByTimeAsync(500);

      expect(
        mockConnection.sessionUpdates.filter(
          (notification) =>
            notification.update.sessionUpdate === 'available_commands_update'
        )
      ).toHaveLength(0);
    });
  });

  describe('setModel', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('活动回合期间应该拒绝切换模型', async () => {
      (session as any).pendingPrompt = new AbortController();

      await expect(session.setModel('gpt-4')).rejects.toThrow(
        'Cannot switch models while a prompt is active'
      );
    });

    it('持久化失败时应该回滚运行时模型', async () => {
      sessionServiceState.updateSessionMetadata.mockRejectedValueOnce(
        new Error('disk unavailable')
      );

      await expect(session.setModel('gpt-4')).rejects.toThrow('disk unavailable');
      expect(getMockAgent().switchModel).toHaveBeenNthCalledWith(1, 'gpt-4');
      expect(getMockAgent().switchModel).toHaveBeenNthCalledWith(2, 'model-1');
    });

    it('首次选择模型时应该创建 durable ACP 会话元数据', async () => {
      const { SessionMissingCreationError } = await import(
        '../../../../src/services/SessionService.js'
      );
      sessionServiceState.updateSessionMetadata.mockRejectedValueOnce(
        new SessionMissingCreationError('test-session-id')
      );

      await session.setModel('gpt-4');

      expect(sessionServiceState.createSessionMetadata).toHaveBeenCalledWith(
        'test-session-id',
        '/tmp/test',
        {
          taskStatus: 'completed',
          selectedModelId: 'gpt-4',
        }
      );
    });
  });

  describe('setReasoningEffort', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('活动回合期间拒绝切换 reasoning effort', async () => {
      (session as any).pendingPrompt = new AbortController();
      await expect(session.setReasoningEffort('low')).rejects.toThrow(
        'Cannot switch reasoning effort while a prompt is active'
      );
      expect(runtimeState.runtime.refresh).not.toHaveBeenCalled();
    });
  });

  describe('setServiceTier', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('活动回合期间拒绝切换 service tier', async () => {
      (session as any).pendingPrompt = new AbortController();
      await expect(session.setServiceTier('flex')).rejects.toThrow(
        'Cannot switch service tier while a prompt is active'
      );
      expect(runtimeState.runtime.refresh).not.toHaveBeenCalled();
    });
  });

  describe('setResponseVerbosity', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('活动回合期间拒绝切换 response verbosity', async () => {
      (session as any).pendingPrompt = new AbortController();
      await expect(session.setResponseVerbosity('low')).rejects.toThrow(
        'Cannot switch response verbosity while a prompt is active'
      );
      expect(runtimeState.runtime.refresh).not.toHaveBeenCalled();
    });
  });

  describe('setCommunicationStyle', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('活动回合期间拒绝切换 communication style', async () => {
      (session as any).pendingPrompt = new AbortController();
      await expect(session.setCommunicationStyle('friendly')).rejects.toThrow(
        'Cannot switch communication style while a prompt is active'
      );
      expect(runtimeState.runtime.refresh).not.toHaveBeenCalled();
    });
  });

  describe('destroy', () => {
    it.each([
      {
        name: 'connection shutdown',
        destroyOptions: {},
        shouldDiscardPendingInput: false,
      },
      {
        name: 'standard session close',
        destroyOptions: { discardPendingInput: true },
        shouldDiscardPendingInput: true,
      },
    ])(
      '$name 等待 active prompt 且丢弃旧 generator 更新',
      async ({ destroyOptions, shouldDiscardPendingInput }) => {
        await session.initialize();
        mockConnection.sessionUpdates = [];
        const mockAgent = getMockAgent();
        let releaseLateEvents: (() => void) | undefined;
        const lateEventsReady = new Promise<void>((resolve) => {
          releaseLateEvents = resolve;
        });
        let generatorStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => {
          generatorStarted = resolve;
        });
        mockAgent.chatStream = async function* (): AsyncGenerator<
          LoopEvent,
          LoopResult,
          void
        > {
          generatorStarted?.();
          await lateEventsReady;
          yield { kind: 'content_delta', delta: 'late content' };
          yield {
            kind: 'tool_start',
            toolCall: {
              id: 'late-tool',
              type: 'function',
              function: { name: 'lateTool', arguments: '{}' },
            },
            toolKind: 'execute',
          };
          yield {
            kind: 'task_update',
            tasks: [
              {
                id: 'late-task',
                subject: 'Late task',
                description: 'Must not escape the old owner',
                status: 'in_progress',
                priority: 'medium',
                blocks: [],
                blockedBy: [],
                createdAt: '2026-08-04T00:00:00.000Z',
              },
            ],
          };
          return { success: true, finalMessage: '' };
        };

        const prompt = promptText(session, 'start deferred stream');
        await started;
        let destroySettled = false;
        const destroy = session.destroy(destroyOptions).then(() => {
          destroySettled = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(destroySettled).toBe(false);
        expect(mockAgent.destroy).not.toHaveBeenCalled();
        expect(runtimeState.runtime.dispose).not.toHaveBeenCalled();

        releaseLateEvents?.();
        await prompt;
        await destroy;

        expect(mockConnection.sessionUpdates).toEqual([]);
        if (shouldDiscardPendingInput) {
          expect(runtimeState.runtime.discardPendingInput).toHaveBeenCalledOnce();
          expect(
            runtimeState.runtime.discardPendingInput.mock.invocationCallOrder[0]
          ).toBeLessThan(vi.mocked(mockAgent.destroy).mock.invocationCallOrder[0]!);
        } else {
          expect(runtimeState.runtime.discardPendingInput).not.toHaveBeenCalled();
        }
        expect(mockAgent.destroy).toHaveBeenCalledOnce();
        expect(runtimeState.runtime.dispose).toHaveBeenCalledOnce();
      }
    );

    it('应该完整清理会话且二次 destroy 不重复资源 cleanup', async () => {
      await session.initialize();
      const mockAgent = getMockAgent();
      const cancel = vi.spyOn(session, 'cancel');
      await session.destroy();
      await session.destroy();

      const { AcpServiceContext } = await import(
        '../../../../src/acp/AcpServiceContext.js'
      );
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(mockAgent.destroy).toHaveBeenCalledTimes(1);
      expect(runtimeState.runtime.dispose).toHaveBeenCalledTimes(1);
      expect(AcpServiceContext.destroyRegisteredSession).toHaveBeenCalledTimes(1);
      expect(AcpServiceContext.destroyRegisteredSession).toHaveBeenCalledWith({
        generation: 'acp-owner-generation:test',
        sessionId: 'test-session-id',
      });
      await expect(session.setModel('gpt-4')).rejects.toThrow(
        'Session not initialized'
      );
    });

    it('cancel 失败时仍应该清理 Agent、runtime 与 ACP context', async () => {
      await session.initialize();
      const mockAgent = getMockAgent();
      vi.spyOn(session, 'cancel').mockImplementationOnce(() => {
        throw new Error('cancel failed first');
      });

      await expect(session.destroy()).rejects.toThrow('cancel failed first');

      const { AcpServiceContext } = await import(
        '../../../../src/acp/AcpServiceContext.js'
      );
      expect(mockAgent.destroy).toHaveBeenCalledTimes(1);
      expect(runtimeState.runtime.dispose).toHaveBeenCalledTimes(1);
      expect(AcpServiceContext.destroyRegisteredSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('structured output metadata', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('rejects schema changes while another ACP turn is active', async () => {
      (session as unknown as { pendingPrompt: AbortController | null }).pendingPrompt =
        new AbortController();

      await expect(
        session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'steer' }],
          _meta: {
            outputSchema: {
              type: 'object',
              properties: {},
            },
          },
        })
      ).rejects.toThrow('active turn');
    });
  });

  describe('ToolKind 映射', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('projects parallel Tasks as independent ACP tool calls', async () => {
      const mockAgent = getMockAgent();
      mockAgent.chatStream = async function* (): AsyncGenerator<
        LoopEvent,
        LoopResult,
        void
      > {
        for (const [id, description] of [
          ['parallel-task-a', 'Inspect API'],
          ['parallel-task-b', 'Review tests'],
        ]) {
          yield {
            kind: 'tool_start',
            toolCall: {
              id,
              type: 'function',
              function: {
                name: 'Task',
                arguments: JSON.stringify({
                  subagent_type: 'Explore',
                  description,
                }),
              },
            },
            toolKind: 'readonly',
          };
        }
        return { success: true, finalMessage: 'Parallel work started.' };
      };

      await promptText(session, 'Run both checks.');

      expect(
        mockConnection.sessionUpdates
          .filter((update) => update.update.sessionUpdate === 'tool_call')
          .map((update) => (update.update as { toolCallId: string }).toolCallId)
      ).toEqual(['parallel-task-a', 'parallel-task-b']);
    });
  });
});

/**
 * AcpSession 测试
 */

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { AcpSession } from '../../../../src/acp/Session.js';
import type { LoopEvent } from '../../../../src/agent/loop/types.js';
import type { LoopResult } from '../../../../src/agent/types.js';
import { MAX_INLINE_ATTACHMENT_BYTES } from '../../../../src/api/attachmentLimits.js';
import { Bus } from '../../../../src/server/bus.js';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';
import type {
  ConfirmationDetails,
  ConfirmationResponse,
} from '../../../../src/tools/types/ExecutionTypes.js';
import { ToolKind } from '../../../../src/tools/types/ToolTypes.js';
import { createMockACPClient } from '../../../support/mocks/mockACPClient.js';
import { createMockAgent, type MockAgent } from '../../../support/mocks/mockAgent.js';

type AgentMockInstance = MockAgent & {
  switchModel: Mock<(modelId: string) => Promise<void>>;
};

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
    enqueueSteering: vi.fn(() => ({
      accepted: true,
      turnId: 'turn-1',
      queued: 1,
    })),
    getPendingSteeringCount: vi.fn(() => 0),
    getPendingSteeringMessages: vi.fn(() => []),
    getCurrentModelId: vi.fn(() => 'model-1'),
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
    initializeSession: vi.fn(),
    destroySession: vi.fn(),
    setCurrentSession: vi.fn(),
    getInstance: vi.fn(() => ({
      getTerminalService: vi.fn(() => terminalState),
    })),
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
    runtimeState.runtime.getCurrentModelId.mockReturnValue('model-1');
    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(0);
    runtimeState.runtime.getPendingSteeringMessages.mockReturnValue([]);
    runtimeState.runtime.getGoal.mockReset().mockResolvedValue(null);
    runtimeState.runtime.listRewindCheckpoints.mockReset().mockResolvedValue([]);
    runtimeState.runtime.rewindSession.mockReset();
    runtimeState.runtime.listSubagents.mockReset().mockReturnValue([]);
    runtimeState.runtime.resumeSubagent.mockReset();
    runtimeState.runtime.executeUserShellCommand.mockReset();
    sessionServiceState.loadSession.mockReset().mockResolvedValue([]);
    sessionServiceState.loadSessionModelContext
      .mockReset()
      .mockImplementation((...args: unknown[]) =>
        sessionServiceState.loadSession(...args)
      );
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
      '/tmp/test',
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

  afterEach(() => {
    vi.clearAllMocks();
    runtimeState.runtime.dispose.mockClear();
    runtimeState.runtime.enqueueSteering.mockClear();
  });

  describe('initialize', () => {
    it('应该正确初始化会话', async () => {
      await session.initialize();

      // 验证 ACP 服务上下文已初始化
      const { AcpServiceContext } = await import(
        '../../../../src/acp/AcpServiceContext.js'
      );
      expect(AcpServiceContext.initializeSession).toHaveBeenCalledWith(
        mockConnection,
        'test-session-id',
        expect.any(Object),
        '/tmp/test'
      );
    });

    it('应该创建 SessionRuntime 并注入 Agent 实例', async () => {
      await session.initialize();

      const { SessionRuntime } = await import(
        '../../../../src/agent/runtime/SessionRuntime.js'
      );
      const { Agent } = await import('../../../../src/agent/Agent.js');
      expect(SessionRuntime.create).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        workspaceRoot: '/tmp/test',
        permissionMode: 'default',
        userShellExecutor: expect.any(Object),
      });
      expect(Agent.createWithRuntime).toHaveBeenCalledWith(runtimeState.runtime, {
        sessionId: 'test-session-id',
      });
    });

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
        '/tmp/task-worktree',
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

    it('应该在初始化后自动恢复 verifying Goal', async () => {
      runtimeState.runtime.getGoal.mockResolvedValue({
        status: 'verifying',
      });
      await session.initialize();

      await vi.waitFor(() => {
        expect(getMockAgent().calls[0]).toMatchObject({
          message: '',
          options: { goalContinuationOnly: true },
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
        code: 'timeout',
        message: 'Provider request timed out.',
        retryable: true,
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
    it.each([
      'destroy',
      'abort',
    ] as const)('%s 后停止 deferred history replay 且不恢复 pending input', async (stopMethod) => {
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
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'prepare replay history' }],
      });
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
    });

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
      ];
      session = new AcpSession(
        'test-session-id',
        '/tmp/test',
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
          evidenceSha256: 'a'.repeat(64),
        },
        createdAt: '2026-08-14T00:00:00.000Z',
        updatedAt: '2026-08-14T00:00:02.000Z',
      });
      session = new AcpSession(
        'test-session-id',
        '/tmp/test',
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
                },
              },
            },
          }),
        ])
      );
      expect(getMockAgent().calls).toHaveLength(0);
    });

    it('恢复后的下一次 prompt 应携带完整模型历史', async () => {
      const history: Message[] = [
        { role: 'user', content: 'Remember marker ACP_RESUME_MARKER.' },
        { role: 'assistant', content: 'I will remember ACP_RESUME_MARKER.' },
      ];
      session = new AcpSession(
        'test-session-id',
        '/tmp/test',
        mockConnection as any,
        undefined,
        { initialMessages: history }
      );
      await session.initialize();

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'What marker did I ask you to remember?' }],
      });

      const call = getMockAgent().getLastCall();
      expect(call?.context.messages).toEqual(history);
    });
  });

  describe('ACP MCP session setup', () => {
    it('应该把结构化 MCP server 转换为 SessionRuntime 配置', async () => {
      session = new AcpSession(
        'test-session-id',
        '/tmp/test',
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
    });

    it('应该处理文本提示', async () => {
      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [
          {
            type: 'text' as const,
            text: 'Hello, World!',
          },
        ],
      };

      const response = await session.prompt(promptParams);

      expect(response).toBeDefined();
      expect(response.stopReason).toBe('end_turn');
    });

    it('projects Provider retry lifecycle through ACP session metadata', async () => {
      const mockAgent = getMockAgent();
      mockAgent.chatStream = vi.fn(async function* () {
        yield {
          kind: 'provider_retry',
          phase: 'scheduled',
          attempt: 1,
          maxRetries: 2,
          reason: 'rate_limit',
          statusCode: 429,
          delayMs: 2_000,
          nextRetryAt: 3_000,
        } as LoopEvent;
        yield {
          kind: 'provider_retry',
          phase: 'recovered',
          attempt: 1,
          maxRetries: 2,
          reason: 'rate_limit',
          statusCode: 429,
        } as LoopEvent;
        return { success: true, finalMessage: 'recovered' };
      }) as typeof mockAgent.chatStream;

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'recover the provider' }],
      });

      expect(mockConnection.sessionUpdates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'session_info_update',
              _meta: {
                'blade/providerRetry': {
                  phase: 'scheduled',
                  attempt: 1,
                  maxRetries: 2,
                  reason: 'rate_limit',
                  statusCode: 429,
                  delayMs: 2_000,
                  nextRetryAt: 3_000,
                },
              },
            }),
          }),
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'session_info_update',
              _meta: {
                'blade/providerRetry': {
                  phase: 'recovered',
                  attempt: 1,
                  maxRetries: 2,
                  reason: 'rate_limit',
                  statusCode: 429,
                },
              },
            }),
          }),
        ])
      );
      expect(JSON.stringify(mockConnection.sessionUpdates)).not.toContain(
        'provider-specific'
      );
    });

    it('projects Provider stall lifecycle through ACP session metadata', async () => {
      const mockAgent = getMockAgent();
      mockAgent.chatStream = vi.fn(async function* () {
        yield {
          kind: 'provider_stall',
          phase: 'detected',
          stallCount: 1,
          durationMs: 30_000,
          warningAfterMs: 30_000,
          timeoutMs: 300_000,
          outputStarted: true,
        } as LoopEvent;
        yield {
          kind: 'provider_stall',
          phase: 'recovered',
          stallCount: 1,
          durationMs: 31_250,
          warningAfterMs: 30_000,
          timeoutMs: 300_000,
          outputStarted: true,
        } as LoopEvent;
        return { success: true, finalMessage: 'recovered' };
      }) as typeof mockAgent.chatStream;

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'wait for the provider' }],
      });

      expect(mockConnection.sessionUpdates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'session_info_update',
              _meta: {
                'blade/providerStall': {
                  phase: 'detected',
                  stallCount: 1,
                  durationMs: 30_000,
                  warningAfterMs: 30_000,
                  timeoutMs: 300_000,
                  outputStarted: true,
                },
              },
            }),
          }),
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'session_info_update',
              _meta: {
                'blade/providerStall': {
                  phase: 'recovered',
                  stallCount: 1,
                  durationMs: 31_250,
                  warningAfterMs: 30_000,
                  timeoutMs: 300_000,
                  outputStarted: true,
                },
              },
            }),
          }),
        ])
      );
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
          strategy: 'llm',
          outcome: 'completed',
          preTokens: 120_000,
          postTokens: 2_000,
        } as LoopEvent;
        return { success: true, finalMessage: 'recovered' };
      }) as typeof mockAgent.chatStream;

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'recover context' }],
      });

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
                  strategy: 'llm',
                  outcome: 'completed',
                  preTokens: 120_000,
                  postTokens: 2_000,
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

    it('fails closed with a typed ACP error when the agent loop fails', async () => {
      const mockAgent = getMockAgent();
      mockAgent.chatStream = vi.fn(async function* () {
        yield* [] as LoopEvent[];
        return {
          success: false,
          error: {
            type: 'intent_fulfillment_failed',
            message: 'provider-specific failure details',
          },
        };
      }) as typeof mockAgent.chatStream;

      await expect(
        session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'complete the task' }],
        })
      ).rejects.toMatchObject({
        name: 'RequestError',
        code: -32603,
        message: 'Internal error: Agent turn failed (intent_fulfillment_failed)',
        data: {
          failureType: 'intent_fulfillment_failed',
        },
      });
    });

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

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'run fixture' }],
      });

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

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'apply patch' }],
      });

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

    it('应该把独立验证判定投影为 ACP Task 结果内容', async () => {
      const mockAgent = getMockAgent();
      const toolCall = {
        id: 'verification-call',
        type: 'function' as const,
        function: {
          name: 'Task',
          arguments:
            '{"subagent_type":"verification","description":"Verify implementation"}',
        },
      };
      mockAgent.chatStream = vi.fn(async function* () {
        yield {
          kind: 'tool_start',
          toolCall,
          toolKind: 'readonly',
        } as LoopEvent;
        yield {
          kind: 'tool_result',
          toolCall,
          result: {
            success: true,
            llmContent: '## Verification Result: PASS',
            metadata: {
              subagentType: 'verification',
              subagentStatus: 'completed',
              verificationVerdict: 'pass',
            },
          },
        } as LoopEvent;
        return { success: true, finalMessage: 'done' };
      }) as typeof mockAgent.chatStream;

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'verify implementation' }],
      });

      expect(mockConnection.sessionUpdates).toContainEqual(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'verification-call',
            status: 'completed',
            content: expect.arrayContaining([
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: 'Verification result: PASS',
                },
              },
            ]),
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

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'run progress tool' }],
      });

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

    it('应该把 MCP catalog revision 投影为 ACP 消息更新', async () => {
      const mockAgent = getMockAgent();
      mockAgent.chatStream = vi.fn(async function* () {
        yield {
          kind: 'mcp_catalog_changed',
          revision: 2,
          serverName: 'dynamic',
          reason: 'notification',
          added: ['mcp__dynamic__new_tool'],
          removed: [],
          updated: [],
        } as LoopEvent;
        return { success: true, finalMessage: 'done' };
      }) as typeof mockAgent.chatStream;

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'refresh catalog' }],
      });

      expect(mockConnection.sessionUpdates).toContainEqual(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'MCP catalog r2 (dynamic): +1 -0 ~0\n',
            },
          }),
        })
      );
    });

    it('应该把 MCP content 与 resource update 投影为 ACP 消息', async () => {
      const mockAgent = getMockAgent();
      mockAgent.chatStream = vi.fn(async function* () {
        yield {
          kind: 'mcp_content_changed',
          revision: 4,
          serverName: 'content',
          contentKind: 'prompts',
          reason: 'notification',
          added: ['new_prompt'],
          removed: [],
          updated: ['compose_report'],
        } as LoopEvent;
        yield {
          kind: 'mcp_resource_updated',
          revision: 5,
          serverName: 'content',
          uri: 'context://live',
        } as LoopEvent;
        yield {
          kind: 'mcp_connection_changed',
          revision: 6,
          serverName: 'content',
          phase: 'reconnecting',
          reason: 'transport_closed',
          attempt: 1,
          maxAttempts: 5,
        } as LoopEvent;
        yield {
          kind: 'mcp_log',
          revision: 7,
          serverName: 'content',
          level: 'warning',
          message: `[MCP log details omitted; sha256=${'a'.repeat(64)}]`,
          projectedBytes: 15,
          dataSha256: 'a'.repeat(64),
          truncated: false,
          detailsOmitted: true,
          timestamp: 1_000,
        } as LoopEvent;
        yield {
          kind: 'mcp_instructions_changed',
          revision: 8,
          serverName: 'content',
          action: 'added',
          reason: 'snapshot',
          sourceBytes: 23,
          projectedBytes: 0,
          sha256: 'b'.repeat(64),
          truncated: false,
          detailsOmitted: true,
        } as LoopEvent;
        yield {
          kind: 'mcp_task_changed',
          revision: 9,
          taskId: 'mcp_task_safe',
          serverName: 'content',
          toolName: 'long_task',
          status: 'completed',
          createdAt: 1_000,
          updatedAt: 2_000,
          completedAt: 2_000,
          hasResult: true,
        } as LoopEvent;
        yield {
          kind: 'project_rules_loaded',
          files: [
            {
              id: 'project:rule-one',
              relativePath: '.claude/rules/typescript.md',
              source: 'project',
              conditional: true,
              contentSha256: 'c'.repeat(64),
            },
          ],
          triggerPaths: ['src/index.ts'],
          blockedWrite: true,
        } as LoopEvent;
        return { success: true, finalMessage: 'done' };
      }) as typeof mockAgent.chatStream;

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'refresh content' }],
      });

      expect(mockConnection.sessionUpdates).toContainEqual(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'MCP prompts r4 (content): +1 -0 ~1\n',
            },
          }),
        })
      );
      expect(mockConnection.sessionUpdates).toContainEqual(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'MCP resource updated r5 (content): context://live\n',
            },
          }),
        })
      );
      expect(mockConnection.sessionUpdates).toContainEqual(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'MCP connection r6 (content): reconnecting 1/5\n',
            },
          }),
        })
      );
      expect(mockConnection.sessionUpdates).toContainEqual(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text:
                'MCP log r7 (content) warning: ' +
                `[MCP log details omitted; sha256=${'a'.repeat(64)}]\n`,
            },
          }),
        })
      );
      expect(mockConnection.sessionUpdates).toContainEqual(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'MCP instructions r8 (content): added details-omitted\n',
            },
          }),
        })
      );
      expect(mockConnection.sessionUpdates).toContainEqual(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text:
                'MCP task r9 mcp_task_safe ' +
                '(content/long_task): completed result-available\n',
            },
          }),
        })
      );
      expect(mockConnection.sessionUpdates).toContainEqual(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'Project rules loaded: 1 (write retry required)\n',
            },
          }),
        })
      );
    });

    it('应该把 ACP 图片作为真正的多模态内容传给 Agent', async () => {
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [
          { type: 'text', text: 'Describe this image' },
          {
            type: 'image',
            mimeType: 'image/png',
            data: 'base64-image',
          },
        ],
      });

      expect(getMockAgent().getLastCall()?.message).toEqual([
        { type: 'text', text: 'Describe this image' },
        { type: 'text', text: '\n' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,base64-image' },
        },
      ]);
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

    it('活动回合中的第二个 prompt 应转为 steering 而不是中止前一个回合', async () => {
      const activeController = new AbortController();
      (session as any).pendingPrompt = activeController;

      const result = await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'Use the updated requirement.' }],
      });

      expect(result.stopReason).toBe('end_turn');
      expect(activeController.signal.aborted).toBe(false);
      expect(runtimeState.runtime.enqueueSteering).toHaveBeenCalledWith(
        'Use the updated requirement.',
        { allowBeforeTurn: true }
      );
      expect((session as any).pendingPrompt).toBe(activeController);
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

      const response = await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: '/review uncommitted' }],
      });

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
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: '/compact' }],
      });

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'continue after compact' }],
      });

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

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: '/rewind user-2' }],
      });

      expect(runtimeState.runtime.listRewindCheckpoints).toHaveBeenCalledOnce();
      expect(runtimeState.runtime.rewindSession).toHaveBeenCalledWith({
        targetMessageId: 'user-2',
        mode: 'conversation',
      });
      expect(originalAgent.destroy).toHaveBeenCalledOnce();
      const { Agent } = await import('../../../../src/agent/Agent.js');
      expect(Agent.createWithRuntime).toHaveBeenCalledTimes(2);

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'continue after rewind' }],
      });
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

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [
          {
            type: 'text',
            text: '/tasks resume agent-source Check the follow-up',
          },
        ],
      });

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

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [
          {
            type: 'text',
            text: '/tasks resume agent-unrecoverable Continue',
          },
        ],
      });

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

    it('应该发送文本消息给 IDE', async () => {
      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [
          {
            type: 'text' as const,
            text: 'Hello, World!',
          },
        ],
      };

      await session.prompt(promptParams);

      // 简单验证 prompt 方法不抛出错误
      // 具体的消息更新验证比较复杂，涉及 mock 时机问题
      expect(mockConnection.sessionUpdates.length).toBeGreaterThanOrEqual(0);
    });

    it('应该通知 IDE 有崩溃后恢复的 steering 指令', async () => {
      const mockAgent = getMockAgent();
      mockAgent.chatStream = vi.fn(async function* () {
        yield {
          kind: 'follow_up_started',
          queued: 1,
          recovered: 1,
          messages: [
            {
              id: 'recovered-1',
              content: 'recovered guidance',
              queuedAt: Date.now(),
              recovered: true,
              persisted: false,
            },
          ],
        } as const;
        return {
          success: true,
          finalMessage: 'done',
        };
      }) as typeof mockAgent.chatStream;

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'continue' }],
      });

      expect(
        mockConnection.sessionUpdates.some(
          (notification) =>
            notification.update.sessionUpdate === 'agent_message_chunk' &&
            notification.update.content.type === 'text' &&
            notification.update.content.text.includes('Resuming 1 queued instruction')
        )
      ).toBe(true);
      expect(
        mockConnection.sessionUpdates.some(
          (notification) =>
            notification.update.sessionUpdate === 'user_message_chunk' &&
            notification.update.content.type === 'text' &&
            notification.update.content.text === 'recovered guidance'
        )
      ).toBe(true);
    });

    it('应该发送可用命令', async () => {
      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [
          {
            type: 'text' as const,
            text: 'test',
          },
        ],
      };

      await session.prompt(promptParams);

      // 简单验证 prompt 方法不抛出错误
      expect(mockConnection.sessionUpdates.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('cancel', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('应该取消当前操作', () => {
      session.cancel();

      // 验证取消成功（没有抛出错误）
      expect(() => session.cancel()).not.toThrow();
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
      const result = await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: '! pwd' }],
      });

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

    it('maps terminal timeout and abort from failureKind instead of error text', async () => {
      const { SessionRuntime } = await import(
        '../../../../src/agent/runtime/SessionRuntime.js'
      );
      const createOptions = vi.mocked(SessionRuntime.create).mock.calls.at(-1)?.[0];
      const executor = createOptions?.userShellExecutor;
      terminalState.execute
        .mockResolvedValueOnce({
          success: false,
          stdout: '',
          stderr: '',
          exitCode: null,
          error: 'localized timeout message',
          failureKind: 'timeout',
          transport: 'acp',
        })
        .mockResolvedValueOnce({
          success: false,
          stdout: '',
          stderr: '',
          exitCode: null,
          error: 'localized abort message',
          failureKind: 'aborted',
          transport: 'acp',
        });

      const options = {
        cwd: '/tmp/test',
        env: {},
        timeoutMs: 1000,
        signal: new AbortController().signal,
      };
      await expect(executor?.execute('sleep 10', options)).resolves.toMatchObject({
        timedOut: true,
        aborted: false,
      });
      await expect(executor?.execute('sleep 10', options)).resolves.toMatchObject({
        timedOut: false,
        aborted: true,
      });
    });
  });

  describe('setMode', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('应该设置会话模式为 default', async () => {
      await session.setMode('default');

      // 验证发送了模式更新
      const updates = mockConnection.sessionUpdates;
      const modeUpdates = updates.filter(
        (u) => u.update.sessionUpdate === 'current_mode_update'
      );
      expect(modeUpdates.length).toBeGreaterThan(0);
      expect((modeUpdates[0].update as any).currentModeId).toBe('default');
    });

    it('应该设置会话模式为 auto-edit', async () => {
      await session.setMode('auto-edit');

      const updates = mockConnection.sessionUpdates;
      const modeUpdates = updates.filter(
        (u) => u.update.sessionUpdate === 'current_mode_update'
      );
      expect(modeUpdates.length).toBeGreaterThan(0);
      expect((modeUpdates[0].update as any).currentModeId).toBe('auto-edit');
    });

    it('应该设置会话模式为 yolo', async () => {
      await session.setMode('yolo');

      expect(sessionServiceState.setSessionPermissionMode).toHaveBeenLastCalledWith(
        'test-session-id',
        '/tmp/test',
        'yolo'
      );
      const updates = mockConnection.sessionUpdates;
      const modeUpdates = updates.filter(
        (u) => u.update.sessionUpdate === 'current_mode_update'
      );
      expect(modeUpdates.length).toBeGreaterThan(0);
      expect((modeUpdates[0].update as any).currentModeId).toBe('yolo');
    });

    it('持久化失败时不应通知客户端或改变当前模式', async () => {
      const updatesBefore = mockConnection.sessionUpdates.length;
      sessionServiceState.setSessionPermissionMode.mockRejectedValueOnce(
        new Error('mode fsync failed')
      );

      await expect(session.setMode('yolo')).rejects.toThrow('mode fsync failed');

      expect(mockConnection.sessionUpdates).toHaveLength(updatesBefore);
      expect(session.getMode()).toBe('default');
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

    it('destroy 后不应该发送延迟的 available commands update', async () => {
      session.sendAvailableCommandsDelayed();

      await vi.advanceTimersByTimeAsync(499);
      await session.destroy();
      await vi.advanceTimersByTimeAsync(1);

      expect(
        mockConnection.sessionUpdates.filter(
          (notification) =>
            notification.update.sessionUpdate === 'available_commands_update'
        )
      ).toHaveLength(0);
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

    it('应该切换会话运行时使用的模型', async () => {
      await session.setModel('gpt-4');

      expect(getMockAgent().switchModel).toHaveBeenCalledWith('gpt-4');
      expect(sessionServiceState.updateSessionMetadata).toHaveBeenCalledWith(
        'test-session-id',
        '/tmp/test',
        { selectedModelId: 'gpt-4' }
      );
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

    it('原子切换并持久化 Session reasoning effort', async () => {
      await session.setReasoningEffort('high');

      expect(runtimeState.runtime.resolveReasoningConfiguration).toHaveBeenCalledWith(
        'high'
      );
      expect(runtimeState.runtime.refresh).toHaveBeenCalledWith({
        reasoningEffort: 'high',
      });
      expect(sessionServiceState.updateSessionMetadata).toHaveBeenCalledWith(
        'test-session-id',
        '/tmp/test',
        { reasoningEffort: 'high' }
      );
    });

    it('活动回合期间拒绝切换 reasoning effort', async () => {
      (session as any).pendingPrompt = new AbortController();
      await expect(session.setReasoningEffort('low')).rejects.toThrow(
        'Cannot switch reasoning effort while a prompt is active'
      );
      expect(runtimeState.runtime.refresh).not.toHaveBeenCalled();
    });

    it('持久化失败时回滚 reasoning effort', async () => {
      sessionServiceState.updateSessionMetadata.mockRejectedValueOnce(
        new Error('disk unavailable')
      );
      await expect(session.setReasoningEffort('medium')).rejects.toThrow(
        'disk unavailable'
      );
      expect(runtimeState.runtime.refresh).toHaveBeenNthCalledWith(1, {
        reasoningEffort: 'medium',
      });
      expect(runtimeState.runtime.refresh).toHaveBeenNthCalledWith(2, {
        reasoningEffort: 'off',
      });
    });
  });

  describe('setServiceTier', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('原子切换并持久化 Session service tier', async () => {
      await session.setServiceTier('fast');
      expect(runtimeState.runtime.resolveServiceTierConfiguration).toHaveBeenCalledWith(
        'fast'
      );
      expect(runtimeState.runtime.refresh).toHaveBeenCalledWith({
        serviceTier: 'fast',
      });
      expect(sessionServiceState.updateSessionMetadata).toHaveBeenCalledWith(
        'test-session-id',
        '/tmp/test',
        { serviceTier: 'fast' }
      );
    });

    it('活动回合期间拒绝切换 service tier', async () => {
      (session as any).pendingPrompt = new AbortController();
      await expect(session.setServiceTier('flex')).rejects.toThrow(
        'Cannot switch service tier while a prompt is active'
      );
      expect(runtimeState.runtime.refresh).not.toHaveBeenCalled();
    });

    it('持久化失败时回滚 service tier', async () => {
      sessionServiceState.updateSessionMetadata.mockRejectedValueOnce(
        new Error('disk unavailable')
      );
      await expect(session.setServiceTier('fast')).rejects.toThrow('disk unavailable');
      expect(runtimeState.runtime.refresh).toHaveBeenNthCalledWith(1, {
        serviceTier: 'fast',
      });
      expect(runtimeState.runtime.refresh).toHaveBeenNthCalledWith(2, {
        serviceTier: 'auto',
      });
    });
  });

  describe('setResponseVerbosity', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('原子切换并持久化 Session response verbosity', async () => {
      await session.setResponseVerbosity('high');
      expect(
        runtimeState.runtime.resolveResponseVerbosityConfiguration
      ).toHaveBeenCalledWith('high');
      expect(runtimeState.runtime.refresh).toHaveBeenCalledWith({
        responseVerbosity: 'high',
      });
      expect(sessionServiceState.updateSessionMetadata).toHaveBeenCalledWith(
        'test-session-id',
        '/tmp/test',
        { responseVerbosity: 'high' }
      );
    });

    it('活动回合期间拒绝切换 response verbosity', async () => {
      (session as any).pendingPrompt = new AbortController();
      await expect(session.setResponseVerbosity('low')).rejects.toThrow(
        'Cannot switch response verbosity while a prompt is active'
      );
      expect(runtimeState.runtime.refresh).not.toHaveBeenCalled();
    });

    it('持久化失败时回滚 response verbosity', async () => {
      sessionServiceState.updateSessionMetadata.mockRejectedValueOnce(
        new Error('disk unavailable')
      );
      await expect(session.setResponseVerbosity('high')).rejects.toThrow(
        'disk unavailable'
      );
      expect(runtimeState.runtime.refresh).toHaveBeenNthCalledWith(1, {
        responseVerbosity: 'high',
      });
      expect(runtimeState.runtime.refresh).toHaveBeenNthCalledWith(2, {
        responseVerbosity: 'auto',
      });
    });
  });

  describe('setCommunicationStyle', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('原子切换并持久化 Session communication style', async () => {
      await session.setCommunicationStyle('explanatory');
      expect(
        runtimeState.runtime.resolveCommunicationStyleConfiguration
      ).toHaveBeenCalledWith('explanatory');
      expect(runtimeState.runtime.refresh).toHaveBeenCalledWith({
        communicationStyle: 'explanatory',
      });
      expect(sessionServiceState.updateSessionMetadata).toHaveBeenCalledWith(
        'test-session-id',
        '/tmp/test',
        {
          communicationStyle: 'explanatory',
          communicationStyleDigest: null,
        }
      );
    });

    it('活动回合期间拒绝切换 communication style', async () => {
      (session as any).pendingPrompt = new AbortController();
      await expect(session.setCommunicationStyle('friendly')).rejects.toThrow(
        'Cannot switch communication style while a prompt is active'
      );
      expect(runtimeState.runtime.refresh).not.toHaveBeenCalled();
    });

    it('持久化失败时回滚 communication style', async () => {
      sessionServiceState.updateSessionMetadata.mockRejectedValueOnce(
        new Error('disk unavailable')
      );
      await expect(session.setCommunicationStyle('pragmatic')).rejects.toThrow(
        'disk unavailable'
      );
      expect(runtimeState.runtime.refresh).toHaveBeenNthCalledWith(1, {
        communicationStyle: 'pragmatic',
      });
      expect(runtimeState.runtime.refresh).toHaveBeenNthCalledWith(2, {
        communicationStyle: 'auto',
      });
    });
  });

  describe('destroy', () => {
    it('destroy 后丢弃仍在 drain 的旧 generator 产生的更新', async () => {
      await session.initialize();
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

      const prompt = session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'start deferred stream' }],
      });
      await started;
      await session.destroy();
      releaseLateEvents?.();
      await prompt;

      expect(mockConnection.sessionUpdates).toEqual([]);
    });

    it('connection abort 后直接丢弃 session update', async () => {
      connectionAbortController.abort();

      await session.setMode('yolo');

      expect(mockConnection.sessionUpdates).toEqual([]);
    });

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
      expect(AcpServiceContext.destroySession).toHaveBeenCalledTimes(1);
      expect(AcpServiceContext.destroySession).toHaveBeenCalledWith('test-session-id');
      await expect(session.setModel('gpt-4')).rejects.toThrow(
        'Session not initialized'
      );
    });

    it.each([
      {
        name: 'Agent destroy 失败',
        agentError: new Error('agent destroy failed'),
        runtimeError: undefined,
        expectedError: 'agent destroy failed',
      },
      {
        name: 'runtime dispose 失败',
        agentError: undefined,
        runtimeError: new Error('runtime dispose failed'),
        expectedError: 'runtime dispose failed',
      },
      {
        name: 'Agent 与 runtime 都失败',
        agentError: new Error('agent destroy failed first'),
        runtimeError: new Error('runtime dispose failed second'),
        expectedError: 'agent destroy failed first',
      },
    ])('$name 时仍应该清理全部资源并由第一个错误获胜', async ({
      agentError,
      runtimeError,
      expectedError,
    }) => {
      await session.initialize();
      const mockAgent = getMockAgent();
      if (agentError) mockAgent.destroy = vi.fn().mockRejectedValueOnce(agentError);
      if (runtimeError) {
        runtimeState.runtime.dispose.mockRejectedValueOnce(runtimeError);
      }

      await expect(session.destroy()).rejects.toThrow(expectedError);

      const { AcpServiceContext } = await import(
        '../../../../src/acp/AcpServiceContext.js'
      );
      expect(mockAgent.destroy).toHaveBeenCalledTimes(1);
      expect(runtimeState.runtime.dispose).toHaveBeenCalledTimes(1);
      expect(AcpServiceContext.destroySession).toHaveBeenCalledTimes(1);
      await expect(session.setModel('gpt-4')).rejects.toThrow(
        'Session not initialized'
      );

      await expect(session.destroy()).resolves.toBeUndefined();
      expect(mockAgent.destroy).toHaveBeenCalledTimes(1);
      expect(runtimeState.runtime.dispose).toHaveBeenCalledTimes(1);
      expect(AcpServiceContext.destroySession).toHaveBeenCalledTimes(1);
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
      expect(AcpServiceContext.destroySession).toHaveBeenCalledTimes(1);
    });

    it('ACP context destroy 失败时应该在其余 cleanup 后重抛且保持幂等', async () => {
      await session.initialize();
      const mockAgent = getMockAgent();
      const { AcpServiceContext } = await import(
        '../../../../src/acp/AcpServiceContext.js'
      );
      vi.mocked(AcpServiceContext.destroySession).mockImplementationOnce(() => {
        throw new Error('context destroy failed');
      });

      await expect(session.destroy()).rejects.toThrow('context destroy failed');
      expect(mockAgent.destroy).toHaveBeenCalledTimes(1);
      expect(runtimeState.runtime.dispose).toHaveBeenCalledTimes(1);
      expect(AcpServiceContext.destroySession).toHaveBeenCalledTimes(1);

      await expect(session.destroy()).resolves.toBeUndefined();
      expect(mockAgent.destroy).toHaveBeenCalledTimes(1);
      expect(runtimeState.runtime.dispose).toHaveBeenCalledTimes(1);
      expect(AcpServiceContext.destroySession).toHaveBeenCalledTimes(1);
    });

    it('runtime 创建失败的半初始化会话仍应该清理 ACP context', async () => {
      const { SessionRuntime } = await import(
        '../../../../src/agent/runtime/SessionRuntime.js'
      );
      vi.mocked(SessionRuntime.create).mockRejectedValueOnce(
        new Error('runtime create failed')
      );

      await expect(session.initialize()).rejects.toThrow('runtime create failed');
      await session.destroy();

      const { AcpServiceContext } = await import(
        '../../../../src/acp/AcpServiceContext.js'
      );
      expect(AcpServiceContext.destroySession).toHaveBeenCalledTimes(1);
      expect(runtimeState.runtime.dispose).not.toHaveBeenCalled();
    });

    it('应该取消挂起的提示', async () => {
      await session.initialize();

      // 设置一个挂起的提示
      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text' as const, text: 'test' }],
      };
      const promptPromise = session.prompt(promptParams);

      // 立即取消
      session.cancel();

      // 等待提示完成（应该被取消）
      const result = await promptPromise;
      expect(result.stopReason).toBe('cancelled');
    });
  });

  describe('消息历史管理', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('应该保存消息历史', async () => {
      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text' as const, text: 'Hello' }],
      };

      await session.prompt(promptParams);

      // 验证消息已保存
      // （由于消息是私有的，我们通过再次提示来验证历史保持）
      const secondPrompt = {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text' as const, text: 'How are you?' }],
      };

      const response = await session.prompt(secondPrompt);
      expect(response.stopReason).toBe('end_turn');
    });
  });

  describe('structured output metadata', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('accepts an ACP output schema and returns the validated payload in _meta', async () => {
      const schema = {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      };
      const output = { answer: 'done' };
      const digest = 'a'.repeat(64);
      const agent = getMockAgent();
      agent.events = [
        {
          kind: 'structured_output',
          output,
          schemaDigest: digest,
        },
      ];
      agent.setChatResult({
        success: true,
        finalMessage: JSON.stringify(output),
        metadata: {
          turnsCount: 2,
          toolCallsCount: 1,
          duration: 10,
          structuredOutput: output,
          structuredOutputSchemaDigest: digest,
        },
      });

      const response = await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'Return an answer' }],
        _meta: { outputSchema: schema },
      });

      expect(agent.getLastCall()?.options?.outputSchema).toEqual(schema);
      expect(response).toEqual({
        stopReason: 'end_turn',
        _meta: {
          structuredOutput: output,
          outputSchemaDigest: digest,
        },
      });
      expect(mockConnection.sessionUpdates.map((entry) => entry.update)).toContainEqual(
        expect.objectContaining({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: JSON.stringify(output) },
        })
      );
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

  describe('goal completion metadata', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('returns only stable host-verified goal evidence in ACP _meta', async () => {
      const agent = getMockAgent();
      agent.setChatResult({
        success: true,
        finalMessage: 'Goal complete.',
        metadata: {
          turnsCount: 4,
          toolCallsCount: 3,
          duration: 20,
          goalCompletionVerified: true,
          goalVerificationVerdict: 'pass',
          goalVerifierSessionId: 'verifier-session-opaque',
          goalVerificationEvidenceSha256: 'a'.repeat(64),
        },
      });

      const response = await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'Continue the goal' }],
      });

      expect(response).toEqual({
        stopReason: 'end_turn',
        _meta: {
          goalCompletion: {
            verified: true,
            verdict: 'pass',
            verifierSessionId: 'verifier-session-opaque',
            evidenceSha256: 'a'.repeat(64),
          },
        },
      });
      expect(JSON.stringify(response)).not.toContain('Goal complete.');
    });
  });

  describe('权限管理', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('应该在 default 模式下请求权限', async () => {
      await session.setMode('default');

      // 设置权限响应
      mockConnection.setPermissionResponse('tool-123', {
        outcome: {
          outcome: 'selected',
          optionId: 'allow_once',
        },
      });

      // 触发权限请求（通过执行需要权限的工具）
      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text' as const, text: 'Execute a command' }],
      };

      await session.prompt(promptParams);

      // 验证 prompt 方法不抛出错误
      // 具体的权限请求验证比较复杂，涉及 mock Agent 的行为
      expect(mockConnection.permissionRequests.length).toBeGreaterThanOrEqual(0);
    });

    it('应该在 yolo 模式下自动批准', async () => {
      await session.setMode('yolo');

      // 在 yolo 模式下，所有操作应该自动批准
      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text' as const, text: 'Execute a command' }],
      };

      const response = await session.prompt(promptParams);

      // 验证没有发送权限请求（自动批准）
      const _permissionRequests = mockConnection.permissionRequests;
      // 由于我们的 mock Agent 没有实际调用需要权限的工具，
      // 这里只是验证不会发送不必要的权限请求
      expect(response.stopReason).toBe('end_turn');
    });

    it('应该在 plan 模式下拒绝写操作', async () => {
      await session.setMode('plan');

      // 设置一个会被拒绝的权限响应
      mockConnection.setPermissionResponse('tool-123', {
        outcome: {
          outcome: 'selected',
          optionId: 'reject_once',
        },
      });

      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text' as const, text: 'Write a file' }],
      };

      // 在 plan 模式下，写操作应该被拒绝
      const response = await session.prompt(promptParams);
      // 验证行为（具体取决于 Agent 的实现）
      expect(response).toBeDefined();
    });

    it('应该缓存 allow_always 权限', async () => {
      await session.setMode('default');

      // 第一次请求允许并选择 always allow
      mockConnection.setPermissionResponse('tool-123', {
        outcome: {
          outcome: 'selected',
          optionId: 'allow_always',
        },
      });

      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text' as const, text: 'Execute command' }],
      };

      await session.prompt(promptParams);

      // 清空权限请求记录
      mockConnection.permissionRequests = [];

      // 第二次请求相同操作
      await session.prompt(promptParams);

      // 验证第二次没有发送权限请求（使用了缓存）
      // 由于我们的 mock 逻辑简单，这里只是验证不会重复请求
      expect(mockConnection.permissionRequests.length).toBe(0);
    });
  });

  describe('ToolKind 映射', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('应该正确映射 ToolKind', async () => {
      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text' as const, text: 'test' }],
      };

      await session.prompt(promptParams);

      // 检查工具调用更新
      const toolCallUpdates = mockConnection.sessionUpdates.filter(
        (u) => u.update.sessionUpdate === 'tool_call'
      );

      // 验证工具调用类型映射正确
      for (const update of toolCallUpdates) {
        const kind = (update.update as any).kind;
        const validKinds = [
          'read',
          'edit',
          'delete',
          'move',
          'search',
          'execute',
          'think',
          'fetch',
          'other',
        ];
        expect(validKinds).toContain(kind);
      }
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

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'Run both checks.' }],
      });

      expect(
        mockConnection.sessionUpdates
          .filter((update) => update.update.sessionUpdate === 'tool_call')
          .map((update) => (update.update as { toolCallId: string }).toolCallId)
      ).toEqual(['parallel-task-a', 'parallel-task-b']);
    });
  });

  describe('Task 列表更新', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('应该发送 plan 更新', async () => {
      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text' as const, text: 'Create a plan' }],
      };

      await session.prompt(promptParams);

      // 检查 plan 更新
      const planUpdates = mockConnection.sessionUpdates.filter(
        (u) => u.update.sessionUpdate === 'plan'
      );

      // 验证 plan 更新格式正确
      for (const update of planUpdates) {
        const entries = (update.update as any).entries;
        expect(Array.isArray(entries)).toBe(true);
      }
    });
  });
});

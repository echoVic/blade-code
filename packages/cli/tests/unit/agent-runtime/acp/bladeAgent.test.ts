/**
 * BladeAgent 测试
 */

import {
  type ForkSessionRequest,
  type ListSessionsRequest,
  type LoadSessionRequest,
  type LoadSessionResponse,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BladeAgent } from '../../../../src/acp/BladeAgent.js';
import { AcpSession } from '../../../../src/acp/Session.js';
import { createMockACPClient } from '../../../support/mocks/mockACPClient.js';

const sessionServiceMocks = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  forkSession: vi.fn(),
  listSessionPage: vi.fn(),
  loadSession: vi.fn(),
}));

const sessionTaskServiceMocks = vi.hoisted(() => ({
  createSessionTask: vi.fn(),
}));

type AcpSessionConstructorArgs = ConstructorParameters<typeof AcpSession>;
interface MockAcpSessionInstance {
  id: string;
  cwd: string;
  connection: AcpSessionConstructorArgs[2];
  clientCapabilities: AcpSessionConstructorArgs[3];
  options: AcpSessionConstructorArgs[4];
  initialize: ReturnType<typeof vi.fn<() => Promise<void>>>;
  prompt: ReturnType<typeof vi.fn<AcpSession['prompt']>>;
  cancel: ReturnType<typeof vi.fn<AcpSession['cancel']>>;
  setMode: ReturnType<typeof vi.fn<AcpSession['setMode']>>;
  setModel: ReturnType<typeof vi.fn<AcpSession['setModel']>>;
  getCurrentModelId: ReturnType<typeof vi.fn<AcpSession['getCurrentModelId']>>;
  destroy: ReturnType<typeof vi.fn<AcpSession['destroy']>>;
  replayHistory: ReturnType<typeof vi.fn<AcpSession['replayHistory']>>;
  sendAvailableCommandsDelayed: ReturnType<
    typeof vi.fn<AcpSession['sendAvailableCommandsDelayed']>
  >;
}
interface DeferredGate {
  promise: Promise<void>;
  resolve(): void;
}

function createDeferredGate(): DeferredGate {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    resolve: () => release?.(),
  };
}

const createdSessions = vi.hoisted((): MockAcpSessionInstance[] => []);
const acpSessionMocks = vi.hoisted(() => ({
  destroyErrors: [] as Error[],
  initializeGates: [] as DeferredGate[],
  nextInitializeError: null as Error | null,
  nextReplayError: null as Error | null,
  currentModelId: 'model-1',
}));
const mcpRegistryMocks = vi.hoisted(() => ({
  disconnectAll: vi.fn().mockResolvedValue(undefined),
}));

// Mock AcpSession
// Vitest 4: vi.fn().mockImplementation(arrowFn) is not constructable with `new`.
// Use a class wrapper delegating to the mock implementation to ensure constructability.
vi.mock('../../../../src/acp/Session.js', () => {
  const mockAcpSessionImpl = (
    ...[id, cwd, connection, clientCapabilities, options]: AcpSessionConstructorArgs
  ): MockAcpSessionInstance => {
    const session: MockAcpSessionInstance = {
      id,
      cwd,
      connection,
      clientCapabilities,
      initialize: vi.fn().mockImplementation(async () => {
        const gate = acpSessionMocks.initializeGates.shift();
        if (gate) await gate.promise;
        const error = acpSessionMocks.nextInitializeError;
        acpSessionMocks.nextInitializeError = null;
        if (error) throw error;
      }),
      prompt: vi.fn<AcpSession['prompt']>().mockResolvedValue({
        stopReason: 'end_turn',
      }),
      cancel: vi.fn(),
      setMode: vi.fn().mockResolvedValue(undefined),
      setModel: vi.fn().mockResolvedValue(undefined),
      getCurrentModelId: vi.fn(() => acpSessionMocks.currentModelId),
      destroy: vi.fn().mockImplementation(async () => {
        const error = acpSessionMocks.destroyErrors.shift();
        if (error) throw error;
      }),
      replayHistory: vi.fn().mockImplementation(async () => {
        const error = acpSessionMocks.nextReplayError;
        acpSessionMocks.nextReplayError = null;
        if (error) throw error;
      }),
      sendAvailableCommandsDelayed: vi.fn(),
      options,
    };
    createdSessions.push(session);
    return session;
  };

  class AcpSessionMock {
    constructor(...args: AcpSessionConstructorArgs) {
      const session = mockAcpSessionImpl(...args);
      Object.assign(this, session);
    }
  }

  return {
    AcpSession: vi.fn(
      AcpSessionMock as unknown as (
        ...args: AcpSessionConstructorArgs
      ) => MockAcpSessionInstance
    ),
  };
});

// Mock Agent
const MockAgentClass = Object.assign(
  vi.fn().mockImplementation(() => ({
    chat: vi.fn().mockResolvedValue('Mock response'),
    destroy: vi.fn().mockResolvedValue(undefined),
  })),
  {
    create: vi.fn().mockResolvedValue({
      chat: vi.fn().mockResolvedValue('Mock response'),
      destroy: vi.fn().mockResolvedValue(undefined),
    }),
  }
);

vi.mock('../../../../src/agent/Agent.js', () => ({
  Agent: MockAgentClass,
}));

vi.mock('../../../../src/services/SessionService.js', () => ({
  SessionService: {
    deleteSession: sessionServiceMocks.deleteSession,
    forkSession: sessionServiceMocks.forkSession,
    listSessionPage: sessionServiceMocks.listSessionPage,
    loadSession: sessionServiceMocks.loadSession,
  },
}));

vi.mock('../../../../src/services/SessionTaskService.js', () => ({
  SessionTaskService: sessionTaskServiceMocks,
}));

vi.mock('../../../../src/mcp/McpRegistry.js', () => ({
  McpRegistry: {
    getInstance: vi.fn(() => mcpRegistryMocks),
  },
}));

// Mock getConfig
vi.mock('../../../../src/store/vanilla.js', () => ({
  getConfig: vi.fn(() => ({
    models: [
      { id: 'gpt-4', displayName: 'GPT-4', provider: 'openai', model: 'gpt-4' },
      {
        id: 'gpt-3.5',
        displayName: 'GPT-3.5',
        provider: 'openai',
        model: 'gpt-4.1-mini',
      },
    ],
    currentModelId: 'gpt-4',
  })),
}));

// Mock Logger
vi.mock('../../../../src/logging/Logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  LogCategory: {
    AGENT: 'AGENT',
  },
}));

describe('BladeAgent', () => {
  let mockConnection: ReturnType<typeof createMockACPClient>;
  let agent: BladeAgent;

  function loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return (
      agent as BladeAgent & {
        loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>;
      }
    ).loadSession(params);
  }

  beforeEach(() => {
    createdSessions.length = 0;

    // 创建 mock 连接
    mockConnection = createMockACPClient();

    // 创建 BladeAgent 实例
    agent = new BladeAgent(mockConnection as any);
    sessionServiceMocks.listSessionPage.mockResolvedValue({ sessions: [] });
    sessionServiceMocks.forkSession.mockResolvedValue({
      sessionId: 'forked-session',
      messages: [],
    });
    sessionServiceMocks.loadSession.mockResolvedValue([]);
    sessionTaskServiceMocks.createSessionTask.mockReset();
    acpSessionMocks.destroyErrors = [];
    acpSessionMocks.initializeGates = [];
    acpSessionMocks.nextInitializeError = null;
    acpSessionMocks.nextReplayError = null;
    acpSessionMocks.currentModelId = 'model-1';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialize', () => {
    it('应该正确初始化连接', async () => {
      const params = {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          promptCapabilities: {
            image: true,
            audio: false,
            embeddedContext: true,
          },
        },
      } as any;

      const response = await agent.initialize(params);

      expect(response).toBeDefined();
      expect(response.protocolVersion).toBeDefined();
      const agentCapabilities = response.agentCapabilities;
      expect(agentCapabilities).toBeDefined();
      if (!agentCapabilities) {
        throw new Error('agentCapabilities is undefined');
      }
      expect(agentCapabilities.promptCapabilities).toEqual({
        image: true,
        audio: false,
        embeddedContext: true,
      });
      expect(agentCapabilities.mcpCapabilities).toEqual({
        http: true,
        sse: true,
      });
      expect(agentCapabilities.loadSession).toBe(true);
      expect(agentCapabilities.sessionCapabilities).toEqual({
        list: {},
        fork: {},
      });
    });

    it('应该保存客户端能力', async () => {
      const params = {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          promptCapabilities: {
            image: false,
            audio: false,
            embeddedContext: false,
          },
        },
      } as any;

      await agent.initialize(params);

      // 通过检查后续行为来验证客户端能力已保存
      const response = await agent.initialize(params);
      expect(response.agentCapabilities).toBeDefined();
    });
  });

  describe('listSessions', () => {
    it('应该分页列出非 subagent 会话并映射 ACP metadata', async () => {
      sessionServiceMocks.listSessionPage.mockResolvedValueOnce({
        sessions: [
          {
            sessionId: 'persisted-session',
            projectPath: '/tmp/project',
            title: 'Persisted title',
            taskStatus: 'running',
            taskFailure: {
              code: 'timeout',
              message: 'Provider request timed out.',
              retryable: true,
            },
            taskStartedAt: '2026-08-04T01:02:00.000Z',
            taskModelId: 'model-snapshot',
            taskRetryAvailable: true,
            taskRetriedFrom: {
              sessionId: 'failed-source',
              projectPath: '/tmp/source-worktree',
            },
            taskDelivery: {
              status: 'conflicted',
              updatedAt: '2026-08-04T01:02:02.000Z',
              message: 'Source workspace changed after this task started',
            },
            taskIsolation: 'worktree',
            taskSourceProjectPath: '/tmp/source',
            taskWorktreeBranch: 'blade-worktree-task',
            taskBaseCommit: 'abc123',
            taskDiffStat: {
              changedFiles: 2,
              additions: 7,
              deletions: 1,
              commits: 0,
            },
            taskQueuePosition: 2,
            taskQueueDepth: 4,
            taskConcurrencyLimit: 3,
            lastMessageTime: '2026-08-04T01:02:03.000Z',
          },
          {
            sessionId: 'untitled-session',
            projectPath: '/tmp/project',
            taskStatus: 'completed',
            taskCompletedAt: '2026-08-04T01:02:04.000Z',
            lastMessageTime: '2026-08-04T01:02:04.000Z',
          },
        ],
        nextCursor: 'next-page',
      });

      const response = await agent.listSessions({
        cwd: '/tmp/project',
        cursor: 'current-page',
      });

      expect(sessionServiceMocks.listSessionPage).toHaveBeenCalledWith({
        cwd: '/tmp/project',
        cursor: 'current-page',
        limit: 50,
        includeSubagents: false,
      });
      expect(response).toEqual({
        sessions: [
          {
            sessionId: 'persisted-session',
            cwd: '/tmp/project',
            title: 'Persisted title',
            updatedAt: '2026-08-04T01:02:03.000Z',
            _meta: {
              'blade/taskStatus': 'running',
              'blade/taskFailure': {
                code: 'timeout',
                message: 'Provider request timed out.',
                retryable: true,
              },
              'blade/taskStartedAt': '2026-08-04T01:02:00.000Z',
              'blade/taskModelId': 'model-snapshot',
              'blade/taskRetryAvailable': true,
              'blade/taskRetriedFrom': {
                sessionId: 'failed-source',
                projectPath: '/tmp/source-worktree',
              },
              'blade/taskDelivery': {
                status: 'conflicted',
                updatedAt: '2026-08-04T01:02:02.000Z',
                message: 'Source workspace changed after this task started',
              },
              'blade/taskIsolation': 'worktree',
              'blade/taskSourceProjectPath': '/tmp/source',
              'blade/taskWorktreeBranch': 'blade-worktree-task',
              'blade/taskBaseCommit': 'abc123',
              'blade/taskDiffStat': {
                changedFiles: 2,
                additions: 7,
                deletions: 1,
                commits: 0,
              },
              'blade/taskQueuePosition': 2,
              'blade/taskQueueDepth': 4,
              'blade/taskConcurrencyLimit': 3,
            },
          },
          {
            sessionId: 'untitled-session',
            cwd: '/tmp/project',
            title: null,
            updatedAt: '2026-08-04T01:02:04.000Z',
            _meta: {
              'blade/taskStatus': 'completed',
              'blade/taskCompletedAt': '2026-08-04T01:02:04.000Z',
            },
          },
        ],
        nextCursor: 'next-page',
      });
    });

    it('应该把 null filter 转为 undefined', async () => {
      await agent.listSessions({ cwd: null, cursor: null });

      expect(sessionServiceMocks.listSessionPage).toHaveBeenCalledWith({
        cwd: undefined,
        cursor: undefined,
        limit: 50,
        includeSubagents: false,
      });
    });

    it('应该在读取 catalog 前拒绝相对 cwd', async () => {
      const request: ListSessionsRequest = { cwd: 'relative/project' };

      await expect(agent.listSessions(request)).rejects.toThrow(
        'ACP session list cwd must be absolute'
      );
      expect(sessionServiceMocks.listSessionPage).not.toHaveBeenCalled();
    });

    it('应该原样传播 malformed cursor 错误且不注册会话', async () => {
      const cursorError = new Error('Invalid session cursor');
      sessionServiceMocks.listSessionPage.mockRejectedValueOnce(cursorError);

      await expect(agent.listSessions({ cursor: 'not-base64url-json' })).rejects.toBe(
        cursorError
      );
      expect(createdSessions).toHaveLength(0);
    });
  });

  describe('unstable_forkSession', () => {
    const request: ForkSessionRequest = {
      sessionId: 'parent-session',
      cwd: '/tmp/project',
      mcpServers: [],
    };

    it('应该用 durable child history 初始化且不回放历史', async () => {
      const messages = [
        { role: 'user' as const, content: 'Remember the fork context' },
        { role: 'assistant' as const, content: 'Context remembered' },
      ];
      sessionServiceMocks.forkSession.mockResolvedValueOnce({
        sessionId: 'forked-session',
        messages,
      });

      const response = await agent.unstable_forkSession(request);

      expect(sessionServiceMocks.forkSession).toHaveBeenCalledWith('parent-session', {
        sourceProjectPath: '/tmp/project',
        targetProjectPath: '/tmp/project',
      });
      expect(AcpSession).toHaveBeenCalledWith(
        'forked-session',
        '/tmp/project',
        mockConnection,
        undefined,
        { initialMessages: messages, mcpServers: [] }
      );
      const child = createdSessions[0];
      expect(child.initialize).toHaveBeenCalledTimes(1);
      expect(child.replayHistory).not.toHaveBeenCalled();
      expect(child.sendAvailableCommandsDelayed).toHaveBeenCalledTimes(1);
      expect(response).toMatchObject({
        sessionId: 'forked-session',
        modes: { currentModeId: 'default' },
      });
      const forkModelCfg = response.configOptions?.find((o: any) => o.id === 'model');
      expect(
        forkModelCfg && 'currentValue' in forkModelCfg
          ? forkModelCfg.currentValue
          : undefined
      ).toBe('gpt-4');

      await agent.prompt({
        sessionId: 'forked-session',
        prompt: [{ type: 'text', text: 'Continue in the child' }],
      });
      expect(child.prompt).toHaveBeenCalledTimes(1);
    });

    it('应该让 fork 与 new 返回完全相同的 setup', async () => {
      const created = await agent.newSession({
        cwd: '/tmp/project',
        mcpServers: [],
      });
      const forked = await agent.unstable_forkSession(request);
      const { sessionId: _createdId, ...createdSetup } = created;
      const { sessionId: _forkedId, ...forkedSetup } = forked;

      expect(forkedSetup).toEqual(createdSetup);
    });

    it('应该在初始化失败时销毁临时 child 并保留 durable transcript', async () => {
      const initializeError = new Error('fork runtime initialization failed');
      acpSessionMocks.nextInitializeError = initializeError;

      await expect(agent.unstable_forkSession(request)).rejects.toBe(initializeError);

      const child = createdSessions[0];
      expect(child.destroy).toHaveBeenCalledTimes(1);
      expect(sessionServiceMocks.deleteSession).not.toHaveBeenCalled();
      await expect(
        agent.prompt({
          sessionId: 'forked-session',
          prompt: [{ type: 'text', text: 'must not be registered' }],
        })
      ).rejects.toThrow('Session not found: forked-session');
    });

    it('cleanup 失败时仍应该抛出原始 initialize error', async () => {
      const initializeError = new Error('fork initialize failed first');
      acpSessionMocks.nextInitializeError = initializeError;
      acpSessionMocks.destroyErrors = [new Error('temporary cleanup failed')];
      sessionServiceMocks.forkSession.mockResolvedValueOnce({
        sessionId: 'cleanup-failure-child',
        messages: [],
      });

      await expect(agent.unstable_forkSession(request)).rejects.toBe(initializeError);
      expect(sessionServiceMocks.deleteSession).not.toHaveBeenCalled();
    });

    it('应该在 fork catalog 调用前拒绝相对 cwd', async () => {
      await expect(
        agent.unstable_forkSession({ ...request, cwd: 'relative/project' })
      ).rejects.toThrow('ACP session fork cwd must be absolute');
      expect(sessionServiceMocks.forkSession).not.toHaveBeenCalled();
      expect(createdSessions).toHaveLength(0);
    });

    it.each([
      ['/tmp/wrong-project', 'Session forks must stay in the source workspace'],
      ['/tmp/project', 'Session source not found: missing-session'],
    ])('service 拒绝 %s 时不应该注册 child', async (cwd, message) => {
      sessionServiceMocks.forkSession.mockRejectedValueOnce(new Error(message));

      await expect(
        agent.unstable_forkSession({
          ...request,
          sessionId: message.includes('missing')
            ? 'missing-session'
            : request.sessionId,
          cwd,
        })
      ).rejects.toThrow(message);
      expect(createdSessions).toHaveLength(0);
    });

    it('应该把非空 MCP 配置原样传给 fork child', async () => {
      const mcpServers = [
        {
          name: 'project-tools',
          command: 'node',
          args: ['server.mjs'],
          env: [{ name: 'PROJECT_ROOT', value: '/tmp/project' }],
        },
      ];

      await agent.unstable_forkSession({ ...request, mcpServers });

      expect(AcpSession).toHaveBeenCalledWith(
        'forked-session',
        '/tmp/project',
        mockConnection,
        undefined,
        { initialMessages: [], mcpServers }
      );
    });
  });

  describe('loadSession', () => {
    it('应该按项目加载历史并在响应前回放给客户端', async () => {
      const history = [
        { role: 'user' as const, content: 'Original question' },
        { role: 'assistant' as const, content: 'Original answer' },
      ];
      sessionServiceMocks.loadSession.mockResolvedValue(history);
      acpSessionMocks.currentModelId = 'gpt-3.5';

      const response = await loadSession({
        sessionId: 'persisted-session',
        cwd: '/tmp/project',
        mcpServers: [],
      });

      expect(sessionServiceMocks.loadSession).toHaveBeenCalledWith(
        'persisted-session',
        '/tmp/project'
      );
      expect(AcpSession).toHaveBeenCalledWith(
        'persisted-session',
        '/tmp/project',
        mockConnection,
        undefined,
        { initialMessages: history, mcpServers: [] }
      );
      const loadedSession = createdSessions[0];
      expect(loadedSession.initialize).toHaveBeenCalledTimes(1);
      expect(loadedSession.replayHistory).toHaveBeenCalledTimes(1);
      expect(loadedSession.initialize.mock.invocationCallOrder[0]).toBeLessThan(
        loadedSession.replayHistory.mock.invocationCallOrder[0]
      );
      expect(response?.modes?.currentModeId).toBe('default');
      const modelOpt = response?.configOptions?.find((o: any) => o.id === 'model');
      expect(
        modelOpt && 'currentValue' in modelOpt ? modelOpt.currentValue : undefined
      ).toBe('gpt-3.5');
    });

    it('应该拒绝不存在的项目会话且不注册空 session', async () => {
      sessionServiceMocks.loadSession.mockRejectedValueOnce(
        new Error('未找到会话: missing-session')
      );

      await expect(
        loadSession({
          sessionId: 'missing-session',
          cwd: '/tmp/project',
          mcpServers: [],
        })
      ).rejects.toThrow('未找到会话');

      expect(createdSessions).toHaveLength(0);
    });

    it('重复加载同一 session 时应该先销毁旧 owner', async () => {
      await loadSession({
        sessionId: 'persisted-session',
        cwd: '/tmp/project',
        mcpServers: [],
      });
      await loadSession({
        sessionId: 'persisted-session',
        cwd: '/tmp/project',
        mcpServers: [],
      });

      const sessions = createdSessions;
      expect(sessions).toHaveLength(2);
      expect(sessions[0].destroy).toHaveBeenCalledTimes(1);
      expect(sessions[1].initialize).toHaveBeenCalledTimes(1);
      expect(sessions[0].destroy.mock.invocationCallOrder[0]).toBeLessThan(
        sessions[1].initialize.mock.invocationCallOrder[0]
      );
      expect(sessionServiceMocks.loadSession).toHaveBeenCalledTimes(2);
      expect(sessions[0].destroy.mock.invocationCallOrder[0]).toBeLessThan(
        sessionServiceMocks.loadSession.mock.invocationCallOrder[1]
      );
    });

    it('旧 owner destroy 失败时移除注册、传播错误且不读取或初始化 replacement', async () => {
      const request = {
        sessionId: 'persisted-session',
        cwd: '/tmp/project',
        mcpServers: [],
      };
      await loadSession(request);
      const oldOwner = createdSessions[0];
      const destroyError = new Error('old owner destroy failed');
      acpSessionMocks.destroyErrors = [destroyError];
      sessionServiceMocks.loadSession.mockClear();

      await expect(loadSession(request)).rejects.toBe(destroyError);

      expect(sessionServiceMocks.loadSession).not.toHaveBeenCalled();
      expect(createdSessions).toHaveLength(1);
      await expect(
        agent.prompt({
          sessionId: request.sessionId,
          prompt: [{ type: 'text', text: 'must not reach destroyed owner' }],
        })
      ).rejects.toThrow('Session not found: persisted-session');

      await expect(loadSession(request)).resolves.toBeDefined();
      expect(oldOwner.destroy).toHaveBeenCalledTimes(1);
      expect(createdSessions).toHaveLength(2);
    });

    it('initialize 失败后销毁临时 owner、不注册并允许再次 load', async () => {
      const request = {
        sessionId: 'persisted-session',
        cwd: '/tmp/project',
        mcpServers: [],
      };
      await loadSession(request);
      const initializeError = new Error('replacement initialize failed');
      acpSessionMocks.nextInitializeError = initializeError;

      await expect(loadSession(request)).rejects.toBe(initializeError);

      const sessionsAfterFailure = createdSessions;
      expect(sessionsAfterFailure).toHaveLength(2);
      expect(sessionsAfterFailure[0].destroy).toHaveBeenCalledTimes(1);
      expect(sessionsAfterFailure[1].destroy).toHaveBeenCalledTimes(1);
      await expect(
        agent.prompt({
          sessionId: request.sessionId,
          prompt: [{ type: 'text', text: 'temporary owner must not be registered' }],
        })
      ).rejects.toThrow('Session not found: persisted-session');

      await loadSession(request);
      const retriedOwner = createdSessions[2];
      await agent.prompt({
        sessionId: request.sessionId,
        prompt: [{ type: 'text', text: 'retry succeeds' }],
      });
      expect(retriedOwner.prompt).toHaveBeenCalledTimes(1);
    });

    it('history replay 失败后销毁临时 owner、不注册并允许再次 load', async () => {
      const request = {
        sessionId: 'replay-failure-session',
        cwd: '/tmp/project',
        mcpServers: [],
      };
      const replayError = new Error('history replay failed');
      acpSessionMocks.nextReplayError = replayError;

      await expect(loadSession(request)).rejects.toBe(replayError);

      const failedOwner = createdSessions[0];
      expect(failedOwner.destroy).toHaveBeenCalledTimes(1);
      await expect(
        agent.prompt({
          sessionId: request.sessionId,
          prompt: [{ type: 'text', text: 'failed owner must not be registered' }],
        })
      ).rejects.toThrow('Session not found: replay-failure-session');

      await loadSession(request);
      const retriedOwner = createdSessions[1];
      expect(retriedOwner.initialize).toHaveBeenCalledTimes(1);
      expect(retriedOwner.replayHistory).toHaveBeenCalledTimes(1);
    });

    it('并发 load 同一 ID 串行 replacement 且最终只注册最后 owner', async () => {
      const request = {
        sessionId: 'concurrent-session',
        cwd: '/tmp/project',
        mcpServers: [],
      };

      await Promise.all([loadSession(request), loadSession(request)]);

      const sessions = createdSessions;
      expect(sessions).toHaveLength(2);
      expect(sessions[0].destroy).toHaveBeenCalledTimes(1);
      expect(sessions[0].replayHistory.mock.invocationCallOrder[0]).toBeLessThan(
        sessions[0].destroy.mock.invocationCallOrder[0]
      );
      expect(sessions[0].destroy.mock.invocationCallOrder[0]).toBeLessThan(
        sessions[1].initialize.mock.invocationCallOrder[0]
      );

      await agent.prompt({
        sessionId: request.sessionId,
        prompt: [{ type: 'text', text: 'route to final owner' }],
      });
      expect(sessions[0].prompt).not.toHaveBeenCalled();
      expect(sessions[1].prompt).toHaveBeenCalledTimes(1);

      await agent.destroy();
      expect(sessions[0].destroy).toHaveBeenCalledTimes(1);
      expect(sessions[1].destroy).toHaveBeenCalledTimes(1);
    });
  });

  describe('authenticate', () => {
    it('应该直接返回（不需要认证）', async () => {
      const params = {
        methodId: 'none',
        credentials: {},
      };

      const response = await agent.authenticate(params);

      expect(response).toBeUndefined();
    });
  });

  describe('newSession', () => {
    it('应该创建新会话', async () => {
      const params = {
        cwd: '/tmp/test',
        mcpServers: [],
      };

      const response = await agent.newSession(params);

      expect(response).toBeDefined();
      expect(response.sessionId).toBeDefined();
      const modes = response.modes;
      expect(modes).toBeDefined();
      if (!modes) {
        throw new Error('modes is undefined');
      }
      expect(modes.availableModes).toEqual([
        {
          id: 'default',
          name: 'Default',
          description: 'Ask for confirmation before all file edits and commands',
        },
        {
          id: 'auto-edit',
          name: 'Auto Edit',
          description: 'Auto-approve file edits, ask for shell commands',
        },
        {
          id: 'yolo',
          name: 'Full Auto',
          description: 'Auto-approve everything without confirmation',
        },
        {
          id: 'plan',
          name: 'Plan Only',
          description: 'Read-only mode, no file changes or commands',
        },
      ]);
      expect(modes.currentModeId).toBe('default');
      const modelCfg = response.configOptions?.find((o: any) => o.id === 'model');
      expect(modelCfg).toBeDefined();
      expect(
        modelCfg && 'options' in modelCfg ? (modelCfg as any).options : []
      ).toHaveLength(2);
      expect(
        modelCfg && 'currentValue' in modelCfg ? modelCfg.currentValue : undefined
      ).toBe('gpt-4');
    });

    it('应该使用默认 cwd（当未提供时）', async () => {
      const params = {
        cwd: undefined as any,
        mcpServers: [],
      };

      const response = await agent.newSession(params);

      expect(response.sessionId).toBeDefined();
      // 验证会话已创建并调用 initialize
      expect(AcpSession).toHaveBeenCalled();
    });

    it('应该返回可用模型列表', async () => {
      const params = {
        cwd: '/tmp/test',
        mcpServers: [],
      };

      const response = await agent.newSession(params);

      const modelCfg2 = response.configOptions?.find((o: any) => o.id === 'model');
      expect(modelCfg2).toBeDefined();
      expect(
        modelCfg2 && 'options' in modelCfg2 ? (modelCfg2 as any).options : []
      ).toEqual([
        {
          value: 'gpt-4',
          name: 'GPT-4',
          description: 'openai/gpt-4',
        },
        {
          value: 'gpt-3.5',
          name: 'GPT-3.5',
          description: 'openai/gpt-4.1-mini',
        },
      ]);
      expect(
        modelCfg2 && 'currentValue' in modelCfg2 ? modelCfg2.currentValue : undefined
      ).toBe('gpt-4');
    });

    it('应该把客户端 MCP 配置交给 session runtime', async () => {
      const mcpServers = [
        {
          name: 'project-tools',
          command: 'node',
          args: ['server.mjs'],
          env: [{ name: 'PROJECT_ROOT', value: '/tmp/test' }],
        },
      ];

      await agent.newSession({ cwd: '/tmp/test', mcpServers });

      expect(AcpSession).toHaveBeenCalledWith(
        expect.any(String),
        '/tmp/test',
        mockConnection,
        undefined,
        { mcpServers }
      );
    });

    it('应该通过 namespaced metadata 创建隔离 task session', async () => {
      sessionTaskServiceMocks.createSessionTask.mockImplementationOnce(
        async (input: { sessionId: string }) => {
          const taskWorktree = {
            sessionId: input.sessionId,
            name: `task/${input.sessionId}`,
            branch: 'blade-worktree-acp-task',
            baseCommit: 'abc123',
            originalBranch: 'main',
            repositoryRoot: '/tmp/project',
            originalWorkspaceRoot: '/tmp/project',
            worktreeRoot: '/tmp/task-worktree',
            workspaceRoot: '/tmp/task-worktree',
            sourceHadChanges: false,
          };
          return {
            metadata: {
              sessionId: input.sessionId,
              projectPath: '/tmp/task-worktree',
              rootId: input.sessionId,
              taskStatus: 'queued',
              taskIsolation: 'worktree',
              taskSourceProjectPath: '/tmp/project',
              taskWorktreePath: '/tmp/task-worktree',
              taskWorktreeBranch: taskWorktree.branch,
              taskBaseCommit: taskWorktree.baseCommit,
              messageCount: 0,
              firstMessageTime: '2026-08-06T00:00:00.000Z',
              lastMessageTime: '2026-08-06T00:00:00.000Z',
              hasErrors: false,
            },
            taskWorktree,
          };
        }
      );

      const response = await agent.newSession({
        cwd: '/tmp/project',
        mcpServers: [],
        _meta: {
          'blade/taskIsolation': 'worktree',
          'blade/taskPrompt': 'Implement ACP task dispatch',
        },
      });

      expect(sessionTaskServiceMocks.createSessionTask).toHaveBeenCalledWith({
        sessionId: response.sessionId,
        prompt: 'Implement ACP task dispatch',
        sourceProjectPath: '/tmp/project',
        isolation: 'worktree',
      });
      expect(AcpSession).toHaveBeenCalledWith(
        response.sessionId,
        '/tmp/task-worktree',
        mockConnection,
        undefined,
        {
          mcpServers: [],
          taskIsolation: 'worktree',
          taskWorktree: expect.objectContaining({
            sessionId: response.sessionId,
            branch: 'blade-worktree-acp-task',
          }),
        }
      );
      expect(response._meta).toMatchObject({
        'blade/taskIsolation': 'worktree',
        'blade/taskSourceProjectPath': '/tmp/project',
        'blade/taskProjectPath': '/tmp/task-worktree',
        'blade/taskWorktreeBranch': 'blade-worktree-acp-task',
        'blade/taskBaseCommit': 'abc123',
      });
    });

    it('初始化失败时应该销毁未注册的 session', async () => {
      const initializeError = new Error('runtime initialization failed');
      acpSessionMocks.nextInitializeError = initializeError;

      await expect(
        agent.newSession({ cwd: '/tmp/test', mcpServers: [] })
      ).rejects.toThrow(initializeError);
      const session = createdSessions[0];
      expect(session.destroy).toHaveBeenCalledTimes(1);
    });
  });

  describe('prompt', () => {
    it('应该处理提示请求', async () => {
      // 先创建会话
      const newSessionResponse = await agent.newSession({
        cwd: '/tmp/test',
        mcpServers: [],
      });
      const sessionId = newSessionResponse.sessionId;

      const promptParams = {
        sessionId,
        prompt: [
          {
            type: 'text' as const,
            text: 'Hello, World!',
          },
        ],
      };

      const response = await agent.prompt(promptParams);

      expect(response).toBeDefined();
      expect(response.stopReason).toBe('end_turn');
    });

    it('应该拒绝未知会话的提示请求', async () => {
      const promptParams = {
        sessionId: 'nonexistent-session',
        prompt: [
          {
            type: 'text' as const,
            text: 'Hello, World!',
          },
        ],
      };

      await expect(agent.prompt(promptParams)).rejects.toThrow('Session not found');
    });
  });

  describe('cancel', () => {
    it('应该取消指定会话的操作', async () => {
      // 先创建会话
      const newSessionResponse = await agent.newSession({
        cwd: '/tmp/test',
        mcpServers: [],
      });
      const sessionId = newSessionResponse.sessionId;

      const cancelParams = {
        sessionId,
      };

      await agent.cancel(cancelParams);

      // 验证会话的 cancel 方法被调用
      const sessions = createdSessions;
      expect(sessions.length).toBe(1);
      expect(sessions[0].cancel).toHaveBeenCalled();
    });

    it('应该处理取消不存在的会话', async () => {
      const cancelParams = {
        sessionId: 'nonexistent-session',
      };

      // 不应该抛出错误
      await expect(agent.cancel(cancelParams)).resolves.toBeUndefined();
    });
  });

  describe('setSessionMode', () => {
    it('应该设置会话模式', async () => {
      // 先创建会话
      const newSessionResponse = await agent.newSession({
        cwd: '/tmp/test',
        mcpServers: [],
      });
      const sessionId = newSessionResponse.sessionId;

      const params = {
        sessionId,
        modeId: 'yolo',
      };

      const response = await agent.setSessionMode(params);

      expect(response).toEqual({});

      // 验证会话的 setMode 方法被调用
      const sessions = createdSessions;
      const sessionInstance = sessions[sessions.length - 1];
      expect(sessionInstance?.setMode).toHaveBeenCalledWith('yolo');
    });

    it('应该处理设置不存在会话的模式', async () => {
      const params = {
        sessionId: 'nonexistent-session',
        modeId: 'yolo',
      };

      const response = await agent.setSessionMode(params);

      expect(response).toEqual({});
    });
  });

  describe('setSessionConfigOption (model switch)', () => {
    it('应该设置会话模型', async () => {
      // 先创建会话
      const newSessionResponse = await agent.newSession({
        cwd: '/tmp/test',
        mcpServers: [],
      });
      const sessionId = newSessionResponse.sessionId;

      const response = await agent.setSessionConfigOption?.({
        sessionId,
        configId: 'model',
        value: 'gpt-3.5',
      });

      expect(response).toEqual({ configOptions: [] });

      // 验证会话的 setModel 方法被调用
      const sessions = createdSessions;
      const sessionInstance = sessions[sessions.length - 1];
      expect(sessionInstance?.setModel).toHaveBeenCalledWith('gpt-3.5');
    });

    it('应该拒绝为不存在的会话切换模型', async () => {
      await expect(
        agent.setSessionConfigOption?.({
          sessionId: 'nonexistent-session',
          configId: 'model',
          value: 'gpt-3.5',
        })
      ).rejects.toThrow('Session not found: nonexistent-session');
    });
  });

  describe('destroy', () => {
    it('等待 deferred load 收尾并销毁其临时 owner 后才完成', async () => {
      const initializeGate = createDeferredGate();
      acpSessionMocks.initializeGates.push(initializeGate);
      const sessionId = 'deferred-destroy-session';
      const load = loadSession({
        sessionId,
        cwd: '/tmp/project',
        mcpServers: [],
      });
      await vi.waitFor(() => {
        expect(createdSessions).toHaveLength(1);
        expect(createdSessions[0].initialize).toHaveBeenCalledTimes(1);
      });

      let destroySettled = false;
      const destroy = agent.destroy().finally(() => {
        destroySettled = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      const settledBeforeRelease = destroySettled;

      initializeGate.resolve();
      const [loadResult, destroyResult] = await Promise.allSettled([load, destroy]);

      expect(settledBeforeRelease).toBe(false);
      expect(loadResult).toMatchObject({
        status: 'rejected',
        reason: new Error('BladeAgent is destroyed'),
      });
      expect(destroyResult.status).toBe('fulfilled');
      expect(createdSessions[0].destroy).toHaveBeenCalledTimes(1);
      await expect(
        agent.prompt({
          sessionId,
          prompt: [{ type: 'text', text: 'must not reach deferred owner' }],
        })
      ).rejects.toThrow(`Session not found: ${sessionId}`);
      expect(mcpRegistryMocks.disconnectAll).toHaveBeenCalledTimes(1);
    });

    it('destroy 开始后拒绝新的 load、new 与 fork owner', async () => {
      const destroy = agent.destroy();
      const results = await Promise.allSettled([
        loadSession({
          sessionId: 'late-load',
          cwd: '/tmp/project',
          mcpServers: [],
        }),
        agent.newSession({ cwd: '/tmp/project', mcpServers: [] }),
        agent.unstable_forkSession({
          sessionId: 'parent-session',
          cwd: '/tmp/project',
          mcpServers: [],
        }),
      ]);
      await destroy;

      expect(results).toEqual([
        { status: 'rejected', reason: new Error('BladeAgent is destroyed') },
        { status: 'rejected', reason: new Error('BladeAgent is destroyed') },
        { status: 'rejected', reason: new Error('BladeAgent is destroyed') },
      ]);
      expect(createdSessions).toHaveLength(0);
      expect(mcpRegistryMocks.disconnectAll).toHaveBeenCalledTimes(1);
    });

    it('应该销毁所有会话', async () => {
      // 创建多个会话
      await agent.newSession({ cwd: '/tmp/test1', mcpServers: [] });
      await agent.newSession({ cwd: '/tmp/test2', mcpServers: [] });

      await agent.destroy();

      // 验证所有会话的 destroy 方法被调用
      const sessions = createdSessions;
      expect(sessions.length).toBe(2);

      for (const sessionInstance of sessions) {
        expect(sessionInstance?.destroy).toHaveBeenCalled();
      }
    });

    it('应该清理会话映射', async () => {
      // 创建会话
      const response = await agent.newSession({ cwd: '/tmp/test', mcpServers: [] });
      const sessionId = response.sessionId;

      // 验证会话存在
      const promptParams = {
        sessionId,
        prompt: [{ type: 'text' as const, text: 'test' }],
      };
      await agent.prompt(promptParams);

      // 销毁
      await agent.destroy();

      // 验证会话已被清理（后续提示应该失败）
      await expect(agent.prompt(promptParams)).rejects.toThrow('Session not found');
    });

    it('一个 session cleanup 失败时仍应该销毁其余 session 和 MCP 并抛第一个错误', async () => {
      await agent.newSession({ cwd: '/tmp/test1', mcpServers: [] });
      await agent.newSession({ cwd: '/tmp/test2', mcpServers: [] });
      const firstError = new Error('first session destroy failed');
      acpSessionMocks.destroyErrors = [firstError];

      await expect(agent.destroy()).rejects.toBe(firstError);

      const sessions = createdSessions;
      expect(sessions[0].destroy).toHaveBeenCalledTimes(1);
      expect(sessions[1].destroy).toHaveBeenCalledTimes(1);
      expect(mcpRegistryMocks.disconnectAll).toHaveBeenCalledTimes(1);
      await expect(
        agent.prompt({
          sessionId: sessions[1].id,
          prompt: [{ type: 'text', text: 'must be removed' }],
        })
      ).rejects.toThrow('Session not found');
    });
  });

  describe('会话管理', () => {
    it('应该正确管理多个会话', async () => {
      // 创建第一个会话
      const response1 = await agent.newSession({ cwd: '/tmp/test1', mcpServers: [] });
      const sessionId1 = response1.sessionId;

      // 创建第二个会话
      const response2 = await agent.newSession({ cwd: '/tmp/test2', mcpServers: [] });
      const sessionId2 = response2.sessionId;

      // 验证两个会话都有不同的 ID
      expect(sessionId1).toBeDefined();
      expect(sessionId2).toBeDefined();
      expect(sessionId1).not.toBe(sessionId2);

      // 验证两个会话都可以接收提示
      await agent.prompt({
        sessionId: sessionId1,
        prompt: [{ type: 'text' as const, text: 'test1' }],
      });

      await agent.prompt({
        sessionId: sessionId2,
        prompt: [{ type: 'text' as const, text: 'test2' }],
      });
    });

    it('应该独立取消不同会话', async () => {
      // 创建两个会话
      const response1 = await agent.newSession({ cwd: '/tmp/test1', mcpServers: [] });
      const response2 = await agent.newSession({ cwd: '/tmp/test2', mcpServers: [] });
      const sessionId1 = response1.sessionId;
      const sessionId2 = response2.sessionId;

      // 取消第一个会话
      await agent.cancel({ sessionId: sessionId1 });

      // 验证第二个会话仍然可用
      await agent.prompt({
        sessionId: sessionId2,
        prompt: [{ type: 'text' as const, text: 'test' }],
      });

      // 验证第一个会话已被取消
      const sessions = createdSessions;
      const sessionInstance1 = sessions[0];
      const sessionInstance2 = sessions[1];
      expect(sessionInstance1?.cancel).toHaveBeenCalled();
      expect(sessionInstance2?.cancel).not.toHaveBeenCalled();
    });
  });

  describe('可用命令', () => {
    it('应该在创建会话后发送可用命令', async () => {
      await agent.newSession({ cwd: '/tmp/test', mcpServers: [] });

      // 等待延迟执行（500ms）
      await new Promise((resolve) => setTimeout(resolve, 600));

      // 验证会话的 sendAvailableCommandsDelayed 方法被调用
      const sessions = createdSessions;
      const sessionInstance = sessions[sessions.length - 1];
      expect(sessionInstance?.sendAvailableCommandsDelayed).toHaveBeenCalled();
    });
  });
});

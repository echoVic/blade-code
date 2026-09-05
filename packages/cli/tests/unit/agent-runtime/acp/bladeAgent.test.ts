/**
 * BladeAgent 测试
 */

import {
  type ClientCapabilities,
  type ForkSessionRequest,
  type ListSessionsRequest,
  type LoadSessionRequest,
  type LoadSessionResponse,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
} from '../../../../src/acp/AcpRemoteWorkspace.js';
import { BladeAgent } from '../../../../src/acp/BladeAgent.js';
import { AcpSession } from '../../../../src/acp/Session.js';
import type { CommunicationStyleConfiguration } from '../../../../src/services/communicationStyle.js';
import { ControlledFileClient } from '../../../support/acp/ControlledFileClient.js';
import {
  createPairedAcpHarness,
  type PairedAcpHarness,
} from '../../../support/acp/createPairedAcpHarness.js';
import { createMockACPClient } from '../../../support/mocks/mockACPClient.js';

const sessionServiceMocks = vi.hoisted(() => ({
  assertSessionWritable: vi.fn(),
  assertRemoteSessionWritable: vi.fn(),
  createRemoteSessionMetadata: vi.fn(),
  deleteSession: vi.fn(),
  forkSession: vi.fn(),
  findSessionMetadata: vi.fn(),
  listSessionPage: vi.fn(),
  listRemoteSessionPage: vi.fn(),
  loadSession: vi.fn(),
  loadRemoteSession: vi.fn(),
}));

const sessionTaskServiceMocks = vi.hoisted(() => ({
  createSessionTask: vi.fn(),
}));

type AcpSessionConstructorArgs = ConstructorParameters<typeof AcpSession>;
interface MockAcpSessionInstance {
  id: string;
  roots: AcpSessionConstructorArgs[1];
  connection: AcpSessionConstructorArgs[2];
  clientCapabilities: AcpSessionConstructorArgs[3];
  options: AcpSessionConstructorArgs[4];
  initialize: ReturnType<typeof vi.fn<() => Promise<void>>>;
  prompt: ReturnType<typeof vi.fn<AcpSession['prompt']>>;
  cancel: ReturnType<typeof vi.fn<AcpSession['cancel']>>;
  setMode: ReturnType<typeof vi.fn<AcpSession['setMode']>>;
  setModel: ReturnType<typeof vi.fn<AcpSession['setModel']>>;
  setReasoningEffort: ReturnType<typeof vi.fn<AcpSession['setReasoningEffort']>>;
  setServiceTier: ReturnType<typeof vi.fn<AcpSession['setServiceTier']>>;
  setResponseVerbosity: ReturnType<typeof vi.fn<AcpSession['setResponseVerbosity']>>;
  setCommunicationStyle: ReturnType<typeof vi.fn<AcpSession['setCommunicationStyle']>>;
  getCurrentModelId: ReturnType<typeof vi.fn<AcpSession['getCurrentModelId']>>;
  getModelConfiguration: ReturnType<typeof vi.fn<AcpSession['getModelConfiguration']>>;
  getMode: ReturnType<typeof vi.fn<AcpSession['getMode']>>;
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

function localRoots(root: string) {
  return {
    kind: 'local' as const,
    hostStateRoot: root,
    executionRoot: root,
    hostResourceRoot: root,
  };
}

function isRequestErrorWithData(
  error: unknown
): error is RequestError & { data: Record<string, unknown> } {
  return (
    error instanceof RequestError &&
    typeof error.data === 'object' &&
    error.data !== null
  );
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
const runtimeResidencyConfig = vi.hoisted(() => ({
  maxResident: 32,
  idleMs: 300_000,
}));
const cwdState = vi.hoisted(() => ({ value: '/trusted/agent-start' }));

// Mock AcpSession
// Vitest 4: vi.fn().mockImplementation(arrowFn) is not constructable with `new`.
// Use a class wrapper delegating to the mock implementation to ensure constructability.
vi.mock('../../../../src/acp/Session.js', () => {
  const mockAcpSessionImpl = (
    ...[id, roots, connection, clientCapabilities, options]: AcpSessionConstructorArgs
  ): MockAcpSessionInstance => {
    const session: MockAcpSessionInstance = {
      id,
      roots,
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
      setReasoningEffort: vi.fn().mockResolvedValue(undefined),
      setServiceTier: vi.fn().mockResolvedValue(undefined),
      setResponseVerbosity: vi.fn().mockResolvedValue(undefined),
      setCommunicationStyle: vi.fn().mockResolvedValue(undefined),
      getCurrentModelId: vi.fn(() => acpSessionMocks.currentModelId),
      getModelConfiguration: vi.fn(() => ({
        currentModelId: ['gpt-4', 'gpt-3.5'].includes(acpSessionMocks.currentModelId)
          ? acpSessionMocks.currentModelId
          : 'gpt-4',
        models: [
          {
            id: 'gpt-4',
            displayName: 'GPT-4',
            provider: 'openai',
            model: 'gpt-4',
          },
          {
            id: 'gpt-3.5',
            displayName: 'GPT-3.5',
            provider: 'team-gateway',
            model: 'gpt-4.1-mini',
          },
        ],
        modelProviders: {
          'team-gateway': {
            name: 'Team Gateway',
            baseUrl: 'https://gateway.example.test/v1',
            wireApi: 'openai-completions',
          },
        },
        reasoning: {
          selection: 'off',
          effective: 'off',
          supported: ['off', 'low', 'medium', 'high'],
        },
        serviceTier: {
          selection: 'auto',
          effective: 'provider-default',
          supported: ['standard', 'fast', 'flex'],
        },
        responseVerbosity: {
          selection: 'auto',
          effective: 'provider-default',
          supported: ['low', 'medium', 'high'],
        },
        communicationStyle: {
          selection: 'auto',
          effective: 'blade-default',
          name: 'Auto',
          description: 'Use the Blade default communication style',
          source: 'built-in',
          supported: [
            {
              id: 'auto',
              name: 'Auto',
              description: 'Use the Blade default communication style',
              source: 'built-in',
            },
            {
              id: 'project:security-review',
              name: 'Security Review',
              description: 'Prioritize concrete security findings',
              source: 'project',
              contentSha256: 'a'.repeat(64),
            },
          ],
        } satisfies CommunicationStyleConfiguration,
      })),
      getMode: vi.fn(() => (options?.permissionMode === 'yolo' ? 'yolo' : 'default')),
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
    createLocalAcpSessionRoots: localRoots,
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
    assertSessionWritable: sessionServiceMocks.assertSessionWritable,
    assertRemoteSessionWritable: sessionServiceMocks.assertRemoteSessionWritable,
    createRemoteSessionMetadata: sessionServiceMocks.createRemoteSessionMetadata,
    deleteSession: sessionServiceMocks.deleteSession,
    forkSession: sessionServiceMocks.forkSession,
    findSessionMetadata: sessionServiceMocks.findSessionMetadata,
    listSessionPage: sessionServiceMocks.listSessionPage,
    listRemoteSessionPage: sessionServiceMocks.listRemoteSessionPage,
    loadSession: sessionServiceMocks.loadSession,
    loadRemoteSession: sessionServiceMocks.loadRemoteSession,
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
  ensureStoreInitialized: vi.fn(async () => undefined),
  getConfig: vi.fn(() => ({
    models: [
      { id: 'gpt-4', displayName: 'GPT-4', provider: 'openai', model: 'gpt-4' },
      {
        id: 'gpt-3.5',
        displayName: 'GPT-3.5',
        provider: 'team-gateway',
        model: 'gpt-4.1-mini',
      },
    ],
    modelProviders: {
      'team-gateway': {
        name: 'Team Gateway',
        baseUrl: 'https://gateway.example.test/v1',
        wireApi: 'openai-completions',
      },
    },
    currentModelId: 'gpt-4',
    maxResidentSessionRuntimes: runtimeResidencyConfig.maxResident,
    sessionRuntimeIdleMs: runtimeResidencyConfig.idleMs,
  })),
}));

vi.mock('../../../../src/utils/cwd.js', () => ({
  getCwd: vi.fn(() => cwdState.value),
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
  const remoteHarnesses: PairedAcpHarness[] = [];
  const remoteFsCapabilities: ClientCapabilities = {
    fs: {
      readTextFile: true,
      writeTextFile: true,
    },
  };
  const remoteProfile = createAcpRemotePathProfile('C:/Workspace/Child');
  const remoteDescriptor = createAcpRemoteWorkspaceDescriptor(remoteProfile);
  const remoteHostStateRoot = deriveAcpRemoteHostStateRoot(
    remoteDescriptor.collisionIdentity
  );

  function loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return (
      agent as BladeAgent & {
        loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>;
      }
    ).loadSession(params);
  }

  async function initializeRemoteFsNegotiation(): Promise<void> {
    await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: remoteFsCapabilities,
    });
  }

  async function configureRemoteFsAgent(): Promise<PairedAcpHarness> {
    const harness = createPairedAcpHarness(new ControlledFileClient());
    remoteHarnesses.push(harness);
    agent = new BladeAgent(harness.agentConnection);
    await initializeRemoteFsNegotiation();
    return harness;
  }

  beforeEach(() => {
    createdSessions.length = 0;
    runtimeResidencyConfig.maxResident = 32;
    runtimeResidencyConfig.idleMs = 300_000;
    cwdState.value = '/trusted/agent-start';

    // 创建 mock 连接
    mockConnection = createMockACPClient();

    // 创建 BladeAgent 实例
    agent = new BladeAgent(mockConnection as any);
    sessionServiceMocks.listSessionPage.mockResolvedValue({ sessions: [] });
    sessionServiceMocks.listRemoteSessionPage.mockResolvedValue({ sessions: [] });
    sessionServiceMocks.forkSession.mockImplementation(
      async (_sourceSessionId, options: { newSessionId: string }) => ({
        sessionId: options.newSessionId,
        messages: [],
        metadata: {
          permissionMode: 'default',
        },
      })
    );
    sessionServiceMocks.findSessionMetadata.mockResolvedValue({
      permissionMode: 'default',
    });
    sessionServiceMocks.loadSession.mockResolvedValue([]);
    sessionServiceMocks.loadRemoteSession.mockResolvedValue([]);
    sessionServiceMocks.createRemoteSessionMetadata.mockResolvedValue({
      permissionMode: 'default',
      projectPath: remoteHostStateRoot,
      remoteWorkspace: remoteDescriptor,
    });
    sessionServiceMocks.assertRemoteSessionWritable.mockResolvedValue({
      permissionMode: 'default',
      projectPath: remoteHostStateRoot,
      remoteWorkspace: remoteDescriptor,
    });
    sessionTaskServiceMocks.createSessionTask.mockReset();
    acpSessionMocks.destroyErrors = [];
    acpSessionMocks.initializeGates = [];
    acpSessionMocks.nextInitializeError = null;
    acpSessionMocks.nextReplayError = null;
    acpSessionMocks.currentModelId = 'model-1';
  });

  afterEach(async () => {
    await Promise.all(remoteHarnesses.splice(0).map((harness) => harness.close()));
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
        close: {},
      });
      expect(JSON.stringify(agentCapabilities)).not.toContain('followUpQueue');
      expect(JSON.stringify(agentCapabilities)).not.toContain('queueMutation');
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

    it('remote list 在给出 cwd 时应该改走 listRemoteSessionPage 且只返回 wirePath cwd', async () => {
      await configureRemoteFsAgent();
      sessionServiceMocks.listRemoteSessionPage.mockResolvedValueOnce({
        sessions: [
          {
            sessionId: 'remote-session',
            projectPath: '/host/state/root',
            remoteWorkspace: remoteDescriptor,
            title: 'Remote title',
            taskStatus: 'running',
            lastMessageTime: '2026-09-01T00:00:00.000Z',
          },
        ],
        nextCursor: 'remote-cursor',
      });

      const response = await agent.listSessions({
        cwd: 'C:/Workspace/Child',
        cursor: 'remote-page',
      });

      expect(sessionServiceMocks.listRemoteSessionPage).toHaveBeenCalledWith({
        descriptor: remoteDescriptor,
        cursor: 'remote-page',
        limit: 50,
        includeSubagents: false,
      });
      expect(sessionServiceMocks.listSessionPage).not.toHaveBeenCalled();
      expect(response).toEqual({
        sessions: [
          {
            sessionId: 'remote-session',
            cwd: 'C:\\Workspace\\Child',
            title: 'Remote title',
            updatedAt: '2026-09-01T00:00:00.000Z',
            _meta: {
              'blade/taskStatus': 'running',
            },
          },
        ],
        nextCursor: 'remote-cursor',
      });
    });

    it('remote list 在无 cwd 时应该列出全部 remote sessions', async () => {
      await configureRemoteFsAgent();

      await agent.listSessions({ cwd: null, cursor: null });

      expect(sessionServiceMocks.listRemoteSessionPage).toHaveBeenCalledWith({
        cursor: undefined,
        limit: 50,
        includeSubagents: false,
      });
      expect(sessionServiceMocks.listSessionPage).not.toHaveBeenCalled();
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
      sessionServiceMocks.forkSession.mockImplementationOnce(
        async (_sourceSessionId, options: { newSessionId: string }) => ({
          sessionId: options.newSessionId,
          messages,
          metadata: { permissionMode: 'yolo' },
        })
      );

      const response = await agent.unstable_forkSession(request);

      expect(sessionServiceMocks.forkSession).toHaveBeenCalledWith('parent-session', {
        sourceProjectPath: '/tmp/project',
        targetProjectPath: '/tmp/project',
        newSessionId: response.sessionId,
      });
      expect(AcpSession).toHaveBeenCalledWith(
        response.sessionId,
        localRoots('/tmp/project'),
        mockConnection,
        undefined,
        { initialMessages: messages, permissionMode: 'yolo', mcpServers: [] }
      );
      const child = createdSessions[0];
      expect(child.initialize).toHaveBeenCalledTimes(1);
      expect(child.replayHistory).not.toHaveBeenCalled();
      expect(child.sendAvailableCommandsDelayed).toHaveBeenCalledTimes(1);
      expect(response).toMatchObject({
        modes: { currentModeId: 'yolo' },
      });
      const forkModelCfg = response.configOptions?.find((o: any) => o.id === 'model');
      expect(
        forkModelCfg && 'currentValue' in forkModelCfg
          ? forkModelCfg.currentValue
          : undefined
      ).toBe('gpt-4');

      await agent.prompt({
        sessionId: response.sessionId,
        prompt: [{ type: 'text', text: 'Continue in the child' }],
      });
      expect(child.prompt).toHaveBeenCalledTimes(1);
    });

    it('应该让 fork 与 new 返回相同的 modes 和 config setup', async () => {
      const created = await agent.newSession({
        cwd: '/tmp/project',
        mcpServers: [],
      });
      const forked = await agent.unstable_forkSession(request);
      const { sessionId: _createdId, ...createdSetup } = created;
      const { sessionId: _forkedId, _meta: _forkMeta, ...forkedSetup } = forked;

      expect(forkedSetup).toEqual(createdSetup);
    });

    it('应该在初始化失败时销毁临时 child 并保留 durable transcript', async () => {
      const initializeError = new Error('fork runtime initialization failed');
      acpSessionMocks.nextInitializeError = initializeError;

      await expect(agent.unstable_forkSession(request)).rejects.toBe(initializeError);

      const child = createdSessions[0];
      expect(child.destroy).toHaveBeenCalledTimes(1);
      expect(sessionServiceMocks.deleteSession).not.toHaveBeenCalled();
      const forkSessionId = sessionServiceMocks.forkSession.mock.calls[0]?.[1]
        .newSessionId as string;
      await expect(
        agent.prompt({
          sessionId: forkSessionId,
          prompt: [{ type: 'text', text: 'must not be registered' }],
        })
      ).rejects.toThrow(`Session not found: ${forkSessionId}`);
    });

    it('remote fork 初始化失败时保留 durable child 且不注册 runtime owner', async () => {
      await configureRemoteFsAgent();
      const initializeError = new Error('remote fork runtime initialization failed');
      acpSessionMocks.nextInitializeError = initializeError;
      sessionServiceMocks.forkSession.mockImplementationOnce(
        async (
          _sourceSessionId,
          options: {
            newSessionId: string;
            targetProjectPath: string;
          }
        ) => ({
          sessionId: options.newSessionId,
          projectPath: options.targetProjectPath,
          messages: [],
          metadata: {
            permissionMode: 'default',
            projectPath: options.targetProjectPath,
            remoteWorkspace: remoteDescriptor,
          },
        })
      );

      await expect(
        agent.unstable_forkSession({
          sessionId: 'remote-parent',
          cwd: remoteDescriptor.wirePath,
          mcpServers: [],
        })
      ).rejects.toBe(initializeError);

      const child = createdSessions[0];
      expect(child.destroy).toHaveBeenCalledTimes(1);
      expect(sessionServiceMocks.deleteSession).not.toHaveBeenCalled();
      const childSessionId = sessionServiceMocks.forkSession.mock.calls[0]?.[1]
        .newSessionId as string;
      await expect(
        agent.prompt({
          sessionId: childSessionId,
          prompt: [{ type: 'text', text: 'runtime owner must not exist' }],
        })
      ).rejects.toThrow(`Session not found: ${childSessionId}`);
    });

    it('cleanup 失败时仍应该抛出原始 initialize error', async () => {
      const initializeError = new Error('fork initialize failed first');
      acpSessionMocks.nextInitializeError = initializeError;
      acpSessionMocks.destroyErrors = [new Error('temporary cleanup failed')];
      sessionServiceMocks.forkSession.mockResolvedValueOnce({
        sessionId: 'cleanup-failure-child',
        messages: [],
        metadata: { permissionMode: 'default' },
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

    it('在 remote fs 下应该先校验 fork cwd，再进入 runtime reservation 或 durable fork', async () => {
      await agent.destroy();
      runtimeResidencyConfig.maxResident = 0;
      await configureRemoteFsAgent();

      const result = await agent
        .unstable_forkSession({
          ...request,
          cwd: 'C:relative\\project',
        })
        .catch((error: unknown) => error);

      expect(result).toMatchObject({
        name: 'RequestError',
        code: -32602,
        message: 'Invalid params',
        data: {
          code: 'acp_remote_path_invalid',
          reason: 'drive-relative',
        },
      });
      expect(JSON.stringify(result)).not.toContain('C:relative\\project');
      expect(sessionServiceMocks.forkSession).not.toHaveBeenCalled();
      expect(createdSessions).toHaveLength(0);
    });

    it('remote fork 成功后应该使用 durable 返回的 child projectPath 构建子会话 profile', async () => {
      const remoteHarness = await configureRemoteFsAgent();
      sessionServiceMocks.forkSession.mockImplementationOnce(
        async (
          _sourceSessionId,
          options: {
            newSessionId: string;
            remote?: { expectedDescriptor: unknown };
            sourceProjectPath: string;
            targetProjectPath: string;
          }
        ) => ({
          sessionId: options.newSessionId,
          projectPath: deriveAcpRemoteHostStateRoot(remoteDescriptor.collisionIdentity),
          messages: [],
          metadata: {
            permissionMode: 'default',
            projectPath: options.targetProjectPath,
            remoteWorkspace: remoteDescriptor,
          },
        })
      );

      const response = await agent.unstable_forkSession({
        sessionId: 'parent-session',
        cwd: 'C:/Workspace/Child',
        mcpServers: [],
      });

      expect(sessionServiceMocks.forkSession).toHaveBeenCalledWith('parent-session', {
        sourceProjectPath: remoteHostStateRoot,
        targetProjectPath: remoteHostStateRoot,
        newSessionId: response.sessionId,
        remote: {
          expectedDescriptor: remoteDescriptor,
        },
      });

      expect(AcpSession).toHaveBeenCalledWith(
        response.sessionId,
        {
          kind: 'acp-remote',
          hostStateRoot: remoteHostStateRoot,
          executionRoot: remoteDescriptor.wirePath,
          hostResourceRoot: expect.any(String),
          profile: remoteProfile,
          descriptor: remoteDescriptor,
        },
        remoteHarness.agentConnection,
        remoteFsCapabilities,
        {
          initialMessages: [],
          permissionMode: 'default',
          mcpServers: [],
        }
      );
      expect(response._meta).toBeUndefined();
      expect(JSON.stringify(response)).not.toContain(remoteHostStateRoot);
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

      const response = await agent.unstable_forkSession({
        ...request,
        mcpServers,
      });

      expect(AcpSession).toHaveBeenCalledWith(
        response.sessionId,
        localRoots('/tmp/project'),
        mockConnection,
        undefined,
        {
          initialMessages: [],
          permissionMode: 'default',
          mcpServers,
        }
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
      sessionServiceMocks.findSessionMetadata.mockResolvedValueOnce({
        permissionMode: 'yolo',
      });
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
        localRoots('/tmp/project'),
        mockConnection,
        undefined,
        {
          initialMessages: history,
          permissionMode: 'yolo',
          mcpServers: [],
        }
      );
      const loadedSession = createdSessions[0];
      expect(loadedSession.initialize).toHaveBeenCalledTimes(1);
      expect(loadedSession.replayHistory).toHaveBeenCalledTimes(1);
      expect(loadedSession.initialize.mock.invocationCallOrder[0]).toBeLessThan(
        loadedSession.replayHistory.mock.invocationCallOrder[0]
      );
      expect(response?.modes?.currentModeId).toBe('yolo');
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

    it('应该在读取历史或替换 owner 前拒绝归档会话', async () => {
      sessionServiceMocks.assertSessionWritable.mockRejectedValueOnce(
        new Error('Session is archived: archived-session')
      );

      await expect(
        loadSession({
          sessionId: 'archived-session',
          cwd: '/tmp/project',
          mcpServers: [],
        })
      ).rejects.toThrow('Session is archived');

      expect(sessionServiceMocks.loadSession).not.toHaveBeenCalled();
      expect(createdSessions).toHaveLength(0);
    });

    it('remote load 在 exact identity 不匹配时应该先拒绝且保留 resident owner', async () => {
      await configureRemoteFsAgent();
      const storedProfile = createAcpRemotePathProfile('C:/Workspace');
      const storedDescriptor = createAcpRemoteWorkspaceDescriptor(storedProfile);
      const storedRoot = deriveAcpRemoteHostStateRoot(
        storedDescriptor.collisionIdentity
      );
      sessionServiceMocks.assertRemoteSessionWritable.mockResolvedValueOnce({
        permissionMode: 'default',
        projectPath: storedRoot,
        remoteWorkspace: storedDescriptor,
      });
      sessionServiceMocks.loadRemoteSession.mockResolvedValueOnce([]);

      await loadSession({
        sessionId: 'persisted-session',
        cwd: 'C:\\Workspace',
        mcpServers: [],
      });

      const originalOwner = createdSessions[0];
      const mismatchError = new Error('mismatch');
      Object.assign(mismatchError, {
        code: 'acp_remote_workspace_mismatch',
        reason: 'exact-identity-mismatch',
      });
      sessionServiceMocks.assertRemoteSessionWritable.mockRejectedValueOnce(
        mismatchError
      );

      const result = await loadSession({
        sessionId: 'persisted-session',
        cwd: 'c:/workspace',
        mcpServers: [],
      }).catch((error: unknown) => error);

      expect(result).toMatchObject({
        name: 'RequestError',
        code: -32602,
        message: 'Invalid params',
        data: {
          code: 'acp_remote_workspace_mismatch',
          reason: 'exact-identity-mismatch',
        },
      });
      if (!isRequestErrorWithData(result)) {
        throw new Error('expected RequestError with object data');
      }
      expect(result.data).not.toHaveProperty('cwd');
      expect(result.data).not.toHaveProperty('path');
      expect(originalOwner.destroy).not.toHaveBeenCalled();
      expect(createdSessions).toHaveLength(1);
      await agent.prompt({
        sessionId: 'persisted-session',
        prompt: [{ type: 'text', text: 'resident owner must survive mismatch' }],
      });
      expect(originalOwner.prompt).toHaveBeenCalledTimes(1);
    });

    it('remote load 成功时应该使用 persisted wirePath 与 frozen profile', async () => {
      const remoteHarness = await configureRemoteFsAgent();
      const persistedProfile = createAcpRemotePathProfile('C:/Workspace/./Child');
      const persistedDescriptor = createAcpRemoteWorkspaceDescriptor(persistedProfile);
      const persistedRoot = deriveAcpRemoteHostStateRoot(
        persistedDescriptor.collisionIdentity
      );
      sessionServiceMocks.assertRemoteSessionWritable.mockResolvedValueOnce({
        permissionMode: 'yolo',
        projectPath: persistedRoot,
        remoteWorkspace: persistedDescriptor,
      });
      sessionServiceMocks.loadRemoteSession.mockResolvedValueOnce([]);

      await loadSession({
        sessionId: 'persisted-session',
        cwd: 'C:/Workspace/Child',
        mcpServers: [],
      });

      expect(sessionServiceMocks.assertRemoteSessionWritable).toHaveBeenCalledWith(
        'persisted-session',
        persistedRoot,
        remoteDescriptor
      );
      expect(sessionServiceMocks.loadRemoteSession).toHaveBeenCalledWith(
        'persisted-session',
        persistedRoot,
        persistedDescriptor
      );
      expect(sessionServiceMocks.loadSession).not.toHaveBeenCalled();

      expect(AcpSession).toHaveBeenCalledWith(
        'persisted-session',
        {
          kind: 'acp-remote',
          hostStateRoot: persistedRoot,
          executionRoot: persistedDescriptor.wirePath,
          hostResourceRoot: expect.any(String),
          profile: persistedProfile,
          descriptor: persistedDescriptor,
        },
        remoteHarness.agentConnection,
        remoteFsCapabilities,
        {
          initialMessages: [],
          permissionMode: 'yolo',
          mcpServers: [],
        }
      );
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
          description: 'openai · gpt-4',
        },
        {
          value: 'gpt-3.5',
          name: 'GPT-3.5',
          description: 'Team Gateway · gpt-4.1-mini',
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
        localRoots('/tmp/test'),
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
        localRoots('/tmp/task-worktree'),
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

    it('在 remote fs 下应该先校验 invalid cwd，再进入 runtime reservation', async () => {
      await agent.destroy();
      runtimeResidencyConfig.maxResident = 0;
      await configureRemoteFsAgent();

      const result = await agent
        .newSession({
          cwd: 'C:relative\\project',
          mcpServers: [],
        })
        .catch((error: unknown) => error);

      expect(result).toMatchObject({
        name: 'RequestError',
        code: -32602,
        message: 'Invalid params',
        data: {
          code: 'acp_remote_path_invalid',
          reason: 'drive-relative',
        },
      });
      expect(JSON.stringify(result)).not.toContain('C:relative\\project');
      expect(createdSessions).toHaveLength(0);
    });

    it('remote new 应该在 reservation 后创建 remote metadata，且不把 hostResourceRoot 交给请求 cwd 覆盖', async () => {
      const remoteHarness = await configureRemoteFsAgent();
      cwdState.value = '/changed/after-agent-construction';
      sessionServiceMocks.createRemoteSessionMetadata.mockImplementationOnce(
        async (sessionId, hostStateRoot, descriptor) => ({
          sessionId,
          permissionMode: 'default',
          projectPath: hostStateRoot,
          remoteWorkspace: descriptor,
        })
      );

      const response = await agent.newSession({
        cwd: 'C:/Workspace/Child',
        mcpServers: [],
      });

      expect(sessionServiceMocks.createRemoteSessionMetadata).toHaveBeenCalledWith(
        response.sessionId,
        remoteHostStateRoot,
        remoteDescriptor,
        {}
      );
      expect(AcpSession).toHaveBeenCalledWith(
        response.sessionId,
        {
          kind: 'acp-remote',
          hostStateRoot: remoteHostStateRoot,
          executionRoot: remoteDescriptor.wirePath,
          hostResourceRoot: '/trusted/agent-start',
          profile: remoteProfile,
          descriptor: remoteDescriptor,
        },
        remoteHarness.agentConnection,
        remoteFsCapabilities,
        { mcpServers: [] }
      );
      expect(response._meta).toBeUndefined();
      expect(JSON.stringify(response)).not.toContain(remoteHostStateRoot);
    });

    it('remote new 应该在有效 cwd 解析后先拒绝 runtime capacity，再创建 private metadata', async () => {
      await agent.destroy();
      runtimeResidencyConfig.maxResident = 1;
      await configureRemoteFsAgent();
      await agent.newSession({
        cwd: remoteDescriptor.wirePath,
        mcpServers: [],
      });
      sessionServiceMocks.createRemoteSessionMetadata.mockClear();
      const residentSessionCount = createdSessions.length;

      await expect(
        agent.newSession({
          cwd: remoteDescriptor.wirePath,
          mcpServers: [],
        })
      ).rejects.toMatchObject({
        name: 'RequestError',
        code: -32603,
        data: { resource: 'resident_runtimes', limit: 1, retryable: true },
      });

      expect(sessionServiceMocks.createRemoteSessionMetadata).not.toHaveBeenCalled();
      expect(createdSessions).toHaveLength(residentSessionCount);
    });

    it.each(['local', 'worktree'] as const)(
      '在 remote fs 下应该先拒绝 taskIsolation=%s，再进入 runtime reservation 或 durable task',
      async (taskIsolation) => {
        await agent.destroy();
        runtimeResidencyConfig.maxResident = 0;
        await configureRemoteFsAgent();

        const result = await agent
          .newSession({
            cwd: 'C:\\Workspace',
            mcpServers: [],
            _meta: {
              'blade/taskIsolation': taskIsolation,
            },
          })
          .catch((error: unknown) => error);

        expect(result).toMatchObject({
          name: 'RequestError',
          code: -32602,
          message: 'Invalid params',
          data: {
            code: 'acp_remote_task_isolation_unsupported',
            reason: 'remote task isolation is not supported',
          },
        });
        expect(JSON.stringify(result)).not.toContain('C:\\Workspace');
        expect(sessionTaskServiceMocks.createSessionTask).not.toHaveBeenCalled();
        expect(createdSessions).toHaveLength(0);
      }
    );

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

      expect(response?.configOptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'model' }),
          expect.objectContaining({
            id: 'reasoning_effort',
            currentValue: 'off',
          }),
          expect.objectContaining({
            id: 'service_tier',
            currentValue: 'auto',
          }),
          expect.objectContaining({
            id: 'response_verbosity',
            currentValue: 'auto',
          }),
          expect.objectContaining({
            id: 'communication_style',
            currentValue: 'auto',
            options: expect.arrayContaining([
              expect.objectContaining({
                value: 'project:security-review',
                name: 'Security Review',
              }),
            ]),
          }),
        ])
      );

      // 验证会话的 setModel 方法被调用
      const sessions = createdSessions;
      const sessionInstance = sessions[sessions.length - 1];
      expect(sessionInstance?.setModel).toHaveBeenCalledWith('gpt-3.5');
    });

    it('应该通过标准 config option 设置 Session service tier', async () => {
      const created = await agent.newSession({
        cwd: '/tmp/test',
        mcpServers: [],
      });
      const response = await agent.setSessionConfigOption?.({
        sessionId: created.sessionId,
        configId: 'service_tier',
        value: 'fast',
      });
      const sessionInstance = createdSessions.at(-1);
      expect(sessionInstance?.setServiceTier).toHaveBeenCalledWith('fast');
      expect(response?.configOptions).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'service_tier' })])
      );
    });

    it('应该通过标准 config option 设置 Session response verbosity', async () => {
      const created = await agent.newSession({
        cwd: '/tmp/test',
        mcpServers: [],
      });
      const response = await agent.setSessionConfigOption?.({
        sessionId: created.sessionId,
        configId: 'response_verbosity',
        value: 'high',
      });
      const sessionInstance = createdSessions.at(-1);
      expect(sessionInstance?.setResponseVerbosity).toHaveBeenCalledWith('high');
      expect(response?.configOptions).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'response_verbosity' })])
      );
    });

    it('应该通过标准 config option 设置 Session communication style', async () => {
      const created = await agent.newSession({
        cwd: '/tmp/test',
        mcpServers: [],
      });
      const response = await agent.setSessionConfigOption?.({
        sessionId: created.sessionId,
        configId: 'communication_style',
        value: 'friendly',
      });
      const sessionInstance = createdSessions.at(-1);
      expect(sessionInstance?.setCommunicationStyle).toHaveBeenCalledWith('friendly');
      expect(response?.configOptions).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'communication_style' })])
      );
    });

    it('应该通过标准 config option 设置 Session reasoning effort', async () => {
      const created = await agent.newSession({
        cwd: '/tmp/test',
        mcpServers: [],
      });
      const response = await agent.setSessionConfigOption?.({
        sessionId: created.sessionId,
        configId: 'reasoning_effort',
        value: 'high',
      });
      const sessionInstance = createdSessions.at(-1);
      expect(sessionInstance?.setReasoningEffort).toHaveBeenCalledWith('high');
      expect(response?.configOptions).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'reasoning_effort' })])
      );
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

  describe('Session Runtime residency', () => {
    it('closes an exact Session through the standard ACP lifecycle', async () => {
      const created = await agent.newSession({
        cwd: '/tmp/project',
        mcpServers: [],
      });
      const session = createdSessions[0];

      expect(agent.getRuntimeResidencyStats()).toMatchObject({
        resident: 1,
        reserved: 0,
      });
      await agent.closeSession({ sessionId: created.sessionId });

      expect(session.destroy).toHaveBeenCalledTimes(1);
      expect(session.destroy).toHaveBeenCalledWith({
        discardPendingInput: true,
      });
      expect(agent.getRuntimeResidencyStats()).toMatchObject({
        resident: 0,
        reserved: 0,
      });
      await expect(
        agent.prompt({
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'must be closed' }],
        })
      ).rejects.toThrow(`Session not found: ${created.sessionId}`);
      await expect(
        agent.closeSession({ sessionId: created.sessionId })
      ).resolves.toBeUndefined();
    });

    it('rejects capacity before constructing a second ACP Session', async () => {
      await agent.destroy();
      runtimeResidencyConfig.maxResident = 1;
      agent = new BladeAgent(mockConnection as any);
      const first = await agent.newSession({
        cwd: '/tmp/project',
        mcpServers: [],
      });

      await expect(
        agent.newSession({
          cwd: '/tmp/project',
          mcpServers: [],
        })
      ).rejects.toMatchObject({
        name: 'RequestError',
        code: -32603,
        message: 'Internal error: Session runtime capacity is full',
        data: {
          resource: 'resident_runtimes',
          limit: 1,
          retryable: true,
        },
      });
      expect(createdSessions).toHaveLength(1);

      await agent.closeSession({ sessionId: first.sessionId });
      await expect(
        agent.newSession({
          cwd: '/tmp/project',
          mcpServers: [],
        })
      ).resolves.toBeDefined();
      expect(agent.getRuntimeResidencyStats().resident).toBe(1);
    });

    it('rejects a task Session before durable creation at capacity', async () => {
      await agent.destroy();
      runtimeResidencyConfig.maxResident = 1;
      agent = new BladeAgent(mockConnection as any);
      await agent.newSession({
        cwd: '/tmp/project',
        mcpServers: [],
      });
      sessionTaskServiceMocks.createSessionTask.mockClear();

      await expect(
        agent.newSession({
          cwd: '/tmp/project',
          mcpServers: [],
          _meta: {
            'blade/taskIsolation': 'local',
            'blade/taskPrompt': 'must not persist',
          },
        })
      ).rejects.toMatchObject({
        name: 'RequestError',
        code: -32603,
        message: 'Internal error: Session runtime capacity is full',
        data: {
          resource: 'resident_runtimes',
          limit: 1,
          retryable: true,
        },
      });
      expect(sessionTaskServiceMocks.createSessionTask).not.toHaveBeenCalled();
      expect(createdSessions).toHaveLength(1);
    });
  });

  describe('destroy', () => {
    it('shares one destroy barrier across concurrent callers', async () => {
      await agent.newSession({ cwd: '/tmp/test', mcpServers: [] });
      const session = createdSessions[0];
      let releaseDestroy!: () => void;
      const destroyBarrier = new Promise<void>((resolve) => {
        releaseDestroy = resolve;
      });
      session.destroy.mockImplementation(async () => destroyBarrier);

      const first = agent.destroy();
      const second = agent.destroy();

      expect(second).toBe(first);
      await Promise.resolve();
      expect(session.destroy).toHaveBeenCalledOnce();

      releaseDestroy();
      await expect(Promise.all([first, second])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      expect(session.destroy).toHaveBeenCalledOnce();
      expect(mcpRegistryMocks.disconnectAll).toHaveBeenCalledOnce();
    });

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

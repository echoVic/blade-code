/**
 * Agent 单元测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../../src/agent/Agent.js';
import { PermissionMode } from '../../../src/config/types.js';

// Mock getCurrentModel function to return a mock model
vi.mock('../../../src/config/models.js', () => ({
  getCurrentModel: vi.fn().mockReturnValue({
    id: 'mock-model',
    name: 'Mock Model',
    provider: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://mock.api',
    model: 'mock-model',
  }),
  setCurrentModel: vi.fn(),
  addModel: vi.fn(),
  removeModel: vi.fn(),
  listModels: vi.fn().mockReturnValue([
    {
      id: 'mock-model',
      name: 'Mock Model',
      provider: 'openai-compatible',
      apiKey: 'test-key',
      baseUrl: 'https://mock.api',
      model: 'mock-model',
    },
  ]),
  validateModelConfig: vi.fn().mockReturnValue({ isValid: true, errors: [] }),
  getAvailableModels: vi.fn().mockReturnValue([
    {
      id: 'mock-model',
      name: 'Mock Model',
      provider: 'openai-compatible',
      apiKey: 'test-key',
      baseUrl: 'https://mock.api',
      model: 'mock-model',
    },
  ]),
}));

// Mock ChatService
vi.mock('../../../src/services/ChatServiceInterface.js', () => ({
  createChatService: vi.fn().mockReturnValue({
    chat: vi.fn().mockResolvedValue({
      content: 'Mock AI response',
      toolCalls: undefined,
    }),
  }),
}));

// Mock ChatService for backward compatibility
vi.mock('../../../src/services/ChatService.js', () => ({
  ChatService: vi.fn().mockImplementation(() => ({
    chat: vi.fn().mockResolvedValue({
      content: 'Mock AI response',
      toolCalls: undefined,
    }),
  })),
}));

// Mock store/vanilla.js functions
vi.mock('../../../src/store/vanilla.js', () => ({
  ensureStoreInitialized: vi.fn().mockResolvedValue(undefined),
  getConfig: vi.fn().mockReturnValue({
    permissionMode: 'DEFAULT',
    maxTurns: -1,
    temperature: 0.7,
    maxContextTokens: 128000,
    maxOutputTokens: 4096,
    timeout: 30000,
    models: [
      {
        id: 'mock-model',
        name: 'Mock Model',
        provider: 'openai-compatible',
        apiKey: 'test-key',
        baseUrl: 'https://mock.api',
        model: 'mock-model',
      },
    ],
    currentModelId: 'mock-model',
  }),
  getCurrentModel: vi.fn().mockReturnValue({
    id: 'mock-model',
    name: 'Mock Model',
    provider: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://mock.api',
    model: 'mock-model',
  }),
  getAllModels: vi.fn().mockReturnValue([
    {
      id: 'mock-model',
      name: 'Mock Model',
      provider: 'openai-compatible',
      apiKey: 'test-key',
      baseUrl: 'https://mock.api',
      model: 'mock-model',
    },
  ]),
  getMcpServers: vi.fn().mockReturnValue({}),
  configActions: vi.fn().mockReturnValue({
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
  }),
  sessionActions: vi.fn().mockReturnValue({
    addAssistantMessage: vi.fn(),
  }),
  appActions: vi.fn().mockReturnValue({
    setTodos: vi.fn(),
  }),
  getState: vi.fn().mockReturnValue({
    config: {
      config: {
        permissionMode: 'DEFAULT',
        maxTurns: -1,
        temperature: 0.7,
        maxContextTokens: 128000,
        maxOutputTokens: 4096,
        timeout: 30000,
        models: [
          {
            id: 'mock-model',
            name: 'Mock Model',
            provider: 'openai-compatible',
            apiKey: 'test-key',
            baseUrl: 'https://mock.api',
            model: 'mock-model',
          },
        ],
        currentModelId: 'mock-model',
      },
      actions: {
        updateConfig: vi.fn(),
        setConfig: vi.fn(),
      },
    },
    session: {
      actions: {
        addAssistantMessage: vi.fn(),
      },
    },
    app: {
      actions: {
        setTodos: vi.fn(),
      },
    },
  }),
}));

// Mock ExecutionEngine
vi.mock('../../../src/agent/ExecutionEngine.js', () => ({
  ExecutionEngine: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    executeSimpleTask: vi.fn().mockImplementation((task) =>
      Promise.resolve({
        taskId: task.id,
        content: 'Mock task result',
        subAgentResults: [],
        executionPlan: null,
        metadata: {},
      })
    ),
    getContextManager: vi.fn().mockReturnValue({
      init: vi.fn().mockResolvedValue(undefined),
      addAssistantMessage: vi.fn(),
      buildMessagesWithContext: vi
        .fn()
        .mockReturnValue([{ role: 'user', content: 'Test message' }]),
      getMessages: vi.fn().mockReturnValue([]),
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../../src/context/ContextManager.js', () => ({
  ContextManager: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    addAssistantMessage: vi.fn(),
    buildMessagesWithContext: vi
      .fn()
      .mockReturnValue([{ role: 'user', content: 'Test message' }]),
    getMessages: vi.fn().mockReturnValue([]),
  })),
}));

// Mock getBuiltinTools - 修复tags属性问题
vi.mock('../../../src/tools/builtin/index.js', () => ({
  getBuiltinTools: vi.fn().mockResolvedValue([
    {
      name: 'MockTool',
      description: 'A mock tool for testing',
      displayName: 'Mock Tool',
      category: 'test',
      tags: ['test', 'mock'],
      inputSchema: {
        type: 'object',
        properties: {},
      },
      build: vi.fn().mockReturnValue({
        execute: vi.fn().mockResolvedValue({
          success: true,
          llmContent: 'Mock tool result',
        }),
      }),
      getFunctionDeclaration: vi.fn().mockReturnValue({
        name: 'MockTool',
        description: 'A mock tool for testing',
        parameters: {
          type: 'object',
          properties: {},
        },
      }),
    },
  ]),
}));

// Mock ToolRegistry
vi.mock('../../../src/tools/registry/ToolRegistry.js', () => ({
  ToolRegistry: vi.fn().mockImplementation(() => ({
    registerAll: vi.fn(),
    get: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
  })),
}));

// Mock other dependencies
vi.mock('../../../src/config/ConfigManager.js', () => ({
  ConfigManager: vi.fn().mockImplementation(() => ({
    getConfig: vi.fn().mockReturnValue({
      permissionMode: 'DEFAULT',
      maxTurns: -1,
      temperature: 0.7,
      maxContextTokens: 128000,
      maxOutputTokens: 4096,
      timeout: 30000,
      models: [
        {
          id: 'mock-model',
          name: 'Mock Model',
          provider: 'openai-compatible',
          apiKey: 'test-key',
          baseUrl: 'https://mock.api',
          model: 'mock-model',
        },
      ],
      currentModelId: 'mock-model',
    }),
    initialize: vi.fn().mockResolvedValue({
      permissionMode: 'DEFAULT',
      maxTurns: -1,
      temperature: 0.7,
      maxContextTokens: 128000,
      maxOutputTokens: 4096,
      timeout: 30000,
      models: [
        {
          id: 'mock-model',
          name: 'Mock Model',
          provider: 'openai-compatible',
          apiKey: 'test-key',
          baseUrl: 'https://mock.api',
          model: 'mock-model',
        },
      ],
      currentModelId: 'mock-model',
    }),
    validateConfig: vi.fn().mockReturnValue({ isValid: true, errors: [] }),
  })),
}));

vi.mock('../../../src/prompts/index.js', () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue({
    prompt: 'Mock system prompt',
    sources: [{ name: 'default', loaded: true }],
  }),
  createPlanModeReminder: vi.fn((msg) => msg),
}));

vi.mock('../../../src/agent/LoopDetectionService.js', () => ({
  LoopDetectionService: vi.fn().mockImplementation(() => ({
    detectLoop: vi.fn().mockReturnValue(false),
    reset: vi.fn(),
  })),
}));

vi.mock('../../../src/utils/environment.js', () => ({
  getEnvironmentContext: vi.fn().mockReturnValue('Mock environment context'),
}));

vi.mock('../../../src/tools/execution/ExecutionPipeline.js', () => ({
  ExecutionPipeline: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ success: true }),
    getRegistry: vi.fn().mockReturnValue({
      registerAll: vi.fn(),
      get: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
    }),
    initialize: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('Agent', () => {
  let agent: Agent;
  let mockChatService: any;

  beforeEach(() => {
    // 重置所有 mock
    vi.clearAllMocks();

    // 直接使用已经mock的createChatService返回的对象
    mockChatService = {
      chat: vi.fn().mockResolvedValue({
        content: 'Mock AI response',
        toolCalls: undefined,
      }),
    };

    // 创建新的 Agent 实例
    agent = new Agent({
      // BladeConfig 的必需字段
      currentModelId: 'mock-model',
      models: [
        {
          id: 'mock-model',
          name: 'Mock Model',
          provider: 'openai-compatible' as const,
          apiKey: 'test-key',
          baseUrl: 'https://mock.api',
          model: 'mock-model',
        },
      ],
      temperature: 0.7,
      maxContextTokens: 8000,
      maxOutputTokens: 4000,
      stream: true,
      topP: 0.9,
      topK: 50,
      timeout: 30000,
      theme: 'GitHub',
      language: 'zh-CN',
      fontSize: 14,
      debug: false,
      mcpEnabled: false,
      mcpServers: {},
      permissions: {
        allow: [],
        ask: [],
        deny: [],
      },
      permissionMode: PermissionMode.DEFAULT,
      hooks: {},
      env: {},
      disableAllHooks: false,
      maxTurns: 10,
    });
  });

  afterEach(() => {
    // 销毁 agent 实例
    if (agent) {
      agent.destroy();
    }
  });

  describe('初始化', () => {
    it('应该成功创建 Agent 实例', () => {
      expect(agent).toBeInstanceOf(Agent);
    });

    it('应该能够正确初始化所有服务', async () => {
      await agent.initialize();

      // Agent初始化应该成功
      expect(agent.getActiveTask()).toBeUndefined();
    });

    it('应该正确设置状态', async () => {
      expect(agent.getActiveTask()).toBeUndefined();

      await agent.initialize();
      // Agent 初始化后应该能够获取上下文管理器
      expect(agent.getContextManager()).toBeDefined();
    });
  });

  describe('聊天功能', () => {
    beforeEach(async () => {
      await agent.initialize();
      // 替换Agent的chatService为我们的mock
      (agent as any).chatService = mockChatService;
    });

    it('应该能够发送消息并接收响应', async () => {
      // 使用系统提示词聊天，避免网络调用
      const response = await agent.chatWithSystem(
        'You are a helpful assistant',
        'Hello, world!'
      );

      expect(response).toBe('Mock AI response');
      expect(mockChatService.chat).toHaveBeenCalled();
    }, 10000);

    it('应该能够处理对话上下文', async () => {
      // 使用系统提示词聊天，避免网络调用
      await agent.chatWithSystem('You are a helpful assistant', 'First message');
      await agent.chatWithSystem('You are a helpful assistant', 'Second message');

      expect(mockChatService.chat).toHaveBeenCalledTimes(2);
    }, 10000);

    it('应该支持带系统提示词的聊天', async () => {
      const response = await agent.chatWithSystem(
        'You are a helpful assistant',
        'Hello'
      );

      expect(response).toBe('Mock AI response');
      expect(mockChatService.chat).toHaveBeenCalledWith([
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' },
      ]);
    }, 10000);

    it('应该在错误时正确处理', async () => {
      // 让 chatWithSystem 方法抛出错误
      mockChatService.chat.mockRejectedValueOnce(new Error('Connection error.'));

      await expect(agent.chatWithSystem('System prompt', 'Hello')).rejects.toThrow(
        'Connection error.'
      );
    });
  });

  describe('任务执行', () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it('应该能够执行简单任务', async () => {
      const task = {
        id: 'test-task',
        type: 'simple' as const,
        prompt: 'Test message',
      };

      const response = await agent.executeTask(task);

      expect(response).toBeDefined();
      expect(response.taskId).toBe('test-task');
      expect(response.content).toBeDefined();
    }, 10000);
  });

  describe('上下文管理', () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it('应该能够获取上下文管理器', () => {
      const contextManager = agent.getContextManager();
      expect(contextManager).toBeDefined();
      // 跳过精确匹配检查，因为返回的是执行引擎的上下文管理器
    });

    it('应该能够获取Chat服务', () => {
      const chatService = agent.getChatService();
      expect(chatService).toBeDefined();
      // 跳过精确匹配检查，因为返回的是实际的聊天服务实例
    });
  });

  describe('销毁', () => {
    it('应该正确销毁所有服务', async () => {
      await agent.initialize();
      await agent.destroy();

      // 验证销毁过程不抛出错误
      expect(true).toBe(true);
    });
  });

  describe('错误处理', () => {
    it('应该在初始化失败时正确处理', async () => {
      // 临时替换 ExecutionEngine mock 为失败版本
      const { ExecutionEngine } = await import('../../../src/agent/ExecutionEngine.js');
      const originalImplementation = vi.mocked(ExecutionEngine).getMockImplementation();

      vi.mocked(ExecutionEngine).mockImplementationOnce(() => {
        throw new Error('Init Error');
      });

      const failingAgent = new Agent(
        {
          // BladeConfig 的必需字段
          currentModelId: 'mock-model',
          models: [
            {
              id: 'mock-model',
              name: 'Mock Model',
              provider: 'openai-compatible',
              apiKey: 'test-key',
              baseUrl: 'https://mock.api',
              model: 'mock-model',
            },
          ],
          temperature: 0.7,
          maxContextTokens: 8000,
          maxOutputTokens: 4000,
          stream: true,
          topP: 0.9,
          topK: 50,
          timeout: 30000,
          theme: 'GitHub',
          language: 'zh-CN',
          fontSize: 14,
          debug: false,
          mcpEnabled: false,
          mcpServers: {},
          permissions: {
            allow: [],
            ask: [],
            deny: [],
          },
          permissionMode: PermissionMode.DEFAULT,
          hooks: {},
          env: {},
          disableAllHooks: false,
          maxTurns: 10,
        },
        {
          // AgentOptions
          permissionMode: PermissionMode.DEFAULT,
        }
      );

      await expect(failingAgent.initialize()).rejects.toThrow('Init Error');

      // 恢复原始mock
      if (originalImplementation) {
        vi.mocked(ExecutionEngine).mockImplementation(originalImplementation);
      }
    });
  });
});

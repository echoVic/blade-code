import { describe, expect, it, vi } from 'vitest';
import { ExecutionEngine } from '../../../../src/agent/ExecutionEngine.js';
import { executeLoopGenerator } from '../../../../src/agent/loop/executeLoopGenerator.js';
import type { LoopDependencies, LoopEvent } from '../../../../src/agent/loop/types.js';
import type { ChatContext, LoopResult } from '../../../../src/agent/types.js';
import { DEFAULT_CONFIG } from '../../../../src/config/defaults.js';
import { PermissionMode } from '../../../../src/config/types.js';
import { ContextManager } from '../../../../src/context/ContextManager.js';
import { Type } from '../../../../src/schema/index.js';
import type {
  ChatConfig,
  ChatResponse,
  IChatService,
  Message,
  StreamChunk,
  StreamToolCall,
} from '../../../../src/services/ChatServiceInterface.js';
import { createTool } from '../../../../src/tools/core/createTool.js';
import { ToolExecutor } from '../../../../src/tools/execution/ToolExecutor.js';
import { ToolRegistry } from '../../../../src/tools/registry/ToolRegistry.js';
import { ToolKind } from '../../../../src/tools/types/index.js';

class ExactlyOnceStreamingChatService implements IChatService {
  readonly visibleTools: string[][] = [];
  private turn = 0;

  async chat(
    _messages: Message[],
    _tools?: Array<{ name: string; description: string; parameters: unknown }>,
    _signal?: AbortSignal
  ): Promise<ChatResponse> {
    throw new Error('Streaming policy test must not use non-streaming chat');
  }

  async *streamChat(
    _messages: Message[],
    tools?: Array<{ name: string; description: string; parameters: unknown }>,
    _signal?: AbortSignal
  ): AsyncGenerator<StreamChunk, void, unknown> {
    this.visibleTools.push((tools ?? []).map((tool) => tool.name));
    this.turn += 1;
    if (this.turn === 1) {
      const toolCalls: StreamToolCall[] = [
        {
          index: 0,
          id: 'stream-task-one',
          type: 'function',
          function: { name: 'Task', arguments: '{"prompt":"first"}' },
        },
        {
          index: 1,
          id: 'stream-task-two',
          type: 'function',
          function: { name: 'Task', arguments: '{"prompt":"second"}' },
        },
      ];
      yield { toolCalls, finishReason: 'tool_calls' };
      return;
    }

    yield { content: 'Delegation complete.', finishReason: 'stop' };
  }

  getConfig(): ChatConfig {
    return {
      provider: 'openai-compatible',
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid/v1',
      model: 'test-model',
      maxContextTokens: 64_000,
      maxOutputTokens: 4_096,
    };
  }

  updateConfig(_newConfig: Partial<ChatConfig>): void {
    void _newConfig;
  }
}

class FallbackStreamingChatService implements IChatService {
  private turn = 0;

  async chat(
    _messages: Message[],
    _tools?: Array<{ name: string; description: string; parameters: unknown }>,
    _signal?: AbortSignal
  ): Promise<ChatResponse> {
    throw new Error('Fallback policy test must not use non-streaming chat');
  }

  async *streamChat(): AsyncGenerator<StreamChunk, void, unknown> {
    this.turn += 1;
    if (this.turn === 1) {
      yield {
        toolCalls: [
          {
            index: 0,
            id: 'discarded-task',
            type: 'function',
            function: { name: 'Task', arguments: '{"prompt":"stale"}' },
          },
        ],
      };
      yield { modelFallback: true };
      yield {
        toolCalls: [
          {
            index: 0,
            id: 'fallback-task',
            type: 'function',
            function: { name: 'Task', arguments: '{"prompt":"current"}' },
          },
        ],
        finishReason: 'tool_calls',
      };
      return;
    }
    yield { content: 'Fallback delegation complete.', finishReason: 'stop' };
  }

  getConfig(): ChatConfig {
    return {
      provider: 'openai-compatible',
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid/v1',
      model: 'test-model',
      maxContextTokens: 64_000,
      maxOutputTokens: 4_096,
    };
  }

  updateConfig(_newConfig: Partial<ChatConfig>): void {
    void _newConfig;
  }
}

interface CapturedRequestOptions {
  toolChoice?: { type: 'tool'; toolName: string };
  providerRecovery?: {
    mode: 'bounded_foreground';
    budgetMs: number;
  };
}

class RequiredDelegationChatService implements IChatService {
  readonly toolChoices: Array<CapturedRequestOptions['toolChoice']> = [];

  async chat(): Promise<ChatResponse> {
    throw new Error('Required delegation test must not use non-streaming chat');
  }

  async *streamChat(
    _messages: Message[],
    tools?: Array<{ name: string; description: string; parameters: unknown }>,
    _signal?: AbortSignal,
    options?: CapturedRequestOptions
  ): AsyncGenerator<StreamChunk, void, unknown> {
    this.toolChoices.push(options?.toolChoice);
    if (!(tools ?? []).some((tool) => tool.name === 'Task')) {
      yield { content: 'Delegation complete.', finishReason: 'stop' };
      return;
    }
    if (options?.toolChoice?.toolName !== 'Task') {
      yield { content: 'I will delegate after more planning.', finishReason: 'stop' };
      return;
    }
    yield {
      toolCalls: [
        {
          index: 0,
          id: 'required-task',
          type: 'function',
          function: { name: 'Task', arguments: '{"prompt":"repair"}' },
        },
      ],
      finishReason: 'tool_calls',
    };
  }

  getConfig(): ChatConfig {
    return {
      provider: 'openai-compatible',
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid/v1',
      model: 'test-model',
      maxContextTokens: 64_000,
      maxOutputTokens: 4_096,
    };
  }

  updateConfig(_newConfig: Partial<ChatConfig>): void {
    void _newConfig;
  }
}

class RequiredVerificationChatService implements IChatService {
  readonly toolChoices: Array<CapturedRequestOptions['toolChoice']> = [];
  private verified = false;

  async chat(): Promise<ChatResponse> {
    throw new Error('Required verification test must not use non-streaming chat');
  }

  async *streamChat(
    _messages: Message[],
    _tools?: Array<{ name: string; description: string; parameters: unknown }>,
    _signal?: AbortSignal,
    options?: CapturedRequestOptions
  ): AsyncGenerator<StreamChunk, void, unknown> {
    this.toolChoices.push(options?.toolChoice);
    if (this.verified) {
      yield { content: 'Verification complete.', finishReason: 'stop' };
      return;
    }
    if (options?.toolChoice?.toolName !== 'Bash') {
      yield { content: 'The repair is complete.', finishReason: 'stop' };
      return;
    }
    this.verified = true;
    yield {
      toolCalls: [
        {
          index: 0,
          id: 'required-bash',
          type: 'function',
          function: { name: 'Bash', arguments: '{"command":"npm test"}' },
        },
      ],
      finishReason: 'tool_calls',
    };
  }

  getConfig(): ChatConfig {
    return {
      provider: 'openai-compatible',
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid/v1',
      model: 'test-model',
      maxContextTokens: 64_000,
      maxOutputTokens: 4_096,
    };
  }

  updateConfig(_newConfig: Partial<ChatConfig>): void {
    void _newConfig;
  }
}

class RequiredFallbackChatService implements IChatService {
  readonly streamChoices: Array<CapturedRequestOptions['toolChoice']> = [];
  readonly chatChoices: Array<CapturedRequestOptions['toolChoice']> = [];
  readonly chatRecoveries: Array<CapturedRequestOptions['providerRecovery']> = [];
  private completed = false;

  async chat(
    _messages: Message[],
    _tools?: Array<{ name: string; description: string; parameters: unknown }>,
    _signal?: AbortSignal,
    options?: CapturedRequestOptions
  ): Promise<ChatResponse> {
    this.chatChoices.push(options?.toolChoice);
    this.chatRecoveries.push(options?.providerRecovery);
    this.completed = true;
    return {
      content: '',
      toolCalls: [
        {
          id: 'fallback-required-task',
          type: 'function',
          function: { name: 'Task', arguments: '{"prompt":"repair"}' },
        },
      ],
      finishReason: 'tool_calls',
    };
  }

  async *streamChat(
    _messages: Message[],
    _tools?: Array<{ name: string; description: string; parameters: unknown }>,
    _signal?: AbortSignal,
    options?: CapturedRequestOptions
  ): AsyncGenerator<StreamChunk, void, unknown> {
    this.streamChoices.push(options?.toolChoice);
    if (this.completed) {
      yield { content: 'Delegation complete.', finishReason: 'stop' };
      return;
    }
    if (options?.toolChoice?.toolName !== 'Task') {
      yield { content: 'I will delegate after more planning.', finishReason: 'stop' };
    }
  }

  getConfig(): ChatConfig {
    return {
      provider: 'openai-compatible',
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid/v1',
      model: 'test-model',
      maxContextTokens: 64_000,
      maxOutputTokens: 4_096,
    };
  }

  updateConfig(_newConfig: Partial<ChatConfig>): void {
    void _newConfig;
  }
}

class MissingRequiredTaskChatService implements IChatService {
  async chat(): Promise<ChatResponse> {
    throw new Error('Missing required Task test must not use non-streaming chat');
  }

  async *streamChat(
    _messages: Message[],
    _tools?: Array<{ name: string; description: string; parameters: unknown }>,
    _signal?: AbortSignal,
    options?: CapturedRequestOptions
  ): AsyncGenerator<StreamChunk, void, unknown> {
    if (options?.toolChoice?.toolName === 'Task') {
      throw new Error('Required tool is unavailable: Task');
    }
    yield { content: 'I will delegate later.', finishReason: 'stop' };
  }

  getConfig(): ChatConfig {
    return {
      provider: 'openai-compatible',
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid/v1',
      model: 'test-model',
      maxContextTokens: 64_000,
      maxOutputTokens: 4_096,
    };
  }

  updateConfig(_newConfig: Partial<ChatConfig>): void {
    void _newConfig;
  }
}

class ProviderRetryStreamingChatService implements IChatService {
  async chat(): Promise<ChatResponse> {
    throw new Error('Provider retry test must not use non-streaming chat');
  }

  async *streamChat(): AsyncGenerator<StreamChunk, void, unknown> {
    yield {
      providerStall: {
        phase: 'detected',
        stallCount: 1,
        durationMs: 30_000,
        warningAfterMs: 30_000,
        timeoutMs: 300_000,
        outputStarted: false,
      },
    };
    yield {
      providerStall: {
        phase: 'recovered',
        stallCount: 1,
        durationMs: 31_250,
        warningAfterMs: 30_000,
        timeoutMs: 300_000,
        outputStarted: false,
      },
    };
    yield {
      providerRetry: {
        phase: 'scheduled',
        attempt: 1,
        maxRetries: 2,
        reason: 'server_error',
        statusCode: 503,
        delayMs: 750,
        nextRetryAt: 1_750,
      },
    };
    yield {
      providerRetry: {
        phase: 'attempt',
        attempt: 1,
        maxRetries: 2,
        reason: 'server_error',
        statusCode: 503,
      },
    };
    yield {
      providerRetry: {
        phase: 'recovered',
        attempt: 1,
        maxRetries: 2,
        reason: 'server_error',
        statusCode: 503,
      },
    };
    yield { content: 'Recovered exactly once.', finishReason: 'stop' };
  }

  getConfig(): ChatConfig {
    return {
      provider: 'openai-compatible',
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid/v1',
      model: 'test-model',
      maxContextTokens: 64_000,
      maxOutputTokens: 4_096,
    };
  }

  updateConfig(_newConfig: Partial<ChatConfig>): void {
    void _newConfig;
  }
}

function createTaskLoopDependencies(
  chatService: IChatService,
  taskExecution: ReturnType<typeof vi.fn>,
  options: { exactlyOnce?: boolean } = {}
): LoopDependencies {
  const registry = new ToolRegistry();
  registry.register(
    createTool({
      name: 'Task',
      displayName: 'Task',
      kind: ToolKind.ReadOnly,
      isConcurrencySafe: false,
      parallelism: 'shared',
      description: { short: 'Delegate work' },
      schema: Type.Unknown(),
      execute: taskExecution as any,
    })
  );
  return {
    chatService,
    toolExecutor: new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
    }),
    executionEngine: undefined,
    config: DEFAULT_CONFIG,
    runtimeOptions:
      options.exactlyOnce === false
        ? {}
        : {
            appendSystemPrompt: 'Call Task exactly once, then return a final answer.',
          },
    currentModelMaxContextTokens: 64_000,
    applySkillToolRestrictions: (tools) => tools,
  };
}

function createVerificationLoopDependencies(
  chatService: IChatService,
  bashExecution: ReturnType<typeof vi.fn>
): LoopDependencies {
  const registry = new ToolRegistry();
  registry.register(
    createTool({
      name: 'Bash',
      displayName: 'Bash',
      kind: ToolKind.Execute,
      isConcurrencySafe: false,
      description: { short: 'Run a command' },
      schema: Type.Unknown(),
      execute: bashExecution as any,
    })
  );
  return {
    chatService,
    toolExecutor: new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
    }),
    executionEngine: undefined,
    config: DEFAULT_CONFIG,
    runtimeOptions: {},
    currentModelMaxContextTokens: 64_000,
    applySkillToolRestrictions: (tools) => tools,
  };
}

async function drain(
  generator: AsyncGenerator<LoopEvent, LoopResult, void>
): Promise<{ events: LoopEvent[]; result: LoopResult }> {
  const events: LoopEvent[] = [];
  let current = await generator.next();
  while (!current.done) {
    events.push(current.value);
    current = await generator.next();
  }
  return { events, result: current.value };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('executeLoopGenerator streaming tool policy', () => {
  it('does not complete a streamed response when its assistant commit fails', async () => {
    let providerRequests = 0;
    const chatService: IChatService = {
      async chat() {
        throw new Error('Durable streaming response test must not use chat');
      },
      async *streamChat() {
        providerRequests++;
        yield {
          content: 'Ephemeral streamed response',
          finishReason: 'stop',
        };
      },
      getConfig() {
        return {
          provider: 'openai-compatible',
          apiKey: 'test-key',
          baseUrl: 'https://example.invalid/v1',
          model: 'test-model',
          maxContextTokens: 64_000,
          maxOutputTokens: 4_096,
        };
      },
      updateConfig(newConfig: Partial<ChatConfig>) {
        void newConfig;
      },
    };
    const registry = new ToolRegistry();
    const contextManager = new ContextManager({
      projectPath: '/tmp/blade-streaming-response-barrier',
    });
    vi.spyOn(contextManager, 'saveMessage').mockImplementation(
      async (_sessionId, role) => {
        if (role === 'assistant') {
          throw new Error('durable assistant fsync failed');
        }
        return 'durable-user-message';
      }
    );
    const dependencies: LoopDependencies = {
      chatService,
      toolExecutor: new ToolExecutor(registry, {
        permissionMode: PermissionMode.YOLO,
      }),
      executionEngine: new ExecutionEngine(
        chatService,
        contextManager,
        '/tmp/blade-streaming-response-barrier'
      ),
      config: DEFAULT_CONFIG,
      runtimeOptions: {},
      currentModelMaxContextTokens: 64_000,
      applySkillToolRestrictions: (tools) => tools,
    };
    const context: ChatContext = {
      messages: [],
      userId: 'stream-response-barrier-user',
      sessionId: 'stream-response-barrier-session',
      workspaceRoot: '/tmp/blade-streaming-response-barrier',
      permissionMode: PermissionMode.YOLO,
    };

    const { events, result } = await drain(
      executeLoopGenerator(
        dependencies,
        'Return a streamed response.',
        context,
        { stream: true },
        undefined
      )
    );

    expect(providerRequests).toBe(1);
    expect(events).toContainEqual({
      kind: 'content_delta',
      delta: 'Ephemeral streamed response',
    });
    expect(context.messages.some((message) => message.role === 'assistant')).toBe(
      false
    );
    expect(result).toMatchObject({
      success: false,
      error: { type: 'message_persistence_failed' },
    });
  });

  it('stops before publishing a streaming result when its durable commit fails', async () => {
    let providerRequests = 0;
    const chatService: IChatService = {
      async chat() {
        throw new Error('Durable streaming result test must not use chat');
      },
      async *streamChat() {
        providerRequests++;
        if (providerRequests === 1) {
          yield {
            toolCalls: [
              {
                index: 0,
                id: 'stream-edit',
                type: 'function',
                function: {
                  name: 'Edit',
                  arguments: '{"file_path":"/tmp/result-barrier.ts"}',
                },
              },
            ],
            finishReason: 'tool_calls',
          };
          return;
        }
        yield {
          content: 'This response must never be requested.',
          finishReason: 'stop',
        };
      },
      getConfig() {
        return {
          provider: 'openai-compatible',
          apiKey: 'test-key',
          baseUrl: 'https://example.invalid/v1',
          model: 'test-model',
          maxContextTokens: 64_000,
          maxOutputTokens: 4_096,
        };
      },
      updateConfig(newConfig: Partial<ChatConfig>) {
        void newConfig;
      },
    };
    const editExecution = vi.fn(async () => ({
      success: true,
      llmContent: 'edited',
    }));
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: 'Edit',
        displayName: 'Edit',
        kind: ToolKind.Write,
        isConcurrencySafe: false,
        description: { short: 'Edit a file' },
        schema: Type.Unknown(),
        execute: editExecution as any,
      })
    );
    const contextManager = new ContextManager({
      projectPath: '/tmp/blade-streaming-result-barrier',
    });
    vi.spyOn(contextManager, 'saveMessage').mockResolvedValue('durable-message');
    vi.spyOn(contextManager, 'saveToolUse').mockResolvedValue('durable-tool-call');
    vi.spyOn(contextManager, 'saveToolResult').mockRejectedValue(
      new Error('durable result fsync failed')
    );
    const dependencies: LoopDependencies = {
      chatService,
      toolExecutor: new ToolExecutor(registry, {
        permissionMode: PermissionMode.YOLO,
      }),
      executionEngine: new ExecutionEngine(
        chatService,
        contextManager,
        '/tmp/blade-streaming-result-barrier'
      ),
      config: DEFAULT_CONFIG,
      runtimeOptions: {},
      currentModelMaxContextTokens: 64_000,
      applySkillToolRestrictions: (tools) => tools,
    };
    const context: ChatContext = {
      messages: [],
      userId: 'stream-result-barrier-user',
      sessionId: 'stream-result-barrier-session',
      workspaceRoot: '/tmp/blade-streaming-result-barrier',
      permissionMode: PermissionMode.YOLO,
    };

    const { events, result } = await drain(
      executeLoopGenerator(
        dependencies,
        'Edit the file.',
        context,
        { stream: true },
        undefined
      )
    );

    expect(editExecution).toHaveBeenCalledTimes(1);
    expect(providerRequests).toBe(1);
    expect(events.some((event) => event.kind === 'tool_result')).toBe(false);
    expect(result).toMatchObject({
      success: false,
      error: { type: 'tool_persistence_failed' },
    });
  });

  it('projects Provider recovery metadata without treating it as model output', async () => {
    const registry = new ToolRegistry();
    const dependencies: LoopDependencies = {
      chatService: new ProviderRetryStreamingChatService(),
      toolExecutor: new ToolExecutor(registry, {
        permissionMode: PermissionMode.YOLO,
      }),
      executionEngine: undefined,
      config: DEFAULT_CONFIG,
      runtimeOptions: {},
      currentModelMaxContextTokens: 64_000,
      applySkillToolRestrictions: (tools) => tools,
    };
    const context: ChatContext = {
      messages: [],
      userId: 'provider-retry-user',
      sessionId: 'provider-retry-session',
      workspaceRoot: process.cwd(),
      permissionMode: PermissionMode.YOLO,
    };

    const { events, result } = await drain(
      executeLoopGenerator(
        dependencies,
        'Recover from a transient provider failure.',
        context,
        { stream: true },
        undefined
      )
    );

    expect(
      events
        .filter((event) => event.kind === 'provider_retry')
        .map((event) => event.phase)
    ).toEqual(['scheduled', 'attempt', 'recovered']);
    expect(
      events
        .filter((event) => event.kind === 'provider_stall')
        .map((event) => event.phase)
    ).toEqual(['detected', 'recovered']);
    expect(events.filter((event) => event.kind === 'content_delta')).toEqual([
      { kind: 'content_delta', delta: 'Recovered exactly once.' },
    ]);
    expect(result).toMatchObject({
      success: true,
      finalMessage: 'Recovered exactly once.',
    });
  });

  it('requires Task at the provider boundary when delegation is explicit', async () => {
    const taskExecution = vi.fn(async () => ({
      success: true,
      llmContent: 'Subagent completed the repair.',
    }));
    const chatService = new RequiredDelegationChatService();
    const dependencies = createTaskLoopDependencies(chatService, taskExecution);
    const context: ChatContext = {
      messages: [],
      userId: 'required-delegation-user',
      sessionId: 'required-delegation-session',
      workspaceRoot: process.cwd(),
      permissionMode: PermissionMode.YOLO,
    };

    const { result } = await drain(
      executeLoopGenerator(
        dependencies,
        'Delegate this repair with the Task tool.',
        context,
        { stream: true },
        undefined
      )
    );

    expect(result.success).toBe(true);
    expect(taskExecution).toHaveBeenCalledTimes(1);
    expect(chatService.toolChoices).toEqual([
      undefined,
      { type: 'tool', toolName: 'Task' },
      undefined,
    ]);
  });

  it('requires Bash on the retry after requested verification is omitted', async () => {
    const bashExecution = vi.fn(async () => ({
      success: true,
      llmContent: 'tests passed',
      metadata: { command: 'npm test', exit_code: 0 },
    }));
    const chatService = new RequiredVerificationChatService();
    const dependencies = createVerificationLoopDependencies(chatService, bashExecution);
    const context: ChatContext = {
      messages: [],
      userId: 'required-verification-user',
      sessionId: 'required-verification-session',
      workspaceRoot: process.cwd(),
      permissionMode: PermissionMode.YOLO,
    };

    const { result } = await drain(
      executeLoopGenerator(
        dependencies,
        'Repair the project, run npm test, and finish only after it passes.',
        context,
        { stream: true },
        undefined
      )
    );

    expect(result.success).toBe(true);
    expect(bashExecution).toHaveBeenCalledTimes(1);
    expect(chatService.toolChoices).toEqual([
      undefined,
      { type: 'tool', toolName: 'Bash' },
      undefined,
    ]);
  });

  it('preserves a required Task choice during stream-to-chat fallback', async () => {
    const taskExecution = vi.fn(async () => ({
      success: true,
      llmContent: 'Subagent completed the repair.',
    }));
    const chatService = new RequiredFallbackChatService();
    const dependencies = createTaskLoopDependencies(chatService, taskExecution);
    const context: ChatContext = {
      messages: [],
      userId: 'required-fallback-user',
      sessionId: 'required-fallback-session',
      workspaceRoot: process.cwd(),
      permissionMode: PermissionMode.YOLO,
    };

    const { result } = await drain(
      executeLoopGenerator(
        dependencies,
        'Delegate this repair with the Task tool.',
        context,
        { stream: true },
        undefined
      )
    );

    expect(result.success).toBe(true);
    expect(taskExecution).toHaveBeenCalledTimes(1);
    expect(chatService.streamChoices).toEqual([
      undefined,
      { type: 'tool', toolName: 'Task' },
      undefined,
    ]);
    expect(chatService.chatChoices).toEqual([{ type: 'tool', toolName: 'Task' }]);
    expect(chatService.chatRecoveries).toEqual([
      {
        mode: 'bounded_foreground',
        budgetMs: DEFAULT_CONFIG.providerForegroundRecoveryMs,
      },
    ]);
  });

  it('fails closed when an explicitly required Task is not available', async () => {
    const registry = new ToolRegistry();
    const dependencies: LoopDependencies = {
      chatService: new MissingRequiredTaskChatService(),
      toolExecutor: new ToolExecutor(registry, {
        permissionMode: PermissionMode.YOLO,
      }),
      executionEngine: undefined,
      config: DEFAULT_CONFIG,
      runtimeOptions: {
        appendSystemPrompt: 'Call Task exactly once before returning an answer.',
      },
      currentModelMaxContextTokens: 64_000,
      applySkillToolRestrictions: (tools) => tools,
    };
    const context: ChatContext = {
      messages: [],
      userId: 'missing-required-task-user',
      sessionId: 'missing-required-task-session',
      workspaceRoot: process.cwd(),
      permissionMode: PermissionMode.YOLO,
    };

    const { result } = await drain(
      executeLoopGenerator(
        dependencies,
        'Repair the project.',
        context,
        { stream: true },
        undefined
      )
    );

    expect(result).toMatchObject({
      success: false,
      error: {
        type: 'api_error',
        message: 'Required tool is unavailable: Task',
      },
    });
  });

  it('executes only one Task when the same stream requests two', async () => {
    const taskExecution = vi.fn(async () => ({
      success: true,
      llmContent: 'Subagent completed the repair.',
    }));
    const chatService = new ExactlyOnceStreamingChatService();
    const dependencies = createTaskLoopDependencies(chatService, taskExecution);
    const context: ChatContext = {
      messages: [],
      userId: 'stream-policy-user',
      sessionId: 'stream-policy-session',
      workspaceRoot: process.cwd(),
      permissionMode: PermissionMode.YOLO,
    };

    const { events, result } = await drain(
      executeLoopGenerator(
        dependencies,
        'Delegate this repair with the Task tool.',
        context,
        { stream: true },
        undefined
      )
    );

    expect(result.success).toBe(true);
    expect(taskExecution).toHaveBeenCalledTimes(1);
    expect(chatService.visibleTools).toEqual([['Task'], []]);
    expect(
      events.filter(
        (event) =>
          event.kind === 'tool_start' &&
          'function' in event.toolCall &&
          event.toolCall.function.name === 'Task'
      )
    ).toHaveLength(1);
    expect(
      events
        .filter((event) => event.kind === 'tool_result')
        .map((event) => ({
          id: 'function' in event.toolCall ? event.toolCall.id : '',
          success: event.result.success,
          errorType: event.result.error?.type,
        }))
    ).toEqual([
      { id: 'stream-task-one', success: true, errorType: undefined },
      {
        id: 'stream-task-two',
        success: false,
        errorType: 'validation_error',
      },
    ]);
  });

  it('runs independent Tasks from one production stream concurrently', async () => {
    let started = 0;
    let markBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    const first = deferred();
    const second = deferred();
    const taskExecution = vi.fn(async (params: { prompt?: string }) => {
      started++;
      if (started === 2) markBothStarted();
      await (params.prompt === 'first' ? first.promise : second.promise);
      return {
        success: true,
        llmContent: `${params.prompt}:done`,
      };
    });
    const dependencies = createTaskLoopDependencies(
      new ExactlyOnceStreamingChatService(),
      taskExecution,
      { exactlyOnce: false }
    );
    const context: ChatContext = {
      messages: [],
      userId: 'parallel-stream-user',
      sessionId: 'parallel-stream-session',
      workspaceRoot: process.cwd(),
      permissionMode: PermissionMode.YOLO,
    };

    const run = drain(
      executeLoopGenerator(
        dependencies,
        'Run both independent reviews in parallel.',
        context,
        { stream: true },
        undefined
      )
    );

    await bothStarted;
    expect(taskExecution).toHaveBeenCalledTimes(2);
    second.resolve();
    first.resolve();

    const { events, result } = await run;
    expect(result.success).toBe(true);
    expect(
      events
        .filter((event) => event.kind === 'tool_result')
        .map((event) => ('function' in event.toolCall ? event.toolCall.id : ''))
    ).toEqual(['stream-task-one', 'stream-task-two']);
  });

  it('releases an unexecuted Task admission when the model stream falls back', async () => {
    const taskExecution = vi.fn(async () => ({
      success: true,
      llmContent: 'Fallback subagent completed the repair.',
    }));
    const dependencies = createTaskLoopDependencies(
      new FallbackStreamingChatService(),
      taskExecution
    );
    const context: ChatContext = {
      messages: [],
      userId: 'fallback-policy-user',
      sessionId: 'fallback-policy-session',
      workspaceRoot: process.cwd(),
      permissionMode: PermissionMode.YOLO,
    };

    const { events, result } = await drain(
      executeLoopGenerator(
        dependencies,
        'Delegate this repair with the Task tool.',
        context,
        { stream: true },
        undefined
      )
    );

    expect(result.success).toBe(true);
    expect(taskExecution).toHaveBeenCalledTimes(1);
    expect(
      events
        .filter((event) => event.kind === 'tool_result')
        .map((event) => ('function' in event.toolCall ? event.toolCall.id : ''))
    ).toEqual(['fallback-task']);
  });
});

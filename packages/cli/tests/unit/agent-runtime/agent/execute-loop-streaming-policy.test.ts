import { describe, expect, it, vi } from 'vitest';
import { executeLoopGenerator } from '../../../../src/agent/loop/executeLoopGenerator.js';
import type { LoopDependencies, LoopEvent } from '../../../../src/agent/loop/types.js';
import type { ChatContext, LoopResult } from '../../../../src/agent/types.js';
import { DEFAULT_CONFIG } from '../../../../src/config/defaults.js';
import { PermissionMode } from '../../../../src/config/types.js';
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
  private completed = false;

  async chat(
    _messages: Message[],
    _tools?: Array<{ name: string; description: string; parameters: unknown }>,
    _signal?: AbortSignal,
    options?: CapturedRequestOptions
  ): Promise<ChatResponse> {
    this.chatChoices.push(options?.toolChoice);
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

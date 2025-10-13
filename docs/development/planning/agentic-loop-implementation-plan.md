# Blade Agentic Loop 融合实现方案

> 综合 Claude Code、Gemini CLI、Neovate Code、Codex 四个工具的最佳实践

---

## 📊 四个工具的核心优势分析

### 1. Claude Code
**核心优势:**
- ✅ **任务分层**: 通过 Task tool 实现子任务递归
- ✅ **简洁流程**: 扁平的 tool → response 循环
- ✅ **灵活分支**: 复杂任务可以 spawn 独立分支

**借鉴点:**
```typescript
// 支持 Task tool 创建子代理
if (toolName === 'Task') {
  const subAgent = new Agent(config);
  return await subAgent.runAgenticLoop(params.prompt, subContext);
}
```

---

### 2. Gemini CLI
**核心优势:**
- ✅ **三层循环检测** (最完善):
  - 工具调用循环 (连续5次相同工具)
  - 内容循环 (10次重复块)
  - **LLM智能检测** (30轮后用专门prompt分析)
- ✅ **批量工具调度**: 并行执行多个工具
- ✅ **三种执行模式**: Interactive/NonInteractive/Streaming

**借鉴点:**
```typescript
// 循环检测系统提示
const LOOP_DETECTION_PROMPT = `你是循环诊断专家，分析对话历史判断是否陷入:
- 重复工具调用
- 认知循环(无法决定下一步)
区分真正的死循环 vs 正常的渐进式进展`;

// 动态调整检测频率
llmCheckInterval = 3-15轮自适应;

// 批量工具调度
await Promise.all(toolCalls.map(tc => executeToolAsync(tc)));
```

---

### 3. Neovate Code
**核心优势:**
- ✅ **历史压缩机制** (autoCompact):
  ```typescript
  if (opts.autoCompact) {
    const compressed = await history.compress(opts.model);
  }
  ```
- ✅ **灵活钩子系统**:
  - `onToolUse`: 工具调用前处理
  - `onToolResult`: 结果后处理
  - `onToolApprove`: 用户审批
- ✅ **流式处理**:
  ```typescript
  for await (const chunk of result.toStream()) {
    if (chunk.type === 'text-delta') // 实时输出
    if (chunk.type === 'reasoning') // 推理过程
  }
  ```

**借鉴点:**
- 多种终止条件: 无工具调用、最大轮次、用户中断、工具被拒绝、API错误
- 简洁的 while(true) 主循环结构
- 完整的钩子系统支持自定义逻辑

---

### 4. Codex
**核心优势:**
- ✅ **三层架构** (最健壮):
  ```rust
  submission_loop()  // 主控制循环
    └─> run_task()   // 任务生命周期
        └─> run_turn()  // 单轮对话 + 重试
            └─> try_run_turn()  // 流处理
  ```
- ✅ **重试机制**: 处理流失败自动重试
- ✅ **优雅中断处理**:
  - 检查 handle.is_finished()
  - 发送 TurnAbortedEvent
  - 清理 review_mode 状态

**借鉴点:**
```typescript
// 处理缺失的 tool_call 响应
const missing_calls = prompt.input
  .filter(callId => !completed_call_ids.includes(callId))
  .map(callId => ({ call_id: callId, output: "aborted" }));

// 重试循环
let retries = 0;
while (retries < maxRetries) {
  try {
    return await tryExecute();
  } catch (error) {
    if (isRetriable(error)) retries++;
  }
}
```

---

## 🎯 融合架构设计

### 三层结构 (借鉴 Codex)

```
Layer 1: AgentLoop (主控制)
  ├─ 管理全局状态
  ├─ 循环检测 (Gemini CLI)
  └─ 历史压缩 (Neovate)

Layer 2: TaskExecution (任务执行)
  ├─ 子任务分支 (Claude Code)
  ├─ 重试机制 (Codex)
  └─ 钩子系统 (Neovate)

Layer 3: TurnExecution (单轮对话)
  ├─ 流式处理 (Neovate)
  ├─ 批量工具调度 (Gemini CLI)
  └─ 优雅中断 (Codex)
```

---

## Phase 1: 核心循环 + 循环检测 (3天)

### 1.1 主循环结构

**文件**: `src/agent/AgentLoop.ts` (新建)

```typescript
/**
 * AgentLoop - 主控制循环
 * 融合 Codex 的三层架构 + Neovate 的简洁实现
 */
export class AgentLoop extends EventEmitter {
  private loopDetector: LoopDetectionService;
  private historyManager: HistoryManager;

  constructor(
    private agent: Agent,
    private config: LoopConfig
  ) {
    super();

    // 初始化循环检测 (Gemini CLI)
    this.loopDetector = new LoopDetectionService({
      toolCallThreshold: 5,      // 连续5次相同工具
      contentRepeatThreshold: 10, // 10次重复内容
      llmCheckInterval: 30,      // 30轮后启用LLM检测
    });

    // 初始化历史管理 (Neovate)
    this.historyManager = new HistoryManager({
      autoCompact: true,
      maxMessages: 50,
    });
  }

  /**
   * 主循环 - 融合 Codex run_task + Neovate while(true)
   */
  async run(
    message: string,
    context: ChatContext,
    options?: LoopOptions
  ): Promise<LoopResult> {
    const startTime = Date.now();
    let turnsCount = 0;
    let toolCallsCount = 0;
    const maxTurns = options?.maxTurns || 50;

    // 初始化消息历史
    const messages = this.historyManager.initialize(context.messages, message);

    // 主循环
    while (true) {
      // === 1. 检查终止条件 (Neovate) ===
      const shouldStop = await this.checkStopConditions(
        turnsCount,
        maxTurns,
        options?.signal
      );
      if (shouldStop) {
        return shouldStop;
      }

      turnsCount++;
      this.emit('turnStart', { turn: turnsCount, maxTurns });

      // === 2. 历史压缩 (Neovate) ===
      if (turnsCount % 5 === 0) {
        await this.historyManager.compressIfNeeded(messages);
      }

      // === 3. 执行单轮对话 (调用 Layer 2) ===
      const turnResult = await this.executeTurn(
        messages,
        turnsCount,
        options
      );

      // === 4. 检查是否有工具调用 ===
      if (!turnResult.toolCalls || turnResult.toolCalls.length === 0) {
        // 无工具调用,任务完成
        return {
          success: true,
          finalMessage: turnResult.content,
          metadata: {
            turnsCount,
            toolCallsCount,
            duration: Date.now() - startTime,
          },
        };
      }

      // === 5. 循环检测 (Gemini CLI) ===
      const loopDetected = await this.loopDetector.detect(
        turnResult.toolCalls,
        turnsCount,
        messages
      );

      if (loopDetected) {
        // 注入警告让 LLM 改变策略
        messages.push({
          role: 'user',
          content: `⚠️ 检测到循环: ${loopDetected.reason}\n请尝试不同的方法。`,
        });
        continue; // 跳过工具执行,让 LLM 重新思考
      }

      // === 6. 添加 assistant 消息 ===
      messages.push({
        role: 'assistant',
        content: turnResult.content || '',
      });

      // === 7. 批量执行工具 (Gemini CLI) ===
      const toolResults = await this.executeToolsBatch(
        turnResult.toolCalls,
        options
      );

      toolCallsCount += toolResults.length;

      // === 8. 注入工具结果 ===
      for (const result of toolResults) {
        messages.push(result.message);
      }

      // 继续下一轮
    }
  }

  /**
   * 检查终止条件 (Neovate)
   */
  private async checkStopConditions(
    turnsCount: number,
    maxTurns: number,
    signal?: AbortSignal
  ): Promise<LoopResult | null> {
    // 1. 用户中断 (Codex)
    if (signal?.aborted) {
      // 清理当前工具执行
      await this.cleanupPendingTools();

      // 保存当前状态
      await this.saveState();

      // 发送中断事件
      this.emit('taskAborted', { reason: 'user_interrupt' });

      return {
        success: false,
        error: { type: 'canceled', message: '用户中断' },
      };
    }

    // 2. 最大轮次 (Neovate)
    if (turnsCount >= maxTurns) {
      return {
        success: false,
        error: {
          type: 'max_turns_exceeded',
          message: `超过最大轮次 ${maxTurns}`
        },
      };
    }

    return null;
  }

  /**
   * 清理待执行工具 (Codex 优雅中断)
   */
  private async cleanupPendingTools(): Promise<void> {
    // 取消所有进行中的工具执行
    // 保存部分结果
  }

  /**
   * 保存当前状态 (Codex)
   */
  private async saveState(): Promise<void> {
    // 保存消息历史、轮次计数等
  }
}
```

### 1.2 循环检测服务 (Gemini CLI 最佳实践)

**文件**: `src/agent/LoopDetectionService.ts` (新建)

```typescript
/**
 * 循环检测服务 - 参考 Gemini CLI 三层检测机制
 */
export class LoopDetectionService {
  // 工具调用历史
  private toolCallHistory: Array<{
    name: string;
    paramsHash: string;
    turn: number;
  }> = [];

  // 内容历史 (用于检测重复)
  private contentHistory: string[] = [];

  // LLM 检测计数器
  private turnsInCurrentPrompt = 0;
  private llmCheckInterval: number;

  constructor(private config: {
    toolCallThreshold: number;
    contentRepeatThreshold: number;
    llmCheckInterval: number;
  }) {
    this.llmCheckInterval = config.llmCheckInterval;
  }

  /**
   * 主检测方法 - 三层检测机制
   */
  async detect(
    toolCalls: ToolCall[],
    currentTurn: number,
    messages: Message[]
  ): Promise<{ detected: boolean; reason: string } | null> {
    this.turnsInCurrentPrompt = currentTurn;

    // === 层1: 工具调用循环检测 ===
    const toolLoop = this.detectToolCallLoop(toolCalls);
    if (toolLoop) {
      return {
        detected: true,
        reason: `重复调用工具 ${toolLoop.toolName} ${this.config.toolCallThreshold}次`
      };
    }

    // === 层2: 内容循环检测 ===
    const contentLoop = this.detectContentLoop(messages);
    if (contentLoop) {
      return {
        detected: true,
        reason: '检测到重复内容模式'
      };
    }

    // === 层3: LLM 智能检测 ===
    if (currentTurn >= this.llmCheckInterval) {
      const llmLoop = await this.detectLlmLoop(messages);
      if (llmLoop) {
        return {
          detected: true,
          reason: 'AI判断陷入认知循环'
        };
      }

      // 动态调整检测间隔 (3-15轮)
      this.llmCheckInterval = Math.min(this.llmCheckInterval + 5, 15);
    }

    return null;
  }

  /**
   * 工具调用循环检测 (Gemini CLI)
   * 检测连续N次相同工具调用
   */
  private detectToolCallLoop(toolCalls: ToolCall[]): { toolName: string } | null {
    for (const tc of toolCalls) {
      const hash = this.hashParams(tc.function.arguments);
      this.toolCallHistory.push({
        name: tc.function.name,
        paramsHash: hash,
        turn: Date.now(),
      });

      // 检查最近N次
      const threshold = this.config.toolCallThreshold;
      const recent = this.toolCallHistory.slice(-threshold);

      if (recent.length === threshold && recent.every(
        h => h.name === tc.function.name && h.paramsHash === hash
      )) {
        return { toolName: tc.function.name };
      }
    }

    return null;
  }

  /**
   * 内容循环检测 (Gemini CLI)
   * 使用滑动窗口检测重复内容块
   */
  private detectContentLoop(messages: Message[]): boolean {
    const recentContent = messages
      .slice(-10)
      .map(m => typeof m.content === 'string' ? m.content : '')
      .join('\n');

    this.contentHistory.push(recentContent);

    // 检查是否有重复块
    if (this.contentHistory.length < this.config.contentRepeatThreshold) {
      return false;
    }

    const recent = this.contentHistory.slice(-this.config.contentRepeatThreshold);
    const hashes = recent.map(c => this.hashContent(c));

    // 检查是否有超过50%的相似度
    const uniqueHashes = new Set(hashes);
    return uniqueHashes.size < hashes.length / 2;
  }

  /**
   * LLM 智能检测 (Gemini CLI)
   * 使用专门的系统提示让 LLM 分析是否陷入循环
   */
  private async detectLlmLoop(messages: Message[]): Promise<boolean> {
    const LOOP_DETECTION_PROMPT = `你是AI循环诊断专家。分析以下对话历史，判断AI是否陷入无效状态:

无效状态特征:
- 重复操作: 相同工具/响应重复多次
- 认知循环: 无法决定下一步，表达困惑

关键: 区分真正的死循环 vs 正常的渐进式进展

最近对话历史:
${this.formatMessagesForDetection(messages.slice(-10))}

回答 "YES" (陷入循环) 或 "NO" (正常进展)`;

    // TODO: 调用 ChatService 进行判断
    // const response = await this.chatService.chatSimple(LOOP_DETECTION_PROMPT);
    // return response.toLowerCase().includes('yes');

    return false; // 暂时禁用
  }

  private hashParams(args: string): string {
    // 使用简单的 hash 算法
    let hash = 0;
    for (let i = 0; i < args.length; i++) {
      const char = args.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString();
  }

  private hashContent(content: string): string {
    return this.hashParams(content);
  }

  private formatMessagesForDetection(messages: Message[]): string {
    return messages
      .map((m, i) => `[${i+1}] ${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 200) : '...'}`)
      .join('\n');
  }

  /**
   * 重置检测状态
   */
  reset(): void {
    this.toolCallHistory = [];
    this.contentHistory = [];
    this.turnsInCurrentPrompt = 0;
  }
}
```

---

## Phase 2: 单轮执行 + 子任务支持 (2天)

### 2.1 单轮对话执行 (融合 Codex 重试 + Neovate 流式)

**文件**: `src/agent/TurnExecutor.ts` (新建)

```typescript
/**
 * TurnExecutor - 单轮对话执行
 * 融合 Codex 重试机制 + Neovate 流式处理
 */
export class TurnExecutor {
  constructor(
    private chatService: ChatService,
    private config: TurnExecutorConfig
  ) {}

  /**
   * 执行单轮 - 带重试 (Codex)
   */
  async execute(
    messages: Message[],
    tools: FunctionDeclaration[],
    options: TurnOptions
  ): Promise<TurnResult> {
    const maxRetries = options.maxRetries || 3;
    let retries = 0;

    while (retries < maxRetries) {
      try {
        return await this.tryExecuteTurn(messages, tools, options);
      } catch (error) {
        if (this.isRetriableError(error)) {
          retries++;
          console.log(`重试 ${retries}/${maxRetries}...`);

          // 指数退避
          await this.delay(1000 * Math.pow(2, retries - 1));
        } else {
          throw error;
        }
      }
    }

    throw new Error(`达到最大重试次数 ${maxRetries}`);
  }

  /**
   * 尝试执行单轮 - 流式处理 (Neovate)
   */
  private async tryExecuteTurn(
    messages: Message[],
    tools: FunctionDeclaration[],
    options: TurnOptions
  ): Promise<TurnResult> {
    const response = await this.chatService.chatDetailed(
      messages,
      tools,
      { systemPrompt: options.systemPrompt }
    );

    // 如果支持流式,处理流 (Neovate)
    if (options.stream && response.stream) {
      for await (const chunk of response.stream) {
        if (chunk.type === 'text-delta') {
          options.onTextDelta?.(chunk.text);
        }
        if (chunk.type === 'reasoning') {
          options.onReasoning?.(chunk.reasoning);
        }
      }
    }

    return response;
  }

  /**
   * 判断是否可重试 (Codex)
   */
  private isRetriableError(error: any): boolean {
    // 网络错误、流中断等可重试
    const retriableCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'];
    const retriableMessages = ['stream closed', 'connection reset', 'timeout'];

    return (
      retriableCodes.includes(error.code) ||
      retriableMessages.some(msg => error.message?.toLowerCase().includes(msg))
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

interface TurnOptions {
  systemPrompt?: string;
  maxRetries?: number;
  stream?: boolean;
  onTextDelta?: (text: string) => void;
  onReasoning?: (reasoning: string) => void;
}

interface TurnResult {
  content: string;
  toolCalls?: ToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}
```

### 2.2 子任务支持 (Claude Code)

**文件**: `src/tools/builtin/task/TaskTool.ts` (修改现有文件)

```typescript
import { DeclarativeTool } from '../../base/DeclarativeTool.js';
import { ToolInvocation } from '../../base/ToolInvocation.js';
import type { Agent } from '../../../agent/Agent.js';

/**
 * Task Tool - 支持子任务递归
 * 参考 Claude Code 的嵌套结构
 */
export class TaskTool extends DeclarativeTool {
  constructor(private agentFactory: () => Promise<Agent>) {
    super(
      'Task',
      '任务工具',
      '将复杂任务委托给子代理执行。适用于需要独立上下文的子任务。',
      'system',
      {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '子任务的详细描述'
          },
          context: {
            type: 'object',
            description: '传递给子任务的上下文信息',
            properties: {
              workspaceRoot: { type: 'string' },
              sessionId: { type: 'string' },
            }
          },
          maxTurns: {
            type: 'number',
            description: '子任务最大轮次限制',
            default: 10,
          }
        },
        required: ['prompt'],
      }
    );
  }

  build(params: {
    prompt: string;
    context?: any;
    maxTurns?: number;
  }) {
    return new ToolInvocation(
      this,
      params,
      async (signal: AbortSignal) => {
        try {
          // 创建子代理
          const subAgent = await this.agentFactory();
          await subAgent.initialize();

          // 执行子任务 (递归调用 AgentLoop)
          const result = await subAgent.runAgenticLoop(
            params.prompt,
            params.context || {},
            {
              maxTurns: params.maxTurns || 10,
              signal,
            }
          );

          if (result.success) {
            return {
              success: true,
              llmContent: result.finalMessage,
              displayContent: `✅ 子任务完成: ${result.metadata.turnsCount}轮, ${result.metadata.toolCallsCount}次工具调用`,
              metadata: result.metadata,
            };
          } else {
            return {
              success: false,
              error: {
                message: `子任务失败: ${result.error.type}`,
                details: result.error,
              },
            };
          }
        } catch (error) {
          return {
            success: false,
            error: {
              message: `子任务执行异常: ${error.message}`,
            },
          };
        }
      }
    );
  }
}
```

---

## Phase 3: 批量工具执行 + 钩子系统 (2天)

### 3.1 批量工具调度 (Gemini CLI)

**文件**: `src/agent/ToolExecutor.ts` (新建)

```typescript
import type { DeclarativeTool } from '../tools/base/DeclarativeTool.js';
import type { ToolResult } from '../tools/types/index.js';

/**
 * ToolExecutor - 批量工具执行
 * 参考 Gemini CLI 的并行调度 + Neovate 的钩子系统
 */
export class ToolExecutor {
  constructor(
    private registry: ToolRegistry,
    private config: ToolExecutorConfig
  ) {}

  /**
   * 批量执行工具 (并行) - Gemini CLI
   */
  async executeBatch(
    toolCalls: ToolCall[],
    options: ExecuteOptions
  ): Promise<ToolExecutionResult[]> {
    // === 1. 前置钩子 (Neovate onToolUse) ===
    const processedCalls = await Promise.all(
      toolCalls.map(async (tc) => {
        if (options.onToolUse) {
          return await options.onToolUse(tc) || tc;
        }
        return tc;
      })
    );

    // === 2. 用户审批 (Neovate onToolApprove) ===
    const approvedCalls: ToolCall[] = [];
    for (const tc of processedCalls) {
      const approved = await options.onToolApprove?.(tc) ?? true;

      if (approved) {
        approvedCalls.push(tc);
      } else {
        // 用户拒绝
        this.emit('toolDenied', tc);
      }
    }

    if (approvedCalls.length === 0) {
      throw new Error('所有工具调用都被拒绝');
    }

    // === 3. 并行执行 (Gemini CLI) ===
    const results = await Promise.allSettled(
      approvedCalls.map(tc => this.executeSingle(tc, options))
    );

    // === 4. 后置钩子 (Neovate onToolResult) ===
    const finalResults = await Promise.all(
      results.map(async (r, i) => {
        const toolCall = approvedCalls[i];
        const result = r.status === 'fulfilled'
          ? r.value
          : {
              success: false,
              error: { message: r.reason?.message || '执行失败' }
            };

        // 调用后置钩子
        if (options.onToolResult) {
          const modifiedResult = await options.onToolResult(toolCall, result);
          return modifiedResult || result;
        }

        return result;
      })
    );

    return finalResults.map((result, i) => ({
      toolCall: approvedCalls[i],
      result,
      message: this.formatToolResultMessage(approvedCalls[i], result),
    }));
  }

  /**
   * 执行单个工具
   */
  private async executeSingle(
    toolCall: ToolCall,
    options: ExecuteOptions
  ): Promise<ToolResult> {
    const tool = this.registry.get(toolCall.function.name);
    if (!tool) {
      throw new Error(`工具不存在: ${toolCall.function.name}`);
    }

    const params = JSON.parse(toolCall.function.arguments);
    const invocation = tool.build(params);

    // 超时控制 (30s)
    const timeout = this.createTimeout(30000);

    try {
      return await Promise.race([
        invocation.execute(options.signal || new AbortController().signal),
        timeout.promise,
      ]);
    } finally {
      timeout.clear();
    }
  }

  /**
   * 创建超时 Promise
   */
  private createTimeout(ms: number): {
    promise: Promise<never>;
    clear: () => void;
  } {
    let timeoutId: NodeJS.Timeout;

    const promise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`工具执行超时 (${ms}ms)`));
      }, ms);
    });

    return {
      promise,
      clear: () => clearTimeout(timeoutId),
    };
  }

  /**
   * 格式化工具结果为消息
   */
  private formatToolResultMessage(
    toolCall: ToolCall,
    result: ToolResult
  ): Message {
    const content = result.success
      ? result.llmContent || result.displayContent || '执行成功'
      : result.error?.message || '执行失败';

    return {
      role: 'user',
      content: `工具 ${toolCall.function.name} 执行结果: ${result.success ? '✅ 成功' : '❌ 失败'}\n\n${content}`,
    };
  }
}

interface ExecuteOptions {
  signal?: AbortSignal;
  onToolUse?: (toolCall: ToolCall) => Promise<ToolCall | void>;
  onToolApprove?: (toolCall: ToolCall) => Promise<boolean>;
  onToolResult?: (toolCall: ToolCall, result: ToolResult) => Promise<ToolResult | void>;
}

interface ToolExecutionResult {
  toolCall: ToolCall;
  result: ToolResult;
  message: Message;
}
```

---

## Phase 4: 历史管理 + 优雅中断 (1天)

### 4.1 历史管理 (Neovate)

**文件**: `src/agent/HistoryManager.ts` (新建)

```typescript
import type { Message } from '../services/ChatService.js';

/**
 * HistoryManager - 历史压缩和管理
 * 参考 Neovate 的 autoCompact 机制
 */
export class HistoryManager {
  constructor(private config: {
    autoCompact: boolean;
    maxMessages: number;
    compressionThreshold?: number;
  }) {}

  /**
   * 初始化消息历史
   */
  initialize(contextMessages: Message[], newMessage: string): Message[] {
    return [
      ...contextMessages,
      { role: 'user', content: newMessage },
    ];
  }

  /**
   * 智能压缩 (Neovate)
   */
  async compressIfNeeded(messages: Message[]): Promise<Message[]> {
    const tokenCount = this.estimateTokens(messages);
    const threshold = this.config.compressionThreshold || 8000;

    if (tokenCount <= threshold) {
      return messages;
    }

    console.log(`历史压缩: ${messages.length}条消息, ${tokenCount} tokens → 压缩中...`);

    // 策略: 保留系统提示 + 最近N轮对话
    const keepRecent = 20; // 保留最近20条消息

    if (messages.length <= keepRecent + 2) {
      return messages;
    }

    const compressed = [
      ...messages.slice(0, 2), // 保留前2条(系统提示+初始用户消息)
      {
        role: 'system' as const,
        content: `[历史已压缩: ${messages.length - keepRecent - 2}条早期消息]`,
      },
      ...messages.slice(-keepRecent), // 保留最近N条
    ];

    const newTokenCount = this.estimateTokens(compressed);
    console.log(`压缩完成: ${compressed.length}条消息, ${newTokenCount} tokens`);

    return compressed;
  }

  /**
   * Token 估算 (简单版: 字符数 / 4)
   */
  estimateTokens(messages: Message[]): number {
    const totalChars = messages
      .map(m => {
        if (typeof m.content === 'string') {
          return m.content.length;
        } else if (Array.isArray(m.content)) {
          return m.content.reduce((sum, item) => {
            if (item.type === 'text' && item.text) {
              return sum + item.text.length;
            }
            return sum;
          }, 0);
        }
        return 0;
      })
      .reduce((sum, len) => sum + len, 0);

    return Math.ceil(totalChars / 4);
  }

  /**
   * 裁剪到指定大小
   */
  trimToSize(messages: Message[], maxMessages: number): Message[] {
    if (messages.length <= maxMessages) {
      return messages;
    }

    // 保留首尾消息
    return [
      ...messages.slice(0, 2),
      ...messages.slice(-(maxMessages - 2)),
    ];
  }
}
```

### 4.2 集成到 AgentLoop

**文件**: `src/agent/AgentLoop.ts` (添加方法)

```typescript
/**
 * 批量执行工具 - 调用 ToolExecutor
 */
private async executeToolsBatch(
  toolCalls: ToolCall[],
  options?: LoopOptions
): Promise<ToolExecutionResult[]> {
  const executor = new ToolExecutor(this.agent.getToolRegistry(), {});

  return executor.executeBatch(toolCalls, {
    signal: options?.signal,
    onToolUse: options?.onToolUse,
    onToolApprove: options?.onToolApprove,
    onToolResult: options?.onToolResult,
  });
}

/**
 * 执行单轮对话 - 调用 TurnExecutor
 */
private async executeTurn(
  messages: Message[],
  turnNumber: number,
  options?: LoopOptions
): Promise<TurnResult> {
  const executor = new TurnExecutor(this.agent.getChatService(), {});

  const tools = this.agent.getToolRegistry().getFunctionDeclarations();

  return executor.execute(messages, tools, {
    systemPrompt: this.agent.getSystemPrompt(),
    maxRetries: 3,
    stream: options?.stream,
    onTextDelta: (text) => this.emit('textDelta', { text, turn: turnNumber }),
    onReasoning: (reasoning) => this.emit('reasoning', { reasoning, turn: turnNumber }),
  });
}
```

---

## Phase 5: UI 进度展示 + ESC 停止 (1天)

### 5.1 进度组件

**文件**: `src/ui/components/AgentLoopProgress.tsx` (新建)

```typescript
import { Box, Text } from 'ink';
import React from 'react';

export interface LoopProgressProps {
  turn: number;
  maxTurns: number;
  currentTool?: string;
  status: 'running' | 'stopped' | 'completed' | 'error';
}

export const AgentLoopProgress: React.FC<LoopProgressProps> = ({
  turn,
  maxTurns,
  currentTool,
  status,
}) => {
  const progress = Math.floor((turn / maxTurns) * 100);

  const statusIcons = {
    running: '🔄',
    stopped: '⏸️',
    completed: '✅',
    error: '❌',
  };

  const statusColors = {
    running: 'cyan',
    stopped: 'yellow',
    completed: 'green',
    error: 'red',
  };

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" paddingX={1}>
      <Text color={statusColors[status]} bold>
        {statusIcons[status]} 回合 {turn}/{maxTurns} ({progress}%)
      </Text>

      {currentTool && status === 'running' && (
        <Text color="yellow" dimColor>
          🔧 正在执行: {currentTool}
        </Text>
      )}

      {status === 'stopped' && (
        <Text color="yellow" dimColor>
          任务已停止 (按 ESC 停止)
        </Text>
      )}
    </Box>
  );
};
```

### 5.2 集成到主 App

**文件**: `src/ui/App.tsx` (修改)

```typescript
import { AgentLoopProgress } from './components/AgentLoopProgress.js';

// 在组件中添加状态
const [loopState, setLoopState] = useState({
  active: false,
  turn: 0,
  maxTurns: 50,
  currentTool: undefined as string | undefined,
  status: 'running' as 'running' | 'stopped' | 'completed' | 'error',
});

// 监听 Agent 事件
useEffect(() => {
  if (!agent) return;

  const handleTurnStart = ({ turn, maxTurns }) => {
    setLoopState(prev => ({
      ...prev,
      active: true,
      turn,
      maxTurns,
      status: 'running',
    }));
  };

  const handleToolExecuting = (toolName: string) => {
    setLoopState(prev => ({
      ...prev,
      currentTool: toolName,
    }));
  };

  const handleTaskCompleted = () => {
    setLoopState(prev => ({
      ...prev,
      active: false,
      status: 'completed',
    }));
  };

  const handleTaskAborted = () => {
    setLoopState(prev => ({
      ...prev,
      active: false,
      status: 'stopped',
    }));
  };

  agent.on('turnStart', handleTurnStart);
  agent.on('toolExecuting', handleToolExecuting);
  agent.on('taskCompleted', handleTaskCompleted);
  agent.on('taskAborted', handleTaskAborted);

  return () => {
    agent.off('turnStart', handleTurnStart);
    agent.off('toolExecuting', handleToolExecuting);
    agent.off('taskCompleted', handleTaskCompleted);
    agent.off('taskAborted', handleTaskAborted);
  };
}, [agent]);

// 渲染进度组件
return (
  <Box flexDirection="column">
    {loopState.active && (
      <AgentLoopProgress
        turn={loopState.turn}
        maxTurns={loopState.maxTurns}
        currentTool={loopState.currentTool}
        status={loopState.status}
      />
    )}

    {/* 其他 UI 组件 */}
  </Box>
);
```

### 5.3 ESC 停止机制

**文件**: `src/ui/components/InputArea.tsx` (修改)

```typescript
import { useInput } from 'ink';
import { useRef } from 'react';

export const InputArea: React.FC<InputAreaProps> = ({ onSubmit, agent }) => {
  const abortController = useRef(new AbortController());

  // 监听键盘输入
  useInput((input, key) => {
    if (key.escape) {
      // ESC - 优雅停止
      console.log('⏸️  用户请求停止任务...');
      abortController.current.abort();

      // 显示提示
      setStatus('⏸️  任务正在停止...');
    }
  });

  // 提交任务时传递 signal
  const handleSubmit = async (message: string) => {
    // 重置 AbortController
    abortController.current = new AbortController();

    await onSubmit(message, {
      signal: abortController.current.signal,
    });
  };

  return (
    <Box>
      {/* Input UI */}
    </Box>
  );
};
```

---

## 融合效果对比

| 特性 | Claude Code | Gemini CLI | Neovate | Codex | **融合方案** |
|------|------------|-----------|---------|-------|------------|
| 任务分层 | ✅ Task tool | ❌ | ❌ | ❌ | ✅ 支持 |
| 循环检测 | ❌ | ✅✅✅ 三层 | ❌ | ❌ | ✅✅✅ 完整 |
| 历史压缩 | ❌ | ❌ | ✅ | ❌ | ✅ 支持 |
| 流式处理 | ❌ | ✅ | ✅ | ✅ | ✅ 支持 |
| 钩子系统 | ❌ | ❌ | ✅✅ | ❌ | ✅✅ 完整 |
| 重试机制 | ❌ | ❌ | ❌ | ✅✅ | ✅✅ 支持 |
| 批量工具 | ❌ | ✅✅ | ❌ | ❌ | ✅✅ 支持 |
| 优雅中断 | ❌ | ❌ | ✅ | ✅✅ | ✅✅ 支持 |

---

## 类型定义

**文件**: `src/agent/types.ts` (添加)

```typescript
import type { Message } from '../services/ChatService.js';

export interface LoopConfig {
  maxTurns?: number;
  autoCompact?: boolean;
  compressionThreshold?: number;
  loopDetection?: {
    enabled: boolean;
    toolCallThreshold: number;
    contentRepeatThreshold: number;
    llmCheckInterval: number;
  };
}

export interface LoopOptions {
  maxTurns?: number;
  autoCompact?: boolean;
  signal?: AbortSignal;
  stream?: boolean;
  onTurnStart?: (data: { turn: number; maxTurns: number }) => void;
  onToolUse?: (toolCall: ToolCall) => Promise<ToolCall | void>;
  onToolApprove?: (toolCall: ToolCall) => Promise<boolean>;
  onToolResult?: (toolCall: ToolCall, result: ToolResult) => Promise<ToolResult | void>;
}

export interface LoopResult {
  success: boolean;
  finalMessage?: string;
  error?: {
    type: 'canceled' | 'max_turns_exceeded' | 'api_error' | 'loop_detected';
    message: string;
    details?: any;
  };
  metadata?: {
    turnsCount: number;
    toolCallsCount: number;
    duration: number;
  };
}

export interface ToolCall {
  id?: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}
```

---

## 实施计划

### Week 1: Phase 1 - 核心循环 + 循环检测
- Day 1-2: 实现 `AgentLoop` 主循环
- Day 3: 实现 `LoopDetectionService` 三层检测
- Day 4: 单元测试和简单集成测试

### Week 2: Phase 2 - 单轮执行 + 子任务
- Day 1: 实现 `TurnExecutor` 重试机制
- Day 2: 实现 `TaskTool` 子任务支持
- Day 3-4: 集成测试

### Week 3: Phase 3 - 批量工具 + 钩子
- Day 1-2: 实现 `ToolExecutor` 批量执行
- Day 3: 实现钩子系统集成
- Day 4: 测试和优化

### Week 4: Phase 4+5 - 历史管理 + UI
- Day 1: 实现 `HistoryManager`
- Day 2: 实现 UI 进度组件
- Day 3: ESC 停止机制
- Day 4-5: 完整测试和文档

---

## 测试场景

### 1. 简单任务 (单轮)
```bash
blade "现在几点了？"

# 预期: 1轮,无工具调用,直接返回
```

### 2. 多工具任务 (3-5轮)
```bash
blade "分析 src/index.ts,找出所有 TODO 注释"

# 预期流程:
# 轮1: ReadTool(src/index.ts)
# 轮2: GrepTool(TODO)
# 轮3: 汇总结果
```

### 3. 复杂重构任务 (10-15轮)
```bash
blade "重构 src/index.ts,提取公共函数到 utils/"

# 预期流程:
# 轮1: ReadTool(src/index.ts)
# 轮2: GrepTool(重复代码)
# 轮3: WriteTool(utils/helpers.ts)
# 轮4: EditTool(src/index.ts)
# 轮5: BashTool(npm test)
# ...
```

### 4. 循环检测
```bash
blade "读取不存在的文件 /foo/bar.txt"

# 预期: 检测到重复 ReadTool 调用,注入警告
```

### 5. 子任务
```bash
blade "分析项目结构并生成文档"

# 预期: 使用 TaskTool 创建多个子任务
```

### 6. ESC 中断
```bash
blade "执行长时间任务..."
[用户按 ESC]

# 预期: 优雅停止,保存状态
```

---

## 总结

这个融合方案综合了4个优秀工具的最佳实践:

1. **Claude Code**: 任务分层和子任务支持
2. **Gemini CLI**: 三层循环检测 + 批量工具调度
3. **Neovate Code**: 历史压缩 + 钩子系统 + 简洁循环
4. **Codex**: 三层架构 + 重试机制 + 优雅中断

**核心优势:**
- ✅ 功能最完整 (覆盖所有场景)
- ✅ 架构最清晰 (三层设计)
- ✅ 可靠性最高 (重试+循环检测)
- ✅ 扩展性最强 (钩子系统)

**开发周期: 4周**

**代码量估算:**
- 新增文件: 6个 (~1500行)
- 修改文件: 3个 (~300行)
- 总计: ~1800行代码

这将让 Blade 从 "基础聊天机器人" 升级为 **企业级 Agentic CLI 工具**! 🚀
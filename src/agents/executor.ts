/**
 * Blade Subagent System - Executor
 *
 * Subagent 执行引擎：创建隔离环境、管理执行循环、控制资源预算
 */

import type { Agent } from '../agent/Agent.js';
import type { LoopOptions, LoopResult } from '../agent/types.js';
import { ToolRegistry } from '../tools/registry/ToolRegistry.js';
import { createConfirmationHandler, isReadOnlyTool } from './confirmation.js';
import type {
  SubagentActivity,
  SubagentDefinition,
  SubagentResult,
  TokenUsage,
} from './types.js';
import { TerminateReason, TokenBudgetExceededError } from './types.js';

/**
 * 扩展的执行上下文，包含 subagent 需要的额外字段
 */
export interface SubagentExecutionContext {
  userId?: string;
  sessionId?: string;
  messageId?: string;
  workspaceRoot?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  updateOutput?: (output: string) => void;
  confirmationHandler?: any;
  permissionMode?: string;

  // Subagent 特定字段
  toolRegistry: ToolRegistry;
  config?: Record<string, unknown>;
  runtimeOptions?: Record<string, unknown>;
}

/**
 * Subagent 执行器
 *
 * 负责:
 * 1. 创建隔离的工具环境
 * 2. 执行 subagent 的主循环
 * 3. 监控 Token 使用
 * 4. 处理写入确认
 * 5. 记录活动日志
 */
export class SubagentExecutor {
  /** Token 使用统计 */
  private tokenUsage: TokenUsage = { input: 0, output: 0, total: 0 };

  /** 活动记录 */
  private activities: SubagentActivity[] = [];

  /** 执行开始时间 */
  private startTime = 0;

  /** 实际执行回合数 */
  private turns = 0;

  /** 是否已完成 */
  private completed = false;

  /** 完成时的输出 */
  private completionOutput: unknown = null;

  constructor(
    private definition: SubagentDefinition,
    private parentContext: SubagentExecutionContext
  ) {}

  /**
   * 执行 subagent
   *
   * @param params 输入参数
   * @param options 执行选项
   * @returns SubagentResult
   */
  async execute(
    params: Record<string, unknown>,
    options: {
      signal?: AbortSignal;
      onActivity?: (activity: SubagentActivity) => void;
    } = {}
  ): Promise<SubagentResult> {
    this.startTime = Date.now();
    this.tokenUsage = { input: 0, output: 0, total: 0 };
    this.activities = [];
    this.turns = 0;
    this.completed = false;
    this.completionOutput = null;

    let terminateReason: TerminateReason = TerminateReason.ERROR;

    try {
      // 1. 验证输入（如果有 schema）
      if (this.definition.inputSchema) {
        // TODO: 使用 JSON Schema 验证库验证输入
      }

      // 2. 创建隔离的工具注册表
      const isolatedRegistry = this.createIsolatedToolRegistry();

      // 3. 添加 complete_subagent_task 工具
      await this.addCompletionTool(isolatedRegistry);

      // 4. 创建写入确认处理器
      const _confirmationHandler = createConfirmationHandler(
        this.parentContext.confirmationHandler,
        this.definition.name
      );

      // 5. 创建子 Agent（使用父 context 的配置）
      const { Agent: AgentClass } = await import('../agent/Agent.js');

      // 创建隔离的 ExecutionPipeline
      const { ExecutionPipeline } = await import(
        '../tools/execution/ExecutionPipeline.js'
      );
      const isolatedPipeline = new ExecutionPipeline(isolatedRegistry);

      // 创建子 Agent
      // 注意：这里传递 config 可能会有类型问题，但在运行时应该可以工作
      // 因为 Agent 构造函数会处理配置的合并
      const subAgent = new AgentClass(
        (this.parentContext.config as any) || {},
        {
          systemPrompt: this.definition.systemPrompt,
          ...this.parentContext.runtimeOptions,
        } as any,
        isolatedPipeline
      ) as Agent;

      await subAgent.initialize();

      // 6. 构建提示词
      const prompt = this.buildPrompt(params);

      // 7. 执行主循环
      const loopOptions: LoopOptions = {
        maxTurns: this.definition.maxTurns || 10,
        signal: options.signal,
        // 监控工具调用结果，用于活动记录
        onToolResult: async (toolCall, result) => {
          const toolName =
            'function' in toolCall ? toolCall.function.name : toolCall.type;

          this.recordActivity({
            type: 'tool_result',
            timestamp: new Date().toISOString(),
            data: {
              tool: toolName,
              success: result.success,
            },
          });

          // 如果有活动回调，通知外部
          if (options.onActivity) {
            options.onActivity({
              type: 'tool_result',
              timestamp: new Date().toISOString(),
              data: {
                tool: toolName,
                success: result.success,
              },
            });
          }

          return result;
        },
        // 监控工具调用开始
        onToolStart: (toolCall) => {
          const toolName =
            'function' in toolCall ? toolCall.function.name : toolCall.type;
          const toolArgs =
            'function' in toolCall ? toolCall.function.arguments : undefined;

          this.recordActivity({
            type: 'tool_call',
            timestamp: new Date().toISOString(),
            data: {
              tool: toolName,
              arguments: toolArgs,
            },
          });

          if (options.onActivity) {
            options.onActivity({
              type: 'tool_call',
              timestamp: new Date().toISOString(),
              data: {
                tool: toolName,
              },
            });
          }
        },
      };

      const result: LoopResult = await subAgent.runAgenticLoop(
        prompt,
        {
          messages: [],
          userId: this.parentContext.userId || 'subagent',
          sessionId: `subagent-${this.definition.name}-${Date.now()}`,
          workspaceRoot: this.parentContext.workspaceRoot || process.cwd(),
          signal: options.signal,
          confirmationHandler: this.parentContext.confirmationHandler,
        },
        loopOptions
      );

      this.turns = result.metadata?.toolCallsCount || 0;

      // 8. 检查是否调用了 complete_subagent_task
      if (this.completed) {
        terminateReason = TerminateReason.GOAL;
      } else if (!result.success) {
        // 检查停止原因
        if (result.error?.type === 'aborted' || result.error?.type === 'canceled') {
          terminateReason = TerminateReason.ABORTED;
        } else if (result.error?.type === 'max_turns_exceeded') {
          terminateReason = TerminateReason.MAX_TURNS;
        } else {
          terminateReason = TerminateReason.ERROR;
        }
      } else {
        terminateReason = TerminateReason.GOAL;
      }

      // 9. 使用完成时的输出或循环结果
      const output = this.completed ? this.completionOutput : result.finalMessage;

      // 10. 验证输出（如果有 schema）
      if (this.definition.outputSchema && output) {
        // TODO: 使用 JSON Schema 验证输出
      }

      return {
        output,
        terminateReason,
        turns: this.turns,
        duration: Date.now() - this.startTime,
        tokenUsage: this.tokenUsage,
        activities: options.onActivity ? this.activities : undefined,
      };
    } catch (error) {
      // 处理错误
      if (error instanceof TokenBudgetExceededError) {
        terminateReason = TerminateReason.TOKEN_LIMIT;
      } else if ((error as Error).name === 'AbortError') {
        terminateReason = TerminateReason.ABORTED;
      } else {
        terminateReason = TerminateReason.ERROR;
      }

      return {
        output: null,
        terminateReason,
        turns: this.turns,
        duration: Date.now() - this.startTime,
        tokenUsage: this.tokenUsage,
        activities: options.onActivity ? this.activities : undefined,
      };
    }
  }

  /**
   * 创建隔离的工具注册表
   *
   * 只包含 definition 中指定的工具
   */
  private createIsolatedToolRegistry(): ToolRegistry {
    const isolated = new ToolRegistry();
    const parentRegistry = this.parentContext.toolRegistry;

    // 如果未指定 tools，继承所有工具
    if (!this.definition.tools) {
      // 复制父注册表的所有工具
      for (const tool of parentRegistry.getAll()) {
        isolated.register(tool);
      }
      return isolated;
    }

    // 只注册指定的工具
    for (const toolName of this.definition.tools) {
      const tool = parentRegistry.get(toolName);

      if (!tool) {
        console.warn(
          `[Subagent ${this.definition.name}] Tool '${toolName}' not found in parent registry`
        );
        continue;
      }

      // 检查是否为只读工具（可选的安全检查）
      if (!isReadOnlyTool(toolName)) {
        console.log(
          `[Subagent ${this.definition.name}] Registering write tool '${toolName}' (requires confirmation)`
        );
      }

      isolated.register(tool);
    }

    return isolated;
  }

  /**
   * 添加 complete_subagent_task 工具
   *
   * 这个工具用于 subagent 标记任务完成并返回结果
   */
  private async addCompletionTool(registry: ToolRegistry): Promise<void> {
    const { z } = await import('zod');
    const { createTool } = await import('../tools/core/createTool.js');
    const { ToolKind } = await import('../tools/types/index.js');

    const completionTool = createTool({
      name: 'complete_subagent_task',
      displayName: '完成Subagent任务',
      kind: ToolKind.Other,
      description: {
        short: '完成 subagent 任务并返回结果',
        long: '调用此工具表示任务已完成，并返回最终结果。',
      },
      schema: z.object({
        output: z.any().describe('任务输出结果'),
        summary: z.string().optional().describe('任务完成总结'),
      }),
      execute: async (params: { output?: unknown; summary?: string }) => {
        // 标记为已完成
        this.completed = true;
        this.completionOutput = params.output;

        // 记录活动
        this.recordActivity({
          type: 'tool_call',
          timestamp: new Date().toISOString(),
          data: {
            tool: 'complete_subagent_task',
            params,
          },
        });

        return {
          success: true,
          llmContent: `✅ 任务完成\n\n${params.summary || ''}`,
          displayContent: `任务完成: ${params.summary || '已完成'}`,
        };
      },
    });

    registry.register(completionTool as any);
  }

  /**
   * 构建提示词
   *
   * 支持模板变量替换（${variable}）
   */
  private buildPrompt(params: Record<string, unknown>): string {
    let prompt = (params.prompt as string) || '';

    // 简单的模板变量替换
    for (const [key, value] of Object.entries(params)) {
      if (key !== 'prompt') {
        const placeholder = `\${${key}}`;
        // 转义正则表达式特殊字符
        const escapedPlaceholder = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        prompt = prompt.replace(new RegExp(escapedPlaceholder, 'g'), String(value));
      }
    }

    return prompt;
  }

  /**
   * 记录活动
   */
  private recordActivity(activity: SubagentActivity): void {
    this.activities.push(activity);

    // 限制活动记录数量（避免内存溢出）
    if (this.activities.length > 1000) {
      this.activities.shift();
    }
  }

  /**
   * 更新 Token 使用量
   */
  private updateTokenUsage(usage: { input: number; output: number }): void {
    this.tokenUsage.input += usage.input;
    this.tokenUsage.output += usage.output;
    this.tokenUsage.total = this.tokenUsage.input + this.tokenUsage.output;

    const budget = this.definition.tokenBudget || 100000;

    if (this.tokenUsage.total > budget) {
      throw new TokenBudgetExceededError(
        `Token budget exceeded: ${this.tokenUsage.total}/${budget}`
      );
    }
  }
}

/**
 * 创建 Subagent 执行器
 *
 * @param definition Subagent 定义
 * @param parentContext 父执行上下文
 * @returns SubagentExecutor 实例
 */
export function createExecutor(
  definition: SubagentDefinition,
  parentContext: SubagentExecutionContext
): SubagentExecutor {
  return new SubagentExecutor(definition, parentContext);
}

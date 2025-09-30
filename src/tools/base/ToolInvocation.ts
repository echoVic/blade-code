import type {
  ConfirmationDetails,
  ToolInvocation,
  ToolResult,
} from '../types/index.js';
import { ResultProcessor } from '../execution/ResultProcessor.js';

/**
 * 工具调用抽象基类
 * 实现了通用的工具调用逻辑
 */
export abstract class BaseToolInvocation<TParams = any, TResult = ToolResult>
  implements ToolInvocation<TParams, TResult>
{
  constructor(
    public readonly toolName: string,
    public readonly params: TParams
  ) {}

  /**
   * 获取工具描述
   */
  abstract getDescription(): string;

  /**
   * 获取受影响的路径
   */
  abstract getAffectedPaths(): string[];

  /**
   * 是否需要用户确认
   */
  abstract shouldConfirm(): Promise<ConfirmationDetails | null>;

  /**
   * 执行工具
   */
  abstract execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void
  ): Promise<TResult>;

  /**
   * 验证参数
   */
  protected validateParams(): void {
    if (!this.params) {
      throw new Error(`工具 ${this.toolName} 缺少必需参数`);
    }
  }

  /**
   * 创建成功结果
   */
  protected createSuccessResult(
    data: any,
    displayMessage?: string,
    metadata?: Record<string, any>
  ): ToolResult {
    return ResultProcessor.formatSuccess(data, displayMessage, metadata);
  }

  /**
   * 创建错误结果
   */
  protected createErrorResult(
    error: Error | string,
    metadata?: Record<string, any>
  ): ToolResult {
    return ResultProcessor.formatError(error, undefined, metadata);
  }

  /**
   * 检查是否应该中止执行
   */
  protected checkAbortSignal(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new Error('工具执行已被中止');
    }
  }
}

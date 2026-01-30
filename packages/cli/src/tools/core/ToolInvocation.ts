import type { ExecutionContext, ToolInvocation, ToolResult } from '../types/index.js';

/**
 * 统一的工具调用实现
 */
export class UnifiedToolInvocation<TParams = unknown> implements ToolInvocation<TParams> {
  constructor(
    public readonly toolName: string,
    public readonly params: TParams,
    private readonly executeFn: (
      params: TParams,
      context: ExecutionContext
    ) => Promise<ToolResult>,
    private readonly descriptionFn?: (params: TParams) => string,
    private readonly affectedPathsFn?: (params: TParams) => string[]
  ) {}

  /**
   * 获取操作描述
   */
  getDescription(): string {
    if (this.descriptionFn) {
      return this.descriptionFn(this.params);
    }
    return `执行工具: ${this.toolName}`;
  }

  /**
   * 获取受影响的文件路径
   */
  getAffectedPaths(): string[] {
    if (this.affectedPathsFn) {
      return this.affectedPathsFn(this.params);
    }
    return [];
  }

  /**
   * 执行工具
   * @param signal - 中止信号
   * @param updateOutput - 输出更新回调
   * @param context - 额外的执行上下文（包含 confirmationHandler、permissionMode 等）
   */
  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
    context?: Partial<ExecutionContext>
  ): Promise<ToolResult> {
    // 合并基础 context 和额外字段
    const fullContext: ExecutionContext = {
      signal,
      updateOutput,
      ...context, // 包含 confirmationHandler, permissionMode, userId, sessionId 等
    };
    return this.executeFn(this.params, fullContext);
  }
}

import type {
  ConfirmationCallback,
  ConfirmationDetails,
  ExecutionContext,
  ToolInvocation,
  ToolResult,
} from '../types/index.js';

/**
 * 统一的工具调用实现
 */
export class UnifiedToolInvocation<TParams = any> implements ToolInvocation<TParams> {
  constructor(
    public readonly toolName: string,
    public readonly params: TParams,
    private readonly executeFn: (
      params: TParams,
      context: ExecutionContext
    ) => Promise<ToolResult>,
    private readonly confirmationFn?: ConfirmationCallback<TParams>,
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
   * 检查是否需要用户确认
   */
  async shouldConfirm(): Promise<ConfirmationDetails | null> {
    if (this.confirmationFn) {
      return this.confirmationFn(this.params);
    }
    return null;
  }

  /**
   * 执行工具
   */
  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    return this.executeFn(this.params, { signal, updateOutput });
  }
}

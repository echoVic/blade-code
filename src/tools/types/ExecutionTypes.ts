import type { ToolResult } from './ToolTypes.js';
import { ToolErrorType } from './ToolTypes.js';

/**
 * 确认详情
 */
export interface ConfirmationDetails {
  type?: 'permission' | 'exitPlanMode'; // 🆕 确认类型
  title?: string;
  message: string;
  details?: string; // 🆕 Plan 方案内容或其他详细信息
  risks?: string[];
  affectedFiles?: string[];
}

/**
 * 用户确认响应
 */
export type PermissionApprovalScope = 'once' | 'session';

export interface ConfirmationResponse {
  approved: boolean;
  reason?: string;
  scope?: PermissionApprovalScope;
  targetMode?: 'default' | 'auto_edit'; // 🆕 Plan 模式退出后的目标权限模式
  feedback?: string; // 🆕 用户拒绝时的反馈意见（用于 Plan 模式调整）
}

/**
 * 确认处理器接口
 * 由 UI 层实现,用于处理需要用户确认的工具调用
 */
export interface ConfirmationHandler {
  /**
   * 请求用户确认
   * @param details 确认详情
   * @returns Promise<ConfirmationResponse> 用户的确认结果
   */
  requestConfirmation(details: ConfirmationDetails): Promise<ConfirmationResponse>;
}

/**
 * 执行上下文
 */
export interface ExecutionContext {
  userId?: string;
  sessionId?: string;
  messageId?: string; // 对话消息 ID（用于快照管理）
  workspaceRoot?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  updateOutput?: (output: string) => void; // 别名，与 onProgress 功能相同
  confirmationHandler?: ConfirmationHandler; // 用于处理需要用户确认的工具调用

  // 权限模式（用于 Plan 模式判断）
  permissionMode?: string;
}

/**
 * 工具执行内部状态 (由 Pipeline 阶段设置)
 */
export interface ToolExecutionInternalState {
  // DiscoveryStage 设置
  tool?: any;

  // PermissionStage 设置 (含 Zod 验证和默认值处理)
  invocation?: any;
  permissionCheckResult?: any;
  needsConfirmation?: boolean;
  confirmationReason?: string;
  permissionSignature?: string;

  // HookStage 设置
  hookToolUseId?: string; // 用于关联 PreToolUse 和 PostToolUse 事件
}

/**
 * 工具执行状态
 */
export class ToolExecution {
  private aborted = false;
  private result?: ToolResult;

  // 内部状态 (由 Pipeline 阶段设置和访问)
  public _internal: ToolExecutionInternalState = {};

  constructor(
    public readonly toolName: string,
    public readonly params: Record<string, unknown>,
    public readonly context: ExecutionContext
  ) {}

  shouldAbort(): boolean {
    return this.aborted || (this.context.signal?.aborted ?? false);
  }

  abort(reason?: string): void {
    this.aborted = true;
    this.result = {
      success: false,
      llmContent: `Tool execution aborted: ${reason || 'Unknown reason'}`,
      displayContent: `执行已中止: ${reason || '未知原因'}`,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: reason || 'Execution aborted',
      },
    };
  }

  setResult(result: ToolResult): void {
    this.result = result;
  }

  getResult(): ToolResult {
    if (!this.result) {
      throw new Error('Tool execution result not set');
    }
    return this.result;
  }
}

/**
 * 管道阶段接口
 */
export interface PipelineStage {
  readonly name: string;
  process(execution: ToolExecution): Promise<void>;
}

/**
 * 执行历史记录
 */
export interface ExecutionHistoryEntry {
  executionId: string;
  toolName: string;
  params: any;
  result: ToolResult;
  startTime: number;
  endTime: number;
  context: ExecutionContext;
}

/**
 * 并发管理配置
 */
export interface ConcurrencyConfig {
  maxConcurrent: number;
  timeoutMs: number;
  retryAttempts: number;
  retryDelayMs: number;
}

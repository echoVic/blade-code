import { PermissionMode } from '../../config/types.js';
import type { Tool, ToolInvocation, ToolResult } from './ToolTypes.js';
import { ToolErrorType, ToolKind } from './ToolTypes.js';

interface QuestionOption {
  label: string;
  description: string;
}

interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export interface ConfirmationDetails {
  type?:
    | 'permission'
    | 'enterPlanMode'
    | 'exitPlanMode'
    | 'maxTurnsExceeded'
    | 'askUserQuestion'; // 确认类型
  kind?: ToolKind; // 工具类型（readonly, write, execute），用于 ACP 权限模式判断
  toolName?: string;
  args?: Record<string, unknown>;
  title?: string;
  message: string;
  details?: string; // 🆕 Plan 方案内容或其他详细信息
  risks?: string[];
  affectedFiles?: string[];
  planContent?: string; // Plan 模式的完整计划内容（Markdown 格式）
  questions?: Question[]; // 🆕 AskUserQuestion 的问题列表
}

type PermissionApprovalScope = 'once' | 'session';

export interface ConfirmationResponse {
  approved: boolean;
  reason?: string;
  scope?: PermissionApprovalScope;
  targetMode?: PermissionMode; // Plan 模式退出后的目标权限模式
  feedback?: string; // 🆕 用户拒绝时的反馈意见（用于 Plan 模式调整）
  answers?: Record<string, string | string[]>; // 🆕 AskUserQuestion 的用户答案
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
  permissionMode?: PermissionMode;
}

interface ToolExecutionInternalState {
  // DiscoveryStage 设置
  tool?: Tool;

  // PermissionStage 设置 (含 Zod 验证和默认值处理)
  invocation?: ToolInvocation<unknown>;
  permissionCheckResult?: { reason?: string };
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

  abort(reason?: string, options?: { shouldExitLoop?: boolean }): void {
    this.aborted = true;
    this.result = {
      success: false,
      llmContent: `Tool execution aborted: ${reason || 'Unknown reason'}`,
      displayContent: `执行已中止: ${reason || '未知原因'}`,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: reason || 'Execution aborted',
      },
      metadata: options?.shouldExitLoop ? { shouldExitLoop: true } : undefined,
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
  params: Record<string, unknown>;
  result: ToolResult;
  startTime: number;
  endTime: number;
  context: ExecutionContext;
}

import { PermissionMode } from '../../config/types.js';
import type { DeferredToolManager } from '../registry/DeferredToolManager.js';
import type { ToolRegistry } from '../registry/ToolRegistry.js';
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
  details?: string; // NEW: Plan 方案内容或其他详细信息
  risks?: string[];
  affectedFiles?: string[];
  planContent?: string; // Plan 模式的完整计划内容（Markdown 格式）
  questions?: Question[]; // NEW: AskUserQuestion 的问题列表
}

type PermissionApprovalScope = 'once' | 'session';

export interface ConfirmationResponse {
  approved: boolean;
  reason?: string;
  scope?: PermissionApprovalScope;
  targetMode?: PermissionMode; // Plan 模式退出后的目标权限模式
  feedback?: string; // NEW: 用户拒绝时的反馈意见（用于 Plan 模式调整）
  answers?: Record<string, string | string[]>; // NEW: AskUserQuestion 的用户答案
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
  taskListId?: string; // Optional shared task-list scope (used by agent teams)
  messageId?: string; // 对话消息 ID（用于快照管理）
  workspaceRoot?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  updateOutput?: (output: string) => void; // 别名，与 onProgress 功能相同
  confirmationHandler?: ConfirmationHandler; // 用于处理需要用户确认的工具调用

  // 权限模式（用于 Plan 模式判断）
  permissionMode?: PermissionMode;

  // 工具注册表（用于 ToolSearch 等需要访问注册表的工具）
  toolRegistry?: ToolRegistry;

  // 延迟加载管理器（用于 ToolSearch 标记工具为已加载）
  deferredToolManager?: DeferredToolManager;
}

/**
 * 权限行为
 */
export type PermissionBehavior = 'allow' | 'ask' | 'deny';

/**
 * 决策来源
 * - rule: 来自 PermissionChecker 规则库 / 权限模式 / 会话批准 / 敏感文件调整
 * - hook: 来自用户 PreToolUse Hook
 * - default: 兜底(无规则匹配 & 无 Hook 决策)
 */
export type PermissionDecisionSource = 'rule' | 'hook' | 'default';

/**
 * 权限决策
 *
 * 不变量:
 *   Rule \ Hook   | deny | ask  | allow | (none)
 *   --------------|------|------|-------|--------
 *   deny          | deny | deny | deny  | deny
 *   ask           | ask  | ask  | ask   | ask
 *   allow         | deny | ask  | allow | allow
 *   (none=ask)    | deny | ask  | allow | ask
 *
 * Hook 只能收紧规则库,不能放宽。
 */
export interface PermissionDecision {
  behavior: PermissionBehavior;
  source: PermissionDecisionSource;
  reason?: string;
  matchedRule?: string;
}

interface ToolExecutionInternalState {
  // DiscoveryStage / ValidationStage 设置
  tool?: Tool;

  // ValidationStage 设置 (Zod 验证和默认值处理完成后的调用实例)
  invocation?: ToolInvocation<unknown>;

  // RuleBasedPermissionStage 设置
  permissionSignature?: string; // 供会话级批准持久化使用
  ruleDecision?: PermissionDecision; // 规则库 + 模式 + 敏感文件调整后的决策

  // PreToolUseHookStage 设置
  hookDecision?: PermissionDecision; // Hook 返回的决策 (若 Hook 未表态则缺席)
  hookToolUseId?: string; // 用于关联 PreToolUse 和 PostToolUse 事件

  // ResolveDecisionStage 设置
  effectiveDecision?: PermissionDecision; // 仲裁后的最终决策;下游 Stage 只读此字段
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

  abort(
    reason?: string,
    options?: {
      shouldExitLoop?: boolean;
      llmContent?: string;
      summary?: string;
      errorType?: ToolErrorType;
      abortedBeforeLaunch?: boolean;
    }
  ): void {
    this.aborted = true;
    this.result = {
      success: false,
      llmContent:
        options?.llmContent || `Tool execution aborted: ${reason || 'Unknown reason'}`,
      error: {
        type: options?.errorType || ToolErrorType.EXECUTION_ERROR,
        message: reason || 'Execution aborted',
      },
      metadata: {
        summary: options?.summary || `执行已中止: ${reason || '未知原因'}`,
        ...(options?.shouldExitLoop ? { shouldExitLoop: true } : {}),
        ...(options?.abortedBeforeLaunch ? { abortedBeforeLaunch: true } : {}),
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
  params: Record<string, unknown>;
  result: ToolResult;
  startTime: number;
  endTime: number;
  context: ExecutionContext;
}

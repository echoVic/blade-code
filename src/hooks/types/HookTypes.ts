/**
 * Hook System Types
 *
 * 定义 Blade Hooks System 的核心类型
 */

import type { PermissionMode } from '../../config/types.js';

// ============================================================================
// Hook Events
// ============================================================================

/**
 * Hook 事件类型
 */
export enum HookEvent {
  /** 工具执行前 (可阻止或修改输入) */
  PreToolUse = 'PreToolUse',

  /** 工具执行后 (可添加上下文或修改输出) */
  PostToolUse = 'PostToolUse',

  /** Claude 停止响应时 */
  Stop = 'Stop',
}

// ============================================================================
// Hook Input
// ============================================================================

/**
 * Hook 输入基础字段
 */
export interface HookInputBase {
  /** Hook 事件名称 */
  hook_event_name: HookEvent;

  /** Hook 执行唯一 ID */
  hook_execution_id: string;

  /** 时间戳 (ISO 8601) */
  timestamp: string;

  /** 项目目录 */
  project_dir: string;

  /** 会话 ID */
  session_id: string;

  /** 当前权限模式 */
  permission_mode: PermissionMode;

  /** 元数据 */
  _metadata?: {
    blade_version: string;
    hook_timeout_ms: number;
  };
}

/**
 * PreToolUse 输入
 */
export interface PreToolUseInput extends HookInputBase {
  hook_event_name: HookEvent.PreToolUse;

  /** 工具名称 */
  tool_name: string;

  /** 工具使用 ID */
  tool_use_id: string;

  /** 工具输入参数 */
  tool_input: Record<string, unknown>;
}

/**
 * PostToolUse 输入
 */
export interface PostToolUseInput extends HookInputBase {
  hook_event_name: HookEvent.PostToolUse;

  /** 工具名称 */
  tool_name: string;

  /** 工具使用 ID */
  tool_use_id: string;

  /** 工具输入参数 */
  tool_input: Record<string, unknown>;

  /** 工具响应 */
  tool_response: unknown;
}

/**
 * Stop 输入
 */
export interface StopInput extends HookInputBase {
  hook_event_name: HookEvent.Stop;

  /** 停止原因 */
  reason?: string;
}

/**
 * Hook 输入联合类型
 */
export type HookInput = PreToolUseInput | PostToolUseInput | StopInput;

// ============================================================================
// Hook Output
// ============================================================================

/**
 * 决策行为
 */
export enum DecisionBehavior {
  /** 批准,继续执行 */
  Approve = 'approve',

  /** 阻止,停止执行 */
  Block = 'block',

  /** 异步执行,不等待结果 */
  Async = 'async',
}

/**
 * 权限决策 (与 Blade 权限体系对齐)
 */
export enum PermissionDecision {
  Allow = 'allow',
  Deny = 'deny',
  Ask = 'ask',
}

/**
 * PreToolUse 特定输出
 */
export interface PreToolUseOutput {
  hookEventName?: 'PreToolUse';

  /** 权限决策 */
  permissionDecision?: PermissionDecision;

  /** 权限决策原因 */
  permissionDecisionReason?: string;

  /** 修改后的工具输入 */
  updatedInput?: Record<string, unknown>;
}

/**
 * PostToolUse 特定输出
 */
export interface PostToolUseOutput {
  hookEventName?: 'PostToolUse';

  /** 添加给 LLM 的额外上下文 */
  additionalContext?: string;

  /** 修改后的工具输出 */
  updatedOutput?: unknown;
}

/**
 * Hook 输出结构
 */
export interface HookOutput {
  /** 通用决策 */
  decision?: {
    behavior?: DecisionBehavior;
  };

  /** 系统消息 (显示给用户,不发送给 LLM) */
  systemMessage?: string;

  /** 事件特定输出 */
  hookSpecificOutput?: PreToolUseOutput | PostToolUseOutput;

  /** 抑制输出 (不显示成功消息) */
  suppressOutput?: boolean;
}

// ============================================================================
// Hook Configuration
// ============================================================================

/**
 * Hook 类型
 */
export enum HookType {
  Command = 'command',
  Prompt = 'prompt',
}

/**
 * 命令 Hook
 */
export interface CommandHook {
  type: HookType.Command;

  /** Shell 命令 */
  command: string;

  /** 超时时间 (秒) */
  timeout?: number;

  /** 状态消息 (显示在 UI) */
  statusMessage?: string;
}

/**
 * 提示词 Hook (未来实现)
 */
export interface PromptHook {
  type: HookType.Prompt;

  /** 提示词内容 */
  prompt: string;

  /** 超时时间 (秒) */
  timeout?: number;
}

/**
 * Hook 联合类型
 */
export type Hook = CommandHook | PromptHook;

/**
 * Matcher 配置
 */
export interface MatcherConfig {
  /** 工具名匹配 (支持精确、管道分隔、正则) */
  tools?: string;

  /** 文件路径匹配 (glob 模式) */
  paths?: string;

  /** 命令匹配 (正则) */
  commands?: string;
}

/**
 * Hook Matcher
 */
export interface HookMatcher {
  /** 可选的名称 (用于日志和 UI) */
  name?: string;

  /** 匹配器配置 */
  matcher?: MatcherConfig;

  /** Hook 列表 */
  hooks: Hook[];
}

/**
 * Hook 配置
 */
export interface HookConfig {
  /** 是否启用 hooks */
  enabled?: boolean;

  /** 默认超时 (秒) */
  defaultTimeout?: number;

  /** 超时行为 */
  timeoutBehavior?: 'ignore' | 'deny' | 'ask';

  /** 失败行为 */
  failureBehavior?: 'ignore' | 'deny' | 'ask';

  /** 最大并发 Hook 数 */
  maxConcurrentHooks?: number;

  /** PreToolUse Hooks */
  PreToolUse?: HookMatcher[];

  /** PostToolUse Hooks */
  PostToolUse?: HookMatcher[];

  /** Stop Hooks */
  Stop?: HookMatcher[];
}

// ============================================================================
// Hook Execution Results
// ============================================================================

/**
 * Hook 退出码
 */
export enum HookExitCode {
  /** 成功,继续 */
  SUCCESS = 0,

  /** 非阻塞错误,记录但继续 */
  NON_BLOCKING_ERROR = 1,

  /** 阻塞错误,停止执行 */
  BLOCKING_ERROR = 2,

  /** 超时 */
  TIMEOUT = 124,
}

/**
 * 进程执行结果
 */
export interface ProcessResult {
  /** 标准输出 */
  stdout: string;

  /** 标准错误 */
  stderr: string;

  /** 退出码 */
  exitCode: number;

  /** 是否超时 */
  timedOut: boolean;
}

/**
 * Hook 执行结果
 */
export interface HookExecutionResult {
  /** 是否成功 */
  success: boolean;

  /** 是否阻塞 */
  blocking?: boolean;

  /** 是否需要用户确认 (ask 行为) */
  needsConfirmation?: boolean;

  /** 错误信息 */
  error?: string;

  /** 警告信息 */
  warning?: string;

  /** 解析后的输出 */
  output?: HookOutput;

  /** 原始标准输出 */
  stdout?: string;

  /** 原始标准错误 */
  stderr?: string;

  /** 退出码 */
  exitCode?: number;

  /** Hook 配置 */
  hook?: Hook;
}

/**
 * PreToolUse Hook 执行结果
 */
export interface PreToolHookResult {
  /** 决策 */
  decision: 'allow' | 'deny' | 'ask';

  /** 原因 */
  reason?: string;

  /** 修改后的输入 */
  modifiedInput?: Record<string, unknown>;

  /** 警告信息 */
  warning?: string;
}

/**
 * PostToolUse Hook 执行结果
 */
export interface PostToolHookResult {
  /** 额外上下文 */
  additionalContext?: string;

  /** 修改后的输出 */
  modifiedOutput?: unknown;

  /** 警告信息 */
  warning?: string;
}

// ============================================================================
// Hook Execution Context
// ============================================================================

/**
 * Hook 执行上下文
 */
export interface HookExecutionContext {
  /** 项目目录 */
  projectDir: string;

  /** 会话 ID */
  sessionId: string;

  /** 权限模式 */
  permissionMode: PermissionMode;

  /** Hook 配置 */
  config: HookConfig;

  /** 中止信号 */
  abortSignal?: AbortSignal;
}

/**
 * Matcher 匹配上下文
 */
export interface MatchContext {
  /** 工具名称 */
  toolName?: string;

  /** 文件路径 */
  filePath?: string;

  /** 命令 */
  command?: string;
}

// ============================================================================
// Hook Metrics
// ============================================================================

/**
 * Hook 统计
 */
export interface HookStats {
  /** 执行次数 */
  executions: number;

  /** 总耗时 (ms) */
  totalDuration: number;

  /** 失败次数 */
  failures: number;
}

/**
 * Hook 性能报告
 */
export interface HookPerformanceReport {
  /** Hook 名称 */
  hookName: string;

  /** 平均耗时 (ms) */
  avgDuration: number;

  /** 执行次数 */
  executions: number;

  /** 失败率 */
  failureRate: number;
}

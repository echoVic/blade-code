import type { PermissionMode } from '../../config/types.js';
import type {
  McpElicitationAction,
  McpElicitationContent,
} from '../../mcp/McpElicitation.js';

export enum HookEvent {
  PreToolUse = 'PreToolUse',
  PostToolUse = 'PostToolUse',
  PostToolUseFailure = 'PostToolUseFailure',
  PermissionRequest = 'PermissionRequest',
  Elicitation = 'Elicitation',
  ElicitationResult = 'ElicitationResult',
  UserPromptSubmit = 'UserPromptSubmit',
  SessionStart = 'SessionStart',
  SessionEnd = 'SessionEnd',
  Stop = 'Stop',
  SubagentStop = 'SubagentStop',
  Notification = 'Notification',
  Compaction = 'Compaction',
}

interface HookInputBase {
  hook_event_name: HookEvent;
  hook_execution_id: string;
  timestamp: string;
  project_dir: string;
  session_id: string;
  permission_mode: PermissionMode;
  _metadata?: {
    blade_version: string;
    hook_timeout_ms: number;
  };
}

export interface PreToolUseInput extends HookInputBase {
  hook_event_name: HookEvent.PreToolUse;
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}

export interface PostToolUseInput extends HookInputBase {
  hook_event_name: HookEvent.PostToolUse;
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
}

export interface StopInput extends HookInputBase {
  hook_event_name: HookEvent.Stop;
  reason?: string;
}

export interface PostToolUseFailureInput extends HookInputBase {
  hook_event_name: HookEvent.PostToolUseFailure;
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
  error: string;
  error_type?: string;
  is_interrupt: boolean;
  is_timeout: boolean;
}

export interface PermissionRequestInput extends HookInputBase {
  hook_event_name: HookEvent.PermissionRequest;
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}

export interface ElicitationInput extends HookInputBase {
  hook_event_name: HookEvent.Elicitation;
  server_name: string;
  mode: 'form' | 'url';
  message: string;
  requested_schema?: Record<string, unknown>;
  url?: string;
  elicitation_id?: string;
}

export interface ElicitationResultInput extends HookInputBase {
  hook_event_name: HookEvent.ElicitationResult;
  server_name: string;
  mode: 'form' | 'url';
  elicitation_id?: string;
  action: McpElicitationAction;
  content?: McpElicitationContent;
}

export interface UserPromptSubmitInput extends HookInputBase {
  hook_event_name: HookEvent.UserPromptSubmit;
  user_prompt: string;
  has_images: boolean;
  image_count: number;
}

export interface SessionStartInput extends HookInputBase {
  hook_event_name: HookEvent.SessionStart;
  is_resume: boolean;
  resume_session_id?: string;
}

export interface SessionEndInput extends HookInputBase {
  hook_event_name: HookEvent.SessionEnd;
  reason:
    | 'user_exit'
    | 'error'
    | 'max_turns'
    | 'idle_timeout'
    | 'ctrl_c'
    | 'esc'
    | 'clear'
    | 'logout'
    | 'other';
}

export interface SubagentStopInput extends HookInputBase {
  hook_event_name: HookEvent.SubagentStop;
  agent_type: string;
  task_description?: string;
  success: boolean;
  result_summary?: string;
  error?: string;
}

export interface NotificationInput extends HookInputBase {
  hook_event_name: HookEvent.Notification;
  notification_type:
    | 'permission_prompt'
    | 'idle_prompt'
    | 'auth_success'
    | 'elicitation_dialog'
    | 'info'
    | 'warning'
    | 'error';
  title?: string;
  message: string;
}

export interface CompactionInput extends HookInputBase {
  hook_event_name: HookEvent.Compaction;
  trigger: 'manual' | 'auto';
  messages_before: number;
  tokens_before: number;
}

export type HookInput =
  | PreToolUseInput
  | PostToolUseInput
  | PostToolUseFailureInput
  | PermissionRequestInput
  | ElicitationInput
  | ElicitationResultInput
  | UserPromptSubmitInput
  | SessionStartInput
  | SessionEndInput
  | StopInput
  | SubagentStopInput
  | NotificationInput
  | CompactionInput;

export enum DecisionBehavior {
  Approve = 'approve',
  Block = 'block',
  Async = 'async',
}

export enum PermissionDecision {
  Allow = 'allow',
  Deny = 'deny',
  Ask = 'ask',
}

interface PreToolUseOutput {
  hookEventName?: 'PreToolUse';
  permissionDecision?: PermissionDecision;
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
}

interface PostToolUseOutput {
  hookEventName?: 'PostToolUse';
  additionalContext?: string;
  updatedOutput?: unknown;
}

interface StopOutput {
  hookEventName?: 'Stop';
  continue?: boolean;
  continueReason?: string;
}

interface SubagentStopOutput {
  hookEventName?: 'SubagentStop';
  continue?: boolean;
  continueReason?: string;
  additionalContext?: string;
}

interface PermissionRequestOutput {
  hookEventName?: 'PermissionRequest';
  permissionDecision?: 'approve' | 'deny' | 'ask';
  permissionDecisionReason?: string;
}

interface ElicitationOutput {
  hookEventName?: 'Elicitation';
  action?: McpElicitationAction;
  content?: McpElicitationContent;
}

interface ElicitationResultOutput {
  hookEventName?: 'ElicitationResult';
  action?: McpElicitationAction;
  content?: McpElicitationContent;
}

interface UserPromptSubmitOutput {
  hookEventName?: 'UserPromptSubmit';
  updatedPrompt?: string;
  contextInjection?: string;
}

interface SessionStartOutput {
  hookEventName?: 'SessionStart';
  env?: Record<string, string>;
}

interface CompactionOutput {
  hookEventName?: 'Compaction';
  blockCompaction?: boolean;
  blockReason?: string;
}

export type HookSpecificOutput =
  | PreToolUseOutput
  | PostToolUseOutput
  | StopOutput
  | SubagentStopOutput
  | PermissionRequestOutput
  | ElicitationOutput
  | ElicitationResultOutput
  | UserPromptSubmitOutput
  | SessionStartOutput
  | CompactionOutput;
export interface HookOutput {
  decision?: {
    behavior?: DecisionBehavior;
  };
  systemMessage?: string;
  hookSpecificOutput?: HookSpecificOutput;
  suppressOutput?: boolean;
}

export enum HookType {
  Command = 'command',
  Prompt = 'prompt',
  Function = 'function',
  Http = 'http',
}

export interface CommandHook {
  type: HookType.Command;
  command: string;
  timeout?: number;
  statusMessage?: string;
}

export interface PromptHook {
  type: HookType.Prompt;
  prompt: string;
  model?: string;
  timeout?: number;
}

/**
 * Function Hook — 进程内函数 Hook (SDK / 插件扩展用)
 *
 * 通过 JS/TS 函数直接介入 Hook 链,无需 shell IPC,适合:
 * - SDK 使用者把自定义逻辑注入到 Hook 事件
 * - 插件/扩展注册即时决策回调
 * - 单元测试场景
 *
 * 注意: handler 必须是可调用引用,因此不能通过配置文件序列化注册。
 *   通过 `HookManager.registerFunction(...)` 在代码里注册。
 */
export interface FunctionHook {
  type: HookType.Function;

  /**
   * Hook 处理函数。
   * - 接收 HookInput (与 shell hook stdin 相同的数据结构)
   * - 接收 HookExecutionContext (projectDir/sessionId/permissionMode/abortSignal)
   * - 返回 HookOutput 或 undefined (视作无决策,等价于 allow/pass-through)
   * - 抛异常视作 non-blocking error,记录日志但继续流程
   */
  handler: (
    input: HookInput,
    ctx: HookExecutionContext
  ) => Promise<HookOutput | undefined> | HookOutput | undefined;
  timeout?: number;
}

export interface PluginHookSource {
  kind: 'plugin';
  pluginName: string;
  pluginSource: 'cli' | 'project' | 'user';
  pluginRoot: string;
}

export type Hook = (CommandHook | PromptHook | FunctionHook | HttpHook) & {
  source?: PluginHookSource;
};

/** POSTs HookInput and accepts HookOutput JSON. Redirects, HTTP, loopback, and
 * private networks are denied unless HttpHookPolicy explicitly allows them. */
export interface HttpHook {
  type: HookType.Http;
  url: string;

  /**
   * 自定义请求头; value 支持 ${ENV_VAR} 替换。
   * 例: { Authorization: 'Bearer ${SECURITY_HOOK_TOKEN}' }
   */
  headers?: Record<string, string>;
  timeout?: number;
  retries?: number;
  allowInsecureTLS?: boolean;
  maxResponseBytes?: number;
}

/** HTTP Hook 全局安全策略 (进程级) */
export interface HttpHookPolicy {
  allowedHosts?: string[];
  allowLoopback?: boolean;
  allowPrivateRanges?: boolean;
  allowHttp?: boolean;
}

export interface MatcherConfig {
  tools?: string | string[];
  paths?: string | string[];
  commands?: string | string[];
}

export interface HookMatcher {
  name?: string;
  matcher?: MatcherConfig;
  hooks: Hook[];
}

export interface HookConfig {
  enabled?: boolean;
  defaultTimeout?: number;
  timeoutBehavior?: 'ignore' | 'deny' | 'ask';
  failureBehavior?: 'ignore' | 'deny' | 'ask';
  maxConcurrentHooks?: number;

  /** HTTP Hook 全局安全策略 */
  httpPolicy?: HttpHookPolicy;
  PreToolUse?: HookMatcher[];
  PostToolUse?: HookMatcher[];
  PostToolUseFailure?: HookMatcher[];
  PermissionRequest?: HookMatcher[];
  Elicitation?: HookMatcher[];
  ElicitationResult?: HookMatcher[];
  UserPromptSubmit?: HookMatcher[];
  SessionStart?: HookMatcher[];
  SessionEnd?: HookMatcher[];
  Stop?: HookMatcher[];
  SubagentStop?: HookMatcher[];
  Notification?: HookMatcher[];
  Compaction?: HookMatcher[];
}

export enum HookExitCode {
  SUCCESS = 0,
  NON_BLOCKING_ERROR = 1,
  BLOCKING_ERROR = 2,
  TIMEOUT = 124,
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface HookExecutionResult {
  success: boolean;
  blocking?: boolean;
  needsConfirmation?: boolean;
  error?: string;
  warning?: string;
  output?: HookOutput;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  hook?: Hook;
}

export interface PreToolHookResult {
  decision: 'allow' | 'deny' | 'ask';
  reason?: string;
  modifiedInput?: Record<string, unknown>;
  warning?: string;
}

export interface PostToolHookResult {
  additionalContext?: string;
  modifiedOutput?: unknown;
  warning?: string;
}

export interface StopHookResult {
  shouldStop: boolean;
  continueReason?: string;
  warning?: string;
}

export interface SubagentStopHookResult {
  shouldStop: boolean;
  continueReason?: string;
  additionalContext?: string;
  warning?: string;
}

export interface PermissionRequestHookResult {
  decision: 'approve' | 'deny' | 'ask';
  reason?: string;
  warning?: string;
}

export interface ElicitationHookResult {
  response?: {
    action: McpElicitationAction;
    content?: McpElicitationContent;
  };
  blockedReason?: string;
  warning?: string;
}

export interface UserPromptSubmitHookResult {
  proceed: boolean;
  updatedPrompt?: string;
  contextInjection?: string;
  warning?: string;
}

export interface SessionStartHookResult {
  proceed: boolean;
  env?: Record<string, string>;
  warning?: string;
}

export interface SessionEndHookResult {
  warning?: string;
}

export interface PostToolUseFailureHookResult {
  additionalContext?: string;
  warning?: string;
}

export interface CompactionHookResult {
  blockCompaction: boolean;
  blockReason?: string;
  warning?: string;
}

export interface HookExecutionContext {
  projectDir: string;
  sessionId: string;
  permissionMode: PermissionMode;
  config: HookConfig;

  /** Session-scoped explicit environment; never the mutable process environment. */
  environment?: Readonly<Record<string, string>>;
  abortSignal?: AbortSignal;
}

export interface MatchContext {
  toolName?: string;
  filePath?: string;
  filePaths?: string[];
  command?: string;
}

/**
 * ACP 会话管理
 *
 * 封装 Blade Agent，处理 ACP 协议的 prompt 请求，
 * 将 Agent 的流式输出转发给 IDE。
 */

import {
  type AgentSideConnection,
  type AvailableCommand,
  type ClientCapabilities,
  type ContentBlock,
  type McpServer,
  type PlanEntry,
  type PlanEntryPriority,
  type PromptRequest,
  type PromptResponse,
  RequestError,
  type RequestPermissionRequest,
  type SessionNotification,
  type ToolCallContent,
  type ToolCallStatus,
  type ToolKind,
} from '@agentclientprotocol/sdk';
import { nanoid } from 'nanoid';
import { Agent } from '../agent/Agent.js';
import { drainLoop } from '../agent/loop/index.js';
import type { LoopEvent } from '../agent/loop/types.js';
import { SessionRuntime } from '../agent/runtime/SessionRuntime.js';
import type { ChatContext, UserMessageContent } from '../agent/types.js';
import {
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_INLINE_ATTACHMENT_COUNT,
  MAX_USER_MESSAGE_TEXT_CHARS,
} from '../api/attachmentLimits.js';
import {
  type BladeConfig,
  type CommunicationStyleSelection,
  type McpServerConfig,
  PermissionMode,
  type ReasoningEffortSelection,
  type ResponseVerbositySelection,
  type ServiceTierSelection,
} from '../config/types.js';
import type { SessionTaskIsolation, SessionTaskWorktree } from '../context/types.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type {
  McpElicitationContent,
  McpElicitationField,
} from '../mcp/McpElicitation.js';
import { Bus } from '../server/bus.js';
import type { ContentPart, Message } from '../services/ChatServiceInterface.js';
import { CodeReviewService, renderCodeReview } from '../services/CodeReviewService.js';
import { SessionInteractionService } from '../services/SessionInteractionService.js';
import {
  SessionMissingCreationError,
  SessionService,
} from '../services/SessionService.js';
import {
  createStructuredOutputContract,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from '../services/StructuredOutputService.js';
import {
  renderUserShellCommandForDisplay,
  type UserShellCommandRecord,
  userShellCommandRecordFromMetadata,
} from '../services/UserShellCommandService.js';
import {
  executeSlashCommand,
  getRegisteredCommands,
  initializeCustomCommands,
  isSlashCommand,
  type SlashCommandContext,
} from '../slash-commands/index.js';
import type { JsonValue } from '../store/types.js';
import type { TaskListItem } from '../tools/builtin/task/taskListTypes.js';
import {
  CONFIRMATION_ABORTED_REASON,
  type ConfirmationDetails,
  type ConfirmationResponse,
} from '../tools/types/ExecutionTypes.js';
import {
  formatToolDisplay,
  renderToolDisplayToString,
} from '../ui/utils/toolFormatters.js';
import { AcpServiceContext } from './AcpServiceContext.js';

const logger = createLogger(LogCategory.AGENT);

/**
 * ACP 会话类
 *
 * 每个会话对应一个 Blade Agent 实例，
 * 处理来自 IDE 的 prompt 请求并返回流式响应。
 */
/**
 * ACP 模式 ID（与 BladeAgent 返回的 availableModes 对应）
 */
export type AcpModeId = 'default' | 'auto-edit' | 'yolo' | 'plan';

interface ResolvedAcpPrompt {
  content: UserMessageContent;
  displayText: string;
}

export interface AcpSessionOptions {
  initialMessages?: Message[];
  permissionMode?: PermissionMode;
  mcpServers?: McpServer[];
  taskWorktree?: SessionTaskWorktree;
  taskIsolation?: SessionTaskIsolation;
}

function entriesToRecord(
  entries: Array<{ name: string; value: string }> | undefined
): Record<string, string> {
  if (!entries) return {};
  return Object.fromEntries(entries.map((entry) => [entry.name, entry.value]));
}

function toMcpServerConfig(server: McpServer): McpServerConfig | null {
  if ('command' in server) {
    return {
      type: 'stdio',
      command: server.command,
      args: server.args,
      env: entriesToRecord(server.env),
    };
  }

  if ('url' in server) {
    return {
      type: server.type as 'http' | 'sse',
      url: server.url,
      headers: entriesToRecord(
        'headers' in server
          ? (server.headers as Array<{ name: string; value: string }>)
          : undefined
      ),
    };
  }

  return null;
}

function toMcpServers(servers: McpServer[]): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  for (const server of servers) {
    const config = toMcpServerConfig(server);
    if (config) result[server.name] = config;
  }
  return result;
}

function historyContentBlocks(content: Message['content']): ContentBlock[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }

  return content.flatMap((part): ContentBlock[] => {
    if (part.type === 'text') {
      return part.text ? [{ type: 'text', text: part.text }] : [];
    }

    const dataUrl = part.image_url.url;
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
    if (!match) {
      return [{ type: 'text', text: '[Image]' }];
    }
    return [
      {
        type: 'image',
        mimeType: match[1] ?? 'image/png',
        data: match[2] ?? '',
      },
    ];
  });
}

function acpHistoryContentBlocks(message: Message): ContentBlock[] {
  const record = userShellCommandRecordFromMetadata(message.metadata);
  return record
    ? [{ type: 'text', text: renderUserShellCommandForDisplay(record) }]
    : historyContentBlocks(message.content);
}

function shellCompletionSummary(record: UserShellCommandRecord): string {
  return [
    `Status: ${record.status}`,
    `Exit code: ${record.exitCode ?? 'null'}`,
    `Duration: ${(record.durationMs / 1000).toFixed(3)} seconds`,
  ].join('\n');
}

export class AcpSession {
  private agent: Agent | null = null;
  private runtime: SessionRuntime | null = null;
  private pendingPrompt: AbortController | null = null;
  private pendingUserShell: AbortController | null = null;
  private pendingResumeRequested = false;
  private availableCommandsTimer: ReturnType<typeof setTimeout> | null = null;
  private taskStatusUnsubscribe?: () => void;
  private destroyed = false;
  private messages: Message[];
  private mode: AcpModeId;

  constructor(
    private readonly id: string,
    private readonly cwd: string,
    private readonly connection: AgentSideConnection,
    private readonly clientCapabilities: ClientCapabilities | undefined,
    private readonly options: AcpSessionOptions = {}
  ) {
    this.messages = [...(options.initialMessages ?? [])];
    this.mode = this.mapPermissionModeToMode(options.permissionMode);
  }

  private mapPermissionModeToMode(
    permissionMode: PermissionMode | undefined
  ): AcpModeId {
    switch (permissionMode) {
      case PermissionMode.YOLO:
        return 'yolo';
      case PermissionMode.AUTO_EDIT:
        return 'auto-edit';
      case PermissionMode.PLAN:
        return 'plan';
      case PermissionMode.DEFAULT:
      default:
        return 'default';
    }
  }

  private createAgent(): Promise<Agent> {
    if (!this.runtime) {
      throw new Error('Session runtime is unavailable');
    }
    return Agent.createWithRuntime(this.runtime, {
      sessionId: this.id,
      ...(this.options.taskWorktree
        ? { toolBlacklist: ['EnterWorktree', 'ExitWorktree'] }
        : {}),
    });
  }

  /**
   * 初始化会话
   * 创建 Blade Agent 实例并初始化 ACP 服务
   */
  async initialize(): Promise<void> {
    logger.debug(`[AcpSession ${this.id}] Initializing...`);
    await SessionService.setSessionPermissionMode(
      this.id,
      this.cwd,
      this.mapModeToPermissionMode() ?? PermissionMode.DEFAULT
    );

    // 初始化 ACP 服务上下文（按会话隔离，不使用 process.chdir）
    AcpServiceContext.initializeSession(
      this.connection,
      this.id,
      this.clientCapabilities,
      this.cwd
    );
    logger.debug(`[AcpSession ${this.id}] ACP service context initialized`);
    const recoveredInteraction =
      await SessionInteractionService.resolvePendingWithHandler(this.cwd, this.id, {
        requestConfirmation: (details) => this.requestPermission(details),
      });
    if (recoveredInteraction) {
      this.messages = await SessionService.loadSession(this.id, this.cwd);
    }

    const mcpServers = this.options.mcpServers
      ? toMcpServers(this.options.mcpServers)
      : undefined;
    const terminalService = AcpServiceContext.getInstance().getTerminalService(this.id);
    this.runtime = await SessionRuntime.create({
      sessionId: this.id,
      workspaceRoot: this.cwd,
      permissionMode: this.mapModeToPermissionMode(),
      ...(mcpServers ? { mcpServers } : {}),
      ...(this.options.taskWorktree ? { taskWorktree: this.options.taskWorktree } : {}),
      ...(this.options.taskIsolation
        ? { taskIsolation: this.options.taskIsolation }
        : {}),
      userShellExecutor: {
        execute: async (command, options) => {
          const result = await terminalService.execute(command, {
            cwd: options.cwd,
            env: options.env,
            timeout: options.timeoutMs,
            signal: options.signal,
            allowLocalFallback: false,
            onOutput: (chunk) => options.onOutput?.('stdout', chunk),
          });
          return {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            ...(result.error ? { error: result.error } : {}),
            timedOut: result.error === 'Command timed out',
            aborted: result.error === 'Command was aborted',
          };
        },
      },
      ...((this.options.initialMessages?.length ?? 0) > 0
        ? {
            sessionStart: {
              isResume: true,
              resumeSessionId: this.id,
            },
          }
        : {}),
    });
    const recoveredReview = await CodeReviewService.recoverInterrupted(
      this.cwd,
      this.id,
      this.runtime
    );
    if (recoveredReview) {
      this.messages = await SessionService.loadSession(this.id, this.cwd);
    }
    this.agent = await this.createAgent();
    await initializeCustomCommands(this.cwd);

    logger.debug(`[AcpSession ${this.id}] Agent created successfully`);
    this.taskStatusUnsubscribe?.();
    this.taskStatusUnsubscribe = Bus.subscribe((event) => {
      if (event.sessionId !== this.id || event.projectPath !== this.cwd) {
        return;
      }
      if (event.type === 'task.delivery') {
        if (
          !event.properties.taskDelivery ||
          typeof event.properties.taskDelivery !== 'object'
        ) {
          return;
        }
        this.sendUpdate({
          sessionUpdate: 'session_info_update',
          updatedAt:
            typeof event.properties.updatedAt === 'string'
              ? event.properties.updatedAt
              : new Date().toISOString(),
          _meta: {
            'blade/taskDelivery': event.properties.taskDelivery,
            ...(event.properties.taskWorktreeRemoved === true
              ? { 'blade/taskWorktreeRemoved': true }
              : {}),
          },
        });
        return;
      }
      if (event.type !== 'task.status') return;
      this.sendUpdate({
        sessionUpdate: 'session_info_update',
        updatedAt:
          typeof event.properties.updatedAt === 'string'
            ? event.properties.updatedAt
            : new Date().toISOString(),
        _meta: {
          'blade/taskStatus': event.properties.taskStatus,
          ...(typeof event.properties.taskStatusReason === 'string'
            ? {
                'blade/taskStatusReason': event.properties.taskStatusReason,
              }
            : {}),
          ...(event.properties.taskFailure &&
          typeof event.properties.taskFailure === 'object'
            ? { 'blade/taskFailure': event.properties.taskFailure }
            : {}),
          ...(typeof event.properties.taskStartedAt === 'string'
            ? { 'blade/taskStartedAt': event.properties.taskStartedAt }
            : {}),
          ...(typeof event.properties.taskCompletedAt === 'string'
            ? {
                'blade/taskCompletedAt': event.properties.taskCompletedAt,
              }
            : {}),
          ...(event.properties.taskDiffStat &&
          typeof event.properties.taskDiffStat === 'object'
            ? { 'blade/taskDiffStat': event.properties.taskDiffStat }
            : {}),
          ...(typeof event.properties.taskQueuePosition === 'number'
            ? {
                'blade/taskQueuePosition': event.properties.taskQueuePosition,
              }
            : {}),
          ...(typeof event.properties.taskQueueDepth === 'number'
            ? { 'blade/taskQueueDepth': event.properties.taskQueueDepth }
            : {}),
          ...(typeof event.properties.taskConcurrencyLimit === 'number'
            ? {
                'blade/taskConcurrencyLimit': event.properties.taskConcurrencyLimit,
              }
            : {}),
          ...(typeof event.properties.taskInFlight === 'number'
            ? { 'blade/taskInFlight': event.properties.taskInFlight }
            : {}),
        },
      });
    });
    const activeGoal = await this.runtime.getGoal();
    if (this.runtime.getPendingSteeringCount() > 0 || activeGoal?.status === 'active') {
      if (this.options.initialMessages === undefined) {
        this.schedulePendingResume();
      } else {
        this.pendingResumeRequested = true;
      }
    }
    // 注意：available_commands_update 在 BladeAgent.newSession 响应后延迟发送
  }

  /**
   * ACP session/load requires history to be replayed before the load response.
   * Internal system/tool messages remain in model context but are not exposed.
   */
  async replayHistory(): Promise<void> {
    for (const message of this.messages) {
      if (!this.canSendUpdates()) return;
      const sessionUpdate =
        message.role === 'user'
          ? 'user_message_chunk'
          : message.role === 'assistant'
            ? 'agent_message_chunk'
            : undefined;
      if (!sessionUpdate) continue;

      for (const content of acpHistoryContentBlocks(message)) {
        if (!this.canSendUpdates()) return;
        if (!(await this.sendUpdateAndWait({ sessionUpdate, content }))) return;
      }
    }
    if (this.pendingResumeRequested) {
      this.schedulePendingResume();
    }
  }

  /**
   * 发送可用的 slash commands 给 IDE（公开方法，由 BladeAgent 调用）
   */
  sendAvailableCommandsDelayed(): void {
    if (this.destroyed || this.connection.signal.aborted) return;
    if (this.availableCommandsTimer !== null) {
      clearTimeout(this.availableCommandsTimer);
    }

    // 延迟发送，确保在 session/new 响应之后
    // 使用较长的延迟确保 Zed 已准备好接收
    logger.debug(
      `[AcpSession ${this.id}] Scheduling available commands update (500ms delay)`
    );
    this.availableCommandsTimer = setTimeout(() => {
      this.availableCommandsTimer = null;
      if (this.destroyed || this.connection.signal.aborted) return;
      void this.sendAvailableCommands();
    }, 500);
  }

  /**
   * 处理 slash command
   */
  private async handleSlashCommand(
    message: string,
    signal: AbortSignal
  ): Promise<PromptResponse> {
    try {
      logger.debug(`[AcpSession ${this.id}] Executing slash command: ${message}`);

      // 创建 slash command 上下文，包含 ACP 回调和取消信号
      const context: SlashCommandContext = {
        cwd: this.cwd,
        surface: 'acp',
        workspaceRoot: this.cwd,
        sessionId: this.id,
        messages: [...this.messages],
        rewind: {
          listCheckpoints: async () => {
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            return this.runtime.listRewindCheckpoints();
          },
          execute: async (options) => {
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            const result = await this.runtime.rewindSession(options);
            this.messages = [...result.messages];
            await this.agent?.destroy();
            this.agent = await this.createAgent();
            return result;
          },
        },
        reasoning: {
          get: async () => {
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            return this.runtime.getReasoningConfiguration();
          },
          set: async (selection) => {
            await this.setReasoningEffort(selection);
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            return this.runtime.getReasoningConfiguration();
          },
        },
        serviceTier: {
          get: async () => {
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            return this.runtime.getServiceTierConfiguration();
          },
          set: async (selection) => {
            await this.setServiceTier(selection);
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            return this.runtime.getServiceTierConfiguration();
          },
        },
        responseVerbosity: {
          get: async () => {
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            return this.runtime.getResponseVerbosityConfiguration();
          },
          set: async (selection) => {
            await this.setResponseVerbosity(selection);
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            return this.runtime.getResponseVerbosityConfiguration();
          },
        },
        communicationStyle: {
          get: async () => {
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            return this.runtime.getCommunicationStyleConfiguration();
          },
          set: async (selection) => {
            await this.setCommunicationStyle(selection);
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            return this.runtime.getCommunicationStyleConfiguration();
          },
        },
        subagents: {
          list: async () => {
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            return this.runtime.listSubagents();
          },
          resume: async (agentId, prompt) => {
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            let announced = false;
            let pendingCompletion:
              | import('../agent/subagents/AgentSessionStore.js').AgentSession
              | undefined;
            const sendCompletion = (
              session: import('../agent/subagents/AgentSessionStore.js').AgentSession
            ) => {
              this.sendUpdate({
                sessionUpdate: 'tool_call_update',
                toolCallId: session.id,
                status:
                  session.status === 'completed'
                    ? ('completed' as ToolCallStatus)
                    : ('failed' as ToolCallStatus),
                content: [
                  {
                    type: 'content',
                    content: {
                      type: 'text',
                      text:
                        session.result?.message ||
                        session.result?.error ||
                        `Subagent ${session.status}`,
                    },
                  },
                ],
              });
            };
            const result = this.runtime.resumeSubagent({
              agentId,
              prompt,
              onCompleted: (session) => {
                if (announced) sendCompletion(session);
                else pendingCompletion = session;
              },
            });
            this.sendUpdate({
              sessionUpdate: 'tool_call',
              toolCallId: result.session.id,
              status: 'in_progress' as ToolCallStatus,
              title: `Resuming ${result.session.subagentType} subagent`,
              content: [
                {
                  type: 'content',
                  content: {
                    type: 'text',
                    text: `Resumed from ${result.source.id} at depth ${result.session.resumeDepth}`,
                  },
                },
              ],
              kind: this.mapToolKind('readonly'),
            });
            announced = true;
            if (pendingCompletion) sendCompletion(pendingCompletion);
            return result;
          },
        },
        mcp: {
          getCatalog: async () => {
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            return this.runtime.getMcpContentCatalog();
          },
          refresh: async (serverName) => {
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            await this.runtime.refreshMcpContentCatalogs(serverName);
          },
          getPrompt: async (serverName, name, arguments_) => {
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            return this.runtime.getMcpPrompt(serverName, name, arguments_);
          },
          complete: async (serverName, input, signal) => {
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            return this.runtime.completeMcpArgument(serverName, input, signal);
          },
          listTasks: async (serverName) => {
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            return this.runtime.listMcpTasks(serverName);
          },
          getTask: async (taskId) => {
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            return this.runtime.getMcpTask(taskId);
          },
          cancelTask: async (taskId, signal) => {
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            return this.runtime.cancelMcpTask(taskId, signal);
          },
          getLogs: async (serverName, options) => {
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            return this.runtime.getMcpLogs(serverName, options);
          },
          setLoggingLevel: async (serverName, level) => {
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            await this.runtime.setMcpLoggingLevel(serverName, level);
          },
          getInstructions: async () => {
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            return this.runtime.getMcpInstructions();
          },
        },
        codeReview: {
          run: async (request, reviewSignal) => {
            if (!this.runtime) throw new Error('Session runtime is unavailable');
            const run = await CodeReviewService.start({
              sessionId: this.id,
              projectPath: this.cwd,
              runtime: this.runtime,
              request,
              signal: reviewSignal,
              onEvent: (event) => {
                if (event.kind === 'tool_start') {
                  this.sendUpdate({
                    sessionUpdate: 'tool_call',
                    toolCallId: event.toolCall.id,
                    status: 'in_progress' as ToolCallStatus,
                    title: `Review: ${event.toolCall.function.name}`,
                    content: [],
                    kind: this.mapToolKind(event.toolKind),
                  });
                } else if (event.kind === 'tool_result') {
                  this.sendUpdate({
                    sessionUpdate: 'tool_call_update',
                    toolCallId: event.toolCall.id,
                    status: event.result.success
                      ? ('completed' as ToolCallStatus)
                      : ('failed' as ToolCallStatus),
                    content: [],
                  });
                }
              },
            });
            const completion = await run.completion;
            const review = (await CodeReviewService.list(this.cwd, this.id)).find(
              (candidate) => candidate.start.reviewId === run.reviewId
            );
            if (!review) throw new Error(`Review not found: ${run.reviewId}`);
            this.messages = await SessionService.loadSession(this.id, this.cwd);
            return {
              reviewId: run.reviewId,
              status: completion.status,
              findings: completion.findings.length,
              content: renderCodeReview(review.start, completion),
            };
          },
        },
        signal, // 传递取消信号
        acp: {
          // 发送文本消息给 IDE
          sendMessage: (text: string) => {
            this.sendUpdate({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            });
          },
          // 发送工具调用开始通知
          sendToolStart: (
            toolName: string,
            params: Record<string, unknown>,
            toolKind?: 'readonly' | 'write' | 'execute'
          ) => {
            const toolCallId = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const acpKind = this.mapToolKind(toolKind);
            this.sendUpdate({
              sessionUpdate: 'tool_call',
              toolCallId,
              status: 'in_progress' as ToolCallStatus,
              title: `${toolName}`,
              content: [
                {
                  type: 'content',
                  content: { type: 'text', text: JSON.stringify(params, null, 2) },
                },
              ],
              kind: acpKind,
            });
          },
          // 发送工具调用结果通知
          sendToolResult: (
            _toolName: string,
            result: { success: boolean; summary?: string }
          ) => {
            // 工具结果通过 sendMessage 显示即可
            if (result.summary) {
              this.sendUpdate({
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: result.summary },
              });
            }
          },
        },
      };

      // 执行 slash command
      const result = await executeSlashCommand(message, context);
      const action = result.data?.action;
      if (action === 'start_goal' || action === 'resume_goal') {
        this.schedulePendingResume();
      }
      if (action === 'rewind_session' && Array.isArray(result.data?.messages)) {
        this.messages = [...(result.data.messages as Message[])];
      }
      if (
        (result.message === 'compact_completed' ||
          result.message === 'compact_fallback') &&
        result.data?.compactedMessages
      ) {
        this.messages = [...result.data.compactedMessages];
      }

      // 发送结果给 IDE
      // 优先使用 content（完整内容），否则使用 message（简短状态）
      const displayContent = result.content || result.message;
      if (displayContent) {
        this.sendUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: displayContent },
        });
      }

      if (result.error) {
        this.sendUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `[FAIL] ${result.error}` },
        });
      }

      return { stopReason: result.success ? 'end_turn' : 'cancelled' };
    } catch (error) {
      // 注意：abortHandler 在 try 块内定义，catch 无法直接访问
      // 但由于 signal 是 WeakRef 的，GC 会自动清理
      logger.error(`[AcpSession ${this.id}] Slash command error:`, error);
      this.sendUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `[FAIL] 命令执行失败: ${error instanceof Error ? error.message : '未知错误'}`,
        },
      });
      return { stopReason: 'cancelled' };
    }
  }

  /**
   * 发送可用的 slash commands 给 IDE
   *
   * 根据 ACP 协议，命令名称不需要 "/" 前缀。
   * 客户端（IDE）会在 prompt 中以 "/command args" 格式发送命令。
   */
  private async sendAvailableCommands(): Promise<void> {
    try {
      const commands = getRegisteredCommands(this.cwd);

      // 在 ACP 模式下过滤掉不需要的命令
      // - model/permissions/theme: Zed 已提供 UI
      // - config/exit/ide: 在 IDE 中不适用
      const excludedInAcp = ['model', 'permissions', 'theme', 'config', 'exit', 'ide'];
      const filteredCommands = commands.filter(
        (cmd) => !excludedInAcp.includes(cmd.name)
      );

      const availableCommands: AvailableCommand[] = filteredCommands.map((cmd) => {
        // 构建 input hint
        let hint: string | undefined;

        // 优先使用 usage（包含参数提示，如 "/commit [message]"）
        if (cmd.usage) {
          // 提取参数部分（去掉命令名）
          const usageParts = cmd.usage.replace(/^\/\w+\s*/, '').trim();
          if (usageParts) {
            hint = usageParts;
          }
        }

        // 其次添加别名信息
        if (cmd.aliases?.length) {
          const aliasText = `Aliases: ${cmd.aliases.join(', ')}`;
          hint = hint ? `${hint} | ${aliasText}` : aliasText;
        }

        return {
          // 命令名称不需要 / 前缀（根据 ACP 协议）
          name: cmd.name,
          description: cmd.description,
          // 如果命令需要参数或有别名，添加 input.hint
          input: hint ? { hint } : undefined,
        };
      });

      logger.info(
        `[AcpSession ${this.id}] Sending available commands: ${JSON.stringify(availableCommands.map((c) => c.name))}`
      );

      this.sendUpdate({
        sessionUpdate: 'available_commands_update',
        availableCommands,
      });

      logger.info(
        `[AcpSession ${this.id}] Sent ${availableCommands.length} available commands`
      );
    } catch (error) {
      logger.error(`[AcpSession ${this.id}] Failed to send available commands:`, error);
    }
  }

  /**
   * 处理 prompt 请求
   *
   * @param params - ACP prompt 请求参数
   * @returns ACP prompt 响应
   */
  async prompt(
    params: PromptRequest,
    internalOptions: {
      pendingInputOnly?: boolean;
      goalContinuationOnly?: boolean;
    } = {}
  ): Promise<PromptResponse> {
    // 设置当前会话（确保工具使用正确的服务上下文）
    AcpServiceContext.setCurrentSession(this.id);

    if (!this.agent || !this.runtime) {
      throw new Error('Session not initialized');
    }

    const resolvedPrompt = this.resolvePrompt(params.prompt);
    const message = resolvedPrompt.content;
    const messageText = resolvedPrompt.displayText;
    const rawOutputSchema =
      params._meta?.outputSchema ??
      (internalOptions.pendingInputOnly
        ? this.runtime
            .getPendingSteeringMessages()
            .find((pending) => pending.outputSchema)?.outputSchema
        : undefined);
    let outputSchema:
      | ReturnType<typeof createStructuredOutputContract>['schema']
      | undefined;
    if (rawOutputSchema !== undefined) {
      outputSchema = createStructuredOutputContract(rawOutputSchema).schema;
    }
    if (messageText.trimStart().startsWith('!')) {
      if (outputSchema) {
        throw new Error('Output schemas cannot be combined with user shell commands');
      }
      return this.handleUserShellCommand(messageText);
    }
    if (this.pendingPrompt) {
      if (outputSchema) {
        throw new Error(
          'Wait for the active turn to finish before setting an output schema'
        );
      }
      if (/^\/goal(?:\s|$)/i.test(messageText.trim())) {
        return this.handleSlashCommand(messageText, this.pendingPrompt.signal);
      }
      const steering = await this.runtime.enqueueSteering(message, {
        allowBeforeTurn: true,
      });
      if (!steering.accepted) {
        throw new Error(
          steering.reason === 'queue_full'
            ? 'Active turn steering queue is full'
            : 'Active turn is no longer steerable'
        );
      }
      logger.debug(
        `[AcpSession ${this.id}] Queued steering for active turn (${steering.queued})`
      );
      if (steering.delivery === 'next_turn') {
        this.schedulePendingResume();
      }
      return { stopReason: 'end_turn' };
    }

    const abortController = new AbortController();
    this.pendingPrompt = abortController;

    try {
      // 1. 解析 ACP prompt 为文本消息
      logger.debug(
        `[AcpSession ${this.id}] Received prompt: ${messageText.slice(0, 100)}...`
      );

      // 2. 检查是否是 slash command
      if (isSlashCommand(messageText)) {
        if (outputSchema) {
          throw new Error('Output schemas cannot be combined with slash commands');
        }
        // 重要：使用 await 确保 finally 块在 handleSlashCommand 完成后才执行
        // 否则 finally 会在返回 Promise 后立即执行，导致 pendingPrompt 被提前清空
        return await this.handleSlashCommand(messageText, abortController.signal);
      }

      // 3. 构建 ChatContext
      const context: ChatContext = {
        sessionId: this.id,
        userId: 'acp-user',
        workspaceRoot: this.cwd,
        messages: [...this.messages],
        signal: abortController.signal,
        // 根据 ACP 模式映射到 Blade 权限模式
        permissionMode: this.mapModeToPermissionMode(),
        onPermissionModeChange: async (permissionMode) => {
          this.mode = this.mapPermissionModeToMode(permissionMode);
          this.sendUpdate({
            sessionUpdate: 'current_mode_update',
            currentModeId: this.mode,
          });
        },
        ...(this.options.taskWorktree ? { worktreeActive: true } : {}),
        // 确认处理器：转发给 IDE 请求权限
        confirmationHandler: {
          requestConfirmation: async (
            details: ConfirmationDetails
          ): Promise<ConfirmationResponse> => {
            return this.requestPermission(details);
          },
        },
      };

      // 4. 调用 Agent chatStream（Phase 4: 事件驱动消费）
      // stream_end 不外发给 ACP 客户端（保持内部语义）
      const loopResult = await drainLoop(
        this.agent.chatStream(message, context, {
          pendingInputOnly: internalOptions.pendingInputOnly,
          goalContinuationOnly: internalOptions.goalContinuationOnly,
          outputSchema,
        }),
        async (event: LoopEvent) => {
          switch (event.kind) {
            // --- 流式内容（delta 是唯一内容信号） ---
            case 'content_delta':
              if (outputSchema) break;
              this.sendUpdate({
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: event.delta },
              });
              break;
            case 'thinking_delta':
              this.sendUpdate({
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: event.delta },
              });
              break;

            // --- 工具事件 ---
            case 'tool_start': {
              const toolCall = event.toolCall;
              const toolName = toolCall.function.name;
              if (toolName === STRUCTURED_OUTPUT_TOOL_NAME) break;
              const acpKind = this.mapToolKind(event.toolKind);
              let title = `Executing ${toolName}`;
              if (toolName === 'Task' && 'function' in toolCall) {
                try {
                  const args = JSON.parse(toolCall.function.arguments) as Record<
                    string,
                    unknown
                  >;
                  const resumedFrom = args.resume_from ?? args.resume;
                  if (typeof resumedFrom === 'string') {
                    title = `Resuming ${String(args.subagent_type || 'subagent')} from ${resumedFrom}`;
                  }
                } catch {
                  // Keep the generic tool title for malformed arguments.
                }
              }
              this.sendUpdate({
                sessionUpdate: 'tool_call',
                toolCallId: toolCall.id,
                status: 'in_progress' as ToolCallStatus,
                title,
                content: [],
                kind: acpKind,
              });
              break;
            }
            case 'tool_progress': {
              const toolCall = event.toolCall;
              if (toolCall.function.name === STRUCTURED_OUTPUT_TOOL_NAME) break;
              this.sendUpdate({
                sessionUpdate: 'tool_call_update',
                toolCallId: toolCall.id,
                status: 'in_progress' as ToolCallStatus,
                content: [
                  {
                    type: 'content',
                    content: {
                      type: 'text',
                      text: event.update.message,
                    },
                  },
                ],
              });
              break;
            }
            case 'tool_result': {
              const toolCall = event.toolCall;
              if (toolCall.function.name === STRUCTURED_OUTPUT_TOOL_NAME) break;
              const result = event.result;
              const content: ToolCallContent[] = [];

              // 检查是否有 diff 信息（Edit/Write 工具）
              const metadata = result.metadata;
              if (metadata?.kind === 'patch' && Array.isArray(metadata.changes)) {
                for (const change of metadata.changes) {
                  if (
                    !change ||
                    typeof change !== 'object' ||
                    !('path' in change) ||
                    typeof change.path !== 'string'
                  ) {
                    continue;
                  }
                  content.push({
                    type: 'diff',
                    path: change.path,
                    oldText:
                      'oldContent' in change && typeof change.oldContent === 'string'
                        ? change.oldContent
                        : null,
                    newText:
                      'newContent' in change && typeof change.newContent === 'string'
                        ? change.newContent
                        : null,
                  });
                }
              } else if (
                metadata?.kind === 'edit' &&
                typeof metadata.file_path === 'string' &&
                typeof metadata.oldContent === 'string' &&
                (typeof metadata.newContent === 'string' ||
                  metadata.newContent === undefined)
              ) {
                content.push({
                  type: 'diff',
                  path: metadata.file_path,
                  oldText: metadata.oldContent,
                  newText: (metadata.newContent as string) ?? null,
                });
              } else {
                const toolName = toolCall.function.name;
                const displayText = renderToolDisplayToString(
                  formatToolDisplay(toolName, result)
                );
                content.push({
                  type: 'content',
                  content: { type: 'text', text: displayText },
                });
              }
              if (
                toolCall.function.name === 'Task' &&
                (metadata?.verificationVerdict === 'pass' ||
                  metadata?.verificationVerdict === 'fail' ||
                  metadata?.verificationVerdict === 'partial')
              ) {
                content.unshift({
                  type: 'content',
                  content: {
                    type: 'text',
                    text: `Verification result: ${metadata.verificationVerdict.toUpperCase()}`,
                  },
                });
              }

              const status: ToolCallStatus = result.success ? 'completed' : 'failed';
              this.sendUpdate({
                sessionUpdate: 'tool_call_update',
                toolCallId: toolCall.id,
                status,
                content,
              });
              break;
            }
            case 'structured_output':
              this.sendUpdate({
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: JSON.stringify(event.output),
                },
              });
              break;
            case 'mcp_catalog_changed':
              this.sendUpdate({
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text:
                    `MCP catalog r${event.revision} (${event.serverName}): ` +
                    `+${event.added.length} -${event.removed.length} ~${event.updated.length}\n`,
                },
              });
              break;
            case 'mcp_content_changed':
              this.sendUpdate({
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text:
                    `MCP ${event.contentKind} r${event.revision} ` +
                    `(${event.serverName}): +${event.added.length} ` +
                    `-${event.removed.length} ~${event.updated.length}\n`,
                },
              });
              break;
            case 'mcp_resource_updated':
              this.sendUpdate({
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text:
                    `MCP resource updated r${event.revision} ` +
                    `(${event.serverName}): ${event.uri}\n`,
                },
              });
              break;
            case 'mcp_connection_changed':
              this.sendUpdate({
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text:
                    `MCP connection r${event.revision} (${event.serverName}): ` +
                    `${event.phase} ${event.attempt}/${event.maxAttempts}\n`,
                },
              });
              break;
            case 'mcp_log':
              this.sendUpdate({
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text:
                    `MCP log r${event.revision} (${event.serverName}) ` +
                    `${event.level}${event.logger ? ` logger=${event.logger}` : ''}: ` +
                    `${event.message}\n`,
                },
              });
              break;
            case 'mcp_instructions_changed':
              this.sendUpdate({
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text:
                    `MCP instructions r${event.revision} ` +
                    `(${event.serverName}): ${event.action}` +
                    `${event.detailsOmitted ? ' details-omitted' : ''}\n`,
                },
              });
              break;
            case 'mcp_task_changed':
              this.sendUpdate({
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text:
                    `MCP task r${event.revision} ${event.taskId} ` +
                    `(${event.serverName}/${event.toolName}): ${event.status}` +
                    `${event.hasResult ? ' result-available' : ''}\n`,
                },
              });
              break;
            case 'project_rules_loaded':
              this.sendUpdate({
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text:
                    `Project rules loaded: ${event.files.length}` +
                    `${event.blockedWrite ? ' (write retry required)' : ''}\n`,
                },
              });
              break;

            // --- 业务事件 ---
            case 'task_update':
              this.sendPlanUpdate(event.tasks);
              break;
            case 'steering_applied':
              break;
            case 'follow_up_started':
              for (const pending of event.messages) {
                if (!pending.recovered || pending.persisted) continue;
                for (const content of historyContentBlocks(pending.content)) {
                  this.sendUpdate({
                    sessionUpdate: 'user_message_chunk',
                    content,
                  });
                }
              }
              if (event.recovered > 0) {
                this.sendUpdate({
                  sessionUpdate: 'agent_message_chunk',
                  content: {
                    type: 'text',
                    text: `[Resuming ${event.recovered} queued instruction${event.recovered === 1 ? '' : 's'} recovered after restart]\n`,
                  },
                });
              }
              break;
            case 'goal_updated':
              if (event.goal && event.goal.status !== 'active') {
                this.sendUpdate({
                  sessionUpdate: 'agent_message_chunk',
                  content: {
                    type: 'text',
                    text: `[Goal ${event.goal.status}: ${event.goal.objective}]\n`,
                  },
                });
              }
              break;
            case 'goal_continuation_started':
              break;

            // --- 系统事件不外发 ---
            // stream_end: 内部 per-turn 信号，不外发
            // turn_start, compaction, token_usage, model_fallback: 内部事件
            default:
              break;
          }
        }
      );
      // 5. 使用 chatContext.messages 作为完整历史（Phase 4: 不再手工构造）
      this.messages = [...context.messages];
      if (!loopResult.success) {
        const failureType = loopResult.error?.type ?? 'unknown';
        throw RequestError.internalError(
          { failureType },
          `Agent turn failed (${failureType})`
        );
      }

      // 6. 检查是否被取消
      if (abortController.signal.aborted) {
        return { stopReason: 'cancelled' };
      }

      return {
        stopReason: 'end_turn',
        ...(loopResult.metadata?.structuredOutput
          ? {
              _meta: {
                structuredOutput: loopResult.metadata.structuredOutput,
                outputSchemaDigest: loopResult.metadata.structuredOutputSchemaDigest,
              },
            }
          : {}),
      };
    } catch (error) {
      // 检查是否是取消操作
      if (
        abortController.signal.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        return { stopReason: 'cancelled' };
      }

      logger.error(`[AcpSession ${this.id}] Prompt error:`, error);
      throw error;
    } finally {
      if (this.pendingPrompt === abortController) {
        this.pendingPrompt = null;
        if (!this.destroyed && this.pendingResumeRequested) {
          this.schedulePendingResume();
        }
      }
    }
  }

  private async handleUserShellCommand(input: string): Promise<PromptResponse> {
    if (!this.runtime) throw new Error('Session runtime is unavailable');
    if (this.pendingUserShell) {
      throw new Error('A user shell command is already running');
    }
    const command = input.trimStart().slice(1).trim();
    if (!command) throw new Error('User shell command cannot be empty');

    const controller = new AbortController();
    this.pendingUserShell = controller;
    let toolCallId: string | undefined;
    let streamedOutput = '';
    try {
      const result = await this.runtime.executeUserShellCommand(command, {
        signal: controller.signal,
        onEvent: async (event) => {
          toolCallId = event.executionId;
          if (event.type === 'started') {
            this.sendUpdate({
              sessionUpdate: 'tool_call',
              toolCallId: event.executionId,
              status: 'in_progress' as ToolCallStatus,
              title: `! ${event.command}`,
              content: [],
              kind: 'execute' as ToolKind,
            });
            return;
          }
          if (event.type === 'output') {
            streamedOutput += event.chunk;
            this.sendUpdate({
              sessionUpdate: 'tool_call_update',
              toolCallId: event.executionId,
              status: 'in_progress' as ToolCallStatus,
              content: [
                {
                  type: 'content',
                  content: {
                    type: 'text',
                    text: event.chunk,
                  },
                },
              ],
            });
            return;
          }
          const display = renderUserShellCommandForDisplay(event.record);
          this.sendUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: event.executionId,
            status:
              event.record.status === 'completed'
                ? ('completed' as ToolCallStatus)
                : ('failed' as ToolCallStatus),
            content: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: streamedOutput ? shellCompletionSummary(event.record) : display,
                },
              },
            ],
          });
        },
      });
      this.messages.push({
        role: 'user',
        content: result.modelContent,
        metadata: {
          userShellCommand: JSON.parse(JSON.stringify(result.record)) as JsonValue,
        },
      });
      if (result.delivery === 'next_turn') this.schedulePendingResume();
      return {
        stopReason: result.record.status === 'aborted' ? 'cancelled' : 'end_turn',
      };
    } catch (error) {
      if (toolCallId) {
        this.sendUpdate({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'failed' as ToolCallStatus,
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: error instanceof Error ? error.message : String(error),
              },
            },
          ],
        });
      }
      if (controller.signal.aborted) return { stopReason: 'cancelled' };
      throw error;
    } finally {
      if (this.pendingUserShell === controller) this.pendingUserShell = null;
    }
  }

  private schedulePendingResume(): void {
    if (this.destroyed || this.connection.signal.aborted) return;
    this.pendingResumeRequested = true;
    queueMicrotask(() => {
      void this.resumePendingIfIdle();
    });
  }

  private async resumePendingIfIdle(): Promise<void> {
    if (this.destroyed || this.connection.signal.aborted) return;
    if (this.pendingPrompt || this.pendingUserShell || !this.runtime || !this.agent)
      return;
    const hasPending = this.runtime.getPendingSteeringCount() > 0;
    const goal = hasPending ? null : await this.runtime.getGoal();
    const hasActiveGoal = goal?.status === 'active';
    if (!hasPending && !hasActiveGoal) {
      this.pendingResumeRequested = false;
      return;
    }

    this.pendingResumeRequested = false;
    await this.prompt(
      { sessionId: this.id, prompt: [] },
      {
        pendingInputOnly: hasPending,
        goalContinuationOnly: hasActiveGoal,
      }
    ).catch((error) => {
      logger.error(`[AcpSession ${this.id}] Failed to resume pending input:`, error);
    });
  }

  /**
   * 取消当前操作
   */
  cancel(): void {
    logger.info(`[AcpSession ${this.id}] Cancel requested`);
    this.pendingResumeRequested = false;
    let cancelled = false;
    if (this.pendingPrompt) {
      this.pendingPrompt.abort();
      this.pendingPrompt = null;
      cancelled = true;
    }
    if (this.pendingUserShell) {
      this.pendingUserShell.abort();
      this.pendingUserShell = null;
      cancelled = true;
    }
    if (!cancelled) {
      logger.warn(`[AcpSession ${this.id}] No pending prompt to cancel`);
    }
  }

  /**
   * 设置会话模式（权限模式）
   *
   * 可用模式：
   * - default: 所有操作都需要确认
   * - auto-edit: 文件编辑自动批准，命令需要确认
   * - yolo: 所有操作自动批准
   * - plan: 只读模式，不允许写操作
   */
  async setMode(mode: string): Promise<void> {
    const validModes: AcpModeId[] = ['default', 'auto-edit', 'yolo', 'plan'];
    const nextMode = validModes.includes(mode as AcpModeId)
      ? (mode as AcpModeId)
      : 'default';
    const permissionMode = this.mapModeIdToPermissionMode(nextMode);
    await SessionService.setSessionPermissionMode(this.id, this.cwd, permissionMode);
    this.mode = nextMode;
    logger.info(`[AcpSession ${this.id}] Mode set to: ${this.mode}`);

    // 发送模式更新通知给 IDE
    this.sendUpdate({
      sessionUpdate: 'current_mode_update',
      currentModeId: this.mode,
    });
  }

  /**
   * 将 ACP 模式映射到 Blade 权限模式
   */
  private mapModeToPermissionMode(): PermissionMode | undefined {
    return this.mapModeIdToPermissionMode(this.mode);
  }

  private mapModeIdToPermissionMode(mode: AcpModeId): PermissionMode {
    switch (mode) {
      case 'yolo':
        return PermissionMode.YOLO; // 绕过所有权限检查
      case 'auto-edit':
        return PermissionMode.AUTO_EDIT; // 自动批准文件操作
      case 'plan':
        return PermissionMode.PLAN; // 只读模式
      case 'default':
      default:
        return PermissionMode.DEFAULT; // 使用默认权限（需要确认）
    }
  }

  /**
   * 检查操作是否需要确认
   *
   * ToolKind 枚举值：
   * - 'readonly': 只读操作（Read, Glob, Grep 等）
   * - 'write': 写操作（Edit, Write 等）
   * - 'execute': 执行操作（Bash 等）
   */
  private shouldAutoApprove(toolKind: string): boolean {
    switch (this.mode) {
      case 'yolo':
        // Full Auto: 所有操作自动批准
        return true;
      case 'auto-edit':
        // Auto Edit: 只读和写操作自动批准，执行操作需要确认
        return toolKind === 'readonly' || toolKind === 'write';
      case 'plan':
        // Plan Only: 只允许只读操作
        return toolKind === 'readonly';
      case 'default':
      default:
        // Default: 都需要确认
        return false;
    }
  }

  /**
   * 设置会话模型
   */
  async setModel(modelId: string): Promise<void> {
    logger.info(`[AcpSession ${this.id}] Model set to: ${modelId}`);

    if (this.pendingPrompt) {
      throw new Error('Cannot switch models while a prompt is active');
    }
    if (!this.agent) {
      throw new Error('Session not initialized');
    }
    if (!this.runtime) {
      throw new Error('Session runtime is unavailable');
    }

    const previousModelId = this.runtime.getCurrentModelId();
    await this.agent.switchModel(modelId);
    try {
      try {
        await SessionService.updateSessionMetadata(this.id, this.cwd, {
          selectedModelId: modelId,
        });
      } catch (error) {
        if (
          !(error instanceof SessionMissingCreationError) &&
          (error as NodeJS.ErrnoException).code !== 'ENOENT'
        ) {
          throw error;
        }
        await SessionService.createSessionMetadata(this.id, this.cwd, {
          taskStatus: 'completed',
          selectedModelId: modelId,
        });
      }
    } catch (error) {
      if (previousModelId && previousModelId !== modelId) {
        await this.agent.switchModel(previousModelId).catch((rollbackError) => {
          logger.error(
            `[AcpSession ${this.id}] Failed to roll back a non-durable model switch:`,
            rollbackError
          );
        });
      }
      throw error;
    }
  }

  getCurrentModelId(): string | undefined {
    return this.runtime?.getCurrentModelId();
  }

  async setReasoningEffort(reasoningEffort: ReasoningEffortSelection): Promise<void> {
    if (this.pendingPrompt) {
      throw new Error('Cannot switch reasoning effort while a prompt is active');
    }
    if (!this.runtime) {
      throw new Error('Session runtime is unavailable');
    }
    const previous = this.runtime.getReasoningConfiguration();
    try {
      this.runtime.resolveReasoningConfiguration(reasoningEffort);
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : 'Invalid reasoning effort'
      );
    }
    if (previous.selection === reasoningEffort) return;
    await this.runtime.refresh({ reasoningEffort });
    try {
      try {
        await SessionService.updateSessionMetadata(this.id, this.cwd, {
          reasoningEffort,
        });
      } catch (error) {
        if (
          !(error instanceof SessionMissingCreationError) &&
          (error as NodeJS.ErrnoException).code !== 'ENOENT'
        ) {
          throw error;
        }
        await SessionService.createSessionMetadata(this.id, this.cwd, {
          taskStatus: 'completed',
          selectedModelId: this.runtime.getCurrentModelId(),
          reasoningEffort,
        });
      }
    } catch (error) {
      await this.runtime.refresh({ reasoningEffort: previous.selection });
      throw error;
    }
  }

  async setServiceTier(serviceTier: ServiceTierSelection): Promise<void> {
    if (this.pendingPrompt) {
      throw new Error('Cannot switch service tier while a prompt is active');
    }
    if (!this.runtime) {
      throw new Error('Session runtime is unavailable');
    }
    const previous = this.runtime.getServiceTierConfiguration();
    try {
      this.runtime.resolveServiceTierConfiguration(serviceTier);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Invalid service tier');
    }
    if (previous.selection === serviceTier) return;
    await this.runtime.refresh({ serviceTier });
    try {
      try {
        await SessionService.updateSessionMetadata(this.id, this.cwd, {
          serviceTier,
        });
      } catch (error) {
        if (
          !(error instanceof SessionMissingCreationError) &&
          (error as NodeJS.ErrnoException).code !== 'ENOENT'
        ) {
          throw error;
        }
        await SessionService.createSessionMetadata(this.id, this.cwd, {
          taskStatus: 'completed',
          selectedModelId: this.runtime.getCurrentModelId(),
          serviceTier,
        });
      }
    } catch (error) {
      await this.runtime.refresh({ serviceTier: previous.selection });
      throw error;
    }
  }

  async setResponseVerbosity(
    responseVerbosity: ResponseVerbositySelection
  ): Promise<void> {
    if (this.pendingPrompt) {
      throw new Error('Cannot switch response verbosity while a prompt is active');
    }
    if (!this.runtime) {
      throw new Error('Session runtime is unavailable');
    }
    const previous = this.runtime.getResponseVerbosityConfiguration();
    try {
      this.runtime.resolveResponseVerbosityConfiguration(responseVerbosity);
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : 'Invalid response verbosity'
      );
    }
    if (previous.selection === responseVerbosity) return;
    await this.runtime.refresh({ responseVerbosity });
    try {
      try {
        await SessionService.updateSessionMetadata(this.id, this.cwd, {
          responseVerbosity,
        });
      } catch (error) {
        if (
          !(error instanceof SessionMissingCreationError) &&
          (error as NodeJS.ErrnoException).code !== 'ENOENT'
        ) {
          throw error;
        }
        await SessionService.createSessionMetadata(this.id, this.cwd, {
          taskStatus: 'completed',
          selectedModelId: this.runtime.getCurrentModelId(),
          responseVerbosity,
        });
      }
    } catch (error) {
      await this.runtime.refresh({ responseVerbosity: previous.selection });
      throw error;
    }
  }

  async setCommunicationStyle(
    communicationStyle: CommunicationStyleSelection
  ): Promise<void> {
    if (this.pendingPrompt) {
      throw new Error('Cannot switch communication style while a prompt is active');
    }
    if (!this.runtime) {
      throw new Error('Session runtime is unavailable');
    }
    const previous = this.runtime.getCommunicationStyleConfiguration();
    const next =
      this.runtime.resolveCommunicationStyleConfiguration(communicationStyle);
    if (next.source !== 'built-in' && !next.contentSha256) {
      throw new Error('Custom communication style has no provenance');
    }
    if (previous.selection === communicationStyle) return;
    await this.runtime.refresh({ communicationStyle });
    try {
      try {
        await SessionService.updateSessionMetadata(this.id, this.cwd, {
          communicationStyle,
          communicationStyleDigest:
            next.source === 'built-in' ? null : next.contentSha256,
        });
      } catch (error) {
        if (
          !(error instanceof SessionMissingCreationError) &&
          (error as NodeJS.ErrnoException).code !== 'ENOENT'
        ) {
          throw error;
        }
        await SessionService.createSessionMetadata(this.id, this.cwd, {
          taskStatus: 'completed',
          selectedModelId: this.runtime.getCurrentModelId(),
          communicationStyle,
          ...(next.source !== 'built-in' && next.contentSha256
            ? { communicationStyleDigest: next.contentSha256 }
            : {}),
        });
      }
    } catch (error) {
      await this.runtime.refresh({ communicationStyle: previous.selection });
      throw error;
    }
  }

  getModelConfiguration():
    | (Pick<BladeConfig, 'currentModelId' | 'models' | 'modelProviders'> & {
        reasoning: ReturnType<SessionRuntime['getReasoningConfiguration']>;
        serviceTier: ReturnType<SessionRuntime['getServiceTierConfiguration']>;
        responseVerbosity: ReturnType<
          SessionRuntime['getResponseVerbosityConfiguration']
        >;
        communicationStyle: ReturnType<
          SessionRuntime['getCommunicationStyleConfiguration']
        >;
      })
    | undefined {
    if (!this.runtime) return undefined;
    const config = this.runtime.getConfig();
    return {
      currentModelId: this.runtime.getCurrentModelId() ?? config.currentModelId,
      models: config.models.map((model) => structuredClone(model)),
      modelProviders: structuredClone(config.modelProviders),
      reasoning: this.runtime.getReasoningConfiguration(),
      serviceTier: this.runtime.getServiceTierConfiguration(),
      responseVerbosity: this.runtime.getResponseVerbosityConfiguration(),
      communicationStyle: this.runtime.getCommunicationStyleConfiguration(),
    };
  }

  getMode(): AcpModeId {
    return this.mode;
  }

  /**
   * 销毁会话
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.availableCommandsTimer !== null) {
      clearTimeout(this.availableCommandsTimer);
      this.availableCommandsTimer = null;
    }
    this.taskStatusUnsubscribe?.();
    this.taskStatusUnsubscribe = undefined;

    const agent = this.agent;
    const runtime = this.runtime;
    this.agent = null;
    this.runtime = null;
    let firstError: unknown;
    const attempt = async (cleanup: () => void | Promise<void>): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        firstError ??= error;
      }
    };

    await attempt(() => this.cancel());
    if (agent) await attempt(() => agent.destroy());
    if (runtime) await attempt(() => runtime.dispose());
    await attempt(() => AcpServiceContext.destroySession(this.id));
    logger.debug(`[AcpSession ${this.id}] Destroyed`);

    if (firstError !== undefined) throw firstError;
  }

  /**
   * 解析 ACP prompt 为文本消息
   *
   * @param prompt - ACP prompt 数组
   * @returns 文本消息
   */
  private resolvePrompt(prompt: ContentBlock[]): ResolvedAcpPrompt {
    const displayParts: string[] = [];
    const contentParts: ContentPart[] = [];
    let imageCount = 0;
    let imageBytes = 0;
    let textChars = 0;

    const appendContent = (part: ContentPart): void => {
      if (contentParts.length > 0) {
        contentParts.push({ type: 'text', text: '\n' });
        textChars += 1;
      }
      contentParts.push(part);
      if (part.type === 'text') textChars += part.text.length;
    };

    for (const block of prompt) {
      if (block.type === 'text') {
        displayParts.push(block.text);
        appendContent({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        const dataUrl = `data:${block.mimeType};base64,${block.data}`;
        imageCount += 1;
        imageBytes += dataUrl.length;
        displayParts.push(`[Image: ${block.mimeType}]`);
        appendContent({ type: 'image_url', image_url: { url: dataUrl } });
      } else if (block.type === 'resource') {
        const resource = block.resource;
        if ('text' in resource) {
          const text = `<file path="${resource.uri}">\n${resource.text}\n</file>`;
          displayParts.push(text);
          appendContent({ type: 'text', text });
        }
      } else if (block.type === 'resource_link') {
        const text = `[Resource: ${block.uri}]`;
        displayParts.push(text);
        appendContent({ type: 'text', text });
      }
    }

    if (imageCount > MAX_INLINE_ATTACHMENT_COUNT) {
      throw new Error(
        `ACP prompt contains more than ${MAX_INLINE_ATTACHMENT_COUNT} images`
      );
    }
    if (imageBytes > MAX_INLINE_ATTACHMENT_BYTES) {
      throw new Error('ACP prompt images exceed the 5 MiB limit');
    }
    if (textChars > MAX_USER_MESSAGE_TEXT_CHARS) {
      throw new Error(
        `ACP prompt text exceeds ${MAX_USER_MESSAGE_TEXT_CHARS} characters`
      );
    }

    const displayText = displayParts.join('\n');
    return {
      content: imageCount > 0 ? contentParts : displayText,
      displayText,
    };
  }

  /**
   * 发送会话更新通知
   */
  private canSendUpdates(): boolean {
    return !this.destroyed && !this.connection.signal.aborted;
  }

  private async sendUpdateAndWait(
    update: SessionNotification['update']
  ): Promise<boolean> {
    if (!this.canSendUpdates()) return false;
    await this.connection.sessionUpdate({ sessionId: this.id, update });
    return this.canSendUpdates();
  }

  private sendUpdate(update: SessionNotification['update']): void {
    if (!this.canSendUpdates()) return;
    const params: SessionNotification = {
      sessionId: this.id,
      update,
    };

    // 异步发送，不等待
    this.connection.sessionUpdate(params).catch((error) => {
      logger.warn(`[AcpSession ${this.id}] Failed to send update:`, error);
    });
  }

  /**
   * 发送 Plan 更新（Task 列表）
   *
   * 将 Blade TaskListItem 转换为 ACP PlanEntry 格式发送给 IDE。
   * IDE 会在 UI 中渲染为任务列表，显示进度和状态。
   *
   * @param tasks - Blade Task 列表
   */
  private sendPlanUpdate(tasks: TaskListItem[]): void {
    // 将 Blade TaskListItem 转换为 ACP PlanEntry
    const entries: PlanEntry[] = tasks.map((task) => ({
      content: task.subject,
      priority: task.priority as PlanEntryPriority,
      status: task.status, // pending | in_progress | completed 与 ACP 一致
    }));

    logger.debug(
      `[AcpSession ${this.id}] Sending plan update with ${entries.length} entries`
    );

    this.sendUpdate({
      sessionUpdate: 'plan',
      entries,
    });
  }

  /**
   * 请求 IDE 确认权限
   *
   * 根据当前模式决定是否自动批准：
   * - yolo: 所有操作自动批准
   * - auto-edit: 文件操作自动批准，命令需要确认
   * - plan: 只允许读操作
   * - default: 所有操作都需要确认
   *
   * @param details - 确认详情
   * @returns 确认响应
   */
  private async requestPermission(
    details: ConfirmationDetails
  ): Promise<ConfirmationResponse> {
    const signal = this.pendingPrompt?.signal;
    if (details.type === 'askUserQuestion') {
      return this.requestUserQuestions(details, signal);
    }
    if (details.type === 'mcpElicitation') {
      return this.requestMcpElicitation(details, signal);
    }

    // 检查是否应该自动批准（基于当前模式）
    const toolKind = details.kind?.toLowerCase() || 'execute';
    if (details.type !== 'mcpSampling' && this.shouldAutoApprove(toolKind)) {
      logger.debug(
        `[AcpSession ${this.id}] Auto-approving ${toolKind} in mode: ${this.mode}`
      );
      return { approved: true };
    }

    // Plan 模式下拒绝写和执行操作
    if (this.mode === 'plan' && (toolKind === 'write' || toolKind === 'execute')) {
      logger.debug(`[AcpSession ${this.id}] Rejecting ${toolKind} in plan mode`);
      return {
        approved: false,
        reason: 'Write and execute operations are not allowed in Plan mode',
      };
    }

    try {
      const toolCallId = nanoid();
      const content: ToolCallContent[] = [];

      // 添加详情信息
      if (details.message) {
        content.push({
          type: 'content',
          content: { type: 'text', text: details.message },
        });
      }
      if (details.details) {
        content.push({
          type: 'content',
          content: { type: 'text', text: details.details },
        });
      }

      // 添加风险信息
      if (details.risks && details.risks.length > 0) {
        content.push({
          type: 'content',
          content: { type: 'text', text: `Risks:\n- ${details.risks.join('\n- ')}` },
        });
      }

      // 转换 Blade ToolKind 到 ACP ToolKind
      const acpToolKind = this.mapToolKind(toolKind);

      const permissionRequest: RequestPermissionRequest = {
        sessionId: this.id,
        options:
          details.type === 'mcpSampling'
            ? [
                {
                  optionId: 'allow_once',
                  name: 'Allow this sampling request',
                  kind: 'allow_once',
                },
                {
                  optionId: 'reject_once',
                  name: 'Deny',
                  kind: 'reject_once',
                },
              ]
            : [
                // 允许选项
                {
                  optionId: 'allow_once',
                  name: 'Allow once',
                  kind: 'allow_once',
                },
                {
                  optionId: 'allow_always',
                  name: 'Always allow',
                  kind: 'allow_always',
                },
                // 拒绝选项
                {
                  optionId: 'reject_once',
                  name: 'Deny once',
                  kind: 'reject_once',
                },
                {
                  optionId: 'reject_always',
                  name: 'Always deny',
                  kind: 'reject_always',
                },
              ],
        toolCall: {
          toolCallId,
          status: 'pending' as ToolCallStatus,
          title: details.title || 'Permission Required',
          content,
          kind: acpToolKind,
        },
      };

      const response = await this.waitForClientInteraction(
        this.connection.requestPermission(permissionRequest),
        signal
      );
      if (!response) {
        return { approved: false, reason: CONFIRMATION_ABORTED_REASON };
      }

      // 检查用户选择
      const outcome = response.outcome;
      if (outcome.outcome === 'cancelled') {
        return {
          approved: false,
          reason: 'User cancelled the permission request',
        };
      }

      // outcome.outcome === 'selected'，此时有 optionId
      const optionId = outcome.optionId;
      if (optionId === 'allow_always') {
        return { approved: true, scope: 'project' };
      }
      if (optionId === 'reject_always') {
        return {
          approved: false,
          scope: 'project',
          reason: 'User permanently denied the permission request',
        };
      }

      const approved = optionId === 'allow_once';
      return {
        approved,
        scope: 'once',
        reason: approved ? undefined : 'User denied the operation',
      };
    } catch (error) {
      logger.warn(`[AcpSession ${this.id}] Permission request failed:`, error);
      // 权限请求失败时，默认拒绝
      return {
        approved: false,
        reason: 'Permission request failed',
      };
    }
  }

  private async requestUserQuestions(
    details: ConfirmationDetails,
    signal?: AbortSignal
  ): Promise<ConfirmationResponse> {
    const questions = details.questions ?? [];
    if (questions.length === 0) {
      return { approved: false, reason: 'No structured questions were provided' };
    }
    if (questions.some((question) => question.multiSelect)) {
      return {
        approved: false,
        reason: 'ACP does not support multi-select question responses',
      };
    }

    const answers: Record<string, string> = {};
    try {
      for (const [questionIndex, question] of questions.entries()) {
        const optionIds = question.options.map(
          (_option, optionIndex) => `answer:${questionIndex}:${optionIndex}`
        );
        const cancelId = `answer:${questionIndex}:cancel`;
        const response = await this.waitForClientInteraction(
          this.connection.requestPermission({
            sessionId: this.id,
            options: [
              ...question.options.map((option, optionIndex) => ({
                optionId: optionIds[optionIndex]!,
                name: option.label,
                kind: 'allow_once' as const,
              })),
              { optionId: cancelId, name: 'Cancel', kind: 'reject_once' as const },
            ],
            toolCall: {
              toolCallId: nanoid(),
              status: 'pending' as ToolCallStatus,
              title: question.header,
              kind: 'think',
              content: [
                {
                  type: 'content',
                  content: {
                    type: 'text',
                    text: [
                      question.question,
                      ...question.options.map(
                        (option) => `${option.label}: ${option.description}`
                      ),
                    ].join('\n'),
                  },
                },
              ],
            },
          }),
          signal
        );

        if (!response) {
          return { approved: false, reason: CONFIRMATION_ABORTED_REASON };
        }

        if (response.outcome.outcome !== 'selected') {
          return { approved: false, reason: 'User cancelled the question prompt' };
        }
        const selectedIndex = optionIds.indexOf(response.outcome.optionId);
        if (selectedIndex < 0) {
          return { approved: false, reason: 'User cancelled the question prompt' };
        }
        answers[question.header] = question.options[selectedIndex]!.label;
      }

      return { approved: true, answers };
    } catch (error) {
      logger.warn(`[AcpSession ${this.id}] Question request failed:`, error);
      return { approved: false, reason: 'Question request failed' };
    }
  }

  private async requestMcpElicitation(
    details: ConfirmationDetails,
    signal?: AbortSignal
  ): Promise<ConfirmationResponse> {
    const elicitation = details.mcpElicitation;
    if (!elicitation) {
      return {
        approved: false,
        reason: 'MCP elicitation details are missing',
        elicitation: { action: 'cancel' },
      };
    }

    try {
      if (elicitation.mode === 'url') {
        const selected = await this.requestElicitationChoice(
          'MCP external authorization',
          [
            elicitation.message,
            `Server: ${elicitation.serverName}`,
            `Domain: ${elicitation.domain ?? 'unknown'}`,
            `URL: ${elicitation.url ?? ''}`,
            'Open this URL yourself only if you trust the MCP server.',
          ].join('\n'),
          [
            { id: 'accept', label: 'I will open this URL' },
            { id: 'decline', label: 'Decline' },
          ],
          signal
        );
        if (selected === 'accept') {
          return {
            approved: true,
            elicitation: { action: 'accept' },
          };
        }
        return {
          approved: false,
          reason: selected === 'decline' ? 'User declined URL' : 'User cancelled',
          elicitation: {
            action: selected === 'decline' ? 'decline' : 'cancel',
          },
        };
      }

      const content = Object.create(null) as McpElicitationContent;
      for (const field of elicitation.fields ?? []) {
        const selected = await this.collectAcpElicitationField(field, signal);
        if (selected.cancelled) {
          return {
            approved: false,
            reason: selected.reason,
            elicitation: { action: 'cancel' },
          };
        }
        if (selected.value !== undefined) {
          content[field.name] = selected.value;
        }
      }
      return {
        approved: true,
        elicitation: { action: 'accept', content },
      };
    } catch (error) {
      logger.warn(`[AcpSession ${this.id}] MCP elicitation failed:`, error);
      return {
        approved: false,
        reason: 'MCP elicitation failed',
        elicitation: { action: 'cancel' },
      };
    }
  }

  private async collectAcpElicitationField(
    field: McpElicitationField,
    signal?: AbortSignal
  ): Promise<{
    cancelled: boolean;
    reason?: string;
    value?: string | number | boolean | string[];
  }> {
    if (field.type === 'select' || field.type === 'boolean') {
      const choices =
        field.type === 'boolean'
          ? [
              { id: 'true', label: 'Yes', value: true },
              { id: 'false', label: 'No', value: false },
            ]
          : (field.options ?? []).map((option, index) => ({
              id: `option:${index}`,
              label: option.label,
              value: option.value,
            }));
      const selected = await this.requestElicitationChoice(
        field.title,
        [field.description, field.required ? 'Required' : 'Optional']
          .filter(Boolean)
          .join('\n'),
        [
          ...choices.map((choice) => ({ id: choice.id, label: choice.label })),
          ...(!field.required ? [{ id: 'skip', label: 'Skip' }] : []),
        ],
        signal
      );
      if (selected === 'skip') return { cancelled: false };
      const choice = choices.find((candidate) => candidate.id === selected);
      if (!choice) {
        return { cancelled: true, reason: 'User cancelled MCP elicitation' };
      }
      return { cancelled: false, value: choice.value };
    }

    if (field.defaultValue !== undefined) {
      const selected = await this.requestElicitationChoice(
        field.title,
        [
          field.description,
          `ACP cannot collect ${field.type} input. Use the server default: ${String(
            field.defaultValue
          )}?`,
        ]
          .filter(Boolean)
          .join('\n'),
        [
          { id: 'default', label: 'Use default' },
          ...(!field.required ? [{ id: 'skip', label: 'Skip' }] : []),
        ],
        signal
      );
      if (selected === 'default') {
        return { cancelled: false, value: field.defaultValue };
      }
      if (selected === 'skip') return { cancelled: false };
      return { cancelled: true, reason: 'User cancelled MCP elicitation' };
    }

    if (!field.required) return { cancelled: false };
    return {
      cancelled: true,
      reason: `ACP cannot collect required ${field.type} field "${field.name}"`,
    };
  }

  private async requestElicitationChoice(
    title: string,
    message: string,
    choices: Array<{ id: string; label: string }>,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const response = await this.waitForClientInteraction(
      this.connection.requestPermission({
        sessionId: this.id,
        options: [
          ...choices.map((choice) => ({
            optionId: choice.id,
            name: choice.label,
            kind: 'allow_once' as const,
          })),
          {
            optionId: 'cancel',
            name: 'Cancel',
            kind: 'reject_once' as const,
          },
        ],
        toolCall: {
          toolCallId: nanoid(),
          status: 'pending' as ToolCallStatus,
          title,
          kind: 'think',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: message },
            },
          ],
        },
      }),
      signal
    );
    return response?.outcome.outcome === 'selected'
      ? response.outcome.optionId
      : undefined;
  }

  private async waitForClientInteraction<T>(
    request: Promise<T>,
    signal?: AbortSignal
  ): Promise<T | undefined> {
    if (!signal) return request;
    if (signal.aborted) return undefined;

    return new Promise<T | undefined>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => settle(() => resolve(undefined));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
      request.then(
        (response) => settle(() => resolve(response)),
        (error) => settle(() => reject(error))
      );
    });
  }

  /**
   * 映射 Blade ToolKind 到 ACP ToolKind
   *
   * Blade ToolKind: 'readonly' | 'write' | 'execute'
   * ACP ToolKind: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other'
   */
  private mapToolKind(kind: string | undefined): ToolKind {
    const kindMap: Record<string, ToolKind> = {
      // Blade ToolKind 映射
      readonly: 'read',
      write: 'edit',
      execute: 'execute',
      // 保留其他可能的直接映射
      read: 'read',
      edit: 'edit',
      delete: 'delete',
      move: 'move',
      search: 'search',
      think: 'think',
      fetch: 'fetch',
    };
    return kindMap[kind || ''] || 'other';
  }
}

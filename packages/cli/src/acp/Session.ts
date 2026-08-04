/**
 * ACP 会话管理
 *
 * 封装 Blade Agent，处理 ACP 协议的 prompt 请求，
 * 将 Agent 的流式输出转发给 IDE。
 */

import type {
  AgentSideConnection,
  AvailableCommand,
  ClientCapabilities,
  ContentBlock,
  McpServer,
  PlanEntry,
  PlanEntryPriority,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  SessionNotification,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
} from '@agentclientprotocol/sdk';
import { nanoid } from 'nanoid';
import { Agent } from '../agent/Agent.js';
import { drainLoop } from '../agent/loop/index.js';
import type { LoopEvent } from '../agent/loop/types.js';
import { SessionRuntime } from '../agent/runtime/SessionRuntime.js';
import type { ChatContext } from '../agent/types.js';
import { type McpServerConfig, PermissionMode } from '../config/types.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type { Message } from '../services/ChatServiceInterface.js';
import {
  executeSlashCommand,
  getRegisteredCommands,
  isSlashCommand,
} from '../slash-commands/index.js';
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
type AcpModeId = 'default' | 'auto-edit' | 'yolo' | 'plan';

export interface AcpSessionOptions {
  initialMessages?: Message[];
  mcpServers?: McpServer[];
}

function entriesToRecord(
  entries: Array<{ name: string; value: string }>
): Record<string, string> {
  return Object.fromEntries(entries.map((entry) => [entry.name, entry.value]));
}

function toMcpServerConfig(server: McpServer): McpServerConfig {
  if ('command' in server) {
    return {
      type: 'stdio',
      command: server.command,
      args: server.args,
      env: entriesToRecord(server.env),
    };
  }

  return {
    type: server.type,
    url: server.url,
    headers: entriesToRecord(server.headers),
  };
}

function toMcpServers(servers: McpServer[]): Record<string, McpServerConfig> {
  return Object.fromEntries(
    servers.map((server) => [server.name, toMcpServerConfig(server)])
  );
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

export class AcpSession {
  private agent: Agent | null = null;
  private runtime: SessionRuntime | null = null;
  private pendingPrompt: AbortController | null = null;
  private pendingResumeRequested = false;
  private messages: Message[];
  private mode: AcpModeId = 'default';

  constructor(
    private readonly id: string,
    private readonly cwd: string,
    private readonly connection: AgentSideConnection,
    private readonly clientCapabilities: ClientCapabilities | undefined,
    private readonly options: AcpSessionOptions = {}
  ) {
    this.messages = [...(options.initialMessages ?? [])];
  }

  /**
   * 初始化会话
   * 创建 Blade Agent 实例并初始化 ACP 服务
   */
  async initialize(): Promise<void> {
    logger.debug(`[AcpSession ${this.id}] Initializing...`);

    // 初始化 ACP 服务上下文（按会话隔离，不使用 process.chdir）
    AcpServiceContext.initializeSession(
      this.connection,
      this.id,
      this.clientCapabilities,
      this.cwd
    );
    logger.debug(`[AcpSession ${this.id}] ACP service context initialized`);

    const mcpServers = this.options.mcpServers
      ? toMcpServers(this.options.mcpServers)
      : undefined;
    this.runtime = await SessionRuntime.create({
      sessionId: this.id,
      workspaceRoot: this.cwd,
      ...(mcpServers ? { mcpServers } : {}),
    });
    this.agent = await Agent.createWithRuntime(this.runtime, { sessionId: this.id });

    logger.debug(`[AcpSession ${this.id}] Agent created successfully`);
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
      const sessionUpdate =
        message.role === 'user'
          ? 'user_message_chunk'
          : message.role === 'assistant'
            ? 'agent_message_chunk'
            : undefined;
      if (!sessionUpdate) continue;

      for (const content of historyContentBlocks(message.content)) {
        await this.connection.sessionUpdate({
          sessionId: this.id,
          update: { sessionUpdate, content },
        });
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
    // 延迟发送，确保在 session/new 响应之后
    // 使用较长的延迟确保 Zed 已准备好接收
    logger.debug(
      `[AcpSession ${this.id}] Scheduling available commands update (500ms delay)`
    );
    setTimeout(() => {
      this.sendAvailableCommands();
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
      const context = {
        cwd: this.cwd,
        workspaceRoot: this.cwd,
        sessionId: this.id,
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
      const commands = getRegisteredCommands();

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

    const message = this.resolvePrompt(params.prompt);
    if (this.pendingPrompt) {
      if (/^\/goal(?:\s|$)/i.test(message.trim())) {
        return this.handleSlashCommand(message, this.pendingPrompt.signal);
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
        `[AcpSession ${this.id}] Received prompt: ${message.slice(0, 100)}...`
      );

      // 2. 检查是否是 slash command
      if (isSlashCommand(message)) {
        // 重要：使用 await 确保 finally 块在 handleSlashCommand 完成后才执行
        // 否则 finally 会在返回 Promise 后立即执行，导致 pendingPrompt 被提前清空
        return await this.handleSlashCommand(message, abortController.signal);
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
      await drainLoop(
        this.agent.chatStream(message, context, {
          pendingInputOnly: internalOptions.pendingInputOnly,
          goalContinuationOnly: internalOptions.goalContinuationOnly,
        }),
        async (event: LoopEvent) => {
          switch (event.kind) {
            // --- 流式内容（delta 是唯一内容信号） ---
            case 'content_delta':
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
              const toolName =
                'function' in toolCall ? toolCall.function.name : toolCall.type;
              const acpKind = this.mapToolKind(event.toolKind);
              this.sendUpdate({
                sessionUpdate: 'tool_call',
                toolCallId: toolCall.id,
                status: 'in_progress' as ToolCallStatus,
                title: `Executing ${toolName}`,
                content: [],
                kind: acpKind,
              });
              break;
            }
            case 'tool_result': {
              const toolCall = event.toolCall;
              const result = event.result;
              const content: ToolCallContent[] = [];

              // 检查是否有 diff 信息（Edit/Write 工具）
              const metadata = result.metadata;
              if (
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
                const toolName =
                  'function' in toolCall ? toolCall.function.name : toolCall.type;
                const displayText = renderToolDisplayToString(
                  formatToolDisplay(toolName, result)
                );
                content.push({
                  type: 'content',
                  content: { type: 'text', text: displayText },
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

      // 6. 检查是否被取消
      if (abortController.signal.aborted) {
        return { stopReason: 'cancelled' };
      }

      return { stopReason: 'end_turn' };
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
        if (this.pendingResumeRequested) {
          this.schedulePendingResume();
        }
      }
    }
  }

  private schedulePendingResume(): void {
    this.pendingResumeRequested = true;
    queueMicrotask(() => {
      void this.resumePendingIfIdle();
    });
  }

  private async resumePendingIfIdle(): Promise<void> {
    if (this.pendingPrompt || !this.runtime || !this.agent) return;
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
    if (this.pendingPrompt) {
      this.pendingPrompt.abort();
      this.pendingPrompt = null;
      logger.info(`[AcpSession ${this.id}] Cancelled successfully`);
    } else {
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
    // 验证并设置模式
    const validModes: AcpModeId[] = ['default', 'auto-edit', 'yolo', 'plan'];
    this.mode = validModes.includes(mode as AcpModeId)
      ? (mode as AcpModeId)
      : 'default';
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
    switch (this.mode) {
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

    await this.agent.switchModel(modelId);
  }

  /**
   * 销毁会话
   */
  async destroy(): Promise<void> {
    this.cancel();
    if (this.agent) {
      await this.agent.destroy();
      this.agent = null;
    }
    if (this.runtime) {
      await this.runtime.dispose();
      this.runtime = null;
    }
    // 销毁此会话的 ACP 服务（不影响其他会话）
    AcpServiceContext.destroySession(this.id);
    logger.debug(`[AcpSession ${this.id}] Destroyed`);
  }

  /**
   * 解析 ACP prompt 为文本消息
   *
   * @param prompt - ACP prompt 数组
   * @returns 文本消息
   */
  private resolvePrompt(prompt: ContentBlock[]): string {
    const parts: string[] = [];

    for (const block of prompt) {
      if (block.type === 'text') {
        parts.push(block.text);
      } else if (block.type === 'image') {
        // 图片暂时用占位符表示
        parts.push(`[Image: ${block.mimeType}]`);
      } else if (block.type === 'resource') {
        // 嵌入资源（文件内容等）
        const resource = block.resource;
        if ('text' in resource) {
          parts.push(`<file path="${resource.uri}">\n${resource.text}\n</file>`);
        }
      } else if (block.type === 'resource_link') {
        // 资源链接
        parts.push(`[Resource: ${block.uri}]`);
      }
    }

    return parts.join('\n');
  }

  /**
   * 发送会话更新通知
   */
  private sendUpdate(update: SessionNotification['update']): void {
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

    // 检查是否应该自动批准（基于当前模式）
    const toolKind = details.kind?.toLowerCase() || 'execute';
    if (this.shouldAutoApprove(toolKind)) {
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
        options: [
          // 允许选项
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
          // 拒绝选项
          { optionId: 'reject_once', name: 'Deny once', kind: 'reject_once' },
          { optionId: 'reject_always', name: 'Always deny', kind: 'reject_always' },
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

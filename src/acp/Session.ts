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
import type { ChatContext, LoopOptions } from '../agent/types.js';
import { PermissionMode } from '../config/types.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type { Message } from '../services/ChatServiceInterface.js';
import {
  executeSlashCommand,
  getRegisteredCommands,
  isSlashCommand,
} from '../slash-commands/index.js';
import type { TodoItem } from '../tools/builtin/todo/types.js';
import type {
  ConfirmationDetails,
  ConfirmationResponse,
} from '../tools/types/ExecutionTypes.js';
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

export class AcpSession {
  private agent: Agent | null = null;
  private pendingPrompt: AbortController | null = null;
  private messages: Message[] = [];
  private mode: AcpModeId = 'default';
  // 会话级别的权限缓存（allow_always 选项）
  private sessionApprovals: Set<string> = new Set();

  constructor(
    private readonly id: string,
    private readonly cwd: string,
    private readonly connection: AgentSideConnection,
    private readonly clientCapabilities: ClientCapabilities | undefined
  ) {}

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

    // 创建 Agent（cwd 通过 ChatContext.workspaceRoot 传递，不修改全局工作目录）
    this.agent = await Agent.create({});

    logger.debug(`[AcpSession ${this.id}] Agent created successfully`);
    // 注意：available_commands_update 在 BladeAgent.newSession 响应后延迟发送
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
            toolName: string,
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
          content: { type: 'text', text: `❌ ${result.error}` },
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
          text: `❌ 命令执行失败: ${error instanceof Error ? error.message : '未知错误'}`,
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
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    // 设置当前会话（确保工具使用正确的服务上下文）
    AcpServiceContext.setCurrentSession(this.id);

    // 中止之前的请求（如果有）
    this.pendingPrompt?.abort();

    const abortController = new AbortController();
    this.pendingPrompt = abortController;

    if (!this.agent) {
      throw new Error('Session not initialized');
    }

    try {
      // 1. 解析 ACP prompt 为文本消息
      const message = this.resolvePrompt(params.prompt);
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

      // 3. 定义回调选项
      // 注意：abort 检查已在 Agent 内部统一处理，回调不再需要重复检查
      const loopOptions: LoopOptions = {
        signal: abortController.signal,

        // 文本内容流式输出
        onContent: (text: string) => {
          this.sendUpdate({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
          });
        },

        // 思考过程流式输出（DeepSeek R1 等）
        onThinking: (text: string) => {
          this.sendUpdate({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text },
          });
        },

        // 工具调用开始
        onToolStart: (toolCall, toolKind) => {
          const toolName =
            'function' in toolCall ? toolCall.function.name : toolCall.type;
          // 映射 Blade ToolKind 到 ACP ToolKind
          const acpKind = this.mapToolKind(toolKind);
          this.sendUpdate({
            sessionUpdate: 'tool_call',
            toolCallId: toolCall.id,
            status: 'in_progress' as ToolCallStatus,
            title: `Executing ${toolName}`,
            content: [],
            kind: acpKind,
          });
        },

        // 工具调用完成
        onToolResult: async (toolCall, result) => {
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
            // 发送 diff 格式（IDE 会显示差异视图）
            content.push({
              type: 'diff',
              path: metadata.file_path,
              oldText: metadata.oldContent,
              newText: (metadata.newContent as string) ?? null,
            });
          } else if (result.displayContent) {
            // 其他工具：发送文本内容
            const displayText =
              typeof result.displayContent === 'string'
                ? result.displayContent
                : JSON.stringify(result.displayContent);
            content.push({
              type: 'content',
              content: { type: 'text', text: displayText },
            });
          }

          const _toolName =
            'function' in toolCall ? toolCall.function.name : toolCall.type;
          const status: ToolCallStatus = result.success ? 'completed' : 'failed';

          this.sendUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: toolCall.id,
            status,
            content,
          });
        },

        // Todo 列表更新（发送 ACP plan）
        onTodoUpdate: (todos: TodoItem[]) => {
          this.sendPlanUpdate(todos);
        },
      };

      // 4. 调用 Agent chat
      const response = await this.agent.chat(message, context, loopOptions);

      // 5. 保存助手响应到历史
      if (response) {
        this.messages.push({ role: 'user', content: message });
        this.messages.push({ role: 'assistant', content: response });
      }

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
      }
    }
  }

  /**
   * 取消当前操作
   */
  cancel(): void {
    logger.info(`[AcpSession ${this.id}] Cancel requested`);
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

    // 更新 Agent 的模型配置
    if (this.agent) {
      // TODO: 实现模型切换逻辑
      // 目前 Agent 不支持运行时切换模型，需要重新创建
      logger.warn(
        `[AcpSession ${this.id}] Runtime model switching not yet implemented`
      );
    }
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
   * 发送 Plan 更新（Todo 列表）
   *
   * 将 Blade TodoItem 转换为 ACP PlanEntry 格式发送给 IDE。
   * IDE 会在 UI 中渲染为任务列表，显示进度和状态。
   *
   * @param todos - Blade Todo 列表
   */
  private sendPlanUpdate(todos: TodoItem[]): void {
    // 将 Blade TodoItem 转换为 ACP PlanEntry
    const entries: PlanEntry[] = todos.map((todo) => ({
      content: todo.content,
      priority: todo.priority as PlanEntryPriority,
      status: todo.status, // pending | in_progress | completed 与 ACP 一致
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

    // 生成权限签名（用于 allow_always 缓存）
    const permissionSignature = `${toolKind}:${details.title || 'unknown'}`;

    // 检查会话级别的权限缓存（allow_always）
    if (this.sessionApprovals.has(permissionSignature)) {
      logger.debug(
        `[AcpSession ${this.id}] Using cached approval for: ${permissionSignature}`
      );
      // 注意：返回 'once' 而非 'session'，因为：
      // 1. ACP 自己管理会话缓存（sessionApprovals）
      // 2. 'session' 会触发 Blade 的持久化逻辑，与 ACP "仅本次会话" 语义不符
      return { approved: true };
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

      const response = await this.connection.requestPermission(permissionRequest);

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
      const approved = optionId === 'allow_once' || optionId === 'allow_always';

      // 缓存 allow_always 选择（会话级别）
      if (optionId === 'allow_always') {
        this.sessionApprovals.add(permissionSignature);
        logger.debug(
          `[AcpSession ${this.id}] Cached approval for: ${permissionSignature}`
        );
      }

      // 处理 reject_always（可选：缓存拒绝，但目前不实现）
      // if (optionId === 'reject_always') { ... }

      // 注意：始终返回 'once' 或不返回 scope
      // ACP 的 "Always Allow" 仅在本次会话有效（内存缓存），不应触发 Blade 的持久化
      return {
        approved,
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

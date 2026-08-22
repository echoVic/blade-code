/**
 * Agent核心类 - 无状态设计
 *
 * 设计原则：
 * 1. Agent 本身不保存任何会话状态（sessionId, messages 等）
 * 2. 所有状态通过 context 参数传入
 * 3. Agent 实例可以每次命令创建，用完即弃
 * 4. 历史连续性由外部 SessionContext 保证
 *
 * 负责：LLM 交互、工具执行、循环检测
 */

import { randomUUID } from 'node:crypto';
import {
  type BladeConfig,
  ConfigManager,
  type PermissionConfig,
  PermissionMode,
} from '../config/index.js';
import type { ModelConfig } from '../config/types.js';
import { ContextManager } from '../context/ContextManager.js';
import { getBladeStorageRoot } from '../context/storage/pathUtils.js';
import { buildGoalContinuationPrompt } from '../goals/prompts.js';
import type { GoalSnapshot } from '../goals/types.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import { McpToolArtifactStore } from '../mcp/McpToolArtifactStore.js';
import { resolveWorkspaceMcpConfig } from '../mcp/resolveWorkspaceMcpConfig.js';
import { buildSystemPrompt, createPlanModeReminder } from '../prompts/index.js';
import { AttachmentCollector } from '../prompts/processors/AttachmentCollector.js';
import type { Attachment } from '../prompts/processors/types.js';
import {
  type ContentPart,
  createChatServiceAsync,
  type IChatService,
  type Message,
} from '../services/ChatServiceInterface.js';
import { isProviderAdmissionError } from '../services/pi/providerRequestAdmission.js';
import { resolveModelConfig as resolvePiModelConfig } from '../services/pi/resolveModelConfig.js';
import { SessionService } from '../services/SessionService.js';
import { createStructuredOutputContract } from '../services/StructuredOutputService.js';
import {
  ensureStoreInitialized,
  getAllModels,
  getConfig,
  getCurrentModel,
  getModelById,
  getThinkingModeEnabled,
} from '../store/vanilla.js';
import { getBuiltinTools } from '../tools/builtin/index.js';
import { createMcpContentTools } from '../tools/builtin/mcp/index.js';
import { ToolExecutor } from '../tools/execution/ToolExecutor.js';
import { ToolRegistry } from '../tools/registry/ToolRegistry.js';
import { type Tool, ToolErrorType, type ToolResult } from '../tools/types/index.js';
import { getCwd } from '../utils/cwd.js';
import { ExecutionEngine } from './ExecutionEngine.js';
import { executeLoopGenerator } from './loop/index.js';
import {
  type FunctionToolCallRef,
  handleSubagentLifecycle,
} from './loop/toolDomainPolicy.js';
import type { LoopEvent } from './loop/types.js';
import {
  resolveWorkspaceAgentResources,
  type SessionAgentResources,
  snapshotWorkspaceAgentResources,
} from './resources/WorkspaceAgentResources.js';
import { ActiveOperationGate } from './runtime/ActiveOperationGate.js';
import type {
  ActiveTurnHandle,
  PreparedInputTurn,
  SteeringMessage,
} from './runtime/ActiveTurnMailbox.js';
import { SessionRuntime } from './runtime/SessionRuntime.js';
import {
  TaskAdmissionCancelledError,
  type TaskRunPermit,
  taskRunScheduler,
} from './runtime/TaskRunScheduler.js';
import { estimateTaskRunPendingBytes } from './runtime/taskRunFootprint.js';
import type { SubagentRegistry } from './subagents/SubagentRegistry.js';
import type {
  AgentOptions,
  AgentResponse,
  AgentTask,
  ChatContext,
  LoopOptions,
  LoopResult,
  UserMessageContent,
} from './types.js';

// 创建 Agent 专用 Logger
const logger = createLogger(LogCategory.AGENT);
const CACHE_STABLE_ENVIRONMENT_OPTIONS = {
  includeGitSnapshot: false,
  includeDirectoryListing: false,
} as const;

function isTerminalProviderAdmissionRejection(result: LoopResult): boolean {
  return (
    !result.success &&
    isProviderAdmissionError(result.error?.details) &&
    result.error.details.reason === 'queue_full'
  );
}

/**
 * Skill 执行上下文
 * 用于跟踪当前活动的 Skill 及其工具限制
 */
interface SkillExecutionContext {
  skillName: string;
  allowedTools?: string[];
  basePath: string;
}

export class Agent {
  private config: BladeConfig;
  private runtimeOptions: AgentOptions;
  private isInitialized = false;
  private activeTask?: AgentTask;
  private toolExecutor: ToolExecutor;
  // systemPrompt 已移除 - 改为从 context 参数传入（无状态设计）
  // sessionId 已移除 - 改为从 context 参数传入（无状态设计）

  // 核心组件
  private chatService!: IChatService;
  private executionEngine!: ExecutionEngine;
  private attachmentCollector?: AttachmentCollector;

  // Skill 执行上下文（用于 allowed-tools 限制）
  private activeSkillContext?: SkillExecutionContext;

  // 当前模型的上下文窗口大小（用于 tokenUsage 上报）
  private currentModelMaxContextTokens!: number;
  private currentModelId?: string;
  private sessionRuntime?: SessionRuntime;
  private legacyMcpRegistry?: McpRegistry;
  private agentResources?: SessionAgentResources;
  private subagentRegistry?: SubagentRegistry;
  private readonly activeOperations = new ActiveOperationGate();
  private destroyPromise?: Promise<void>;

  constructor(
    config: BladeConfig,
    runtimeOptions: AgentOptions = {},
    toolExecutor?: ToolExecutor,
    sessionRuntime?: SessionRuntime
  ) {
    this.config = config;
    this.runtimeOptions = runtimeOptions;
    this.toolExecutor = toolExecutor || this.createDefaultToolExecutor();
    this.sessionRuntime = sessionRuntime;
    this.agentResources = sessionRuntime?.getAgentResources();
    this.subagentRegistry = this.agentResources?.subagents;
    // sessionId 不再存储在 Agent 内部，改为从 context 传入
  }

  /**
   * 创建默认的工具执行器
   */
  private createDefaultToolExecutor(): ToolExecutor {
    const registry = new ToolRegistry();
    // 合并基础权限配置和运行时覆盖
    const permissions: PermissionConfig = {
      ...this.config.permissions,
      ...this.runtimeOptions.permissions,
    };
    const permissionMode =
      this.runtimeOptions.permissionMode ??
      this.config.permissionMode ??
      PermissionMode.DEFAULT;
    return new ToolExecutor(registry, {
      permissionConfig: permissions,
      permissionMode,
      maxHistorySize: 1000,
      toolWhitelist: this.runtimeOptions.toolWhitelist,
      toolBlacklist: this.runtimeOptions.toolBlacklist,
      contextDefaults: {
        foregroundCommandHandoffMs: this.config.bashForegroundHandoffMs,
      },
    });
  }

  private resolveModelConfig(requestedModelId?: string): ModelConfig {
    const modelId =
      requestedModelId && requestedModelId !== 'inherit' ? requestedModelId : undefined;
    const modelConfig = modelId ? getModelById(modelId) : getCurrentModel();
    if (!modelConfig) {
      throw new Error(`模型配置未找到: ${modelId ?? 'current'}`);
    }
    return modelConfig;
  }

  private async applyModelConfig(
    modelConfig: ModelConfig,
    label: string
  ): Promise<void> {
    const thinkingModeEnabled = getThinkingModeEnabled();
    const resolved = resolvePiModelConfig(
      modelConfig,
      this.config,
      thinkingModeEnabled ? 'auto' : 'off'
    );
    this.log(`${label} ${resolved.displayName} (${modelConfig.model})`);

    if (resolved.model.reasoning && !thinkingModeEnabled) {
      this.log(`模型支持 Thinking，但用户未开启（按 Tab 开启）`);
    } else if (resolved.chat.reasoningEnabled) {
      this.log(`Thinking 模式已启用，启用 reasoning_content 支持`);
    }

    this.currentModelMaxContextTokens = resolved.model.contextWindow;
    this.chatService = await createChatServiceAsync(resolved.chat);

    const contextManager = this.executionEngine?.getContextManager();
    this.executionEngine = new ExecutionEngine(this.chatService, contextManager);
    this.currentModelId = modelConfig.id;
  }

  private async switchModelIfNeeded(modelId: string): Promise<void> {
    if (this.sessionRuntime) {
      await this.sessionRuntime.refresh({ modelId });
      this.syncRuntimeState();
      return;
    }
    if (!modelId || modelId === this.currentModelId) return;
    const modelConfig = getModelById(modelId);
    if (!modelConfig) {
      this.log(`Warning: 模型配置未找到: ${modelId}`);
      return;
    }
    await this.applyModelConfig(modelConfig, '切换模型');
  }

  /** Switch this agent's session runtime without changing the global default model. */
  public async switchModel(modelId: string): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }
    await this.switchModelIfNeeded(modelId);
  }

  /**
   * 快速创建并初始化 Agent 实例（静态工厂方法）
   * 使用 Store 获取配置
   */
  static async create(options: AgentOptions = {}): Promise<Agent> {
    if (options.sessionId) {
      throw new Error(
        'Agent.create() does not accept sessionId. Create a SessionRuntime explicitly and use Agent.createWithRuntime().'
      );
    }
    // 0. 确保 store 已初始化（防御性检查）
    await ensureStoreInitialized();

    // 1. 检查是否有可用的模型配置
    const models = getAllModels();
    if (models.length === 0) {
      throw new Error(
        '没有可用的模型配置\n\n' +
          '请先使用以下命令添加模型：\n' +
          '  /model add\n\n' +
          '或运行初始化向导：\n' +
          '  /init'
      );
    }

    // 2. 获取 BladeConfig（从 Store）
    const config = getConfig();
    if (!config) {
      throw new Error('配置未初始化，请确保应用已正确启动');
    }

    // 3. 验证配置
    const configManager = ConfigManager.getInstance();
    configManager.validateConfig(config);

    // 3.5. 从 RuntimeConfig 继承 CLI 工具约束（allowedTools / disallowedTools）
    const mergedOptions = { ...options };
    if (!mergedOptions.toolWhitelist && config.allowedTools?.length) {
      mergedOptions.toolWhitelist = config.allowedTools;
    }
    if (!mergedOptions.toolBlacklist && config.disallowedTools?.length) {
      mergedOptions.toolBlacklist = config.disallowedTools;
    }

    // 4. 创建并初始化 Agent
    // 将 options 作为运行时参数传递
    const agent = new Agent(config, mergedOptions);
    await agent.initialize();

    // 5. 应用工具白名单（如果指定）
    if (mergedOptions.toolWhitelist && mergedOptions.toolWhitelist.length > 0) {
      agent.applyToolWhitelist(mergedOptions.toolWhitelist);
    }

    // 6. 应用工具黑名单（如果指定）
    if (mergedOptions.toolBlacklist && mergedOptions.toolBlacklist.length > 0) {
      agent.applyToolBlacklist(mergedOptions.toolBlacklist);
    }

    return agent;
  }

  static async createWithRuntime(
    runtime: SessionRuntime,
    options: AgentOptions = {}
  ): Promise<Agent> {
    const storeConfig = getConfig();
    const mergedOptions = { ...options };
    if (!mergedOptions.toolWhitelist && storeConfig?.allowedTools?.length) {
      mergedOptions.toolWhitelist = storeConfig.allowedTools;
    }
    if (!mergedOptions.toolBlacklist && storeConfig?.disallowedTools?.length) {
      mergedOptions.toolBlacklist = storeConfig.disallowedTools;
    }

    const agent = new Agent(
      runtime.getConfig(),
      mergedOptions,
      runtime.createToolExecutor(mergedOptions),
      runtime
    );
    await agent.initialize();
    return agent;
  }

  /**
   * 初始化Agent
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      this.log('初始化Agent...');

      if (this.sessionRuntime) {
        await this.initializeSystemPrompt();
        await this.sessionRuntime.refresh(this.runtimeOptions);
        this.syncRuntimeState();
        this.isInitialized = true;
        this.log(
          `Agent初始化完成，已加载 ${this.toolExecutor.getRegistry().getAll().length} 个工具`
        );
        return;
      }

      // 1. 初始化系统提示
      await this.initializeSystemPrompt();

      // 2. 加载 workspace-scoped subagent 配置
      await this.loadSubagents();

      // 3. 注册绑定当前资源快照的内置工具
      await this.registerBuiltinTools();

      // 4. 初始化核心组件
      const modelConfig = this.resolveModelConfig(this.runtimeOptions.modelId);
      await this.applyModelConfig(modelConfig, '使用模型:');

      // 5. 初始化附件收集器（@ 文件提及）
      this.attachmentCollector = new AttachmentCollector({
        cwd: getCwd(),
        maxFileSize: 1024 * 1024, // 1MB
        maxLines: 2000,
        maxTokens: 32000,
      });

      this.isInitialized = true;
      this.log(
        `Agent初始化完成，已加载 ${this.toolExecutor.getRegistry().getAll().length} 个工具`
      );
    } catch (error) {
      this.error('Agent初始化失败', error);
      throw error;
    }
  }

  /**
   * 执行任务
   */
  public async executeTask(task: AgentTask): Promise<AgentResponse> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    this.activeTask = task;

    try {
      this.log(`开始执行任务: ${task.id}`);

      const response = await this.executionEngine.executeTask(task);

      this.activeTask = undefined;
      this.log(`任务执行完成: ${task.id}`);

      return response;
    } catch (error) {
      this.activeTask = undefined;
      this.error(`任务执行失败: ${task.id}`, error);
      throw error;
    }
  }

  /**
   * 聊天接口 — 返回 AsyncGenerator 事件流
   *
   * 这是事件流的唯一入口。调用方通过 for-await-of 消费事件，
   * generator 的 return value 是 LoopResult。
   *
   * @param message  用户消息（纯文本或多模态）
   * @param context  聊天上下文（消息历史、会话标识等）
   * @param options  循环控制选项（行为回调 + 控制参数）
   */
  public async *chatStream(
    message: UserMessageContent,
    context?: ChatContext,
    options?: LoopOptions
  ): AsyncGenerator<import('./loop/types.js').LoopEvent, LoopResult, void> {
    const operation = this.activeOperations.enter(context?.signal);
    const activeContext = context
      ? {
          ...context,
          signal: operation.signal,
        }
      : context;

    try {
      const runtime = this.sessionRuntime;
      if (!runtime || !activeContext?.sessionId) {
        return yield* this.chatStreamInternal(message, activeContext, options);
      }

      let admissionPermit: TaskRunPermit | undefined;
      let ownsAdmission = false;
      let settled = false;
      const releaseOwnedAdmission = (
        taskStatus: 'completed' | 'failed' | 'cancelled' | 'interrupted'
      ): void => {
        if (!ownsAdmission || !admissionPermit) return;
        admissionPermit.release();
        admissionPermit = undefined;
        try {
          runtime.publishTaskAdmissionCapacity(taskStatus);
        } catch (error) {
          logger.warn('[Agent] Failed to publish task admission capacity:', error);
        }
      };
      try {
        if (runtime.isTaskSession?.() === true) {
          ownsAdmission = options?.taskAdmission === undefined;
          const admission =
            options?.taskAdmission ??
            taskRunScheduler.admit({
              key: `${runtime.workspaceRoot}\0${runtime.sessionId}`,
              ...runtime.getTaskAdmissionLimits(),
              pendingBytes: estimateTaskRunPendingBytes({
                content: message,
                outputSchema: options?.outputSchema,
                pendingMessages: runtime.getPendingSteeringMessages(),
              }),
              signal: activeContext.signal,
              onUpdate: (snapshot) => {
                void runtime.setTaskAdmission(snapshot).catch((error) => {
                  logger.warn(
                    '[Agent] Failed to persist task admission update:',
                    error
                  );
                });
              },
            });
          try {
            admissionPermit = await admission.ready;
          } catch (error) {
            if (
              error instanceof TaskAdmissionCancelledError ||
              activeContext.signal?.aborted
            ) {
              const reason = 'Task admission was cancelled';
              await runtime.setTaskStatus('cancelled', reason);
              settled = true;
              return {
                success: false,
                error: { type: 'aborted', message: reason },
                metadata: {
                  turnsCount: 0,
                  toolCallsCount: 0,
                  duration: 0,
                },
              };
            }
            throw error;
          }
          if (activeContext.signal?.aborted) {
            const reason = 'Task admission was cancelled';
            await runtime.setTaskStatus('cancelled', reason);
            settled = true;
            releaseOwnedAdmission('cancelled');
            return {
              success: false,
              error: { type: 'aborted', message: reason },
              metadata: {
                turnsCount: 0,
                toolCallsCount: 0,
                duration: 0,
              },
            };
          }
        }

        await runtime.setTaskStatus('running');
        const result = yield* this.chatStreamInternal(message, activeContext, options);
        const status = activeContext.signal?.aborted
          ? 'cancelled'
          : result.success
            ? 'completed'
            : 'failed';
        await runtime.setTaskStatus(
          status,
          status === 'failed' && result.error ? result.error : undefined
        );
        settled = true;
        releaseOwnedAdmission(status);
        return result;
      } catch (error) {
        const status = activeContext.signal?.aborted ? 'cancelled' : 'failed';
        try {
          await runtime.setTaskStatus(status, error);
        } catch (statusError) {
          logger.warn('[Agent] Failed to persist terminal task status:', statusError);
        }
        settled = true;
        releaseOwnedAdmission(status);
        throw error;
      } finally {
        if (!settled) {
          await runtime
            .setTaskStatus('interrupted', 'Task stream closed before completion')
            .catch((error) => {
              logger.warn('[Agent] Failed to persist interrupted task status:', error);
            });
          releaseOwnedAdmission('interrupted');
        }
        if (ownsAdmission) admissionPermit?.release();
      }
    } finally {
      operation.release();
    }
  }

  private async *chatStreamInternal(
    message: UserMessageContent,
    context?: ChatContext,
    options?: LoopOptions
  ): AsyncGenerator<import('./loop/types.js').LoopEvent, LoopResult, void> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    if (context?.workspaceRoot) {
      this.attachmentCollector?.setCwd(context.workspaceRoot);
    }

    const requestedPendingInputOnly = options?.pendingInputOnly === true;
    const requestedGoalContinuationOnly = options?.goalContinuationOnly === true;
    if (requestedPendingInputOnly && options?.preparedInputTurn) {
      throw new Error('preparedInputTurn cannot be combined with pendingInputOnly');
    }
    if (requestedPendingInputOnly && requestedGoalContinuationOnly) {
      throw new Error('goalContinuationOnly cannot be combined with pendingInputOnly');
    }
    if (requestedGoalContinuationOnly && options?.preparedInputTurn) {
      throw new Error('preparedInputTurn cannot be combined with goalContinuationOnly');
    }
    if (!context && options?.preparedInputTurn) {
      throw new Error('preparedInputTurn requires a ChatContext');
    }
    if (requestedGoalContinuationOnly && (!context || !this.sessionRuntime)) {
      throw new Error('goalContinuationOnly requires a SessionRuntime and ChatContext');
    }
    const requestedOutputSchema = options?.outputSchema
      ? createStructuredOutputContract(options.outputSchema).schema
      : undefined;

    let preparedInputTurn = options?.preparedInputTurn;
    if (
      context &&
      this.sessionRuntime &&
      !requestedPendingInputOnly &&
      !requestedGoalContinuationOnly
    ) {
      if (!preparedInputTurn) {
        const preparation = requestedOutputSchema
          ? await this.sessionRuntime.prepareInputTurn(message, {
              outputSchema: requestedOutputSchema,
            })
          : await this.sessionRuntime.prepareInputTurn(message);
        if (!preparation.accepted) {
          throw new Error(
            preparation.reason === 'queue_full'
              ? 'Pending user input queue is full'
              : 'Session already has an active turn'
          );
        }
        preparedInputTurn = preparation;
      }
    }
    if (
      context &&
      this.sessionRuntime &&
      (requestedPendingInputOnly ||
        requestedGoalContinuationOnly ||
        preparedInputTurn?.mode === 'pending')
    ) {
      const durableContext = await this.sessionRuntime.loadModelContext();
      context.messages.splice(0, context.messages.length, ...durableContext);
    }
    for (const event of this.takeStartupAdoptedToolResultEvents()) {
      yield event;
    }

    let enhancedMessage = message;
    let initialGoal: GoalSnapshot | null = null;
    if (requestedGoalContinuationOnly) {
      initialGoal = await this.sessionRuntime!.beginGoalContinuation();
      if (!initialGoal) {
        return {
          success: true,
          finalMessage: '',
          metadata: { turnsCount: 0, toolCallsCount: 0, duration: 0 },
        };
      }
      enhancedMessage = buildGoalContinuationPrompt(initialGoal);
    } else if (!requestedPendingInputOnly && preparedInputTurn?.mode !== 'pending') {
      try {
        enhancedMessage = await this.processAtMentionsForContent(message);
      } catch (error) {
        if (this.sessionRuntime && preparedInputTurn) {
          await this.sessionRuntime
            .finishTurn(preparedInputTurn.handle, {
              outcome: {
                status: 'aborted',
                cause: 'failed',
                turnsCount: 0,
                toolCallsCount: 0,
                durationMs: 0,
              },
            })
            .catch(() => undefined);
        }
        throw error;
      }
    } else if (!context || !this.sessionRuntime) {
      enhancedMessage = await this.processAtMentionsForContent(message);
    }

    if (context) {
      let currentMessage = enhancedMessage;
      let currentContext = context;
      let pendingInputOnly = requestedPendingInputOnly;
      let goalContinuation = requestedGoalContinuationOnly;
      let currentOutputSchema = goalContinuation ? undefined : requestedOutputSchema;
      let currentGoal = initialGoal;
      let inputMessageId: string | undefined;
      let turnHandle: ActiveTurnHandle | undefined;
      if (this.sessionRuntime) {
        if (goalContinuation) {
          turnHandle = await this.sessionRuntime.beginTurn('goal');
        } else if (pendingInputOnly) {
          turnHandle = await this.sessionRuntime.beginPendingTurn();
        } else {
          const prepared = preparedInputTurn as PreparedInputTurn;
          turnHandle = prepared.handle;
          if (prepared.mode === 'pending') {
            pendingInputOnly = true;
            currentMessage = '';
          } else {
            inputMessageId = prepared.messageId;
          }
        }
      }
      let chainedFollowUps = 0;

      if (pendingInputOnly && this.sessionRuntime && !turnHandle) {
        return {
          success: true,
          finalMessage: '',
          metadata: { turnsCount: 0, toolCallsCount: 0, duration: 0 },
        };
      }
      const pendingMessagesForEvent = () =>
        this.sessionRuntime!.getPendingSteeringMessages().map((pending) => ({
          ...pending,
          persisted:
            pending.persisted === true ||
            currentContext.messages.some((message) => {
              const metadata = message.metadata;
              return (
                metadata !== null &&
                typeof metadata === 'object' &&
                !Array.isArray(metadata) &&
                metadata.inboxMessageId === pending.id
              );
            }),
        }));
      const pendingOutputSchema = () => {
        const schemas = this.sessionRuntime!.getPendingSteeringMessages().flatMap(
          (pending) => (pending.outputSchema ? [pending.outputSchema] : [])
        );
        if (schemas.length <= 1) return schemas[0];
        const first = JSON.stringify(schemas[0]);
        if (schemas.some((schema) => JSON.stringify(schema) !== first)) {
          throw new Error(
            'Queued inputs contain conflicting structured output schemas'
          );
        }
        return schemas[0];
      };
      if (pendingInputOnly && this.sessionRuntime) {
        currentOutputSchema = pendingOutputSchema();
      }
      const enhancePendingMessages = async (
        messages: SteeringMessage[]
      ): Promise<SteeringMessage[]> =>
        Promise.all(
          messages.map(async (pending) =>
            pending.origin === 'background_subagent'
              ? pending
              : {
                  ...pending,
                  content: await this.processAtMentionsForContent(pending.content),
                }
          )
        );

      try {
        if (pendingInputOnly && this.sessionRuntime) {
          yield {
            kind: 'follow_up_started',
            queued: this.sessionRuntime.getPendingSteeringCount(),
            recovered: this.sessionRuntime.getRecoveredSteeringCount(),
            messages: pendingMessagesForEvent(),
          };
        }
        if (goalContinuation && currentGoal) {
          yield {
            kind: 'goal_continuation_started',
            goal: currentGoal,
            continuation: currentGoal.continuationCount,
          };
          yield { kind: 'goal_updated', goal: currentGoal };
        }

        while (true) {
          const ownedHandle = turnHandle;
          const persistedGoal =
            currentGoal ?? (await this.sessionRuntime?.getGoal()) ?? null;
          const loopOptions: LoopOptions = {
            ...options,
            pendingInputOnly,
            goalContinuationOnly: undefined,
            preparedInputTurn: undefined,
            inputMessageId: pendingInputOnly ? undefined : inputMessageId,
            transientInput: goalContinuation ? 'goal_continuation' : undefined,
            outputSchema: goalContinuation ? undefined : currentOutputSchema,
            ...(this.sessionRuntime
              ? {
                  goalLifecycle: {
                    snapshot: persistedGoal,
                    getSnapshot: () => this.sessionRuntime!.getGoal(),
                    recordVerification: (verification) =>
                      this.sessionRuntime!.recordGoalCompletionVerification(
                        verification
                      ),
                    invalidateVerification: (reason) =>
                      this.sessionRuntime!.invalidateGoalCompletionVerification(reason),
                    finalizeCompletion: () =>
                      this.sessionRuntime!.finalizeVerifiedGoalCompletion(),
                  },
                }
              : {}),
            signal: currentContext.signal,
            turnSteering:
              this.sessionRuntime && ownedHandle
                ? {
                    drain: async () =>
                      enhancePendingMessages(
                        await this.sessionRuntime!.drainSteering(ownedHandle)
                      ),
                    drainOrSeal: async () => {
                      const result =
                        await this.sessionRuntime!.drainSteeringOrSeal(ownedHandle);
                      return {
                        ...result,
                        messages: await enhancePendingMessages(result.messages),
                      };
                    },
                  }
                : undefined,
            turnFinalization:
              this.sessionRuntime && ownedHandle
                ? {
                    turnId: ownedHandle.id,
                    getInputMessageIds: () =>
                      this.sessionRuntime!.getClaimedTurnMessageIds(ownedHandle),
                  }
                : undefined,
            getRecoveredEmptyFinalState:
              this.sessionRuntime && ownedHandle
                ? () => this.sessionRuntime!.getRecoveredEmptyFinalState(ownedHandle)
                : undefined,
          };

          // 选择对应模式的 generator
          let result: LoopResult;
          if (currentContext.permissionMode === 'plan') {
            result = yield* this.runPlanLoop(
              currentMessage,
              currentContext,
              loopOptions
            );
          } else {
            result = yield* this.runLoop(currentMessage, currentContext, loopOptions);
          }

          // Plan 模式批准后切换模式并重新执行
          if (
            result.success &&
            result.metadata?.targetMode &&
            currentContext.permissionMode === 'plan'
          ) {
            const targetMode = result.metadata.targetMode as PermissionMode;
            const planContent = result.metadata.planContent as string | undefined;
            logger.debug(`Plan 模式已批准，切换到 ${targetMode} 模式并重新执行`);

            if (this.sessionRuntime && currentContext.sessionId) {
              await SessionService.setSessionPermissionMode(
                currentContext.sessionId,
                this.sessionRuntime.workspaceRoot,
                targetMode
              );
            }
            await currentContext.onPermissionModeChange?.(targetMode);

            currentContext = {
              ...currentContext,
              permissionMode: targetMode,
            };
            let messageWithPlan: UserMessageContent = currentMessage;
            if (planContent) {
              const planSuffix = `\n\n<approved-plan>\n${planContent}\n</approved-plan>\n\nIMPORTANT: Execute according to the approved plan above. Follow the steps exactly as specified.`;
              if (typeof currentMessage === 'string') {
                messageWithPlan = currentMessage + planSuffix;
              } else {
                messageWithPlan = [
                  ...currentMessage,
                  { type: 'text', text: planSuffix },
                ];
              }
            }

            result = yield* this.runLoop(messageWithPlan, currentContext, {
              ...loopOptions,
              inputMessageId: undefined,
            });
          }

          if (!this.sessionRuntime || !ownedHandle) {
            return result;
          }

          let goal = await this.sessionRuntime.recordGoalProgress({
            tokens: result.metadata?.tokensUsed ?? 0,
            elapsedMs: result.metadata?.duration ?? 0,
          });
          if (goal) {
            yield { kind: 'goal_updated', goal };
          }
          if (!result.success || currentContext.signal?.aborted) {
            goal = await this.sessionRuntime.pauseActiveGoal(
              currentContext.signal?.aborted
                ? 'goal paused after user cancellation'
                : (result.error?.message ?? 'goal paused after turn failure')
            );
            if (goal) {
              yield { kind: 'goal_updated', goal };
            }
          }
          if (
            result.success &&
            !currentContext.signal?.aborted &&
            chainedFollowUps < 20
          ) {
            await this.sessionRuntime.waitForBackgroundSubagentFollowUp(
              ownedHandle,
              currentContext.signal
            );
          }
          const continuePending =
            result.success && !currentContext.signal?.aborted && chainedFollowUps < 20;
          const acknowledgeRejectedInput = isTerminalProviderAdmissionRejection(result);
          turnHandle = await this.sessionRuntime.finishTurn(ownedHandle, {
            continuePending,
            ...(acknowledgeRejectedInput ? { acknowledgeInput: true } : {}),
            outcome:
              result.success && !currentContext.signal?.aborted
                ? {
                    status: 'completed',
                    turnsCount: result.metadata?.turnsCount ?? 0,
                    toolCallsCount: result.metadata?.toolCallsCount ?? 0,
                    durationMs: result.metadata?.duration ?? 0,
                  }
                : {
                    status: 'aborted',
                    cause: currentContext.signal?.aborted ? 'cancelled' : 'failed',
                    turnsCount: result.metadata?.turnsCount ?? 0,
                    toolCallsCount: result.metadata?.toolCallsCount ?? 0,
                    durationMs: result.metadata?.duration ?? 0,
                  },
          });
          if (turnHandle) {
            chainedFollowUps++;
            pendingInputOnly = true;
            goalContinuation = false;
            currentGoal = null;
            currentMessage = '';
            inputMessageId = undefined;
            currentOutputSchema = pendingOutputSchema();
            yield {
              kind: 'follow_up_started',
              queued: this.sessionRuntime.getPendingSteeringCount(),
              recovered: this.sessionRuntime.getRecoveredSteeringCount(),
              messages: pendingMessagesForEvent(),
            };
            continue;
          }

          if (!result.success || currentContext.signal?.aborted) {
            return result;
          }
          goal = await this.sessionRuntime.getGoal();
          if (!goal || (goal.status !== 'active' && goal.status !== 'verifying')) {
            return result;
          }

          currentGoal = await this.sessionRuntime.beginGoalContinuation();
          if (!currentGoal) {
            return result;
          }
          turnHandle = await this.sessionRuntime.beginTurn('goal');
          pendingInputOnly = false;
          goalContinuation = true;
          currentMessage = buildGoalContinuationPrompt(currentGoal);
          inputMessageId = undefined;
          currentOutputSchema = undefined;
          yield {
            kind: 'goal_continuation_started',
            goal: currentGoal,
            continuation: currentGoal.continuationCount,
          };
          yield { kind: 'goal_updated', goal: currentGoal };
        }
      } finally {
        if (this.sessionRuntime && turnHandle) {
          await this.sessionRuntime.finishTurn(turnHandle);
        }
      }
    }

    // 无 context 的简单流程
    const textPrompt =
      typeof enhancedMessage === 'string'
        ? enhancedMessage
        : enhancedMessage
            .filter((p) => p.type === 'text')
            .map((p) => (p as { text: string }).text)
            .join('\n');

    const task: AgentTask = {
      id: this.generateTaskId(),
      type: 'simple',
      prompt: textPrompt,
    };

    const response = await this.executeTask(task);
    return {
      success: true,
      finalMessage: response.content,
      metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
    };
  }

  /**
   * 高层 API：发送消息并等待最终结果。
   * 不暴露事件流，内部消费 chatStream() 并返回 LoopResult。
   * 事件流消费请使用 chatStream()。
   */
  public async chat(
    message: UserMessageContent,
    context?: ChatContext,
    options?: LoopOptions
  ): Promise<LoopResult> {
    const { drainLoop } = await import('./loop/index.js');
    return drainLoop(this.chatStream(message, context, options));
  }

  /**
   * 运行 Plan 模式循环 - 专门处理 Plan 模式的逻辑
   * Plan 模式特点：只读调研、系统化研究方法论、最终输出实现计划
   */
  /**
   * Plan 模式入口 - 准备 Plan 专用配置后调用通用循环
   */
  private async *runPlanLoop(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions
  ): AsyncGenerator<import('./loop/types.js').LoopEvent, LoopResult, void> {
    logger.debug('Processing Plan mode message...');

    // Plan 模式差异 1: 使用统一入口构建 Plan 模式系统提示词
    const { prompt: systemPrompt } = await buildSystemPrompt({
      projectPath: context.workspaceRoot || getCwd(),
      mode: PermissionMode.PLAN,
      includeEnvironment: true,
      environmentOptions: CACHE_STABLE_ENVIRONMENT_OPTIONS,
      language: this.config.language,
      availableSkills: this.agentResources?.skills.generateAvailableSkillsList(),
      communicationStyle:
        this.sessionRuntime?.getCommunicationStyleConfiguration().selection,
      communicationStyleCatalog: this.sessionRuntime?.getCommunicationStyleCatalog(),
      projectRuleCatalog: this.sessionRuntime?.getProjectRuleCatalog(),
      projectInstructionSourcePath: this.sessionRuntime?.projectRoot,
    });

    // Plan 模式差异 2: 在用户消息中注入 system-reminder
    // 处理多模态消息：提取文本部分添加 reminder
    let messageWithReminder: UserMessageContent;
    if (typeof message === 'string') {
      messageWithReminder = createPlanModeReminder(message);
    } else {
      // 多模态消息：在第一个文本部分前添加 reminder，或创建新的文本部分
      const textParts = message.filter((p) => p.type === 'text');
      if (textParts.length > 0) {
        const firstTextPart = textParts[0] as { type: 'text'; text: string };
        messageWithReminder = message.map((p) =>
          p === firstTextPart
            ? {
                type: 'text' as const,
                text: createPlanModeReminder(firstTextPart.text),
              }
            : p
        );
      } else {
        // 仅图片，添加空的 reminder
        messageWithReminder = [
          { type: 'text', text: createPlanModeReminder('') },
          ...message,
        ];
      }
    }

    // 调用通用循环，传入 Plan 模式专用配置
    // 注意：不再传递 isPlanMode 参数，executeLoop 会从 context.permissionMode 读取
    return yield* this.executeLoop(messageWithReminder, context, options, systemPrompt);
  }

  /**
   * 普通模式入口 - 准备普通模式配置后调用通用循环
   */
  private async *runLoop(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions
  ): AsyncGenerator<import('./loop/types.js').LoopEvent, LoopResult, void> {
    logger.debug('Processing enhanced chat message...');

    // 无状态设计：优先使用 context.systemPrompt，否则按需构建
    const systemPrompt =
      context.systemPrompt ??
      (await this.buildSystemPromptOnDemand(context.workspaceRoot || getCwd()));

    return yield* this.executeLoop(message, context, options, systemPrompt);
  }

  /**
   * 按需构建系统提示词（用于未传入 context.systemPrompt 的场景）
   */
  private async buildSystemPromptOnDemand(projectPath: string): Promise<string> {
    const replacePrompt = this.runtimeOptions.systemPrompt;
    const appendPrompt = this.runtimeOptions.appendSystemPrompt;

    const result = await buildSystemPrompt({
      projectPath,
      replaceDefault: replacePrompt,
      append: appendPrompt,
      includeEnvironment: true,
      environmentOptions: CACHE_STABLE_ENVIRONMENT_OPTIONS,
      language: this.config.language,
      availableSkills: this.agentResources?.skills.generateAvailableSkillsList(),
      communicationStyle:
        this.sessionRuntime?.getCommunicationStyleConfiguration().selection,
      communicationStyleCatalog: this.sessionRuntime?.getCommunicationStyleCatalog(),
      projectRuleCatalog: this.sessionRuntime?.getProjectRuleCatalog(),
      projectInstructionSourcePath: this.sessionRuntime?.projectRoot,
    });

    return result.prompt;
  }

  /**
   * 核心执行循环 — 返回 AsyncGenerator 事件流
   */
  private executeLoop(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions,
    systemPrompt?: string
  ): AsyncGenerator<import('./loop/types.js').LoopEvent, LoopResult, void> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }
    const deps = this.buildLoopDependencies();
    return executeLoopGenerator(deps, message, context, options, systemPrompt);
  }

  private takeStartupAdoptedToolResultEvents(): LoopEvent[] {
    const adoptedResults = this.sessionRuntime?.takeStartupAdoptedToolResults() ?? [];
    return adoptedResults.flatMap(({ call, result }) => {
      const toolCall: FunctionToolCallRef = {
        id: call.toolCallId,
        type: 'function',
        function: {
          name: call.toolName,
          arguments: JSON.stringify(call.input),
        },
      };
      const metadata =
        result.metadata &&
        typeof result.metadata === 'object' &&
        !Array.isArray(result.metadata)
          ? (result.metadata as ToolResult['metadata'])
          : undefined;
      const success = result.error === undefined;
      const output = result.output;
      const toolResult: ToolResult = {
        success,
        llmContent:
          typeof output === 'string' || (output !== null && typeof output === 'object')
            ? output
            : output === null
              ? result.error
                ? `Subagent execution failed: ${result.error}.`
                : ''
              : String(output),
        ...(result.error
          ? {
              error: {
                type: ToolErrorType.EXECUTION_ERROR,
                message: result.error,
              },
            }
          : {}),
        ...(metadata ? { metadata } : {}),
      };
      const events: LoopEvent[] = [
        {
          kind: 'tool_result',
          toolCall,
          result: toolResult,
        },
      ];
      const lifecycle = handleSubagentLifecycle(toolCall, toolResult);
      if (lifecycle) events.push(lifecycle);
      return events;
    });
  }

  /**
   * 构建 LoopDependencies（从 Agent 实例注入到 generator）
   */
  private buildLoopDependencies(): import('./loop/types.js').LoopDependencies {
    return {
      chatService: this.chatService,
      toolExecutor: this.toolExecutor,
      executionEngine: this.executionEngine,
      config: this.config,
      runtimeOptions: this.runtimeOptions,
      currentModelMaxContextTokens: this.currentModelMaxContextTokens,
      activeSkillContext: this.activeSkillContext,
      onSkillActivated: (ctx) => {
        this.activeSkillContext = ctx;
        logger.debug(
          `Skill "${ctx.skillName}" activated` +
            (ctx.allowedTools
              ? ` with allowed tools: ${ctx.allowedTools.join(', ')}`
              : '')
        );
      },
      onModelSwitch: (modelId) => this.switchModelIfNeeded(modelId),
      applySkillToolRestrictions: (tools) => this.applySkillToolRestrictions(tools),
      staticProjectRules: this.sessionRuntime?.getStaticProjectRules(),
      hydrateProjectRules: this.sessionRuntime
        ? (references) => this.sessionRuntime!.hydrateProjectRules(references)
        : undefined,
      resolveContextualProjectRules: this.sessionRuntime
        ? (toolName, params, result, loadedIds) =>
            this.sessionRuntime!.resolveContextualProjectRules(
              toolName,
              params,
              result,
              loadedIds
            )
        : undefined,
    };
  }

  /**
   * 带系统提示的聊天接口
   */
  public async chatWithSystem(systemPrompt: string, message: string): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ];
    const response = await this.chatService.chat(messages);

    return response.content;
  }

  /**
   * 获取当前活动任务
   */
  public getActiveTask(): AgentTask | undefined {
    return this.activeTask;
  }

  /**
   * 获取Chat服务
   */
  public getChatService(): IChatService {
    return this.chatService;
  }

  /**
   * 获取上下文管理器 - 返回执行引擎的上下文管理功能
   */
  public getContextManager(): ContextManager | undefined {
    return this.executionEngine?.getContextManager();
  }

  /**
   * 获取Agent状态统计
   */
  public getStats(): Record<string, unknown> {
    return {
      initialized: this.isInitialized,
      activeTask: this.activeTask?.id,
      components: {
        chatService: this.chatService ? 'ready' : 'not_loaded',
        executionEngine: this.executionEngine ? 'ready' : 'not_loaded',
      },
    };
  }

  /**
   * 获取可用工具列表
   */
  public getAvailableTools(): Tool[] {
    return this.toolExecutor ? this.toolExecutor.getRegistry().getAll() : [];
  }

  /**
   * 获取工具注册表（用于子 Agent 工具隔离）
   */
  public getToolRegistry(): ToolRegistry {
    return this.toolExecutor.getRegistry();
  }

  /**
   * 应用工具白名单（仅保留指定工具）
   */
  public applyToolWhitelist(whitelist: string[]): void {
    const registry = this.toolExecutor.getRegistry();
    const allTools = registry.getAll();

    const toolsToRemove = allTools.filter((tool) => !whitelist.includes(tool.name));

    for (const tool of toolsToRemove) {
      registry.unregister(tool.name);
    }

    logger.debug(
      `Applied tool whitelist: ${whitelist.join(', ')} (removed ${toolsToRemove.length} tools)`
    );
  }

  public applyToolBlacklist(blacklist: string[]): void {
    const registry = this.toolExecutor.getRegistry();
    const blacklistSet = new Set(blacklist);

    for (const tool of registry.getAll()) {
      if (blacklistSet.has(tool.name)) {
        registry.unregister(tool.name);
      }
    }

    logger.debug(`Applied tool blacklist: ${blacklist.join(', ')}`);
  }

  /**
   * 获取工具统计信息
   */
  public getToolStats() {
    const tools = this.getAvailableTools();
    const toolsByKind = new Map<string, number>();

    tools.forEach((tool) => {
      const count = toolsByKind.get(tool.kind) || 0;
      toolsByKind.set(tool.kind, count + 1);
    });

    return {
      totalTools: tools.length,
      toolsByKind: Object.fromEntries(toolsByKind),
      toolNames: tools.map((t) => t.name),
    };
  }

  /**
   * 销毁Agent
   */
  public async destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;

    this.destroyPromise = (async () => {
      this.log('销毁Agent...');
      await this.activeOperations.shutdown('agent-destroy');

      try {
        await this.legacyMcpRegistry?.disconnectAll();
        this.legacyMcpRegistry = undefined;
        this.log('Agent已销毁');
      } catch (error) {
        this.error('Agent销毁失败', error);
        throw error;
      } finally {
        this.toolExecutor.dispose();
        this.isInitialized = false;
      }
    })();
    return this.destroyPromise;
  }

  private syncRuntimeState(): void {
    if (!this.sessionRuntime) {
      return;
    }

    this.chatService = this.sessionRuntime.getChatService();
    this.executionEngine = this.sessionRuntime.getExecutionEngine();
    this.attachmentCollector = this.sessionRuntime.getAttachmentCollector();
    this.currentModelId = this.sessionRuntime.getCurrentModelId();
    this.currentModelMaxContextTokens =
      this.sessionRuntime.getCurrentModelMaxContextTokens();
  }

  /**
   * 生成任务ID
   */
  private generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * 日志记录
   */
  private log(message: string, data?: unknown): void {
    logger.debug(`[MainAgent] ${message}`, data || '');
  }

  /**
   * 错误记录
   */
  private error(message: string, error?: unknown): void {
    logger.error(`[MainAgent] ${message}`, error || '');
  }

  /**
   * 初始化系统提示（无状态设计：仅验证配置，不存储状态）
   * 实际的 systemPrompt 在每次请求时通过 context.systemPrompt 传入或按需构建
   */
  private async initializeSystemPrompt(): Promise<void> {
    try {
      // 验证系统提示配置是否有效（预热构建，但不存储结果）
      const replacePrompt = this.runtimeOptions.systemPrompt;
      const appendPrompt = this.runtimeOptions.appendSystemPrompt;

      const result = await buildSystemPrompt({
        projectPath: this.sessionRuntime?.workspaceRoot ?? getCwd(),
        replaceDefault: replacePrompt,
        append: appendPrompt,
        includeEnvironment: false,
        language: this.config.language,
        availableSkills: this.agentResources?.skills.generateAvailableSkillsList(),
        communicationStyle:
          this.sessionRuntime?.getCommunicationStyleConfiguration().selection,
        communicationStyleCatalog: this.sessionRuntime?.getCommunicationStyleCatalog(),
        projectRuleCatalog: this.sessionRuntime?.getProjectRuleCatalog(),
        projectInstructionSourcePath: this.sessionRuntime?.projectRoot,
      });

      if (result.prompt) {
        this.log('系统提示配置验证成功');
        logger.debug(
          `[SystemPrompt] 可用来源: ${result.sources
            .filter((s) => s.loaded)
            .map((s) => s.name)
            .join(', ')}`
        );
      }
    } catch (error) {
      this.error('系统提示配置验证失败', error);
      // 系统提示失败不应该阻止 Agent 初始化
    }
  }

  /**
   * 注册内置工具
   */
  private async registerBuiltinTools(): Promise<void> {
    try {
      // 使用默认 sessionId（因为注册时还没有会话上下文）
      const builtinTools = await getBuiltinTools({
        sessionId: 'default',
        configDir: getBladeStorageRoot(),
        workspaceRoot: getCwd(),
        resourceRoot: getCwd(),
        agentResources: this.agentResources,
      });
      logger.debug(`Registering ${builtinTools.length} builtin tools...`);

      this.toolExecutor.getRegistry().registerAll(builtinTools);

      const registeredCount = this.toolExecutor.getRegistry().getAll().length;
      logger.debug(`Builtin tools registered: ${registeredCount} tools`);
      logger.debug(
        `[Tools] ${this.toolExecutor
          .getRegistry()
          .getAll()
          .map((t) => t.name)
          .join(', ')}`
      );

      // 注册 MCP 工具
      await this.registerMcpTools();
    } catch (error) {
      logger.error('Failed to register builtin tools:', error);
      throw error;
    }
  }

  /**
   * 注册 MCP 工具
   */
  private async registerMcpTools(): Promise<void> {
    try {
      const mcpServers = await resolveWorkspaceMcpConfig({
        workspaceRoot: getCwd(),
        storeServers: this.config.mcpServers ?? {},
        cliConfigs: this.runtimeOptions.mcpConfig,
        strictCliConfig: this.runtimeOptions.strictMcpConfig,
      });

      if (Object.keys(mcpServers).length === 0) {
        logger.debug('No MCP servers configured');
        return;
      }

      const registry = McpRegistry.createIsolated({
        artifactWriter: new McpToolArtifactStore(`legacy-${randomUUID()}`),
      });
      this.legacyMcpRegistry = registry;

      for (const [name, config] of Object.entries(mcpServers)) {
        try {
          logger.debug(`Connecting to MCP server: ${name}`);
          await registry.registerServer(name, config);
          logger.debug(`MCP server "${name}" connected`);
        } catch (error) {
          logger.warn(`Warning: MCP server "${name}" connection failed:`, error);
          // 继续处理其他服务器，不抛出错误
        }
      }

      const toolRegistry = this.toolExecutor.getRegistry();
      toolRegistry.setMcpCatalogBarrier(() => registry.waitForCatalogIdle());
      const snapshot = registry.getCatalogSnapshot();
      toolRegistry.replaceMcpTools(snapshot.tools);
      toolRegistry.registerAll(createMcpContentTools(registry));
      const instructions = registry.getInstructionsSnapshot();
      toolRegistry.queueMcpInstructionsChange({
        revision: instructions.revision,
        reason: 'snapshot',
        replace: true,
        instructions: instructions.instructions,
        removed: [],
      });
      registry.on('catalogChanged', (change) => {
        toolRegistry.replaceMcpTools(change.tools, change);
      });
      registry.on('contentCatalogChanged', (change) => {
        toolRegistry.queueMcpContentChange(change);
      });
      registry.on('resourceUpdated', (update) => {
        toolRegistry.queueMcpResourceUpdated(update);
      });
      registry.on('connectionLifecycleChanged', (change) => {
        toolRegistry.queueMcpConnectionChange(change);
      });
      registry.on('log', (entry) => {
        toolRegistry.queueMcpLog(entry);
      });
      registry.on('instructionsChanged', (change) => {
        toolRegistry.queueMcpInstructionsChange({
          revision: change.revision,
          reason: change.reason,
          replace: false,
          instructions:
            change.action === 'added' && change.instruction
              ? [
                  {
                    serverName: change.serverName,
                    ...change.instruction,
                  },
                ]
              : [],
          removed: change.action === 'removed' ? [change.serverName] : [],
        });
      });
      if (snapshot.tools.length > 0) {
        logger.debug(`Registered ${snapshot.tools.length} MCP tools`);
        logger.debug(
          `[MCP Tools] ${snapshot.tools.map((tool) => tool.name).join(', ')}`
        );
      }
    } catch (error) {
      logger.warn('Failed to register MCP tools:', error);
      // 不抛出错误，允许 Agent 继续初始化
    }
  }

  /**
   * 加载 subagent 配置
   */
  private async loadSubagents(): Promise<void> {
    const resources = await resolveWorkspaceAgentResources(getCwd());
    this.agentResources = snapshotWorkspaceAgentResources(resources);
    this.subagentRegistry = this.agentResources.subagents;
    if (this.runtimeOptions.agents?.length) {
      this.subagentRegistry.applyOverrides(this.runtimeOptions.agents);
    }
    const loadedCount = this.subagentRegistry.getAllNames().length;
    if (loadedCount > 0) {
      logger.debug(
        `Loaded ${loadedCount} subagents: ${this.subagentRegistry.getAllNames().join(', ')}`
      );
    } else {
      logger.debug('No subagents configured');
    }
  }

  /**
   * 应用 Skill 的 allowed-tools 限制
   * 如果有活动的 Skill 且定义了 allowed-tools，则过滤可用工具列表
   *
   * @param tools - 原始工具列表
   * @returns 过滤后的工具列表
   */
  private applySkillToolRestrictions(
    tools: import('../tools/types/index.js').FunctionDeclaration[]
  ): import('../tools/types/index.js').FunctionDeclaration[] {
    // 如果没有活动的 Skill，或者 Skill 没有定义 allowed-tools，返回原始工具列表
    if (!this.activeSkillContext?.allowedTools) {
      return tools;
    }

    const allowedTools = this.activeSkillContext.allowedTools;
    logger.debug(`Applying Skill tool restrictions: ${allowedTools.join(', ')}`);

    // 过滤工具列表，只保留 allowed-tools 中指定的工具
    const filteredTools = tools.filter((tool) => {
      // 检查工具名称是否在 allowed-tools 列表中
      // 支持精确匹配和通配符模式（如 Bash(git:*)）
      return allowedTools.some((allowed) => {
        // 精确匹配
        if (allowed === tool.name) {
          return true;
        }

        // 通配符匹配：Bash(git:*) 匹配 Bash
        const match = allowed.match(/^(\w+)\(.*\)$/);
        if (match && match[1] === tool.name) {
          return true;
        }

        return false;
      });
    });

    logger.debug(
      `Filtered tools: ${filteredTools.map((t) => t.name).join(', ')} (${filteredTools.length}/${tools.length})`
    );

    return filteredTools;
  }

  /**
   * 清除 Skill 执行上下文
   * 当 Skill 执行完成或需要重置时调用
   */
  public clearSkillContext(): void {
    if (this.activeSkillContext) {
      logger.debug(`Skill "${this.activeSkillContext.skillName}" deactivated`);
      this.activeSkillContext = undefined;
    }
  }

  /**
   * 处理 @ 文件提及（支持纯文本和多模态消息）
   * 从用户消息中提取 @ 提及，读取文件内容，并追加到消息
   *
   * @param content - 用户消息内容（纯文本或多模态）
   * @returns 增强后的消息（包含文件内容）
   */
  private async processAtMentionsForContent(
    content: UserMessageContent
  ): Promise<UserMessageContent> {
    if (!this.attachmentCollector) {
      return content;
    }

    // 纯文本消息：直接处理
    if (typeof content === 'string') {
      return this.processAtMentions(content);
    }

    // 多模态消息：提取所有文本部分，合并后处理 @ 提及
    const textParts: string[] = [];

    for (const part of content) {
      if (part.type === 'text') {
        textParts.push(part.text);
      }
    }

    // 没有文本部分，直接返回
    if (textParts.length === 0) {
      return content;
    }

    // 合并所有文本进行 @ 提及收集
    const combinedText = textParts.join('\n');

    try {
      const attachments = await this.attachmentCollector.collect(combinedText);

      if (attachments.length === 0) {
        return content;
      }

      logger.debug(
        `Processed ${attachments.length} @ file mentions in multimodal message`
      );

      // 构建附件内容块
      const attachmentText = this.buildAttachmentText(attachments);

      if (!attachmentText) {
        return content;
      }

      // 将附件内容作为新的文本 part 追加到末尾（保留原始图文顺序）
      const result: ContentPart[] = [
        ...content,
        { type: 'text', text: attachmentText },
      ];

      return result;
    } catch (error) {
      logger.error('Failed to process @ mentions in multimodal message:', error);
      return content;
    }
  }

  /**
   * 构建附件文本块（供 processAtMentionsForContent 使用）
   */
  private buildAttachmentText(attachments: Attachment[]): string {
    const contextBlocks: string[] = [];
    const errors: string[] = [];

    for (const att of attachments) {
      if (att.type === 'file') {
        const lineInfo = att.metadata?.lineRange
          ? ` (lines ${att.metadata.lineRange.start}${att.metadata.lineRange.end ? `-${att.metadata.lineRange.end}` : ''})`
          : '';

        contextBlocks.push(
          `<file path="${att.path}"${lineInfo ? ` range="${lineInfo}"` : ''}>`,
          att.content,
          '</file>'
        );
      } else if (att.type === 'directory') {
        contextBlocks.push(
          `<directory path="${att.path}">`,
          att.content,
          '</directory>'
        );
      } else if (att.type === 'error') {
        errors.push(`- @${att.path}: ${att.error}`);
      }
    }

    let result = '';

    if (contextBlocks.length > 0) {
      result += '\n\n<system-reminder>\n';
      result += 'The following files were mentioned with @ syntax:\n\n';
      result += contextBlocks.join('\n');
      result += '\n</system-reminder>';
    }

    if (errors.length > 0) {
      result += '\n\nWarning: Some files could not be loaded:\n';
      result += errors.join('\n');
    }

    return result;
  }

  /**
   * 处理 @ 文件提及
   * 从用户消息中提取 @ 提及，读取文件内容，并追加到消息
   *
   * @param message - 原始用户消息
   * @returns 增强后的消息（包含文件内容）
   */
  private async processAtMentions(message: string): Promise<string> {
    if (!this.attachmentCollector) {
      return message;
    }

    try {
      const attachments = await this.attachmentCollector.collect(message);

      if (attachments.length === 0) {
        return message;
      }

      logger.debug(`Processed ${attachments.length} @ file mentions`);

      return this.appendAttachments(message, attachments);
    } catch (error) {
      logger.error('Failed to process @ mentions:', error);
      // 失败时返回原始消息，不中断流程
      return message;
    }
  }

  /**
   * 将附件追加到用户消息
   *
   * @param message - 原始消息
   * @param attachments - 附件数组
   * @returns 包含附件的完整消息
   */
  private appendAttachments(message: string, attachments: Attachment[]): string {
    const contextBlocks: string[] = [];
    const errors: string[] = [];

    for (const att of attachments) {
      if (att.type === 'file') {
        const lineInfo = att.metadata?.lineRange
          ? ` (lines ${att.metadata.lineRange.start}${att.metadata.lineRange.end ? `-${att.metadata.lineRange.end}` : ''})`
          : '';

        contextBlocks.push(
          `<file path="${att.path}"${lineInfo ? ` range="${lineInfo}"` : ''}>`,
          att.content,
          '</file>'
        );
      } else if (att.type === 'directory') {
        contextBlocks.push(
          `<directory path="${att.path}">`,
          att.content,
          '</directory>'
        );
      } else if (att.type === 'error') {
        errors.push(`- @${att.path}: ${att.error}`);
      }
    }

    let enhancedMessage = message;

    // 追加文件内容
    if (contextBlocks.length > 0) {
      enhancedMessage += '\n\n<system-reminder>\n';
      enhancedMessage += 'The following files were mentioned with @ syntax:\n\n';
      enhancedMessage += contextBlocks.join('\n');
      enhancedMessage += '\n</system-reminder>';
    }

    // 追加错误信息
    if (errors.length > 0) {
      enhancedMessage += '\n\nWarning: Some files could not be loaded:\n';
      enhancedMessage += errors.join('\n');
    }

    return enhancedMessage;
  }
}

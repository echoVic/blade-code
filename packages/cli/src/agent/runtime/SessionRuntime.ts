import { stat } from 'node:fs/promises';
import { Mutex } from 'async-mutex';
import { nanoid } from 'nanoid';
import * as path from 'path';
import { isAcpMode } from '../../acp/AcpServiceContext.js';
import {
  type BladeConfig,
  ConfigManager,
  type PermissionConfig,
  PermissionMode,
} from '../../config/index.js';
import { normalizeRuntimeEnvironment } from '../../config/runtimeEnvironment.js';
import type {
  CommunicationStyleSelection,
  McpServerConfig,
  ModelConfig,
  ReasoningEffortSelection,
  ResponseVerbositySelection,
  ServiceTierSelection,
} from '../../config/types.js';
import { ForegroundProcessLeaseStore } from '../../context/storage/ForegroundProcessLeaseStore.js';
import type {
  SessionAdoptedToolResult,
  SessionInterruptedToolCall,
  SessionTurnRecovery,
} from '../../context/storage/PersistentStore.js';
import {
  getBladeStorageRoot,
  getSessionInboxFilePath,
} from '../../context/storage/pathUtils.js';
import { toTaskFailure } from '../../context/taskFailure.js';
import type {
  MessagePersistenceMetadata,
  SessionTaskDiffStat,
  SessionTaskFailure,
  SessionTaskIsolation,
  SessionTaskStatus,
  SessionTaskWorktree,
  SessionTurnAbortCause,
  SessionTurnFinalizationInfo,
  SessionTurnKind,
  SessionTurnMetrics,
} from '../../context/types.js';
import { GoalStore } from '../../goals/GoalStore.js';
import type {
  GoalCompletionVerificationResult,
  GoalCreateInput,
  GoalProgress,
  GoalSnapshot,
} from '../../goals/types.js';
import { HookManager } from '../../hooks/HookManager.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { LspSessionManager } from '../../lsp/LspSessionManager.js';
import {
  resolveWorkspaceLspResources,
  type SessionLspResources,
  snapshotWorkspaceLspResources,
} from '../../lsp/WorkspaceLspResources.js';
import type {
  McpCompletionInput,
  McpNormalizedCompletionResult,
} from '../../mcp/McpCompletion.js';
import type { McpNormalizedPromptResult } from '../../mcp/McpContentCatalog.js';
import type { McpLogLevel } from '../../mcp/McpLogging.js';
import {
  type McpCatalogChange,
  type McpConnectionLifecycleChange,
  type McpContentCatalogChange,
  type McpInstructionsChange,
  type McpInstructionsSnapshot,
  type McpLogEntry,
  type McpLogSnapshot,
  type McpRegisteredPrompt,
  type McpRegisteredResource,
  type McpRegisteredResourceTemplate,
  McpRegistry,
  type McpResourceUpdated,
} from '../../mcp/McpRegistry.js';
import {
  finalizeMcpSamplingResponse,
  type McpSamplingHandler,
} from '../../mcp/McpSampling.js';
import { McpTaskManager } from '../../mcp/McpTaskManager.js';
import type { McpTaskChange, McpTaskSnapshot } from '../../mcp/McpTasks.js';
import { McpToolArtifactStore } from '../../mcp/McpToolArtifactStore.js';
import { resolveWorkspaceMcpConfig } from '../../mcp/resolveWorkspaceMcpConfig.js';
import { buildSystemPrompt } from '../../prompts/index.js';
import { AttachmentCollector } from '../../prompts/processors/AttachmentCollector.js';
import { Bus } from '../../server/bus.js';
import {
  createChatServiceAsync,
  type IChatService,
  type Message,
} from '../../services/ChatServiceInterface.js';
import {
  BUILTIN_COMMUNICATION_STYLE_CATALOG,
  type CommunicationStyleCatalog,
  type CommunicationStyleConfiguration,
  resolveCommunicationStyle,
} from '../../services/communicationStyle.js';
import { getPiModelCatalog, PiModelCatalog } from '../../services/pi/PiModelCatalog.js';
import type { ReasoningEffortConfiguration } from '../../services/pi/reasoningEffort.js';
import { resolveModelConfig as resolvePiModelConfig } from '../../services/pi/resolveModelConfig.js';
import type { ResponseVerbosityConfiguration } from '../../services/pi/responseVerbosity.js';
import type { ServiceTierConfiguration } from '../../services/pi/serviceTier.js';
import {
  type RewindSessionOptions,
  type RewoundSession,
  SessionArchivedError,
  type SessionMetadata,
  SessionMissingCreationError,
  type SessionRewindCheckpoint,
  SessionService,
} from '../../services/SessionService.js';
import {
  runSideConversation,
  type SideConversationResult,
} from '../../services/SideConversationService.js';
import {
  executeUserShellCommand,
  renderUserShellCommandForModel,
  type UserShellCommandEvent,
  type UserShellCommandRecord,
  type UserShellExecutor,
} from '../../services/UserShellCommandService.js';
import type { JsonObject, JsonValue } from '../../store/types.js';
import { ensureStoreInitialized, getConfig } from '../../store/vanilla.js';
import { FileAccessTracker } from '../../tools/builtin/file/FileAccessTracker.js';
import { recoverWorkspacePatchTransactions } from '../../tools/builtin/file/PatchTransactionCoordinator.js';
import { getBuiltinTools } from '../../tools/builtin/index.js';
import {
  createMcpContentTools,
  createMcpTaskTools,
} from '../../tools/builtin/mcp/index.js';
import { BackgroundShellManager } from '../../tools/builtin/shell/BackgroundShellManager.js';
import { AutoVerifyRuntime } from '../../tools/execution/AutoVerify.js';
import { InMemorySessionApprovalStore } from '../../tools/execution/SessionApprovalStore.js';
import { ToolExecutor } from '../../tools/execution/ToolExecutor.js';
import { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import type { Tool, ToolResult } from '../../tools/types/index.js';
import { getCwd } from '../../utils/cwd.js';
import { worktreeManager } from '../../worktree/WorktreeManager.js';
import { ExecutionEngine } from '../ExecutionEngine.js';
import {
  CACHE_STABLE_ENVIRONMENT_OPTIONS,
  composeProviderSystemPrompt,
} from '../loop/providerSystemPrompt.js';
import type { LoopEvent } from '../loop/types.js';
import {
  resolveWorkspaceAgentResources,
  type SessionAgentResources,
  snapshotWorkspaceAgentResources,
} from '../resources/WorkspaceAgentResources.js';
import {
  cloneWorkspaceModelConfig,
  resolveWorkspaceModelResources,
  type SessionModelResources,
  snapshotWorkspaceModelResources,
} from '../resources/WorkspaceModelResources.js';
import {
  ProjectRuleCatalog,
  type ProjectRuleReference,
  type ProjectRuleResolution,
} from '../resources/WorkspaceProjectRules.js';
import {
  type AgentSession,
  AgentSessionStore,
  isAgentSessionOwnedBy,
} from '../subagents/AgentSessionStore.js';
import {
  BackgroundAgentManager,
  type ResumeAgentResult,
} from '../subagents/BackgroundAgentManager.js';
import { buildBackgroundSubagentCompletion } from '../subagents/BackgroundSubagentCompletion.js';
import type { SubagentRegistry } from '../subagents/SubagentRegistry.js';
import { buildSubagentResultAdoption } from '../subagents/SubagentResultAdoption.js';
import type { SubagentConfig } from '../subagents/types.js';
import {
  formatTeamMessage,
  TeamMailbox,
  teamMessageMetadata,
} from '../teams/TeamMailbox.js';
import { TeamStore } from '../teams/TeamStore.js';
import type {
  AgentOptions,
  SubagentInfoForContext,
  UserMessageContent,
} from '../types.js';
import { ActiveOperationGate } from './ActiveOperationGate.js';
import {
  type ActiveTurnHandle,
  ActiveTurnMailbox,
  type InputTurnPreparation,
  type SteeringEnqueueResult,
  type SteeringMessage,
} from './ActiveTurnMailbox.js';
import { SessionInUseError, SessionLease } from './SessionLease.js';
import { type TaskAdmissionSnapshot, taskRunScheduler } from './TaskRunScheduler.js';

const logger = createLogger(LogCategory.AGENT);
const staleWorktreeCleanupRuns = new Map<string, Promise<void>>();

async function cleanupStaleWorktreesOnce(workspaceRoot: string): Promise<void> {
  let cleanup = staleWorktreeCleanupRuns.get(workspaceRoot);
  if (!cleanup) {
    cleanup = (async () => {
      try {
        const result = await worktreeManager.cleanupStaleAgentWorktrees({
          workspaceRoot,
        });
        if (result.removed > 0) {
          logger.info(`[WorktreeGC] removed ${result.removed} stale agent worktree(s)`);
        }
        if (result.errors.length > 0) {
          logger.warn(
            `[WorktreeGC] completed with ${result.errors.length} error(s): ${result.errors.join(
              '; '
            )}`
          );
        }
      } catch (error) {
        logger.warn(
          `[WorktreeGC] cleanup failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    })();
    staleWorktreeCleanupRuns.set(workspaceRoot, cleanup);
  }
  await cleanup;
}

export interface SessionRuntimeOptions {
  sessionId: string;
  workspaceRoot?: string;
  modelId?: string;
  permissionMode?: PermissionMode;
  reasoningEffort?: ReasoningEffortSelection;
  serviceTier?: ServiceTierSelection;
  responseVerbosity?: ResponseVerbositySelection;
  communicationStyle?: CommunicationStyleSelection;
  communicationStyleDigest?: string;
  projectInstructionsDigest?: string;
  mcpConfig?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  strictMcpConfig?: boolean;
  agents?: SubagentConfig[];
  agentResources?: SessionAgentResources;
  modelResources?: SessionModelResources;
  lspResources?: SessionLspResources;
  sessionStart?: {
    isResume: boolean;
    resumeSessionId?: string;
  };
  subagentInfo?: SubagentInfoForContext;
  taskWorktree?: SessionTaskWorktree;
  taskIsolation?: SessionTaskIsolation;
  userShellExecutor?: UserShellExecutor;
}

export type SessionTurnOutcome =
  | ({ status: 'completed' } & SessionTurnMetrics)
  | ({
      status: 'aborted';
      cause: Exclude<SessionTurnAbortCause, 'process_restart'>;
    } & SessionTurnMetrics);

export interface SessionUserShellCommandResult {
  executionId: string;
  messageId: string;
  record: UserShellCommandRecord;
  modelContent: string;
  auxiliary: boolean;
  delivery?: 'current_turn' | 'next_turn';
  queued?: number;
}

export type SessionUserShellCommandEvent =
  | (Extract<UserShellCommandEvent, { type: 'started' | 'output' }> & {
      auxiliary: boolean;
    })
  | {
      type: 'completed';
      executionId: string;
      messageId: string;
      record: UserShellCommandRecord;
      auxiliary: boolean;
      delivery?: 'current_turn' | 'next_turn';
      queued?: number;
    };

export interface ResumeSubagentOptions {
  agentId: string;
  prompt: string;
  onEvent?: (event: LoopEvent, agentId: string) => void | Promise<void>;
  onCompleted?: (session: AgentSession) => void | Promise<void>;
}

export interface ResumedSubagent {
  source: AgentSession;
  session: AgentSession;
}

export interface SessionMcpContentSnapshot {
  revision: number;
  resources: McpRegisteredResource[];
  resourceTemplates: McpRegisteredResourceTemplate[];
  prompts: McpRegisteredPrompt[];
}

export interface RecoveredFinalResponse {
  turnId: string;
  content: string;
  structuredOutput?: JsonObject;
  structuredOutputSchemaDigest?: string;
}

export interface StartupAdoptedToolResult {
  call: SessionInterruptedToolCall;
  result: SessionAdoptedToolResult;
}

function messageTurnFinalization(
  message: Message
): SessionTurnFinalizationInfo | undefined {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  const finalization = metadata.turnFinalization;
  if (
    !finalization ||
    typeof finalization !== 'object' ||
    Array.isArray(finalization)
  ) {
    return undefined;
  }
  return finalization as unknown as SessionTurnFinalizationInfo;
}

export class SessionRuntime {
  private readonly approvalStore = new InMemorySessionApprovalStore();
  private baseRegistry = new ToolRegistry();
  private readonly attachmentCollector: AttachmentCollector;
  private readonly goalStore: GoalStore;
  private activeTurnMailbox?: ActiveTurnMailbox;

  private chatService?: IChatService;
  private executionEngine?: ExecutionEngine;
  private selectedModelId?: string;
  private selectedReasoningEffort: ReasoningEffortSelection;
  private currentReasoning?: ReasoningEffortConfiguration;
  private selectedServiceTier: ServiceTierSelection;
  private currentServiceTier?: ServiceTierConfiguration;
  private selectedResponseVerbosity: ResponseVerbositySelection;
  private currentResponseVerbosity?: ResponseVerbosityConfiguration;
  private selectedCommunicationStyle: CommunicationStyleSelection;
  private currentModelId?: string;
  private currentModelMaxContextTokens?: number;
  private initialized = false;
  private disposing = false;
  private startupTurnRecovery?: SessionTurnRecovery;
  private startupAdoptedToolResults: StartupAdoptedToolResult[] = [];
  private sessionLease?: SessionLease;
  private sessionMcpRegistry?: McpRegistry;
  private mcpCatalogListener?: (change: McpCatalogChange) => void;
  private mcpContentCatalogListener?: (change: McpContentCatalogChange) => void;
  private mcpResourceUpdatedListener?: (update: McpResourceUpdated) => void;
  private mcpConnectionListener?: (change: McpConnectionLifecycleChange) => void;
  private mcpLogListener?: (entry: McpLogEntry) => void;
  private mcpInstructionsListener?: (change: McpInstructionsChange) => void;
  private mcpTaskListener?: (change: McpTaskChange) => void;
  private mcpCatalogBarrier: () => Promise<void> = async () => undefined;
  private readonly executorCatalogs = new Map<
    ToolRegistry,
    {
      allowed: ReadonlySet<string> | null;
      blocked: ReadonlySet<string> | null;
    }
  >();
  private agentResources?: SessionAgentResources;
  private readonly modelResources: SessionModelResources;
  private readonly lspResources: SessionLspResources;
  private sessionEnvironment: Readonly<Record<string, string>>;
  private subagentRegistry?: SubagentRegistry;
  private autoVerifyRuntime?: AutoVerifyRuntime;
  private lspManager?: LspSessionManager;
  private readonly userShellMutex = new Mutex();
  private readonly sideConversationOperations = new ActiveOperationGate();
  private readonly backgroundSubagentCompletionMutex = new Mutex();
  private readonly backgroundSubagentCompletionWaiters = new Set<() => void>();
  private backgroundSubagentCompletionRevision = 0;
  private backgroundTaskChildIds = new Set<string>();
  private readonly backgroundTaskCompletionSettledIds = new Set<string>();

  constructor(
    private readonly config: BladeConfig,
    private readonly options: SessionRuntimeOptions
  ) {
    this.selectedModelId =
      options.modelId && options.modelId !== 'inherit' ? options.modelId : undefined;
    this.selectedReasoningEffort = options.reasoningEffort ?? 'off';
    this.selectedServiceTier = options.serviceTier ?? 'auto';
    this.selectedResponseVerbosity = options.responseVerbosity ?? 'auto';
    this.selectedCommunicationStyle = options.communicationStyle ?? 'auto';
    if (options.modelResources) {
      this.modelResources = options.modelResources;
    } else {
      const catalog = new PiModelCatalog(getPiModelCatalog().credentials);
      if (config.modelProviders && config.models) {
        catalog.configureModelProviders(config.modelProviders, config.models);
      }
      this.modelResources = {
        projectRoot: path.resolve(options.workspaceRoot ?? getCwd()),
        config: cloneWorkspaceModelConfig(config),
        catalog,
      };
    }
    this.lspResources = snapshotWorkspaceLspResources(
      options.lspResources ?? {
        projectRoot: this.modelResources.projectRoot,
        servers: config.lspServers,
      }
    );
    this.sessionEnvironment = Object.freeze({ ...config.env });
    this.goalStore = new GoalStore(this.workspaceRoot, this.sessionId);
    this.attachmentCollector = new AttachmentCollector({
      cwd: this.workspaceRoot,
      maxFileSize: 1024 * 1024,
      maxLines: 2000,
      maxTokens: 32000,
    });
  }

  static async create(options: SessionRuntimeOptions): Promise<SessionRuntime> {
    const workspaceRoot = options.workspaceRoot ?? getCwd();
    let taskWorktree = options.taskWorktree;
    let taskIsolation = options.taskIsolation;
    let selectedModelId = options.modelId;
    let selectedPermissionMode = options.permissionMode;
    let selectedReasoningEffort = options.reasoningEffort;
    let selectedServiceTier = options.serviceTier;
    let selectedResponseVerbosity = options.responseVerbosity;
    let selectedCommunicationStyle = options.communicationStyle;
    let selectedCommunicationStyleDigest = options.communicationStyleDigest;
    let selectedProjectInstructionsDigest = options.projectInstructionsDigest;
    const hasExplicitModel = selectedModelId !== undefined;
    const hasExplicitCommunicationStyle = selectedCommunicationStyle !== undefined;
    try {
      await ensureStoreInitialized();
      const storedMetadata = await SessionService.findSessionMetadata(
        options.sessionId,
        workspaceRoot
      );
      if (storedMetadata?.archivedAt) {
        throw new SessionArchivedError(
          options.sessionId,
          storedMetadata.archivedBySessionId ?? options.sessionId
        );
      }
      selectedPermissionMode ??= storedMetadata?.permissionMode as
        | PermissionMode
        | undefined;
      selectedReasoningEffort ??= storedMetadata?.reasoningEffort ?? 'off';
      selectedServiceTier ??= storedMetadata?.serviceTier ?? 'auto';
      selectedResponseVerbosity ??= storedMetadata?.responseVerbosity ?? 'auto';
      selectedCommunicationStyle ??= storedMetadata?.communicationStyle ?? 'auto';
      if (
        !hasExplicitCommunicationStyle ||
        selectedCommunicationStyle === storedMetadata?.communicationStyle
      ) {
        selectedCommunicationStyleDigest ??= storedMetadata?.communicationStyleDigest;
      }
      selectedProjectInstructionsDigest ??= storedMetadata?.projectInstructionsDigest;
      if (
        !options.subagentInfo &&
        (!taskWorktree || !taskIsolation || !selectedModelId)
      ) {
        const storedWorktree = await (taskWorktree
          ? Promise.resolve(undefined)
          : SessionService.findSessionTaskWorktree(options.sessionId, workspaceRoot));
        taskWorktree ??= storedWorktree;
        taskIsolation ??= storedMetadata?.taskIsolation;
        selectedModelId ??=
          storedMetadata?.selectedModelId ?? storedMetadata?.taskModelId;
      }
      if (taskWorktree) {
        if (path.resolve(taskWorktree.workspaceRoot) !== path.resolve(workspaceRoot)) {
          throw new Error('Task worktree workspace does not match runtime workspace');
        }
        await worktreeManager.restoreSession(taskWorktree);
      }

      const config = getConfig();
      if (!config) {
        throw new Error('配置未初始化，请确保应用已正确启动');
      }
      taskRunScheduler.configure(
        config.maxConcurrentTasks,
        config.maxQueuedTasks,
        config.maxQueuedTaskBytes
      );

      const configManager = ConfigManager.getInstance();
      const hookConfigRoot =
        options.modelResources?.projectRoot ??
        options.lspResources?.projectRoot ??
        options.agentResources?.projectRoot ??
        taskWorktree?.originalWorkspaceRoot ??
        workspaceRoot;
      const modelResources = options.modelResources
        ? snapshotWorkspaceModelResources(options.modelResources)
        : await resolveWorkspaceModelResources(hookConfigRoot, config);
      const models = modelResources.config.models;
      const lspResources = options.lspResources
        ? snapshotWorkspaceLspResources(options.lspResources)
        : await resolveWorkspaceLspResources(
            hookConfigRoot,
            modelResources.config.lspServers
          );
      if (models.length === 0) {
        throw new Error(
          '没有可用的模型配置\n\n' +
            '请先使用以下命令添加模型：\n' +
            '  /model add\n\n' +
            '或运行初始化向导：\n' +
            '  /init'
        );
      }
      if (
        !hasExplicitModel &&
        selectedModelId &&
        selectedModelId !== 'inherit' &&
        !models.some((model) => model.id === selectedModelId)
      ) {
        selectedModelId = undefined;
      }
      const mcpServers = await resolveWorkspaceMcpConfig({
        workspaceRoot: hookConfigRoot,
        storeServers: config.mcpServers ?? {},
        sessionServers: options.mcpServers,
        cliConfigs: options.mcpConfig,
        strictCliConfig: options.strictMcpConfig,
      });
      const runtimeConfig: BladeConfig = {
        ...modelResources.config,
        permissionMode:
          selectedPermissionMode ??
          modelResources.config.permissionMode ??
          PermissionMode.DEFAULT,
        lspServers: structuredClone(lspResources.servers),
        permissions: await configManager.loadWorkspacePermissions(
          hookConfigRoot,
          modelResources.config.permissions
        ),
        hooks: await configManager.loadWorkspaceHooks(
          hookConfigRoot,
          modelResources.config.hooks ?? {}
        ),
      };
      configManager.validateConfig(runtimeConfig, modelResources.catalog);

      const runtime = new SessionRuntime(runtimeConfig, {
        ...options,
        modelResources,
        lspResources,
        mcpServers,
        ...(selectedModelId ? { modelId: selectedModelId } : {}),
        permissionMode: runtimeConfig.permissionMode,
        reasoningEffort: selectedReasoningEffort,
        serviceTier: selectedServiceTier,
        responseVerbosity: selectedResponseVerbosity,
        communicationStyle: selectedCommunicationStyle,
        ...(selectedCommunicationStyleDigest
          ? { communicationStyleDigest: selectedCommunicationStyleDigest }
          : {}),
        ...(selectedProjectInstructionsDigest
          ? { projectInstructionsDigest: selectedProjectInstructionsDigest }
          : {}),
        ...(taskWorktree ? { taskWorktree } : {}),
        ...(taskIsolation ? { taskIsolation } : {}),
      });
      await runtime.initialize();
      return runtime;
    } catch (error) {
      if (!options.subagentInfo && !(error instanceof SessionInUseError)) {
        const taskDiffStat = taskWorktree
          ? await worktreeManager
              .getChangeSummary(options.sessionId)
              .catch(() => undefined)
          : undefined;
        await SessionRuntime.persistTaskStatus(
          options.sessionId,
          workspaceRoot,
          'failed',
          'Session runtime initialization failed',
          taskDiffStat ?? undefined
        ).catch((statusError) => {
          if ((statusError as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn(
              `[SessionRuntime ${options.sessionId}] Failed to persist initialization failure`,
              statusError
            );
          }
        });
      }
      throw error;
    }
  }

  static async hasPendingInbox(
    workspaceRoot: string,
    sessionId: string
  ): Promise<boolean> {
    try {
      if ((await stat(getSessionInboxFilePath(workspaceRoot, sessionId))).size > 0) {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (getConfig()?.agentTeamsEnabled !== true) return false;
    const teams = (
      await TeamStore.getInstance(getBladeStorageRoot()).listTeams()
    ).filter(
      (team) =>
        team.deletedAt === undefined &&
        team.leadSessionId === sessionId &&
        team.workspaceRoot === workspaceRoot
    );
    for (const team of teams) {
      if (
        (
          await new TeamMailbox(team.name, getBladeStorageRoot()).listPending(
            'team-lead'
          )
        ).length > 0
      ) {
        return true;
      }
    }
    return false;
  }

  static async hasActiveGoal(
    workspaceRoot: string,
    sessionId: string
  ): Promise<boolean> {
    return GoalStore.hasActiveGoal(workspaceRoot, sessionId);
  }

  get sessionId(): string {
    return this.options.sessionId;
  }

  get workspaceRoot(): string {
    return this.options.workspaceRoot ?? getCwd();
  }

  get projectRoot(): string {
    return (
      this.options.modelResources?.projectRoot ??
      this.options.lspResources?.projectRoot ??
      this.options.agentResources?.projectRoot ??
      this.options.taskWorktree?.originalWorkspaceRoot ??
      this.workspaceRoot
    );
  }

  getConfig(): BladeConfig {
    return this.config;
  }

  getAvailableModels(): ModelConfig[] {
    return this.config.models.map((model) => structuredClone(model));
  }

  getModelById(modelId: string): ModelConfig | undefined {
    const model = this.config.models.find((candidate) => candidate.id === modelId);
    return model ? structuredClone(model) : undefined;
  }

  getAgentResources(): SessionAgentResources {
    if (!this.agentResources) {
      throw new Error('Session agent resources are unavailable before initialization');
    }
    return this.agentResources;
  }

  getModelResources(): SessionModelResources {
    return this.modelResources;
  }

  getLspResources(): SessionLspResources {
    return snapshotWorkspaceLspResources(this.lspResources);
  }

  isTaskSession(): boolean {
    return !this.options.subagentInfo && this.options.taskIsolation !== undefined;
  }

  getTaskAdmissionLimits(): {
    maxConcurrent: number;
    maxQueued: number;
    maxQueuedBytes: number;
  } {
    const admission = taskRunScheduler.getStats();
    return {
      maxConcurrent: admission.maxConcurrent,
      maxQueued: admission.maxQueued,
      maxQueuedBytes: admission.maxQueuedBytes,
    };
  }

  async setTaskAdmission(
    snapshot: TaskAdmissionSnapshot
  ): Promise<SessionMetadata | undefined> {
    if (!this.isTaskSession()) return undefined;
    const now = new Date().toISOString();
    const queued = snapshot.state === 'queued';
    const metadata = await SessionService.updateSessionMetadata(
      this.sessionId,
      this.workspaceRoot,
      {
        taskStatus: snapshot.state,
        taskStatusReason: null,
        taskFailure: null,
        taskQueuePosition: queued ? (snapshot.queuePosition ?? 1) : null,
        taskQueueDepth: queued ? snapshot.queueDepth : null,
        taskConcurrencyLimit: snapshot.maxConcurrent,
        ...(queued
          ? {
              taskStartedAt: null,
              taskCompletedAt: null,
              taskOwnerPid: null,
            }
          : {
              taskStartedAt: now,
              taskCompletedAt: null,
              taskOwnerPid: process.pid,
            }),
      }
    );
    Bus.publish(
      { sessionId: this.sessionId, projectPath: this.workspaceRoot },
      'task.status',
      {
        taskStatus: metadata.taskStatus,
        ...(metadata.taskStartedAt ? { taskStartedAt: metadata.taskStartedAt } : {}),
        ...(snapshot.queuePosition
          ? { taskQueuePosition: snapshot.queuePosition }
          : {}),
        taskQueueDepth: snapshot.queueDepth,
        taskConcurrencyLimit: snapshot.maxConcurrent,
        taskInFlight: snapshot.inFlight,
        taskAdmissionPaused: taskRunScheduler.getStats().paused,
        updatedAt: metadata.lastMessageTime,
      }
    );
    return metadata;
  }

  publishTaskAdmissionCapacity(taskStatus: SessionTaskStatus): void {
    if (!this.isTaskSession()) return;
    const stats = taskRunScheduler.getStats();
    Bus.publish(
      { sessionId: this.sessionId, projectPath: this.workspaceRoot },
      'task.status',
      {
        taskStatus,
        taskQueueDepth: stats.queued,
        taskConcurrencyLimit: stats.maxConcurrent,
        taskInFlight: stats.inFlight,
        taskAdmissionPaused: stats.paused,
        updatedAt: new Date().toISOString(),
      }
    );
  }

  getChatService(): IChatService {
    if (!this.chatService) {
      throw new Error('Session runtime is not initialized');
    }
    return this.chatService;
  }

  getExecutionEngine(): ExecutionEngine {
    if (!this.executionEngine) {
      throw new Error('Session runtime is not initialized');
    }
    return this.executionEngine;
  }

  async loadModelContext(): Promise<Message[]> {
    if (!this.initialized) {
      throw new Error('Session runtime is not initialized');
    }
    return SessionService.loadSessionModelContext(this.sessionId, this.workspaceRoot);
  }

  async askSideQuestion(
    question: string,
    options: {
      signal?: AbortSignal;
      systemPrompt?: string;
      appendSystemPrompt?: string;
    } = {}
  ): Promise<SideConversationResult> {
    if (!this.initialized || !this.chatService) {
      throw new Error('Session runtime is not initialized');
    }
    const operation = this.sideConversationOperations.enter(options.signal);
    const permissionMode = this.config.permissionMode ?? PermissionMode.DEFAULT;
    let toolExecutor: ToolExecutor | undefined;

    try {
      toolExecutor = this.createToolExecutor({ permissionMode });
      const registry = toolExecutor.getRegistry();
      await registry.waitForMcpCatalogIdle();
      const [messages, builtPrompt] = await Promise.all([
        this.loadModelContext(),
        buildSystemPrompt({
          projectPath: this.workspaceRoot,
          replaceDefault: options.systemPrompt,
          append: options.appendSystemPrompt,
          ...(permissionMode === PermissionMode.PLAN
            ? { mode: PermissionMode.PLAN }
            : {}),
          includeEnvironment: true,
          environmentOptions: CACHE_STABLE_ENVIRONMENT_OPTIONS,
          language: this.config.language,
          availableSkills:
            this.agentResources?.skills.generateAvailableSkillsList() ?? '',
          communicationStyle: this.selectedCommunicationStyle,
          communicationStyleCatalog: this.getCommunicationStyleCatalog(),
          projectRuleCatalog: this.getProjectRuleCatalog(),
          projectInstructionSourcePath: this.projectRoot,
        }),
      ]);
      const systemPrompt = composeProviderSystemPrompt(builtPrompt.prompt, registry);
      if (!systemPrompt) throw new Error('Side conversation system prompt is empty');

      return await runSideConversation({
        question,
        sessionId: this.sessionId,
        workspaceRoot: this.workspaceRoot,
        systemPrompt,
        messages,
        tools: registry.getFunctionDeclarationsByMode(permissionMode),
        chatService: this.chatService,
        signal: operation.signal,
        providerRecoveryBudgetMs: this.config.providerForegroundRecoveryMs,
      });
    } finally {
      toolExecutor?.dispose();
      operation.release();
    }
  }

  getStartupTurnRecovery(): SessionTurnRecovery | undefined {
    return this.startupTurnRecovery
      ? structuredClone(this.startupTurnRecovery)
      : undefined;
  }

  async getRecoveredFinalResponse(): Promise<RecoveredFinalResponse | undefined> {
    const recovery = this.startupTurnRecovery;
    if (!recovery || recovery.outcome !== 'completed') return undefined;
    const messages = await this.loadModelContext();
    const message = messages.findLast(
      (candidate) =>
        candidate.role === 'assistant' &&
        messageTurnFinalization(candidate)?.turnId === recovery.turnId &&
        JSON.stringify(messageTurnFinalization(candidate)) ===
          JSON.stringify(recovery.finalization)
    );
    if (!message || typeof message.content !== 'string') return undefined;
    const metadata =
      message.metadata &&
      typeof message.metadata === 'object' &&
      !Array.isArray(message.metadata)
        ? message.metadata
        : undefined;
    const structuredOutput = metadata?.structuredOutput;
    const output =
      structuredOutput &&
      typeof structuredOutput === 'object' &&
      !Array.isArray(structuredOutput) &&
      structuredOutput.output &&
      typeof structuredOutput.output === 'object' &&
      !Array.isArray(structuredOutput.output)
        ? (structuredOutput.output as JsonObject)
        : undefined;
    return {
      turnId: recovery.turnId,
      content: message.content,
      ...(output ? { structuredOutput: output } : {}),
      ...(typeof metadata?.structuredOutputSchemaDigest === 'string'
        ? {
            structuredOutputSchemaDigest: metadata.structuredOutputSchemaDigest,
          }
        : {}),
    };
  }

  takeStartupAdoptedToolResults(): StartupAdoptedToolResult[] {
    const results = this.startupAdoptedToolResults;
    this.startupAdoptedToolResults = [];
    return structuredClone(results);
  }

  getAttachmentCollector(): AttachmentCollector {
    return this.attachmentCollector;
  }

  getCurrentModelId(): string | undefined {
    return this.currentModelId;
  }

  getReasoningConfiguration(): ReasoningEffortConfiguration {
    if (!this.currentReasoning) {
      throw new Error('Session runtime is not initialized');
    }
    return {
      ...this.currentReasoning,
      supported: [...this.currentReasoning.supported],
    };
  }

  resolveReasoningConfiguration(
    selection: ReasoningEffortSelection,
    modelId = this.currentModelId
  ): ReasoningEffortConfiguration {
    return resolvePiModelConfig(
      this.resolveModelConfig(modelId),
      this.config,
      selection,
      this.modelResources.catalog
    ).reasoning;
  }

  getServiceTierConfiguration(): ServiceTierConfiguration {
    if (!this.currentServiceTier) {
      throw new Error('Session runtime is not initialized');
    }
    return {
      ...this.currentServiceTier,
      supported: [...this.currentServiceTier.supported],
    };
  }

  resolveServiceTierConfiguration(
    selection: ServiceTierSelection,
    modelId = this.currentModelId
  ): ServiceTierConfiguration {
    return resolvePiModelConfig(
      this.resolveModelConfig(modelId),
      this.config,
      this.selectedReasoningEffort,
      this.modelResources.catalog,
      selection
    ).serviceTier;
  }

  getResponseVerbosityConfiguration(): ResponseVerbosityConfiguration {
    if (!this.currentResponseVerbosity) {
      throw new Error('Session runtime is not initialized');
    }
    return {
      ...this.currentResponseVerbosity,
      supported: [...this.currentResponseVerbosity.supported],
    };
  }

  resolveResponseVerbosityConfiguration(
    selection: ResponseVerbositySelection,
    modelId = this.currentModelId
  ): ResponseVerbosityConfiguration {
    return resolvePiModelConfig(
      this.resolveModelConfig(modelId),
      this.config,
      this.selectedReasoningEffort,
      this.modelResources.catalog,
      this.selectedServiceTier,
      selection
    ).responseVerbosity;
  }

  getCommunicationStyleConfiguration(): CommunicationStyleConfiguration {
    return resolveCommunicationStyle(
      this.selectedCommunicationStyle,
      this.getCommunicationStyleCatalog()
    );
  }

  resolveCommunicationStyleConfiguration(
    selection: CommunicationStyleSelection
  ): CommunicationStyleConfiguration {
    return resolveCommunicationStyle(selection, this.getCommunicationStyleCatalog());
  }

  getCommunicationStyleCatalog(): CommunicationStyleCatalog {
    return (
      this.agentResources?.communicationStyles ?? BUILTIN_COMMUNICATION_STYLE_CATALOG
    );
  }

  getProjectRuleCatalog(): ProjectRuleCatalog {
    return (
      this.agentResources?.projectRules ?? ProjectRuleCatalog.empty(this.projectRoot)
    );
  }

  getStaticProjectRules(): ProjectRuleResolution {
    return this.getProjectRuleCatalog().staticRules(this.projectRoot);
  }

  hydrateProjectRules(
    references: readonly ProjectRuleReference[]
  ): ProjectRuleResolution {
    return this.getProjectRuleCatalog().hydrate(references);
  }

  resolveContextualProjectRules(
    toolName: string,
    params: Record<string, unknown>,
    result: ToolResult | undefined,
    loadedIds: ReadonlySet<string>
  ): ProjectRuleResolution {
    const paths = new Set<string>();
    try {
      const invocation = this.baseRegistry.get(toolName)?.build(params);
      for (const value of invocation?.getAffectedPaths() ?? []) {
        if (value) paths.add(value);
      }
    } catch {
      // Invalid tool parameters are handled by normal tool validation.
    }
    const addString = (value: unknown) => {
      if (typeof value === 'string' && value.trim()) paths.add(value);
    };
    if (['Read', 'Edit', 'Write'].includes(toolName)) {
      addString(params.file_path);
    } else if (toolName === 'NotebookEdit') {
      addString(params.notebook_path);
    } else if (['Grep', 'Glob'].includes(toolName)) {
      addString(params.path);
    } else if (toolName === 'Bash') {
      addString(params.cwd);
    }
    const metadata =
      result?.metadata && typeof result.metadata === 'object'
        ? (result.metadata as Record<string, unknown>)
        : undefined;
    if (Array.isArray(metadata?.affected_paths)) {
      for (const value of metadata.affected_paths) addString(value);
    }
    if (Array.isArray(metadata?.changes)) {
      for (const value of metadata.changes) {
        if (value && typeof value === 'object') {
          addString((value as Record<string, unknown>).path);
        }
      }
    }
    const sourcePaths = [...paths]
      .map((value) =>
        path.isAbsolute(value)
          ? path.resolve(value)
          : path.resolve(this.workspaceRoot, value)
      )
      .flatMap((target) => {
        const relative = path.relative(this.workspaceRoot, target);
        if (
          relative === '' ||
          (!relative.startsWith('..') && !path.isAbsolute(relative))
        ) {
          return [path.resolve(this.projectRoot, relative)];
        }
        const sourceRelative = path.relative(this.projectRoot, target);
        return sourceRelative === '' ||
          (!sourceRelative.startsWith('..') && !path.isAbsolute(sourceRelative))
          ? [target]
          : [];
      });
    return this.getProjectRuleCatalog().contextualRules(
      this.projectRoot,
      sourcePaths,
      loadedIds
    );
  }

  getCurrentModelMaxContextTokens(): number {
    if (this.currentModelMaxContextTokens === undefined) {
      throw new Error('Session runtime is not initialized');
    }
    return this.currentModelMaxContextTokens;
  }

  getGoal(): Promise<GoalSnapshot | null> {
    return this.goalStore.get();
  }

  async setTaskStatus(
    taskStatus: SessionTaskStatus,
    taskStatusReason?: unknown
  ): Promise<SessionMetadata | undefined> {
    if (this.options.subagentInfo) return undefined;

    const taskDiffStat =
      this.options.taskWorktree && !['queued', 'running'].includes(taskStatus)
        ? await worktreeManager.getChangeSummary(this.sessionId)
        : undefined;
    return SessionRuntime.persistTaskStatus(
      this.sessionId,
      this.workspaceRoot,
      taskStatus,
      taskStatusReason,
      taskDiffStat ?? undefined
    );
  }

  private static async persistTaskStatus(
    sessionId: string,
    workspaceRoot: string,
    taskStatus: SessionTaskStatus,
    taskStatusReason?: unknown,
    taskDiffStat?: SessionTaskDiffStat
  ): Promise<SessionMetadata> {
    const now = new Date().toISOString();
    const taskFailure: SessionTaskFailure | undefined =
      taskStatus === 'failed' && taskStatusReason !== undefined
        ? toTaskFailure(taskStatusReason)
        : undefined;
    const safeTaskStatusReason =
      taskFailure?.message ??
      (typeof taskStatusReason === 'string'
        ? taskStatusReason.slice(0, 500)
        : undefined);
    const metadata = await SessionService.updateSessionMetadata(
      sessionId,
      workspaceRoot,
      {
        taskStatus,
        taskStatusReason: safeTaskStatusReason ?? null,
        taskFailure: taskFailure ?? null,
        ...(taskDiffStat !== undefined
          ? { taskDiffStat }
          : taskStatus === 'running'
            ? { taskDiffStat: null }
            : {}),
        ...(taskStatus !== 'queued'
          ? {
              taskQueuePosition: null,
              taskQueueDepth: null,
            }
          : {}),
        ...(taskStatus === 'running'
          ? {
              taskStartedAt: now,
              taskCompletedAt: null,
              taskOwnerPid: process.pid,
            }
          : taskStatus === 'queued'
            ? {
                taskStartedAt: null,
                taskCompletedAt: null,
                taskOwnerPid: null,
              }
            : { taskCompletedAt: now, taskOwnerPid: null }),
      }
    );
    Bus.publish({ sessionId, projectPath: workspaceRoot }, 'task.status', {
      taskStatus: metadata.taskStatus,
      ...(safeTaskStatusReason ? { taskStatusReason: safeTaskStatusReason } : {}),
      ...(taskFailure ? { taskFailure } : {}),
      ...(metadata.taskStartedAt ? { taskStartedAt: metadata.taskStartedAt } : {}),
      ...(metadata.taskCompletedAt
        ? { taskCompletedAt: metadata.taskCompletedAt }
        : {}),
      ...(metadata.taskDiffStat ? { taskDiffStat: metadata.taskDiffStat } : {}),
      ...(metadata.taskQueuePosition
        ? { taskQueuePosition: metadata.taskQueuePosition }
        : {}),
      ...(metadata.taskQueueDepth !== undefined
        ? { taskQueueDepth: metadata.taskQueueDepth }
        : {}),
      ...(metadata.taskConcurrencyLimit !== undefined
        ? { taskConcurrencyLimit: metadata.taskConcurrencyLimit }
        : {}),
      updatedAt: metadata.lastMessageTime,
    });
    return metadata;
  }

  createGoal(input: GoalCreateInput): Promise<GoalSnapshot> {
    return this.goalStore.create(input);
  }

  editGoal(objective: string): Promise<GoalSnapshot> {
    return this.goalStore.edit(objective);
  }

  pauseGoal(reason?: string): Promise<GoalSnapshot> {
    return this.goalStore.pause(reason);
  }

  resumeGoal(): Promise<GoalSnapshot> {
    return this.goalStore.resume();
  }

  clearGoal(): Promise<boolean> {
    return this.goalStore.clear();
  }

  recordGoalCompletionVerification(
    result: GoalCompletionVerificationResult
  ): Promise<GoalSnapshot> {
    return this.goalStore.recordCompletionVerification(result);
  }

  invalidateGoalCompletionVerification(reason: string): Promise<GoalSnapshot> {
    return this.goalStore.invalidateCompletionVerification(reason);
  }

  finalizeVerifiedGoalCompletion(): Promise<GoalSnapshot> {
    return this.goalStore.finalizeVerifiedCompletion();
  }

  recordGoalProgress(progress: GoalProgress): Promise<GoalSnapshot | null> {
    return this.goalStore.recordProgress(progress);
  }

  beginGoalContinuation(): Promise<GoalSnapshot | null> {
    return this.goalStore.tryBeginContinuation();
  }

  async pauseActiveGoal(reason: string): Promise<GoalSnapshot | null> {
    return this.goalStore.pauseIfActive(reason);
  }

  async listRewindCheckpoints(): Promise<SessionRewindCheckpoint[]> {
    this.assertRewindIdle();
    return SessionService.listRewindCheckpoints(this.sessionId, this.workspaceRoot);
  }

  async rewindSession(options: RewindSessionOptions): Promise<RewoundSession> {
    this.assertRewindIdle();
    const result = await SessionService.rewindSession(
      this.sessionId,
      this.workspaceRoot,
      options
    );
    this.backgroundTaskChildIds = await this.getExecutionEngine()
      .getContextManager()
      .persistentStore.loadBackgroundTaskChildIds(this.sessionId);
    this.backgroundTaskCompletionSettledIds.clear();
    return result;
  }

  listSubagents(): AgentSession[] {
    return BackgroundAgentManager.getInstance().listForSession({
      sessionId: this.sessionId,
      projectPath: this.workspaceRoot,
    });
  }

  getMcpContentCatalog(): SessionMcpContentSnapshot {
    return (
      this.sessionMcpRegistry?.getContentCatalogSnapshot() ?? {
        revision: 0,
        resources: [],
        resourceTemplates: [],
        prompts: [],
      }
    );
  }

  async refreshMcpContentCatalogs(serverName?: string): Promise<void> {
    if (!this.sessionMcpRegistry) {
      throw new Error('This Session has no MCP servers');
    }
    await this.sessionMcpRegistry.refreshContentCatalogs(serverName);
  }

  async getMcpPrompt(
    serverName: string,
    name: string,
    arguments_: Record<string, string>
  ): Promise<McpNormalizedPromptResult> {
    if (!this.sessionMcpRegistry) {
      throw new Error('This Session has no MCP servers');
    }
    return this.sessionMcpRegistry.getPrompt(serverName, name, arguments_);
  }

  async completeMcpArgument(
    serverName: string,
    input: McpCompletionInput,
    signal?: AbortSignal
  ): Promise<McpNormalizedCompletionResult> {
    if (!this.sessionMcpRegistry) {
      throw new Error('This Session has no MCP servers');
    }
    return this.sessionMcpRegistry.complete(serverName, input, signal);
  }

  listMcpTasks(serverName?: string): McpTaskSnapshot[] {
    return McpTaskManager.getInstance().list(
      {
        sessionId: this.sessionId,
        projectPath: this.workspaceRoot,
      },
      serverName
    );
  }

  getMcpTask(taskId: string): McpTaskSnapshot | undefined {
    return McpTaskManager.getInstance().get(taskId, {
      sessionId: this.sessionId,
      projectPath: this.workspaceRoot,
    });
  }

  cancelMcpTask(
    taskId: string,
    signal?: AbortSignal
  ): Promise<McpTaskSnapshot | undefined> {
    return McpTaskManager.getInstance().cancel(
      taskId,
      {
        sessionId: this.sessionId,
        projectPath: this.workspaceRoot,
      },
      signal
    );
  }

  getMcpLogs(
    serverName?: string,
    options: { afterRevision?: number; limit?: number } = {}
  ): McpLogSnapshot {
    return (
      this.sessionMcpRegistry?.getLogSnapshot(serverName, options) ?? {
        revision: 0,
        entries: [],
      }
    );
  }

  getMcpInstructions(): McpInstructionsSnapshot {
    return (
      this.sessionMcpRegistry?.getInstructionsSnapshot() ?? {
        revision: 0,
        instructions: [],
      }
    );
  }

  async setMcpLoggingLevel(serverName: string, level: McpLogLevel): Promise<void> {
    if (!this.sessionMcpRegistry) {
      throw new Error('This Session has no MCP servers');
    }
    await this.sessionMcpRegistry.setServerLoggingLevel(serverName, level);
  }

  resumeSubagent(options: ResumeSubagentOptions): ResumedSubagent {
    this.assertSubagentControlIdle();
    const manager = BackgroundAgentManager.getInstance();
    const owner = {
      sessionId: this.sessionId,
      projectPath: this.workspaceRoot,
    };
    const source = manager.getAgent(options.agentId, owner);
    if (!source) {
      throw new Error(`Subagent not found in this session: ${options.agentId}`);
    }
    const registered = this.subagentRegistry?.getSubagent(source.subagentType);
    const config = source.configSnapshot
      ? ({ ...source.configSnapshot } as SubagentConfig)
      : registered;
    if (!config) {
      throw new Error(`Subagent configuration is unavailable: ${source.subagentType}`);
    }
    const resumed: ResumeAgentResult | undefined = manager.resumeAgent({
      agentId: source.id,
      prompt: options.prompt,
      config,
      owner,
      permissionMode: config.permissionMode,
      reasoningEffort: this.selectedReasoningEffort,
      serviceTier: this.selectedServiceTier,
      responseVerbosity: this.selectedResponseVerbosity,
      communicationStyle: this.selectedCommunicationStyle,
      agentResources: this.agentResources,
      modelResources: this.modelResources,
      lspResources: this.lspResources,
      onEvent: options.onEvent,
      onCompleted: async (session) => {
        await this.notifyBackgroundSubagentCompleted(session.id);
        await options.onCompleted?.(session);
      },
    });
    if (!resumed) {
      throw new Error(`Subagent cannot be resumed: ${source.id}`);
    }
    const session = manager.getAgent(resumed.agentId, owner);
    if (!session) {
      throw new Error(`Resumed subagent was not persisted: ${resumed.agentId}`);
    }
    return { source: resumed.source, session };
  }

  async beginTurn(kind: SessionTurnKind = 'goal'): Promise<ActiveTurnHandle> {
    const handle = this.getActiveTurnMailbox().beginTurn();
    try {
      await this.saveTurnStart(handle, kind);
      return handle;
    } catch (error) {
      await this.getActiveTurnMailbox()
        .finishTurn(handle)
        .catch(() => undefined);
      throw error;
    }
  }

  async prepareInputTurn(
    content: UserMessageContent,
    options?: { outputSchema?: JsonObject }
  ): Promise<InputTurnPreparation> {
    const mailbox = this.getActiveTurnMailbox();
    const preparation = await mailbox.prepareInputTurn(content, options);
    if (!preparation.accepted) return preparation;

    try {
      await this.saveTurnStart(
        preparation.handle,
        preparation.mode === 'direct' ? 'user' : 'pending',
        mailbox.pendingMessages().map((message) => message.id)
      );
      return preparation;
    } catch (error) {
      await mailbox.finishTurn(preparation.handle).catch(() => undefined);
      throw error;
    }
  }

  async enqueueSteering(
    content: UserMessageContent,
    options?: {
      allowBeforeTurn?: boolean;
      messageId?: string;
      outputSchema?: JsonObject;
      origin?: SteeringMessage['origin'];
      metadata?: MessagePersistenceMetadata;
    }
  ): Promise<SteeringEnqueueResult> {
    const result = await this.getActiveTurnMailbox().enqueue(content, options);
    if (result.accepted) this.signalBackgroundSubagentCompletionWaiters();
    return result;
  }

  async drainSteering(handle: ActiveTurnHandle): Promise<SteeringMessage[]> {
    return this.getActiveTurnMailbox().drain(handle);
  }

  async drainSteeringOrSeal(handle: ActiveTurnHandle): Promise<{
    messages: SteeringMessage[];
    sealed: boolean;
  }> {
    return this.getActiveTurnMailbox().drainOrSeal(handle);
  }

  async getClaimedTurnMessageIds(handle: ActiveTurnHandle): Promise<string[]> {
    return this.getActiveTurnMailbox().claimedMessageIds(handle);
  }

  async getRecoveredEmptyFinalState(handle: ActiveTurnHandle): Promise<{
    hadSuccessfulToolResult: boolean;
    correctionSpent: boolean;
  }> {
    const recovery = this.startupTurnRecovery;
    if (!recovery || recovery.outcome !== 'aborted') {
      return { hadSuccessfulToolResult: false, correctionSpent: false };
    }
    const claimed = await this.getClaimedTurnMessageIds(handle);
    const recoveredInputIds = new Set(recovery.inputMessageIds);
    if (
      claimed.length === 0 ||
      claimed.some((messageId) => !recoveredInputIds.has(messageId))
    ) {
      return { hadSuccessfulToolResult: false, correctionSpent: false };
    }
    return {
      hadSuccessfulToolResult: recovery.hadSuccessfulToolResult,
      correctionSpent: recovery.emptyFinalCorrectionSpent,
    };
  }

  async discardPendingInput(): Promise<void> {
    const mailbox = this.getActiveTurnMailbox();
    const ids = mailbox.pendingMessages().map((message) => message.id);
    if (ids.length === 0) return;
    await this.getExecutionEngine()
      .getContextManager()
      .persistentStore.acknowledgeInboxMessages(this.sessionId, ids);
    await mailbox.acknowledge(ids);
  }

  async finishTurn(
    handle: ActiveTurnHandle,
    options: {
      continuePending?: boolean;
      acknowledgeInput?: boolean;
      outcome?: SessionTurnOutcome;
    } = {}
  ): Promise<ActiveTurnHandle | undefined> {
    const outcome = options.outcome ?? {
      status: 'aborted',
      cause: 'interrupted',
      turnsCount: 0,
      toolCallsCount: 0,
      durationMs: 0,
    };
    const persistentStore =
      this.getExecutionEngine().getContextManager().persistentStore;
    if (outcome.status === 'completed') {
      const inputMessageIds =
        await this.getActiveTurnMailbox().claimedMessageIds(handle);
      await persistentStore.saveTurnCompletion(
        this.sessionId,
        {
          turnId: handle.id,
          completedAt: new Date().toISOString(),
          turnsCount: outcome.turnsCount,
          toolCallsCount: outcome.toolCallsCount,
          durationMs: outcome.durationMs,
        },
        inputMessageIds
      );
      await this.getActiveTurnMailbox().acknowledge(inputMessageIds);
    } else {
      const inheritedRecovery = await this.getRecoveredEmptyFinalState(handle);
      const inputMessageIds =
        await this.getActiveTurnMailbox().claimedMessageIds(handle);
      const abortResult = await persistentStore.saveTurnAbort(
        this.sessionId,
        {
          turnId: handle.id,
          cause: outcome.cause,
          abortedAt: new Date().toISOString(),
          turnsCount: outcome.turnsCount,
          toolCallsCount: outcome.toolCallsCount,
          durationMs: outcome.durationMs,
          recovery: {
            version: 1,
            inputMessageIds,
            hadSuccessfulToolResult: inheritedRecovery.hadSuccessfulToolResult,
            emptyFinalCorrectionSpent: inheritedRecovery.correctionSpent,
          },
        },
        options.acknowledgeInput
          ? { acknowledgeInputMessageIds: inputMessageIds }
          : undefined
      );
      this.startupTurnRecovery = abortResult.recovery;
      if (options.acknowledgeInput) {
        await this.getActiveTurnMailbox().acknowledge(
          abortResult.acknowledgedInputMessageIds
        );
      }
    }

    const next = await this.getActiveTurnMailbox().finishTurn(handle, options);
    if (!next) return undefined;
    try {
      await this.saveTurnStart(
        next,
        'pending',
        this.getActiveTurnMailbox()
          .pendingMessages()
          .map((message) => message.id)
      );
      return next;
    } catch (error) {
      await this.getActiveTurnMailbox()
        .finishTurn(next)
        .catch(() => undefined);
      throw error;
    }
  }

  async beginPendingTurn(): Promise<ActiveTurnHandle | undefined> {
    const mailbox = this.getActiveTurnMailbox();
    const handle = await mailbox.beginPendingTurn();
    if (!handle) return undefined;
    try {
      await this.saveTurnStart(
        handle,
        'pending',
        mailbox.pendingMessages().map((message) => message.id)
      );
      return handle;
    } catch (error) {
      await mailbox.finishTurn(handle).catch(() => undefined);
      throw error;
    }
  }

  hasActiveTurn(): boolean {
    return this.activeTurnMailbox?.isActive() ?? false;
  }

  hasTurnOwner(): boolean {
    return this.activeTurnMailbox?.hasTurnOwner() ?? false;
  }

  getPendingSteeringCount(): number {
    return this.activeTurnMailbox?.pendingCount() ?? 0;
  }

  getPendingSteeringMessages(): SteeringMessage[] {
    return this.activeTurnMailbox?.pendingMessages() ?? [];
  }

  isIdleForResidency(): boolean {
    if (
      !this.initialized ||
      this.disposing ||
      this.hasActiveTurn() ||
      this.hasTurnOwner() ||
      this.sideConversationOperations.stats().active > 0 ||
      this.getPendingSteeringCount() > 0 ||
      this.executorCatalogs.size > 0
    ) {
      return false;
    }
    if (
      BackgroundShellManager.getInstance()
        .listForSession(this.sessionId)
        .some((process) => process.status === 'running')
    ) {
      return false;
    }
    const owner = {
      sessionId: this.sessionId,
      projectPath: this.workspaceRoot,
    };
    if (
      BackgroundAgentManager.getInstance()
        .listForSession(owner)
        .some((session) => session.status === 'running') ||
      this.getBackgroundTaskChildrenState() !== 'none'
    ) {
      return false;
    }
    return !McpTaskManager.getInstance().hasActive(owner);
  }

  getRecoveredSteeringCount(): number {
    return this.activeTurnMailbox?.recoveredCount() ?? 0;
  }

  async notifyBackgroundSubagentCompleted(agentId: string): Promise<void> {
    try {
      await this.reconcileBackgroundSubagentCompletions(agentId);
    } finally {
      this.signalBackgroundSubagentCompletionWaiters();
    }
  }

  registerBackgroundSubagent(agentId: string): void {
    this.backgroundTaskChildIds.add(agentId);
    this.backgroundTaskCompletionSettledIds.delete(agentId);
  }

  async waitForBackgroundSubagentFollowUp(
    handle: ActiveTurnHandle,
    signal?: AbortSignal
  ): Promise<boolean> {
    while (!signal?.aborted) {
      await this.reconcileBackgroundSubagentCompletions();
      if (await this.hasUnclaimedPendingInput(handle)) return true;

      const revision = this.backgroundSubagentCompletionRevision;
      const childState = this.getBackgroundTaskChildrenState();
      if (childState === 'none') return false;
      if (childState === 'terminal_pending') continue;
      await this.waitForBackgroundSubagentSignal(revision, signal);
    }
    return false;
  }

  private async hasUnclaimedPendingInput(handle: ActiveTurnHandle): Promise<boolean> {
    const claimed = new Set(
      await this.getActiveTurnMailbox().claimedMessageIds(handle)
    );
    return this.getActiveTurnMailbox()
      .pendingMessages()
      .some((message) => !claimed.has(message.id));
  }

  private signalBackgroundSubagentCompletionWaiters(): void {
    this.backgroundSubagentCompletionRevision++;
    for (const wake of this.backgroundSubagentCompletionWaiters) wake();
    this.backgroundSubagentCompletionWaiters.clear();
  }

  private async waitForBackgroundSubagentSignal(
    revision: number,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted || revision !== this.backgroundSubagentCompletionRevision) {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.backgroundSubagentCompletionWaiters.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      this.backgroundSubagentCompletionWaiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
      if (signal?.aborted || revision !== this.backgroundSubagentCompletionRevision) {
        finish();
      }
    });
  }

  private getBackgroundTaskChildrenState(): 'running' | 'terminal_pending' | 'none' {
    if (this.backgroundTaskChildIds.size === 0) return 'none';
    const owner = {
      sessionId: this.sessionId,
      projectPath: this.workspaceRoot,
    };
    const sessions = AgentSessionStore.getInstance()
      .listSessions()
      .filter(
        (session) =>
          isAgentSessionOwnedBy(session, owner) &&
          this.backgroundTaskChildIds.has(session.id) &&
          session.background === true
      );
    if (
      sessions.some(
        (session) =>
          session.status !== 'running' &&
          !this.backgroundTaskCompletionSettledIds.has(session.id)
      )
    ) {
      return 'terminal_pending';
    }
    return sessions.some((session) => session.status === 'running')
      ? 'running'
      : 'none';
  }

  private async reconcileBackgroundSubagentCompletions(
    onlyAgentId?: string
  ): Promise<number> {
    return this.backgroundSubagentCompletionMutex.runExclusive(async () => {
      if (!this.activeTurnMailbox || !this.executionEngine) return 0;
      const persistentStore =
        this.getExecutionEngine().getContextManager().persistentStore;
      if (this.backgroundTaskChildIds.size === 0) return 0;
      const sessionStore = AgentSessionStore.getInstance();
      const owner = {
        sessionId: this.sessionId,
        projectPath: this.workspaceRoot,
      };
      const sessions = onlyAgentId
        ? [sessionStore.loadSession(onlyAgentId)].filter(
            (session): session is AgentSession => Boolean(session)
          )
        : sessionStore
            .listSessions()
            .filter((session) => isAgentSessionOwnedBy(session, owner));
      let enqueued = 0;
      for (const session of sessions) {
        if (
          !this.backgroundTaskChildIds.has(session.id) ||
          this.backgroundTaskCompletionSettledIds.has(session.id) ||
          session.status === 'running'
        ) {
          continue;
        }
        const source = session.resumedFrom
          ? sessionStore.loadSession(session.resumedFrom)
          : undefined;
        const completion = buildBackgroundSubagentCompletion(session, owner, source);
        if (!completion) {
          this.backgroundTaskCompletionSettledIds.add(session.id);
          continue;
        }
        const receipt = await persistentStore.persistBackgroundSubagentCompletion(
          this.sessionId,
          completion
        );
        if (!receipt.eligible || receipt.acknowledged) {
          this.backgroundTaskCompletionSettledIds.add(session.id);
          continue;
        }
        const queued =
          await this.activeTurnMailbox.enqueueBackgroundSubagentCompletion(completion);
        if (!queued.accepted) {
          logger.warn(
            `[SessionRuntime ${this.sessionId}] Background subagent completion queue is full for ${session.id}`
          );
          continue;
        }
        this.backgroundTaskCompletionSettledIds.add(session.id);
        if (queued.duplicate) continue;
        enqueued++;
        Bus.publish(
          { sessionId: this.sessionId, projectPath: this.workspaceRoot },
          'subagent.completion.queued',
          {
            childSessionId: session.id,
            inboxMessageId: completion.inboxMessageId,
            status: session.status,
            type: session.subagentType,
            description: session.description,
            summary: completion.subagentRef.subagentSummary,
            resumedFrom: session.resumedFrom,
            rootAgentId: session.rootAgentId,
            resumeDepth: session.resumeDepth,
            verificationVerdict: session.result?.verificationVerdict,
            queued: queued.queued,
            delivery: queued.delivery,
          }
        );
      }
      return enqueued;
    });
  }

  async reloadPendingInbox(): Promise<void> {
    if (this.hasTurnOwner()) {
      throw new Error('Cannot reload the pending inbox during an active turn');
    }
    this.activeTurnMailbox = await ActiveTurnMailbox.create(
      this.workspaceRoot,
      this.sessionId
    );
  }

  private async recoverTeamLeadMessages(): Promise<void> {
    if (this.config.agentTeamsEnabled !== true) return;
    const teams = (
      await TeamStore.getInstance(getBladeStorageRoot()).listTeams()
    ).filter(
      (team) =>
        team.deletedAt === undefined &&
        team.leadSessionId === this.sessionId &&
        team.workspaceRoot === this.workspaceRoot
    );
    for (const team of teams) {
      const mailbox = new TeamMailbox(team.name, getBladeStorageRoot());
      const messages = await mailbox.listPending('team-lead');
      for (const message of messages) {
        const queued = await this.enqueueSteering(formatTeamMessage(message), {
          allowBeforeTurn: true,
          messageId: message.id,
          origin: 'team_message',
          metadata: teamMessageMetadata(message),
        });
        if (queued.accepted) await mailbox.markDelivered([message.id]);
      }
    }
  }

  async executeUserShellCommand(
    command: string,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onEvent?: (event: SessionUserShellCommandEvent) => void | Promise<void>;
    } = {}
  ): Promise<SessionUserShellCommandResult> {
    if (!this.initialized || !this.executionEngine) {
      throw new Error('Session runtime is not initialized');
    }
    return this.userShellMutex.runExclusive(async () => {
      const executionId = nanoid(12);
      const auxiliary = this.hasTurnOwner();
      const signal = options.signal ?? new AbortController().signal;
      const publish = async (event: SessionUserShellCommandEvent) => {
        const properties =
          event.type === 'started'
            ? {
                executionId: event.executionId,
                command: event.command,
                auxiliary,
              }
            : event.type === 'output'
              ? {
                  executionId: event.executionId,
                  stream: event.stream,
                  chunk: event.chunk,
                  streamedBytes: event.streamedBytes,
                  streamTruncated: event.streamTruncated,
                  auxiliary,
                }
              : {
                  executionId: event.executionId,
                  messageId: event.messageId,
                  record: event.record,
                  auxiliary,
                  delivery: event.delivery,
                  queued: event.queued,
                };
        Bus.publish(
          { sessionId: this.sessionId, projectPath: this.workspaceRoot },
          `user.shell.${event.type}`,
          properties
        );
        await options.onEvent?.(event);
      };

      const record = await executeUserShellCommand(command, {
        executionId,
        cwd: this.workspaceRoot,
        env: {
          ...process.env,
          ...this.sessionEnvironment,
          BLADE_CLI: '1',
          BLADE_USER_SHELL: '1',
        },
        signal,
        timeoutMs: options.timeoutMs,
        executor: this.options.userShellExecutor,
        onEvent: async (event) => {
          if (event.type !== 'completed') {
            await publish({ ...event, auxiliary });
          }
        },
      });
      const modelContent = renderUserShellCommandForModel(record);
      const contextManager = this.getExecutionEngine().getContextManager();
      const messageId = await contextManager.saveMessage(
        this.sessionId,
        'user',
        modelContent,
        null,
        {
          ...(auxiliary ? { inboxMessageId: executionId } : {}),
          userShellCommand: JSON.parse(JSON.stringify(record)) as JsonValue,
        },
        this.options.subagentInfo
      );
      const steering = auxiliary
        ? await this.getActiveTurnMailbox().enqueue(modelContent, {
            allowBeforeTurn: true,
            messageId: executionId,
            persisted: true,
          })
        : undefined;
      const result: SessionUserShellCommandResult = {
        executionId,
        messageId,
        record,
        modelContent,
        auxiliary,
        ...(steering?.delivery ? { delivery: steering.delivery } : {}),
        ...(steering ? { queued: steering.queued } : {}),
      };
      await publish({
        type: 'completed',
        executionId,
        messageId,
        record,
        auxiliary,
        ...(steering?.delivery ? { delivery: steering.delivery } : {}),
        ...(steering ? { queued: steering.queued } : {}),
      });
      return result;
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.sessionLease = await SessionLease.acquire(this.sessionId, this.workspaceRoot);
    try {
      await new ForegroundProcessLeaseStore(
        this.workspaceRoot,
        this.sessionId
      ).reapOrphans();
      await BackgroundShellManager.getInstance().reapOrphanedSession(
        this.sessionId,
        this.workspaceRoot
      );
      if (!isAcpMode(this.sessionId)) {
        await recoverWorkspacePatchTransactions(this.workspaceRoot);
      }
      await BackgroundAgentManager.getInstance().reconcileOrphanedSessions({
        sessionId: this.sessionId,
        projectPath: this.workspaceRoot,
      });
      await cleanupStaleWorktreesOnce(this.workspaceRoot);
      const hookManager = HookManager.getInstance();
      hookManager.loadConfig(
        this.config.disableAllHooks
          ? { ...this.config.hooks, enabled: false }
          : (this.config.hooks ?? {}),
        this.projectRoot
      );
      hookManager.bindSessionModelResources(
        this.sessionId,
        [this.projectRoot, this.workspaceRoot],
        this.modelResources
      );
      await this.loadAgentResources();
      if (this.projectRoot !== this.workspaceRoot) {
        hookManager.inheritProjectConfig(this.projectRoot, this.workspaceRoot);
      }
      hookManager.bindSessionConfig(
        this.sessionId,
        [this.projectRoot, this.workspaceRoot],
        this.config.disableAllHooks
          ? {
              ...(this.agentResources?.hooks ??
                hookManager.getConfig(this.projectRoot)),
              enabled: false,
            }
          : (this.agentResources?.hooks ?? hookManager.getConfig(this.projectRoot))
      );
      const sessionStartResult = await hookManager.executeSessionStartHooks({
        projectDir: this.workspaceRoot,
        sessionId: this.sessionId,
        permissionMode: this.config.permissionMode ?? PermissionMode.DEFAULT,
        isResume: this.options.sessionStart?.isResume ?? false,
        resumeSessionId: this.options.sessionStart?.resumeSessionId,
      });
      if (!sessionStartResult.proceed) {
        throw new Error(
          sessionStartResult.warning || 'SessionStart hook blocked initialization'
        );
      }
      if (sessionStartResult.warning) {
        logger.warn(
          `[SessionRuntime ${this.sessionId}] SessionStart hook warning: ${sessionStartResult.warning}`
        );
      }
      const hookEnvironment = normalizeRuntimeEnvironment(sessionStartResult.env ?? {});
      this.sessionEnvironment = Object.freeze({
        ...this.sessionEnvironment,
        ...hookEnvironment,
      });
      this.config.env = this.sessionEnvironment as Record<string, string>;
      hookManager.bindSessionEnvironment(
        this.sessionId,
        [this.projectRoot, this.workspaceRoot],
        this.sessionEnvironment
      );
      if (Object.keys(this.lspResources.servers).length > 0) {
        this.lspManager = new LspSessionManager({
          sessionId: this.sessionId,
          workspaceRoot: this.workspaceRoot,
          environment: this.sessionEnvironment,
          servers: this.lspResources.servers,
        });
      }
      if (!this.lspManager?.available) {
        this.autoVerifyRuntime = new AutoVerifyRuntime({
          sessionId: this.sessionId,
          workspaceRoot: this.workspaceRoot,
          projectRoot: this.projectRoot,
          environment: this.sessionEnvironment,
        });
      }
      await this.validateSystemPromptConfig();
      this.activeTurnMailbox = await ActiveTurnMailbox.create(
        this.workspaceRoot,
        this.sessionId
      );
      await this.registerBuiltinTools();
      await this.applyModelConfig(
        this.resolveModelConfig(this.selectedModelId),
        '使用模型:',
        this.selectedReasoningEffort,
        this.selectedServiceTier,
        this.selectedResponseVerbosity
      );
      await this.getExecutionEngine()
        .getContextManager()
        .persistentStore.initSession(this.sessionId, this.options.subagentInfo);
      const persistentStore =
        this.getExecutionEngine().getContextManager().persistentStore;
      this.backgroundTaskChildIds = await persistentStore.loadBackgroundTaskChildIds(
        this.sessionId
      );
      this.backgroundTaskCompletionSettledIds.clear();
      const interruptedToolCalls = await persistentStore.loadInterruptedToolCalls(
        this.sessionId
      );
      const adoptedToolResults = new Map<string, SessionAdoptedToolResult>();
      const subagentSessionStore = AgentSessionStore.getInstance();
      const subagentOwner = {
        sessionId: this.sessionId,
        projectPath: this.workspaceRoot,
      };
      for (const call of interruptedToolCalls) {
        if (
          call.toolName !== 'Task' ||
          !call.input ||
          typeof call.input !== 'object' ||
          Array.isArray(call.input)
        ) {
          continue;
        }
        const childId = call.input.subagent_session_id;
        if (typeof childId !== 'string') continue;
        const child = subagentSessionStore.loadSession(childId);
        if (!child) continue;
        const adoption = buildSubagentResultAdoption(call, child, subagentOwner);
        if (adoption) adoptedToolResults.set(call.toolCallId, adoption);
      }
      const recovery = await persistentStore.recoverInterruptedTurn(this.sessionId, {
        adoptedToolResults,
      });
      if (recovery) {
        this.startupAdoptedToolResults = interruptedToolCalls.flatMap((call) => {
          const result = adoptedToolResults.get(call.toolCallId);
          return result ? [{ call, result }] : [];
        });
      }
      const goalHandoff = await persistentStore.loadLatestGoalFinalization(
        this.sessionId
      );
      const goalReconciliation = goalHandoff
        ? await this.goalStore.reconcileFinalizationReceipt(
            goalHandoff.finalization.goalFinalization!
          )
        : null;
      if (goalReconciliation?.finalized) {
        Bus.publish(
          { sessionId: this.sessionId, projectPath: this.workspaceRoot },
          'goal.updated',
          { goal: goalReconciliation.goal }
        );
      }
      this.startupTurnRecovery =
        recovery ??
        (goalHandoff && goalReconciliation?.finalized
          ? {
              turnId: goalHandoff.turnId,
              outcome: 'completed',
              inputMessageIds: goalHandoff.finalization.inputMessageIds,
              hadSuccessfulToolResult: false,
              emptyFinalCorrectionSpent: false,
              finalization: goalHandoff.finalization,
            }
          : undefined);
      if (this.startupTurnRecovery?.outcome === 'completed') {
        await this.reloadPendingInbox();
      }
      await this.recoverTeamLeadMessages();
      await this.reconcileBackgroundSubagentCompletions();
      if (recovery) {
        logger.warn(
          `[SessionRuntime ${this.sessionId}] recovered ${recovery.outcome} turn ${recovery.turnId}`
        );
      }

      this.initialized = true;
      logger.debug(
        `[SessionRuntime ${this.sessionId}] initialized with ${this.baseRegistry.getAll().length} tools`
      );
    } catch (error) {
      try {
        await this.dispose();
      } catch (cleanupError) {
        logger.warn(
          `[SessionRuntime ${this.sessionId}] Failed to clean up after initialization error`,
          cleanupError
        );
      }
      throw error;
    }
  }

  async refresh(options: Partial<SessionRuntimeOptions>): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
      return;
    }

    const clearsSelection = options.modelId === 'inherit';
    const requestedModelId =
      options.modelId && !clearsSelection ? options.modelId : undefined;
    const nextModelId = clearsSelection
      ? this.getDefaultModel()?.id
      : (requestedModelId ?? this.selectedModelId ?? this.getDefaultModel()?.id);
    const nextReasoningEffort = options.reasoningEffort ?? this.selectedReasoningEffort;
    const nextServiceTier = options.serviceTier ?? this.selectedServiceTier;
    const nextResponseVerbosity =
      options.responseVerbosity ?? this.selectedResponseVerbosity;
    const nextCommunicationStyle =
      options.communicationStyle ?? this.selectedCommunicationStyle;
    resolveCommunicationStyle(
      nextCommunicationStyle,
      this.getCommunicationStyleCatalog()
    );
    if (
      nextModelId &&
      (nextModelId !== this.currentModelId ||
        nextReasoningEffort !== this.selectedReasoningEffort ||
        nextServiceTier !== this.selectedServiceTier ||
        nextResponseVerbosity !== this.selectedResponseVerbosity)
    ) {
      await this.applyModelConfig(
        this.resolveModelConfig(nextModelId),
        nextModelId !== this.currentModelId
          ? '切换模型'
          : nextReasoningEffort !== this.selectedReasoningEffort
            ? '切换推理强度'
            : nextServiceTier !== this.selectedServiceTier
              ? '切换服务等级'
              : '切换输出详略',
        nextReasoningEffort,
        nextServiceTier,
        nextResponseVerbosity
      );
    }
    if (clearsSelection) {
      this.selectedModelId = undefined;
    } else if (requestedModelId) {
      this.selectedModelId = requestedModelId;
    }
    this.selectedReasoningEffort = nextReasoningEffort;
    this.selectedServiceTier = nextServiceTier;
    this.selectedResponseVerbosity = nextResponseVerbosity;
    this.selectedCommunicationStyle = nextCommunicationStyle;
  }

  createToolExecutor(options: AgentOptions = {}): ToolExecutor {
    const registry = new ToolRegistry();
    registry.setMcpCatalogBarrier(this.mcpCatalogBarrier);
    const allowed = options.toolWhitelist ? new Set(options.toolWhitelist) : null;
    const blocked = options.toolBlacklist ? new Set(options.toolBlacklist) : null;

    for (const tool of this.baseRegistry.getBuiltinTools()) {
      if (blocked?.has(tool.name)) continue;
      if (!allowed || allowed.has(tool.name)) {
        registry.register(tool);
      }
    }
    registry.replaceMcpTools(
      this.filterMcpTools(this.baseRegistry.getMcpTools(), allowed, blocked)
    );
    const instructions = this.getMcpInstructions();
    registry.queueMcpInstructionsChange({
      revision: instructions.revision,
      reason: 'snapshot',
      replace: true,
      instructions: instructions.instructions,
      removed: [],
    });
    const taskVisible = ['TaskOutput', 'ListMcpTasks', 'CancelMcpTask'].some(
      (name) => !blocked?.has(name) && (!allowed || allowed.has(name))
    );
    if (taskVisible) {
      for (const task of McpTaskManager.getInstance().list({
        sessionId: this.sessionId,
        projectPath: this.workspaceRoot,
      })) {
        const { result: _result, ...projection } = task;
        registry.queueMcpTaskChange({
          revision: 0,
          ...projection,
        });
      }
    }
    this.executorCatalogs.set(registry, { allowed, blocked });

    const permissions: PermissionConfig = {
      ...this.config.permissions,
      ...options.permissions,
    };
    const permissionMode =
      options.permissionMode ?? this.config.permissionMode ?? PermissionMode.DEFAULT;

    return new ToolExecutor(registry, {
      permissionConfig: permissions,
      permissionMode,
      approvalStore: this.approvalStore,
      maxHistorySize: 1000,
      toolWhitelist: options.toolWhitelist,
      toolBlacklist: options.toolBlacklist,
      contextDefaults: {
        sessionId: this.sessionId,
        workspaceRoot: this.workspaceRoot,
        environment: this.sessionEnvironment,
        permissionMode,
        foregroundCommandHandoffMs: this.config.bashForegroundHandoffMs,
        mcpSamplingHandler: this.handleMcpSampling,
        notifyBackgroundSubagentCompleted: (agentId) =>
          this.notifyBackgroundSubagentCompleted(agentId),
        registerBackgroundSubagent: (agentId) =>
          this.registerBackgroundSubagent(agentId),
      },
      ...(this.lspManager ? { lspManager: this.lspManager } : {}),
      ...(permissionMode === PermissionMode.YOLO && this.autoVerifyRuntime
        ? { autoVerifyRuntime: this.autoVerifyRuntime }
        : {}),
      onDispose: () => {
        this.executorCatalogs.delete(registry);
      },
    });
  }

  /** @deprecated Use createToolExecutor() for new code. */
  createExecutionPipeline(options: AgentOptions = {}): ToolExecutor {
    return this.createToolExecutor(options);
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    let firstError: unknown;
    const attempt = async (label: string, cleanup: () => Promise<void> | void) => {
      try {
        await cleanup();
      } catch (error) {
        firstError ??= error;
        logger.warn(
          `[SessionRuntime ${this.sessionId}] Failed to ${label} during cleanup`,
          error
        );
      }
    };
    const disposableChatService = this.chatService as
      | (IChatService & { dispose?: () => Promise<void> | void })
      | undefined;
    const sessionMcpRegistry = this.sessionMcpRegistry;
    const mcpCatalogListener = this.mcpCatalogListener;
    const mcpContentCatalogListener = this.mcpContentCatalogListener;
    const mcpResourceUpdatedListener = this.mcpResourceUpdatedListener;
    const mcpConnectionListener = this.mcpConnectionListener;
    const mcpLogListener = this.mcpLogListener;
    const mcpInstructionsListener = this.mcpInstructionsListener;
    const mcpTaskListener = this.mcpTaskListener;
    const sessionLease = this.sessionLease;
    const autoVerifyRuntime = this.autoVerifyRuntime;
    const lspManager = this.lspManager;
    await attempt('stop side conversations', () =>
      this.sideConversationOperations.shutdown('session-runtime-dispose')
    );
    this.signalBackgroundSubagentCompletionWaiters();
    this.chatService = undefined;
    this.executionEngine = undefined;
    this.activeTurnMailbox = undefined;
    this.startupTurnRecovery = undefined;
    this.startupAdoptedToolResults = [];
    this.backgroundTaskChildIds.clear();
    this.backgroundTaskCompletionSettledIds.clear();
    this.currentModelMaxContextTokens = undefined;
    this.baseRegistry = new ToolRegistry();
    this.sessionMcpRegistry = undefined;
    this.mcpCatalogListener = undefined;
    this.mcpContentCatalogListener = undefined;
    this.mcpResourceUpdatedListener = undefined;
    this.mcpConnectionListener = undefined;
    this.mcpLogListener = undefined;
    this.mcpInstructionsListener = undefined;
    this.mcpTaskListener = undefined;
    this.mcpCatalogBarrier = async () => undefined;
    this.executorCatalogs.clear();
    this.sessionLease = undefined;
    this.autoVerifyRuntime = undefined;
    this.lspManager = undefined;

    await attempt('kill the session background processes', () =>
      BackgroundShellManager.getInstance().killSession(this.sessionId)
    );
    await attempt('clear the session approvals', () => this.approvalStore.clear());
    await attempt('clear the session file access records', () =>
      FileAccessTracker.getInstance().clearSession(this.sessionId, this.workspaceRoot)
    );
    await attempt('stop the session auto-verification processes', () =>
      autoVerifyRuntime?.dispose()
    );
    await attempt('stop the session LSP servers', () => lspManager?.dispose());
    await attempt('release the session hook model resources', () =>
      HookManager.getInstance().unbindSessionModelResources(this.sessionId, [
        this.projectRoot,
        this.workspaceRoot,
      ])
    );
    await attempt('release the session worktrees', () =>
      worktreeManager.releaseSession(this.sessionId)
    );
    await attempt('dispose the session chat service', () =>
      disposableChatService?.dispose?.()
    );
    await attempt('cancel the session MCP tasks', () =>
      McpTaskManager.getInstance().cancelSession({
        sessionId: this.sessionId,
        projectPath: this.workspaceRoot,
      })
    );
    await attempt('disconnect the session MCP servers', async () => {
      if (sessionMcpRegistry && mcpCatalogListener) {
        sessionMcpRegistry.off('catalogChanged', mcpCatalogListener);
      }
      if (sessionMcpRegistry && mcpContentCatalogListener) {
        sessionMcpRegistry.off('contentCatalogChanged', mcpContentCatalogListener);
      }
      if (sessionMcpRegistry && mcpResourceUpdatedListener) {
        sessionMcpRegistry.off('resourceUpdated', mcpResourceUpdatedListener);
      }
      if (sessionMcpRegistry && mcpConnectionListener) {
        sessionMcpRegistry.off('connectionLifecycleChanged', mcpConnectionListener);
      }
      if (sessionMcpRegistry && mcpLogListener) {
        sessionMcpRegistry.off('log', mcpLogListener);
      }
      if (sessionMcpRegistry && mcpInstructionsListener) {
        sessionMcpRegistry.off('instructionsChanged', mcpInstructionsListener);
      }
      if (mcpTaskListener) {
        McpTaskManager.getInstance().off('taskChanged', mcpTaskListener);
      }
      await sessionMcpRegistry?.disconnectAll();
    });
    await attempt('release the session lease', () => sessionLease?.release());

    this.currentModelId = undefined;
    this.currentReasoning = undefined;
    this.currentServiceTier = undefined;
    this.initialized = false;

    if (firstError !== undefined) {
      throw firstError;
    }
  }

  private resolveModelConfig(requestedModelId?: string): ModelConfig {
    const modelId =
      requestedModelId && requestedModelId !== 'inherit' ? requestedModelId : undefined;
    const modelConfig = modelId
      ? this.config.models.find((model) => model.id === modelId)
      : this.getDefaultModel();
    if (!modelConfig) {
      throw new Error(`模型配置未找到: ${modelId ?? 'current'}`);
    }
    return modelConfig;
  }

  private getDefaultModel(): ModelConfig | undefined {
    return (
      this.config.models.find((model) => model.id === this.config.currentModelId) ??
      this.config.models[0]
    );
  }

  private getActiveTurnMailbox(): ActiveTurnMailbox {
    if (!this.activeTurnMailbox) {
      throw new Error('Session runtime is not initialized');
    }
    return this.activeTurnMailbox;
  }

  private async saveTurnStart(
    handle: ActiveTurnHandle,
    kind: SessionTurnKind,
    inputMessageIds: string[] = []
  ): Promise<void> {
    await this.getExecutionEngine()
      .getContextManager()
      .persistentStore.saveTurnStart(this.sessionId, {
        turnId: handle.id,
        kind,
        startedAt: new Date().toISOString(),
        ...(inputMessageIds.length > 0 ? { inputMessageIds } : {}),
      });
  }

  private assertRewindIdle(): void {
    if (this.hasTurnOwner()) {
      throw new Error('Cannot rewind while the session has an active turn');
    }
    if (this.getPendingSteeringCount() > 0) {
      throw new Error('Cannot rewind while durable input is pending');
    }
    if (
      BackgroundShellManager.getInstance()
        .listForSession(this.sessionId)
        .some((process) => process.status === 'running')
    ) {
      throw new Error('Cannot rewind while a background shell is running');
    }
    if (
      BackgroundAgentManager.getInstance()
        .listForSession({
          sessionId: this.sessionId,
          projectPath: this.workspaceRoot,
        })
        .some((session) => session.status === 'running')
    ) {
      throw new Error('Cannot rewind while a background agent is running');
    }
  }

  private assertSubagentControlIdle(): void {
    if (this.hasTurnOwner()) {
      throw new Error('Cannot resume a subagent while the session has an active turn');
    }
    if (this.getPendingSteeringCount() > 0) {
      throw new Error('Cannot resume a subagent while durable input is pending');
    }
  }

  private async applyModelConfig(
    modelConfig: ModelConfig,
    label: string,
    reasoningEffort: ReasoningEffortSelection,
    serviceTier: ServiceTierSelection,
    responseVerbosity: ResponseVerbositySelection
  ): Promise<void> {
    const resolved = resolvePiModelConfig(
      modelConfig,
      this.config,
      reasoningEffort,
      this.modelResources.catalog,
      serviceTier,
      responseVerbosity
    );
    logger.debug(`${label} ${resolved.displayName} (${modelConfig.model})`);
    const nextModelMaxContextTokens = resolved.model.contextWindow;
    const nextChatService = await createChatServiceAsync(resolved.chat);

    const previousChatService = this.initialized ? this.chatService : undefined;
    const contextManager = this.executionEngine?.getContextManager();
    this.chatService = nextChatService;
    this.executionEngine = new ExecutionEngine(
      nextChatService,
      contextManager,
      this.workspaceRoot
    );
    this.currentModelMaxContextTokens = nextModelMaxContextTokens;
    this.currentModelId = modelConfig.id;
    this.currentReasoning = resolved.reasoning;
    this.currentServiceTier = resolved.serviceTier;
    this.currentResponseVerbosity = resolved.responseVerbosity;

    const disposablePreviousService = previousChatService as
      | (IChatService & { dispose?: () => Promise<void> | void })
      | undefined;
    try {
      await disposablePreviousService?.dispose?.();
    } catch (error) {
      logger.warn(
        `[SessionRuntime ${this.sessionId}] Failed to dispose previous model service`,
        error
      );
    }
  }

  private async validateSystemPromptConfig(): Promise<void> {
    const staticProjectRules = this.getStaticProjectRules();
    if (
      this.options.projectInstructionsDigest &&
      staticProjectRules.provenanceSha256 !== this.options.projectInstructionsDigest
    ) {
      throw new Error('Project instruction provenance mismatch');
    }
    if (
      !this.options.subagentInfo &&
      staticProjectRules.files.length > 0 &&
      !this.options.projectInstructionsDigest
    ) {
      await this.persistSystemPromptProvenance({
        projectInstructionsDigest: staticProjectRules.provenanceSha256,
      });
      this.options.projectInstructionsDigest = staticProjectRules.provenanceSha256;
    }
    const communicationStyle = this.resolveCommunicationStyleConfiguration(
      this.selectedCommunicationStyle
    );
    if (
      communicationStyle.source !== 'built-in' &&
      this.options.communicationStyleDigest &&
      communicationStyle.contentSha256 !== this.options.communicationStyleDigest
    ) {
      throw new Error(
        `Communication style provenance mismatch: ${this.selectedCommunicationStyle}`
      );
    }
    if (
      communicationStyle.source !== 'built-in' &&
      communicationStyle.contentSha256 &&
      !this.options.communicationStyleDigest
    ) {
      await this.persistSystemPromptProvenance({
        communicationStyleDigest: communicationStyle.contentSha256,
      });
      this.options.communicationStyleDigest = communicationStyle.contentSha256;
    }
    try {
      await buildSystemPrompt({
        projectPath: this.workspaceRoot,
        includeEnvironment: false,
        language: this.config.language,
        availableSkills:
          this.agentResources?.skills.generateAvailableSkillsList() ?? '',
        communicationStyle: this.selectedCommunicationStyle,
        communicationStyleCatalog: this.getCommunicationStyleCatalog(),
        projectRuleCatalog: this.getProjectRuleCatalog(),
        projectInstructionSourcePath: this.projectRoot,
      });
    } catch (error) {
      logger.warn(
        '[SessionRuntime] Failed to validate system prompt configuration:',
        error
      );
    }
  }

  private async persistSystemPromptProvenance(update: {
    communicationStyleDigest?: string;
    projectInstructionsDigest?: string;
  }): Promise<void> {
    try {
      await SessionService.updateSessionMetadata(
        this.sessionId,
        this.workspaceRoot,
        update
      );
    } catch (error) {
      const isMissingCreation =
        error instanceof SessionMissingCreationError ||
        (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (!isMissingCreation || this.options.subagentInfo) throw error;
      await SessionService.createSessionMetadata(
        this.sessionId,
        this.workspaceRoot,
        update
      );
    }
  }

  private async registerBuiltinTools(): Promise<void> {
    const builtinTools = await getBuiltinTools({
      sessionId: this.sessionId,
      configDir: getBladeStorageRoot(),
      workspaceRoot: this.workspaceRoot,
      resourceRoot: this.projectRoot,
      agentResources: this.agentResources,
      modelResources: this.modelResources,
      lspManager: this.lspManager,
      lspResources: this.lspResources,
      getReasoningEffort: () => this.selectedReasoningEffort,
      getServiceTier: () => this.selectedServiceTier,
      getResponseVerbosity: () => this.selectedResponseVerbosity,
      getCommunicationStyle: () => this.selectedCommunicationStyle,
      agentTeamsEnabled: this.config.agentTeamsEnabled === true,
    });

    const builtin = builtinTools.filter((tool) => !tool.name.startsWith('mcp__'));

    this.baseRegistry.registerAll(builtin);

    await this.registerMcpTools();
  }

  private async registerMcpTools(): Promise<void> {
    try {
      const mcpServers = this.options.mcpServers ?? {};
      if (Object.keys(mcpServers).length === 0) {
        return;
      }

      const registry = McpRegistry.createIsolated({
        roots: isAcpMode(this.sessionId) ? [] : [this.workspaceRoot],
        samplingAvailable: true,
        oauthCredentialAccess: !isAcpMode(this.sessionId),
        artifactWriter: new McpToolArtifactStore(
          `${this.projectRoot}\0${this.sessionId}`,
          {
            exposePaths: !isAcpMode(this.sessionId),
          }
        ),
        exposeLogDetails: !isAcpMode(this.sessionId),
        exposeInstructions: !isAcpMode(this.sessionId),
      });
      this.sessionMcpRegistry = registry;
      this.mcpCatalogBarrier = () => registry.waitForCatalogIdle();
      this.baseRegistry.setMcpCatalogBarrier(this.mcpCatalogBarrier);
      const catalogListener = (change: McpCatalogChange) => {
        this.applyMcpCatalog(change, this.initialized);
      };
      this.mcpCatalogListener = catalogListener;
      registry.on('catalogChanged', catalogListener);
      const contentCatalogListener = (change: McpContentCatalogChange) => {
        this.applyMcpContentCatalog(change);
      };
      const resourceUpdatedListener = (update: McpResourceUpdated) => {
        this.applyMcpResourceUpdated(update);
      };
      const connectionListener = (change: McpConnectionLifecycleChange) => {
        this.applyMcpConnectionChange(change);
      };
      const logListener = (entry: McpLogEntry) => {
        this.applyMcpLog(entry);
      };
      const instructionsListener = (change: McpInstructionsChange) => {
        this.applyMcpInstructions(change);
      };
      const taskListener = (change: McpTaskChange) => {
        if (
          change.owner.sessionId !== this.sessionId ||
          path.resolve(change.owner.projectPath) !== path.resolve(this.workspaceRoot)
        ) {
          return;
        }
        this.applyMcpTask(change);
        const { owner: _owner, result: _result, ...projection } = change;
        Bus.publish(
          {
            sessionId: this.sessionId,
            projectPath: this.workspaceRoot,
          },
          'mcp.task.changed',
          projection
        );
      };
      this.mcpContentCatalogListener = contentCatalogListener;
      this.mcpResourceUpdatedListener = resourceUpdatedListener;
      this.mcpConnectionListener = connectionListener;
      this.mcpLogListener = logListener;
      this.mcpInstructionsListener = instructionsListener;
      this.mcpTaskListener = taskListener;
      registry.on('contentCatalogChanged', contentCatalogListener);
      registry.on('resourceUpdated', resourceUpdatedListener);
      registry.on('connectionLifecycleChanged', connectionListener);
      registry.on('log', logListener);
      registry.on('instructionsChanged', instructionsListener);
      McpTaskManager.getInstance().on('taskChanged', taskListener);
      for (const [name, config] of Object.entries(mcpServers)) {
        try {
          const environment =
            config.type === 'stdio'
              ? {
                  ...this.sessionEnvironment,
                  ...config.env,
                }
              : undefined;
          await registry.registerServer(
            name,
            config.type === 'stdio'
              ? {
                  ...config,
                  ...(environment && Object.keys(environment).length > 0
                    ? { env: environment }
                    : {}),
                }
              : config
          );
        } catch (error) {
          logger.warn(`Warning: MCP server "${name}" connection failed:`, error);
        }
      }

      this.baseRegistry.replaceMcpTools(registry.getCatalogSnapshot().tools);
      this.baseRegistry.registerAll(createMcpContentTools(registry));
      this.baseRegistry.registerAll(createMcpTaskTools(registry));
    } catch (error) {
      logger.warn('Failed to register MCP tools:', error);
    }
  }

  private filterMcpTools(
    tools: readonly Tool[],
    allowed: ReadonlySet<string> | null,
    blocked: ReadonlySet<string> | null
  ): Tool[] {
    return tools.filter(
      (tool) => !blocked?.has(tool.name) && (!allowed || allowed.has(tool.name))
    );
  }

  private applyMcpCatalog(change: McpCatalogChange, announce: boolean): void {
    this.baseRegistry.replaceMcpTools(change.tools);
    for (const [registry, filters] of this.executorCatalogs) {
      const filteredTools = this.filterMcpTools(
        change.tools,
        filters.allowed,
        filters.blocked
      );
      const include = (name: string) =>
        !filters.blocked?.has(name) && (!filters.allowed || filters.allowed.has(name));
      const projected = {
        revision: change.revision,
        serverName: change.serverName,
        reason: change.reason,
        added: change.added.filter(include),
        removed: change.removed.filter(include),
        updated: change.updated.filter(include),
      };
      const hasProjectedChanges =
        projected.added.length > 0 ||
        projected.removed.length > 0 ||
        projected.updated.length > 0;
      registry.replaceMcpTools(
        filteredTools,
        announce && hasProjectedChanges ? projected : undefined
      );
    }
  }

  private applyMcpContentCatalog(change: McpContentCatalogChange): void {
    if (!this.initialized) return;
    const requiredTools =
      change.kind === 'resources'
        ? ['ListMcpResources', 'ReadMcpResource']
        : change.kind === 'resourceTemplates'
          ? ['ListMcpResourceTemplates', 'CompleteMcpArgument']
          : ['ListMcpPrompts', 'CompleteMcpArgument', 'GetMcpPrompt'];
    for (const [registry, filters] of this.executorCatalogs) {
      const visible = requiredTools.some(
        (name) =>
          !filters.blocked?.has(name) && (!filters.allowed || filters.allowed.has(name))
      );
      if (visible) registry.queueMcpContentChange(change);
    }
  }

  private applyMcpResourceUpdated(update: McpResourceUpdated): void {
    if (!this.initialized) return;
    for (const [registry, filters] of this.executorCatalogs) {
      const visible =
        !filters.blocked?.has('ReadMcpResource') &&
        (!filters.allowed || filters.allowed.has('ReadMcpResource'));
      if (visible) registry.queueMcpResourceUpdated(update);
    }
  }

  private applyMcpConnectionChange(change: McpConnectionLifecycleChange): void {
    if (!this.initialized) return;
    for (const registry of this.executorCatalogs.keys()) {
      registry.queueMcpConnectionChange(change);
    }
  }

  private applyMcpLog(entry: McpLogEntry): void {
    if (!this.initialized) return;
    for (const registry of this.executorCatalogs.keys()) {
      registry.queueMcpLog(entry);
    }
  }

  private applyMcpInstructions(change: McpInstructionsChange): void {
    if (!this.initialized) return;
    for (const registry of this.executorCatalogs.keys()) {
      registry.queueMcpInstructionsChange({
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
    }
  }

  private applyMcpTask(change: McpTaskChange): void {
    if (!this.initialized) return;
    const { owner: _owner, result: _result, ...projection } = change;
    for (const [registry, filters] of this.executorCatalogs) {
      const visible = ['TaskOutput', 'ListMcpTasks', 'CancelMcpTask'].some(
        (name) =>
          !filters.blocked?.has(name) && (!filters.allowed || filters.allowed.has(name))
      );
      if (visible) registry.queueMcpTaskChange(projection);
    }
  }

  private readonly handleMcpSampling: McpSamplingHandler = async (request, signal) => {
    const service = this.getChatService();
    const response = await service.chat(request.messages, undefined, signal, {
      maxOutputTokens: request.maxTokens,
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
    });
    return finalizeMcpSamplingResponse(response, service.getConfig().model, request);
  };

  private async loadAgentResources(): Promise<void> {
    const resources = this.options.agentResources
      ? this.options.agentResources
      : await resolveWorkspaceAgentResources(this.projectRoot, {
          reconcilePlugins: true,
        });
    this.agentResources = snapshotWorkspaceAgentResources(resources);
    this.subagentRegistry = this.agentResources.subagents;
    if (this.options.agents?.length) {
      this.subagentRegistry.applyOverrides(this.options.agents);
    }
  }
}

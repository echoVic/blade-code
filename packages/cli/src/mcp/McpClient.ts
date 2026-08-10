/**
 * MCP 客户端（SDK 版本 + 增强功能）
 * 使用官方 @modelcontextprotocol/sdk
 * 支持重试、自动重连、错误分类、OAuth 认证、健康监控
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolResultSchema,
  CreateMessageRequestSchema,
  ElicitationCompleteNotificationSchema,
  ElicitRequestSchema,
  ErrorCode,
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  McpError,
  ResourceUpdatedNotificationSchema,
  TaskStatusNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { EventEmitter } from 'events';
import open from 'open';
import type { McpServerConfig } from '../config/types.js';
import { HookManager } from '../hooks/HookManager.js';
import {
  CONFIRMATION_ABORTED_REASON,
  type ConfirmationHandler,
  type ExecutionContext,
  type ToolProgressUpdate,
} from '../tools/types/ExecutionTypes.js';
import { ToolKind } from '../tools/types/ToolTypes.js';
import { getPackageName, getVersion } from '../utils/packageInfo.js';
import {
  McpOAuthAuthorizationRequiredError,
  type McpOAuthLoginHandle,
  type McpOAuthStatus,
  McpOAuthUnavailableError,
  normalizeMcpOAuthConfig,
  OAuthProvider,
  OAuthTokenStorage,
  safeMcpOAuthFetch,
} from './auth/index.js';
import { type HealthCheckConfig, HealthMonitor } from './HealthMonitor.js';
import { normalizeMcpCallLifecycle, normalizeMcpProgress } from './McpCallLifecycle.js';
import {
  MAX_MCP_COMPLETION_CONCURRENCY,
  MCP_COMPLETION_TIMEOUT_MS,
  type McpCompletionInput,
  type McpNormalizedCompletionResult,
  normalizeMcpCompletionResult,
  validateMcpCompletionInput,
} from './McpCompletion.js';
import {
  createMcpRecoveryAbortError,
  getMcpRecoveryDelay,
  isMcpSessionExpiredError,
  isTerminalMcpTransportError,
  MAX_MCP_RECOVERY_ATTEMPTS,
  MAX_MCP_RECOVERY_DELAY_MS,
  type McpClientConnectionLifecycleChange,
  type McpRecoveryPolicy,
  type McpRecoveryReason,
  normalizeMcpRecoveryPolicy,
  sanitizeMcpConnectionError,
  waitForMcpRecoveryDelay,
} from './McpConnectionRecovery.js';
import {
  diffMcpContentCatalog,
  hasMcpContentChanges,
  MAX_MCP_CONTENT_PAGES,
  MAX_MCP_PROMPTS,
  MAX_MCP_RESOURCE_SUBSCRIPTIONS,
  MAX_MCP_RESOURCE_TEMPLATES,
  MAX_MCP_RESOURCES,
  type McpContentCatalogDelta,
  type McpContentCatalogKind,
  type McpContentCatalogSnapshot,
  type McpNormalizedPromptResult,
  type McpNormalizedResourceResult,
  type McpPromptDefinition,
  type McpResourceDefinition,
  type McpResourceTemplateDefinition,
  normalizeMcpPromptResult,
  normalizeMcpPrompts,
  normalizeMcpResourceResult,
  normalizeMcpResources,
  normalizeMcpResourceTemplates,
} from './McpContentCatalog.js';
import {
  type McpElicitationAction,
  type McpElicitationResponse,
  normalizeMcpElicitation,
  validateMcpElicitationResponse,
} from './McpElicitation.js';
import {
  createMcpLogRateLimitEntry,
  isMcpLogLevel,
  isMcpLogLevelEnabled,
  MAX_MCP_LOG_EVENTS_PER_SECOND,
  type McpClientLogEntry,
  type McpLoggingPolicy,
  type McpLogLevel,
  normalizeMcpLogEntry,
  normalizeMcpLoggingPolicy,
} from './McpLogging.js';
import {
  type McpSamplingHandler,
  normalizeMcpSamplingPolicy,
  normalizeMcpSamplingRequest,
} from './McpSampling.js';
import {
  type McpServerInstruction,
  normalizeMcpServerInstruction,
} from './McpServerInstructions.js';
import {
  type McpServerTaskState,
  type McpTaskPolicy,
  normalizeMcpServerTask,
  normalizeMcpTaskPolicy,
} from './McpTasks.js';
import {
  diffMcpToolCatalog,
  hasMcpCatalogChanges,
  MAX_MCP_TOOL_PAGES,
  MAX_MCP_TOOLS_PER_SERVER,
  type McpToolCatalogDelta,
  normalizeMcpToolCatalog,
} from './McpToolCatalog.js';
import {
  type McpNormalizedToolResult,
  type McpToolArtifactWriter,
  normalizeMcpToolResult,
} from './McpToolResult.js';
import {
  McpConnectionStatus,
  type McpToolCallResponse,
  type McpToolDefinition,
} from './types.js';

/**
 * 错误类型枚举
 */
export enum ErrorType {
  NETWORK_TEMPORARY = 'network_temporary', // 临时网络错误（可重试）
  NETWORK_PERMANENT = 'network_permanent', // 永久网络错误
  CONFIG_ERROR = 'config_error', // 配置错误
  AUTH_ERROR = 'auth_error', // 认证错误
  PROTOCOL_ERROR = 'protocol_error', // 协议错误
  UNKNOWN = 'unknown', // 未知错误
}

/**
 * 分类后的错误
 */
interface ClassifiedError {
  type: ErrorType;
  isRetryable: boolean;
  originalError: Error;
}

export interface McpInteractionContext {
  confirmationHandler?: ConfirmationHandler;
  samplingHandler?: McpSamplingHandler;
  progressHandler?: (update: ToolProgressUpdate) => void;
  signal?: AbortSignal;
  sessionId?: ExecutionContext['sessionId'];
  workspaceRoot?: ExecutionContext['workspaceRoot'];
  permissionMode?: ExecutionContext['permissionMode'];
}

interface McpActiveInteraction {
  token: symbol;
  context: McpInteractionContext;
  samplingRequests: number;
  samplingInFlight: boolean;
}

export interface McpClientRuntimeOptions {
  roots?: readonly string[];
  samplingAvailable?: boolean;
  oauthCredentialAccess?: boolean;
  oauthStorageRoot?: string;
  recoveryRandom?: () => number;
  artifactWriter?: McpToolArtifactWriter;
  exposeLogDetails?: boolean;
  exposeInstructions?: boolean;
}

export interface McpClientToolCatalogChange extends McpToolCatalogDelta {
  revision: number;
  reason: 'initial' | 'notification' | 'manual';
}

export interface McpClientContentCatalogChange extends McpContentCatalogDelta {
  revision: number;
  kind: McpContentCatalogKind;
  reason: 'initial' | 'notification' | 'manual';
}

/**
 * 错误分类函数
 */
function classifyError(error: unknown): ClassifiedError {
  if (
    error instanceof McpOAuthAuthorizationRequiredError ||
    error instanceof McpOAuthUnavailableError
  ) {
    return {
      type: ErrorType.AUTH_ERROR,
      isRetryable: false,
      originalError: error,
    };
  }
  if (!(error instanceof Error)) {
    return {
      type: ErrorType.UNKNOWN,
      isRetryable: false,
      originalError: new Error(String(error)),
    };
  }

  const msg = error.message.toLowerCase();

  // 永久性配置错误（不应重试）
  const permanentErrors = [
    'command not found',
    'no such file',
    'permission denied',
    'invalid configuration',
    'malformed',
    'syntax error',
  ];

  if (permanentErrors.some((permanent) => msg.includes(permanent))) {
    return {
      type: ErrorType.CONFIG_ERROR,
      isRetryable: false,
      originalError: error,
    };
  }

  // 认证错误（不应自动重试，需要用户介入）
  if (
    msg.includes('unauthorized') ||
    msg.includes('401') ||
    msg.includes('authentication failed')
  ) {
    return {
      type: ErrorType.AUTH_ERROR,
      isRetryable: false,
      originalError: error,
    };
  }

  // 临时网络错误（可重试）
  const temporaryErrors = [
    'timeout',
    'connection refused',
    'network error',
    'temporary',
    'try again',
    'rate limit',
    'too many requests',
    'service unavailable',
    'socket hang up',
    'econnreset',
    'enotfound',
    'econnrefused',
    'etimedout',
    '503',
    '429',
  ];

  if (temporaryErrors.some((temporary) => msg.includes(temporary))) {
    return {
      type: ErrorType.NETWORK_TEMPORARY,
      isRetryable: true,
      originalError: error,
    };
  }

  // 默认视为临时错误（保守策略：允许重试）
  return {
    type: ErrorType.UNKNOWN,
    isRetryable: true,
    originalError: error,
  };
}

/**
 * MCP客户端
 */
export class McpClient extends EventEmitter {
  private status: McpConnectionStatus = McpConnectionStatus.DISCONNECTED;
  private sdkClient: Client | null = null;
  private tools = new Map<string, McpToolDefinition>();
  private toolCatalogRevision = 0;
  private toolRefreshPromise?: Promise<void>;
  private toolRefreshRequested = false;
  private resources: McpResourceDefinition[] = [];
  private resourceTemplates: McpResourceTemplateDefinition[] = [];
  private prompts: McpPromptDefinition[] = [];
  private contentCatalogRevision = 0;
  private contentRefreshPromise?: Promise<void>;
  private requestedContentCatalogs = new Set<'resources' | 'prompts'>();
  private contentRefreshReason: McpClientContentCatalogChange['reason'] = 'manual';
  private catalogGeneration = 0;
  private desiredResourceSubscriptions = new Set<string>();
  private activeResourceSubscriptions = new Set<string>();
  private serverInfo: { name: string; version: string } | null = null;
  private serverInstructions?: McpServerInstruction;
  private completionCallsInFlight = 0;
  private loggingPolicy: McpLoggingPolicy;
  private logWindowStartedAt = 0;
  private logEventsInWindow = 0;
  private logRateWarningEmitted = false;

  private readonly recoveryPolicy: McpRecoveryPolicy;
  private desiredConnected = false;
  private connectionGeneration = 0;
  private connectPromise?: Promise<void>;
  private connectAbortController?: AbortController;
  private recoveryPromise?: Promise<void>;
  private recoveryAbortController?: AbortController;
  private recoveryState?: McpClientConnectionLifecycleChange;
  private consecutiveTerminalErrors = 0;

  // OAuth 支持
  private oauthProvider: OAuthProvider | null = null;
  private serverName: string;

  // 健康监控
  private healthMonitor: HealthMonitor | null = null;
  private activeInteraction?: McpActiveInteraction;
  private readonly taskInteractions = new Map<string, McpActiveInteraction>();
  private readonly taskPolicy: McpTaskPolicy;
  private readonly roots: Array<{ uri: string; name: string }>;

  constructor(
    private config: McpServerConfig,
    serverName?: string,
    healthCheckConfig?: HealthCheckConfig,
    private readonly runtimeOptions: McpClientRuntimeOptions = {}
  ) {
    super();
    this.serverName = serverName || 'default';
    this.recoveryPolicy = normalizeMcpRecoveryPolicy(config);
    this.loggingPolicy = normalizeMcpLoggingPolicy(config);
    this.taskPolicy = normalizeMcpTaskPolicy(config.tasks);
    this.roots = (runtimeOptions.roots ?? []).map((root) => {
      const canonical = realpathSync.native(path.resolve(root));
      return {
        uri: pathToFileURL(canonical).href,
        name: path.basename(canonical) || canonical,
      };
    });

    const oauth = normalizeMcpOAuthConfig(config);
    this.config = {
      ...config,
      ...(oauth ? { oauth } : {}),
    };

    if (
      oauth?.enabled &&
      config.url &&
      runtimeOptions.oauthCredentialAccess !== false
    ) {
      this.oauthProvider = new OAuthProvider(
        this.serverName,
        config.url,
        oauth,
        runtimeOptions.oauthStorageRoot
          ? {
              tokenStorage: new OAuthTokenStorage(runtimeOptions.oauthStorageRoot),
            }
          : {}
      );
    }

    // 如果启用了健康监控，初始化 monitor
    if (healthCheckConfig?.enabled) {
      this.healthMonitor = new HealthMonitor(this, healthCheckConfig);

      // 转发健康监控事件
      this.healthMonitor.on('unhealthy', (failures, error) => {
        this.emit('unhealthy', failures, error);
      });
    }
  }

  get connectionStatus(): McpConnectionStatus {
    return this.status;
  }

  get availableTools(): McpToolDefinition[] {
    return Array.from(this.tools.values());
  }

  get contentCatalog(): McpContentCatalogSnapshot {
    return {
      resources: structuredClone(this.resources),
      resourceTemplates: structuredClone(this.resourceTemplates),
      prompts: structuredClone(this.prompts),
    };
  }

  get completionSupported(): boolean {
    return Boolean(this.sdkClient?.getServerCapabilities()?.completions);
  }

  get tasks(): McpTaskPolicy {
    return { ...this.taskPolicy };
  }

  get server(): { name: string; version: string } | null {
    return this.serverInfo;
  }

  get instructions(): McpServerInstruction | undefined {
    return this.serverInstructions
      ? structuredClone(this.serverInstructions)
      : undefined;
  }

  get healthCheck(): HealthMonitor | null {
    return this.healthMonitor;
  }

  get recovery(): McpClientConnectionLifecycleChange | undefined {
    return this.recoveryState ? structuredClone(this.recoveryState) : undefined;
  }

  get logging(): McpLoggingPolicy {
    return { ...this.loggingPolicy };
  }

  get oauthEnabled(): boolean {
    return this.config.oauth?.enabled === true;
  }

  async getOAuthStatus(): Promise<McpOAuthStatus> {
    if (!this.oauthEnabled) return 'disabled';
    if (this.runtimeOptions.oauthCredentialAccess === false) return 'unavailable';
    return this.oauthProvider?.getStatus() ?? 'error';
  }

  async beginOAuthLogin(
    options: { openBrowser?: boolean } = {}
  ): Promise<McpOAuthLoginHandle> {
    if (!this.oauthEnabled) {
      throw new Error(`MCP server "${this.serverName}" does not enable OAuth`);
    }
    if (this.runtimeOptions.oauthCredentialAccess === false || !this.oauthProvider) {
      throw new McpOAuthUnavailableError(this.serverName);
    }
    return options.openBrowser
      ? this.oauthProvider.openAuthorization()
      : this.oauthProvider.beginAuthorization();
  }

  async logoutOAuth(): Promise<void> {
    if (!this.oauthEnabled) {
      throw new Error(`MCP server "${this.serverName}" does not enable OAuth`);
    }
    if (this.runtimeOptions.oauthCredentialAccess === false || !this.oauthProvider) {
      throw new McpOAuthUnavailableError(this.serverName);
    }
    if (this.status !== McpConnectionStatus.DISCONNECTED) {
      await this.disconnect();
    }
    await this.oauthProvider.logout();
  }

  /**
   * 连接到MCP服务器（带重试）
   */
  async connect(): Promise<void> {
    return this.connectWithRetry(3, 1000);
  }

  /**
   * 连接到MCP服务器（支持重试）
   * @param maxRetries 最大重试次数
   * @param initialDelay 初始延迟（毫秒）
   */
  async connectWithRetry(maxRetries = 3, initialDelay = 1000): Promise<void> {
    if (
      !Number.isInteger(maxRetries) ||
      maxRetries < 1 ||
      maxRetries > MAX_MCP_RECOVERY_ATTEMPTS
    ) {
      throw new Error(
        `MCP connection maxRetries must be an integer between 1 and ${MAX_MCP_RECOVERY_ATTEMPTS}`
      );
    }
    if (
      !Number.isFinite(initialDelay) ||
      initialDelay < 0 ||
      initialDelay > MAX_MCP_RECOVERY_DELAY_MS
    ) {
      throw new Error(
        `MCP connection initialDelay must be between 0 and ${MAX_MCP_RECOVERY_DELAY_MS}`
      );
    }
    if (this.status === McpConnectionStatus.CONNECTED) return;
    if (this.recoveryPromise) return this.recoveryPromise;
    if (this.connectPromise) return this.connectPromise;

    this.desiredConnected = true;
    const generation = ++this.connectionGeneration;
    const controller = new AbortController();
    this.connectAbortController = controller;
    const promise = this.runInitialConnection(
      Math.max(1, maxRetries),
      Math.max(0, initialDelay),
      generation,
      controller.signal
    ).finally(() => {
      if (this.connectPromise === promise) this.connectPromise = undefined;
      if (this.connectAbortController === controller) {
        this.connectAbortController = undefined;
      }
    });
    this.connectPromise = promise;
    return promise;
  }

  private async runInitialConnection(
    maxRetries: number,
    initialDelay: number,
    generation: number,
    signal: AbortSignal
  ): Promise<void> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      this.assertConnectionGeneration(generation, signal);
      try {
        await this.doConnect(generation, false);
        return;
      } catch (error) {
        if (!this.isConnectionGenerationCurrent(generation) || signal.aborted) {
          throw createMcpRecoveryAbortError(signal.reason);
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        const classified = classifyError(lastError);
        if (!classified.isRetryable || attempt === maxRetries) break;
        await waitForMcpRecoveryDelay(
          initialDelay * 2 ** Math.max(0, attempt - 1),
          signal,
          false
        );
      }
    }

    const failure = lastError ?? new Error('MCP connection failed');
    if (this.isConnectionGenerationCurrent(generation)) {
      this.invalidateLiveConnection(false);
      this.setStatus(McpConnectionStatus.ERROR);
      this.emitClientError(failure);
    }
    throw failure;
  }

  private async doConnect(generation: number, recovering: boolean): Promise<void> {
    let client: Client | undefined;
    try {
      this.assertConnectionGeneration(generation);
      this.setStatus(
        recovering ? McpConnectionStatus.RECONNECTING : McpConnectionStatus.CONNECTING
      );
      const configuredSamplingPolicy = normalizeMcpSamplingPolicy(this.config.sampling);
      const samplingPolicy = {
        ...configuredSamplingPolicy,
        enabled:
          configuredSamplingPolicy.enabled &&
          this.runtimeOptions.samplingAvailable === true,
      };

      // 创建 SDK 客户端
      client = new Client(
        {
          name: getPackageName(),
          version: getVersion(),
        },
        {
          capabilities: {
            roots: {
              listChanged: false,
            },
            elicitation: {
              form: {
                applyDefaults: false,
              },
              url: {},
            },
            ...(samplingPolicy.enabled ? { sampling: {} } : {}),
          },
          listChanged: {
            tools: {
              autoRefresh: false,
              debounceMs: 0,
              onChanged: () => {
                void this.refreshTools('notification');
              },
            },
            resources: {
              autoRefresh: false,
              debounceMs: 0,
              onChanged: () => {
                void this.refreshContentCatalogs('notification', ['resources']);
              },
            },
            prompts: {
              autoRefresh: false,
              debounceMs: 0,
              onChanged: () => {
                void this.refreshContentCatalogs('notification', ['prompts']);
              },
            },
          },
        }
      );
      const connectedClient = client;
      this.sdkClient = connectedClient;
      this.resetCatalogRefreshState();
      this.registerElicitationHandlers(connectedClient);
      this.registerRootHandler(connectedClient);
      if (samplingPolicy.enabled) {
        this.registerSamplingHandler(connectedClient, samplingPolicy);
      }
      this.registerResourceNotificationHandler(connectedClient);
      this.registerLoggingHandler(connectedClient);
      if (this.taskPolicy.enabled) {
        this.registerTaskStatusHandler(connectedClient);
      }

      connectedClient.onclose = () => {
        this.handleUnexpectedClose(connectedClient, generation);
      };
      connectedClient.onerror = (error) => {
        this.handleTransportError(connectedClient, generation, error);
      };

      const transport = await this.createTransport();
      this.assertConnectionGeneration(generation);
      await connectedClient.connect(transport);
      this.assertConnectionGeneration(generation);

      // 获取服务器信息
      const serverVersion = connectedClient.getServerVersion();
      this.serverInfo = {
        name: serverVersion?.name || 'Unknown',
        version: serverVersion?.version || '0.0.0',
      };
      this.serverInstructions = normalizeMcpServerInstruction(
        connectedClient.getInstructions(),
        {
          exposeDetails: this.runtimeOptions.exposeInstructions,
        }
      );
      await this.configureLogging(connectedClient);

      // 加载工具列表
      await this.refreshTools('initial');
      await this.refreshContentCatalogs('initial').catch(() => undefined);
      await this.reconcileResourceSubscriptions(connectedClient);
      this.assertConnectionGeneration(generation);

      this.consecutiveTerminalErrors = 0;
      this.setStatus(McpConnectionStatus.CONNECTED);
      this.emit('connected', this.serverInfo);

      this.healthMonitor?.resetFailureCount();
      this.healthMonitor?.start();
    } catch (error) {
      if (client && this.sdkClient === client) this.sdkClient = null;
      if (client) {
        client.onclose = undefined;
        client.onerror = undefined;
        await client.close().catch(() => undefined);
      }
      throw error;
    }
  }

  private handleUnexpectedClose(client: Client, generation: number): void {
    if (
      this.sdkClient !== client ||
      !this.isConnectionGenerationCurrent(generation) ||
      this.status !== McpConnectionStatus.CONNECTED
    ) {
      return;
    }
    this.startRecovery(
      new Error(`MCP server "${this.serverName}" connection closed`),
      'transport_closed',
      false
    );
  }

  private handleTransportError(client: Client, generation: number, error: Error): void {
    if (
      this.sdkClient !== client ||
      !this.isConnectionGenerationCurrent(generation) ||
      this.status !== McpConnectionStatus.CONNECTED
    ) {
      return;
    }
    this.emit('transportError', {
      serverName: this.serverName,
      error: sanitizeMcpConnectionError(error),
    });

    if (isMcpSessionExpiredError(error)) {
      this.startRecovery(error, 'session_expired', true);
      return;
    }
    if (!isTerminalMcpTransportError(error)) {
      this.consecutiveTerminalErrors = 0;
      return;
    }
    this.consecutiveTerminalErrors++;
    const definitiveFailure = error.message
      .toLowerCase()
      .includes('maximum reconnection attempts');
    if (
      definitiveFailure ||
      this.consecutiveTerminalErrors >= this.recoveryPolicy.terminalErrorThreshold
    ) {
      this.startRecovery(error, 'transport_error', true);
    }
  }

  requestRecovery(error: Error, reason: McpRecoveryReason): void {
    if (
      !this.desiredConnected ||
      this.status !== McpConnectionStatus.CONNECTED ||
      this.recoveryPromise
    ) {
      return;
    }
    this.startRecovery(error, reason, true);
  }

  private startRecovery(
    error: Error,
    reason: McpRecoveryReason,
    closeTransport: boolean
  ): void {
    if (!this.desiredConnected || this.recoveryPromise) return;
    const previousClient = this.sdkClient;
    this.sdkClient = null;
    if (previousClient) {
      previousClient.onclose = undefined;
      previousClient.onerror = undefined;
    }
    this.healthMonitor?.stop();
    this.invalidateLiveConnection(true);
    const generation = ++this.connectionGeneration;
    const controller = new AbortController();
    this.recoveryAbortController = controller;
    this.setStatus(McpConnectionStatus.RECONNECTING);
    if (closeTransport && previousClient) {
      void previousClient.close().catch(() => undefined);
    }

    const promise = Promise.resolve()
      .then(() => this.runRecoveryLoop(error, reason, generation, controller.signal))
      .finally(() => {
        if (this.recoveryPromise === promise) this.recoveryPromise = undefined;
        if (this.recoveryAbortController === controller) {
          this.recoveryAbortController = undefined;
        }
      });
    this.recoveryPromise = promise;
    void promise.catch(() => undefined);
  }

  private async runRecoveryLoop(
    initialError: Error,
    reason: McpRecoveryReason,
    generation: number,
    signal: AbortSignal
  ): Promise<void> {
    let lastError = initialError;
    if (!this.recoveryPolicy.enabled || this.recoveryPolicy.maxAttempts === 0) {
      this.failRecovery(lastError, reason, 0, generation);
      return;
    }

    for (let attempt = 1; attempt <= this.recoveryPolicy.maxAttempts; attempt++) {
      this.assertConnectionGeneration(generation, signal);
      const delay = getMcpRecoveryDelay(
        this.recoveryPolicy,
        attempt,
        this.runtimeOptions.recoveryRandom
      );
      const nextRetryAt = Date.now() + delay;
      this.publishConnectionLifecycle({
        phase: 'reconnecting',
        reason,
        attempt,
        maxAttempts: this.recoveryPolicy.maxAttempts,
        nextRetryAt,
        error: sanitizeMcpConnectionError(lastError),
      });
      await waitForMcpRecoveryDelay(delay, signal);
      this.assertConnectionGeneration(generation, signal);

      try {
        await this.doConnect(generation, true);
        this.healthMonitor?.resetFailureCount();
        this.publishConnectionLifecycle({
          phase: 'recovered',
          reason,
          attempt,
          maxAttempts: this.recoveryPolicy.maxAttempts,
        });
        this.emit('reconnected');
        return;
      } catch (error) {
        if (!this.isConnectionGenerationCurrent(generation) || signal.aborted) {
          throw createMcpRecoveryAbortError(signal.reason);
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        if (!classifyError(lastError).isRetryable) {
          this.failRecovery(lastError, reason, attempt, generation);
          return;
        }
      }
    }

    this.failRecovery(lastError, reason, this.recoveryPolicy.maxAttempts, generation);
  }

  private failRecovery(
    error: Error,
    reason: McpRecoveryReason,
    attempt: number,
    generation: number
  ): void {
    if (!this.isConnectionGenerationCurrent(generation)) return;
    this.setStatus(McpConnectionStatus.ERROR);
    this.publishConnectionLifecycle({
      phase: 'failed',
      reason,
      attempt,
      maxAttempts: this.recoveryPolicy.maxAttempts,
      error: sanitizeMcpConnectionError(error),
    });
    this.emit('reconnectFailed', error);
  }

  private publishConnectionLifecycle(change: McpClientConnectionLifecycleChange): void {
    this.recoveryState = structuredClone(change);
    this.emit('connectionLifecycleChanged', structuredClone(change));
  }

  private isConnectionGenerationCurrent(generation: number): boolean {
    return this.desiredConnected && this.connectionGeneration === generation;
  }

  private assertConnectionGeneration(generation: number, signal?: AbortSignal): void {
    if (
      signal?.aborted ||
      !this.desiredConnected ||
      this.connectionGeneration !== generation
    ) {
      throw createMcpRecoveryAbortError(signal?.reason);
    }
  }

  private invalidateLiveConnection(preserveDesiredSubscriptions: boolean): void {
    this.resetCatalogRefreshState();
    this.tools.clear();
    this.resources = [];
    this.resourceTemplates = [];
    this.prompts = [];
    this.activeResourceSubscriptions.clear();
    if (!preserveDesiredSubscriptions) this.desiredResourceSubscriptions.clear();
    if (!preserveDesiredSubscriptions) this.taskInteractions.clear();
    this.serverInfo = null;
    this.serverInstructions = undefined;
    this.consecutiveTerminalErrors = 0;
  }

  private resetCatalogRefreshState(): void {
    this.catalogGeneration++;
    this.toolRefreshPromise = undefined;
    this.toolRefreshRequested = false;
    this.contentRefreshPromise = undefined;
    this.requestedContentCatalogs.clear();
    this.contentRefreshReason = 'manual';
  }

  private emitClientError(error: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }

  async ping(timeoutMs = 10_000): Promise<void> {
    const client = this.sdkClient;
    if (!client || this.status !== McpConnectionStatus.CONNECTED) {
      throw new Error(`MCP server "${this.serverName}" is not connected`);
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort('MCP health check timeout'),
      timeoutMs
    );
    timer.unref();
    try {
      await client.ping({
        signal: controller.signal,
        timeout: timeoutMs,
        maxTotalTimeout: timeoutMs,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `MCP server "${this.serverName}" health check timed out after ${timeoutMs}ms`
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    this.desiredConnected = false;
    this.connectionGeneration++;
    this.connectAbortController?.abort('MCP client disconnected');
    this.recoveryAbortController?.abort('MCP client disconnected');
    this.healthMonitor?.stop();

    const client = this.sdkClient;
    this.sdkClient = null;
    if (client) {
      client.onclose = undefined;
      client.onerror = undefined;
      await client.close().catch(() => undefined);
    }
    await Promise.allSettled(
      [this.connectPromise, this.recoveryPromise].filter(
        (promise): promise is Promise<void> => promise !== undefined
      )
    );

    this.invalidateLiveConnection(false);
    this.recoveryState = undefined;
    await this.oauthProvider?.dispose();
    this.setStatus(McpConnectionStatus.DISCONNECTED);
    this.emit('disconnected');
  }

  /**
   * 调用MCP工具
   */
  async callTool(
    name: string,
    arguments_: Record<string, unknown> = {},
    interactionContext: McpInteractionContext = {}
  ): Promise<McpToolCallResponse> {
    const client = this.sdkClient;
    if (!client || this.status !== McpConnectionStatus.CONNECTED) {
      throw new Error('客户端未连接到服务器');
    }

    if (!this.tools.has(name)) {
      throw new Error(`工具 "${name}" 不存在`);
    }

    if (this.activeInteraction) {
      throw new Error(
        `MCP server "${this.serverName}" does not allow overlapping interactive tool calls`
      );
    }

    const lifecycle = normalizeMcpCallLifecycle(this.config);
    const token = Symbol(name);
    this.activeInteraction = {
      token,
      context: interactionContext,
      samplingRequests: 0,
      samplingInFlight: false,
    };
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort('mcp-tool-timeout'),
      lifecycle.totalTimeoutMs
    );
    timeout.unref();
    const requestSignal = interactionContext.signal
      ? AbortSignal.any([interactionContext.signal, timeoutController.signal])
      : timeoutController.signal;
    const progressState = { count: 0 };
    try {
      const result = await client.callTool(
        {
          name,
          arguments: arguments_,
        },
        CallToolResultSchema,
        {
          signal: requestSignal,
          timeout: lifecycle.idleTimeoutMs,
          resetTimeoutOnProgress: true,
          maxTotalTimeout: lifecycle.totalTimeoutMs,
          onprogress: (progress) => {
            const normalized = normalizeMcpProgress(progress, progressState, lifecycle);
            if (
              normalized &&
              !requestSignal.aborted &&
              this.activeInteraction?.token === token
            ) {
              interactionContext.progressHandler?.(normalized);
              this.emit('toolProgress', {
                serverName: this.serverName,
                toolName: name,
                ...normalized,
              });
            }
          },
        }
      );

      return result as McpToolCallResponse;
    } catch (error) {
      if (interactionContext.signal?.aborted) {
        throw new DOMException(
          String(interactionContext.signal.reason || 'MCP tool call cancelled'),
          'AbortError'
        );
      }
      if (timeoutController.signal.aborted && !interactionContext.signal?.aborted) {
        throw new McpError(
          ErrorCode.RequestTimeout,
          `MCP server "${this.serverName}" tool "${name}" timed out after ${lifecycle.totalTimeoutMs}ms`
        );
      }
      console.error(`[McpClient] 调用工具 "${name}" 失败:`, error);
      throw error;
    } finally {
      clearTimeout(timeout);
      if (this.activeInteraction?.token === token) {
        this.activeInteraction = undefined;
      }
    }
  }

  getToolTaskSupport(name: string): McpToolDefinition['taskSupport'] {
    return this.tools.get(name)?.taskSupport;
  }

  async createToolTask(
    name: string,
    arguments_: Record<string, unknown>,
    interactionContext: McpInteractionContext,
    signal: AbortSignal,
    requestedTtlMs?: number
  ): Promise<McpServerTaskState> {
    const client = this.sdkClient;
    if (!client || this.status !== McpConnectionStatus.CONNECTED) {
      throw new Error('MCP client is not connected');
    }
    if (!this.taskPolicy.enabled) {
      throw new Error(`MCP tasks are disabled for server "${this.serverName}"`);
    }
    if (!client.getServerCapabilities()?.tasks?.requests?.tools?.call) {
      throw new Error(
        `MCP server "${this.serverName}" does not support task-augmented tools/call`
      );
    }
    const taskSupport = this.getToolTaskSupport(name);
    if (taskSupport !== 'required' && taskSupport !== 'optional') {
      throw new Error(`MCP tool "${name}" does not support task execution`);
    }
    if (this.activeInteraction) {
      throw new Error(
        `MCP server "${this.serverName}" does not allow overlapping interactive task creation`
      );
    }

    const lifecycle = normalizeMcpCallLifecycle(this.config);
    const token = Symbol(name);
    const active: McpActiveInteraction = {
      token,
      context: {
        ...interactionContext,
        signal,
      },
      samplingRequests: 0,
      samplingInFlight: false,
    };
    this.activeInteraction = active;
    const progressState = { count: 0 };
    const stream = client.experimental.tasks.callToolStream(
      {
        name,
        arguments: arguments_,
      },
      CallToolResultSchema,
      {
        signal,
        task: {
          ttl: requestedTtlMs ?? this.taskPolicy.defaultTtlMs,
          pollInterval: this.taskPolicy.pollIntervalMs,
        },
        timeout: lifecycle.idleTimeoutMs,
        maxTotalTimeout: lifecycle.totalTimeoutMs,
        resetTimeoutOnProgress: true,
        onprogress: (progress) => {
          const normalized = normalizeMcpProgress(progress, progressState, lifecycle);
          if (normalized && !signal.aborted && this.hasInteractionToken(token)) {
            interactionContext.progressHandler?.(normalized);
            this.emit('toolProgress', {
              serverName: this.serverName,
              toolName: name,
              ...normalized,
            });
          }
        },
      }
    );
    let created = false;
    try {
      const first = await stream.next();
      await stream.return(undefined);
      if (first.done || first.value.type !== 'taskCreated') {
        if (!first.done && first.value.type === 'error') {
          throw first.value.error;
        }
        throw new Error(`MCP tool "${name}" did not create a task`);
      }
      if (this.sdkClient !== client) {
        throw new Error('MCP client changed while creating a task');
      }
      const task = normalizeMcpServerTask(first.value.task, this.taskPolicy);
      this.taskInteractions.set(task.taskId, active);
      created = true;
      this.emit('taskCreated', {
        serverName: this.serverName,
        toolName: name,
        task,
      });
      return task;
    } finally {
      if (this.activeInteraction?.token === token) {
        this.activeInteraction = undefined;
      }
      if (!created) {
        for (const [taskId, interaction] of this.taskInteractions) {
          if (interaction.token === token) this.taskInteractions.delete(taskId);
        }
      }
    }
  }

  async getToolTask(
    serverTaskId: string,
    expectedCreatedAt: string,
    signal: AbortSignal
  ): Promise<McpServerTaskState> {
    const client = this.requireTaskClient();
    const task = await client.experimental.tasks.getTask(serverTaskId, {
      signal,
      timeout: this.taskPolicy.pollIntervalMs + 10_000,
      maxTotalTimeout: this.taskPolicy.pollIntervalMs + 10_000,
    });
    if (this.sdkClient !== client) {
      throw new Error('MCP client changed while reading a task');
    }
    return normalizeMcpServerTask(task, this.taskPolicy, {
      taskId: serverTaskId,
      createdAt: expectedCreatedAt,
    });
  }

  async getToolTaskResult(
    serverTaskId: string,
    signal: AbortSignal,
    maxWaitMs: number = this.taskPolicy.maxLifetimeMs
  ): Promise<McpToolCallResponse> {
    const client = this.requireTaskClient();
    const timeoutMs = Math.max(1, Math.min(maxWaitMs, this.taskPolicy.maxLifetimeMs));
    const result = await client.experimental.tasks.getTaskResult(
      serverTaskId,
      CallToolResultSchema,
      {
        signal,
        timeout: timeoutMs,
        maxTotalTimeout: timeoutMs,
      }
    );
    if (this.sdkClient !== client) {
      throw new Error('MCP client changed while reading a task result');
    }
    return result as McpToolCallResponse;
  }

  async cancelToolTask(serverTaskId: string, signal?: AbortSignal): Promise<void> {
    const client = this.requireTaskClient();
    if (!client.getServerCapabilities()?.tasks?.cancel) {
      throw new Error(
        `MCP server "${this.serverName}" does not support task cancellation`
      );
    }
    await client.experimental.tasks.cancelTask(serverTaskId, {
      signal,
      timeout: 15_000,
      maxTotalTimeout: 15_000,
    });
    if (this.sdkClient !== client) {
      throw new Error('MCP client changed while cancelling a task');
    }
  }

  async normalizeToolTaskResult(
    result: McpToolCallResponse
  ): Promise<McpNormalizedToolResult> {
    return normalizeMcpToolResult(result, this.runtimeOptions.artifactWriter);
  }

  releaseTaskInteraction(serverTaskId: string): void {
    this.taskInteractions.delete(serverTaskId);
  }

  async waitUntilConnected(signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (this.status === McpConnectionStatus.CONNECTED && this.sdkClient) return;
    if (!this.desiredConnected) {
      throw new Error(`MCP server "${this.serverName}" is disconnected`);
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`MCP server "${this.serverName}" recovery timed out`));
      }, timeoutMs);
      timer.unref();
      const onConnected = () => {
        cleanup();
        resolve();
      };
      const onDisconnected = () => {
        if (this.desiredConnected) return;
        cleanup();
        reject(new Error(`MCP server "${this.serverName}" was disconnected`));
      };
      const onAbort = () => {
        cleanup();
        reject(
          new DOMException(
            String(signal.reason || 'MCP task recovery cancelled'),
            'AbortError'
          )
        );
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('connected', onConnected);
        this.off('disconnected', onDisconnected);
        signal.removeEventListener('abort', onAbort);
      };
      this.on('connected', onConnected);
      this.on('disconnected', onDisconnected);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private requireTaskClient(): Client {
    const client = this.sdkClient;
    if (
      !client ||
      this.status !== McpConnectionStatus.CONNECTED ||
      !this.taskPolicy.enabled
    ) {
      throw new Error(`MCP server "${this.serverName}" task client is unavailable`);
    }
    if (!client.getServerCapabilities()?.tasks?.requests?.tools?.call) {
      throw new Error(
        `MCP server "${this.serverName}" does not support task-augmented tools/call`
      );
    }
    return client;
  }

  private hasInteractionToken(token: symbol): boolean {
    if (this.activeInteraction?.token === token) return true;
    return [...this.taskInteractions.values()].some(
      (interaction) => interaction.token === token
    );
  }

  private registerRootHandler(client: Client): void {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: this.roots.map((root) => ({ ...root })),
    }));
  }

  private resolveInteraction(params: {
    _meta?: {
      'io.modelcontextprotocol/related-task'?: {
        taskId: string;
      };
    };
  }): McpActiveInteraction | undefined {
    const taskId = params._meta?.['io.modelcontextprotocol/related-task']?.taskId;
    return taskId ? this.taskInteractions.get(taskId) : this.activeInteraction;
  }

  private registerTaskStatusHandler(client: Client): void {
    client.setNotificationHandler(TaskStatusNotificationSchema, (notification) => {
      this.emit('taskStatus', notification.params);
    });
  }

  private registerSamplingHandler(
    client: Client,
    policy: ReturnType<typeof normalizeMcpSamplingPolicy>
  ): void {
    client.setRequestHandler(CreateMessageRequestSchema, async (request, extra) => {
      const active = this.resolveInteraction(request.params);
      if (!active?.context.confirmationHandler || !active.context.samplingHandler) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          'MCP sampling requires an active interactive Session'
        );
      }
      if (active.samplingInFlight) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          'MCP server does not allow overlapping sampling requests'
        );
      }
      active.samplingInFlight = true;
      try {
        active.samplingRequests++;
        if (active.samplingRequests > policy.maxRequestsPerToolCall) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `MCP sampling exceeded ${policy.maxRequestsPerToolCall} requests for one tool call`
          );
        }
        const signal = active.context.signal
          ? AbortSignal.any([active.context.signal, extra.signal])
          : extra.signal;
        if (signal.aborted) {
          throw new McpError(ErrorCode.InvalidRequest, 'MCP sampling was cancelled');
        }

        let normalized;
        try {
          normalized = normalizeMcpSamplingRequest(request.params, policy);
        } catch (error) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            error instanceof Error ? error.message : String(error)
          );
        }
        const approval = await active.context.confirmationHandler.requestConfirmation(
          {
            type: 'mcpSampling',
            kind: ToolKind.Execute,
            toolName: `MCP sampling: ${this.serverName}`,
            title: 'MCP model sampling request',
            message: `MCP server "${this.serverName}" wants to call the current Session model with up to ${normalized.maxTokens} output tokens.`,
            details: normalized.preview,
            risks: [
              `May consume up to ${normalized.maxTokens} output tokens`,
              'The model response will be returned to the MCP server',
            ],
          },
          signal
        );
        if (
          signal.aborted ||
          approval.reason === CONFIRMATION_ABORTED_REASON ||
          approval.reason === 'timeout'
        ) {
          throw new McpError(ErrorCode.InvalidRequest, 'MCP sampling was cancelled');
        }
        if (!approval.approved) {
          throw new McpError(ErrorCode.InvalidRequest, 'MCP sampling was denied');
        }

        const result = await active.context.samplingHandler(normalized, signal);
        this.emit('samplingCompleted', {
          serverName: this.serverName,
          model: result.model,
          maxTokens: normalized.maxTokens,
        });
        return result;
      } finally {
        active.samplingInFlight = false;
      }
    });
  }

  private registerElicitationHandlers(client: Client): void {
    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      const active = this.resolveInteraction(request.params)?.context;
      if (!active?.confirmationHandler) {
        this.emit('elicitationCancelled', {
          serverName: this.serverName,
          reason: 'no-interaction-handler',
        });
        return { action: 'cancel' };
      }

      const signal = active.signal
        ? AbortSignal.any([active.signal, extra.signal])
        : extra.signal;
      if (signal.aborted) return { action: 'cancel' };

      let details;
      try {
        details = normalizeMcpElicitation(this.serverName, request.params);
      } catch (error) {
        this.emit('elicitationRejected', {
          serverName: this.serverName,
          reason: error instanceof Error ? error.message : String(error),
        });
        return { action: 'decline' };
      }

      try {
        const hookContext =
          active.sessionId && active.workspaceRoot && active.permissionMode
            ? {
                projectDir: active.workspaceRoot,
                sessionId: active.sessionId,
                permissionMode: active.permissionMode,
                abortSignal: signal,
              }
            : undefined;
        const beforeHooks = hookContext
          ? await HookManager.getInstance().executeElicitationHooks(
              details,
              hookContext
            )
          : {};
        let response: McpElicitationResponse;
        if (beforeHooks.blockedReason) {
          response = { action: 'decline' as const };
        } else if (beforeHooks.response) {
          response = beforeHooks.response;
        } else {
          const userResponse = await active.confirmationHandler.requestConfirmation(
            {
              type: 'mcpElicitation',
              message: details.message,
              title: `MCP input requested by ${this.serverName}`,
              mcpElicitation: details,
            },
            signal
          );
          const action = this.resolveElicitationAction(userResponse, signal);
          response = userResponse.elicitation ?? { action };
          if (
            action === 'accept' &&
            details.mode === 'url' &&
            userResponse.openExternalUrl &&
            details.url
          ) {
            await open(details.url, { wait: false });
          }
        }

        const afterHooks = hookContext
          ? await HookManager.getInstance().executeElicitationResultHooks(
              details,
              response,
              hookContext
            )
          : {};
        if (afterHooks.blockedReason) {
          response = { action: 'cancel' };
        } else if (afterHooks.response) {
          response = afterHooks.response;
        }
        const result = validateMcpElicitationResponse(details, response);
        this.emit('elicitationResolved', {
          serverName: this.serverName,
          mode: details.mode,
          action: result.action,
          elicitationId: details.elicitationId,
        });
        return result;
      } catch (error) {
        this.emit('elicitationCancelled', {
          serverName: this.serverName,
          reason: error instanceof Error ? error.message : String(error),
        });
        return { action: 'cancel' };
      }
    });

    client.setNotificationHandler(
      ElicitationCompleteNotificationSchema,
      (notification) => {
        this.emit('elicitationCompleted', {
          serverName: this.serverName,
          elicitationId: notification.params.elicitationId,
        });
      }
    );
  }

  private resolveElicitationAction(
    response: Awaited<ReturnType<ConfirmationHandler['requestConfirmation']>>,
    signal: AbortSignal
  ): McpElicitationAction {
    if (
      signal.aborted ||
      response.reason === CONFIRMATION_ABORTED_REASON ||
      response.reason === 'timeout'
    ) {
      return 'cancel';
    }
    if (response.elicitation) return response.elicitation.action;
    return response.approved ? 'accept' : 'decline';
  }

  /**
   * 创建传输层（支持 OAuth）
   */
  private async createTransport(): Promise<Transport> {
    const { type, command, args, env, cwd, url, headers, oauth } = this.config;
    let authProvider: OAuthProvider | undefined;
    if (oauth?.enabled) {
      if (this.runtimeOptions.oauthCredentialAccess === false || !this.oauthProvider) {
        throw new McpOAuthUnavailableError(this.serverName);
      }
      if (!(await this.oauthProvider.hasUsableCredentials())) {
        throw new McpOAuthAuthorizationRequiredError(this.serverName);
      }
      authProvider = this.oauthProvider;
    }

    if (type === 'stdio') {
      if (!command) {
        throw new Error('stdio 传输需要 command 参数');
      }
      // 过滤掉 undefined 值
      const processEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          processEnv[key] = value;
        }
      }
      return new StdioClientTransport({
        command,
        args: args || [],
        env: { ...processEnv, ...env },
        cwd,
        stderr: 'ignore', // 忽略子进程的 stderr 输出
      });
    } else if (type === 'sse') {
      if (!url) {
        throw new Error('sse 传输需要 url 参数');
      }
      return new SSEClientTransport(new URL(url), {
        requestInit: {
          headers,
        },
        ...(oauth?.enabled ? { fetch: safeMcpOAuthFetch } : {}),
        ...(authProvider ? { authProvider } : {}),
      });
    } else if (type === 'http') {
      if (!url) {
        throw new Error('http 传输需要 url 参数');
      }
      // HTTP 传输需要动态导入
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      );
      return new StreamableHTTPClientTransport(new URL(url), {
        requestInit: {
          headers,
        },
        ...(oauth?.enabled ? { fetch: safeMcpOAuthFetch } : {}),
        ...(authProvider ? { authProvider } : {}),
      });
    }

    throw new Error(`不支持的传输类型: ${type}`);
  }

  /**
   * 加载工具列表
   */
  async refreshTools(
    reason: McpClientToolCatalogChange['reason'] = 'manual'
  ): Promise<void> {
    this.toolRefreshRequested = true;
    if (this.toolRefreshPromise) return this.toolRefreshPromise;
    const generation = this.catalogGeneration;

    const promise = (
      reason === 'notification'
        ? new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 25);
            timer.unref();
          })
        : Promise.resolve()
    )
      .then(() => this.runToolRefresh(reason))
      .finally(() => {
        if (
          generation !== this.catalogGeneration ||
          this.toolRefreshPromise !== promise
        ) {
          return;
        }
        const refreshAgain = this.toolRefreshRequested;
        this.toolRefreshPromise = undefined;
        this.toolRefreshRequested = false;
        if (refreshAgain && this.sdkClient) {
          void this.refreshTools('notification');
        }
      });
    this.toolRefreshPromise = promise;
    return promise;
  }

  async waitForToolRefresh(): Promise<void> {
    while (this.toolRefreshPromise) {
      await this.toolRefreshPromise;
    }
  }

  private async runToolRefresh(
    initialReason: McpClientToolCatalogChange['reason']
  ): Promise<void> {
    let reason = initialReason;
    for (let pass = 0; pass < 3 && this.toolRefreshRequested; pass++) {
      this.toolRefreshRequested = false;
      try {
        await this.fetchAndPublishTools(reason);
      } catch (error) {
        this.emit('toolsRefreshFailed', {
          serverName: this.serverName,
          reason,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        if (reason !== 'notification') throw error;
        return;
      }
      reason = 'notification';
    }
  }

  private async fetchAndPublishTools(
    reason: McpClientToolCatalogChange['reason']
  ): Promise<void> {
    const client = this.sdkClient;
    if (!client) throw new Error('MCP client is not connected');

    const tools: Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
      execution?: {
        taskSupport?: 'required' | 'optional' | 'forbidden';
      };
    }> = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_MCP_TOOL_PAGES; page++) {
      const response = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...response.tools);
      if (tools.length > MAX_MCP_TOOLS_PER_SERVER) {
        throw new Error(`MCP tool catalog exceeds ${MAX_MCP_TOOLS_PER_SERVER} tools`);
      }
      cursor = response.nextCursor;
      if (!cursor) break;
      if (cursors.has(cursor)) {
        throw new Error('MCP tool catalog returned a repeated cursor');
      }
      cursors.add(cursor);
      if (page === MAX_MCP_TOOL_PAGES - 1) {
        throw new Error(`MCP tool catalog exceeds ${MAX_MCP_TOOL_PAGES} pages`);
      }
    }

    const next = normalizeMcpToolCatalog(tools);
    if (this.sdkClient !== client) {
      throw new Error('MCP client changed while refreshing tools');
    }
    const previous = this.availableTools;
    const delta = diffMcpToolCatalog(previous, next);
    this.tools = new Map(next.map((tool) => [tool.name, tool]));
    if (!hasMcpCatalogChanges(delta)) return;

    this.toolCatalogRevision++;
    const change: McpClientToolCatalogChange = {
      revision: this.toolCatalogRevision,
      reason,
      ...delta,
    };
    this.emit('toolsUpdated', this.availableTools, change);
  }

  async refreshContentCatalogs(
    reason: McpClientContentCatalogChange['reason'] = 'manual',
    catalogs: readonly ('resources' | 'prompts')[] = ['resources', 'prompts']
  ): Promise<void> {
    const capabilities = this.sdkClient?.getServerCapabilities();
    for (const catalog of catalogs) {
      if (catalog === 'resources' && capabilities?.resources) {
        this.requestedContentCatalogs.add(catalog);
      }
      if (catalog === 'prompts' && capabilities?.prompts) {
        this.requestedContentCatalogs.add(catalog);
      }
    }
    if (this.requestedContentCatalogs.size === 0) return;
    if (this.contentRefreshPromise) {
      if (reason !== 'notification') this.contentRefreshReason = reason;
      return this.contentRefreshPromise;
    }
    this.contentRefreshReason = reason;
    const generation = this.catalogGeneration;

    const promise = (
      reason === 'notification'
        ? new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 25);
            timer.unref();
          })
        : Promise.resolve()
    )
      .then(() => this.runContentCatalogRefresh())
      .finally(() => {
        if (
          generation !== this.catalogGeneration ||
          this.contentRefreshPromise !== promise
        ) {
          return;
        }
        const refreshAgain = this.requestedContentCatalogs.size > 0;
        this.contentRefreshPromise = undefined;
        this.contentRefreshReason = 'manual';
        if (refreshAgain && this.sdkClient) {
          void this.refreshContentCatalogs('notification');
        }
      });
    this.contentRefreshPromise = promise;
    return promise;
  }

  async waitForCatalogRefresh(): Promise<void> {
    while (this.toolRefreshPromise || this.contentRefreshPromise) {
      await Promise.all([
        this.toolRefreshPromise ?? Promise.resolve(),
        this.contentRefreshPromise ?? Promise.resolve(),
      ]);
    }
  }

  private async runContentCatalogRefresh(): Promise<void> {
    for (let pass = 0; pass < 3 && this.requestedContentCatalogs.size > 0; pass++) {
      const catalogs = [...this.requestedContentCatalogs];
      this.requestedContentCatalogs.clear();
      const reason = this.contentRefreshReason;
      this.contentRefreshReason = 'notification';
      const failures: Error[] = [];
      for (const catalog of catalogs) {
        try {
          if (catalog === 'resources') {
            await this.fetchAndPublishResourceCatalog(reason);
          } else {
            await this.fetchAndPublishPromptCatalog(reason);
          }
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          failures.push(normalized);
          this.emit('contentCatalogRefreshFailed', {
            serverName: this.serverName,
            catalog,
            reason,
            error: normalized,
          });
        }
      }
      if (failures.length > 0 && reason !== 'notification') {
        throw new AggregateError(
          failures,
          `Failed to refresh MCP content catalogs for "${this.serverName}"`
        );
      }
    }
  }

  private async fetchAndPublishResourceCatalog(
    reason: McpClientContentCatalogChange['reason']
  ): Promise<void> {
    const client = this.sdkClient;
    if (!client) throw new Error('MCP client is not connected');
    const resources = await this.fetchContentPages(
      'resource',
      MAX_MCP_RESOURCES,
      (cursor) => client.listResources(cursor ? { cursor } : undefined),
      (response) => response.resources
    );
    const templates = await this.fetchContentPages(
      'resource template',
      MAX_MCP_RESOURCE_TEMPLATES,
      (cursor) => client.listResourceTemplates(cursor ? { cursor } : undefined),
      (response) => response.resourceTemplates
    );
    const nextResources = normalizeMcpResources(resources);
    const nextTemplates = normalizeMcpResourceTemplates(templates);
    if (this.sdkClient !== client) {
      throw new Error('MCP client changed while refreshing resource catalogs');
    }

    const resourceDelta = diffMcpContentCatalog(
      this.resources,
      nextResources,
      (resource) => resource.uri
    );
    const templateDelta = diffMcpContentCatalog(
      this.resourceTemplates,
      nextTemplates,
      (template) => template.uriTemplate
    );
    this.resources = nextResources;
    this.resourceTemplates = nextTemplates;
    await this.reconcileResourceSubscriptions(client);
    this.publishContentCatalogDelta('resources', reason, resourceDelta);
    this.publishContentCatalogDelta('resourceTemplates', reason, templateDelta);
  }

  private async fetchAndPublishPromptCatalog(
    reason: McpClientContentCatalogChange['reason']
  ): Promise<void> {
    const client = this.sdkClient;
    if (!client) throw new Error('MCP client is not connected');
    const prompts = await this.fetchContentPages(
      'prompt',
      MAX_MCP_PROMPTS,
      (cursor) => client.listPrompts(cursor ? { cursor } : undefined),
      (response) => response.prompts
    );
    const next = normalizeMcpPrompts(prompts);
    if (this.sdkClient !== client) {
      throw new Error('MCP client changed while refreshing prompts');
    }
    const delta = diffMcpContentCatalog(this.prompts, next, (prompt) => prompt.name);
    this.prompts = next;
    this.publishContentCatalogDelta('prompts', reason, delta);
  }

  private async fetchContentPages<T, TResponse extends { nextCursor?: string }>(
    label: string,
    maximum: number,
    request: (cursor?: string) => Promise<TResponse>,
    select: (response: TResponse) => readonly T[]
  ): Promise<T[]> {
    const result: T[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_MCP_CONTENT_PAGES; page++) {
      const response = await request(cursor);
      result.push(...select(response));
      if (result.length > maximum) {
        throw new Error(`MCP ${label} catalog exceeds ${maximum} entries`);
      }
      cursor = response.nextCursor;
      if (!cursor) return result;
      if (cursors.has(cursor)) {
        throw new Error(`MCP ${label} catalog returned a repeated cursor`);
      }
      cursors.add(cursor);
    }
    throw new Error(`MCP ${label} catalog exceeds ${MAX_MCP_CONTENT_PAGES} pages`);
  }

  private publishContentCatalogDelta(
    kind: McpContentCatalogKind,
    reason: McpClientContentCatalogChange['reason'],
    delta: McpContentCatalogDelta
  ): void {
    if (!hasMcpContentChanges(delta)) return;
    this.contentCatalogRevision++;
    const change: McpClientContentCatalogChange = {
      revision: this.contentCatalogRevision,
      kind,
      reason,
      ...delta,
    };
    this.emit('contentCatalogUpdated', this.contentCatalog, change);
  }

  private registerResourceNotificationHandler(client: Client): void {
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      const uri = notification.params.uri;
      if (this.sdkClient !== client || !this.activeResourceSubscriptions.has(uri)) {
        return;
      }
      this.contentCatalogRevision++;
      this.emit('resourceUpdated', {
        revision: this.contentCatalogRevision,
        serverName: this.serverName,
        uri,
      });
    });
  }

  private registerLoggingHandler(client: Client): void {
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      if (
        this.sdkClient !== client ||
        !this.loggingPolicy.enabled ||
        !isMcpLogLevelEnabled(notification.params.level, this.loggingPolicy.level)
      ) {
        return;
      }
      const now = Date.now();
      if (now - this.logWindowStartedAt >= 1_000) {
        this.logWindowStartedAt = now;
        this.logEventsInWindow = 0;
        this.logRateWarningEmitted = false;
      }
      if (this.logEventsInWindow >= MAX_MCP_LOG_EVENTS_PER_SECOND) {
        if (!this.logRateWarningEmitted) {
          this.logRateWarningEmitted = true;
          this.emit(
            'log',
            createMcpLogRateLimitEntry(1, {
              now,
            })
          );
        }
        return;
      }

      this.logEventsInWindow++;
      const entry: McpClientLogEntry = normalizeMcpLogEntry(
        {
          level: notification.params.level,
          logger: notification.params.logger,
          data: notification.params.data,
        },
        {
          exposeDetails: this.runtimeOptions.exposeLogDetails,
          now,
        }
      );
      this.emit('log', entry);
    });
  }

  private async configureLogging(client: Client): Promise<void> {
    this.logWindowStartedAt = Date.now();
    this.logEventsInWindow = 0;
    this.logRateWarningEmitted = false;
    if (!this.loggingPolicy.enabled || !client.getServerCapabilities()?.logging) {
      return;
    }
    try {
      await client.setLoggingLevel(this.loggingPolicy.level);
    } catch (error) {
      if (this.sdkClient !== client) return;
      const details = {
        serverName: this.serverName,
        level: this.loggingPolicy.level,
        error: sanitizeMcpConnectionError(error),
      };
      this.emit('loggingSetupFailed', details);
      this.emit('log', {
        ...normalizeMcpLogEntry(
          {
            level: 'warning',
            logger: 'blade.mcp.logging',
            data: `Failed to set MCP logging level: ${details.error}`,
          },
          {
            exposeDetails: this.runtimeOptions.exposeLogDetails,
          }
        ),
        synthetic: true,
      } satisfies McpClientLogEntry);
    }
  }

  async setLoggingLevel(level: McpLogLevel): Promise<void> {
    if (!isMcpLogLevel(level)) {
      throw new Error('Invalid MCP logging level');
    }
    const client = this.sdkClient;
    if (!client) throw new Error('MCP client is not connected');
    if (!client.getServerCapabilities()?.logging) {
      throw new Error(`MCP server "${this.serverName}" does not support logging`);
    }
    await client.setLoggingLevel(level);
    if (this.sdkClient !== client) {
      throw new Error('MCP client changed while setting logging level');
    }
    this.loggingPolicy = { enabled: true, level };
    this.emit('loggingLevelChanged', {
      serverName: this.serverName,
      level,
    });
  }

  async complete(
    input: McpCompletionInput,
    signal?: AbortSignal
  ): Promise<McpNormalizedCompletionResult> {
    const client = this.sdkClient;
    if (!client || this.status !== McpConnectionStatus.CONNECTED) {
      throw new Error('MCP client is not connected');
    }
    if (!client.getServerCapabilities()?.completions) {
      throw new Error(`MCP server "${this.serverName}" does not support completions`);
    }
    if (this.completionCallsInFlight >= MAX_MCP_COMPLETION_CONCURRENCY) {
      throw new Error(
        `MCP server "${this.serverName}" has too many completion requests`
      );
    }
    const params = validateMcpCompletionInput(input, this.contentCatalog);
    this.completionCallsInFlight++;
    try {
      const result = await client.complete(params, {
        signal,
        timeout: MCP_COMPLETION_TIMEOUT_MS,
        maxTotalTimeout: MCP_COMPLETION_TIMEOUT_MS,
      });
      if (this.sdkClient !== client) {
        throw new Error('MCP client changed while completing an argument');
      }
      return normalizeMcpCompletionResult(result);
    } catch (error) {
      if (signal?.aborted) {
        throw new DOMException(
          String(signal.reason || 'MCP completion cancelled'),
          'AbortError'
        );
      }
      throw error;
    } finally {
      this.completionCallsInFlight--;
    }
  }

  async readResource(uri: string): Promise<McpNormalizedResourceResult> {
    const client = this.sdkClient;
    if (!client) throw new Error('MCP client is not connected');
    if (!this.resources.some((resource) => resource.uri === uri)) {
      throw new Error(
        `MCP resource "${uri}" is not present in server "${this.serverName}" catalog`
      );
    }
    return normalizeMcpResourceResult(await client.readResource({ uri }));
  }

  async getPrompt(
    name: string,
    arguments_: Record<string, string> = {}
  ): Promise<McpNormalizedPromptResult> {
    const client = this.sdkClient;
    if (!client) throw new Error('MCP client is not connected');
    const prompt = this.prompts.find((candidate) => candidate.name === name);
    if (!prompt) {
      throw new Error(
        `MCP prompt "${name}" is not present in server "${this.serverName}" catalog`
      );
    }
    const knownArguments = new Set(prompt.arguments.map((argument) => argument.name));
    for (const [key, value] of Object.entries(arguments_)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) {
        throw new Error(`Unsafe argument "${key}" for MCP prompt "${name}"`);
      }
      if (!knownArguments.has(key)) {
        throw new Error(`Unknown argument "${key}" for MCP prompt "${name}"`);
      }
      if (Buffer.byteLength(value) > 16 * 1024) {
        throw new Error(`Argument "${key}" for MCP prompt "${name}" is too large`);
      }
    }
    for (const argument of prompt.arguments) {
      if (argument.required && arguments_[argument.name] === undefined) {
        throw new Error(
          `Required argument "${argument.name}" is missing for MCP prompt "${name}"`
        );
      }
    }
    return normalizeMcpPromptResult(
      await client.getPrompt({ name, arguments: arguments_ })
    );
  }

  async setResourceSubscription(uri: string, subscribe: boolean): Promise<void> {
    const client = this.sdkClient;
    if (!client) throw new Error('MCP client is not connected');
    if (subscribe) {
      if (!this.resources.some((resource) => resource.uri === uri)) {
        throw new Error(
          `MCP resource "${uri}" is not present in server "${this.serverName}" catalog`
        );
      }
      if (
        this.desiredResourceSubscriptions.has(uri) &&
        this.activeResourceSubscriptions.has(uri)
      ) {
        return;
      }
      if (
        !this.desiredResourceSubscriptions.has(uri) &&
        this.desiredResourceSubscriptions.size >= MAX_MCP_RESOURCE_SUBSCRIPTIONS
      ) {
        throw new Error(
          `MCP resource subscriptions exceed ${MAX_MCP_RESOURCE_SUBSCRIPTIONS}`
        );
      }
      if (!client.getServerCapabilities()?.resources?.subscribe) {
        throw new Error(
          `MCP server "${this.serverName}" does not support resource subscriptions`
        );
      }
      await client.subscribeResource({ uri });
      if (this.sdkClient !== client) {
        throw new Error('MCP client changed while subscribing to resource');
      }
      this.desiredResourceSubscriptions.add(uri);
      this.activeResourceSubscriptions.add(uri);
      return;
    }
    if (!this.desiredResourceSubscriptions.has(uri)) return;
    if (this.activeResourceSubscriptions.has(uri)) {
      await client.unsubscribeResource({ uri });
      if (this.sdkClient !== client) {
        throw new Error('MCP client changed while unsubscribing from resource');
      }
    }
    this.activeResourceSubscriptions.delete(uri);
    this.desiredResourceSubscriptions.delete(uri);
  }

  private async reconcileResourceSubscriptions(client: Client): Promise<void> {
    if (this.sdkClient !== client) return;
    const catalogUris = new Set(this.resources.map((resource) => resource.uri));
    for (const uri of this.activeResourceSubscriptions) {
      if (!catalogUris.has(uri)) this.activeResourceSubscriptions.delete(uri);
    }
    if (!client.getServerCapabilities()?.resources?.subscribe) {
      this.activeResourceSubscriptions.clear();
      return;
    }
    for (const uri of this.desiredResourceSubscriptions) {
      if (!catalogUris.has(uri) || this.activeResourceSubscriptions.has(uri)) {
        continue;
      }
      try {
        await client.subscribeResource({ uri });
        if (this.sdkClient !== client) return;
        this.activeResourceSubscriptions.add(uri);
      } catch (error) {
        this.emit('resourceSubscriptionRestoreFailed', {
          serverName: this.serverName,
          uri,
          error: sanitizeMcpConnectionError(error),
        });
      }
    }
  }

  /**
   * 设置连接状态
   */
  private setStatus(status: McpConnectionStatus): void {
    const oldStatus = this.status;
    if (oldStatus === status) return;
    this.status = status;
    this.emit('statusChanged', status, oldStatus);
  }

  // ========================================
  // 兼容性方法（保持与 Registry 的接口一致）
  // ========================================

  async initialize(): Promise<void> {
    return this.connect();
  }

  async destroy(): Promise<void> {
    return this.disconnect();
  }

  async connectToServer(serverId?: string): Promise<void> {
    return this.connect();
  }

  async disconnectFromServer(serverId?: string): Promise<void> {
    return this.disconnect();
  }

  async listResources(_serverId?: string): Promise<McpResourceDefinition[]> {
    return structuredClone(this.resources);
  }

  async listResourceTemplates(): Promise<McpResourceTemplateDefinition[]> {
    return structuredClone(this.resourceTemplates);
  }

  async listPrompts(): Promise<McpPromptDefinition[]> {
    return structuredClone(this.prompts);
  }

  async listTools(serverId?: string): Promise<McpToolDefinition[]> {
    return this.availableTools;
  }
}

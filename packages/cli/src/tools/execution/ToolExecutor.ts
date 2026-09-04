import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AcpFileSystemService } from '../../acp/AcpFileSystemService.js';
import { AcpRemotePathError, parseAcpRemotePath } from '../../acp/AcpRemotePath.js';
import {
  getAcpFileSystemService,
  isAcpRemoteFileSystem,
} from '../../acp/AcpServiceContext.js';
import type { PermissionConfig } from '../../config/types.js';
import { PermissionMode } from '../../config/types.js';
import { HookManager } from '../../hooks/HookManager.js';
import type { LspSessionManager } from '../../lsp/LspSessionManager.js';
import { getCwd } from '../../utils/cwd.js';
import type { ToolRegistry } from '../registry/ToolRegistry.js';
import type {
  ExecutionContext,
  ExecutionHistoryEntry,
  PermissionDecision,
  Tool,
  ToolInvocation,
  ToolResult,
} from '../types/index.js';
import { ToolErrorType, ToolKind } from '../types/index.js';
import type { AutoVerifyRuntime } from './AutoVerify.js';
import {
  type ConcurrencyLimits,
  ConcurrencyScheduler,
  ToolAdmissionError,
} from './ConcurrencyScheduler.js';
import { FileLockManager } from './FileLockManager.js';
import { PermissionResolver, resolvePermissionDecision } from './PermissionResolver.js';
import {
  InMemorySessionApprovalStore,
  type SessionApprovalStore,
} from './SessionApprovalStore.js';
import { ToolApprovalController } from './ToolApprovalController.js';
import {
  ToolConcurrencyGate,
  ToolConcurrencyGateClosedError,
  ToolConcurrencyGateOverflowError,
} from './ToolConcurrencyGate.js';
import { enforceWorktreeIsolation, validateToolCall } from './ToolExecutionGuards.js';
import {
  type PreToolUseResult,
  runPostToolUseHooks,
  runPreToolUseHooks,
} from './ToolExecutionHooks.js';
import {
  createCancellationResult,
  createInvalidAcpRemotePathResult,
  createRejectedResult,
} from './ToolExecutionResults.js';
import { executeToolInvocation, formatToolResult } from './ToolInvocationRunner.js';
import {
  bindExecutionWorkspaceToolPolicy,
  createRemoteToolUnavailableResult,
  evaluateBuiltinToolAccess,
  freezeWorkspaceToolPolicy,
  isRuntimeWorkspaceToolPolicy,
  type WorkspaceToolPolicy,
} from './WorkspaceToolPolicy.js';

interface ToolExecutorEventMap {
  executionStarted: [
    event: {
      executionId: string;
      toolName: string;
      params: Record<string, unknown>;
      context: ExecutionContext;
      timestamp: number;
    },
  ];
  executionCompleted: [
    event: {
      executionId: string;
      toolName: string;
      result: ToolResult;
      duration: number;
      timestamp: number;
    },
  ];
  executionFailed: [
    event: {
      executionId: string;
      toolName: string;
      error: Error;
      duration: number;
      timestamp: number;
    },
  ];
  historyClear: [event: { timestamp: number }];
}

type PreToolUseHookRunner = (
  tool: Tool,
  params: Record<string, unknown>,
  invocation: ToolInvocation<unknown>,
  context: ExecutionContext,
  ruleDecision: PermissionDecision
) => Promise<PreToolUseResult>;

type RemoteExecutionContextDefaults = Readonly<
  ExecutionContext & {
    sessionId: string;
    workspaceRoot: string;
    executionRoot: string;
    workspaceKind: 'acp-remote';
  }
>;

export class ToolExecutor extends EventEmitter<ToolExecutorEventMap> {
  private readonly executionHistory: ExecutionHistoryEntry[] = [];
  private readonly maxHistorySize: number;
  private readonly scheduler: ConcurrencyScheduler;
  private readonly toolWhitelist: ReadonlySet<string> | null;
  private readonly toolBlacklist: ReadonlySet<string> | null;
  private readonly permissionResolver: PermissionResolver;
  private readonly approvalController: ToolApprovalController;
  private readonly concurrencyGate = new ToolConcurrencyGate();
  private readonly contextDefaults: ExecutionContext;
  private readonly remoteContextDefaults?: RemoteExecutionContextDefaults;
  private readonly preToolUseHookRunner: PreToolUseHookRunner;
  private readonly trustedRuntimePolicy: boolean;
  private readonly autoVerifyRuntime?: Pick<AutoVerifyRuntime, 'verify'>;
  private readonly lspManager?: Pick<LspSessionManager, 'afterToolUse'>;
  private readonly onDispose?: () => void;
  private readonly workspaceToolPolicy?: WorkspaceToolPolicy;
  private readonly ownerId = `tool-executor-${randomUUID()}`;
  private disposed = false;

  constructor(
    private readonly registry: ToolRegistry,
    config: ToolExecutorConfig = {}
  ) {
    super();

    this.maxHistorySize = config.maxHistorySize ?? 1000;
    this.autoVerifyRuntime = config.autoVerifyRuntime;
    this.lspManager = config.lspManager;
    this.onDispose = config.onDispose;
    this.workspaceToolPolicy = config.workspaceToolPolicy
      ? freezeWorkspaceToolPolicy(config.workspaceToolPolicy)
      : undefined;
    this.contextDefaults = freezeExecutionContextDefaults(config.contextDefaults);
    this.trustedRuntimePolicy = isRuntimeWorkspaceToolPolicy(
      config.workspaceToolPolicy
    );
    this.remoteContextDefaults =
      this.workspaceToolPolicy?.kind === 'acp-remote'
        ? requireRemoteExecutionContextDefaults(this.contextDefaults)
        : undefined;
    this.preToolUseHookRunner = runPreToolUseHooks;
    this.toolWhitelist = config.toolWhitelist?.length
      ? new Set(config.toolWhitelist)
      : null;
    this.toolBlacklist = config.toolBlacklist?.length
      ? new Set(config.toolBlacklist)
      : null;
    this.scheduler =
      config.scheduler ??
      (config.concurrencyLimits
        ? new ConcurrencyScheduler(config.concurrencyLimits)
        : ConcurrencyScheduler.getInstance());

    const approvalStore = config.approvalStore ?? new InMemorySessionApprovalStore();
    this.permissionResolver = new PermissionResolver(
      config.permissionConfig ?? { allow: [], ask: [], deny: [] },
      approvalStore,
      config.permissionMode ?? PermissionMode.DEFAULT
    );
    this.approvalController = new ToolApprovalController(
      approvalStore,
      this.permissionResolver.getPermissionChecker()
    );
  }

  async execute(
    toolName: string,
    params: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<ToolResult> {
    if (this.disposed) return this.createDisposedResult();
    const startTime = Date.now();
    const executionId = `exec_${randomUUID()}`;
    const remoteContext = this.remoteContextDefaults;
    const remoteWorkspace = remoteContext !== undefined;
    const trustedLocalWorkspace =
      this.trustedRuntimePolicy && this.workspaceToolPolicy?.kind === 'local';
    const executionContext = bindExecutionWorkspaceToolPolicy(
      {
        ...this.contextDefaults,
        ...context,
        sessionId: remoteWorkspace
          ? remoteContext.sessionId
          : (context.sessionId ?? this.contextDefaults.sessionId ?? this.ownerId),
        workspaceRoot: remoteWorkspace
          ? remoteContext.workspaceRoot
          : (context.workspaceRoot ?? this.contextDefaults.workspaceRoot),
        executionRoot: remoteWorkspace
          ? remoteContext.executionRoot
          : (context.executionRoot ?? this.contextDefaults.executionRoot),
        workspaceKind: remoteWorkspace
          ? 'acp-remote'
          : trustedLocalWorkspace
            ? 'local'
            : (context.workspaceKind ?? this.contextDefaults.workspaceKind),
        worktreeIsolationRequired: remoteWorkspace
          ? false
          : (context.worktreeIsolationRequired ??
            this.contextDefaults.worktreeIsolationRequired),
        worktreeActive: remoteWorkspace
          ? false
          : (context.worktreeActive ?? this.contextDefaults.worktreeActive),
        environment: remoteWorkspace
          ? remoteContext.environment
          : {
              ...this.contextDefaults.environment,
              ...context.environment,
            },
      },
      this.trustedRuntimePolicy ? this.workspaceToolPolicy : undefined
    );
    this.emit('executionStarted', {
      executionId,
      toolName,
      params,
      context: executionContext,
      timestamp: startTime,
    });

    return this.executeFlow(toolName, params, executionContext, executionId, startTime);
  }

  private async executeFlow(
    toolName: string,
    initialParams: Record<string, unknown>,
    context: ExecutionContext,
    executionId: string,
    startTime: number
  ): Promise<ToolResult> {
    let resolvedParams = initialParams;
    try {
      const result = await this.runTool(
        toolName,
        initialParams,
        context,
        executionId,
        (params) => {
          resolvedParams = params;
        }
      );
      this.completeExecution(
        executionId,
        toolName,
        resolvedParams,
        context,
        result,
        startTime
      );
      return result;
    } catch (error) {
      const admissionResult = this.projectAdmissionFailure(toolName, error);
      if (admissionResult) {
        const result = formatToolResult(admissionResult, executionId, toolName);
        this.completeExecution(
          executionId,
          toolName,
          resolvedParams,
          context,
          result,
          startTime
        );
        return result;
      }
      return this.failExecution(
        executionId,
        toolName,
        resolvedParams,
        context,
        error,
        startTime
      );
    }
  }

  private async runTool(
    toolName: string,
    initialParams: Record<string, unknown>,
    context: ExecutionContext,
    executionId: string,
    onParamsResolved: (params: Record<string, unknown>) => void
  ): Promise<ToolResult> {
    if (context.signal?.aborted) {
      return createCancellationResult(true);
    }

    const tool = this.registry.get(toolName);
    if (!tool) {
      return createRejectedResult(`Tool "${toolName}" not found`, {
        errorType: ToolErrorType.VALIDATION_ERROR,
      });
    }
    const isBuiltin = this.registry.getBuiltinTools().includes(tool);
    if (this.workspaceToolPolicy) {
      if (isBuiltin) {
        const access = evaluateBuiltinToolAccess(this.workspaceToolPolicy, toolName);
        if (!access.allowed) {
          return createRemoteToolUnavailableResult(access.reason);
        }
      }
    }

    const validation = validateToolCall(
      tool,
      initialParams,
      this.toolWhitelist,
      this.toolBlacklist
    );
    if ('success' in validation) {
      return validation;
    }
    onParamsResolved(validation.params);
    const initialPathRejection = this.validateRemoteDeclaredPaths(
      toolName,
      tool,
      validation.invocation,
      isBuiltin
    );
    if (initialPathRejection) {
      return initialPathRejection;
    }

    return this.concurrencyGate.run(
      tool.parallelism === 'shared' ||
        (tool.parallelism === undefined && tool.isConcurrencySafe),
      async () => {
        if (context.signal?.aborted) {
          return createCancellationResult(true);
        }

        let { params, invocation } = validation;
        const isolationRejection = await enforceWorktreeIsolation(
          tool,
          params,
          context,
          invocation
        );
        if (isolationRejection) {
          return isolationRejection;
        }

        let rulePermission = this.permissionResolver.resolveRulePermission(
          tool,
          invocation,
          params,
          context
        );
        const hookResult = await this.preToolUseHookRunner(
          tool,
          params,
          invocation,
          context,
          rulePermission.decision
        );
        if (hookResult.rejection) {
          return hookResult.rejection;
        }

        invocation = hookResult.invocation;
        const invocationParams = invocation.params;
        if (
          typeof invocationParams !== 'object' ||
          invocationParams === null ||
          Array.isArray(invocationParams)
        ) {
          return createRejectedResult('Hook modified parameters must be an object', {
            errorType: ToolErrorType.VALIDATION_ERROR,
          });
        }
        params = invocationParams as Record<string, unknown>;
        onParamsResolved(params);
        if (hookResult.inputModified) {
          const modifiedPathRejection = this.validateRemoteDeclaredPaths(
            toolName,
            tool,
            invocation,
            isBuiltin
          );
          if (modifiedPathRejection) {
            return modifiedPathRejection;
          }
          const modifiedInputIsolationRejection = await enforceWorktreeIsolation(
            tool,
            params,
            context,
            invocation
          );
          if (modifiedInputIsolationRejection) {
            return modifiedInputIsolationRejection;
          }
          rulePermission = this.permissionResolver.resolveRulePermission(
            tool,
            invocation,
            params,
            context
          );
        }

        const decision = resolvePermissionDecision(
          rulePermission.decision,
          hookResult.decision
        );
        if (decision.behavior === 'deny') {
          return createRejectedResult(
            decision.reason ||
              `Tool invocation denied by ${decision.source}${
                decision.matchedRule ? ` (${decision.matchedRule})` : ''
              }`,
            { errorType: ToolErrorType.PERMISSION_DENIED }
          );
        }

        const approvalRejection = await this.approvalController.confirmIfNeeded(
          tool,
          invocation,
          params,
          decision,
          rulePermission.signature,
          context
        );
        if (approvalRejection) {
          return approvalRejection;
        }
        if (context.signal?.aborted) {
          return createCancellationResult(true);
        }

        let invocationStarted = false;
        const executeInvocation = () => {
          if (context.signal?.aborted) {
            return Promise.resolve(createCancellationResult(true));
          }
          invocationStarted = true;
          return executeToolInvocation(invocation, context);
        };
        const lockPath = params.file_path ?? params.notebook_path;
        const remoteFileSystem =
          this.workspaceToolPolicy?.kind === 'acp-remote' ||
          isAcpRemoteFileSystem(context.sessionId);
        const needsOpaqueReadLock =
          tool.kind === ToolKind.ReadOnly && tool.name === 'Read' && remoteFileSystem;
        const needsAnyFileLock =
          (!tool.isConcurrencySafe || needsOpaqueReadLock) && lockPath;
        const executeWithLock = needsAnyFileLock
          ? remoteFileSystem
            ? () => {
                const service = getAcpFileSystemService(context.sessionId);
                if (!(service instanceof AcpFileSystemService)) {
                  throw new Error(
                    'ACP remote filesystem service is unavailable for file lock routing'
                  );
                }
                return FileLockManager.getInstance().acquireOpaqueLock(
                  service.createOpaqueLockKey(String(lockPath)),
                  executeInvocation
                );
              }
            : () =>
                FileLockManager.getInstance().acquireLock(
                  String(lockPath),
                  executeInvocation
                )
          : executeInvocation;
        const result = await this.scheduler.schedule(
          {
            ownerId: this.ownerId,
            sessionId: context.sessionId ?? this.ownerId,
            kind: tool.kind,
            signal: context.signal,
            onAbort: () => createCancellationResult(true),
            onQueued: (snapshot) => {
              context.onProgressUpdate?.({
                message: 'Waiting for tool execution capacity',
                admission: snapshot,
              });
            },
          },
          executeWithLock
        );
        if (context.signal?.aborted && !hasClassifiedSideEffectOutcome(result)) {
          return createCancellationResult(!invocationStarted);
        }
        if (result.metadata?.abortedBeforeLaunch === true) {
          return result;
        }

        await runPostToolUseHooks(tool, params, result, context, hookResult.toolUseId);
        if (context.signal?.aborted && !hasClassifiedSideEffectOutcome(result)) {
          return createCancellationResult(false);
        }

        await this.lspManager?.afterToolUse(tool.name, params, result, context);
        if (context.signal?.aborted && !hasClassifiedSideEffectOutcome(result)) {
          return createCancellationResult(false);
        }
        await this.autoVerifyRuntime?.verify(tool.name, params, context, result);
        if (context.signal?.aborted && !hasClassifiedSideEffectOutcome(result)) {
          return createCancellationResult(false);
        }
        return formatToolResult(result, executionId, tool.name);
      },
      context.signal,
      () => createCancellationResult(true)
    );
  }

  private completeExecution(
    executionId: string,
    toolName: string,
    params: Record<string, unknown>,
    context: ExecutionContext,
    result: ToolResult,
    startTime: number
  ): void {
    const endTime = Date.now();
    this.addToHistory({
      executionId,
      toolName,
      params,
      result,
      startTime,
      endTime,
      context,
    });
    this.emit('executionCompleted', {
      executionId,
      toolName,
      result,
      duration: endTime - startTime,
      timestamp: endTime,
    });
  }

  private async failExecution(
    executionId: string,
    toolName: string,
    params: Record<string, unknown>,
    context: ExecutionContext,
    error: unknown,
    startTime: number
  ): Promise<ToolResult> {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    const endTime = Date.now();
    const isTimeout =
      normalizedError.message.includes('timeout') ||
      normalizedError.name === 'TimeoutError';
    let result: ToolResult = {
      success: false,
      llmContent: `Tool execution failed: ${normalizedError.message}`,
      error: {
        type: isTimeout ? ToolErrorType.TIMEOUT_ERROR : ToolErrorType.EXECUTION_ERROR,
        message: normalizedError.message,
      },
    };

    if (context.workspaceKind === 'acp-remote') {
      this.addToHistory({
        executionId,
        toolName,
        params,
        result,
        startTime,
        endTime,
        context,
      });
      return formatToolResult(result, executionId, toolName);
    }

    try {
      const hookResult = await HookManager.getInstance().executePostToolUseFailureHooks(
        toolName,
        `tool_use_${executionId}`,
        params,
        normalizedError.message,
        {
          projectDir: context.workspaceRoot || getCwd(),
          sessionId: context.sessionId || 'unknown',
          permissionMode: context.permissionMode || PermissionMode.DEFAULT,
          isInterrupt: false,
          isTimeout,
          abortSignal: context.signal,
        }
      );
      if (hookResult.additionalContext) {
        result = {
          ...result,
          llmContent: `${result.llmContent}\n\n${hookResult.additionalContext}`,
        };
      }
      if (hookResult.warning) {
        console.warn(
          `[ToolExecutor] PostToolUseFailure hook warning: ${hookResult.warning}`
        );
      }
    } catch (hookError) {
      console.warn(
        '[ToolExecutor] PostToolUseFailure hook execution failed:',
        hookError
      );
    }

    this.addToHistory({
      executionId,
      toolName,
      params,
      result,
      startTime,
      endTime,
      context,
    });
    this.emit('executionFailed', {
      executionId,
      toolName,
      error: normalizedError,
      duration: endTime - startTime,
      timestamp: endTime,
    });
    return result;
  }

  async executeAll(
    requests: Array<{
      toolName: string;
      params: Record<string, unknown>;
      context: ExecutionContext;
    }>
  ): Promise<ToolResult[]> {
    return Promise.all(
      requests.map((request) =>
        this.execute(request.toolName, request.params, request.context)
      )
    );
  }

  async executeParallel(
    requests: Array<{
      toolName: string;
      params: Record<string, unknown>;
      context: ExecutionContext;
    }>,
    maxConcurrency = 5
  ): Promise<ToolResult[]> {
    const limit = maxConcurrency > 0 ? maxConcurrency : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(limit) || limit >= requests.length) {
      return this.executeAll(requests);
    }

    const results: ToolResult[] = new Array(requests.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < requests.length) {
        const currentIndex = nextIndex++;
        const request = requests[currentIndex];
        results[currentIndex] = await this.execute(
          request.toolName,
          request.params,
          request.context
        );
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(limit, requests.length) }, () => worker())
    );
    return results;
  }

  getSchedulerStats() {
    return this.scheduler.getStats();
  }

  getAdmissionStats() {
    return this.scheduler.getAdmissionStats();
  }

  getExecutionHistory(limit?: number): ExecutionHistoryEntry[] {
    return limit ? this.executionHistory.slice(-limit) : [...this.executionHistory];
  }

  clearHistory(): void {
    this.executionHistory.length = 0;
    this.emit('historyClear', { timestamp: Date.now() });
  }

  getStats(): ExecutionStats {
    const stats: ExecutionStats = {
      totalExecutions: this.executionHistory.length,
      successfulExecutions: 0,
      failedExecutions: 0,
      averageDuration: 0,
      toolUsage: new Map(),
      recentExecutions: this.executionHistory.slice(-10),
    };
    let totalDuration = 0;

    for (const entry of this.executionHistory) {
      if (entry.result.success) {
        stats.successfulExecutions++;
      } else {
        stats.failedExecutions++;
      }
      totalDuration += entry.endTime - entry.startTime;
      stats.toolUsage.set(
        entry.toolName,
        (stats.toolUsage.get(entry.toolName) || 0) + 1
      );
    }

    stats.averageDuration =
      stats.totalExecutions > 0 ? totalDuration / stats.totalExecutions : 0;
    return stats;
  }

  getRegistry(): ToolRegistry {
    return this.registry;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.concurrencyGate.close('tool-executor-disposed');
    this.scheduler.cancelOwner(this.ownerId);
    this.onDispose?.();
    this.removeAllListeners();
  }

  private createDisposedResult(): ToolResult {
    const cancelled = createCancellationResult(true);
    return {
      ...cancelled,
      metadata: {
        ...cancelled.metadata,
        executorDisposed: true,
      },
    };
  }

  private projectAdmissionFailure(
    toolName: string,
    error: unknown
  ): ToolResult | undefined {
    if (error instanceof ToolAdmissionError && error.reason !== 'closed') {
      const kind = this.registry.get(toolName)?.kind ?? error.kind;
      return {
        success: false,
        llmContent: 'Tool execution capacity is busy. Retry this tool in a later turn.',
        error: {
          type: ToolErrorType.RESOURCE_EXHAUSTED,
          code: 'tool_busy',
          message: error.message,
        },
        metadata: {
          summary: 'Tool execution capacity is busy',
          tool_admission: {
            code: 'tool_busy',
            reason: error.reason,
            scope: error.scope,
            retryable: error.retryable,
            kind,
            limit: error.limit,
          },
        },
      };
    }
    if (error instanceof ToolConcurrencyGateOverflowError) {
      const kind = this.registry.get(toolName)?.kind ?? ToolKind.Execute;
      return {
        success: false,
        llmContent: 'Tool execution capacity is busy. Retry this tool in a later turn.',
        error: {
          type: ToolErrorType.RESOURCE_EXHAUSTED,
          code: 'tool_busy',
          message: error.message,
        },
        metadata: {
          summary: 'Tool execution queue is full',
          tool_admission: {
            code: 'tool_busy',
            reason: 'queue_full',
            scope: 'session',
            retryable: true,
            kind,
            limit: error.limit,
          },
        },
      };
    }
    if (
      error instanceof ToolAdmissionError ||
      error instanceof ToolConcurrencyGateClosedError
    ) {
      return this.createDisposedResult();
    }
    return undefined;
  }

  private addToHistory(entry: ExecutionHistoryEntry): void {
    this.executionHistory.push(entry);
    if (this.executionHistory.length > this.maxHistorySize) {
      this.executionHistory.splice(
        0,
        this.executionHistory.length - this.maxHistorySize
      );
    }
  }

  private validateRemoteDeclaredPaths(
    toolName: string,
    tool: { readonly kind: ToolKind; readonly isConcurrencySafe: boolean },
    invocation: ToolInvocation<unknown>,
    isBuiltin: boolean
  ): ToolResult | undefined {
    if (this.workspaceToolPolicy?.kind !== 'acp-remote') {
      return undefined;
    }

    const value = invocation.params;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }
    const params = value as Record<string, unknown>;
    const pathCandidates = new Set<string>();
    for (const parameterPath of [params.file_path, params.notebook_path]) {
      if (typeof parameterPath === 'string') {
        pathCandidates.add(parameterPath);
      }
    }
    const usesDedicatedRemotePathPreflight = isBuiltin && toolName === 'ApplyPatch';
    if (
      !usesDedicatedRemotePathPreflight &&
      tool.kind === ToolKind.Write &&
      typeof params.path === 'string'
    ) {
      pathCandidates.add(params.path);
    }
    if (!usesDedicatedRemotePathPreflight) {
      let affectedPaths: string[];
      try {
        affectedPaths = invocation.getAffectedPaths();
      } catch {
        return createInvalidAcpRemotePathResult({
          mutation: tool.kind !== ToolKind.ReadOnly,
        });
      }
      for (const affectedPath of affectedPaths) {
        if (typeof affectedPath === 'string') {
          pathCandidates.add(affectedPath);
        }
      }
    }

    try {
      for (const candidate of pathCandidates) {
        parseAcpRemotePath(candidate, this.workspaceToolPolicy.pathStyle);
      }
      return undefined;
    } catch (error) {
      if (!(error instanceof AcpRemotePathError)) {
        throw error;
      }
      return createInvalidAcpRemotePathResult({
        mutation: tool.kind !== ToolKind.ReadOnly,
      });
    }
  }
}

export interface ToolExecutorConfig {
  maxHistorySize?: number;
  permissionConfig?: PermissionConfig;
  permissionMode?: PermissionMode;
  approvalStore?: SessionApprovalStore;
  toolWhitelist?: readonly string[];
  toolBlacklist?: readonly string[];
  workspaceToolPolicy?: WorkspaceToolPolicy;
  scheduler?: ConcurrencyScheduler;
  concurrencyLimits?: ConcurrencyLimits;
  contextDefaults?: ExecutionContext;
  autoVerifyRuntime?: Pick<AutoVerifyRuntime, 'verify'>;
  lspManager?: Pick<LspSessionManager, 'afterToolUse'>;
  onDispose?: () => void;
}

function freezeExecutionContextDefaults(
  context: ExecutionContext | undefined
): ExecutionContext {
  const environment = context?.environment
    ? Object.freeze({ ...context.environment })
    : undefined;
  return Object.freeze({
    ...context,
    ...(environment ? { environment } : {}),
  });
}

function requireRemoteExecutionContextDefaults(
  context: ExecutionContext
): RemoteExecutionContextDefaults {
  if (
    !context.sessionId ||
    !context.workspaceRoot ||
    !context.executionRoot ||
    context.workspaceKind !== 'acp-remote'
  ) {
    throw new Error('ACP remote ToolExecutor requires runtime-owned context defaults');
  }
  return context as RemoteExecutionContextDefaults;
}

function hasClassifiedSideEffectOutcome(result: ToolResult): boolean {
  if (!result.metadata || typeof result.metadata !== 'object') {
    return false;
  }
  return Object.hasOwn(result.metadata, 'sideEffectsUncertain');
}

export interface ExecutionStats {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  averageDuration: number;
  toolUsage: Map<string, number>;
  recentExecutions: ExecutionHistoryEntry[];
}

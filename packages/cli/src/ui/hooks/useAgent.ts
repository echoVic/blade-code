/**
 * Agent 生命周期管理工具
 * 负责创建、初始化和清理 Agent 实例
 */

import { useMemoizedFn } from 'ahooks';
import { useEffect, useRef } from 'react';
import { Agent } from '../../agent/Agent.js';
import type { LoopEvent } from '../../agent/loop/types.js';
import type { SteeringEnqueueResult } from '../../agent/runtime/ActiveTurnMailbox.js';
import {
  type ResumedSubagent,
  SessionRuntime,
  type SessionUserShellCommandEvent,
} from '../../agent/runtime/SessionRuntime.js';
import type { AgentSession } from '../../agent/subagents/AgentSessionStore.js';
import type { SubagentConfig } from '../../agent/subagents/types.js';
import type { UserMessageContent } from '../../agent/types.js';
import type {
  CommunicationStyleSelection,
  PermissionMode,
  ReasoningEffortSelection,
  ResponseVerbositySelection,
  ServiceTierSelection,
} from '../../config/types.js';
import type {
  McpCompletionInput,
  McpNormalizedCompletionResult,
} from '../../mcp/McpCompletion.js';
import type { McpNormalizedPromptResult } from '../../mcp/McpContentCatalog.js';
import type { McpLogLevel } from '../../mcp/McpLogging.js';
import type { McpTaskSnapshot } from '../../mcp/McpTasks.js';
import {
  type CodeReviewRequest,
  CodeReviewService,
  renderCodeReview,
} from '../../services/CodeReviewService.js';
import { registerCleanup } from '../../services/GracefulShutdown.js';
import {
  type RewindSessionOptions,
  type RewoundSession,
  SessionMissingCreationError,
  type SessionRewindCheckpoint,
  SessionService,
} from '../../services/SessionService.js';
import { appActions, vanillaStore } from '../../store/vanilla.js';
import { getCwd } from '../../utils/cwd.js';

export interface AgentOptions {
  sessionId?: string;
  workspaceRoot?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  maxTurns?: number;
  modelId?: string;
  permissionMode?: PermissionMode;
  reasoningEffort?: ReasoningEffortSelection;
  serviceTier?: ServiceTierSelection;
  responseVerbosity?: ResponseVerbositySelection;
  communicationStyle?: CommunicationStyleSelection;
  agents?: SubagentConfig[];
}

/**
 * Agent 管理 Hook
 * 提供创建和清理 Agent 的方法
 *
 * 注意：Agent 现在直接通过 vanilla store 更新 tasks，
 * 不再需要 onTaskUpdate 回调
 *
 * @param options - Agent 配置选项
 * @returns Agent ref 和创建/清理方法
 */
export function useAgent(options: AgentOptions) {
  const agentRef = useRef<Agent | undefined>(undefined);
  const runtimeRef = useRef<SessionRuntime | undefined>(undefined);
  const persistedSettingsRef = useRef<
    | {
        sessionId: string;
        modelId?: string;
        permissionMode?: PermissionMode;
        reasoningEffort?: ReasoningEffortSelection;
        serviceTier?: ServiceTierSelection;
        responseVerbosity?: ResponseVerbositySelection;
        communicationStyle?: CommunicationStyleSelection;
        communicationStyleDigest?: string;
      }
    | undefined
  >(undefined);
  const cleanupPromiseRef = useRef<Promise<void> | undefined>(undefined);

  /**
   * Release the complete runtime ownership boundary. Clearing refs first makes
   * concurrent shutdown/unmount cleanup idempotent while disposal is in flight.
   */
  const cleanupAgent = useMemoizedFn(async (): Promise<void> => {
    if (cleanupPromiseRef.current) {
      return cleanupPromiseRef.current;
    }

    const agent = agentRef.current;
    const runtime = runtimeRef.current;
    if (!agent && !runtime) return;

    agentRef.current = undefined;
    runtimeRef.current = undefined;
    persistedSettingsRef.current = undefined;

    const cleanupPromise = (async () => {
      try {
        await agent?.destroy();
      } finally {
        await runtime?.dispose();
      }
    })();
    cleanupPromiseRef.current = cleanupPromise;

    try {
      await cleanupPromise;
    } finally {
      if (cleanupPromiseRef.current === cleanupPromise) {
        cleanupPromiseRef.current = undefined;
      }
    }
  });

  const getOrCreateSessionRuntime = useMemoizedFn(
    async (sessionId: string): Promise<SessionRuntime> => {
      const workspaceRoot =
        options.workspaceRoot ?? runtimeRef.current?.workspaceRoot ?? getCwd();
      if (
        runtimeRef.current &&
        (runtimeRef.current.sessionId !== sessionId ||
          runtimeRef.current.workspaceRoot !== workspaceRoot)
      ) {
        await cleanupAgent();
      }
      if (!runtimeRef.current) {
        const metadata = await SessionService.findSessionMetadata(
          sessionId,
          workspaceRoot
        );
        const isResume =
          metadata !== undefined &&
          (await SessionService.loadSession(sessionId, workspaceRoot)).length > 0;
        runtimeRef.current = await SessionRuntime.create({
          sessionId,
          workspaceRoot,
          modelId: options.modelId,
          permissionMode:
            options.permissionMode ??
            (metadata?.permissionMode as PermissionMode | undefined),
          reasoningEffort: metadata?.reasoningEffort ?? options.reasoningEffort,
          serviceTier: metadata?.serviceTier ?? options.serviceTier,
          responseVerbosity: metadata?.responseVerbosity ?? options.responseVerbosity,
          communicationStyle:
            metadata?.communicationStyle ?? options.communicationStyle,
          communicationStyleDigest: metadata?.communicationStyleDigest,
          agents: options.agents,
          ...(isResume
            ? {
                sessionStart: {
                  isResume: true,
                  resumeSessionId: sessionId,
                },
              }
            : {}),
        });
        try {
          persistedSettingsRef.current = {
            sessionId,
            modelId: metadata?.selectedModelId,
            permissionMode: metadata?.permissionMode as PermissionMode | undefined,
            reasoningEffort: metadata?.reasoningEffort,
            serviceTier: metadata?.serviceTier,
            responseVerbosity: metadata?.responseVerbosity,
            communicationStyle: metadata?.communicationStyle,
            communicationStyleDigest: metadata?.communicationStyleDigest,
          };
          appActions().setReasoningEffort(
            runtimeRef.current.getReasoningConfiguration().selection
          );
          appActions().setServiceTier(
            runtimeRef.current.getServiceTierConfiguration().selection
          );
          appActions().setResponseVerbosity(
            runtimeRef.current.getResponseVerbosityConfiguration().selection
          );
          appActions().setCommunicationStyle(
            runtimeRef.current.getCommunicationStyleConfiguration().selection
          );
        } catch (error) {
          const runtime = runtimeRef.current;
          runtimeRef.current = undefined;
          await runtime.dispose().catch(() => undefined);
          throw error;
        }
      }
      return runtimeRef.current;
    }
  );

  /**
   * 创建并设置 Agent 实例
   */
  const createAgent = useMemoizedFn(
    async (overrides?: Partial<AgentOptions>): Promise<Agent> => {
      const sessionId = overrides?.sessionId ?? options.sessionId;
      const shouldUseEphemeralRuntime =
        !!overrides?.modelId && overrides.modelId !== options.modelId;

      let agent: Agent;
      if (!shouldUseEphemeralRuntime && sessionId) {
        const hadOwnedRuntime = runtimeRef.current !== undefined;
        const runtime = await getOrCreateSessionRuntime(sessionId);
        const requestedModelId = overrides?.modelId ?? options.modelId;
        const requestedReasoningEffort =
          overrides?.reasoningEffort ??
          (hadOwnedRuntime
            ? options.reasoningEffort
            : runtime.getReasoningConfiguration().selection);
        const requestedServiceTier =
          overrides?.serviceTier ??
          (hadOwnedRuntime
            ? options.serviceTier
            : runtime.getServiceTierConfiguration().selection);
        const requestedResponseVerbosity =
          overrides?.responseVerbosity ??
          (hadOwnedRuntime
            ? options.responseVerbosity
            : runtime.getResponseVerbosityConfiguration().selection);
        const requestedCommunicationStyle =
          overrides?.communicationStyle ??
          (hadOwnedRuntime
            ? options.communicationStyle
            : runtime.getCommunicationStyleConfiguration().selection);
        const previousModelId = runtime.getCurrentModelId();
        const previousReasoning = runtime.getReasoningConfiguration();
        const previousServiceTier = runtime.getServiceTierConfiguration();
        const previousResponseVerbosity = runtime.getResponseVerbosityConfiguration();
        const previousCommunicationStyle = runtime.getCommunicationStyleConfiguration();
        if (
          options.permissionMode &&
          (persistedSettingsRef.current?.sessionId !== sessionId ||
            persistedSettingsRef.current.permissionMode !== options.permissionMode)
        ) {
          const metadata = await SessionService.setSessionPermissionMode(
            sessionId,
            runtime.workspaceRoot,
            options.permissionMode
          );
          persistedSettingsRef.current = {
            ...persistedSettingsRef.current,
            sessionId,
            permissionMode: metadata.permissionMode as PermissionMode | undefined,
          };
        }
        await runtime.refresh({
          modelId: requestedModelId,
          ...(requestedReasoningEffort
            ? { reasoningEffort: requestedReasoningEffort }
            : {}),
          ...(requestedServiceTier ? { serviceTier: requestedServiceTier } : {}),
          ...(requestedResponseVerbosity
            ? { responseVerbosity: requestedResponseVerbosity }
            : {}),
          ...(requestedCommunicationStyle
            ? { communicationStyle: requestedCommunicationStyle }
            : {}),
        });
        const nextCommunicationStyle = runtime.getCommunicationStyleConfiguration();
        if (
          nextCommunicationStyle.source !== 'built-in' &&
          !nextCommunicationStyle.contentSha256
        ) {
          throw new Error('Custom communication style has no provenance');
        }
        const metadataUpdate = {
          ...(requestedModelId &&
          requestedModelId !== 'inherit' &&
          (persistedSettingsRef.current?.sessionId !== sessionId ||
            persistedSettingsRef.current.modelId !== requestedModelId)
            ? { selectedModelId: requestedModelId }
            : {}),
          ...(requestedReasoningEffort &&
          (persistedSettingsRef.current?.sessionId !== sessionId ||
            persistedSettingsRef.current.reasoningEffort !== requestedReasoningEffort)
            ? { reasoningEffort: requestedReasoningEffort }
            : {}),
          ...(requestedServiceTier &&
          (persistedSettingsRef.current?.sessionId !== sessionId ||
            persistedSettingsRef.current.serviceTier !== requestedServiceTier)
            ? { serviceTier: requestedServiceTier }
            : {}),
          ...(requestedResponseVerbosity &&
          (persistedSettingsRef.current?.sessionId !== sessionId ||
            persistedSettingsRef.current.responseVerbosity !==
              requestedResponseVerbosity)
            ? { responseVerbosity: requestedResponseVerbosity }
            : {}),
          ...(requestedCommunicationStyle &&
          (persistedSettingsRef.current?.sessionId !== sessionId ||
            persistedSettingsRef.current.communicationStyle !==
              requestedCommunicationStyle ||
            persistedSettingsRef.current.communicationStyleDigest !==
              nextCommunicationStyle.contentSha256)
            ? {
                communicationStyle: requestedCommunicationStyle,
                communicationStyleDigest:
                  nextCommunicationStyle.source === 'built-in'
                    ? null
                    : nextCommunicationStyle.contentSha256,
              }
            : {}),
        };
        if (Object.keys(metadataUpdate).length > 0) {
          try {
            const metadata = await SessionService.updateSessionMetadata(
              sessionId,
              runtime.workspaceRoot,
              metadataUpdate
            );
            persistedSettingsRef.current = {
              sessionId,
              modelId: metadata.selectedModelId,
              permissionMode: metadata.permissionMode as PermissionMode | undefined,
              reasoningEffort: metadata.reasoningEffort,
              serviceTier: metadata.serviceTier,
              responseVerbosity: metadata.responseVerbosity,
              communicationStyle: metadata.communicationStyle,
              communicationStyleDigest: metadata.communicationStyleDigest,
            };
          } catch (error) {
            await runtime
              .refresh({
                ...(previousModelId ? { modelId: previousModelId } : {}),
                reasoningEffort: previousReasoning.selection,
                serviceTier: previousServiceTier.selection,
                responseVerbosity: previousResponseVerbosity.selection,
                communicationStyle: previousCommunicationStyle.selection,
              })
              .catch(() => undefined);
            throw error;
          }
        }

        agent = await Agent.createWithRuntime(runtime, {
          sessionId,
          systemPrompt: overrides?.systemPrompt ?? options.systemPrompt,
          appendSystemPrompt:
            overrides?.appendSystemPrompt ?? options.appendSystemPrompt,
          maxTurns: overrides?.maxTurns ?? options.maxTurns,
          modelId: overrides?.modelId ?? options.modelId,
          permissionMode: overrides?.permissionMode ?? options.permissionMode,
          agents: options.agents,
        });
      } else {
        agent = await Agent.create({
          systemPrompt: overrides?.systemPrompt ?? options.systemPrompt,
          appendSystemPrompt:
            overrides?.appendSystemPrompt ?? options.appendSystemPrompt,
          maxTurns: overrides?.maxTurns ?? options.maxTurns,
          modelId: overrides?.modelId ?? options.modelId,
          permissionMode: overrides?.permissionMode ?? options.permissionMode,
          agents: options.agents,
        });
      }
      agentRef.current = agent;

      // Agent 现在直接通过 vanilla store 更新 UI 状态
      // 不再需要设置事件监听器

      return agent;
    }
  );

  const listRewindCheckpoints = useMemoizedFn(
    async (): Promise<SessionRewindCheckpoint[]> => {
      if (!options.sessionId) {
        throw new Error('No active session to rewind');
      }
      return (
        await getOrCreateSessionRuntime(options.sessionId)
      ).listRewindCheckpoints();
    }
  );

  const rewindSession = useMemoizedFn(
    async (rewindOptions: RewindSessionOptions): Promise<RewoundSession> => {
      if (!options.sessionId) {
        throw new Error('No active session to rewind');
      }
      const runtime = await getOrCreateSessionRuntime(options.sessionId);
      const result = await runtime.rewindSession(rewindOptions);
      await cleanupAgent();
      return result;
    }
  );

  const listSubagents = useMemoizedFn(async (): Promise<AgentSession[]> => {
    if (!options.sessionId) {
      throw new Error('No active session for subagent control');
    }
    return (await getOrCreateSessionRuntime(options.sessionId)).listSubagents();
  });

  const resumeSubagent = useMemoizedFn(
    async (agentId: string, prompt: string): Promise<ResumedSubagent> => {
      if (!options.sessionId) {
        throw new Error('No active session for subagent control');
      }
      const runtime = await getOrCreateSessionRuntime(options.sessionId);
      let announced = false;
      let pendingCompletion: AgentSession | undefined;
      let progressId = agentId;
      const complete = (session: AgentSession) => {
        const terminalSummary =
          session.status === 'completed'
            ? session.result?.message
            : session.result?.error || session.result?.message;
        vanillaStore
          .getState()
          .app.actions.completeSubagentProgress(
            progressId,
            session.status === 'completed',
            terminalSummary
          );
      };
      const result = runtime.resumeSubagent({
        agentId,
        prompt,
        onEvent: (event: LoopEvent) => {
          if (event.kind === 'tool_start' && 'function' in event.toolCall) {
            vanillaStore
              .getState()
              .app.actions.updateSubagentTool(progressId, event.toolCall.function.name);
          }
        },
        onCompleted: (session) => {
          if (announced) complete(session);
          else pendingCompletion = session;
        },
      });
      progressId = result.session.id;
      vanillaStore
        .getState()
        .app.actions.startSubagentProgress(
          result.session.id,
          result.session.subagentType,
          `Resumed from ${result.source.id}: ${result.session.description}`
        );
      announced = true;
      if (pendingCompletion) complete(pendingCompletion);
      return result;
    }
  );

  const getMcpContentCatalog = useMemoizedFn(async () => {
    if (!options.sessionId) {
      throw new Error('No active session for MCP content');
    }
    return (await getOrCreateSessionRuntime(options.sessionId)).getMcpContentCatalog();
  });

  const refreshMcpContentCatalogs = useMemoizedFn(
    async (serverName?: string): Promise<void> => {
      if (!options.sessionId) {
        throw new Error('No active session for MCP content');
      }
      await (
        await getOrCreateSessionRuntime(options.sessionId)
      ).refreshMcpContentCatalogs(serverName);
    }
  );

  const getMcpPrompt = useMemoizedFn(
    async (
      serverName: string,
      name: string,
      arguments_: Record<string, string>
    ): Promise<McpNormalizedPromptResult> => {
      if (!options.sessionId) {
        throw new Error('No active session for MCP prompts');
      }
      return (await getOrCreateSessionRuntime(options.sessionId)).getMcpPrompt(
        serverName,
        name,
        arguments_
      );
    }
  );

  const completeMcpArgument = useMemoizedFn(
    async (
      serverName: string,
      input: McpCompletionInput,
      signal?: AbortSignal
    ): Promise<McpNormalizedCompletionResult> => {
      if (!options.sessionId) {
        throw new Error('No active session for MCP completion');
      }
      return (await getOrCreateSessionRuntime(options.sessionId)).completeMcpArgument(
        serverName,
        input,
        signal
      );
    }
  );

  const getMcpLogs = useMemoizedFn(
    async (
      serverName?: string,
      query: { afterRevision?: number; limit?: number } = {}
    ) => {
      if (!options.sessionId) {
        throw new Error('No active session for MCP logs');
      }
      return (await getOrCreateSessionRuntime(options.sessionId)).getMcpLogs(
        serverName,
        query
      );
    }
  );

  const listMcpTasks = useMemoizedFn(
    async (serverName?: string): Promise<McpTaskSnapshot[]> => {
      if (!options.sessionId) {
        throw new Error('No active session for MCP tasks');
      }
      return (await getOrCreateSessionRuntime(options.sessionId)).listMcpTasks(
        serverName
      );
    }
  );

  const getMcpTask = useMemoizedFn(
    async (taskId: string): Promise<McpTaskSnapshot | undefined> => {
      if (!options.sessionId) {
        throw new Error('No active session for MCP tasks');
      }
      return (await getOrCreateSessionRuntime(options.sessionId)).getMcpTask(taskId);
    }
  );

  const cancelMcpTask = useMemoizedFn(
    async (
      taskId: string,
      signal?: AbortSignal
    ): Promise<McpTaskSnapshot | undefined> => {
      if (!options.sessionId) {
        throw new Error('No active session for MCP tasks');
      }
      return (await getOrCreateSessionRuntime(options.sessionId)).cancelMcpTask(
        taskId,
        signal
      );
    }
  );

  const setMcpLoggingLevel = useMemoizedFn(
    async (serverName: string, level: McpLogLevel): Promise<void> => {
      if (!options.sessionId) {
        throw new Error('No active session for MCP logging');
      }
      await (await getOrCreateSessionRuntime(options.sessionId)).setMcpLoggingLevel(
        serverName,
        level
      );
    }
  );

  const getMcpInstructions = useMemoizedFn(async () => {
    if (!options.sessionId) {
      throw new Error('No active session for MCP instructions');
    }
    return (await getOrCreateSessionRuntime(options.sessionId)).getMcpInstructions();
  });

  const getReasoningConfiguration = useMemoizedFn(async () => {
    if (!options.sessionId) {
      throw new Error('No active session for reasoning effort');
    }
    return (
      await getOrCreateSessionRuntime(options.sessionId)
    ).getReasoningConfiguration();
  });

  const setReasoningEffort = useMemoizedFn(
    async (reasoningEffort: ReasoningEffortSelection) => {
      if (!options.sessionId) {
        throw new Error('No active session for reasoning effort');
      }
      const runtime = await getOrCreateSessionRuntime(options.sessionId);
      if (runtime.hasTurnOwner()) {
        throw new Error('Cannot switch reasoning effort while a turn is active');
      }
      const previous = runtime.getReasoningConfiguration();
      runtime.resolveReasoningConfiguration(reasoningEffort);
      if (previous.selection === reasoningEffort) return previous;
      await runtime.refresh({ reasoningEffort });
      try {
        let metadata;
        try {
          metadata = await SessionService.updateSessionMetadata(
            options.sessionId,
            runtime.workspaceRoot,
            { reasoningEffort }
          );
        } catch (error) {
          if (
            !(error instanceof SessionMissingCreationError) &&
            (error as NodeJS.ErrnoException).code !== 'ENOENT'
          ) {
            throw error;
          }
          metadata = await SessionService.createSessionMetadata(
            options.sessionId,
            runtime.workspaceRoot,
            {
              taskStatus: 'completed',
              selectedModelId: runtime.getCurrentModelId(),
              reasoningEffort,
              serviceTier: runtime.getServiceTierConfiguration().selection,
              responseVerbosity: runtime.getResponseVerbosityConfiguration().selection,
              communicationStyle:
                runtime.getCommunicationStyleConfiguration().selection,
            }
          );
        }
        persistedSettingsRef.current = {
          sessionId: options.sessionId,
          modelId: metadata.selectedModelId,
          permissionMode: metadata.permissionMode as PermissionMode | undefined,
          reasoningEffort: metadata.reasoningEffort,
          serviceTier: metadata.serviceTier,
          responseVerbosity: metadata.responseVerbosity,
          communicationStyle: metadata.communicationStyle,
          communicationStyleDigest: metadata.communicationStyleDigest,
        };
        appActions().setReasoningEffort(reasoningEffort);
        return runtime.getReasoningConfiguration();
      } catch (error) {
        await runtime.refresh({ reasoningEffort: previous.selection });
        throw error;
      }
    }
  );

  const getServiceTierConfiguration = useMemoizedFn(async () => {
    if (!options.sessionId) {
      throw new Error('No active session for service tier');
    }
    return (
      await getOrCreateSessionRuntime(options.sessionId)
    ).getServiceTierConfiguration();
  });

  const setServiceTier = useMemoizedFn(async (serviceTier: ServiceTierSelection) => {
    if (!options.sessionId) {
      throw new Error('No active session for service tier');
    }
    const runtime = await getOrCreateSessionRuntime(options.sessionId);
    if (runtime.hasTurnOwner()) {
      throw new Error('Cannot switch service tier while a turn is active');
    }
    const previous = runtime.getServiceTierConfiguration();
    runtime.resolveServiceTierConfiguration(serviceTier);
    if (previous.selection === serviceTier) return previous;
    await runtime.refresh({ serviceTier });
    try {
      let metadata;
      try {
        metadata = await SessionService.updateSessionMetadata(
          options.sessionId,
          runtime.workspaceRoot,
          { serviceTier }
        );
      } catch (error) {
        if (
          !(error instanceof SessionMissingCreationError) &&
          (error as NodeJS.ErrnoException).code !== 'ENOENT'
        ) {
          throw error;
        }
        metadata = await SessionService.createSessionMetadata(
          options.sessionId,
          runtime.workspaceRoot,
          {
            taskStatus: 'completed',
            selectedModelId: runtime.getCurrentModelId(),
            reasoningEffort: runtime.getReasoningConfiguration().selection,
            serviceTier,
            responseVerbosity: runtime.getResponseVerbosityConfiguration().selection,
            communicationStyle: runtime.getCommunicationStyleConfiguration().selection,
          }
        );
      }
      persistedSettingsRef.current = {
        sessionId: options.sessionId,
        modelId: metadata.selectedModelId,
        permissionMode: metadata.permissionMode as PermissionMode | undefined,
        reasoningEffort: metadata.reasoningEffort,
        serviceTier: metadata.serviceTier,
        responseVerbosity: metadata.responseVerbosity,
        communicationStyle: metadata.communicationStyle,
        communicationStyleDigest: metadata.communicationStyleDigest,
      };
      appActions().setServiceTier(serviceTier);
      return runtime.getServiceTierConfiguration();
    } catch (error) {
      await runtime.refresh({ serviceTier: previous.selection });
      throw error;
    }
  });

  const getResponseVerbosityConfiguration = useMemoizedFn(async () => {
    if (!options.sessionId) {
      throw new Error('No active session for response verbosity');
    }
    return (
      await getOrCreateSessionRuntime(options.sessionId)
    ).getResponseVerbosityConfiguration();
  });

  const setResponseVerbosity = useMemoizedFn(
    async (responseVerbosity: ResponseVerbositySelection) => {
      if (!options.sessionId) {
        throw new Error('No active session for response verbosity');
      }
      const runtime = await getOrCreateSessionRuntime(options.sessionId);
      if (runtime.hasTurnOwner()) {
        throw new Error('Cannot switch response verbosity while a turn is active');
      }
      const previous = runtime.getResponseVerbosityConfiguration();
      runtime.resolveResponseVerbosityConfiguration(responseVerbosity);
      if (previous.selection === responseVerbosity) return previous;
      await runtime.refresh({ responseVerbosity });
      try {
        let metadata;
        try {
          metadata = await SessionService.updateSessionMetadata(
            options.sessionId,
            runtime.workspaceRoot,
            { responseVerbosity }
          );
        } catch (error) {
          if (
            !(error instanceof SessionMissingCreationError) &&
            (error as NodeJS.ErrnoException).code !== 'ENOENT'
          ) {
            throw error;
          }
          metadata = await SessionService.createSessionMetadata(
            options.sessionId,
            runtime.workspaceRoot,
            {
              taskStatus: 'completed',
              selectedModelId: runtime.getCurrentModelId(),
              reasoningEffort: runtime.getReasoningConfiguration().selection,
              serviceTier: runtime.getServiceTierConfiguration().selection,
              responseVerbosity,
              communicationStyle:
                runtime.getCommunicationStyleConfiguration().selection,
            }
          );
        }
        persistedSettingsRef.current = {
          sessionId: options.sessionId,
          modelId: metadata.selectedModelId,
          permissionMode: metadata.permissionMode as PermissionMode | undefined,
          reasoningEffort: metadata.reasoningEffort,
          serviceTier: metadata.serviceTier,
          responseVerbosity: metadata.responseVerbosity,
          communicationStyle: metadata.communicationStyle,
          communicationStyleDigest: metadata.communicationStyleDigest,
        };
        appActions().setResponseVerbosity(responseVerbosity);
        return runtime.getResponseVerbosityConfiguration();
      } catch (error) {
        await runtime.refresh({ responseVerbosity: previous.selection });
        throw error;
      }
    }
  );

  const getCommunicationStyleConfiguration = useMemoizedFn(async () => {
    if (!options.sessionId) {
      throw new Error('No active session for communication style');
    }
    return (
      await getOrCreateSessionRuntime(options.sessionId)
    ).getCommunicationStyleConfiguration();
  });

  const setCommunicationStyle = useMemoizedFn(
    async (communicationStyle: CommunicationStyleSelection) => {
      if (!options.sessionId) {
        throw new Error('No active session for communication style');
      }
      const runtime = await getOrCreateSessionRuntime(options.sessionId);
      if (runtime.hasTurnOwner()) {
        throw new Error('Cannot switch communication style while a turn is active');
      }
      const previous = runtime.getCommunicationStyleConfiguration();
      const next = runtime.resolveCommunicationStyleConfiguration(communicationStyle);
      if (next.source !== 'built-in' && !next.contentSha256) {
        throw new Error('Custom communication style has no provenance');
      }
      if (previous.selection === communicationStyle) return previous;
      await runtime.refresh({ communicationStyle });
      try {
        let metadata;
        try {
          metadata = await SessionService.updateSessionMetadata(
            options.sessionId,
            runtime.workspaceRoot,
            {
              communicationStyle,
              communicationStyleDigest:
                next.source === 'built-in' ? null : next.contentSha256,
            }
          );
        } catch (error) {
          if (
            !(error instanceof SessionMissingCreationError) &&
            (error as NodeJS.ErrnoException).code !== 'ENOENT'
          ) {
            throw error;
          }
          metadata = await SessionService.createSessionMetadata(
            options.sessionId,
            runtime.workspaceRoot,
            {
              taskStatus: 'completed',
              selectedModelId: runtime.getCurrentModelId(),
              reasoningEffort: runtime.getReasoningConfiguration().selection,
              serviceTier: runtime.getServiceTierConfiguration().selection,
              responseVerbosity: runtime.getResponseVerbosityConfiguration().selection,
              communicationStyle,
              ...(next.source !== 'built-in' && next.contentSha256
                ? { communicationStyleDigest: next.contentSha256 }
                : {}),
            }
          );
        }
        persistedSettingsRef.current = {
          sessionId: options.sessionId,
          modelId: metadata.selectedModelId,
          permissionMode: metadata.permissionMode as PermissionMode | undefined,
          reasoningEffort: metadata.reasoningEffort,
          serviceTier: metadata.serviceTier,
          responseVerbosity: metadata.responseVerbosity,
          communicationStyle: metadata.communicationStyle,
          communicationStyleDigest: metadata.communicationStyleDigest,
        };
        appActions().setCommunicationStyle(communicationStyle);
        return runtime.getCommunicationStyleConfiguration();
      } catch (error) {
        await runtime.refresh({ communicationStyle: previous.selection });
        throw error;
      }
    }
  );

  const steerActiveTurn = useMemoizedFn(
    async (content: UserMessageContent): Promise<SteeringEnqueueResult> => {
      if (!runtimeRef.current) {
        return { accepted: false, queued: 0, reason: 'no_active_turn' };
      }
      return runtimeRef.current.enqueueSteering(content, {
        allowBeforeTurn: true,
      });
    }
  );

  const executeUserShellCommand = useMemoizedFn(
    async (
      command: string,
      shellOptions?: {
        signal?: AbortSignal;
        onEvent?: (event: SessionUserShellCommandEvent) => void | Promise<void>;
      }
    ) => {
      const targetSessionId = options.sessionId;
      if (!targetSessionId) {
        throw new Error('User shell command requires a Session');
      }
      const runtime = await getOrCreateSessionRuntime(targetSessionId);
      return runtime.executeUserShellCommand(command, shellOptions);
    }
  );

  const runCodeReview = useMemoizedFn(
    async (request: CodeReviewRequest, signal?: AbortSignal) => {
      const targetSessionId = options.sessionId;
      if (!targetSessionId) {
        throw new Error('Code review requires a Session');
      }
      const runtime = await getOrCreateSessionRuntime(targetSessionId);
      await CodeReviewService.recoverInterrupted(
        runtime.workspaceRoot,
        targetSessionId,
        runtime
      );
      const run = await CodeReviewService.start({
        sessionId: targetSessionId,
        projectPath: runtime.workspaceRoot,
        runtime,
        request,
        signal,
      });
      const completion = await run.completion;
      const projected = (
        await CodeReviewService.list(runtime.workspaceRoot, targetSessionId)
      ).find((review) => review.start.reviewId === run.reviewId);
      if (!projected)
        throw new Error(`Review not found after completion: ${run.reviewId}`);
      return {
        reviewId: run.reviewId,
        status: completion.status,
        findings: completion.findings.length,
        content: renderCodeReview(projected.start, completion),
      };
    }
  );

  useEffect(() => {
    const unregisterCleanup = registerCleanup(cleanupAgent);
    return () => {
      unregisterCleanup();
      void cleanupAgent().catch(() => undefined);
    };
  }, [cleanupAgent]);

  return {
    agentRef,
    createAgent,
    cleanupAgent,
    steerActiveTurn,
    runCodeReview,
    executeUserShellCommand,
    listRewindCheckpoints,
    rewindSession,
    listSubagents,
    resumeSubagent,
    getMcpContentCatalog,
    refreshMcpContentCatalogs,
    getMcpPrompt,
    completeMcpArgument,
    listMcpTasks,
    getMcpTask,
    cancelMcpTask,
    getMcpLogs,
    setMcpLoggingLevel,
    getMcpInstructions,
    getReasoningConfiguration,
    setReasoningEffort,
    getServiceTierConfiguration,
    setServiceTier,
    getResponseVerbosityConfiguration,
    setResponseVerbosity,
    getCommunicationStyleConfiguration,
    setCommunicationStyle,
  };
}

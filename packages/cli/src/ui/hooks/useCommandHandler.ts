/**
 * 命令处理编排 Hook
 *
 * 组合各子模块，负责任务生命周期管理（队列、abort controller、race condition 保护）。
 * 具体职责已拆分到：
 * - errorExtractor.ts — 统一错误分类
 * - messageContent.ts — 多模态输入序列化
 * - slashCommandRouter.ts — slash 命令路由与分派
 * - useStreamingBuffer.ts — 流式批处理缓冲
 * - loopEventHandler.ts — drainLoop 事件消费映射
 *
 * TuiStreamSession 收敛正常完成、abort 和 fallback 的流终态；
 * PendingResumeCoordinator 合并来自 UI、Team 和 Subagent 的恢复唤醒。
 */

import { randomUUID } from 'node:crypto';
import { useMemoizedFn } from 'ahooks';
import { useEffect, useMemo, useRef } from 'react';
import { drainLoop } from '../../agent/loop/index.js';
import type { LoopEvent } from '../../agent/loop/types.js';
import { FollowUpQueueMutationError } from '../../agent/runtime/FollowUpQueueProjection.js';
import { SessionRuntime } from '../../agent/runtime/SessionRuntime.js';
import { getSubagentRegistry } from '../../agent/subagents/SubagentRegistry.js';
import type { SubagentConfig } from '../../agent/subagents/types.js';
import { isTeamMessageMetadata, TeamMailbox } from '../../agent/teams/TeamMailbox.js';
import { TeamRuntime } from '../../agent/teams/TeamRuntime.js';
import type { LoopResult } from '../../agent/types.js';
import type { FollowUpQueueMutation } from '../../api/followUpQueueSchemas.js';
import { parseSideConversationCommand } from '../../api/sideConversation.js';
import type { PermissionMode } from '../../config/types.js';
import { getBladeStorageRoot } from '../../context/storage/pathUtils.js';
import { toTaskFailure } from '../../context/taskFailure.js';
import { HookManager } from '../../hooks/HookManager.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { Bus } from '../../server/bus.js';
import { sameSessionRef } from '../../server/sessionRef.js';
import { SessionInteractionService } from '../../services/SessionInteractionService.js';
import { renderUserShellCommandForDisplay } from '../../services/UserShellCommandService.js';
import type { SlashCommandContext } from '../../slash-commands/types.js';
import {
  useAgentTeamsEnabled,
  useAppActions,
  useCommandActions,
  useCommunicationStyle,
  useCurrentModelId,
  useIsProcessing,
  usePermissionMode,
  useReasoningEffort,
  useResponseVerbosity,
  useServiceTier,
  useSessionActions,
  useSessionId,
  useSideConversation,
  useThinkingModeEnabled,
  useWorkspaceRoot,
} from '../../store/selectors/index.js';
import {
  configActions,
  ensureStoreInitialized,
  getState,
} from '../../store/vanilla.js';
import type { ConfirmationHandler } from '../../tools/types/ExecutionTypes.js';
import {
  PendingResumeCoordinator,
  type PendingResumeRunResult,
  type PendingResumeWorkKind,
} from '../services/PendingResumeCoordinator.js';
import { TuiStreamSession } from '../services/TuiStreamSession.js';
import { classifyError } from '../utils/errorExtractor.js';
import {
  createLoopEventHandler,
  projectTurnRecoveryAssessment,
} from '../utils/loopEventHandler.js';
import { buildUserMessageContent } from '../utils/messageContent.js';
import { buildContextMessagesFromSession } from '../utils/sessionContext.js';
import {
  type CommandResult,
  processSlashCommand,
} from '../utils/slashCommandRouter.js';
import { useAgent } from './useAgent.js';
import type { ResolvedInput } from './useInputBuffer.js';
import { useStreamingBuffer } from './useStreamingBuffer.js';

const logger = createLogger(LogCategory.UI);

function retainSupersededVersion(
  versions: readonly string[] | undefined,
  version: string
): string[] {
  return [
    ...(versions ?? []).filter((candidate) => candidate !== version),
    version,
  ].slice(-16);
}

function isLoopCancellation(result: LoopResult): boolean {
  return (
    result.error?.type === 'canceled' ||
    result.error?.type === 'aborted' ||
    result.metadata?.abortReason === 'interrupt'
  );
}

/**
 * 命令处理 Hook
 * 负责命令的执行和状态管理
 */
export const useCommandHandler = (
  replaceSystemPrompt?: string,
  appendSystemPrompt?: string,
  confirmationHandler?: ConfirmationHandler,
  maxTurns?: number,
  onDismissConfirmations?: () => void,
  agents?: SubagentConfig[],
  sessionSurfaces?: SlashCommandContext['sessionSurfaces']
) => {
  // ==================== Store 选择器 ====================
  const isProcessing = useIsProcessing();
  const sessionId = useSessionId();
  const workspaceRoot = useWorkspaceRoot();
  const currentModelId = useCurrentModelId();
  const permissionMode = usePermissionMode();
  const thinkingModeEnabled = useThinkingModeEnabled();
  const reasoningEffort = useReasoningEffort();
  const serviceTier = useServiceTier();
  const responseVerbosity = useResponseVerbosity();
  const communicationStyle = useCommunicationStyle();
  const sideConversation = useSideConversation();
  const agentTeamsEnabled = useAgentTeamsEnabled();

  // ==================== Store Actions ====================
  const sessionActions = useSessionActions();
  const appActions = useAppActions();
  const commandActions = useCommandActions();

  // ==================== Local Refs ====================
  const abortMessageSentRef = useRef(false);
  const activeStreamSessionRef = useRef<TuiStreamSession | null>(null);
  const pendingResumeCoordinatorRef = useRef<PendingResumeCoordinator | null>(null);
  const sideConversationControllerRef = useRef<AbortController | null>(null);

  // ==================== 子模块组合 ====================
  const {
    createAgent,
    cleanupAgent,
    steerActiveTurn,
    enqueueSessionInput,
    getFollowUpQueue,
    mutateFollowUpQueue,
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
    runCodeReview,
    askSideQuestion,
    executeUserShellCommand,
    getTurnRecoveryAssessment,
  } = useAgent({
    sessionId,
    workspaceRoot,
    systemPrompt: replaceSystemPrompt,
    appendSystemPrompt: appendSystemPrompt,
    maxTurns: maxTurns,
    modelId: currentModelId,
    permissionMode,
    reasoningEffort,
    serviceTier,
    responseVerbosity,
    communicationStyle,
    agents,
  });

  const queueOwner = useMemo(
    () => [workspaceRoot, sessionId, randomUUID()].join('\0'),
    [sessionId, workspaceRoot]
  );

  const refreshFollowUpQueue = useMemoizedFn(async () => {
    const expectedVersion = getState().app.followUpQueue?.version;
    const previousMutation = getState().app.followUpQueueMutation;
    try {
      const snapshot = await getFollowUpQueue();
      const currentVersion = getState().app.followUpQueue?.version;
      const responseIsCurrent =
        currentVersion === expectedVersion || currentVersion === snapshot.version;
      if (responseIsCurrent) {
        appActions.projectFollowUpQueue(snapshot, queueOwner);
      }
      const versions = getState().app.followUpQueueMutation.supersededVersions;
      appActions.setFollowUpQueueMutation(
        previousMutation.errorCode === 'revision_conflict'
          ? {
              pending: false,
              errorCode: previousMutation.errorCode,
              errorMessage: previousMutation.errorMessage,
              supersededVersions: responseIsCurrent
                ? versions
                : retainSupersededVersion(versions, snapshot.version),
            }
          : {
              pending: false,
              supersededVersions: responseIsCurrent
                ? versions
                : retainSupersededVersion(versions, snapshot.version),
            },
        queueOwner
      );
    } catch {
      appActions.setFollowUpQueueMutation(
        {
          pending: false,
          errorMessage: 'Follow-up queue is unavailable',
        },
        queueOwner
      );
    }
  });

  const controlFollowUpQueue = useMemoizedFn(
    async (operation: FollowUpQueueMutation): Promise<boolean> => {
      const snapshot = getState().app.followUpQueue;
      if (!snapshot || getState().app.followUpQueueMutation.pending) return false;
      appActions.setFollowUpQueueMutation(
        { pending: true, messageId: operation.messageId },
        queueOwner
      );
      try {
        const result = await mutateFollowUpQueue({
          expectedVersion: snapshot.version,
          operation,
        });
        const currentVersion = getState().app.followUpQueue?.version;
        if (
          currentVersion === snapshot.version ||
          currentVersion === result.snapshot.version
        ) {
          appActions.projectFollowUpQueue(result.snapshot, queueOwner);
        }
        const responseIsCurrent =
          currentVersion === snapshot.version ||
          currentVersion === result.snapshot.version;
        const versions = getState().app.followUpQueueMutation.supersededVersions;
        appActions.setFollowUpQueueMutation(
          {
            pending: false,
            supersededVersions: responseIsCurrent
              ? versions
              : retainSupersededVersion(versions, result.snapshot.version),
          },
          queueOwner
        );
        if (operation.type === 'remove') {
          commandActions.takeFollowUpPresentation(operation.messageId);
        }
        return true;
      } catch (error) {
        if (error instanceof FollowUpQueueMutationError) {
          const currentVersion = getState().app.followUpQueue?.version;
          const responseIsCurrent =
            currentVersion === snapshot.version ||
            currentVersion === error.snapshot.version;
          if (responseIsCurrent) {
            appActions.projectFollowUpQueue(error.snapshot, queueOwner);
          }
          const versions = getState().app.followUpQueueMutation.supersededVersions;
          appActions.setFollowUpQueueMutation(
            {
              pending: false,
              errorCode: error.code,
              errorMessage: error.message,
              supersededVersions: responseIsCurrent
                ? versions
                : retainSupersededVersion(versions, error.snapshot.version),
            },
            queueOwner
          );
        } else {
          appActions.setFollowUpQueueMutation(
            {
              pending: false,
              errorMessage: 'Follow-up queue is unavailable',
            },
            queueOwner
          );
        }
        return false;
      }
    }
  );

  const streamingBuffer = useStreamingBuffer(sessionActions);
  const createStreamSession = useMemoizedFn(
    (signal: AbortSignal): TuiStreamSession =>
      new TuiStreamSession({
        signal,
        streamingBuffer,
        getStreamingMessageId: () => getState().session.currentStreamingMessageId,
        finalizeStreamingMessage: sessionActions.finalizeStreamingMessage,
        discardStreamingMessage: sessionActions.discardStreamingMessage,
        clearThinking: () => sessionActions.setCurrentThinkingContent(null),
      })
  );
  const refreshTeams = useMemoizedFn(async (): Promise<void> => {
    if (!agentTeamsEnabled || !sessionId) {
      appActions.setTeams([]);
      return;
    }
    try {
      const runtime = new TeamRuntime({
        configDir: getBladeStorageRoot(),
        subagentRegistry: getSubagentRegistry(workspaceRoot),
      });
      const teams = await runtime.list({
        sessionId,
        projectPath: workspaceRoot,
      });
      if (
        getState().session.sessionId === sessionId &&
        getState().session.workspaceRoot === workspaceRoot
      ) {
        appActions.setTeams(teams);
      }
    } catch (error) {
      logger.warn('[useCommandHandler] Failed to refresh Agent Teams', error);
    }
  });

  const handleUserShellCommand = useMemoizedFn(
    async (resolved: ResolvedInput, signal: AbortSignal): Promise<CommandResult> => {
      if (resolved.images.length > 0) {
        return {
          success: false,
          error: 'User shell commands do not accept image attachments',
        };
      }
      const command = resolved.text.trimStart().slice(1).trim();
      if (!command) {
        return { success: false, error: 'User shell command cannot be empty' };
      }
      sessionActions.setCommand(`! ${command}`);
      try {
        const result = await executeUserShellCommand(command, { signal });
        sessionActions.addMessage({
          id: `user-shell-${result.executionId}`,
          role: 'user',
          content: renderUserShellCommandForDisplay(result.record),
          timestamp: Date.now(),
          metadata: {
            userShellCommand: result.record,
          },
        });
        if (result.delivery === 'next_turn') {
          const currentSession = getState().session;
          if (
            currentSession.sessionId === sessionId &&
            currentSession.workspaceRoot === workspaceRoot
          ) {
            pendingResumeCoordinatorRef.current?.request();
          }
        }
        return {
          success: result.record.status !== 'spawn_error',
          output: renderUserShellCommandForDisplay(result.record),
          ...(result.record.status === 'spawn_error'
            ? { error: result.record.stderr || 'User shell command failed' }
            : {}),
        };
      } finally {
        sessionActions.setCommand(null);
      }
    }
  );

  // ==================== 生命周期 ====================
  useEffect(() => {
    return () => {
      activeStreamSessionRef.current = null;
      streamingBuffer.resetStreamingBuffers();
    };
  }, [streamingBuffer.resetStreamingBuffers]);

  useEffect(() => {
    return () => {
      sideConversationControllerRef.current?.abort('side-conversation-session-change');
      sideConversationControllerRef.current = null;
      appActions.dismissSideConversation();
    };
  }, [appActions, sessionId, workspaceRoot]);

  useEffect(() => {
    appActions.setTeams([]);
    void refreshTeams();
  }, [agentTeamsEnabled, appActions, refreshTeams, sessionId, workspaceRoot]);

  useEffect(() => {
    if (!thinkingModeEnabled) {
      sessionActions.setCurrentThinkingContent(null);
    }
  }, [thinkingModeEnabled, sessionActions]);

  // ==================== handleAbort ====================
  const handleAbort = useMemoizedFn(() => {
    if (sideConversationControllerRef.current) {
      sideConversationControllerRef.current.abort('user-cancel');
      sideConversationControllerRef.current = null;
      appActions.dismissSideConversation();
      return;
    }
    if (!isProcessing) return;

    // 0. dismiss 确认框（如果有）：先释放阻塞的 Promise，再 abort signal
    //    顺序重要：dismissAll 使审批请求的 await 返回，
    //    然后 abort signal 让 ToolExecutor 检测到 signal.aborted 直接 return
    onDismissConfirmations?.();

    const signal =
      commandActions.getAbortController()?.signal ?? new AbortController().signal;
    const streamSession = activeStreamSessionRef.current ?? createStreamSession(signal);
    streamSession.abortAndFinalize(() => {
      commandActions.abort('user-cancel');
      appActions.setTasks([]);
    });

    // 4. 显示停止消息（防重复）
    if (!abortMessageSentRef.current) {
      sessionActions.addAssistantMessage('任务已停止');
      abortMessageSentRef.current = true;
    }
  });

  const executeSideConversation = useMemoizedFn(
    async (resolved: ResolvedInput, question: string): Promise<void> => {
      const requestId = `side-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      appActions.startSideConversation(requestId, question);

      if (resolved.images.length > 0) {
        appActions.failSideConversation(
          requestId,
          'Side conversations do not accept image attachments'
        );
        return;
      }
      if (!question) {
        appActions.failSideConversation(requestId, 'Usage: /btw <question>');
        return;
      }

      sideConversationControllerRef.current?.abort('side-conversation-replaced');
      const controller = new AbortController();
      sideConversationControllerRef.current = controller;

      try {
        const result = await askSideQuestion(question, controller.signal);
        if (
          controller.signal.aborted ||
          sideConversationControllerRef.current !== controller
        ) {
          return;
        }
        appActions.completeSideConversation(requestId, result);
        if (result.usage) {
          sessionActions.updateTokenUsage({
            inputTokens: result.usage.promptTokens,
            outputTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
            cacheReadTokens: result.usage.cacheReadInputTokens ?? 0,
            cacheWriteTokens: result.usage.cacheCreationInputTokens ?? 0,
            costUsd: result.usage.costUsd,
          });
        }
      } catch (error) {
        if (
          controller.signal.aborted ||
          sideConversationControllerRef.current !== controller
        ) {
          return;
        }
        appActions.failSideConversation(
          requestId,
          error instanceof Error ? error.message : String(error)
        );
      } finally {
        if (sideConversationControllerRef.current === controller) {
          sideConversationControllerRef.current = null;
        }
      }
    }
  );

  const consumeAgentStream = useMemoizedFn(
    async (
      stream: AsyncGenerator<LoopEvent, LoopResult, void>,
      abortController: AbortController
    ) => {
      const stats = {
        contentDeltaCount: 0,
        contentDeltaTotalLen: 0,
        outputStarted: false,
        toolExecutionStarted: false,
        compactionCount: 0,
      };
      const streamSession = createStreamSession(abortController.signal);
      activeStreamSessionRef.current = streamSession;
      const eventHandler = createLoopEventHandler(
        {
          sessionActions,
          appActions,
          commandActions,
          streamingBuffer,
          thinkingModeEnabled,
          getStreamingMessageId: () => getState().session.currentStreamingMessageId,
          signal: abortController.signal,
          streamSession,
          followUpQueueOwner: queueOwner,
        },
        stats
      );
      try {
        const loopResult = await drainLoop(stream, eventHandler);
        return { loopResult, stats };
      } finally {
        if (activeStreamSessionRef.current === streamSession) {
          activeStreamSessionRef.current = null;
        }
      }
    }
  );

  // ==================== handleCommandSubmit ====================
  const handleCommandSubmit = useMemoizedFn(
    async (resolved: ResolvedInput): Promise<CommandResult> => {
      let userMessageAlreadyAdded = false;
      let onceModelId: string | undefined;
      let goalContinuationOnly = false;
      let agentInput = resolved;

      try {
        if (resolved.text.trimStart().startsWith('!')) {
          const abortController =
            commandActions.getAbortController() ??
            commandActions.createAbortController();
          return await handleUserShellCommand(resolved, abortController.signal);
        }

        // --- 1. Slash 命令路由 ---
        // ensureStoreInitialized 是唯一的初始化点，必须在 processSlashCommand 前调用
        await ensureStoreInitialized();

        // 复用 executeCommand 中已创建的 controller。
        // 不能再次调用 createAbortController()：它会中止并替换上层的 controller，
        // 导致 executeCommand 的 finally 中 isOurTask 检查失败，isProcessing 永远不被重置。
        const abortController =
          commandActions.getAbortController() ?? commandActions.createAbortController();
        // Snapshot prior model context before the optimistic UI message is added.
        // The loop appends agentInput exactly once at its durable input boundary.
        const contextMessages = buildContextMessagesFromSession(getState().session);

        const slashResult = await processSlashCommand(
          resolved,
          appActions,
          sessionActions,
          abortController.signal,
          cleanupAgent,
          sessionId,
          buildContextMessagesFromSession(getState().session),
          {
            listCheckpoints: listRewindCheckpoints,
            execute: rewindSession,
          },
          {
            list: listSubagents,
            resume: resumeSubagent,
          },
          {
            getCatalog: getMcpContentCatalog,
            refresh: refreshMcpContentCatalogs,
            getPrompt: getMcpPrompt,
            complete: completeMcpArgument,
            listTasks: listMcpTasks,
            getTask: getMcpTask,
            cancelTask: cancelMcpTask,
            getLogs: getMcpLogs,
            setLoggingLevel: setMcpLoggingLevel,
            getInstructions: getMcpInstructions,
          },
          {
            get: getReasoningConfiguration,
            set: setReasoningEffort,
          },
          {
            get: getServiceTierConfiguration,
            set: setServiceTier,
          },
          {
            get: getResponseVerbosityConfiguration,
            set: setResponseVerbosity,
          },
          {
            get: getCommunicationStyleConfiguration,
            set: setCommunicationStyle,
          },
          workspaceRoot,
          {
            run: runCodeReview,
          },
          sessionSurfaces
        );

        if (slashResult.type === 'handled') {
          return slashResult.commandResult;
        }

        if (slashResult.type === 'continue_as_agent') {
          userMessageAlreadyAdded = slashResult.result.userMessageAlreadyAdded;
          onceModelId = slashResult.result.onceModelId;
          goalContinuationOnly = slashResult.result.goalContinuationOnly === true;
          agentInput = slashResult.result.agentInput;
        }

        // --- 2. UserPromptSubmit Hook ---
        const hookManager = HookManager.getInstance();
        let hookContextInjection: string | undefined;

        if (!goalContinuationOnly) {
          const hookResult = await hookManager.executeUserPromptSubmitHooks(
            agentInput.text,
            {
              projectDir: workspaceRoot,
              sessionId: sessionId,
              permissionMode: permissionMode,
              hasImages: agentInput.images.length > 0,
              imageCount: agentInput.images.length,
            }
          );

          if (!hookResult.proceed) {
            if (hookResult.warning) {
              sessionActions.addAssistantMessage(`${hookResult.warning}`);
            }
            return { success: false, error: 'blocked by hook' };
          }

          // hook 只改写 agentInput，不回写已提交的 UI 消息
          if (hookResult.updatedPrompt) {
            agentInput = {
              ...agentInput,
              text: hookResult.updatedPrompt,
              displayText: hookResult.updatedPrompt,
              parts: [
                { type: 'text', text: hookResult.updatedPrompt },
                ...agentInput.parts.filter((part) => part.type === 'image'),
              ],
            };
          }

          if (hookResult.contextInjection) {
            hookContextInjection = hookResult.contextInjection;
          }
        }

        // --- 3. 添加用户消息（如果 slash 路由阶段未添加） ---
        if (!userMessageAlreadyAdded) {
          sessionActions.addUserMessage(agentInput.displayText);
        }

        // --- 4. 构建 Agent + ChatContext ---
        const userMessageContent = buildUserMessageContent(agentInput);

        const agent = await createAgent(
          onceModelId ? { modelId: onceModelId } : undefined
        );

        if (abortController.signal.aborted) {
          logger.info('[handleCommandSubmit] Agent 创建期间已被中止');
          return { success: false, error: 'aborted' };
        }

        if (hookContextInjection) {
          contextMessages.push({
            role: 'system',
            content: `<user-prompt-submit-hook>\n${hookContextInjection}\n</user-prompt-submit-hook>`,
          });
        }

        const chatContext = {
          messages: contextMessages,
          userId: 'cli-user',
          sessionId: sessionId,
          workspaceRoot,
          signal: abortController.signal,
          confirmationHandler,
          permissionMode: permissionMode,
          onPermissionModeChange: async (nextMode: PermissionMode) => {
            await configActions().setPermissionMode(nextMode);
          },
        };

        // --- 5. 消费 Agent 事件流 ---
        const { loopResult, stats } = await consumeAgentStream(
          agent.chatStream(userMessageContent, chatContext, {
            stream: true,
            goalContinuationOnly,
            onTurnLimitReached: confirmationHandler
              ? async (data: { turnsCount: number }) => {
                  const response = await confirmationHandler.requestConfirmation({
                    type: 'maxTurnsExceeded',
                    message: `已进行 ${data.turnsCount} 轮对话。是否继续？`,
                    risks: [
                      '继续执行可能导致更长的等待时间',
                      '可能产生更多的 API 费用',
                    ],
                  });
                  return {
                    continue: response.approved,
                    reason: response.reason,
                  };
                }
              : undefined,
          }),
          abortController
        );
        if (stats.compactionCount > 0) {
          sessionActions.setCompactedContext(chatContext.messages);
        }

        // --- 6. 后处理 ---
        if (loopResult.success && loopResult.metadata?.outputTruncated) {
          sessionActions.addAssistantMessage(
            '输出因达到 token 上限被截断，部分内容可能不完整。'
          );
        }

        const output = loopResult.finalMessage || '';
        logger.debug('[handleCommandSubmit] final reply', {
          success: loopResult.success,
          outputLength: output.length,
          turnsCount: loopResult.metadata?.turnsCount,
          toolCallsCount: loopResult.metadata?.toolCallsCount,
        });

        // 非 abort 的失败必须保留 typed loop failure，不能误报为"已取消"。
        if (!loopResult.success && !isLoopCancellation(loopResult)) {
          const errorMsg = loopResult.error?.message || '任务执行失败';
          sessionActions.addAssistantMessage(errorMsg);
          return { success: false, error: errorMsg };
        }

        if (!output || output.trim() === '') {
          // interrupt 时不显示"已取消"（紧接着就有新任务开始）
          const abortReason = loopResult.metadata?.abortReason;
          if (
            !abortMessageSentRef.current &&
            stats.contentDeltaCount === 0 &&
            abortReason !== 'interrupt'
          ) {
            sessionActions.addAssistantMessage('已取消');
            return { success: true, output: '已取消' };
          }
          return { success: true, output: output ?? '' };
        }

        return { success: true, output };
      } catch (error) {
        if (abortMessageSentRef.current) {
          return { success: false, error: 'aborted' };
        }

        const classified = classifyError(error);
        const lifecycleAbort =
          typeof error === 'object' &&
          error !== null &&
          'name' in error &&
          error.name === 'AbortError';
        if (classified.isAbort || lifecycleAbort) {
          return { success: false, error: 'aborted' };
        }
        sessionActions.addAssistantMessage(`${classified.displayMessage}`);
        return { success: false, error: classified.displayMessage };
      }
    }
  );

  const performPendingResume = useMemoizedFn(
    async (lifecycleSignal: AbortSignal): Promise<PendingResumeRunResult> => {
      if (lifecycleSignal.aborted) return { status: 'completed' };
      if (getState().command.isProcessing) {
        return { status: 'deferred' };
      }
      const hasPending = await SessionRuntime.hasPendingInbox(workspaceRoot, sessionId);
      const hasActiveGoal =
        !hasPending && (await SessionRuntime.hasActiveGoal(workspaceRoot, sessionId));
      const hasRecoverableTurn =
        !hasPending &&
        !hasActiveGoal &&
        (await SessionRuntime.hasRecoverableTurn(workspaceRoot, sessionId));
      if (lifecycleSignal.aborted) return { status: 'completed' };
      if (!hasPending && !hasActiveGoal && !hasRecoverableTurn) {
        return { status: 'completed' };
      }
      if (getState().command.isProcessing) {
        return { status: 'deferred' };
      }

      await ensureStoreInitialized();
      if (lifecycleSignal.aborted) return { status: 'completed' };
      if (getState().command.isProcessing) {
        return { status: 'deferred' };
      }
      const abortController = commandActions.createAbortController();
      let workKind: PendingResumeWorkKind = 'preflight';
      const abortForLifecycle = () => {
        if (!abortController.signal.aborted) {
          abortController.abort('pending-resume-coordinator-disposed');
        }
      };
      lifecycleSignal.addEventListener('abort', abortForLifecycle, { once: true });
      if (lifecycleSignal.aborted) abortForLifecycle();
      streamingBuffer.resetStreamingBuffers();
      sessionActions.clearFinalizingStreamingMessageId();
      commandActions.setProcessing(true);

      try {
        const agent = await createAgent();
        if (abortController.signal.aborted) {
          return abortController.signal.reason === 'interrupted-by-new-command'
            ? { status: 'deferred' }
            : { status: 'completed' };
        }
        const pendingAfterInitialization = await SessionRuntime.hasPendingInbox(
          workspaceRoot,
          sessionId
        );
        const goalAfterInitialization =
          !pendingAfterInitialization &&
          (await SessionRuntime.hasActiveGoal(workspaceRoot, sessionId));
        if (abortController.signal.aborted) {
          return abortController.signal.reason === 'interrupted-by-new-command'
            ? { status: 'deferred' }
            : { status: 'completed' };
        }
        if (!pendingAfterInitialization && !goalAfterInitialization) {
          const recoveryAssessment = getTurnRecoveryAssessment();
          if (recoveryAssessment.state !== 'none') {
            projectTurnRecoveryAssessment(sessionActions, recoveryAssessment);
          }
          return { status: 'completed' };
        }
        workKind = pendingAfterInitialization ? 'pending_input' : 'goal';

        const chatContext = {
          messages: buildContextMessagesFromSession(getState().session),
          userId: 'cli-user',
          sessionId,
          workspaceRoot,
          signal: abortController.signal,
          confirmationHandler,
          permissionMode,
          onPermissionModeChange: async (nextMode: PermissionMode) => {
            await configActions().setPermissionMode(nextMode);
          },
        };
        const { loopResult, stats } = await consumeAgentStream(
          agent.chatStream('', chatContext, {
            stream: true,
            pendingInputOnly: pendingAfterInitialization,
            goalContinuationOnly: goalAfterInitialization,
          }),
          abortController
        );
        if (stats.compactionCount > 0) {
          sessionActions.setCompactedContext(chatContext.messages);
        }
        if (abortController.signal.aborted) {
          return abortController.signal.reason === 'interrupted-by-new-command'
            ? { status: 'deferred' }
            : { status: 'completed' };
        }

        if (loopResult.success && loopResult.metadata?.outputTruncated) {
          sessionActions.addAssistantMessage(
            '输出因达到 token 上限被截断，部分内容可能不完整。'
          );
        }
        if (!loopResult.success && !isLoopCancellation(loopResult)) {
          const taskFailure = toTaskFailure(
            loopResult.error?.details ?? loopResult.error?.message ?? '恢复排队指令失败'
          );
          if (workKind === 'pending_input') {
            const reportedToolCallsCount = loopResult.metadata?.toolCallsCount;
            const toolCallsCount =
              typeof reportedToolCallsCount === 'number' &&
              Number.isInteger(reportedToolCallsCount) &&
              reportedToolCallsCount >= 0
                ? reportedToolCallsCount
                : -1;
            const workStillPending = await SessionRuntime.hasPendingInbox(
              workspaceRoot,
              sessionId
            );
            if (abortController.signal.aborted) {
              return abortController.signal.reason === 'interrupted-by-new-command'
                ? { status: 'deferred' }
                : { status: 'completed' };
            }
            return {
              status: 'failed',
              workKind,
              workStillPending,
              taskFailure,
              evidence: {
                taskFailure,
                outputStarted: stats.outputStarted,
                toolExecutionStarted: stats.toolExecutionStarted,
                toolCallsCount,
              },
            };
          }
          return {
            status: 'failed',
            workKind,
            workStillPending: false,
            taskFailure,
          };
        }
        return { status: 'completed' };
      } catch (error) {
        const classified = classifyError(error);
        if (abortController.signal.reason === 'interrupted-by-new-command') {
          return { status: 'deferred' };
        }
        if (classified.isAbort || lifecycleSignal.aborted) {
          return { status: 'completed' };
        }
        return {
          status: 'failed',
          workKind,
          workStillPending: false,
          taskFailure: toTaskFailure(error),
        };
      } finally {
        lifecycleSignal.removeEventListener('abort', abortForLifecycle);
        const isOurTask = commandActions.getAbortController() === abortController;
        if (isOurTask) {
          commandActions.setProcessing(false);
          commandActions.clearAbortController(abortController);
          sessionActions.setCurrentThinkingContent(null);
        }
      }
    }
  );

  const pendingResumeCoordinator = useMemo(() => {
    let terminalWorkKind: PendingResumeWorkKind = 'preflight';
    return new PendingResumeCoordinator({
      canRun: () => !getState().command.isProcessing,
      run: async (signal) => {
        terminalWorkKind = 'preflight';
        const result = await performPendingResume(signal);
        if (result.status === 'failed') {
          terminalWorkKind = result.workKind;
        }
        return result;
      },
      sessionIdentity: JSON.stringify([workspaceRoot, sessionId]),
      onTerminalFailure: ({ taskFailure }) => {
        if (terminalWorkKind === 'preflight') {
          sessionActions.setError(`恢复排队指令失败: ${taskFailure.message}`);
        } else {
          sessionActions.addAssistantMessage(taskFailure.message);
        }
      },
    });
  }, [performPendingResume, sessionActions, sessionId, workspaceRoot]);

  useEffect(() => {
    pendingResumeCoordinatorRef.current = pendingResumeCoordinator;
    return () => {
      pendingResumeCoordinator.dispose();
      if (pendingResumeCoordinatorRef.current === pendingResumeCoordinator) {
        pendingResumeCoordinatorRef.current = null;
      }
    };
  }, [pendingResumeCoordinator]);

  useEffect(() => {
    appActions.claimFollowUpQueueOwner(queueOwner);
    return () => {
      appActions.clearFollowUpQueue(queueOwner);
    };
  }, [appActions, queueOwner]);

  // ==================== executeCommand ====================
  const executeCommand = useMemoizedFn(async (resolved: ResolvedInput) => {
    if (getState().app.activeModal === 'sessionHistoryViewer') {
      return;
    }
    if (!resolved.text.trim() && resolved.images.length === 0) {
      return;
    }

    const sideCommand = parseSideConversationCommand(resolved.text);
    if (sideCommand) {
      await executeSideConversation(resolved, sideCommand.question);
      return;
    }

    sideConversationControllerRef.current?.abort('main-conversation-submitted');
    sideConversationControllerRef.current = null;
    appActions.dismissSideConversation();

    if (resolved.text.trimStart().startsWith('!') && isProcessing) {
      const abortController = commandActions.getAbortController();
      if (!abortController) {
        sessionActions.addAssistantMessage(
          '当前任务没有可用的取消边界，无法执行用户 Shell 命令。'
        );
        return;
      }
      const result = await handleUserShellCommand(resolved, abortController.signal);
      if (!result.success && result.error && result.error !== 'aborted') {
        sessionActions.setError(result.error);
      }
      return;
    }

    // 运行中提交新消息时，将其注入当前 Agent 回合的下一个安全边界。
    // Esc/Ctrl+C 仍由 handleAbort 提供真正的中止语义。
    if (isProcessing) {
      if (resolved.text.trimStart().startsWith('/')) {
        const slash = resolved.text.trim();
        if (/^\/(?:goal|queue)(?:\s|$)/i.test(slash)) {
          await ensureStoreInitialized();
          const existingController = commandActions.getAbortController();
          const signal = /^\/queue(?:\s|$)/i.test(slash)
            ? (existingController?.signal ?? new AbortController().signal)
            : (existingController ?? commandActions.createAbortController()).signal;
          await processSlashCommand(
            resolved,
            appActions,
            sessionActions,
            signal,
            cleanupAgent,
            sessionId,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            workspaceRoot
          );
          return;
        }
        sessionActions.addAssistantMessage(
          '活动回合中不能执行 slash command；请先停止任务或等待完成。'
        );
        return;
      }

      await ensureStoreInitialized();
      const hookResult = await HookManager.getInstance().executeUserPromptSubmitHooks(
        resolved.text,
        {
          projectDir: workspaceRoot,
          sessionId,
          permissionMode,
          hasImages: resolved.images.length > 0,
          imageCount: resolved.images.length,
        }
      );
      if (!hookResult.proceed) {
        if (hookResult.warning) {
          sessionActions.addAssistantMessage(hookResult.warning);
        }
        return;
      }

      let steeringInput = resolved;
      if (hookResult.updatedPrompt) {
        steeringInput = {
          ...resolved,
          text: hookResult.updatedPrompt,
          parts: [
            { type: 'text', text: hookResult.updatedPrompt },
            ...resolved.parts.filter((part) => part.type === 'image'),
          ],
        };
      }
      if (hookResult.contextInjection) {
        const injection = `<user-prompt-submit-hook>\n${hookResult.contextInjection}\n</user-prompt-submit-hook>`;
        steeringInput = {
          ...steeringInput,
          text: `${steeringInput.text}\n\n${injection}`,
          parts: [...steeringInput.parts, { type: 'text', text: `\n\n${injection}` }],
        };
      }

      const steeringContent = buildUserMessageContent(steeringInput);
      const steering = await steerActiveTurn(steeringContent);
      if (!steering.accepted) {
        const message =
          steering.reason === 'queue_full'
            ? '补充指令队列已满，请等待当前任务处理后重试。'
            : '当前任务正在结束，补充指令未入队，请稍后重试。';
        sessionActions.addAssistantMessage(message);
        return;
      }

      if (steering.messageId) {
        commandActions.rememberFollowUpPresentation(steering.messageId, resolved);
      }
      if (steering.queue) {
        appActions.projectFollowUpQueue(steering.queue, queueOwner);
      }
      if (steering.delivery === 'next_turn') {
        pendingResumeCoordinator.request();
      }
      return;
    }

    // 清空上一轮对话的 tasks
    appActions.setTasks([]);
    commandActions.setRecoveredSteeringCount(0);

    // 重置中止提示标记
    abortMessageSentRef.current = false;

    // 仅在 idle 分支创建 controller，并保存引用用于 finally 的所有权判断。
    // createAbortController() 会主动中止并替换已有 controller。
    const taskAbortController = commandActions.createAbortController();

    // 重置流式批处理缓冲区
    streamingBuffer.resetStreamingBuffers();

    // 清理上一次的最终渲染标记
    sessionActions.clearFinalizingStreamingMessageId();

    // 设置处理状态
    commandActions.setProcessing(true);

    try {
      const result = await handleCommandSubmit(resolved);

      if (!result.success && result.error && result.error !== 'aborted') {
        sessionActions.setError(result.error);
      }
    } catch (error) {
      const classified = classifyError(error);
      if (classified.isAbort) {
        // AbortError 静默处理
      } else {
        sessionActions.setError(`执行失败: ${classified.displayMessage}`);
      }
    } finally {
      // NOTE: 关键：只有当我们的 controller 仍然是当前的才重置状态
      // 防止竞态条件：用户取消后立即发送新消息时，旧任务的 finally 不影响新任务
      const currentController = commandActions.getAbortController();
      const isOurTask = currentController === taskAbortController;

      if (isOurTask) {
        commandActions.setProcessing(false);
        commandActions.clearAbortController(taskAbortController);
        sessionActions.setCurrentThinkingContent(null);
        pendingResumeCoordinatorRef.current?.notifyIdle();
      }
    }
  });

  useEffect(() => {
    const unsubscribe = Bus.subscribe((event) => {
      if (!sameSessionRef(event, { sessionId, projectPath: workspaceRoot })) return;
      if (event.type.startsWith('team.')) {
        const { teamName, messageId, content } = event.properties;
        const metadata = event.properties.metadata;
        if (
          event.type === 'team.message.received' &&
          typeof teamName === 'string' &&
          typeof messageId === 'string' &&
          typeof content === 'string' &&
          isTeamMessageMetadata(metadata, { messageId, teamName })
        ) {
          void (async () => {
            const steering = await enqueueSessionInput(content, {
              messageId,
              origin: 'team_message',
              metadata,
            });
            if (!steering.accepted) return;
            await new TeamMailbox(teamName, getBladeStorageRoot()).markDelivered([
              messageId,
            ]);
            if (steering.delivery === 'next_turn') {
              pendingResumeCoordinator.request();
            }
          })().catch((error) => {
            logger.warn(
              '[useCommandHandler] Failed to deliver teammate message',
              error
            );
          });
        }
        queueMicrotask(() => {
          void refreshTeams();
        });
        return;
      }
      if (event.type !== 'subagent.completion.queued') return;
      pendingResumeCoordinator.request();
    });
    return () => {
      unsubscribe();
    };
  }, [
    enqueueSessionInput,
    pendingResumeCoordinator,
    refreshTeams,
    sessionId,
    workspaceRoot,
  ]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (confirmationHandler) {
        await SessionInteractionService.resolvePendingWithHandler(
          workspaceRoot,
          sessionId,
          confirmationHandler
        );
      } else {
        await SessionInteractionService.cancelPendingNonInteractive(
          workspaceRoot,
          sessionId
        );
      }
      if (cancelled) return;
      const [hasPending, hasActiveGoal] = await Promise.all([
        SessionRuntime.hasPendingInbox(workspaceRoot, sessionId),
        SessionRuntime.hasActiveGoal(workspaceRoot, sessionId),
      ]);
      const hasRecoverableTurn =
        !hasPending &&
        !hasActiveGoal &&
        (await SessionRuntime.hasRecoverableTurn(workspaceRoot, sessionId));
      if (hasPending || hasActiveGoal || hasRecoverableTurn) {
        pendingResumeCoordinator.request();
      }
    })().catch((error) => {
      if (!cancelled) {
        logger.warn(
          '[useCommandHandler] Failed to recover pending interaction or inbox',
          error
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [confirmationHandler, pendingResumeCoordinator, sessionId, workspaceRoot]);

  return {
    executeCommand,
    handleAbort,
    isProcessing: isProcessing || sideConversation?.status === 'loading',
    cleanupAgent,
    refreshFollowUpQueue,
    controlFollowUpQueue,
  };
};

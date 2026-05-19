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
 * ## Finalize 协议
 *
 * handleAbort 和 loopEventHandler(stream_end) 共享"谁负责最终 finalize"的协议：
 * - abort 路径负责 finalize：handleAbort 先 drainPendingBuffers 保留内容，
 *   再 abort signal，再用 drain 结果调用 finalizeStreamingMessage。
 * - 晚到的 stream_end 只做清理不做提交（检查 streamFinalized || signal.aborted）。
 */

import { useMemoizedFn } from 'ahooks';
import { useEffect, useRef } from 'react';
import { drainLoop } from '../../agent/loop/index.js';
import { HookManager } from '../../hooks/HookManager.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import {
  useAppActions,
  useCommandActions,
  useIsProcessing,
  usePermissionMode,
  useSessionActions,
  useSessionId,
  useThinkingModeEnabled,
} from '../../store/selectors/index.js';
import { ensureStoreInitialized, getState } from '../../store/vanilla.js';
import type { ConfirmationHandler } from '../../tools/types/ExecutionTypes.js';
import { getCwd } from '../../utils/cwd.js';
import {
  appendMarkdownDelta,
  finalizeMarkdownCache,
} from '../utils/markdownIncremental.js';
import { classifyError } from '../utils/errorExtractor.js';
import { buildUserMessageContent } from '../utils/messageContent.js';
import { buildContextMessagesFromSession } from '../utils/sessionContext.js';
import { processSlashCommand, type CommandResult } from '../utils/slashCommandRouter.js';
import { createLoopEventHandler } from '../utils/loopEventHandler.js';
import { useAgent } from './useAgent.js';
import type { ResolvedInput } from './useInputBuffer.js';
import { useStreamingBuffer } from './useStreamingBuffer.js';

const logger = createLogger(LogCategory.UI);

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
) => {
  // ==================== Store 选择器 ====================
  const isProcessing = useIsProcessing();
  const sessionId = useSessionId();
  const permissionMode = usePermissionMode();
  const thinkingModeEnabled = useThinkingModeEnabled();

  // ==================== Store Actions ====================
  const sessionActions = useSessionActions();
  const appActions = useAppActions();
  const commandActions = useCommandActions();

  // ==================== Local Refs ====================
  const abortMessageSentRef = useRef(false);

  // ==================== 子模块组合 ====================
  const { createAgent, cleanupAgent } = useAgent({
    sessionId,
    systemPrompt: replaceSystemPrompt,
    appendSystemPrompt: appendSystemPrompt,
    maxTurns: maxTurns,
  });

  const streamingBuffer = useStreamingBuffer(sessionActions);

  // ==================== 生命周期 ====================
  useEffect(() => {
    return () => {
      cleanupAgent();
      streamingBuffer.resetStreamingBuffers();
    };
  }, [cleanupAgent, streamingBuffer.resetStreamingBuffers]);

  useEffect(() => {
    if (!thinkingModeEnabled) {
      sessionActions.setCurrentThinkingContent(null);
    }
  }, [thinkingModeEnabled, sessionActions]);

  // ==================== handleAbort ====================
  const handleAbort = useMemoizedFn(() => {
    if (!isProcessing) return;

    // 0. dismiss 确认框（如果有）：先释放阻塞的 Promise，再 abort signal
    //    顺序重要：dismissAll 使 ConfirmationStage 的 await 返回，
    //    然后 abort signal 让 ConfirmationStage 检测到 signal.aborted 直接 return
    onDismissConfirmations?.();

    // 1. drain 缓冲区，保留已接收内容
    const { extraContent, extraThinking } = streamingBuffer.drainPendingBuffers();

    // 2. 先触发 abort signal（reason='user-cancel'），阻止后续回调
    //    此后 loopEventHandler 中的 stream_end 检查 signal.aborted 会跳过 finalize
    commandActions.abort('user-cancel');
    appActions.setTasks([]);

    // 3. 用 drain 结果 finalize，确保已收内容提交到 store
    const streamingId = getState().session.currentStreamingMessageId;
    if (streamingId) {
      if (extraContent) appendMarkdownDelta(streamingId, extraContent);
      finalizeMarkdownCache(streamingId);
    }
    sessionActions.finalizeStreamingMessage(extraContent, extraThinking);

    // 4. 显示停止消息（防重复）
    if (!abortMessageSentRef.current) {
      sessionActions.addAssistantMessage('任务已停止');
      abortMessageSentRef.current = true;
    }
  });

  // ==================== handleCommandSubmit ====================
  const handleCommandSubmit = useMemoizedFn(
    async (resolved: ResolvedInput): Promise<CommandResult> => {
      let userMessageAlreadyAdded = false;
      let onceModelId: string | undefined;
      let agentInput = resolved;

      try {
        // --- 1. Slash 命令路由 ---
        // ensureStoreInitialized 是唯一的初始化点，必须在 processSlashCommand 前调用
        await ensureStoreInitialized();

        // 复用 executeCommand 中已创建的 controller。
        // 不能再次调用 createAbortController()：它会中止并替换上层的 controller，
        // 导致 executeCommand 的 finally 中 isOurTask 检查失败，isProcessing 永远不被重置。
        const abortController =
          commandActions.getAbortController() ?? commandActions.createAbortController();

        const slashResult = await processSlashCommand(
          resolved,
          appActions,
          sessionActions,
          abortController.signal,
        );

        if (slashResult.type === 'handled') {
          return slashResult.commandResult;
        }

        if (slashResult.type === 'continue_as_agent') {
          userMessageAlreadyAdded = slashResult.result.userMessageAlreadyAdded;
          onceModelId = slashResult.result.onceModelId;
          agentInput = slashResult.result.agentInput;
        }

        // --- 2. UserPromptSubmit Hook ---
        const hookManager = HookManager.getInstance();
        let hookContextInjection: string | undefined;

        const hookResult = await hookManager.executeUserPromptSubmitHooks(
          agentInput.text,
          {
            projectDir: getCwd(),
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
            parts: [{ type: 'text', text: hookResult.updatedPrompt }],
          };
        }

        if (hookResult.contextInjection) {
          hookContextInjection = hookResult.contextInjection;
        }

        // --- 2b. Spec 进度自动注入（Session Bootstrap） ---
        try {
          const { SpecManager } = await import('../../spec/SpecManager.js');
          const specProgress = SpecManager.getInstance().buildProgressContext();
          if (specProgress) {
            hookContextInjection = hookContextInjection
              ? `${hookContextInjection}\n\n${specProgress}`
              : specProgress;
          }
        } catch {
          // SpecManager 未初始化时静默跳过
        }

        // --- 3. 添加用户消息（如果 slash 路由阶段未添加） ---
        if (!userMessageAlreadyAdded) {
          sessionActions.addUserMessage(agentInput.displayText);
        }

        // --- 4. 构建 Agent + ChatContext ---
        const userMessageContent = buildUserMessageContent(agentInput);

        const agent = await createAgent(onceModelId ? { modelId: onceModelId } : undefined);

        if (abortController.signal.aborted) {
          logger.info('[handleCommandSubmit] Agent 创建期间已被中止');
          return { success: false, error: 'aborted' };
        }

        const contextMessages = buildContextMessagesFromSession(getState().session);

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
          workspaceRoot: getCwd(),
          signal: abortController.signal,
          confirmationHandler,
          permissionMode: permissionMode,
        };

        // --- 5. 创建事件处理器并消费流 ---
        const stats = { contentDeltaCount: 0, contentDeltaTotalLen: 0 };
        const eventHandler = createLoopEventHandler(
          {
            sessionActions,
            appActions,
            streamingBuffer,
            thinkingModeEnabled,
            getStreamingMessageId: () => getState().session.currentStreamingMessageId,
            signal: abortController.signal,
          },
          stats,
        );

        const loopResult = await drainLoop(
          agent.chatStream(userMessageContent, chatContext, {
            stream: true,
            onTurnLimitReached: confirmationHandler
              ? async (data: { turnsCount: number }) => {
                  const response = await confirmationHandler.requestConfirmation({
                    type: 'maxTurnsExceeded',
                    message: `已进行 ${data.turnsCount} 轮对话。是否继续？`,
                    risks: ['继续执行可能导致更长的等待时间', '可能产生更多的 API 费用'],
                  });
                  return {
                    continue: response.approved,
                    reason: response.reason,
                  };
                }
              : undefined,
          }),
          eventHandler,
        );

        // --- 6. 后处理 ---
        if (loopResult.metadata?.outputTruncated) {
          sessionActions.addAssistantMessage(
            '输出因达到 token 上限被截断，部分内容可能不完整。',
          );
        }

        const output = loopResult.finalMessage || '';
        logger.debug('[handleCommandSubmit] final reply', {
          success: loopResult.success,
          outputLength: output.length,
          turnsCount: loopResult.metadata?.turnsCount,
          toolCallsCount: loopResult.metadata?.toolCallsCount,
        });

        // API 错误（非 abort）时显示友好错误信息，而非"已取消"
        if (!loopResult.success && loopResult.error?.type === 'api_error') {
          const errorMsg = loopResult.error.message || '请求失败，请检查网络连接和 API 配置';
          sessionActions.addAssistantMessage(errorMsg);
          return { success: false, error: errorMsg };
        }

        if (!output || output.trim() === '') {
          // interrupt 时不显示"已取消"（紧接着就有新任务开始）
          const abortReason = loopResult.metadata?.abortReason;
          if (!abortMessageSentRef.current && stats.contentDeltaCount === 0 && abortReason !== 'interrupt') {
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
        sessionActions.addAssistantMessage(`${classified.displayMessage}`);
        return { success: false, error: classified.displayMessage };
      }
    }
  );

  // ==================== executeCommand ====================
  const executeCommand = useMemoizedFn(async (resolved: ResolvedInput) => {
    if (!resolved.text.trim() && resolved.images.length === 0) {
      return;
    }

    // 中断模型：运行中提交新消息 = abort 当前任务 + 立即执行新消息
    if (isProcessing) {
      // 1. dismiss 确认框（如果有）
      onDismissConfirmations?.();
      // 2. drain 缓冲区，保留旧任务已接收内容（必须在 abort 之前）
      const { extraContent, extraThinking } = streamingBuffer.drainPendingBuffers();
      // 3. abort 当前任务，传 reason='interrupt'
      commandActions.abort('interrupt');
      // 4. 用 drain 结果 finalize 旧任务的流式消息
      const streamingId = getState().session.currentStreamingMessageId;
      if (streamingId) {
        if (extraContent) appendMarkdownDelta(streamingId, extraContent);
        finalizeMarkdownCache(streamingId);
      }
      sessionActions.finalizeStreamingMessage(extraContent, extraThinking);
      // 5. 不 return，继续往下走正常的 executeCommand 流程
      //    旧任务的 finally 中 isOurTask 检查会阻止它干扰新任务
    }

    // 清空上一轮对话的 tasks
    appActions.setTasks([]);

    // 重置中止提示标记
    abortMessageSentRef.current = false;

    // NOTE: 先创建 AbortController，保存引用用于 finally 中的清理判断
    // 依赖 createAbortController() 的"复用未中止 controller"语义（commandSlice.ts:53-64）
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
      }
    }
  });

  return {
    executeCommand,
    handleAbort,
    isProcessing,
  };
};

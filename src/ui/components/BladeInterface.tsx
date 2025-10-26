import { useMemoizedFn } from 'ahooks';
import { Box, useApp, useStdout } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import { ConfigManager } from '../../config/ConfigManager.js';
import { PermissionMode } from '../../config/types.js';
import { type SessionMetadata, SessionService } from '../../services/SessionService.js';
import type { ConfirmationResponse } from '../../tools/types/ExecutionTypes.js';
import type { AppProps } from '../App.js';
import { useAppState, useTodos } from '../contexts/AppContext.js';
import { FocusId, useFocusContext } from '../contexts/FocusContext.js';
import { useSession } from '../contexts/SessionContext.js';
import { useAppInitializer } from '../hooks/useAppInitializer.js';
import { useCommandHandler } from '../hooks/useCommandHandler.js';
import { useCommandHistory } from '../hooks/useCommandHistory.js';
import { useConfirmation } from '../hooks/useConfirmation.js';
import { useMainInput } from '../hooks/useMainInput.js';
import { ChatStatusBar } from './ChatStatusBar.js';
import { CommandSuggestions } from './CommandSuggestions.js';
import { ConfirmationPrompt } from './ConfirmationPrompt.js';
import { Header } from './Header.js';
import { InputArea } from './InputArea.js';
import { MessageArea } from './MessageArea.js';
import { PerformanceMonitor } from './PerformanceMonitor.js';
import { PermissionsManager } from './PermissionsManager.js';
import { SessionSelector } from './SessionSelector.js';
import { SetupWizard } from './SetupWizard.js';
import { ThemeSelector } from './ThemeSelector.js';

/**
 * BladeInterface 组件的 props 类型
 * 直接继承 AppProps，保持所有字段类型不变（包括 debug 的过滤器功能）
 */
export interface BladeInterfaceProps extends AppProps {}

/**
 * Blade Code 主界面组件
 * 负责应用初始化、主界面渲染和所有业务逻辑的协调
 */
export const BladeInterface: React.FC<BladeInterfaceProps> = ({
  debug,
  ...otherProps
}) => {
  // TODO: 实现 debug 过滤功能
  // 支持 --debug api,hooks 或 --debug "!statsig,!file" 等过滤模式
  // debug 字段类型为 string | undefined，可以包含逗号分隔的类别列表
  // 正向过滤：只显示指定类别（如 "api,hooks"）
  // 负向过滤：排除指定类别（如 "!statsig,!file"）

  // 调试输出：显示接收到的 props
  if (debug) {
    console.log('[Debug] BladeInterface props:', {
      permissionMode: otherProps.permissionMode,
      yolo: otherProps.yolo,
    });
  }

  const { state: appState, dispatch: appDispatch, actions: appActions } = useAppState();

  const {
    state: sessionState,
    addUserMessage,
    addAssistantMessage,
    restoreSession,
  } = useSession();
  const { todos, showTodoPanel } = useTodos();

  const {
    status: initializationStatus,
    readyForChat,
    requiresSetup,
    errorMessage: initializationError,
    handleSetupComplete,
  } = useAppInitializer({ debug: Boolean(debug) });

  const { stdout } = useStdout();
  const [terminalWidth, setTerminalWidth] = useState(80);
  const { exit } = useApp();

  // 处理 --resume CLI 参数
  const hasProcessedResumeRef = useRef(false);
  useEffect(() => {
    if (hasProcessedResumeRef.current) return;
    if (!otherProps.resume) return;

    hasProcessedResumeRef.current = true;

    const handleResume = async () => {
      try {
        // 情况 1: 直接提供了 sessionId (--resume <sessionId>)
        if (typeof otherProps.resume === 'string' && otherProps.resume !== 'true') {
          const messages = await SessionService.loadSession(otherProps.resume);

          const sessionMessages = messages
            // 不再过滤 tool 消息，让工具输出也能被渲染
            .map((msg, index) => ({
              id: `restored-${Date.now()}-${index}`,
              role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
              content:
                typeof msg.content === 'string'
                  ? msg.content
                  : JSON.stringify(msg.content),
              timestamp: Date.now() - (messages.length - index) * 1000,
            }));

          restoreSession(otherProps.resume, sessionMessages);
          return;
        }

        // 情况 2: 交互式选择 (--resume 无参数)
        const sessions = await SessionService.listSessions();

        if (sessions.length === 0) {
          console.error('没有找到历史会话');
          process.exit(1);
        }

        // 显示会话选择器
        appDispatch(appActions.showSessionSelector(sessions));
      } catch (error) {
        console.error('[BladeInterface] 加载会话失败:', error);
        process.exit(1);
      }
    };

    handleResume();
  }, [otherProps.resume, restoreSession, appDispatch, appActions]);

  // 获取终端宽度
  useEffect(() => {
    const updateTerminalWidth = () => {
      setTerminalWidth(stdout.columns || 80);
    };

    updateTerminalWidth();
    stdout.on('resize', updateTerminalWidth);

    return () => {
      stdout.off('resize', updateTerminalWidth);
    };
  }, [stdout, exit]);

  // 确认管理
  const {
    confirmationState,
    confirmationHandler,
    handleResponse: handleResponseRaw,
  } = useConfirmation();

  // 调试日志：追踪 confirmationHandler 接收
  console.log('[BladeInterface] Received confirmationHandler from useConfirmation:', {
    hasHandler: !!confirmationHandler,
    hasMethod: !!confirmationHandler?.requestConfirmation,
    methodType: typeof confirmationHandler?.requestConfirmation,
  });

  const handleResponse = useMemoizedFn(async (response: ConfirmationResponse) => {
    if (confirmationState.details?.type === 'exitPlanMode' && response.approved) {
      // 批准方案后，根据用户选择切换权限模式
      const targetMode =
        response.targetMode === 'auto_edit'
          ? PermissionMode.AUTO_EDIT
          : PermissionMode.DEFAULT;

      const configManager = ConfigManager.getInstance();
      try {
        await configManager.setPermissionMode(targetMode);
        appDispatch(appActions.setPermissionMode(targetMode));

        // 打印模式切换信息（调试用）
        const modeName =
          targetMode === PermissionMode.AUTO_EDIT ? 'Auto-Edit' : 'Default';
        console.log(`[BladeInterface] Plan 模式已退出，切换到 ${modeName} 模式`);
      } catch (error) {
        console.error('[BladeInterface] 退出 Plan 模式失败:', error);
      }
    }
    handleResponseRaw(response);
  });

  // 使用 hooks
  const { isProcessing, executeCommand, loopState, handleAbort } = useCommandHandler(
    otherProps.systemPrompt,
    otherProps.appendSystemPrompt,
    confirmationHandler,
    otherProps.maxTurns
  );
  const { getPreviousCommand, getNextCommand, addToHistory } = useCommandHistory();

  const hasSentInitialMessage = useRef(false);
  const readyAnnouncementSent = useRef(false);
  const lastInitializationError = useRef<string | null>(null);

  const handlePermissionModeToggle = useMemoizedFn(async () => {
    const configManager = ConfigManager.getInstance();
    const currentMode: PermissionMode =
      appState.permissionMode || PermissionMode.DEFAULT;

    // Shift+Tab 循环切换: DEFAULT → AUTO_EDIT → PLAN → DEFAULT
    let nextMode: PermissionMode;
    if (currentMode === PermissionMode.DEFAULT) {
      nextMode = PermissionMode.AUTO_EDIT;
    } else if (currentMode === PermissionMode.AUTO_EDIT) {
      nextMode = PermissionMode.PLAN;
    } else {
      nextMode = PermissionMode.DEFAULT;
    }

    try {
      await configManager.setPermissionMode(nextMode);
      appDispatch(appActions.setPermissionMode(nextMode));
    } catch (error) {
      // 只在失败时显示错误通知
      appDispatch(
        appActions.addNotification({
          type: 'error',
          title: '权限模式切换失败',
          message: error instanceof Error ? error.message : '未知错误',
        })
      );
    }
  });

  const {
    input,
    setInput,
    handleSubmit,
    showSuggestions,
    suggestions,
    selectedSuggestionIndex,
  } = useMainInput(
    (command: string) => executeCommand(command, addUserMessage, addAssistantMessage),
    getPreviousCommand,
    getNextCommand,
    addToHistory,
    handleAbort,
    isProcessing,
    handlePermissionModeToggle
  );

  // 焦点管理：根据不同状态切换焦点
  const { setFocus } = useFocusContext();
  useEffect(() => {
    if (requiresSetup) {
      // SetupWizard 显示时，焦点转移到设置向导
      setFocus(FocusId.SETUP_WIZARD);
      return;
    }

    if (confirmationState.isVisible) {
      // 显示确认对话框时，焦点转移到对话框
      setFocus(FocusId.CONFIRMATION_PROMPT);
    } else if (appState.showSessionSelector) {
      // 显示会话选择器时，焦点转移到选择器
      setFocus(FocusId.SESSION_SELECTOR);
    } else if (appState.showThemeSelector) {
      // 显示主题选择器时，焦点转移到选择器
      setFocus(FocusId.THEME_SELECTOR);
    } else if (appState.showPermissionsManager) {
      // 显示权限管理器时，焦点转移到管理器
      setFocus(FocusId.PERMISSIONS_MANAGER);
    } else {
      // 其他情况，焦点在主输入框
      setFocus(FocusId.MAIN_INPUT);
    }
  }, [
    requiresSetup,
    confirmationState.isVisible,
    appState.showSessionSelector,
    appState.showThemeSelector,
    appState.showPermissionsManager,
    setFocus,
  ]);

  useEffect(() => {
    if (!readyForChat || readyAnnouncementSent.current) {
      return;
    }

    readyAnnouncementSent.current = true;
    addAssistantMessage('Blade Code 助手已就绪！');
    addAssistantMessage('请输入您的问题，我将为您提供帮助。');
  }, [readyForChat, addAssistantMessage]);

  useEffect(() => {
    if (!initializationError) {
      return;
    }

    if (lastInitializationError.current === initializationError) {
      return;
    }

    lastInitializationError.current = initializationError;

    if (initializationStatus === 'error') {
      addAssistantMessage(`❌ 初始化失败: ${initializationError}`);
    } else {
      addAssistantMessage(`❌ ${initializationError}`);
      addAssistantMessage('请重新尝试设置，或检查文件权限');
    }
  }, [initializationError, initializationStatus, addAssistantMessage]);

  useEffect(() => {
    const message = otherProps.initialMessage?.trim();
    if (!message || hasSentInitialMessage.current || !readyForChat || requiresSetup) {
      return;
    }

    hasSentInitialMessage.current = true;
    addToHistory(message);

    (async () => {
      try {
        await executeCommand(message, addUserMessage, addAssistantMessage);
      } catch (error) {
        const fallback = error instanceof Error ? error.message : '无法发送初始消息';
        addAssistantMessage(`❌ 初始消息发送失败：${fallback}`);
      }
    })();
  }, [
    otherProps.initialMessage,
    readyForChat,
    requiresSetup,
    executeCommand,
    addUserMessage,
    addAssistantMessage,
    addToHistory,
  ]);

  // 设置向导取消回调
  const handleSetupCancel = () => {
    addAssistantMessage('❌ 设置已取消');
    addAssistantMessage('Blade 需要 API 配置才能正常工作。');
    addAssistantMessage('您可以稍后运行 Blade 重新进入设置向导。');
    process.exit(0); // 退出程序
  };

  useEffect(() => {
    const targetMode = otherProps.permissionMode as PermissionMode | undefined;
    if (debug) {
      console.log('[Debug] permissionMode from CLI:', targetMode);
      console.log('[Debug] current appState.permissionMode:', appState.permissionMode);
    }
    if (!targetMode || targetMode === appState.permissionMode) {
      return;
    }

    (async () => {
      try {
        const configManager = ConfigManager.getInstance();
        await configManager.setPermissionMode(targetMode);
        appDispatch(appActions.setPermissionMode(targetMode));
      } catch (error) {
        appDispatch(
          appActions.addNotification({
            type: 'error',
            title: '权限模式初始化失败',
            message: error instanceof Error ? error.message : '未知错误',
          })
        );
      }
    })();
  }, [otherProps.permissionMode, appState.permissionMode, appDispatch, appActions]);

  // 如果显示设置向导，渲染 SetupWizard 组件
  if (requiresSetup) {
    return (
      <SetupWizard onComplete={handleSetupComplete} onCancel={handleSetupCancel} />
    );
  }

  // 主界面 - 统一显示，不再区分初始化状态
  if (debug) {
    console.log('[Debug] 渲染主界面，条件检查:', {
      confirmationVisible: confirmationState.isVisible,
      showThemeSelector: appState.showThemeSelector,
      showPermissionsManager: appState.showPermissionsManager,
      showSessionSelector: appState.showSessionSelector,
    });
  }

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* 确认对话框覆盖层 */}
      {confirmationState.isVisible && confirmationState.details ? (
        <ConfirmationPrompt
          details={confirmationState.details}
          onResponse={handleResponse}
        />
      ) : appState.showThemeSelector ? (
        <ThemeSelector />
      ) : appState.showPermissionsManager ? (
        <PermissionsManager
          onClose={() => appDispatch(appActions.hidePermissionsManager())}
        />
      ) : appState.showSessionSelector ? (
        <SessionSelector
          sessions={appState.sessionSelectorData as SessionMetadata[] | undefined} // 从 AppContext 传递会话数据
          onSelect={async (sessionId: string) => {
            try {
              const messages = await SessionService.loadSession(sessionId);

              // 转换消息格式（不再过滤 tool 消息）
              const sessionMessages = messages.map((msg, index) => ({
                id: `restored-${Date.now()}-${index}`,
                role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
                content:
                  typeof msg.content === 'string'
                    ? msg.content
                    : JSON.stringify(msg.content),
                timestamp: Date.now() - (messages.length - index) * 1000,
              }));

              // 恢复会话
              restoreSession(sessionId, sessionMessages);

              // 关闭选择器
              appDispatch(appActions.hideSessionSelector());
            } catch (error) {
              console.error('[BladeInterface] Failed to restore session:', error);
              appDispatch(appActions.hideSessionSelector());
            }
          }}
          onCancel={() => {
            // 如果是 --resume CLI 模式，按 Esc 退出应用
            // 如果是 /resume 斜杠命令模式，按 Esc 关闭选择器
            if (otherProps.resume) {
              exit(); // CLI 模式：退出应用
            } else {
              appDispatch(appActions.hideSessionSelector()); // 斜杠命令模式：关闭选择器
            }
          }}
        />
      ) : (
        <>
          <Header />

          <MessageArea
            sessionState={sessionState}
            terminalWidth={terminalWidth}
            isProcessing={isProcessing}
            isInitialized={readyForChat}
            loopState={loopState}
            todos={todos}
            showTodoPanel={showTodoPanel}
          />

          <InputArea
            input={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            isProcessing={isProcessing || !readyForChat}
          />

          {/* 命令建议列表 - 显示在输入框下方 */}
          <CommandSuggestions
            suggestions={suggestions}
            selectedIndex={selectedSuggestionIndex}
            visible={showSuggestions}
          />

          <ChatStatusBar
            messageCount={sessionState.messages.length}
            hasApiKey={readyForChat}
            isProcessing={isProcessing || !readyForChat}
            permissionMode={appState.permissionMode}
          />

          {/* 性能监控 - Debug 模式 */}
          {debug && (
            <Box position="absolute" width={30}>
              <PerformanceMonitor />
            </Box>
          )}
        </>
      )}
    </Box>
  );
};

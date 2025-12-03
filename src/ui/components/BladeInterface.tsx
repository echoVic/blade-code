import { useMemoizedFn } from 'ahooks';
import { Box, useApp } from 'ink';
import React, { useEffect, useRef } from 'react';
import { ConfigManager } from '../../config/ConfigManager.js';
import {
  type ModelConfig,
  PermissionMode,
  type SetupConfig,
} from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { SessionService } from '../../services/SessionService.js';
import type { ConfirmationResponse } from '../../tools/types/ExecutionTypes.js';
import type { AppProps } from '../App.js';
import { useAppState, usePermissionMode, useTodos } from '../contexts/AppContext.js';
import { FocusId, useFocusContext } from '../contexts/FocusContext.js';
import { useSession } from '../contexts/SessionContext.js';
import { useCommandHandler } from '../hooks/useCommandHandler.js';
import { useCommandHistory } from '../hooks/useCommandHistory.js';
import { useConfirmation } from '../hooks/useConfirmation.js';
import { useInputBuffer } from '../hooks/useInputBuffer.js';
import { useMainInput } from '../hooks/useMainInput.js';
import { AgentCreationWizard } from './AgentCreationWizard.js';
import { AgentsManager } from './AgentsManager.js';
import { ChatStatusBar } from './ChatStatusBar.js';
import { CommandSuggestions } from './CommandSuggestions.js';
import { ConfirmationPrompt } from './ConfirmationPrompt.js';
import { InputArea } from './InputArea.js';
import { LoadingIndicator } from './LoadingIndicator.js';
import { MessageArea } from './MessageArea.js';
import { ModelConfigWizard } from './ModelConfigWizard.js';
import { ModelSelector } from './ModelSelector.js';
import { PermissionsManager } from './PermissionsManager.js';
import { SessionSelector } from './SessionSelector.js';
import { ThemeSelector } from './ThemeSelector.js';

// 创建 BladeInterface 专用 Logger
const logger = createLogger(LogCategory.UI);

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
  if (debug) {
    logger.debug('[Debug] BladeInterface props:', {
      permissionMode: otherProps.permissionMode,
      yolo: otherProps.yolo,
    });
  }

  // ==================== State & Refs ====================
  const hasProcessedResumeRef = useRef(false);
  const hasSentInitialMessage = useRef(false);
  const readyAnnouncementSent = useRef(false);
  const lastInitializationError = useRef<string | null>(null);

  // ==================== Context & Hooks ====================
  const { state: appState, dispatch: appDispatch, actions: appActions } = useAppState();
  const { state: sessionState, addAssistantMessage, restoreSession } = useSession();
  const { todos, showTodoPanel } = useTodos();
  const { setFocus } = useFocusContext();
  const { exit } = useApp();

  // ==================== Custom Hooks ====================
  // 从 AppState 读取初始化状态（由 AppProvider 检查 API Key 后设置）
  const initializationStatus = appState.initializationStatus;
  const initializationError = appState.initializationError;

  // 从 status 派生布尔值
  const readyForChat = initializationStatus === 'ready';
  const requiresSetup = initializationStatus === 'needsSetup';
  const isInitializing = initializationStatus === 'idle';

  const {
    confirmationState,
    confirmationHandler,
    handleResponse: handleResponseRaw,
  } = useConfirmation();

  const { executeCommand, handleAbort } = useCommandHandler(
    otherProps.systemPrompt,
    otherProps.appendSystemPrompt,
    confirmationHandler,
    otherProps.maxTurns
  );

  const { getPreviousCommand, getNextCommand, addToHistory } = useCommandHistory();
  const permissionMode = usePermissionMode();

  // ==================== Input Buffer ====================
  // 使用 useInputBuffer 创建稳定的输入状态，避免 resize 时重建
  const inputBuffer = useInputBuffer('', 0);

  // ==================== Memoized Handlers ====================
  const handlePermissionModeToggle = useMemoizedFn(async () => {
    const configManager = ConfigManager.getInstance();
    const currentMode: PermissionMode = permissionMode;

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
      // Update AppContext config to reflect the change
      const updatedConfig = configManager.getConfig();
      appDispatch(
        appActions.setConfig({
          ...appState.config!,
          permissionMode: updatedConfig.permissionMode,
        })
      );
    } catch (error) {
      logger.error(
        '❌ 权限模式切换失败:',
        error instanceof Error ? error.message : error
      );
    }
  });

  const handleSetupComplete = useMemoizedFn(async (newConfig: SetupConfig) => {
    try {
      // 创建第一个模型配置
      const configManager = ConfigManager.getInstance();

      await configManager.addModel({
        name: newConfig.name,
        provider: newConfig.provider,
        apiKey: newConfig.apiKey,
        baseUrl: newConfig.baseUrl,
        model: newConfig.model,
      });

      // 合并新配置到现有 RuntimeConfig
      const updatedConfig = {
        ...appState.config!,
        ...newConfig,
      };
      appDispatch(appActions.setConfig(updatedConfig));

      // 设置完成后，将状态改为 ready（因为 API Key 已经配置）
      appDispatch(appActions.setInitializationStatus('ready'));
    } catch (error) {
      logger.error(
        '❌ 初始化配置保存失败:',
        error instanceof Error ? error.message : error
      );
      // 即使出错也继续，让用户可以进入主界面
      const updatedConfig = {
        ...appState.config!,
        ...newConfig,
      };
      appDispatch(appActions.setConfig(updatedConfig));
      appDispatch(appActions.setInitializationStatus('ready'));
    }
  });

  const handleToggleShortcuts = useMemoizedFn(() => {
    if (appState.activeModal === 'shortcuts') {
      appDispatch(appActions.closeModal());
    } else {
      appDispatch(appActions.showShortcuts());
    }
  });

  const { showSuggestions, suggestions, selectedSuggestionIndex } = useMainInput(
    inputBuffer,
    executeCommand,
    getPreviousCommand,
    getNextCommand,
    addToHistory,
    handleAbort,
    sessionState.isThinking,
    handlePermissionModeToggle,
    handleToggleShortcuts,
    appState.activeModal === 'shortcuts'
  );

  // 当有输入内容时，自动关闭快捷键帮助
  useEffect(() => {
    if (inputBuffer.value && appState.activeModal === 'shortcuts') {
      appDispatch(appActions.closeModal());
    }
  }, [inputBuffer.value, appState.activeModal, appDispatch, appActions]);

  const handleResume = useMemoizedFn(async () => {
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
        logger.error('没有找到历史会话');
        process.exit(1);
      }

      // 显示会话选择器
      appDispatch(appActions.showSessionSelector(sessions));
    } catch (error) {
      logger.error('[BladeInterface] 加载会话失败:', error);
      process.exit(1);
    }
  });

  useEffect(() => {
    if (hasProcessedResumeRef.current) return;
    if (!otherProps.resume) return;

    hasProcessedResumeRef.current = true;
    handleResume();
  }, [otherProps.resume, handleResume]);

  // ==================== Memoized Methods ====================
  const handleResponse = useMemoizedFn(async (response: ConfirmationResponse) => {
    // ✅ 移除 UI 层的模式切换逻辑 - Agent 层已经负责持久化配置
    // Plan 模式退出后，Agent 会自动更新配置并重新执行
    // UI 只需要传递 response.targetMode 给 Agent，由 Agent 统一处理

    // 如果是 Plan 模式批准，等待 Agent 完成配置更新后同步到 UI
    if (confirmationState.details?.type === 'exitPlanMode' && response.approved) {
      // 延迟更新 UI 配置，等待 Agent 完成持久化
      setTimeout(() => {
        const configManager = ConfigManager.getInstance();
        const updatedConfig = configManager.getConfig();
        appDispatch(
          appActions.setConfig({
            ...appState.config!,
            permissionMode: updatedConfig.permissionMode,
          })
        );
        logger.debug(
          `[BladeInterface] UI 配置已同步: ${updatedConfig.permissionMode}`
        );
      }, 100);
    }

    handleResponseRaw(response);
  });

  const handleSetupCancel = useMemoizedFn(() => {
    addAssistantMessage('❌ 设置已取消');
    addAssistantMessage('Blade 需要 API 配置才能正常工作。');
    addAssistantMessage('您可以稍后运行 Blade 重新进入设置向导。');
    process.exit(0); // 退出程序
  });

  const closeModal = useMemoizedFn(() => {
    appDispatch(appActions.closeModal());
  });

  const handleSessionSelect = useMemoizedFn(async (sessionId: string) => {
    try {
      const messages = await SessionService.loadSession(sessionId);

      const sessionMessages = messages.map((msg, index) => ({
        id: `restored-${Date.now()}-${index}`,
        role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
        content:
          typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        timestamp: Date.now() - (messages.length - index) * 1000,
      }));

      restoreSession(sessionId, sessionMessages);
      appDispatch(appActions.closeModal());
    } catch (error) {
      logger.error('[BladeInterface] Failed to restore session:', error);
      appDispatch(appActions.closeModal());
    }
  });

  const handleSessionCancel = useMemoizedFn(() => {
    if (otherProps.resume) {
      exit();
    } else {
      appDispatch(appActions.closeModal());
    }
  });

  const handleModelEditRequest = useMemoizedFn((model: ModelConfig) => {
    appDispatch(appActions.showModelEditWizard(model));
  });

  const handleModelEditComplete = useMemoizedFn((updatedConfig: SetupConfig) => {
    addAssistantMessage(`✅ 已更新模型配置: ${updatedConfig.name}`);
    closeModal();
  });

  // ==================== Effects ====================
  // 焦点管理：根据不同状态切换焦点
  useEffect(() => {
    if (requiresSetup) {
      // ModelConfigWizard (setup 模式) 显示时，焦点转移到向导
      setFocus(FocusId.MODEL_CONFIG_WIZARD);
      return;
    }

    if (confirmationState.isVisible) {
      // 显示确认对话框时，焦点转移到对话框
      setFocus(FocusId.CONFIRMATION_PROMPT);
    } else if (appState.activeModal === 'sessionSelector') {
      // 显示会话选择器时，焦点转移到选择器
      setFocus(FocusId.SESSION_SELECTOR);
    } else if (appState.activeModal === 'themeSelector') {
      // 显示主题选择器时，焦点转移到选择器
      setFocus(FocusId.THEME_SELECTOR);
    } else if (appState.activeModal === 'modelSelector') {
      // 显示模型选择器时，焦点转移到选择器
      setFocus(FocusId.MODEL_SELECTOR);
    } else if (
      appState.activeModal === 'modelAddWizard' ||
      appState.activeModal === 'modelEditWizard'
    ) {
      // ModelConfigWizard (add/edit 模式) 显示时，焦点转移到向导
      setFocus(FocusId.MODEL_CONFIG_WIZARD);
    } else if (appState.activeModal === 'permissionsManager') {
      // 显示权限管理器时，焦点转移到管理器
      setFocus(FocusId.PERMISSIONS_MANAGER);
    } else if (appState.activeModal === 'agentsManager') {
      // 显示 agents 管理器时，焦点转移到管理器
      setFocus(FocusId.AGENTS_MANAGER);
    } else if (appState.activeModal === 'agentCreationWizard') {
      // 显示 agent 创建向导时，焦点转移到向导
      setFocus(FocusId.AGENT_CREATION_WIZARD);
    } else if (appState.activeModal === 'shortcuts') {
      // 显示快捷键帮助时，焦点保持在主输入框（帮助面板可以通过 ? 或 Esc 关闭）
      setFocus(FocusId.MAIN_INPUT);
    } else {
      // 其他情况，焦点在主输入框
      setFocus(FocusId.MAIN_INPUT);
    }
  }, [requiresSetup, confirmationState.isVisible, appState.activeModal, setFocus]);

  useEffect(() => {
    if (!readyForChat || readyAnnouncementSent.current) {
      return;
    }

    readyAnnouncementSent.current = true;
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
        await executeCommand(message);
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
    addToHistory,
  ]);

  useEffect(() => {
    const targetMode = otherProps.permissionMode as PermissionMode | undefined;
    if (debug) {
      logger.debug('[Debug] permissionMode from CLI:', targetMode);
      logger.debug('[Debug] current permissionMode:', permissionMode);
    }
    if (!targetMode || targetMode === permissionMode) {
      return;
    }

    (async () => {
      try {
        const configManager = ConfigManager.getInstance();
        await configManager.setPermissionMode(targetMode);
        // Update AppContext config to reflect the change
        const updatedConfig = configManager.getConfig();
        appDispatch(
          appActions.setConfig({
            ...appState.config!,
            permissionMode: updatedConfig.permissionMode,
          })
        );
      } catch (error) {
        logger.error(
          '❌ 权限模式初始化失败:',
          error instanceof Error ? error.message : error
        );
      }
    })();
  }, [otherProps.permissionMode, permissionMode]);

  // 初始化中 - 不渲染任何内容，避免闪烁
  if (isInitializing) {
    return null;
  }

  // 如果显示设置向导，渲染 ModelConfigWizard 组件（setup 模式）
  if (requiresSetup) {
    return (
      <ModelConfigWizard
        mode="setup"
        onComplete={handleSetupComplete}
        onCancel={handleSetupCancel}
      />
    );
  }

  // 主界面 - 统一显示，不再区分初始化状态
  if (debug) {
    logger.debug('[Debug] 渲染主界面，条件检查:', {
      confirmationVisible: confirmationState.isVisible,
      activeModal: appState.activeModal,
    });
  }

  const inlineModelSelectorVisible = appState.activeModal === 'modelSelector';
  const editingModel = appState.modelEditorTarget;
  const inlineModelWizardMode =
    appState.activeModal === 'modelAddWizard'
      ? 'add'
      : appState.activeModal === 'modelEditWizard' && editingModel
        ? 'edit'
        : null;
  const inlineModelUiVisible =
    inlineModelSelectorVisible || Boolean(inlineModelWizardMode);

  const agentsManagerVisible = appState.activeModal === 'agentsManager';
  const agentCreationWizardVisible = appState.activeModal === 'agentCreationWizard';

  const editingInitialConfig = editingModel
    ? {
        name: editingModel.name,
        provider: editingModel.provider,
        baseUrl: editingModel.baseUrl,
        apiKey: editingModel.apiKey,
        model: editingModel.model,
      }
    : undefined;

  const blockingModal =
    confirmationState.isVisible && confirmationState.details ? (
      <ConfirmationPrompt
        details={confirmationState.details}
        onResponse={handleResponse}
      />
    ) : appState.activeModal === 'themeSelector' ? (
      <ThemeSelector />
    ) : appState.activeModal === 'permissionsManager' ? (
      <PermissionsManager onClose={closeModal} />
    ) : appState.activeModal === 'sessionSelector' ? (
      <SessionSelector
        sessions={appState.sessionSelectorData}
        onSelect={handleSessionSelect}
        onCancel={handleSessionCancel}
      />
    ) : null;

  const isInputDisabled =
    sessionState.isThinking || !readyForChat || inlineModelUiVisible;

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {blockingModal ?? (
        <>
          {/* MessageArea 内部直接引入 Header，作为 Static 的第一个子项 */}
          <MessageArea
            sessionState={sessionState}
            todos={todos}
            showTodoPanel={showTodoPanel}
          />

          {/* 加载指示器 - 显示在输入框上方 */}
          <LoadingIndicator
            visible={sessionState.isThinking || !readyForChat}
            message="正在思考中..."
          />

          <InputArea
            input={inputBuffer.value}
            cursorPosition={inputBuffer.cursorPosition}
            onChange={inputBuffer.setValue}
            onChangeCursorPosition={inputBuffer.setCursorPosition}
            isProcessing={isInputDisabled}
          />

          {inlineModelSelectorVisible && (
            <Box marginTop={1} paddingX={2}>
              <ModelSelector onClose={closeModal} onEdit={handleModelEditRequest} />
            </Box>
          )}

          {inlineModelWizardMode && (
            <Box marginTop={1} paddingX={2}>
              <ModelConfigWizard
                mode={inlineModelWizardMode}
                modelId={editingModel?.id}
                initialConfig={
                  inlineModelWizardMode === 'edit' ? editingInitialConfig : undefined
                }
                onComplete={
                  inlineModelWizardMode === 'edit'
                    ? handleModelEditComplete
                    : closeModal
                }
                onCancel={closeModal}
              />
            </Box>
          )}

          {agentsManagerVisible && (
            <Box marginTop={1} paddingX={2}>
              <AgentsManager onComplete={closeModal} onCancel={closeModal} />
            </Box>
          )}

          {agentCreationWizardVisible && (
            <Box marginTop={1} paddingX={2}>
              <AgentCreationWizard onComplete={closeModal} onCancel={closeModal} />
            </Box>
          )}

          {/* 命令建议列表 - 显示在输入框下方 */}
          <CommandSuggestions
            suggestions={suggestions}
            selectedIndex={selectedSuggestionIndex}
            visible={showSuggestions && !inlineModelUiVisible}
          />
          <ChatStatusBar
            hasApiKey={readyForChat}
            isProcessing={sessionState.isThinking || !readyForChat}
            permissionMode={permissionMode}
            showShortcuts={appState.activeModal === 'shortcuts'}
          />
        </>
      )}
    </Box>
  );
};

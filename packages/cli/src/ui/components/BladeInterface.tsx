import { useMemoizedFn } from 'ahooks';
import React, { useEffect } from 'react';
import {
  PermissionMode,
  type SetupConfig,
} from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { safeExit } from '../../services/GracefulShutdown.js';
import { SpecManager } from '../../spec/SpecManager.js';
import {
  useActiveModal,
  useAppActions,
  useInitializationStatus,
  useIsProcessing,
  usePermissionMode,
  useSessionActions,
} from '../../store/selectors/index.js';
import { configActions } from '../../store/vanilla.js';
import type { ConfirmationResponse } from '../../tools/types/ExecutionTypes.js';
import type { AppProps } from '../App.js';
import { useCommandHandler } from '../hooks/useCommandHandler.js';
import { useCommandHistory } from '../hooks/useCommandHistory.js';
import { useConfirmation } from '../hooks/useConfirmation.js';
import { useInputBuffer } from '../hooks/useInputBuffer.js';
import { useMainInput } from '../hooks/useMainInput.js';
import { useRefreshStatic } from '../hooks/useRefreshStatic.js';
import { MainLayout } from './MainLayout.js';
import { useModalOrchestrator } from './ModalOrchestrator.js';
import { ModelConfigWizard } from './model-config/index.js';
import { SessionInitializer } from './SessionInitializer.js';

const logger = createLogger(LogCategory.UI);

interface BladeInterfaceProps extends AppProps {}

export const BladeInterface: React.FC<BladeInterfaceProps> = ({
  debug,
  continue: continueSession,
  ...otherProps
}) => {
  if (debug) {
    logger.debug('[Debug] BladeInterface props:', {
      permissionMode: otherProps.permissionMode,
      yolo: otherProps.yolo,
      maxTurns: otherProps.maxTurns,
      continue: continueSession,
    });
  }

  const initializationStatus = useInitializationStatus();
  const activeModal = useActiveModal();
  const appActions = useAppActions();
  const sessionActions = useSessionActions();
  const permissionMode = usePermissionMode();
  const isProcessing = useIsProcessing();

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

  useRefreshStatic();

  const inputBuffer = useInputBuffer('', 0);

  const PERMISSION_CYCLE: PermissionMode[] = [
    PermissionMode.DEFAULT,
    PermissionMode.AUTO_EDIT,
    PermissionMode.PLAN,
    PermissionMode.SPEC,
  ];

  const handlePermissionModeToggle = useMemoizedFn(async () => {
    const idx = PERMISSION_CYCLE.indexOf(permissionMode);
    const nextMode = PERMISSION_CYCLE[(idx + 1) % PERMISSION_CYCLE.length]!;

    try {
      await configActions().setPermissionMode(nextMode);

      if (nextMode === PermissionMode.SPEC) {
        try {
          const specManager = SpecManager.getInstance();
          await specManager.initialize(process.cwd());

          const specs = await specManager.listSpecs();
          if (specs.length > 0) {
            const recentSpec = specs[0];
            await specManager.loadSpec(recentSpec.name);
            sessionActions.addAssistantMessage(
              `📋 **已进入 Spec 模式**\n\n` +
                `检测到已存在的 Spec: **${recentSpec.name}**\n` +
                `当前阶段: ${recentSpec.phase}\n\n` +
                `继续之前的工作，或告诉我你想做什么。`
            );
          } else {
            sessionActions.addAssistantMessage(
              '📋 **已进入 Spec 模式**\n\n' +
                '请告诉我你想实现什么功能，我会引导你完成整个工作流：\n' +
                '`提案 → 需求 → 设计 → 任务 → 实现`\n\n' +
                '例如："实现用户认证功能" 或 "添加暗黑模式支持"'
            );
          }
        } catch (error) {
          logger.warn('Failed to initialize SpecManager:', error);
          sessionActions.addAssistantMessage(
            '📋 **已进入 Spec 模式**\n\n' +
              '请告诉我你想实现什么功能，我会引导你完成整个工作流：\n' +
              '`提案 → 需求 → 设计 → 任务 → 实现`\n\n' +
              '例如："实现用户认证功能" 或 "添加暗黑模式支持"'
          );
        }
      }
    } catch (error) {
      logger.error(
        '❌ 权限模式切换失败:',
        error instanceof Error ? error.message : error
      );
    }
  });

  const handleToggleShortcuts = useMemoizedFn(() => {
    if (activeModal === 'shortcuts') {
      appActions.closeModal();
    } else {
      appActions.setActiveModal('shortcuts');
    }
  });

  const { showSuggestions, suggestions, selectedSuggestionIndex } = useMainInput(
    inputBuffer,
    executeCommand,
    getPreviousCommand,
    getNextCommand,
    addToHistory,
    handleAbort,
    isProcessing,
    handlePermissionModeToggle,
    handleToggleShortcuts,
    activeModal === 'shortcuts'
  );

  useEffect(() => {
    if (inputBuffer.value && activeModal === 'shortcuts') {
      appActions.closeModal();
    }
  }, [inputBuffer.value, activeModal, appActions]);

  const handleSetupComplete = useMemoizedFn(async (newConfig: SetupConfig) => {
    try {
      await configActions().addModel({
        name: newConfig.name,
        provider: newConfig.provider,
        apiKey: newConfig.apiKey,
        baseUrl: newConfig.baseUrl,
        model: newConfig.model,
      });

      appActions.setInitializationStatus('ready');
    } catch (error) {
      logger.error(
        '❌ 初始化配置保存失败:',
        error instanceof Error ? error.message : error
      );
      appActions.setInitializationStatus('ready');
    }
  });

  const handleSetupCancel = useMemoizedFn(() => {
    sessionActions.addAssistantMessage('❌ 设置已取消');
    sessionActions.addAssistantMessage('Blade 需要 API 配置才能正常工作。');
    sessionActions.addAssistantMessage('您可以稍后运行 Blade 重新进入设置向导。');
    safeExit(0);
  });

  const handleResponse = useMemoizedFn(async (response: ConfirmationResponse) => {
    const confirmationType = confirmationState.details?.type;

    if (confirmationType === 'enterPlanMode' && response.approved) {
      try {
        await configActions().setPermissionMode(PermissionMode.PLAN);
        logger.debug('[BladeInterface] Entered Plan mode');
      } catch (error) {
        logger.error('[BladeInterface] Failed to enter Plan mode:', error);
      }
    }

    if (confirmationType === 'exitPlanMode' && response.approved) {
      logger.debug('[BladeInterface] ExitPlanMode approved, Store auto-synced');
    }

    handleResponseRaw(response);
  });

  const {
    blockingModal,
    renderInlineModals,
    hasBlockingModal,
    hasInlineModelUi,
  } = useModalOrchestrator({
    confirmationState,
    handleResponse,
    requiresSetup,
    resume: otherProps.resume,
  });

  if (isInitializing) {
    return null;
  }

  if (requiresSetup) {
    return (
      <ModelConfigWizard
        mode="setup"
        onComplete={handleSetupComplete}
        onCancel={handleSetupCancel}
      />
    );
  }

  if (debug) {
    logger.debug('[Debug] 渲染主界面，条件检查:', {
      confirmationVisible: confirmationState.isVisible,
      activeModal: activeModal,
    });
  }

  return (
    <>
      <SessionInitializer
        debug={debug}
        continueSession={continueSession}
        resume={otherProps.resume}
        initialMessage={otherProps.initialMessage}
        permissionMode={otherProps.permissionMode}
        readyForChat={readyForChat}
        requiresSetup={requiresSetup}
        executeCommand={executeCommand}
        addToHistory={addToHistory}
      />
      <MainLayout
        inputBuffer={inputBuffer}
        showSuggestions={showSuggestions}
        suggestions={suggestions}
        selectedSuggestionIndex={selectedSuggestionIndex}
        hasBlockingModal={hasBlockingModal}
        hasInlineModelUi={hasInlineModelUi}
        renderInlineModals={renderInlineModals}
        blockingModal={blockingModal}
      />
    </>
  );
};

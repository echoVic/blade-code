import { useMemoizedFn } from 'ahooks';
import { Box, useApp } from 'ink';
import React, { useEffect } from 'react';
import type { ModelConfig, SetupConfig } from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { SessionService } from '../../services/SessionService.js';
import {
  useActiveModal,
  useAppActions,
  useFocusActions,
  useModelEditorTarget,
  useSessionActions,
  useSessionSelectorData,
} from '../../store/selectors/index.js';
import { FocusId, type ActiveModal as ActiveModalType } from '../../store/types.js';
import type {
  ConfirmationDetails,
  ConfirmationResponse,
} from '../../tools/types/ExecutionTypes.js';
import { AgentCreationWizard } from './AgentCreationWizard.js';
import { AgentsManager } from './AgentsManager.js';
import { ConfirmationPrompt } from './ConfirmationPrompt.js';
import { HooksManager } from './HooksManager.js';
import { ModelConfigWizard } from './model-config/index.js';
import { ModelSelector } from './ModelSelector.js';
import { PermissionsManager } from './PermissionsManager.js';
import { PluginsManager } from './PluginsManager.js';
import { QuestionPrompt } from './QuestionPrompt.js';
import { SessionSelector } from './SessionSelector.js';
import { SkillsManager } from './SkillsManager.js';
import { ThemeSelector } from './ThemeSelector.js';

const logger = createLogger(LogCategory.UI);

type ActiveModal =
  | { kind: 'none' }
  | { kind: 'sessionSelector' }
  | { kind: 'modelSelector' }
  | { kind: 'modelAddWizard' }
  | { kind: 'modelEditWizard'; model: ModelConfig }
  | { kind: 'themeSelector' }
  | { kind: 'permissionsManager' }
  | { kind: 'hooksManager' }
  | { kind: 'agentsManager' }
  | { kind: 'agentCreationWizard' }
  | { kind: 'skillsManager' }
  | { kind: 'pluginsManager' }
  | { kind: 'specStatusPanel' }
  | { kind: 'shortcuts' }
  | { kind: 'todoPanel' };

function resolveActiveModal(
  storeModal: ActiveModalType,
  editingModel: ModelConfig | null,
): ActiveModal {
  switch (storeModal) {
    case 'sessionSelector':
      return { kind: 'sessionSelector' };
    case 'modelSelector':
      return { kind: 'modelSelector' };
    case 'modelAddWizard':
      return { kind: 'modelAddWizard' };
    case 'modelEditWizard':
      return editingModel
        ? { kind: 'modelEditWizard', model: editingModel }
        : { kind: 'none' };
    case 'themeSelector':
      return { kind: 'themeSelector' };
    case 'permissionsManager':
      return { kind: 'permissionsManager' };
    case 'hooksManager':
      return { kind: 'hooksManager' };
    case 'agentsManager':
      return { kind: 'agentsManager' };
    case 'agentCreationWizard':
      return { kind: 'agentCreationWizard' };
    case 'skillsManager':
      return { kind: 'skillsManager' };
    case 'pluginsManager':
      return { kind: 'pluginsManager' };
    case 'shortcuts':
      return { kind: 'shortcuts' };
    case 'todoPanel':
      return { kind: 'todoPanel' };
    default:
      return { kind: 'none' };
  }
}

interface ConfirmationState {
  isVisible: boolean;
  details: ConfirmationDetails | null;
}

interface UseModalOrchestratorProps {
  confirmationState: ConfirmationState;
  handleResponse: (response: ConfirmationResponse) => void;
  requiresSetup: boolean;
  resume?: string;
}

export function useModalOrchestrator(props: UseModalOrchestratorProps) {
  const activeModalStore = useActiveModal();
  const modelEditorTarget = useModelEditorTarget();
  const sessionSelectorData = useSessionSelectorData();
  const appActions = useAppActions();
  const sessionActions = useSessionActions();
  const focusActions = useFocusActions();
  const { exit } = useApp();

  const modal = resolveActiveModal(activeModalStore, modelEditorTarget);

  const closeModal = useMemoizedFn(() => {
    appActions.closeModal();
  });

  const handleSessionSelect = useMemoizedFn(async (sessionId: string) => {
    try {
      const messages = await SessionService.loadSession(sessionId);

      const sessionMessages = messages.map((msg, index) => ({
        id: `restored-${Date.now()}-${index}`,
        role: msg.role,
        content:
          typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        timestamp: Date.now() - (messages.length - index) * 1000,
        metadata:
          msg.metadata && typeof msg.metadata === 'object'
            ? (msg.metadata as Record<string, unknown>)
            : undefined,
      }));

      sessionActions.restoreSession(sessionId, sessionMessages);
      appActions.closeModal();
    } catch (error) {
      logger.error('[BladeInterface] Failed to restore session:', error);
      appActions.closeModal();
    }
  });

  const handleSessionCancel = useMemoizedFn(() => {
    if (props.resume) {
      exit();
    } else {
      appActions.closeModal();
    }
  });

  const handleModelEditRequest = useMemoizedFn((model: ModelConfig) => {
    appActions.showModelEditWizard(model);
  });

  const handleModelAddComplete = useMemoizedFn((addedConfig: SetupConfig) => {
    sessionActions.addAssistantMessage(
      `✅ 已添加模型配置: ${addedConfig.name}，并已切换到该模型`
    );
    closeModal();
  });

  const handleModelEditComplete = useMemoizedFn((updatedConfig: SetupConfig) => {
    sessionActions.addAssistantMessage(`✅ 已更新模型配置: ${updatedConfig.name}`);
    closeModal();
  });

  useEffect(() => {
    if (props.requiresSetup) {
      focusActions.setFocus(FocusId.MODEL_CONFIG_WIZARD);
      return;
    }

    if (props.confirmationState.isVisible) {
      focusActions.setFocus(FocusId.CONFIRMATION_PROMPT);
    } else if (activeModalStore === 'sessionSelector') {
      focusActions.setFocus(FocusId.SESSION_SELECTOR);
    } else if (activeModalStore === 'themeSelector') {
      focusActions.setFocus(FocusId.THEME_SELECTOR);
    } else if (activeModalStore === 'modelSelector') {
      focusActions.setFocus(FocusId.MODEL_SELECTOR);
    } else if (activeModalStore === 'modelAddWizard' || activeModalStore === 'modelEditWizard') {
      focusActions.setFocus(FocusId.MODEL_CONFIG_WIZARD);
    } else if (activeModalStore === 'permissionsManager') {
      focusActions.setFocus(FocusId.PERMISSIONS_MANAGER);
    } else if (activeModalStore === 'agentsManager') {
      focusActions.setFocus(FocusId.AGENTS_MANAGER);
    } else if (activeModalStore === 'agentCreationWizard') {
      focusActions.setFocus(FocusId.AGENT_CREATION_WIZARD);
    } else if (activeModalStore === 'hooksManager') {
      focusActions.setFocus(FocusId.HOOKS_MANAGER);
    } else if (activeModalStore === 'shortcuts') {
      focusActions.setFocus(FocusId.MAIN_INPUT);
    } else {
      focusActions.setFocus(FocusId.MAIN_INPUT);
    }
  }, [props.requiresSetup, props.confirmationState.isVisible, activeModalStore, focusActions.setFocus]);

  const editingInitialConfig = modal.kind === 'modelEditWizard'
    ? {
        name: modal.model.name,
        provider: modal.model.provider,
        baseUrl: modal.model.baseUrl,
        apiKey: modal.model.apiKey,
        model: modal.model.model,
      }
    : undefined;

  const renderBlockingModal = (): React.ReactNode => {
    if (props.confirmationState.isVisible && props.confirmationState.details) {
      if (
        props.confirmationState.details.type === 'askUserQuestion' &&
        props.confirmationState.details.questions
      ) {
        return (
          <QuestionPrompt
            questions={props.confirmationState.details.questions}
            onComplete={(answers) => props.handleResponse({ approved: true, answers })}
            onCancel={() => props.handleResponse({ approved: false })}
          />
        );
      }
      return (
        <ConfirmationPrompt
          details={props.confirmationState.details}
          onResponse={props.handleResponse}
        />
      );
    }

    if (modal.kind === 'themeSelector') {
      return <ThemeSelector />;
    }
    if (modal.kind === 'permissionsManager') {
      return <PermissionsManager onClose={closeModal} />;
    }
    if (modal.kind === 'sessionSelector') {
      return (
        <SessionSelector
          sessions={sessionSelectorData}
          onSelect={handleSessionSelect}
          onCancel={handleSessionCancel}
        />
      );
    }
    if (modal.kind === 'hooksManager') {
      return <HooksManager onClose={closeModal} />;
    }

    return null;
  };

  const renderInlineModals = (): React.ReactNode => (
    <>
      {modal.kind === 'modelSelector' && (
        <Box marginTop={1} paddingX={2}>
          <ModelSelector onClose={closeModal} onEdit={handleModelEditRequest} />
        </Box>
      )}

      {(modal.kind === 'modelAddWizard' || modal.kind === 'modelEditWizard') && (
        <Box marginTop={1} paddingX={2}>
          <ModelConfigWizard
            mode={modal.kind === 'modelEditWizard' ? 'edit' : 'add'}
            modelId={modal.kind === 'modelEditWizard' ? modal.model.id : undefined}
            initialConfig={
              modal.kind === 'modelEditWizard' ? editingInitialConfig : undefined
            }
            onComplete={
              modal.kind === 'modelEditWizard'
                ? handleModelEditComplete
                : handleModelAddComplete
            }
            onCancel={closeModal}
          />
        </Box>
      )}

      {modal.kind === 'agentsManager' && (
        <Box marginTop={1} paddingX={2}>
          <AgentsManager onComplete={closeModal} onCancel={closeModal} />
        </Box>
      )}

      {modal.kind === 'agentCreationWizard' && (
        <Box marginTop={1} paddingX={2}>
          <AgentCreationWizard onComplete={closeModal} onCancel={closeModal} />
        </Box>
      )}

      {modal.kind === 'skillsManager' && (
        <Box marginTop={1} paddingX={2}>
          <SkillsManager onComplete={closeModal} onCancel={closeModal} />
        </Box>
      )}

      {modal.kind === 'pluginsManager' && (
        <Box marginTop={1} paddingX={2}>
          <PluginsManager onComplete={closeModal} onCancel={closeModal} />
        </Box>
      )}
    </>
  );

  const blockingModal = renderBlockingModal();
  const hasBlockingModal = Boolean(blockingModal);
  const hasInlineModelUi =
    modal.kind === 'modelSelector' ||
    modal.kind === 'modelAddWizard' ||
    modal.kind === 'modelEditWizard';

  return {
    modal,
    blockingModal,
    renderInlineModals,
    hasBlockingModal,
    hasInlineModelUi,
    closeModal,
  };
}

export type { ActiveModal };

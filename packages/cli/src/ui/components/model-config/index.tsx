import { useMemoizedFn } from 'ahooks';
import { Box, Text, useInput } from 'ink';
import React, { useState } from 'react';
import type { SetupConfig } from '../../../config/types.js';
import { getPiModelCatalog } from '../../../services/pi/PiModelCatalog.js';
import { configActions, getConfig } from '../../../store/vanilla.js';
import { useCtrlCHandler } from '../../hooks/useCtrlCHandler.js';
import { ApiKeyInput } from './ApiKeyInput.js';
import { CustomProviderInput } from './CustomProviderInput.js';
import { useModels, useProviders } from './hooks/usePiCatalog.js';
import { ModelSelector } from './ModelSelector.js';
import { ProviderSelector } from './ProviderSelector.js';
import type {
  ModelConfigWizardProps,
  ModelOption,
  ProviderOption,
  WizardStep,
} from './types.js';
import { getPreviousWizardStep } from './wizardFlow.js';

export const ModelConfigWizard: React.FC<ModelConfigWizardProps> = ({
  mode,
  initialConfig,
  modelId,
  onComplete,
  onCancel,
}) => {
  const [step, setStep] = useState<WizardStep>('provider');
  const [provider, setProvider] = useState<ProviderOption>();
  const [model, setModel] = useState<ModelOption>();
  const [customSetup, setCustomSetup] = useState<SetupConfig>();
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  const providersState = useProviders();
  const modelsState = useModels(provider?.id);
  const handleCtrlC = useCtrlCHandler(false);

  useInput((input, key) => {
    if ((key.ctrl && input === 'c') || (key.meta && input === 'c')) {
      mode === 'setup' ? handleCtrlC() : onCancel();
    }
  });

  const save = useMemoizedFn(async (credential?: string) => {
    if (!provider) return;
    const setup: SetupConfig | undefined =
      customSetup ??
      (model
        ? {
            provider: provider.id,
            model: model.id,
            displayName: initialConfig?.displayName,
          }
        : undefined);
    if (!setup) return;
    setIsSaving(true);
    setError(undefined);
    try {
      if (setup.modelProvider) {
        getPiModelCatalog().registerModelProvider(setup.provider, setup.modelProvider, [
          setup.model,
        ]);
      }
      if (credential?.trim()) {
        await getPiModelCatalog().setApiKey(setup.provider, credential.trim());
      }
      const modelData = {
        displayName: setup.displayName,
        provider: setup.provider,
        model: setup.model,
        overrides: setup.overrides,
      };
      if (mode === 'setup') {
        await onComplete(setup);
      } else if (mode === 'add') {
        const added = setup.modelProvider
          ? await configActions().addModelWithProvider(modelData, setup.modelProvider)
          : await configActions().addModel(modelData);
        await configActions().setCurrentModel(added.id);
        await onComplete(setup);
      } else if (modelId) {
        if (setup.modelProvider) {
          await configActions().updateModelWithProvider(
            modelId,
            modelData,
            setup.modelProvider
          );
        } else {
          await configActions().updateModel(modelId, modelData);
        }
        await onComplete(setup);
      }
    } catch (cause) {
      if (setup.modelProvider) {
        await getPiModelCatalog().credentials.delete(setup.provider);
        const config = getConfig();
        getPiModelCatalog().configureModelProviders(
          config?.modelProviders ?? {},
          config?.models ?? []
        );
      }
      setError(cause instanceof Error ? cause.message : '保存配置失败');
      setIsSaving(false);
    }
  });

  const handleModelSelect = useMemoizedFn((selected: ModelOption) => {
    setModel(selected);
    if (provider?.configured) {
      void save();
    } else if (provider?.supportsApiKey) {
      setStep('credential');
    } else {
      setError(
        `${provider?.name ?? 'Provider'} 需要 OAuth 或环境凭证，请先在外部完成认证`
      );
    }
  });

  const back = useMemoizedFn(() => {
    setError(undefined);
    if (step === 'credential' && customSetup) {
      setStep('custom');
      return;
    }
    const previous = getPreviousWizardStep(step);
    if (previous) setStep(previous);
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="blue">
        {mode === 'edit' ? '编辑模型' : '添加模型'}
      </Text>
      {step === 'provider' && (
        <ProviderSelector
          {...providersState}
          onSelect={(selected) => {
            setProvider(selected);
            setModel(undefined);
            setCustomSetup(undefined);
            setStep(selected.factoryWireApi ? 'custom' : 'model');
          }}
          onCancel={mode === 'setup' ? () => undefined : onCancel}
        />
      )}
      {step === 'custom' && provider?.factoryWireApi && (
        <CustomProviderInput
          wireApi={provider.factoryWireApi}
          initialConfig={customSetup}
          onSubmit={(setup) => {
            setCustomSetup(setup);
            setStep('credential');
          }}
          onCancel={back}
        />
      )}
      {step === 'model' && provider && (
        <ModelSelector
          provider={provider}
          {...modelsState}
          onSelect={handleModelSelect}
          onCancel={back}
        />
      )}
      {step === 'credential' && provider && (
        <ApiKeyInput
          provider={provider}
          value={apiKey}
          onChange={setApiKey}
          onSubmit={() => void save(apiKey)}
          onCancel={back}
          error={error}
        />
      )}
      {isSaving && <Text color="yellow">正在保存配置...</Text>}
      {error && step !== 'credential' && <Text color="red">{error}</Text>}
    </Box>
  );
};

export type { ModelConfigWizardProps } from './types.js';

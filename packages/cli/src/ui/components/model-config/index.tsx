/**
 * ModelConfigWizard - 模型配置向导（重构版）
 *
 * 简化流程：
 * Step 1: 选择 Provider（80+ 选项，支持搜索）
 * Step 2: 输入 API Key
 * Step 2.5: 确认或修改 Base URL
 * Step 3: 选择模型（从内置列表选择或自定义）
 */

import { useMemoizedFn } from 'ahooks';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import React, { useState } from 'react';
import type { SetupConfig } from '../../../config/types.js';
import { configActions } from '../../../store/vanilla.js';
import { useCtrlCHandler } from '../../hooks/useCtrlCHandler.js';
import { ApiKeyInput } from './ApiKeyInput.js';
import { useModels, useProviders } from './hooks/useModelsDev.js';
import { ModelSelector } from './ModelSelector.js';
import { ProviderSelector } from './ProviderSelector.js';
import {
  DEFAULT_BASE_URLS,
  type ModelConfigWizardProps,
  type ModelOption,
  type ProviderOption,
  type WizardStep,
} from './types.js';
import { getPreviousWizardStep, getStepAfterApiKeySubmit } from './wizardFlow.js';

export const ModelConfigWizard: React.FC<ModelConfigWizardProps> = ({
  mode,
  initialConfig,
  modelId,
  onComplete,
  onCancel,
}) => {
  const isEditMode = mode === 'edit';

  const [step, setStep] = useState<WizardStep>('provider');
  const [provider, setProvider] = useState<ProviderOption | undefined>();
  const [apiKey, setApiKey] = useState(isEditMode ? initialConfig?.apiKey || '' : '');
  const [baseUrl, setBaseUrl] = useState(
    isEditMode ? initialConfig?.baseUrl || '' : ''
  );
  const [customModel] = useState(isEditMode ? initialConfig?.model || '' : '');
  const [error, setError] = useState<string | undefined>();
  const [isSaving, setIsSaving] = useState(false);

  const {
    providers,
    isLoading: providersLoading,
    error: providersError,
  } = useProviders();
  const {
    models,
    isLoading: modelsLoading,
    error: modelsError,
  } = useModels(provider?.id);

  const handleCtrlC = useCtrlCHandler(false);

  useInput((input, key) => {
    if ((key.ctrl && input === 'c') || (key.meta && input === 'c')) {
      mode === 'setup' ? handleCtrlC() : onCancel();
    }
  });

  const getDefaultBaseUrl = useMemoizedFn((p: ProviderOption): string => {
    return p.defaultBaseUrl || DEFAULT_BASE_URLS[p.id] || '';
  });

  const handleProviderSelect = useMemoizedFn(async (selected: ProviderOption) => {
    setProvider(selected);
    setError(undefined);

    const defaultUrl = getDefaultBaseUrl(selected);
    if (!isEditMode) {
      setBaseUrl(defaultUrl);
    }

    setStep('apiKey');
  });

  const handleApiKeySubmit = useMemoizedFn(() => {
    if (!apiKey.trim()) {
      setError('API Key 不能为空');
      return;
    }
    setError(undefined);
    setStep(getStepAfterApiKeySubmit());
  });

  const handleBaseUrlSubmit = useMemoizedFn(() => {
    if (!baseUrl.trim()) {
      setError('Base URL 不能为空');
      return;
    }
    try {
      new URL(baseUrl);
    } catch {
      setError('请输入有效的 URL (例如: https://api.example.com/v1)');
      return;
    }
    setError(undefined);
    setStep('model');
  });

  const handleModelSelect = useMemoizedFn(async (selected: ModelOption) => {
    setError(undefined);
    setIsSaving(true);

    try {
      const finalBaseUrl = baseUrl || (provider ? getDefaultBaseUrl(provider) : '');
      const configName =
        isEditMode && initialConfig?.name
          ? initialConfig.name
          : `${provider?.name || 'Model'} - ${selected.name}`;

      const setupConfig: SetupConfig = {
        name: configName,
        provider: provider?.id || initialConfig?.provider || 'openai-compatible',
        baseUrl: finalBaseUrl,
        apiKey: apiKey,
        model: selected.id,
        ...(selected.contextWindow && { maxContextTokens: selected.contextWindow }),
        ...(selected.maxOutput && { maxOutputTokens: selected.maxOutput }),
      };

      if (mode === 'setup') {
        onComplete(setupConfig);
      } else if (mode === 'add') {
        const newModel = await configActions().addModel(setupConfig);
        await configActions().setCurrentModel(newModel.id);
        onComplete(setupConfig);
      } else if (mode === 'edit' && modelId) {
        await configActions().updateModel(modelId, setupConfig);
        onComplete(setupConfig);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存配置失败');
      setIsSaving(false);
    }
  });

  const handleBack = useMemoizedFn(() => {
    setError(undefined);
    const previousStep = getPreviousWizardStep(step);
    if (previousStep) {
      setStep(previousStep);
    }
  });

  const handleBaseUrlCancel = useMemoizedFn(() => {
    setStep('apiKey');
  });

  const stepNumber =
    step === 'provider' ? 1 : step === 'apiKey' ? 2 : step === 'baseUrl' ? 2.5 : 3;
  const totalSteps = 3;

  const containerProps =
    mode === 'setup'
      ? { flexDirection: 'column' as const, padding: 1 }
      : {
          flexDirection: 'column' as const,
          borderStyle: 'round' as const,
          borderColor: mode === 'edit' ? 'yellow' : 'blue',
          padding: 1,
        };

  return (
    <Box {...containerProps}>
      {mode === 'setup' && (
        <>
          <Box marginBottom={1}>
            <Text bold color="blue">
              欢迎使用 Blade Code
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text>AI 驱动的代码助手 - 让我们开始配置您的助手</Text>
          </Box>
          <Box marginBottom={1}>
            <Text bold color="blue">
              {'█'.repeat(Math.floor(((stepNumber - 1) / (totalSteps - 1)) * 40))}
            </Text>
            <Text dimColor>
              {'░'.repeat(40 - Math.floor(((stepNumber - 1) / (totalSteps - 1)) * 40))}
            </Text>
            <Text> </Text>
            <Text bold color="cyan">
              {Math.ceil(stepNumber)}/{totalSteps}
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text dimColor>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
          </Box>
        </>
      )}

      {mode !== 'setup' && (
        <Box justifyContent="center" marginBottom={1}>
          <Text bold color={mode === 'edit' ? 'yellow' : 'blue'}>
            {mode === 'edit' ? '编辑模型配置' : '添加新模型配置'}
          </Text>
        </Box>
      )}

      {step === 'provider' && (
        <ProviderSelector
          providers={providers}
          isLoading={providersLoading}
          error={providersError}
          onSelect={handleProviderSelect}
          onCancel={
            mode === 'setup'
              ? () => {
                  /* setup 模式第一步不允许取消 */
                }
              : onCancel
          }
        />
      )}

      {step === 'apiKey' && provider && (
        <ApiKeyInput
          provider={provider}
          value={apiKey}
          onChange={setApiKey}
          onSubmit={handleApiKeySubmit}
          onCancel={handleBack}
          error={error}
        />
      )}

      {step === 'baseUrl' && provider && (
        <BaseUrlInput
          provider={provider}
          value={baseUrl}
          onChange={setBaseUrl}
          onSubmit={handleBaseUrlSubmit}
          onCancel={handleBaseUrlCancel}
          error={error}
        />
      )}

      {step === 'model' && provider && (
        <ModelSelector
          provider={provider}
          models={models}
          isLoading={modelsLoading}
          error={modelsError}
          onSelect={handleModelSelect}
          onCancel={handleBack}
          initialModel={isEditMode ? customModel : undefined}
        />
      )}

      {error && step !== 'apiKey' && step !== 'baseUrl' && (
        <Box marginTop={1} borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      {isSaving && (
        <Box marginTop={1}>
          <Text color="yellow">正在保存配置...</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
      </Box>
    </Box>
  );
};

interface BaseUrlInputProps {
  provider: ProviderOption;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  error?: string;
}

export const BaseUrlInput: React.FC<BaseUrlInputProps> = ({
  provider,
  value,
  onChange,
  onSubmit,
  onCancel,
  error,
}) => {
  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="blue">
          Step 2.5: 确认 Base URL
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text>
          Provider: {provider.icon} <Text bold>{provider.name}</Text>
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>
          默认值已预填，可直接回车继续，也可以手动修改为自定义网关地址
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>示例: https://api.example.com/v1</Text>
      </Box>

      <Box>
        <Text bold color="cyan">
          {'> '}
        </Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder="https://api.example.com/v1"
        />
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          输入完成后按 <Text bold>Enter</Text>，<Text bold>Esc</Text> 返回
        </Text>
      </Box>
    </Box>
  );
};

export type { ModelConfigWizardProps } from './types.js';

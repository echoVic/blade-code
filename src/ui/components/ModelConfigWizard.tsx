/**
 * ModelConfigWizard - 模型配置向导（通用组件）
 *
 * 用于两种场景：
 * 1. 首次初始化（mode='setup'）- 全屏显示，带欢迎标题和进度条
 * 2. 添加新模型（mode='add'）- 模态框显示
 *
 * 交互式配置流程:
 * Step 1: 配置名称
 * Step 2: 选择 Provider
 * Step 3: 输入 Base URL
 * Step 4: 输入 API Key (密码输入)
 * Step 5: 输入 Model
 * Step 6: 确认配置
 */

import { Box, Text, useFocus, useFocusManager, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import React, { useEffect, useState } from 'react';
import type { ProviderType, SetupConfig } from '../../config/types.js';
import { configActions } from '../../store/vanilla.js';
import { useCtrlCHandler } from '../hooks/useCtrlCHandler.js';

interface ModelConfigWizardProps {
  mode: 'setup' | 'add' | 'edit'; // edit=编辑已有模型
  initialConfig?: SetupConfig; // 编辑模式下的初始配置
  modelId?: string; // 编辑模式下的目标模型 ID
  onComplete: (config: SetupConfig) => void; // 设置完成回调，传递配置数据
  onCancel: () => void; // 取消回调
}

type WizardStep = 'name' | 'provider' | 'baseUrl' | 'apiKey' | 'model' | 'confirm';

// ========================================
// 步骤组件：Provider 选择
// ========================================
interface ProviderStepProps {
  onSelect: (provider: ProviderType) => void;
  onCancel: () => void;
  initialProvider?: ProviderType;
}

// 自定义 SelectInput 组件 - 高对比度样式
const SelectIndicator: React.FC<{ isSelected?: boolean }> = ({ isSelected }) => (
  <Box marginRight={1}>
    <Text color={isSelected ? 'yellow' : 'gray'}>{isSelected ? '▶' : ' '}</Text>
  </Box>
);

const SelectItem: React.FC<{ isSelected?: boolean; label: string }> = ({
  isSelected,
  label,
}) => (
  <Text bold={isSelected} color={isSelected ? 'yellow' : undefined}>
    {label}
  </Text>
);

const ProviderStep: React.FC<ProviderStepProps> = ({
  onSelect,
  onCancel,
  initialProvider,
}) => {
  const { isFocused } = useFocus({ id: 'provider-step' });

  useInput(
    (_input, key) => {
      if (key.escape) {
        onCancel();
      }
    },
    { isActive: isFocused }
  );

  const items = [
    {
      label: '⚡ OpenAI Compatible - 兼容 OpenAI API 的服务 (千问/豆包/DeepSeek等)',
      value: 'openai-compatible',
    },
    { label: '🤖 Anthropic Claude API - Claude 官方 API', value: 'anthropic' },
  ];

  const initialIndex = initialProvider
    ? Math.max(
        0,
        items.findIndex((item) => item.value === initialProvider)
      )
    : 0;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text bold color="blue">
          📡 Step 2: 选择 API 提供商
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text>根据您使用的 LLM 服务选择对应的 API 类型</Text>
      </Box>
      <Box marginBottom={1}>
        <SelectInput
          items={items}
          onSelect={(item) => onSelect(item.value as ProviderType)}
          indicatorComponent={SelectIndicator}
          itemComponent={SelectItem}
          initialIndex={initialIndex}
        />
      </Box>
    </Box>
  );
};

// ========================================
// 步骤组件：文本输入（Base URL / API Key / Model）
// ========================================
interface TextInputStepProps {
  stepNumber: number;
  icon: string;
  title: string;
  description: string;
  hint?: string;
  examples?: string[];
  value: string;
  placeholder: string;
  mask?: string;
  previousValue?: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

const TextInputStep: React.FC<TextInputStepProps> = ({
  stepNumber,
  icon,
  title,
  description,
  hint,
  examples,
  value,
  placeholder,
  mask,
  previousValue,
  onChange,
  onSubmit,
  onCancel,
}) => {
  // TextInput 步骤需要监听 Esc 键，但不能使用 useFocus（会干扰粘贴功能）
  // 所以使用 useInput 但始终保持 isActive: true
  useInput(
    (_input, key) => {
      if (key.escape) {
        onCancel();
      }
    },
    { isActive: true }
  );

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text bold color="blue">
          {icon} Step {stepNumber}: {title}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text>{description}</Text>
      </Box>
      {previousValue && (
        <Box marginBottom={1}>
          <Text color="green">✓ {previousValue}</Text>
        </Box>
      )}
      {hint && (
        <Box marginBottom={1}>
          <Text dimColor>{hint}</Text>
        </Box>
      )}
      {examples && examples.length > 0 && (
        <>
          <Box marginBottom={1}>
            <Text dimColor>常见示例：</Text>
          </Box>
          <Box marginBottom={1} paddingLeft={2}>
            <Text dimColor>{examples.join('\n')}</Text>
          </Box>
        </>
      )}
      <Box>
        <Text bold color="cyan">
          ▶{' '}
        </Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={placeholder}
          mask={mask}
        />
      </Box>
    </Box>
  );
};

// ========================================
// 步骤组件：确认配置
// ========================================
interface ConfirmStepProps {
  mode: 'setup' | 'add' | 'edit';
  config: SetupConfig;
  isSaving: boolean;
  onConfirm: () => void;
  onBack: () => void;
  onCancel: () => void;
}

const ConfirmStep: React.FC<ConfirmStepProps> = ({
  mode,
  config,
  isSaving,
  onConfirm,
  onBack,
  onCancel,
}) => {
  const { isFocused } = useFocus({ id: 'confirm-step' });

  useInput(
    (input, key) => {
      if (isSaving) return;

      if (input === 'y' || input === 'Y') {
        onConfirm();
      } else if (input === 'n' || input === 'N') {
        onBack();
      } else if (key.escape) {
        onCancel();
      }
    },
    { isActive: isFocused && !isSaving }
  );

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text bold color={mode === 'edit' ? 'yellow' : 'blue'}>
          {mode === 'edit' ? '💾 确认修改' : '✅ Step 6: 确认配置'}
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text>
          {mode === 'edit'
            ? '请确认修改内容，保存后将立即生效。'
            : '请确认以下配置信息：'}
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
        <Box marginBottom={1}>
          <Text dimColor>名称: </Text>
          <Text bold color="cyan">
            {config.name}
          </Text>
        </Box>

        <Box marginBottom={1}>
          <Text dimColor>Provider: </Text>
          <Text bold color="cyan">
            {config.provider === 'openai-compatible'
              ? '⚡ OpenAI Compatible'
              : '🤖 Anthropic'}
          </Text>
        </Box>

        <Box marginBottom={1}>
          <Text dimColor>Base URL: </Text>
          <Text bold color="blue">
            {config.baseUrl}
          </Text>
        </Box>

        <Box marginBottom={1}>
          <Text dimColor>API Key: </Text>
          <Text bold color="yellow">
            {config.apiKey?.slice(0, 8)}
            {'*'.repeat(Math.min(32, (config.apiKey?.length || 0) - 8))}
          </Text>
        </Box>

        <Box>
          <Text dimColor>Model: </Text>
          <Text bold color="cyan">
            {config.model}
          </Text>
        </Box>
      </Box>

      {!isSaving && (
        <Box marginTop={1}>
          <Text>
            {mode === 'edit' ? '保存修改？ ' : '确认保存配置？ '}[
            <Text bold color="green">
              Y
            </Text>
            /
            <Text bold color="red">
              n
            </Text>
            ]
          </Text>
        </Box>
      )}

      {isSaving && (
        <Box>
          <Text color="yellow">⏳ 正在保存配置到 ~/.blade/config.json...</Text>
        </Box>
      )}
    </Box>
  );
};

export const ModelConfigWizard: React.FC<ModelConfigWizardProps> = ({
  mode,
  initialConfig,
  modelId,
  onComplete,
  onCancel,
}) => {
  const isEditMode = mode === 'edit';

  // 当前步骤
  const [currentStep, setCurrentStep] = useState<WizardStep>('name');

  // 配置数据
  const [config, setConfig] = useState<Partial<SetupConfig>>(() =>
    isEditMode && initialConfig ? { ...initialConfig } : {}
  );

  // 输入状态
  const [inputValue, setInputValue] = useState(
    isEditMode && initialConfig ? initialConfig.name : ''
  );
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 使用智能 Ctrl+C 处理（没有任务，所以会直接退出）
  const handleCtrlC = useCtrlCHandler(false);

  // 全局键盘处理 - 在向导中始终监听
  useInput(
    (input, key) => {
      // Ctrl+C 或 Cmd+C: 智能退出
      if ((key.ctrl && input === 'c') || (key.meta && input === 'c')) {
        if (mode === 'setup') {
          // setup 模式：先调用 handleCtrlC 退出
          handleCtrlC();
        } else {
          // add 模式：关闭模态框
          onCancel();
        }
      }
    },
    { isActive: true }
  );

  // 焦点管理：ModelConfigWizard 不需要自己有焦点，只负责管理子步骤的焦点
  const { focus } = useFocusManager();

  // 根据当前步骤切换焦点
  useEffect(() => {
    if (currentStep === 'provider') {
      focus('provider-step');
    } else if (currentStep === 'confirm') {
      focus('confirm-step');
    }
    // name、baseUrl、apiKey、model 步骤不调用 focus()，让 TextInput 自然获得键盘控制权
  }, [currentStep, focus]);

  // ========================================
  // 步骤处理函数
  // ========================================

  const handleNameSubmit = () => {
    if (!inputValue.trim()) {
      setError('配置名称不能为空');
      return;
    }
    setConfig({ ...config, name: inputValue });
    setInputValue('');
    setError(null);
    setCurrentStep('provider');
  };

  const handleProviderSelect = (provider: ProviderType) => {
    setConfig({ ...config, provider });
    const nextBaseUrl = isEditMode
      ? (config.baseUrl ?? initialConfig?.baseUrl ?? '')
      : '';
    setInputValue(nextBaseUrl);
    setCurrentStep('baseUrl');
  };

  const handleBaseUrlSubmit = () => {
    if (!inputValue.trim()) {
      setError('Base URL 不能为空');
      return;
    }

    // 简单的 URL 格式验证
    try {
      new URL(inputValue);
    } catch {
      setError('请输入有效的 URL (例如: https://api.openai.com/v1)');
      return;
    }

    setConfig({ ...config, baseUrl: inputValue });
    const nextApiKey = isEditMode ? (config.apiKey ?? initialConfig?.apiKey ?? '') : '';
    setInputValue(nextApiKey);
    setError(null);
    setCurrentStep('apiKey');
  };

  const handleApiKeySubmit = () => {
    if (!inputValue.trim()) {
      setError('API Key 不能为空');
      return;
    }

    setConfig({ ...config, apiKey: inputValue });
    const nextModel = isEditMode ? (config.model ?? initialConfig?.model ?? '') : '';
    setInputValue(nextModel);
    setError(null);
    setCurrentStep('model');
  };

  const handleModelSubmit = () => {
    if (!inputValue.trim()) {
      setError('Model 不能为空');
      return;
    }

    setConfig({ ...config, model: inputValue });
    setInputValue('');
    setError(null);
    setCurrentStep('confirm');
  };

  const handleConfirm = async () => {
    setIsSaving(true);
    setError(null);

    try {
      const setupConfig: SetupConfig = {
        name: config.name!,
        provider: config.provider!,
        baseUrl: config.baseUrl!,
        apiKey: config.apiKey!,
        model: config.model!,
      };

      if (mode === 'setup') {
        // setup 模式：由父组件（BladeInterface）负责创建模型
        onComplete(setupConfig);
      } else if (mode === 'add') {
        // add 模式：直接在这里创建模型，然后自动切换到新模型
        const newModel = await configActions().addModel(setupConfig);
        await configActions().setCurrentModel(newModel.id);
        onComplete(setupConfig);
      } else {
        if (!modelId) {
          throw new Error('未提供模型 ID，无法编辑');
        }
        await configActions().updateModel(modelId, setupConfig);
        onComplete(setupConfig);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '配置失败');
      setIsSaving(false);
    }
  };

  const handleBack = () => {
    setError(null);
    setInputValue('');

    switch (currentStep) {
      case 'provider':
        setInputValue(config.name || '');
        setCurrentStep('name');
        break;
      case 'baseUrl':
        setCurrentStep('provider');
        break;
      case 'apiKey':
        setInputValue(config.baseUrl || '');
        setCurrentStep('baseUrl');
        break;
      case 'model':
        setCurrentStep('apiKey');
        break;
      case 'confirm':
        setInputValue(config.model || '');
        setCurrentStep('model');
        break;
    }
  };

  // ========================================
  // 渲染
  // ========================================

  // 计算进度
  const stepNumber =
    currentStep === 'name'
      ? 1
      : currentStep === 'provider'
        ? 2
        : currentStep === 'baseUrl'
          ? 3
          : currentStep === 'apiKey'
            ? 4
            : currentStep === 'model'
              ? 5
              : 6;

  const progress = Math.floor(((stepNumber - 1) / 5) * 40);

  // mode='setup': 全屏显示（带欢迎标题和进度条）
  // mode='add': 模态框显示（带边框和简洁标题）
  const containerProps =
    mode === 'setup'
      ? { flexDirection: 'column' as const, padding: 1 }
      : mode === 'add'
        ? {
            flexDirection: 'column' as const,
            borderStyle: 'round' as const,
            borderColor: 'blue',
            padding: 1,
          }
        : {
            flexDirection: 'column' as const,
            borderStyle: 'round' as const,
            borderColor: 'yellow',
            padding: 1,
          };

  return (
    <Box {...containerProps}>
      {/* 标题 - 根据模式显示不同内容 */}
      {mode === 'setup' ? (
        <>
          <Box marginBottom={1}>
            <Text bold color="blue">
              🚀 欢迎使用 Blade Code
            </Text>
          </Box>

          <Box marginBottom={1}>
            <Text>AI 驱动的代码助手 - 让我们开始配置您的助手</Text>
          </Box>

          {/* 进度条 */}
          <Box marginBottom={1}>
            <Text bold color="blue">
              {'█'.repeat(progress)}
            </Text>
            <Text dimColor>{'░'.repeat(40 - progress)}</Text>
            <Text> </Text>
            <Text bold color="cyan">
              {stepNumber}/6
            </Text>
          </Box>

          {/* 分隔线 */}
          <Box marginBottom={1}>
            <Text dimColor>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
          </Box>
        </>
      ) : mode === 'add' ? (
        <>
          {/* 添加模型模式：简洁标题 */}
          <Box justifyContent="center" marginBottom={1}>
            <Text bold color="blue">
              添加新模型配置
            </Text>
          </Box>

          {/* 进度指示 */}
          <Box marginBottom={1}>
            <Text>步骤: {stepNumber}/6</Text>
          </Box>
        </>
      ) : (
        <>
          <Box justifyContent="center" marginBottom={1}>
            <Text bold color="yellow">
              编辑模型配置
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text>步骤: {stepNumber}/6</Text>
          </Box>
        </>
      )}

      {/* Name 输入 */}
      {currentStep === 'name' && (
        <TextInputStep
          stepNumber={1}
          icon="📝"
          title="配置名称"
          description="给这个模型配置起一个易于识别的名称"
          value={inputValue}
          placeholder="例如: 千问工作账号"
          onChange={setInputValue}
          onSubmit={handleNameSubmit}
          onCancel={onCancel}
        />
      )}

      {/* Provider 选择 */}
      {currentStep === 'provider' && (
        <ProviderStep
          onSelect={handleProviderSelect}
          onCancel={onCancel}
          initialProvider={config.provider as ProviderType | undefined}
        />
      )}

      {/* Base URL 输入 */}
      {currentStep === 'baseUrl' && (
        <TextInputStep
          stepNumber={3}
          icon="🌐"
          title="配置 Base URL"
          description="输入您的 API 端点地址（完整的 URL 包含协议）"
          examples={[
            '• OpenAI: https://api.openai.com/v1',
            '• 千问: https://dashscope.aliyuncs.com/compatible-mode/v1',
            '• 豆包: https://ark.cn-beijing.volces.com/api/v3',
            '• DeepSeek: https://api.deepseek.com/v1',
          ]}
          value={inputValue}
          placeholder="https://api.example.com/v1"
          onChange={setInputValue}
          onSubmit={handleBaseUrlSubmit}
          onCancel={onCancel}
        />
      )}

      {/* API Key 输入 */}
      {currentStep === 'apiKey' && (
        <TextInputStep
          stepNumber={4}
          icon="🔑"
          title="输入 API Key"
          description="您的 API 密钥将被安全存储在 ~/.blade/config.json (权限 600)"
          hint="💡 提示: 输入时字符会被隐藏，支持粘贴 (Ctrl+V / Cmd+V)"
          previousValue={
            config.baseUrl ? `✓ 当前 Base URL: ${config.baseUrl}` : undefined
          }
          value={inputValue}
          placeholder="sk-..."
          mask="*"
          onChange={setInputValue}
          onSubmit={handleApiKeySubmit}
          onCancel={onCancel}
        />
      )}

      {/* Model 输入 */}
      {currentStep === 'model' && (
        <TextInputStep
          stepNumber={5}
          icon="🤖"
          title="选择模型"
          description="输入您想使用的模型名称（请参考您的 API 提供商文档）"
          examples={[
            '• OpenAI: gpt-5, gpt-5-mini, gpt-5-nano',
            '• Claude: claude-sonnet-4.5, claude-opus-4.1',
            '• 千问: qwen3-max, qwen3-235b, qwen3-32b',
            '• DeepSeek: deepseek-v3.1, deepseek-r1-0528',
            '• 豆包: doubao-seed-1.6, doubao-seed-1.6-flash',
          ]}
          value={inputValue}
          placeholder="例如: gpt-5"
          onChange={setInputValue}
          onSubmit={handleModelSubmit}
          onCancel={onCancel}
        />
      )}

      {/* 确认配置 */}
      {currentStep === 'confirm' && (
        <ConfirmStep
          mode={mode}
          config={config as SetupConfig}
          isSaving={isSaving}
          onConfirm={handleConfirm}
          onBack={handleBack}
          onCancel={onCancel}
        />
      )}

      {/* 错误信息 */}
      {error && (
        <Box marginTop={1} borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red">❌ {error}</Text>
        </Box>
      )}

      {/* 底部提示 */}
      <Box marginTop={1}>
        <Text dimColor>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
      </Box>

      {!isSaving && currentStep === 'provider' && (
        <Box marginTop={1}>
          <Text dimColor>
            💡 使用 <Text bold>↑/↓</Text> 键选择，<Text bold>Enter</Text> 确认，
            <Text bold>Esc</Text> 取消
          </Text>
        </Box>
      )}
      {!isSaving && currentStep !== 'confirm' && currentStep !== 'provider' && (
        <Box marginTop={1}>
          <Text dimColor>
            💡 输入完成后按 <Text bold>Enter</Text>，<Text bold>Ctrl+C</Text> 退出
          </Text>
        </Box>
      )}
      {!isSaving && currentStep === 'confirm' && (
        <Box marginTop={1}>
          <Text dimColor>
            💡 按{' '}
            <Text bold color="green">
              Y
            </Text>{' '}
            保存，
            <Text bold color="red">
              N
            </Text>{' '}
            返回修改，
            <Text bold>Esc</Text> 取消
          </Text>
        </Box>
      )}
    </Box>
  );
};

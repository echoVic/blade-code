/**
 * ModelConfigWizard - 模型配置向导（通用组件）
 *
 * 用于两种场景：
 * 1. 首次初始化（mode='setup'）- 全屏显示，带欢迎标题和进度条
 * 2. 添加新模型（mode='add'）- 模态框显示
 *
 * 交互式配置流程:
 * Step 1: 选择 Provider（首先选择 API 类型）
 * Step 2: 输入 Base URL（Anthropic/Gemini 预填充官方 URL，可修改用于代理服务）
 * Step 3: 输入 API Key (密码输入)
 * Step 4: 输入 Model
 * Step 5: 配置名称（放最后，因为不是最重要的）
 * Step 6: 确认配置
 */

import { Box, Text, useFocus, useFocusManager, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import React, { useEffect, useState } from 'react';
import type { ProviderType, SetupConfig } from '../../config/types.js';
import { AntigravityAuth } from '../../services/antigravity/AntigravityAuth.js';
import { ANTIGRAVITY_MODELS, GEMINI_CLI_MODELS } from '../../services/antigravity/types.js';
import { CopilotAuth } from '../../services/copilot/CopilotAuth.js';
import { COPILOT_MODELS } from '../../services/copilot/types.js';
import { configActions } from '../../store/vanilla.js';
import { useCtrlCHandler } from '../hooks/useCtrlCHandler.js';

interface ModelConfigWizardProps {
  mode: 'setup' | 'add' | 'edit'; // edit=编辑已有模型
  initialConfig?: SetupConfig; // 编辑模式下的初始配置
  modelId?: string; // 编辑模式下的目标模型 ID
  onComplete: (config: SetupConfig) => void; // 设置完成回调，传递配置数据
  onCancel: () => void; // 取消回调
}

type WizardStep =
  | 'name'
  | 'provider'
  | 'baseUrl'
  | 'apiKey'
  | 'model'
  | 'oauthModelSelect' // OAuth provider 的模型选择（从列表选择）
  | 'oauthLogin' // OAuth 登录提示
  | 'confirm';

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

// ========================================
// Provider 配置（与 ProviderType 关联）
// ========================================

/**
 * Provider 配置信息
 */
interface ProviderInfo {
  icon: string;
  name: string;
  description: string;
  isOAuth: boolean;
}

/**
 * 所有 Provider 的配置（类型安全，与 ProviderType 一一对应）
 */
const PROVIDER_CONFIG: Record<ProviderType, ProviderInfo> = {
  'openai-compatible': {
    icon: '⚡',
    name: 'OpenAI Compatible',
    description: '兼容 OpenAI API 的服务 (千问/豆包/DeepSeek/Ollama等)',
    isOAuth: false,
  },
  anthropic: {
    icon: '🤖',
    name: 'Anthropic Claude',
    description: 'Claude 官方 API',
    isOAuth: false,
  },
  gemini: {
    icon: '✨',
    name: 'Google Gemini',
    description: 'Gemini 官方 API',
    isOAuth: false,
  },
  antigravity: {
    icon: '🚀',
    name: 'Google Antigravity',
    description: 'OAuth 登录使用 Claude/Gemini (需 Code Assist 订阅)',
    isOAuth: true,
  },
  copilot: {
    icon: '🐙',
    name: 'GitHub Copilot',
    description: 'OAuth 登录使用 GPT/Claude/Gemini (需 Copilot 订阅)',
    isOAuth: true,
  },
  'azure-openai': {
    icon: '☁️',
    name: 'Azure OpenAI',
    description: '微软 Azure OpenAI 服务',
    isOAuth: false,
  },
};

/**
 * 获取 Provider 显示名称
 */
function getProviderDisplayName(provider: ProviderType): string {
  const info = PROVIDER_CONFIG[provider];
  return `${info.icon} ${info.name}`;
}

/**
 * 获取 Provider 的默认 Base URL
 * 返回 null 表示必须由用户手动输入
 */
function getDefaultBaseUrl(provider: ProviderType): string | null {
  switch (provider) {
    case 'anthropic':
      return 'https://api.anthropic.com';
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta';
    case 'antigravity':
      return 'https://cloudcode-pa.googleapis.com'; // Antigravity 固定端点
    case 'copilot':
      return 'https://api.githubcopilot.com'; // Copilot 固定端点
    default:
      return null; // 其他 Provider 需要用户手动输入
  }
}

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

  // 从 PROVIDER_CONFIG 生成 items（类型安全）
  const items = (Object.keys(PROVIDER_CONFIG) as ProviderType[]).map((provider) => {
    const info = PROVIDER_CONFIG[provider];
    return {
      label: `${info.icon} ${info.name} - ${info.description}`,
      value: provider,
    };
  });

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
          📡 Step 1: 选择 API 提供商
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
  stepNumber: number;
  onConfirm: () => void;
  onBack: () => void;
  onCancel: () => void;
}

// ========================================
// 步骤组件：OAuth 登录提示
// ========================================
interface OAuthLoginStepProps {
  provider: 'antigravity' | 'copilot';
  onLogin: () => void;
  onCancel: () => void;
  isLoggingIn: boolean;
}

const OAuthLoginStep: React.FC<OAuthLoginStepProps> = ({
  provider,
  onLogin,
  onCancel,
  isLoggingIn,
}) => {
  const { isFocused } = useFocus({ id: 'oauth-login-step' });

  useInput(
    (input, key) => {
      if (isLoggingIn) return;

      if (input === 'y' || input === 'Y') {
        onLogin();
      } else if (input === 'n' || input === 'N' || key.escape) {
        onCancel();
      }
    },
    { isActive: isFocused && !isLoggingIn }
  );

  const providerInfo =
    provider === 'antigravity'
      ? {
          name: 'Google Antigravity',
          icon: '🚀',
          loginCommand: '/login',
          description: '通过 Google OAuth 登录，使用 Claude/Gemini 模型',
        }
      : {
          name: 'GitHub Copilot',
          icon: '🐙',
          loginCommand: '/login copilot',
          description: '通过 GitHub Device Flow 登录，使用 GPT/Claude/Gemini 模型',
        };

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text bold color="yellow">
          {providerInfo.icon} 需要登录 {providerInfo.name}
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text>{providerInfo.description}</Text>
      </Box>

      <Box marginBottom={1} paddingLeft={2}>
        <Text dimColor>
          您也可以稍后手动执行 <Text bold>{providerInfo.loginCommand}</Text> 命令登录
        </Text>
      </Box>

      {!isLoggingIn && (
        <Box marginTop={1}>
          <Text>
            现在登录？ [
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

      {isLoggingIn && (
        <Box marginTop={1}>
          <Text color="yellow">⏳ 正在启动登录流程...</Text>
        </Box>
      )}
    </Box>
  );
};

// ========================================
// 步骤组件：OAuth 模型选择
// ========================================
interface OAuthModelSelectStepProps {
  provider: 'antigravity' | 'copilot';
  onSelect: (modelId: string) => void;
  onCancel: () => void;
}

const OAuthModelSelectStep: React.FC<OAuthModelSelectStepProps> = ({
  provider,
  onSelect,
  onCancel,
}) => {
  const { isFocused } = useFocus({ id: 'oauth-model-step' });
  const [models, setModels] = useState<
    Array<{ id: string; name: string; description: string }>
  >([]);
  const [isLoading, setIsLoading] = useState(true);

  // 初始化时获取模型列表
  useEffect(() => {
    const loadModels = async () => {
      setIsLoading(true);
      try {
        if (provider === 'copilot') {
          // Copilot 始终使用 COPILOT_MODELS
          setModels(Object.values(COPILOT_MODELS));
        } else {
          // Antigravity: 根据 OAuth 配置类型获取模型列表
          const auth = AntigravityAuth.getInstance();
          const configType = await auth.getConfigType();

          if (configType === 'gemini-cli') {
            // Gemini CLI OAuth: 使用 Gemini 2.5 系列模型
            setModels(Object.values(GEMINI_CLI_MODELS));
          } else {
            // Antigravity IDE OAuth: 使用完整的 Antigravity 模型列表
            setModels(Object.values(ANTIGRAVITY_MODELS));
          }
        }
      } catch {
        // 出错时使用默认的 Antigravity 模型
        setModels(Object.values(ANTIGRAVITY_MODELS));
      } finally {
        setIsLoading(false);
      }
    };

    loadModels();
  }, [provider]);

  useInput(
    (_input, key) => {
      if (key.escape) {
        onCancel();
      }
    },
    { isActive: isFocused }
  );

  const items = models.map((model) => ({
    label: `${model.name} - ${model.description}`,
    value: model.id,
  }));

  const providerName = provider === 'antigravity' ? 'Antigravity' : 'Copilot';

  if (isLoading) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box marginBottom={1}>
          <Text bold color="blue">
            🤖 加载 {providerName} 模型列表...
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text bold color="blue">
          🤖 选择 {providerName} 模型
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text>从可用模型列表中选择一个</Text>
      </Box>
      <Box marginBottom={1}>
        <SelectInput
          items={items}
          onSelect={(item) => onSelect(item.value)}
          indicatorComponent={SelectIndicator}
          itemComponent={SelectItem}
        />
      </Box>
    </Box>
  );
};

// ========================================
// 步骤组件：确认配置
// ========================================
const ConfirmStep: React.FC<ConfirmStepProps> = ({
  mode,
  config,
  isSaving,
  stepNumber,
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
          {mode === 'edit' ? '💾 确认修改' : `✅ Step ${stepNumber}: 确认配置`}
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
            {getProviderDisplayName(config.provider)}
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
            {config.apiKey === 'oauth' ? (
              '🔐 OAuth 认证（使用 /login 登录）'
            ) : (
              <>
                {config.apiKey?.slice(0, 8)}
                {'*'.repeat(Math.min(32, (config.apiKey?.length || 0) - 8))}
              </>
            )}
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

  // 当前步骤 - 从 provider 开始（name 放在最后）
  const [currentStep, setCurrentStep] = useState<WizardStep>('provider');

  // 配置数据
  const [config, setConfig] = useState<Partial<SetupConfig>>(() =>
    isEditMode && initialConfig ? { ...initialConfig } : {}
  );

  // 输入状态 - 初始为空（provider 步骤不需要 inputValue）
  const [inputValue, setInputValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
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
    } else if (currentStep === 'oauthLogin') {
      focus('oauth-login-step');
    } else if (currentStep === 'oauthModelSelect') {
      focus('oauth-model-step');
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
    setCurrentStep('confirm'); // Name 后跳转到确认（Step 6）
  };

  const handleProviderSelect = async (provider: ProviderType) => {
    setConfig({ ...config, provider });

    // OAuth 提供商：检查登录状态，直接进入模型选择
    if (isOAuthProvider(provider)) {
      const auth =
        provider === 'antigravity'
          ? AntigravityAuth.getInstance()
          : CopilotAuth.getInstance();

      try {
        const isLoggedIn = await auth.isLoggedIn();
        if (isLoggedIn) {
          // 已登录，直接进入模型选择
          setCurrentStep('oauthModelSelect');
        } else {
          // 未登录，提示登录
          setCurrentStep('oauthLogin');
        }
      } catch {
        // 检查登录状态失败，提示登录
        setCurrentStep('oauthLogin');
      }
      return;
    }

    // 非 OAuth 提供商：走原来的流程
    // 编辑模式：使用已有配置
    // 新建模式：预填充默认 URL（如有），用户可修改或直接回车
    const defaultUrl = getDefaultBaseUrl(provider);
    const nextBaseUrl = isEditMode
      ? (config.baseUrl ?? initialConfig?.baseUrl ?? '')
      : (defaultUrl ?? '');

    setInputValue(nextBaseUrl);
    setCurrentStep('baseUrl');
  };

  /**
   * 检查 Provider 是否使用 OAuth（不需要 API Key）
   */
  const isOAuthProvider = (provider: ProviderType): provider is 'antigravity' | 'copilot' => {
    return PROVIDER_CONFIG[provider].isOAuth;
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
    setError(null);

    // Antigravity 使用 OAuth，跳过 API Key 步骤
    if (isOAuthProvider(config.provider!)) {
      // 设置特殊的 API Key 标记
      setConfig((prev) => ({ ...prev, baseUrl: inputValue, apiKey: 'oauth' }));
      const nextModel = isEditMode ? (config.model ?? initialConfig?.model ?? '') : '';
      setInputValue(nextModel);
      setCurrentStep('model');
    } else {
      const nextApiKey = isEditMode ? (config.apiKey ?? initialConfig?.apiKey ?? '') : '';
      setInputValue(nextApiKey);
      setCurrentStep('apiKey');
    }
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
    // 编辑模式：预填充已有的名称
    const nextName = isEditMode ? (config.name ?? initialConfig?.name ?? '') : '';
    setInputValue(nextName);
    setError(null);
    setCurrentStep('name'); // Model 后跳转到 Name（Step 5）
  };

  /**
   * OAuth 登录处理
   */
  const handleOAuthLogin = async () => {
    const provider = config.provider as 'antigravity' | 'copilot';
    const auth =
      provider === 'antigravity'
        ? AntigravityAuth.getInstance()
        : CopilotAuth.getInstance();

    setIsLoggingIn(true);
    setError(null);

    try {
      await auth.login();
      // 登录成功，进入模型选择
      setCurrentStep('oauthModelSelect');
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setIsLoggingIn(false);
    }
  };

  /**
   * OAuth 模型选择处理
   */
  const handleOAuthModelSelect = (modelId: string) => {
    const provider = config.provider as 'antigravity' | 'copilot';
    const baseUrl = getDefaultBaseUrl(provider) || '';

    // 设置完整配置
    setConfig({
      ...config,
      baseUrl,
      apiKey: 'oauth',
      model: modelId,
    });

    // 跳转到名称输入（OAuth 流程简化，跳过 baseUrl/apiKey/model 输入步骤）
    setInputValue('');
    setCurrentStep('name');
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

    // 步骤顺序：
    // 普通流程：provider → baseUrl → apiKey → model → name → confirm
    // OAuth 流程：provider → oauthLogin/oauthModelSelect → name → confirm
    switch (currentStep) {
      case 'provider':
        // provider 是第一步，返回时取消
        onCancel();
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
      case 'oauthLogin':
        setCurrentStep('provider');
        break;
      case 'oauthModelSelect':
        setCurrentStep('provider');
        break;
      case 'name':
        // OAuth 流程：返回到模型选择
        if (isOAuthProvider(config.provider!)) {
          setCurrentStep('oauthModelSelect');
        } else {
          setInputValue(config.model || '');
          setCurrentStep('model');
        }
        break;
      case 'confirm':
        setInputValue(config.name || '');
        setCurrentStep('name');
        break;
    }
  };

  // ========================================
  // 渲染
  // ========================================

  // 计算进度
  // 普通流程：provider(1) → baseUrl(2) → apiKey(3) → model(4) → name(5) → confirm(6)
  // OAuth 流程：provider(1) → oauthLogin/oauthModelSelect(2) → name(3) → confirm(4)
  const isOAuth = config.provider && isOAuthProvider(config.provider);
  const totalSteps = isOAuth ? 4 : 6;
  const stepNumber = (() => {
    if (currentStep === 'provider') return 1;
    if (isOAuth) {
      if (currentStep === 'oauthLogin' || currentStep === 'oauthModelSelect') return 2;
      if (currentStep === 'name') return 3;
      return 4; // confirm
    }
    // 普通流程
    if (currentStep === 'baseUrl') return 2;
    if (currentStep === 'apiKey') return 3;
    if (currentStep === 'model') return 4;
    if (currentStep === 'name') return 5;
    return 6; // confirm
  })();

  const progress = Math.floor(((stepNumber - 1) / (totalSteps - 1)) * 40);

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
              {stepNumber}/{totalSteps}
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
            <Text>
              步骤: {stepNumber}/{totalSteps}
            </Text>
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
            <Text>
              步骤: {stepNumber}/{totalSteps}
            </Text>
          </Box>
        </>
      )}

      {/* Name 输入 - Step 5 */}
      {currentStep === 'name' && (
        <TextInputStep
          stepNumber={5}
          icon="📝"
          title="配置名称"
          description="给这个模型配置起一个易于识别的名称（可选，用于区分多个配置）"
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

      {/* OAuth 登录提示 */}
      {currentStep === 'oauthLogin' && config.provider && isOAuthProvider(config.provider) && (
        <OAuthLoginStep
          provider={config.provider}
          onLogin={handleOAuthLogin}
          onCancel={onCancel}
          isLoggingIn={isLoggingIn}
        />
      )}

      {/* OAuth 模型选择 */}
      {currentStep === 'oauthModelSelect' &&
        config.provider &&
        isOAuthProvider(config.provider) && (
          <OAuthModelSelectStep
            provider={config.provider}
            onSelect={handleOAuthModelSelect}
            onCancel={onCancel}
          />
        )}

      {/* Base URL 输入 - Step 2 */}
      {currentStep === 'baseUrl' && (
        <TextInputStep
          stepNumber={2}
          icon="🌐"
          title="配置 Base URL"
          description="输入您的 API 端点地址（完整的 URL 包含协议）"
          hint={
            config.provider && getDefaultBaseUrl(config.provider)
              ? '💡 已预填充官方 URL，直接回车使用。如需代理服务（如 OpenRouter），请修改。'
              : undefined
          }
          examples={[
            '• OpenAI: https://api.openai.com/v1',
            '• Anthropic: https://api.anthropic.com',
            '• Gemini: https://generativelanguage.googleapis.com/v1beta',
            '• Azure: https://{resource}.openai.azure.com',
            '• 代理: https://openrouter.ai/api/v1',
          ]}
          value={inputValue}
          placeholder="https://api.example.com/v1"
          onChange={setInputValue}
          onSubmit={handleBaseUrlSubmit}
          onCancel={onCancel}
        />
      )}

      {/* API Key 输入 - Step 3 */}
      {currentStep === 'apiKey' && (
        <TextInputStep
          stepNumber={3}
          icon="🔑"
          title="输入 API Key"
          description="您的 API 密钥将被安全存储在 ~/.blade/config.json (权限 600)"
          hint="💡 提示: 输入时字符会被隐藏，支持粘贴 (Ctrl+V / Cmd+V)"
          previousValue={config.baseUrl ? `✓ Base URL: ${config.baseUrl}` : undefined}
          value={inputValue}
          placeholder="sk-..."
          mask="*"
          onChange={setInputValue}
          onSubmit={handleApiKeySubmit}
          onCancel={onCancel}
        />
      )}

      {/* Model 输入 - Step 4 */}
      {currentStep === 'model' && (
        <TextInputStep
          stepNumber={4}
          icon="🤖"
          title="选择模型"
          description="输入您想使用的模型名称（请参考您的 API 提供商文档）"
          examples={
            config.provider === 'antigravity'
              ? [
                  '• Claude: claude-sonnet-4-5, claude-opus-4-5-thinking',
                  '• Gemini: gemini-3-pro-high, gemini-3-pro-low',
                  '• GPT-OSS: gpt-oss-120b-medium',
                ]
              : [
                  '• OpenAI: gpt-4o, gpt-4o-mini, o1-preview',
                  '• Claude: claude-sonnet-4-20250514, claude-opus-4-20250514',
                  '• Gemini: gemini-2.5-pro, gemini-2.5-flash',
                  '• Azure: {deployment-name}',
                  '• 千问: qwen3-max, qwen3-235b, qwen3-32b',
                  '• DeepSeek: deepseek-v3.1, deepseek-r1-0528',
                ]
          }
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
          stepNumber={totalSteps}
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

      {!isSaving && !isLoggingIn && currentStep === 'provider' && (
        <Box marginTop={1}>
          <Text dimColor>
            💡 使用 <Text bold>↑/↓</Text> 键选择，<Text bold>Enter</Text> 确认，
            <Text bold>Esc</Text> 取消
          </Text>
        </Box>
      )}
      {!isSaving && !isLoggingIn && currentStep === 'oauthModelSelect' && (
        <Box marginTop={1}>
          <Text dimColor>
            💡 使用 <Text bold>↑/↓</Text> 键选择模型，<Text bold>Enter</Text> 确认，
            <Text bold>Esc</Text> 返回
          </Text>
        </Box>
      )}
      {!isSaving && !isLoggingIn && currentStep === 'oauthLogin' && (
        <Box marginTop={1}>
          <Text dimColor>
            💡 按{' '}
            <Text bold color="green">
              Y
            </Text>{' '}
            登录，
            <Text bold color="red">
              N
            </Text>{' '}
            返回，
            <Text bold>Esc</Text> 取消
          </Text>
        </Box>
      )}
      {!isSaving &&
        !isLoggingIn &&
        currentStep !== 'confirm' &&
        currentStep !== 'provider' &&
        currentStep !== 'oauthLogin' &&
        currentStep !== 'oauthModelSelect' && (
          <Box marginTop={1}>
            <Text dimColor>
              💡 输入完成后按 <Text bold>Enter</Text>，<Text bold>Ctrl+C</Text> 退出
            </Text>
          </Box>
        )}
      {!isSaving && !isLoggingIn && currentStep === 'confirm' && (
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

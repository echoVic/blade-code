/**
 * SetupWizard - 首次设置向导
 *
 * 交互式配置流程:
 * Step 1: 选择 Provider
 * Step 2: 输入 Base URL
 * Step 3: 输入 API Key (密码输入)
 * Step 4: 输入 Model
 * Step 5: 确认配置
 */

import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import React, { useState } from 'react';
import { ConfigManager } from '../../config/ConfigManager.js';
import type { ProviderType } from '../../config/types.js';
import { themeManager } from '../themes/ThemeManager.js';

interface SetupWizardProps {
  onComplete: () => void; // 设置完成回调
  onCancel: () => void; // 取消回调
}

type SetupStep = 'provider' | 'baseUrl' | 'apiKey' | 'model' | 'confirm';

interface SetupConfig {
  provider: ProviderType;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const SetupWizard: React.FC<SetupWizardProps> = ({ onComplete, onCancel }) => {
  const theme = themeManager.getTheme();

  // 当前步骤
  const [currentStep, setCurrentStep] = useState<SetupStep>('provider');

  // 配置数据
  const [config, setConfig] = useState<Partial<SetupConfig>>({});

  // 输入状态
  const [inputValue, setInputValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ========================================
  // 步骤处理函数
  // ========================================

  const handleProviderSelect = (item: { value: string }) => {
    const provider = item.value as ProviderType;
    setConfig({ ...config, provider });
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
    setInputValue('');
    setError(null);
    setCurrentStep('apiKey');
  };

  const handleApiKeySubmit = () => {
    if (!inputValue.trim()) {
      setError('API Key 不能为空');
      return;
    }

    setConfig({ ...config, apiKey: inputValue });
    setInputValue('');
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
      const configManager = ConfigManager.getInstance();

      // 保存配置到 ~/.blade/config.json
      await configManager.saveUserConfig({
        provider: config.provider!,
        baseUrl: config.baseUrl!,
        apiKey: config.apiKey!,
        model: config.model!,
      });

      // 完成回调
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存配置失败');
      setIsSaving(false);
    }
  };

  const handleBack = () => {
    setError(null);
    setInputValue('');

    switch (currentStep) {
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

  // 确认步骤的键盘处理
  useInput(
    (input, key) => {
      if (currentStep !== 'confirm' || isSaving) return;

      if (input === 'y' || input === 'Y') {
        handleConfirm();
      } else if (input === 'n' || input === 'N') {
        handleBack();
      } else if (key.escape) {
        onCancel();
      }
    },
    { isActive: currentStep === 'confirm' && !isSaving }
  );

  // ESC 退出 (仅在 provider 选择步骤启用，避免与 TextInput 冲突)
  useInput(
    (_input, key) => {
      if (key.escape) {
        onCancel();
      }
    },
    { isActive: currentStep === 'provider' && !isSaving }
  );

  // ========================================
  // 渲染
  // ========================================

  // 计算进度
  const stepNumber =
    currentStep === 'provider' ? 1 :
    currentStep === 'baseUrl' ? 2 :
    currentStep === 'apiKey' ? 3 :
    currentStep === 'model' ? 4 : 5;

  const progress = Math.floor((stepNumber - 1) / 4 * 40);

  return (
    <Box flexDirection="column" padding={1}>
      {/* 欢迎标题 */}
      <Box marginBottom={1}>
        <Text bold color={theme.colors.primary}>
          🚀 欢迎使用 Blade Code
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text color={theme.colors.text.secondary}>
          AI 驱动的代码助手 - 让我们开始配置您的助手
        </Text>
      </Box>

      {/* 进度条 */}
      <Box marginBottom={1}>
        <Text color={theme.colors.success}>
          {'█'.repeat(progress)}
        </Text>
        <Text color={theme.colors.text.muted}>
          {'░'.repeat(40 - progress)}
        </Text>
        <Text> </Text>
        <Text bold color={theme.colors.info}>
          {stepNumber}/5
        </Text>
      </Box>

      {/* 分隔线 */}
      <Box marginBottom={1}>
        <Text color={theme.colors.text.muted}>
          ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        </Text>
      </Box>

      {/* Provider 选择 */}
      {currentStep === 'provider' && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}>
            <Text bold color={theme.colors.info}>
              📡 Step 1: 选择 API 提供商
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text color={theme.colors.text.secondary}>
              根据您使用的 LLM 服务选择对应的 API 类型
            </Text>
          </Box>
          <Box marginBottom={1}>
            <SelectInput
              items={[
                { label: '🔵 OpenAI Compatible - 兼容 OpenAI API 的服务 (千问/豆包/DeepSeek等)', value: 'openai-compatible' },
                { label: '🟣 Anthropic Claude API - Claude 官方 API', value: 'anthropic' },
              ]}
              onSelect={handleProviderSelect}
            />
          </Box>
        </Box>
      )}

      {/* Base URL 输入 */}
      {currentStep === 'baseUrl' && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}>
            <Text bold color={theme.colors.info}>
              🌐 Step 2: 配置 Base URL
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text color={theme.colors.text.secondary}>
              输入您的 API 端点地址（完整的 URL 包含协议）
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text color={theme.colors.text.muted}>
              常见示例：
            </Text>
          </Box>
          <Box marginBottom={1} paddingLeft={2}>
            <Text color={theme.colors.text.muted}>
              • OpenAI: https://api.openai.com/v1{'\n'}
              • 千问: https://dashscope.aliyuncs.com/compatible-mode/v1{'\n'}
              • 豆包: https://ark.cn-beijing.volces.com/api/v3{'\n'}
              • DeepSeek: https://api.deepseek.com/v1
            </Text>
          </Box>
          <Box>
            <Text color={theme.colors.primary}>▶ </Text>
            <TextInput
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleBaseUrlSubmit}
              placeholder="https://api.example.com/v1"
            />
          </Box>
        </Box>
      )}

      {/* API Key 输入 */}
      {currentStep === 'apiKey' && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}>
            <Text bold color={theme.colors.info}>
              🔑 Step 3: 输入 API Key
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text color={theme.colors.text.secondary}>
              您的 API 密钥将被安全存储在 ~/.blade/config.json (权限 600)
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text color={theme.colors.success}>
              ✓ 当前 Base URL: {config.baseUrl}
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text color={theme.colors.text.muted}>
              💡 提示: 输入时字符会被隐藏，支持粘贴 (Ctrl+V / Cmd+V)
            </Text>
          </Box>
          <Box>
            <Text color={theme.colors.primary}>▶ </Text>
            <TextInput
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleApiKeySubmit}
              placeholder="sk-..."
              mask="*"
            />
          </Box>
        </Box>
      )}

      {/* Model 输入 */}
      {currentStep === 'model' && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}>
            <Text bold color={theme.colors.info}>
              🤖 Step 4: 选择模型
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text color={theme.colors.text.secondary}>
              输入您想使用的模型名称（请参考您的 API 提供商文档）
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text color={theme.colors.text.muted}>
              常见模型示例：
            </Text>
          </Box>
          <Box marginBottom={1} paddingLeft={2}>
            <Text color={theme.colors.text.muted}>
              • OpenAI: gpt-4, gpt-4-turbo, gpt-3.5-turbo{'\n'}
              • Claude: claude-3-5-sonnet-20241022, claude-3-opus{'\n'}
              • 千问: qwen-max, qwen-plus, qwen-turbo{'\n'}
              • DeepSeek: deepseek-chat, deepseek-coder
            </Text>
          </Box>
          <Box>
            <Text color={theme.colors.primary}>▶ </Text>
            <TextInput
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleModelSubmit}
              placeholder="例如: gpt-4"
            />
          </Box>
        </Box>
      )}

      {/* 确认配置 */}
      {currentStep === 'confirm' && (
        <Box flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}>
            <Text bold color={theme.colors.success}>
              ✅ Step 5: 确认配置
            </Text>
          </Box>

          <Box marginBottom={1}>
            <Text color={theme.colors.text.secondary}>
              请确认以下配置信息：
            </Text>
          </Box>

          <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
            <Box marginBottom={1}>
              <Text color={theme.colors.text.muted}>Provider: </Text>
              <Text bold color={theme.colors.info}>
                {config.provider === 'openai-compatible' ? '🔵 OpenAI Compatible' : '🟣 Anthropic'}
              </Text>
            </Box>

            <Box marginBottom={1}>
              <Text color={theme.colors.text.muted}>Base URL: </Text>
              <Text bold color={theme.colors.success}>
                {config.baseUrl}
              </Text>
            </Box>

            <Box marginBottom={1}>
              <Text color={theme.colors.text.muted}>API Key: </Text>
              <Text bold color={theme.colors.warning}>
                {config.apiKey?.slice(0, 8)}{'*'.repeat(Math.min(32, (config.apiKey?.length || 0) - 8))}
              </Text>
            </Box>

            <Box>
              <Text color={theme.colors.text.muted}>Model: </Text>
              <Text bold color={theme.colors.info}>
                {config.model}
              </Text>
            </Box>
          </Box>

          {!isSaving && (
            <Box marginTop={1}>
              <Text color={theme.colors.primary}>
                确认保存配置？ [<Text bold color={theme.colors.success}>Y</Text>/
                <Text bold color={theme.colors.error}>n</Text>]
              </Text>
            </Box>
          )}

          {isSaving && (
            <Box>
              <Text color={theme.colors.warning}>⏳ 正在保存配置到 ~/.blade/config.json...</Text>
            </Box>
          )}
        </Box>
      )}

      {/* 错误信息 */}
      {error && (
        <Box marginTop={1} borderStyle="round" borderColor="red" paddingX={1}>
          <Text color={theme.colors.error}>❌ {error}</Text>
        </Box>
      )}

      {/* 底部提示 */}
      <Box marginTop={1}>
        <Text color={theme.colors.text.muted}>
          ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        </Text>
      </Box>

      {!isSaving && currentStep === 'provider' && (
        <Box marginTop={1}>
          <Text color={theme.colors.text.muted}>
            💡 使用 <Text bold>↑/↓</Text> 键选择，<Text bold>Enter</Text> 确认，<Text bold>Esc</Text> 取消
          </Text>
        </Box>
      )}
      {!isSaving && currentStep !== 'confirm' && currentStep !== 'provider' && (
        <Box marginTop={1}>
          <Text color={theme.colors.text.muted}>
            💡 输入完成后按 <Text bold>Enter</Text>，<Text bold>Ctrl+C</Text> 退出
          </Text>
        </Box>
      )}
      {!isSaving && currentStep === 'confirm' && (
        <Box marginTop={1}>
          <Text color={theme.colors.text.muted}>
            💡 按 <Text bold color={theme.colors.success}>Y</Text> 保存，
            <Text bold color={theme.colors.error}>N</Text> 返回修改，
            <Text bold>Esc</Text> 取消
          </Text>
        </Box>
      )}
    </Box>
  );
};

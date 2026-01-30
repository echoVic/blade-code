/**
 * OAuthFlow - OAuth 登录流程组件
 * 支持 Antigravity 和 GitHub Copilot
 */

import { Box, Text, useFocus, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import React, { useEffect, useState } from 'react';
import { AntigravityAuth } from '../../../services/antigravity/AntigravityAuth.js';
import {
  ANTIGRAVITY_MODELS,
  GEMINI_CLI_MODELS,
} from '../../../services/antigravity/types.js';
import { CopilotAuth } from '../../../services/copilot/CopilotAuth.js';
import { COPILOT_MODELS } from '../../../services/copilot/types.js';
import type { ModelOption, ProviderOption } from './types.js';

interface OAuthLoginProps {
  provider: ProviderOption;
  onLogin: () => void;
  onCancel: () => void;
  isLoggingIn: boolean;
}

export const OAuthLogin: React.FC<OAuthLoginProps> = ({
  provider,
  onLogin,
  onCancel,
  isLoggingIn,
}) => {
  const { isFocused } = useFocus({ id: 'oauth-login' });

  useInput(
    (input, key) => {
      if (isLoggingIn) return;
      if (input === 'y' || input === 'Y') onLogin();
      else if (input === 'n' || input === 'N' || key.escape) onCancel();
    },
    { isActive: isFocused && !isLoggingIn }
  );

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="yellow">
          {provider.icon} 需要登录 {provider.name}
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text>{provider.description}</Text>
      </Box>

      <Box marginBottom={1} paddingLeft={2}>
        <Text dimColor>
          您也可以稍后手动执行{' '}
          <Text bold>
            {provider.id === 'antigravity' ? '/login' : '/login copilot'}
          </Text>{' '}
          命令登录
        </Text>
      </Box>

      {!isLoggingIn && (
        <Box marginTop={1}>
          <Text>
            现在登录？ [
            <Text bold color="green">Y</Text>/
            <Text bold color="red">n</Text>]
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

interface OAuthModelSelectProps {
  provider: ProviderOption;
  onSelect: (model: ModelOption) => void;
  onCancel: () => void;
}

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

export const OAuthModelSelect: React.FC<OAuthModelSelectProps> = ({
  provider,
  onSelect,
  onCancel,
}) => {
  const { isFocused } = useFocus({ id: 'oauth-model-select' });
  const [models, setModels] = useState<Array<{ id: string; name: string; description: string }>>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadModels = async () => {
      setIsLoading(true);
      try {
        if (provider.id === 'copilot') {
          setModels(Object.values(COPILOT_MODELS));
        } else {
          const auth = AntigravityAuth.getInstance();
          const configType = await auth.getConfigType();
          setModels(
            configType === 'gemini-cli'
              ? Object.values(GEMINI_CLI_MODELS)
              : Object.values(ANTIGRAVITY_MODELS)
          );
        }
      } catch {
        setModels(Object.values(ANTIGRAVITY_MODELS));
      } finally {
        setIsLoading(false);
      }
    };
    loadModels();
  }, [provider.id]);

  useInput(
    (_input, key) => {
      if (key.escape) onCancel();
    },
    { isActive: isFocused }
  );

  const items = models.map((m) => ({
    key: m.id,
    label: `${m.name} - ${m.description}`,
    value: { id: m.id, name: m.name },
  }));

  if (isLoading) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">⏳ 加载 {provider.name} 模型列表...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="blue">
          🤖 选择 {provider.name} 模型
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>从可用模型列表中选择一个</Text>
      </Box>

      <Box flexDirection="column" height={12}>
        <SelectInput
          items={items}
          onSelect={(item) => onSelect(item.value)}
          indicatorComponent={SelectIndicator}
          itemComponent={SelectItem}
          limit={10}
        />
      </Box>
    </Box>
  );
};

export const performOAuthLogin = async (
  providerId: string
): Promise<boolean> => {
  const auth =
    providerId === 'antigravity'
      ? AntigravityAuth.getInstance()
      : CopilotAuth.getInstance();

  try {
    await auth.login();
    return true;
  } catch {
    return false;
  }
};

export const checkOAuthStatus = async (providerId: string): Promise<boolean> => {
  const auth =
    providerId === 'antigravity'
      ? AntigravityAuth.getInstance()
      : CopilotAuth.getInstance();

  try {
    return await auth.isLoggedIn();
  } catch {
    return false;
  }
};

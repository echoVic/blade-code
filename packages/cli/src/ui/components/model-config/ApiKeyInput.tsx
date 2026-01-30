/**
 * ApiKeyInput - API Key 输入组件
 * Step 2: 输入 API Key
 */

import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import React from 'react';
import type { ProviderOption } from './types.js';

interface ApiKeyInputProps {
  provider: ProviderOption;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  error?: string;
}

export const ApiKeyInput: React.FC<ApiKeyInputProps> = ({
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

  const envHint = provider.envVars.length > 0 ? provider.envVars[0] : null;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="blue">
          🔑 Step 2: 输入 API Key
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text>
          Provider: {provider.icon} <Text bold>{provider.name}</Text>
        </Text>
      </Box>

      {envHint && (
        <Box marginBottom={1}>
          <Text dimColor>
            💡 环境变量: <Text color="cyan">{envHint}</Text>
          </Text>
        </Box>
      )}

      {provider.docUrl && (
        <Box marginBottom={1}>
          <Text dimColor>
            📖 文档: <Text color="blue">{provider.docUrl}</Text>
          </Text>
        </Box>
      )}

      <Box marginBottom={1}>
        <Text dimColor>您的 API 密钥将被安全存储在 ~/.blade/config.json (权限 600)</Text>
      </Box>

      <Box>
        <Text bold color="cyan">
          ▶{' '}
        </Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder="sk-..."
          mask="*"
        />
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="red">❌ {error}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          💡 输入完成后按 <Text bold>Enter</Text>，<Text bold>Esc</Text> 返回
        </Text>
      </Box>
    </Box>
  );
};

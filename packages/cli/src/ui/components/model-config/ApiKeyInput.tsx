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

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="blue">
          Step 2: 输入 API Key
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text>
          Provider: <Text bold>{provider.name}</Text>
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>
          API 密钥将存储在 ~/.blade/auth.json（权限 600），不会写入模型配置
        </Text>
      </Box>

      <Box>
        <Text bold color="cyan">
          {'>'}{' '}
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

/**
 * ProviderSelector - Provider 选择组件
 * Step 1: 从 80+ Provider 中选择
 * 直接输入即可搜索，类似 fzf
 */

import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import React, { useMemo, useState } from 'react';
import type { ProviderOption } from './types.js';

interface ProviderSelectorProps {
  providers: ProviderOption[];
  isLoading: boolean;
  error: string | null;
  onSelect: (provider: ProviderOption) => void;
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

export const ProviderSelector: React.FC<ProviderSelectorProps> = ({
  providers,
  isLoading,
  error,
  onSelect,
  onCancel,
}) => {
  const [searchQuery, setSearchQuery] = useState('');

  useInput((_input, key) => {
    if (key.escape) {
      if (searchQuery) {
        setSearchQuery('');
      } else {
        onCancel();
      }
    }
  });

  const filteredProviders = useMemo(() => {
    if (!searchQuery) return providers;
    const query = searchQuery.toLowerCase();
    return providers.filter(
      (p) => p.name.toLowerCase().includes(query) || p.id.toLowerCase().includes(query)
    );
  }, [providers, searchQuery]);

  const items = useMemo(
    () =>
      filteredProviders.map((p) => ({
        key: p.id,
        label: `${p.icon} ${p.name} - ${p.description}`,
        value: p,
      })),
    [filteredProviders]
  );

  if (isLoading) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">⏳ 正在加载 Provider 列表...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">❌ {error}</Text>
        <Text dimColor>按 Esc 返回</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="blue">
          📡 Step 1: 选择 API 提供商
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text color="cyan">🔍 </Text>
        <TextInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={`搜索 ${providers.length} 个 Provider...`}
        />
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

      {filteredProviders.length === 0 && (
        <Text color="yellow">未找到匹配的 Provider，按 Esc 清除搜索</Text>
      )}
    </Box>
  );
};

/**
 * ModelSelector - 模型选择组件
 * Step 3: 从 Provider 内置模型列表中选择
 * 直接输入即可搜索，类似 fzf
 */

import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import React, { useMemo, useState } from 'react';
import type { ModelOption, ProviderOption } from './types.js';

interface ModelSelectorProps {
  provider: ProviderOption;
  models: ModelOption[];
  isLoading: boolean;
  error: string | null;
  onSelect: (model: ModelOption) => void;
  onCancel: () => void;
  initialModel?: string;
}

const SelectIndicator: React.FC<{ isSelected?: boolean }> = ({ isSelected }) => (
  <Box marginRight={1}>
    <Text color={isSelected ? 'yellow' : 'gray'}>{isSelected ? '>' : ' '}</Text>
  </Box>
);

const formatModelLabel = (model: ModelOption): string => {
  const parts = [model.name];

  if (model.contextWindow) {
    const ctx = model.contextWindow >= 1000000
      ? `${(model.contextWindow / 1000000).toFixed(1)}M`
      : model.contextWindow >= 1000
        ? `${Math.round(model.contextWindow / 1000)}K`
        : `${model.contextWindow}`;
    parts.push(`[${ctx} ctx]`);
  }

  if (model.inputCost !== undefined && model.outputCost !== undefined) {
    parts.push(`[$${model.inputCost}/$${model.outputCost}]`);
  }

  return parts.join(' ');
};

const SelectItem: React.FC<{ isSelected?: boolean; label: string }> = ({
  isSelected,
  label,
}) => (
  <Text bold={isSelected} color={isSelected ? 'yellow' : undefined}>
    {label}
  </Text>
);

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  provider,
  models,
  isLoading,
  error,
  onSelect,
  onCancel,
  initialModel,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const isCustomProvider = provider.isCustom || models.length === 0;
  const [isCustomMode, setIsCustomMode] = useState(isCustomProvider);
  const [customModel, setCustomModel] = useState(initialModel || '');

  useInput((input, key) => {
    if (key.escape) {
      if (isCustomMode && !isCustomProvider) {
        setIsCustomMode(false);
        setCustomModel(initialModel || '');
      } else if (searchQuery) {
        setSearchQuery('');
      } else {
        onCancel();
      }
      return;
    }
    if (input === '+' && !isCustomMode) {
      setIsCustomMode(true);
    }
  });

  const filteredModels = useMemo(() => {
    if (!searchQuery) return models;
    const query = searchQuery.toLowerCase();
    return models.filter(
      (m) => m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query)
    );
  }, [models, searchQuery]);

  const items = useMemo(
    () =>
      filteredModels.map((m) => ({
        key: m.id,
        label: formatModelLabel(m),
        value: m,
      })),
    [filteredModels]
  );

  const handleCustomSubmit = () => {
    if (customModel.trim()) {
      onSelect({ id: customModel.trim(), name: customModel.trim() });
    }
  };

  if (isLoading) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">正在加载 {provider.name} 模型列表...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">{error}</Text>
        <Text dimColor>按 Esc 返回</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="blue">
          Step 3: 选择模型
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text>
          Provider: {provider.icon} <Text bold>{provider.name}</Text>
        </Text>
      </Box>

      {isCustomMode ? (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text dimColor>
              {isCustomProvider
                ? '输入 Model ID：'
                : '输入自定义 Model ID（按 Esc 返回列表）：'}
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text dimColor>例如: deepseek-v4-pro</Text>
          </Box>
          <Box>
            <Text bold color="cyan">{'> '}</Text>
            <TextInput
              value={customModel}
              onChange={setCustomModel}
              onSubmit={handleCustomSubmit}
              placeholder="例如: deepseek-v4-pro"
            />
          </Box>
        </Box>
      ) : (
        <>
          <Box marginBottom={1}>
            <Text color="cyan">{'> '}</Text>
            <TextInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder={`搜索 ${models.length} 个模型，按 + 手动输入 Model ID...`}
            />
          </Box>

          <Box marginBottom={1}>
            <Text dimColor>按 + 手动输入 Model ID，例如: deepseek-v4-pro</Text>
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

          {filteredModels.length === 0 && (
            <Text color="yellow">未找到匹配的模型，按 + 输入自定义模型名称</Text>
          )}
        </>
      )}
    </Box>
  );
};

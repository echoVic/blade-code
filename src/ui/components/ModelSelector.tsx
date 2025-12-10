/**
 * ModelSelector - 模型选择器
 *
 * 功能：
 * - 显示模型列表和详情
 * - 操作：Enter 切换、D 删除、ESC 取消、Ctrl+C 退出
 */

import { useMemoizedFn, useMount } from 'ahooks';
import { Box, Text, useFocus, useFocusManager, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import { memo, useEffect, useMemo, useState } from 'react';
import type { ModelConfig } from '../../config/types.js';
import { useSession } from '../contexts/SessionContext.js';
import { useCtrlCHandler } from '../hooks/useCtrlCHandler.js';

interface ModelSelectorProps {
  onClose: () => void;
  onEdit?: (model: ModelConfig) => void;
}

// 自定义 SelectInput 组件 - 高对比度样式
const Indicator: React.FC<{ isSelected?: boolean }> = ({ isSelected }) => (
  <Box marginRight={1}>
    <Text color={isSelected ? 'yellow' : 'gray'}>{isSelected ? '▶' : ' '}</Text>
  </Box>
);

const Item: React.FC<{ isSelected?: boolean; label: string }> = ({
  isSelected,
  label,
}) => (
  <Text bold={isSelected} color={isSelected ? 'yellow' : undefined}>
    {label}
  </Text>
);

export const ModelSelector = memo(({ onClose, onEdit }: ModelSelectorProps) => {
  const { configManager } = useSession();
  const { isFocused } = useFocus({ id: 'model-selector' });
  const focusManager = useFocusManager();

  const [models, setModels] = useState<ModelConfig[]>([]);
  const [currentModelId, setCurrentModelId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 使用智能 Ctrl+C 处理
  const handleCtrlC = useCtrlCHandler(false);

  // 计算分隔线长度 (仅初始化时获取一次,避免终端大小变化导致重复渲染)
  const [separatorLength] = useState(() => {
    const terminalWidth = process.stdout?.columns || 80;
    return Math.max(20, terminalWidth - 8);
  });

  useMount(() => {
    focusManager?.focus('model-selector');
  });

  // 初始化
  useEffect(() => {
    const allModels = configManager.getAllModels();
    const config = configManager.getConfig();

    setModels(allModels);
    setCurrentModelId(config.currentModelId);
    setSelectedId(allModels[0]?.id || '');
  }, [configManager]);

  // 全局键盘处理 - 始终监听
  useInput(
    (input, key) => {
      if (isProcessing) return;

      // Ctrl+C: 智能退出
      if ((key.ctrl && input === 'c') || (key.meta && input === 'c')) {
        handleCtrlC();
        return;
      }

      // Esc: 关闭选择器 (移到焦点检查之前,确保总是生效)
      if (key.escape) {
        onClose();
        return;
      }

      if (!isFocused) return;

      // D: 删除模型
      if (input === 'd' || input === 'D') {
        handleDelete();
        return;
      }

      // E: 编辑模型
      if ((input === 'e' || input === 'E') && onEdit) {
        handleEdit();
      }
    },
    { isActive: true }
  );

  const handleSelect = useMemoizedFn(async (item: { value: string }) => {
    if (isProcessing) return;

    const modelId = item.value;
    if (modelId === currentModelId) {
      onClose();
      return;
    }

    setIsProcessing(true);
    setError(null);
    try {
      await configManager.switchModel(modelId);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setIsProcessing(false);
    }
  });

  const handleDelete = useMemoizedFn(async () => {
    if (isProcessing || selectedId === currentModelId) return;

    setIsProcessing(true);
    setError(null);
    try {
      await configManager.removeModel(selectedId);
      const newModels = configManager.getAllModels();
      setModels(newModels);

      // 如果没有模型了，关闭选择器
      if (newModels.length === 0) {
        onClose();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsProcessing(false);
    }
  });

  const handleEdit = useMemoizedFn(() => {
    if (isProcessing || !onEdit) return;
    const target = models.find((m) => m.id === selectedId);
    if (!target) return;
    onEdit(target);
  });

  const handleHighlight = useMemoizedFn((item: { value: string }) => {
    setSelectedId(item.value);
  });

  const selectedModel = useMemo(() => {
    return models.find((m) => m.id === selectedId);
  }, [models, selectedId]);

  const items = models.map((model) => ({
    label: model.name + (model.id === currentModelId ? ' (当前)' : ''),
    value: model.id,
  }));
  const isCurrentSelection = selectedId === currentModelId;
  const shortcutHint = isProcessing
    ? '⏳ 处理中...'
    : isCurrentSelection
      ? 'Enter=关闭 • E=编辑 • Esc=取消'
      : 'Enter=切换 • D=删除 • E=编辑 • Esc=取消';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      padding={1}
      width="100%"
    >
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Text bold color="cyan">
          模型管理
        </Text>
        <Text dimColor>{shortcutHint} • Ctrl+C=退出</Text>
      </Box>

      <Box flexDirection="row">
        <Box
          flexDirection="column"
          flexGrow={2}
          marginRight={2}
          borderStyle="single"
          borderColor="gray"
          padding={1}
        >
          <Text dimColor>已配置模型 ({models.length})</Text>
          <Box marginTop={1}>
            <SelectInput
              items={items}
              onSelect={handleSelect}
              onHighlight={handleHighlight}
              indicatorComponent={Indicator}
              itemComponent={Item}
            />
          </Box>
        </Box>

        <Box
          flexDirection="column"
          flexGrow={3}
          borderStyle="single"
          borderColor="gray"
          padding={1}
        >
          <Text dimColor>模型详情</Text>
          <Box marginY={1}>
            <Text color={isCurrentSelection ? 'green' : 'yellow'}>
              {isCurrentSelection ? '● 当前使用' : '● 可切换'}
            </Text>
          </Box>
          {selectedModel ? (
            <Box flexDirection="column">
              <Text>
                <Text dimColor>名称: </Text>
                <Text bold color="cyan">
                  {selectedModel.name}
                </Text>
              </Text>
              <Text>
                <Text dimColor>Provider: </Text>
                <Text bold>{selectedModel.provider}</Text>
              </Text>
              <Text>
                <Text dimColor>Model: </Text>
                <Text bold>{selectedModel.model}</Text>
              </Text>
              <Text>
                <Text dimColor>Base URL: </Text>
                <Text color="blueBright">{selectedModel.baseUrl}</Text>
              </Text>
              {selectedModel.temperature !== undefined && (
                <Text>
                  <Text dimColor>Temperature: </Text>
                  <Text>{selectedModel.temperature}</Text>
                </Text>
              )}
              {selectedModel.maxContextTokens !== undefined && (
                <Text>
                  <Text dimColor>Context Window: </Text>
                  <Text>{selectedModel.maxContextTokens}</Text>
                </Text>
              )}
            </Box>
          ) : (
            <Text dimColor>请选择一个模型查看详情</Text>
          )}
        </Box>
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="red">❌ {error}</Text>
        </Box>
      )}

      <Box justifyContent="center" marginTop={1}>
        <Text dimColor>{'─'.repeat(separatorLength)}</Text>
      </Box>

      <Box justifyContent="center">
        <Text dimColor>提示：D=删除 • E=编辑 • ↑↓=移动 • Enter/ESC=确认</Text>
      </Box>
    </Box>
  );
});

/**
 * ModelSelector - 模型选择器
 *
 * 功能：
 * - 显示模型列表和详情
 * - 操作：Enter 切换、D 删除、ESC 取消、Ctrl+C 退出
 */

import { Box, Text, useFocus, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import { memo, useEffect, useState } from 'react';
import type { ModelConfig } from '../../config/types.js';
import { useSession } from '../contexts/SessionContext.js';
import { useCtrlCHandler } from '../hooks/useCtrlCHandler.js';

interface ModelSelectorProps {
  onClose: () => void;
}

// 自定义 SelectInput 组件 - 高对比度样式
const Indicator: React.FC<{ isSelected?: boolean }> = ({ isSelected }) => (
  <Box marginRight={1}>
    <Text color={isSelected ? 'yellow' : 'gray'}>{isSelected ? '▶' : ' '}</Text>
  </Box>
);

const Item: React.FC<{ isSelected?: boolean; label: string }> = ({ isSelected, label }) => (
  <Text bold={isSelected} color={isSelected ? 'yellow' : undefined}>
    {label}
  </Text>
);

export const ModelSelector = memo(({ onClose }: ModelSelectorProps) => {
  const { configManager } = useSession();
  const { isFocused } = useFocus({ id: 'model-selector' });

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

  // 初始化
  useEffect(() => {
    const allModels = configManager.getAllModels();
    const config = configManager.getConfig();
    setModels(allModels);
    setCurrentModelId(config.currentModelId);
    setSelectedId(config.currentModelId);
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
      }
    },
    { isActive: true }
  );

  const handleSelect = async (item: { value: string }) => {
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
  };

  const handleDelete = async () => {
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
  };

  const selectedModel = models.find((m) => m.id === selectedId);
  const items = models.map((model) => ({
    label: model.name + (model.id === currentModelId ? ' (当前)' : ''),
    value: model.id,
  }));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" padding={1}>
      {/* 标题 */}
      <Box justifyContent="center" marginBottom={1}>
        <Text bold color="blue">
          选择模型配置
        </Text>
      </Box>

      {/* 模型列表 */}
      <Box flexDirection="column" marginBottom={1}>
        <SelectInput
          items={items}
          onSelect={handleSelect}
          onHighlight={(item) => setSelectedId(item.value)}
          indicatorComponent={Indicator}
          itemComponent={Item}
        />
      </Box>

      {/* 分隔线 */}
      <Box marginBottom={1}>
        <Text dimColor>{'─'.repeat(separatorLength)}</Text>
      </Box>

      {/* 详情 */}
      {selectedModel && (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text dimColor>名称: </Text>
            <Text bold color="cyan">
              {selectedModel.name}
            </Text>
          </Text>
          <Text>
            <Text dimColor>Provider: </Text>
            <Text bold color="cyan">
              {selectedModel.provider}
            </Text>
          </Text>
          <Text>
            <Text dimColor>Model: </Text>
            <Text bold color="cyan">
              {selectedModel.model}
            </Text>
          </Text>
          <Text>
            <Text dimColor>Base URL: </Text>
            <Text bold color="blue">
              {selectedModel.baseUrl}
            </Text>
          </Text>
        </Box>
      )}

      {/* 错误提示 */}
      {error && (
        <Box marginBottom={1}>
          <Text color="red">❌ {error}</Text>
        </Box>
      )}

      {/* 底部提示 */}
      <Box justifyContent="center">
        <Text dimColor>
          {isProcessing
            ? '⏳ 处理中...'
            : selectedId === currentModelId
              ? '💡 Enter=关闭 | Esc=取消 | Ctrl+C=退出'
              : '💡 Enter=切换 | D=删除 | Esc=取消 | Ctrl+C=退出'}
        </Text>
      </Box>
    </Box>
  );
});

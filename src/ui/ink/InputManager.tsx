/**
 * Ink InputManager 组件 - 终端输入管理器
 * 使用 ink-text-input 和 ink-select-input 社区组件
 */

import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import React, { useCallback, useState } from 'react';
import { Button } from './Button.js';

interface Choice {
  name?: string;
  label: string;
  value: any;
  disabled?: boolean | string;
}

interface InputManagerProps {
  type: 'text' | 'password' | 'confirm' | 'select' | 'multiselect' | 'number';
  message: string;
  defaultValue?: any;
  choices?: Choice[];
  min?: number;
  max?: number;
  validate?: (input: string) => boolean | string;
  onSubmit: (value: any) => void;
  onCancel?: () => void;
}

export const InputManager: React.FC<InputManagerProps> = ({
  type,
  message,
  defaultValue,
  choices = [],
  min,
  max,
  validate,
  onSubmit,
  onCancel,
}) => {
  const [inputValue, setInputValue] = useState(
    defaultValue !== undefined ? String(defaultValue) : ''
  );
  const [selectedChoices, setSelectedChoices] = useState<any[]>([]);
  const [error, setError] = useState('');

  // 处理输入变化
  const handleInputChange = useCallback((value: string) => {
    setInputValue(value);
    setError('');
  }, []);

  // 处理文本输入提交
  const handleTextSubmit = useCallback(
    (value: string) => {
      // 验证输入
      if (validate) {
        const validationResult = validate(value);
        if (typeof validationResult === 'string') {
          setError(validationResult);
          return;
        }
      }

      // 根据类型处理提交
      switch (type) {
        case 'text':
        case 'password':
          onSubmit(value);
          break;

        case 'number': {
          const num = parseFloat(value);
          if (isNaN(num)) {
            setError('请输入有效的数字');
            return;
          }
          if (min !== undefined && num < min) {
            setError(`数字不能小于 ${min}`);
            return;
          }
          if (max !== undefined && num > max) {
            setError(`数字不能大于 ${max}`);
            return;
          }
          onSubmit(num);
          break;
        }

        case 'confirm':
          onSubmit(value.toLowerCase() === 'y' || value.toLowerCase() === 'yes');
          break;

        default:
          onSubmit(value);
      }
    },
    [type, min, max, validate, onSubmit]
  );

  // 处理选择提交
  const handleSelectSubmit = useCallback(
    (item: Choice) => {
      if (type === 'select') {
        onSubmit(item.value);
      }
    },
    [type, onSubmit]
  );

  // 处理多选提交
  const handleMultiSelectSubmit = useCallback(() => {
    onSubmit(selectedChoices);
  }, [selectedChoices, onSubmit]);

  // 处理多选切换
  const _handleMultiSelectToggle = useCallback((item: Choice) => {
    setSelectedChoices((prev) => {
      const index = prev.findIndex((v) => v === item.value);
      if (index >= 0) {
        return prev.filter((_, i) => i !== index);
      } else {
        return [...prev, item.value];
      }
    });
  }, []);

  // 渲染选择类型
  if (type === 'select') {
    const items = choices.map((choice) => ({
      label: choice.label || choice.name || String(choice.value),
      value: choice.value,
    }));

    return (
      <Box flexDirection="column">
        <Text color="white">{message}</Text>
        <Box>
          <SelectInput items={items} onSelect={handleSelectSubmit} />
        </Box>
        {error && <Text color="red">{error}</Text>}
      </Box>
    );
  }

  // 渲染多选类型
  if (type === 'multiselect') {
    return (
      <Box flexDirection="column">
        <Text color="white">{message}</Text>
        <Box flexDirection="column">
          {choices.map((choice, index) => {
            const isSelected = selectedChoices.includes(choice.value);
            return (
              <Box key={index} flexDirection="row" alignItems="center">
                <Text color={isSelected ? 'blue' : 'gray'}>
                  {isSelected ? '☑' : '☐'}
                </Text>
                <Text color={choice.disabled ? 'gray' : 'white'}>
                  {' '}
                  {choice.label || choice.name || String(choice.value)}
                  {choice.disabled && typeof choice.disabled === 'string' && (
                    <Text color="gray"> ({choice.disabled})</Text>
                  )}
                </Text>
              </Box>
            );
          })}
        </Box>
        <Box flexDirection="row">
          <Button onPress={handleMultiSelectSubmit}>确认</Button>
          <Box>
            <Button onPress={onCancel || (() => {})}>取消</Button>
          </Box>
        </Box>
        {error && <Text color="red">{error}</Text>}
      </Box>
    );
  }

  // 渲染文本输入类型
  const placeholder = type === 'confirm' ? '(y/n)' : '';
  const mask = type === 'password' ? '*' : undefined;

  return (
    <Box flexDirection="column">
      <Text color="white">{message}</Text>
      <Box flexDirection="row" alignItems="center">
        <TextInput
          value={inputValue}
          placeholder={placeholder}
          mask={mask}
          onChange={handleInputChange}
          onSubmit={handleTextSubmit}
        />
      </Box>
      {error && <Text color="red">{error}</Text>}
    </Box>
  );
};

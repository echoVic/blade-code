/**
 * Ink InputManager 组件 - 终端输入管理器
 */

import { useInput } from 'ink';
import React, { useCallback, useEffect, useState } from 'react';
import { Box } from './Box.js';
import { Button } from './Button.js';
import { Input as InkInput } from './Input.js';
import { Text } from './Text.js';

interface Choice {
  name: string;
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
  style?: React.CSSProperties;
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
  style,
}) => {
  const [inputValue, setInputValue] = useState(defaultValue || '');
  const [selectedChoice, setSelectedChoice] = useState(0);
  const [selectedChoices, setSelectedChoices] = useState<number[]>([]);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState('');

  // 处理输入变化
  const handleInputChange = useCallback((value: string) => {
    setInputValue(value);
    setError('');
  }, []);

  // 处理输入提交
  const handleSubmit = useCallback(() => {
    // 验证输入
    if (validate) {
      const validationResult = validate(inputValue);
      if (typeof validationResult === 'string') {
        setError(validationResult);
        return;
      }
    }

    // 根据类型处理提交
    switch (type) {
      case 'text':
        onSubmit(inputValue);
        break;

      case 'password':
        onSubmit(inputValue);
        break;

      case 'number': {
        const num = parseFloat(inputValue);
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
        onSubmit(
          inputValue.toLowerCase() === 'y' || inputValue.toLowerCase() === 'yes'
        );
        break;

      case 'select':
        if (choices[selectedChoice]) {
          onSubmit(choices[selectedChoice].value);
        }
        break;

      case 'multiselect': {
        const selectedValues = selectedChoices.map((index) => choices[index].value);
        onSubmit(selectedValues);
        break;
      }

      default:
        onSubmit(inputValue);
    }

    setIsSubmitted(true);
  }, [
    type,
    inputValue,
    selectedChoice,
    selectedChoices,
    choices,
    min,
    max,
    validate,
    onSubmit,
  ]);

  // 处理取消
  const handleCancel = useCallback(() => {
    if (onCancel) {
      onCancel();
    }
  }, [onCancel]);

  // 使用键盘输入处理
  useInput((input, key) => {
    if (isSubmitted) return;

    // 处理确认键
    if (key.return) {
      handleSubmit();
      return;
    }

    // 处理取消键
    if (key.escape) {
      handleCancel();
      return;
    }

    // 处理选择类型输入
    if (type === 'select' || type === 'multiselect') {
      if (key.upArrow) {
        setSelectedChoice((prev) => (prev > 0 ? prev - 1 : choices.length - 1));
      } else if (key.downArrow) {
        setSelectedChoice((prev) => (prev < choices.length - 1 ? prev + 1 : 0));
      } else if (input === ' ' && type === 'multiselect') {
        setSelectedChoices((prev) => {
          if (prev.includes(selectedChoice)) {
            return prev.filter((index) => index !== selectedChoice);
          } else {
            return [...prev, selectedChoice];
          }
        });
      }
      return;
    }

    // 处理文本输入
    if (
      type === 'text' ||
      type === 'password' ||
      type === 'number' ||
      type === 'confirm'
    ) {
      if (key.backspace || key.delete) {
        setInputValue((prev: string) => prev.slice(0, -1));
      } else if (input.length === 1) {
        setInputValue((prev: string) => prev + input);
      }
    }
  });

  // 渲染选择项
  const renderChoices = () => {
    if (!choices.length) return null;

    return (
      <Box flexDirection="column" marginTop={1}>
        {choices.map((choice, index) => (
          <Box key={index} flexDirection="row" alignItems="center">
            {type === 'select' && (
              <Text color={index === selectedChoice ? 'blue' : 'gray'}>
                {index === selectedChoice ? '◉' : '○'}
              </Text>
            )}
            {type === 'multiselect' && (
              <Text color={selectedChoices.includes(index) ? 'blue' : 'gray'}>
                {selectedChoices.includes(index) ? '☑' : '☐'}
              </Text>
            )}
            <Text
              color={
                choice.disabled ? 'gray' : index === selectedChoice ? 'blue' : 'white'
              }
              dim={!!choice.disabled}
              marginLeft={1}
            >
              {choice.name}
              {choice.disabled && typeof choice.disabled === 'string' && (
                <Text color="gray"> ({choice.disabled})</Text>
              )}
            </Text>
          </Box>
        ))}
      </Box>
    );
  };

  // 渲染输入框
  const renderInput = () => {
    if (type === 'select' || type === 'multiselect') {
      return null;
    }

    const placeholder = type === 'confirm' ? '(y/n)' : '';

    return (
      <Box flexDirection="row" alignItems="center" marginTop={1}>
        <InkInput
          value={inputValue}
          placeholder={placeholder}
          onChange={handleInputChange}
          onSubmit={handleSubmit}
          focus={!isSubmitted}
        />
      </Box>
    );
  };

  // 渲染按钮
  const renderButtons = () => {
    if (type === 'select' || type === 'multiselect') {
      return (
        <Box flexDirection="row" marginTop={1}>
          <Button onPress={handleSubmit}>确认</Button>
          <Box marginLeft={1}>
            <Button onPress={handleCancel}>取消</Button>
          </Box>
        </Box>
      );
    }

    return null;
  };

  return (
    <Box flexDirection="column" style={style}>
      <Text color="white">{message}</Text>
      {renderChoices()}
      {renderInput()}
      {error && (
        <Text color="red" marginTop={1}>
          {error}
        </Text>
      )}
      {renderButtons()}
    </Box>
  );
};

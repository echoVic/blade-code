/**
 * Ink Input 组件 - 终端输入框
 */
import { useInput } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import { Box } from './Box.js';
import { Text } from './Text.js';

interface InputProps {
  value?: string;
  placeholder?: string;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  disabled?: boolean;
  focus?: boolean;
  borderColor?: string;
  textColor?: string;
  placeholderColor?: string;
  style?: React.CSSProperties;
}

export const Input: React.FC<InputProps> = ({
  value = '',
  placeholder = '',
  onChange,
  onSubmit,
  onFocus,
  onBlur,
  disabled = false,
  focus = false,
  borderColor = 'blue',
  textColor = 'white',
  placeholderColor = 'gray',
  style,
}) => {
  const [inputValue, setInputValue] = useState(value);
  const [isFocused, setIsFocused] = useState(focus);
  const inputRef = useRef('');

  // 同步外部 value 变化
  useEffect(() => {
    setInputValue(value);
    inputRef.current = value;
  }, [value]);

  // 处理输入焦点
  useEffect(() => {
    if (focus && !disabled) {
      setIsFocused(true);
      if (onFocus) onFocus();
    }
  }, [focus, disabled, onFocus]);

  // 使用 Ink 的输入处理
  useInput((input, key) => {
    if (!isFocused || disabled) return;

    if (key.backspace || key.delete) {
      // 处理退格
      setInputValue((prev) => {
        const newValue = prev.slice(0, -1);
        inputRef.current = newValue;
        if (onChange) onChange(newValue);
        return newValue;
      });
    } else if (key.return) {
      // 处理回车提交
      if (onSubmit) onSubmit(inputValue);
    } else if (input.length === 1) {
      // 处理普通字符输入
      setInputValue((prev) => {
        const newValue = prev + input;
        inputRef.current = newValue;
        if (onChange) onChange(newValue);
        return newValue;
      });
    }
  });

  // 计算显示文本
  const displayText = inputValue || placeholder;
  const showPlaceholder = !inputValue && !!placeholder;

  return (
    <Box
      borderColor={disabled ? 'gray' : isFocused ? borderColor : 'gray'}
      borderStyle="round"
      paddingX={1}
      paddingY={0}
      style={style}
    >
      <Text
        color={showPlaceholder ? placeholderColor : textColor}
        dim={showPlaceholder}
      >
        {displayText}
        {isFocused && <Text color="gray">▋</Text>}
      </Text>
    </Box>
  );
};

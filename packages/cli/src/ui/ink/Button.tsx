/**
 * Ink Button 组件 - 终端按钮
 */
import React, { useCallback, useState } from 'react';
import { Box } from './Box.js';
import { Text } from './Text.js';

interface ButtonProps {
  children: React.ReactNode;
  onPress?: () => void;
  color?: string;
  backgroundColor?: string;
  borderColor?: string;
  disabled?: boolean;
  focus?: boolean;
  style?: React.CSSProperties;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  onPress,
  color = 'white',
  backgroundColor = 'blue',
  borderColor = 'blue',
  disabled = false,
  focus = false,
  style,
}) => {
  const [isHovered, setIsHovered] = useState(false);

  const handlePress = useCallback(() => {
    if (!disabled && onPress) {
      onPress();
    }
  }, [disabled, onPress]);

  const handleMouseEnter = useCallback(() => {
    if (!disabled) {
      setIsHovered(true);
    }
  }, [disabled]);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
  }, []);

  // 计算按钮样式
  const buttonBackgroundColor = disabled
    ? 'gray'
    : isHovered || focus
    ? 'brightBlue'
    : backgroundColor;

  const buttonColor = disabled ? 'darkGray' : color;

  return (
    <Box
      onPress={handlePress}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      borderColor={disabled ? 'gray' : borderColor}
      borderStyle="round"
      paddingX={2}
      paddingY={0}
      backgroundColor={buttonBackgroundColor}
      style={style}
    >
      <Text color={buttonColor} bold>
        {children}
      </Text>
    </Box>
  );
};
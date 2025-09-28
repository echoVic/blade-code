/**
 * Ink Spinner 组件 - 加载动画
 */
import React, { useState, useEffect } from 'react';
import { Text } from './Text.js';

interface SpinnerProps {
  type?: 'dots' | 'dots2' | 'dots3' | 'dots4' | 'dots5' | 'dots6' | 'dots7' | 'dots8' | 'dots9' | 'dots10' | 'dots11' | 'dots12' | 'line' | 'line2' | 'pipe' | 'simpleDots' | 'simpleDotsScrolling' | 'star' | 'star2' | 'flip' | 'hamburger' | 'growVertical' | 'growHorizontal' | 'balloon' | 'balloon2' | 'noise' | 'bounce' | 'boxBounce' | 'boxBounce2' | 'triangle' | 'arc' | 'circle' | 'squareCorners' | 'circleQuarters' | 'circleHalves' | 'squish' | 'toggle' | 'toggle2' | 'pong' | 'run' | 'pingPong' | 'shake' | 'bar' | 'bar2' | 'bar3' | 'bar4' | 'bar5' | 'bar6' | 'moon' | 'dotsBounce' | 'dotsFade' | 'clock';
  color?: string;
  label?: string;
  style?: React.CSSProperties;
}

export const Spinner: React.FC<SpinnerProps> = ({
  type = 'dots',
  color = 'green',
  label = '',
  style,
}) => {
  const [frame, setFrame] = useState(0);

  // 不同类型的动画帧
  const spinnerFrames: Record<string, string[]> = {
    dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    dots2: ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'],
    dots3: ['⠋', '⠙', '⠚', '⠞', '⠖', '⠦', '⠴', '⠲', '⠳', '⠓'],
    line: ['-', '\\', '|', '/'],
    pipe: ['┤', '┘', '┴', '└', '├', '┌', '┬', '┐'],
    star: ['✶', '✸', '✹', '✺', '✹', '✷'],
    flip: ['_', '_', '_', '-', '`', '`', '`', '-', '_', '_', '_',],
    hamburger: ['☱', '☲', '☴'],
    growVertical: ['▁', '▃', '▄', '▅', '▆', '▇', '▆', '▅', '▄', '▃'],
    growHorizontal: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '▊', '▋', '▌', '▍', '▎'],
    balloon: [' ', '○', '◔', '◕', '●'],
    balloon2: [' ', '.', 'o', 'O', '@', '*', ' '],
    noise: ['▓', '▒', '░'],
    bounce: ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'],
    triangle: ['◢', '◣', '◤', '◥'],
    arc: ['◜', '◠', '◝', '◞', '◡', '◟'],
    circle: ['◡', '⊙', '◠'],
    squareCorners: ['◰', '◳', '◲', '◱'],
    circleQuarters: ['◴', '◷', '◶', '◵'],
    circleHalves: ['◐', '◓', '◑', '◒'],
    squish: ['╫', '╪'],
    toggle: ['⊶', '⊷'],
    toggle2: ['▫', '▪'],
    pong: ['▐', '▌'],
    run: ['🚶 ', '🏃 '],
    shake: ['⠐', '⠔', '⠒', '⠂', '⠐', '⠒', '⠔', '⠂'],
    bar: ['▉', '▊', '▋', '▌', '▍', '▎', '▏', '▎', '▍', '▌', '▋', '▊'],
    moon: ['🌑 ', '🌒 ', '🌓 ', '🌔 ', '🌕 ', '🌖 ', '🌗 ', '🌘 '],
    clock: ['🕐 ', '🕑 ', '🕒 ', '🕓 ', '🕔 ', '🕕 ', '🕖 ', '🕗 ', '🕘 ', '🕙 ', '🕚 ', '🕛 '],
  };

  // 如果指定的类型不存在，使用默认的 dots
  const frames = spinnerFrames[type] || spinnerFrames.dots;

  // 动画效果
  useEffect(() => {
    const interval = setInterval(() => {
      setFrame(prev => (prev + 1) % frames.length);
    }, 80);

    return () => clearInterval(interval);
  }, [frames.length]);

  return (
    <Text color={color}>
      {frames[frame]} {label}
    </Text>
  );
};
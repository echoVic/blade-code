/**
 * Ink Animation 组件 - 终端动画效果
 */
import React, { useEffect, useRef, useState } from 'react';
import { Text } from './Text.js';

interface AnimationProps {
  children: React.ReactNode;
  type?: 'fadeIn' | 'fadeOut' | 'slideIn' | 'pulse' | 'bounce' | 'typing';
  duration?: number; // 动画持续时间（毫秒）
  delay?: number; // 动画延迟（毫秒）
  loop?: boolean; // 是否循环播放
  style?: React.CSSProperties;
}

export const Animation: React.FC<AnimationProps> = ({
  children,
  type = 'fadeIn',
  duration = 1000,
  delay = 0,
  loop = false,
  style,
}) => {
  const [animationState, setAnimationState] = useState(0); // 0: 未开始, 1: 进行中, 2: 完成
  const [opacity, setOpacity] = useState(type === 'fadeOut' ? 1 : 0);
  const [position, setPosition] = useState(type === 'slideIn' ? -10 : 0);
  const [scale, setScale] = useState(type === 'pulse' ? 1 : 0);
  const [typingText, setTypingText] = useState('');
  const animationRef = useRef<NodeJS.Timeout | null>(null);
  const loopRef = useRef<NodeJS.Timeout | null>(null);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (animationRef.current) clearTimeout(animationRef.current);
      if (loopRef.current) clearTimeout(loopRef.current);
    };
  }, []);

  // 启动动画
  useEffect(() => {
    if (animationState === 0) {
      animationRef.current = setTimeout(() => {
        setAnimationState(1);
      }, delay);
    }
  }, [animationState, delay]);

  // 执行动画
  useEffect(() => {
    if (animationState !== 1) return;

    const startTime = Date.now();
    const endTime = startTime + duration;

    const animate = () => {
      const now = Date.now();
      const progress = Math.min(1, (now - startTime) / duration);

      switch (type) {
        case 'fadeIn':
          setOpacity(progress);
          break;
        case 'fadeOut':
          setOpacity(1 - progress);
          break;
        case 'slideIn':
          setPosition(-10 + progress * 10);
          break;
        case 'pulse':
          setScale(0.8 + 0.2 * Math.sin(progress * Math.PI * 2));
          break;
        case 'bounce':
          setScale(1 + 0.1 * Math.sin(progress * Math.PI * 4));
          break;
        case 'typing':
          if (typeof children === 'string') {
            const charCount = Math.floor(progress * children.length);
            setTypingText(children.substring(0, charCount));
          }
          break;
      }

      if (now < endTime) {
        animationRef.current = setTimeout(animate, 16); // 约60fps
      } else {
        setAnimationState(2);
        if (loop) {
          loopRef.current = setTimeout(() => {
            setAnimationState(0);
            // 重置动画状态
            switch (type) {
              case 'fadeIn':
                setOpacity(0);
                break;
              case 'fadeOut':
                setOpacity(1);
                break;
              case 'slideIn':
                setPosition(-10);
                break;
              case 'pulse':
              case 'bounce':
                setScale(1);
                break;
              case 'typing':
                setTypingText('');
                break;
            }
          }, 100);
        }
      }
    };

    animate();

    return () => {
      if (animationRef.current) clearTimeout(animationRef.current);
    };
  }, [animationState, type, duration, children, loop]);

  // 渲染动画内容
  const renderAnimatedContent = () => {
    const content = type === 'typing' ? typingText : children;

    const animationStyle: React.CSSProperties = {
      ...style,
      opacity,
      transform:
        type === 'slideIn'
          ? `translateX(${position}%)`
          : type === 'pulse' || type === 'bounce'
            ? `scale(${scale})`
            : undefined,
    };

    return <Text>{content}</Text>;
  };

  // 如果动画还未开始，不渲染内容
  if (animationState === 0 && type !== 'typing') {
    return null;
  }

  return renderAnimatedContent();
};

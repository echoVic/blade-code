/**
 * Ink StreamingDisplay 组件 - 流式响应渲染
 */
import Spinner from 'ink-spinner';
import React, { useEffect, useRef, useState } from 'react';
import { Box } from './Box.js';
import { Text } from './Text.js';

interface StreamingDisplayProps {
  stream: AsyncIterable<string> | null;
  onStart?: () => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
  showSpinner?: boolean;
  spinnerType?: string;
  spinnerLabel?: string;
  style?: React.CSSProperties;
}

export const StreamingDisplay: React.FC<StreamingDisplayProps> = ({
  stream,
  onStart,
  onComplete,
  onError,
  showSpinner = true,
  spinnerType = 'dots',
  spinnerLabel = 'AI 正在思考中...',
  style,
}) => {
  const [content, setContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const contentRef = useRef(content);
  const isMountedRef = useRef(true);

  // 更新内容引用
  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  // 组件卸载时清理
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // 处理流式数据
  useEffect(() => {
    if (!stream) return;

    let cancelled = false;

    const processStream = async () => {
      if (!isMountedRef.current || cancelled) return;

      setIsStreaming(true);
      setError(null);
      setContent('');

      if (onStart) onStart();

      try {
        for await (const chunk of stream) {
          if (!isMountedRef.current || cancelled) break;

          // 更新内容
          setContent((prev) => prev + chunk);
        }

        if (!isMountedRef.current || cancelled) return;

        setIsStreaming(false);
        if (onComplete) onComplete();
      } catch (err) {
        if (!isMountedRef.current || cancelled) return;

        setIsStreaming(false);
        setError(err instanceof Error ? err : new Error('未知错误'));
        if (onError) onError(err instanceof Error ? err : new Error('未知错误'));
      }
    };

    processStream();

    return () => {
      cancelled = true;
    };
  }, [stream, onStart, onComplete, onError]);

  // 渲染内容
  const renderContent = () => {
    if (error) {
      return <Text color="red">错误: {error.message}</Text>;
    }

    if (isStreaming && showSpinner) {
      return (
        <Box flexDirection="column">
          <Text>{contentRef.current}</Text>
          <Box marginTop={1}>
            <Text color="green">
              <Spinner type={spinnerType as any} /> {spinnerLabel}
            </Text>
          </Box>
        </Box>
      );
    }

    return <Text>{contentRef.current}</Text>;
  };

  return <Box style={style}>{renderContent()}</Box>;
};

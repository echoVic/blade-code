import { Box, Text } from 'ink';
import React, { ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      error,
      errorInfo: null,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({
      error,
      errorInfo,
    });

    // 记录错误到控制台
    console.error('未捕获的错误:', error, errorInfo);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <Box flexDirection="column" padding={1} borderStyle="round" borderColor="red">
          <Text color="red">应用发生错误</Text>
          <Text> </Text>
          <Text color="red">{this.state.error?.message}</Text>
          <Text> </Text>
          <Text color="gray">错误详情:</Text>
          <Text color="gray">{this.state.error?.stack}</Text>
          <Text> </Text>
          <Text color="yellow">请重启应用或联系开发者</Text>
        </Box>
      );
    }

    return this.props.children;
  }
}

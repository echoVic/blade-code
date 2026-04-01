import { Box, Text } from 'ink';
import React, { type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  name?: string;
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

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({
      error,
      errorInfo,
    });

    console.error('未捕获的错误:', error, errorInfo);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <Box flexDirection="column" padding={1} borderStyle="round" borderColor="red">
          <Text bold color="red">
            {this.props.name
              ? `💥 Error in ${this.props.name}`
              : '💥 应用发生错误'}
          </Text>
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

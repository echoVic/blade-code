import { ToolErrorType, type ToolResult } from '../types/index.js';

interface RejectionOptions {
  shouldExitLoop?: boolean;
  llmContent?: string;
  summary?: string;
  errorType?: ToolErrorType;
  abortedBeforeLaunch?: boolean;
}

export function createRejectedResult(
  reason: string,
  options: RejectionOptions = {}
): ToolResult {
  return {
    success: false,
    llmContent: options.llmContent ?? `Tool execution aborted: ${reason}`,
    error: {
      type: options.errorType ?? ToolErrorType.EXECUTION_ERROR,
      message: reason,
    },
    metadata: {
      summary: options.summary ?? `执行已中止: ${reason}`,
      ...(options.shouldExitLoop ? { shouldExitLoop: true } : {}),
      ...(options.abortedBeforeLaunch ? { abortedBeforeLaunch: true } : {}),
    },
  };
}

export function createCancellationResult(abortedBeforeLaunch: boolean): ToolResult {
  return createRejectedResult('任务已被用户中止', {
    shouldExitLoop: true,
    llmContent: '任务已被用户中止',
    summary: '任务已被用户中止',
    abortedBeforeLaunch,
  });
}

export function createInvalidAcpRemotePathResult(options?: {
  mutation?: boolean;
}): ToolResult {
  const message = 'ACP remote file path is invalid';
  return {
    success: false,
    llmContent: message,
    error: {
      type: ToolErrorType.VALIDATION_ERROR,
      code: 'acp_remote_path_invalid',
      message,
    },
    ...(options?.mutation
      ? {
          metadata: {
            ...(options.mutation ? { sideEffectsUncertain: false } : {}),
          },
        }
      : {}),
  };
}

export function createUnavailableAcpSessionFileSystemResult(options?: {
  mutation?: boolean;
}): ToolResult {
  const message = 'ACP session filesystem is unavailable';
  return {
    success: false,
    llmContent: message,
    error: {
      type: ToolErrorType.EXECUTION_ERROR,
      code: 'acp_session_unavailable',
      message,
    },
    ...(options?.mutation
      ? {
          metadata: {
            sideEffectsUncertain: false,
          },
        }
      : {}),
  };
}

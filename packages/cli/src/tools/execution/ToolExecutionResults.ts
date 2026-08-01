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

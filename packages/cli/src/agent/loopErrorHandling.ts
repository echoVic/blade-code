import type { LoopResult, LoopResultMetadataInput } from './types.js';

type CreateErrorResult = (params: {
  type: NonNullable<LoopResult['error']>['type'];
  message: string;
  details?: unknown;
  metadata: LoopResultMetadataInput;
}) => LoopResult;

export function createAbortedLoopResult(
  createErrorResult: CreateErrorResult,
  metadata: LoopResultMetadataInput
): LoopResult {
  return createErrorResult({
    type: 'aborted',
    message: '任务已被用户中止',
    metadata,
  });
}

export function createUnexpectedLoopErrorResult(
  createErrorResult: CreateErrorResult,
  params: {
    error: unknown;
    turnsCount: number;
    toolCallsCount: number;
    duration: number;
  }
): LoopResult {
  return createErrorResult({
    type: 'api_error',
    message: `处理消息时发生错误: ${
      params.error instanceof Error ? params.error.message : '未知错误'
    }`,
    details: params.error,
    metadata: {
      turnsCount: params.turnsCount,
      toolCallsCount: params.toolCallsCount,
      duration: params.duration,
    },
  });
}

export function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message.includes('aborted'))
  );
}

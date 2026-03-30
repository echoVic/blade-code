import { describe, expect, it } from 'vitest';

import { resolveLoopControl } from '../../../../src/agent/loopControl.js';
import { createLoopErrorResult } from '../../../../src/agent/loopResult.js';
import {
  createAbortedLoopResult,
  createUnexpectedLoopErrorResult,
  isAbortLikeError,
} from '../../../../src/agent/loopErrorHandling.js';
import { PermissionMode } from '../../../../src/config/types.js';
import type { LoopResult } from '../../../../src/agent/types.js';

const control = resolveLoopControl({
  runtimeMaxTurns: -1,
  permissionMode: PermissionMode.DEFAULT,
});

type LoopMetadataInput = Pick<
  NonNullable<LoopResult['metadata']>,
  'turnsCount' | 'toolCallsCount' | 'duration'
> &
  Partial<NonNullable<LoopResult['metadata']>>;

describe('loopErrorHandling', () => {
  const createErrorResult = (params: {
    type: NonNullable<LoopResult['error']>['type'];
    message: string;
    details?: unknown;
    metadata: LoopMetadataInput;
  }) => createLoopErrorResult(control, params);

  it('builds a standard aborted loop result', () => {
    const result = createAbortedLoopResult(createErrorResult, {
      turnsCount: 3,
      toolCallsCount: 2,
      duration: 456,
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        type: 'aborted',
        message: '任务已被用户中止',
      },
      metadata: {
        turnsCount: 3,
        toolCallsCount: 2,
        duration: 456,
      },
    });
  });

  it('builds a formatted api_error result for unexpected failures', () => {
    const error = new Error('boom');

    const result = createUnexpectedLoopErrorResult(createErrorResult, {
      error,
      turnsCount: 0,
      toolCallsCount: 0,
      duration: 99,
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        type: 'api_error',
        message: '处理消息时发生错误: boom',
        details: error,
      },
      metadata: {
        turnsCount: 0,
        toolCallsCount: 0,
        duration: 99,
      },
    });
  });

  it('recognizes abort-like errors by name or message', () => {
    const abortByName = new Error('something else');
    abortByName.name = 'AbortError';

    expect(isAbortLikeError(abortByName)).toBe(true);
    expect(isAbortLikeError(new Error('request was aborted by client'))).toBe(true);
    expect(isAbortLikeError(new Error('boom'))).toBe(false);
    expect(isAbortLikeError('aborted')).toBe(false);
  });
});

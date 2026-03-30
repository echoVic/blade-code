import { describe, expect, it } from 'vitest';

import { PermissionMode } from '../../../../src/config/types.js';
import { resolveLoopControl } from '../../../../src/agent/loopControl.js';
import {
  createLoopErrorResult,
  createLoopSuccessResult,
} from '../../../../src/agent/loopResult.js';

describe('loopResult', () => {
  it('builds success results with resolved loop metadata', () => {
    const control = resolveLoopControl({
      runtimeMaxTurns: undefined,
      optionMaxTurns: 7,
      configMaxTurns: 20,
      permissionMode: PermissionMode.DEFAULT,
    });

    const result = createLoopSuccessResult(control, {
      finalMessage: 'done',
      metadata: {
        turnsCount: 3,
        toolCallsCount: 2,
        duration: 1234,
        tokensUsed: 99,
      },
    });

    expect(result).toMatchObject({
      success: true,
      finalMessage: 'done',
      metadata: {
        configuredMaxTurns: 7,
        actualMaxTurns: 7,
        hitSafetyLimit: false,
        turnsCount: 3,
        toolCallsCount: 2,
        duration: 1234,
        tokensUsed: 99,
      },
    });
  });

  it('builds error results with details and loop metadata', () => {
    const control = resolveLoopControl({
      runtimeMaxTurns: 150,
      optionMaxTurns: undefined,
      configMaxTurns: undefined,
      permissionMode: PermissionMode.DEFAULT,
    });

    const result = createLoopErrorResult(control, {
      type: 'api_error',
      message: 'boom',
      details: { reason: 'timeout' },
      metadata: {
        turnsCount: 0,
        toolCallsCount: 1,
        duration: 55,
        hitSafetyLimit: true,
      },
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        type: 'api_error',
        message: 'boom',
        details: { reason: 'timeout' },
      },
      metadata: {
        configuredMaxTurns: 150,
        actualMaxTurns: 100,
        hitSafetyLimit: true,
        turnsCount: 0,
        toolCallsCount: 1,
        duration: 55,
      },
    });
  });
});

import { describe, expect, it } from 'vitest';

import {
  buildLoopMetadata,
  resolveLoopControl,
} from '../../../../src/agent/loopControl.js';
import { PermissionMode } from '../../../../src/config/types.js';

describe('loopControl', () => {
  it('prefers runtime maxTurns over options and config while applying the safety limit', () => {
    const control = resolveLoopControl({
      runtimeMaxTurns: 250,
      optionMaxTurns: 80,
      configMaxTurns: 40,
      permissionMode: PermissionMode.DEFAULT,
    });

    expect(control).toMatchObject({
      configuredMaxTurns: 250,
      actualMaxTurns: 100,
      hitSafetyLimit: true,
      isYoloMode: false,
    });
  });

  it('treats yolo mode as exempt from safety-limit hits', () => {
    const control = resolveLoopControl({
      runtimeMaxTurns: -1,
      optionMaxTurns: undefined,
      configMaxTurns: undefined,
      permissionMode: PermissionMode.YOLO,
    });

    expect(control).toMatchObject({
      configuredMaxTurns: -1,
      actualMaxTurns: 100,
      hitSafetyLimit: false,
      isYoloMode: true,
    });
  });

  it('builds loop metadata with resolved turn-limit fields', () => {
    const control = resolveLoopControl({
      runtimeMaxTurns: undefined,
      optionMaxTurns: 7,
      configMaxTurns: 20,
      permissionMode: PermissionMode.DEFAULT,
    });

    expect(
      buildLoopMetadata(control, {
        turnsCount: 3,
        toolCallsCount: 2,
        duration: 1234,
        tokensUsed: 99,
      })
    ).toMatchObject({
      configuredMaxTurns: 7,
      actualMaxTurns: 7,
      hitSafetyLimit: false,
      turnsCount: 3,
      toolCallsCount: 2,
      duration: 1234,
      tokensUsed: 99,
    });
  });
});

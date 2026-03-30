import type { LoopControl } from './loopControl.js';
import { buildLoopMetadata } from './loopControl.js';
import type { LoopResult, LoopResultMetadataInput } from './types.js';

export function createLoopSuccessResult(
  control: LoopControl,
  params: {
    finalMessage?: string;
    metadata: LoopResultMetadataInput;
  }
): LoopResult {
  return {
    success: true,
    finalMessage: params.finalMessage,
    metadata: buildLoopMetadata(control, params.metadata),
  };
}

export function createLoopErrorResult(
  control: LoopControl,
  params: {
    type: NonNullable<LoopResult['error']>['type'];
    message: string;
    details?: unknown;
    metadata: LoopResultMetadataInput;
  }
): LoopResult {
  return {
    success: false,
    error: {
      type: params.type,
      message: params.message,
      details: params.details,
    },
    metadata: buildLoopMetadata(control, params.metadata),
  };
}

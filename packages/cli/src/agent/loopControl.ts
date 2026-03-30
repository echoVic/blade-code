import { PermissionMode } from '../config/types.js';
import type { LoopResult } from './types.js';

const DEFAULT_SAFETY_LIMIT = 100;

export interface LoopControl {
  configuredMaxTurns: number;
  actualMaxTurns: number;
  hitSafetyLimit: boolean;
  isYoloMode: boolean;
}

export interface ResolveLoopControlParams {
  runtimeMaxTurns?: number;
  optionMaxTurns?: number;
  configMaxTurns?: number;
  permissionMode?: PermissionMode;
  safetyLimit?: number;
}

export function resolveLoopControl({
  runtimeMaxTurns,
  optionMaxTurns,
  configMaxTurns,
  permissionMode,
  safetyLimit = DEFAULT_SAFETY_LIMIT,
}: ResolveLoopControlParams): LoopControl {
  const isYoloMode = permissionMode === PermissionMode.YOLO;
  const configuredMaxTurns = runtimeMaxTurns ?? optionMaxTurns ?? configMaxTurns ?? -1;
  const actualMaxTurns =
    configuredMaxTurns === 0
      ? 0
      : configuredMaxTurns === -1
        ? safetyLimit
        : Math.min(configuredMaxTurns, safetyLimit);
  const hitSafetyLimit =
    !isYoloMode &&
    actualMaxTurns === safetyLimit &&
    (configuredMaxTurns === -1 || configuredMaxTurns > safetyLimit);

  return {
    configuredMaxTurns,
    actualMaxTurns,
    hitSafetyLimit,
    isYoloMode,
  };
}

export function buildLoopMetadata(
  control: LoopControl,
  metadata: Pick<
    NonNullable<LoopResult['metadata']>,
    'turnsCount' | 'toolCallsCount' | 'duration'
  > &
    Partial<NonNullable<LoopResult['metadata']>>
): NonNullable<LoopResult['metadata']> {
  return {
    configuredMaxTurns: control.configuredMaxTurns,
    actualMaxTurns: control.actualMaxTurns,
    hitSafetyLimit: metadata.hitSafetyLimit ?? false,
    ...metadata,
  };
}

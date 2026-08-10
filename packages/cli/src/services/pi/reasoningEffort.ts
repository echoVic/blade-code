import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel,
} from '@earendil-works/pi-ai';
import type { ReasoningEffortSelection } from '../../config/types.js';

export const REASONING_EFFORT_SELECTIONS = [
  'auto',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type { ReasoningEffortSelection } from '../../config/types.js';

export interface ReasoningEffortConfiguration {
  selection: ReasoningEffortSelection;
  effective: ModelThinkingLevel;
  supported: ModelThinkingLevel[];
}

export function isReasoningEffortSelection(
  value: unknown
): value is ReasoningEffortSelection {
  return (
    typeof value === 'string' &&
    REASONING_EFFORT_SELECTIONS.includes(value as ReasoningEffortSelection)
  );
}

export function resolveReasoningEffort(
  model: Model<string>,
  selection: ReasoningEffortSelection
): ReasoningEffortConfiguration {
  const supported = getSupportedThinkingLevels(model);
  if (selection !== 'auto' && !supported.includes(selection)) {
    throw new Error(`Reasoning effort ${selection} is not supported by ${model.name}`);
  }
  return {
    selection,
    effective: selection === 'auto' ? clampThinkingLevel(model, 'high') : selection,
    supported,
  };
}

import { MAX_MAX_QUEUED_TASK_BYTES } from '../../config/taskConcurrency.js';
import type { JsonObject } from '../../store/types.js';
import { estimateRetainedValueBytes } from '../../utils/retainedValueFootprint.js';
import type { UserMessageContent } from '../types.js';
import type { SteeringMessage } from './ActiveTurnMailbox.js';

export interface TaskRunFootprintInput {
  content: UserMessageContent;
  outputSchema?: JsonObject;
  pendingMessages?: readonly SteeringMessage[];
}

export function estimateTaskRunPendingBytes(input: TaskRunFootprintInput): number {
  const retainedInput =
    input.pendingMessages && input.pendingMessages.length > 0
      ? input.pendingMessages.map((message) => [
          message.content,
          message.outputSchema,
          message.metadata,
        ])
      : [input.content, input.outputSchema];
  const singleProjection = estimateRetainedValueBytes(retainedInput, {
    maxBytes: MAX_MAX_QUEUED_TASK_BYTES,
  });
  if (singleProjection > Math.floor(MAX_MAX_QUEUED_TASK_BYTES / 2)) {
    return MAX_MAX_QUEUED_TASK_BYTES + 1;
  }
  return Math.max(1, singleProjection * 2);
}

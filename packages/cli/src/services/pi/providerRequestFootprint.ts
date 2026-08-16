import type { Context } from '@earendil-works/pi-ai';
import { MAX_PROVIDER_REQUEST_PENDING_BYTES } from '../../config/providerRequestAdmission.js';
import type {
  ChatRequestOptions,
  ChatToolDefinition,
  Message,
} from '../ChatServiceInterface.js';
import {
  estimateRetainedValueBytes,
  RETAINED_VALUE_FOOTPRINT_MAX_NODES,
} from '../../utils/retainedValueFootprint.js';
import type { RetainedValueEstimateOptions } from '../../utils/retainedValueFootprint.js';

export { estimateRetainedValueBytes };
export type { RetainedValueEstimateOptions };
export const PROVIDER_REQUEST_FOOTPRINT_MAX_NODES = RETAINED_VALUE_FOOTPRINT_MAX_NODES;

export function estimateProviderRequestPendingBytes(input: {
  messages: readonly Message[];
  context: Context;
  tools?: readonly ChatToolDefinition[];
  requestOptions?: ChatRequestOptions;
}): number {
  return estimateRetainedValueBytes(
    [input.messages, input.context, input.tools, input.requestOptions],
    { maxBytes: MAX_PROVIDER_REQUEST_PENDING_BYTES }
  );
}

import type {
  ProviderFallbackTrigger,
  ProviderRecoveryFallback,
  ProviderRecoveryIdentity,
} from '../../api/providerRecoverySchemas.js';
import type { ModelRef } from '../../config/types.js';
import { isProviderCircuitOpenError } from './providerCircuitBreaker.js';
import { isProviderAdmissionError } from './providerRequestAdmission.js';
import {
  classifyProviderRetry,
  type ProviderResponseMetadata,
} from './providerRetry.js';

export type ProviderFallbackEvent = ProviderRecoveryFallback;

export function providerFallbackIdentity(model: ModelRef): ProviderRecoveryIdentity {
  return { provider: model.provider, model: model.model };
}

export function providerFallbackTriggerFromError(
  error: unknown,
  responseMetadata?: ProviderResponseMetadata
): ProviderFallbackTrigger {
  if (isProviderAdmissionError(error)) {
    return { source: 'admission', reason: error.reason };
  }
  if (isProviderCircuitOpenError(error)) {
    return {
      source: 'circuit',
      reason: error.circuit.reason,
      ...(error.circuit.statusCode !== undefined
        ? { statusCode: error.circuit.statusCode }
        : {}),
    };
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'STREAM_IDLE_TIMEOUT'
  ) {
    return { source: 'stall', reason: 'timeout' };
  }
  const classification = classifyProviderRetry(error, responseMetadata);
  if (classification.retryable && classification.reason) {
    return {
      source: 'retry',
      reason: classification.reason,
      ...(classification.statusCode !== undefined
        ? { statusCode: classification.statusCode }
        : {}),
    };
  }
  throw new Error('Provider fallback trigger is not classified');
}

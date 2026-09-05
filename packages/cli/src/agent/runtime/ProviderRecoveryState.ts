import { nanoid } from 'nanoid';
import {
  type ProviderRecoveryAdmission,
  type ProviderRecoveryCircuit,
  type ProviderRecoveryProjection,
  ProviderRecoveryProjectionSchema,
  type ProviderRecoveryReason,
  type ProviderRecoveryRetry,
  type ProviderRecoverySnapshot,
  type ProviderRecoveryStall,
} from '../../api/providerRecoverySchemas.js';
import type { LoopEvent } from '../loop/types.js';

export interface ProviderRecoveryGeneration {
  readonly id: string;
}

interface ProviderRecoveryStateOptions {
  now?: () => number;
  createGenerationId?: () => string;
}

interface RecoveryLayers {
  admission?: ProviderRecoveryAdmission;
  circuit?: ProviderRecoveryCircuit;
  retry?: ProviderRecoveryRetry;
  stall?: ProviderRecoveryStall;
  fallback?: ProviderRecoverySnapshot['fallback'];
}

function cloneProjection(
  projection: ProviderRecoveryProjection
): ProviderRecoveryProjection {
  return structuredClone(projection);
}

function admissionReason(
  event: Extract<LoopEvent, { kind: 'provider_admission' }>
): ProviderRecoveryReason {
  if (event.reason === 'queue_full' || event.reason === 'wait_timeout') {
    return event.reason;
  }
  if (event.reason === 'closed') return 'admission_closed';
  return 'capacity';
}

function fallbackReason(
  event: Extract<LoopEvent, { kind: 'model_fallback' }>
): ProviderRecoveryReason {
  if (event.trigger.source === 'stall') return 'timeout';
  if (event.trigger.source === 'admission') {
    return event.trigger.reason === 'closed'
      ? 'admission_closed'
      : event.trigger.reason;
  }
  return event.trigger.reason;
}

function snapshotFromLayers(
  layers: RecoveryLayers,
  reasons: {
    admission?: ProviderRecoveryReason;
    circuit?: ProviderRecoveryReason;
    retry?: ProviderRecoveryReason;
    fallback?: ProviderRecoveryReason;
  },
  now: number
): ProviderRecoverySnapshot | null {
  const retryWaiting =
    layers.retry !== undefined &&
    layers.retry.delayMs !== undefined &&
    layers.retry.delayMs > 0;
  const common = {
    updatedAt: now,
    ...(retryWaiting
      ? { nextActionAt: now + (layers.retry?.delayMs ?? 0) }
      : layers.circuit?.nextProbeAt !== undefined
        ? { nextActionAt: layers.circuit.nextProbeAt }
        : {}),
    ...(layers.retry ? { retry: layers.retry } : {}),
    ...(layers.admission ? { admission: layers.admission } : {}),
    ...(layers.circuit ? { circuit: layers.circuit } : {}),
    ...(layers.stall ? { stall: layers.stall } : {}),
    ...(layers.fallback ? { fallback: layers.fallback } : {}),
  };
  if (layers.stall) {
    return { activity: 'stream_stall', reason: 'stream_stall', ...common };
  }
  if (layers.circuit) {
    return {
      activity: layers.circuit.phase === 'probe' ? 'circuit_probe' : 'circuit_open',
      reason: reasons.circuit ?? 'circuit_open',
      ...common,
    };
  }
  if (layers.retry) {
    return {
      activity: retryWaiting ? 'retry_wait' : 'retry_attempt',
      reason: reasons.retry ?? 'transport',
      ...common,
    };
  }
  if (layers.admission) {
    return {
      activity: 'admission_wait',
      reason: reasons.admission ?? 'capacity',
      ...common,
    };
  }
  if (layers.fallback) {
    return {
      activity: 'fallback',
      reason: reasons.fallback ?? 'transport',
      ...common,
    };
  }
  return null;
}

export class ProviderRecoveryState {
  private readonly now: () => number;
  private readonly createGenerationId: () => string;
  private generation = '';
  private revision = 0;
  private projection?: ProviderRecoveryProjection;
  private layers: RecoveryLayers = {};
  private reasons: {
    admission?: ProviderRecoveryReason;
    circuit?: ProviderRecoveryReason;
    retry?: ProviderRecoveryReason;
    fallback?: ProviderRecoveryReason;
  } = {};

  constructor(options: ProviderRecoveryStateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createGenerationId = options.createGenerationId ?? (() => nanoid(16));
  }

  begin(): ProviderRecoveryGeneration {
    this.generation = this.createGenerationId();
    this.revision = 0;
    this.layers = {};
    this.reasons = {};
    this.projection = this.parse({
      version: 1,
      generation: this.generation,
      revision: this.revision,
      snapshot: null,
    });
    return Object.freeze({ id: this.generation });
  }

  observe(
    generation: ProviderRecoveryGeneration,
    event: LoopEvent
  ): ProviderRecoveryProjection | undefined {
    if (!this.isCurrent(generation)) return undefined;
    let changed = true;
    switch (event.kind) {
      case 'provider_admission':
        if (event.phase === 'admitted') {
          this.layers.admission = undefined;
          this.reasons.admission = undefined;
        } else {
          this.layers.admission = {
            requestClass: event.requestClass,
            resource: event.resource,
            scope: event.scope,
            queuePosition: event.queuePosition,
            queueDepth: event.queueDepth,
            inFlight: event.inFlight,
            limit: event.limit,
            waitMs: event.waitMs,
            maxWaitMs: event.maxWaitMs,
            ...(event.recoveryRemainingMs !== undefined
              ? { recoveryRemainingMs: event.recoveryRemainingMs }
              : {}),
          };
          this.reasons.admission = admissionReason(event);
        }
        break;
      case 'provider_retry':
        if (event.phase === 'recovered') {
          this.layers.retry = undefined;
          this.layers.circuit = undefined;
          this.reasons.retry = undefined;
          this.reasons.circuit = undefined;
        } else {
          this.layers.retry = {
            attempt: event.attempt,
            maxRetries: event.maxRetries,
            ...(event.statusCode !== undefined ? { statusCode: event.statusCode } : {}),
            ...(event.delayMs !== undefined ? { delayMs: event.delayMs } : {}),
            ...(event.recoveryBudgetMs !== undefined
              ? { recoveryBudgetMs: event.recoveryBudgetMs }
              : {}),
            ...(event.recoveryElapsedMs !== undefined
              ? { recoveryElapsedMs: event.recoveryElapsedMs }
              : {}),
            ...(event.recoveryRemainingMs !== undefined
              ? { recoveryRemainingMs: event.recoveryRemainingMs }
              : {}),
          };
          this.reasons.retry = event.reason;
        }
        break;
      case 'provider_circuit':
        if (event.phase === 'closed') {
          this.layers.circuit = undefined;
          this.reasons.circuit = undefined;
        } else {
          this.layers.circuit = {
            phase: event.phase,
            ...(event.statusCode !== undefined ? { statusCode: event.statusCode } : {}),
            ...(event.retryAfterMs !== undefined
              ? { retryAfterMs: event.retryAfterMs }
              : {}),
            ...(event.nextProbeAt !== undefined
              ? { nextProbeAt: event.nextProbeAt }
              : {}),
            openDurationMs: event.openDurationMs,
            ...(event.sampleCount !== undefined
              ? { sampleCount: event.sampleCount }
              : {}),
            ...(event.failureCount !== undefined
              ? { failureCount: event.failureCount }
              : {}),
            ...(event.recoveryRemainingMs !== undefined
              ? { recoveryRemainingMs: event.recoveryRemainingMs }
              : {}),
          };
          this.reasons.circuit = event.reason;
        }
        break;
      case 'provider_stall':
        if (event.phase === 'recovered') {
          this.layers.stall = undefined;
        } else {
          this.layers.stall = {
            stallCount: event.stallCount,
            durationMs: event.durationMs,
            warningAfterMs: event.warningAfterMs,
            timeoutMs: event.timeoutMs,
            outputStarted: event.outputStarted,
          };
        }
        break;
      case 'model_fallback':
        this.layers = {
          fallback: {
            from: event.from,
            to: event.to,
            candidate: event.candidate,
            candidateCount: event.candidateCount,
            trigger: event.trigger,
          },
        };
        this.reasons = { fallback: fallbackReason(event) };
        break;
      case 'content_delta':
      case 'thinking_delta':
        if (event.delta.length === 0) changed = false;
        else return this.clear(generation);
        break;
      case 'tool_start':
      case 'structured_output':
      case 'stream_end':
        return this.clear(generation);
      default:
        changed = false;
    }
    if (!changed) return undefined;
    return this.commit(snapshotFromLayers(this.layers, this.reasons, this.now()));
  }

  clear(
    generation: ProviderRecoveryGeneration
  ): ProviderRecoveryProjection | undefined {
    if (!this.isCurrent(generation) || this.projection?.snapshot === null) {
      return undefined;
    }
    this.layers = {};
    this.reasons = {};
    return this.commit(null);
  }

  snapshot(): ProviderRecoveryProjection {
    if (!this.projection) {
      const generation = this.begin();
      if (generation.id !== this.generation) {
        throw new Error('Provider recovery generation initialization failed');
      }
    }
    return cloneProjection(this.projection as ProviderRecoveryProjection);
  }

  private isCurrent(generation: ProviderRecoveryGeneration): boolean {
    return generation.id === this.generation;
  }

  private commit(
    snapshot: ProviderRecoverySnapshot | null
  ): ProviderRecoveryProjection {
    this.revision++;
    this.projection = this.parse({
      version: 1,
      generation: this.generation,
      revision: this.revision,
      snapshot,
    });
    return cloneProjection(this.projection);
  }

  private parse(value: ProviderRecoveryProjection): ProviderRecoveryProjection {
    return ProviderRecoveryProjectionSchema.parse(value);
  }
}

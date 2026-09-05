import { Runtime, type Static, StringEnum, Type } from '../schema/index.js';

export const PROVIDER_RECOVERY_IDENTITY_MAX_CHARS = 256;
export const PROVIDER_RECOVERY_GENERATION_MAX_CHARS = 128;
const MAX_RECOVERY_COUNTER = 1_000_000;
const MAX_RECOVERY_DURATION_MS = 86_400_000;
const MAX_UNIX_TIMESTAMP_MS = 8_640_000_000_000_000;

const BoundedCounterSchema = Type.Integer({
  minimum: 0,
  maximum: MAX_RECOVERY_COUNTER,
});
const BoundedDurationSchema = Type.Integer({
  minimum: 0,
  maximum: MAX_RECOVERY_DURATION_MS,
});
const TimestampSchema = Type.Integer({
  minimum: 0,
  maximum: MAX_UNIX_TIMESTAMP_MS,
});
const ProviderIdentityPartSchema = Type.String({
  minLength: 1,
  maxLength: PROVIDER_RECOVERY_IDENTITY_MAX_CHARS,
  pattern: '^(?!.*://)[^\u0000-\u001f\u007f]+$',
});

export const ProviderRecoveryReasonSchema = StringEnum([
  'capacity',
  'queue_full',
  'wait_timeout',
  'admission_closed',
  'rate_limit',
  'server_error',
  'timeout',
  'transport',
  'stream_closed',
  'circuit_open',
  'stream_stall',
]);
export type ProviderRecoveryReason = Static<typeof ProviderRecoveryReasonSchema>;

export const ProviderRecoveryActivitySchema = StringEnum([
  'admission_wait',
  'retry_wait',
  'retry_attempt',
  'circuit_open',
  'circuit_probe',
  'stream_stall',
  'fallback',
]);
export type ProviderRecoveryActivity = Static<typeof ProviderRecoveryActivitySchema>;

export const ProviderRecoveryIdentitySchema = Type.Object(
  {
    provider: ProviderIdentityPartSchema,
    model: ProviderIdentityPartSchema,
  },
  { additionalProperties: false }
);
export type ProviderRecoveryIdentity = Static<typeof ProviderRecoveryIdentitySchema>;

const ProviderRetryReasonSchema = StringEnum([
  'rate_limit',
  'server_error',
  'timeout',
  'transport',
  'stream_closed',
]);

export const ProviderFallbackTriggerSchema = Type.Union([
  Type.Object(
    {
      source: Type.Literal('retry'),
      reason: ProviderRetryReasonSchema,
      statusCode: Type.Optional(Type.Integer({ minimum: 100, maximum: 999 })),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      source: Type.Literal('circuit'),
      reason: ProviderRetryReasonSchema,
      statusCode: Type.Optional(Type.Integer({ minimum: 100, maximum: 999 })),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      source: Type.Literal('admission'),
      reason: StringEnum(['queue_full', 'wait_timeout', 'closed']),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      source: Type.Literal('stall'),
      reason: Type.Literal('timeout'),
    },
    { additionalProperties: false }
  ),
]);
export type ProviderFallbackTrigger = Static<typeof ProviderFallbackTriggerSchema>;

export const ProviderRecoveryFallbackSchema = Type.Object(
  {
    from: ProviderRecoveryIdentitySchema,
    to: ProviderRecoveryIdentitySchema,
    candidate: Type.Integer({ minimum: 1, maximum: MAX_RECOVERY_COUNTER }),
    candidateCount: Type.Integer({ minimum: 1, maximum: MAX_RECOVERY_COUNTER }),
    trigger: ProviderFallbackTriggerSchema,
  },
  { additionalProperties: false }
);
export type ProviderRecoveryFallback = Static<typeof ProviderRecoveryFallbackSchema>;

export const ProviderRecoveryRetrySchema = Type.Object(
  {
    attempt: BoundedCounterSchema,
    maxRetries: BoundedCounterSchema,
    statusCode: Type.Optional(Type.Integer({ minimum: 100, maximum: 999 })),
    delayMs: Type.Optional(BoundedDurationSchema),
    recoveryBudgetMs: Type.Optional(BoundedDurationSchema),
    recoveryElapsedMs: Type.Optional(BoundedDurationSchema),
    recoveryRemainingMs: Type.Optional(BoundedDurationSchema),
  },
  { additionalProperties: false }
);
export type ProviderRecoveryRetry = Static<typeof ProviderRecoveryRetrySchema>;

export const ProviderRecoveryAdmissionSchema = Type.Object(
  {
    requestClass: StringEnum(['foreground', 'background', 'internal']),
    scope: StringEnum(['global', 'domain', 'owner', 'class']),
    resource: StringEnum(['stream', 'pending_count', 'pending_bytes']),
    queuePosition: BoundedCounterSchema,
    queueDepth: BoundedCounterSchema,
    inFlight: BoundedCounterSchema,
    limit: BoundedCounterSchema,
    waitMs: BoundedDurationSchema,
    maxWaitMs: BoundedDurationSchema,
    recoveryRemainingMs: Type.Optional(BoundedDurationSchema),
  },
  { additionalProperties: false }
);
export type ProviderRecoveryAdmission = Static<typeof ProviderRecoveryAdmissionSchema>;

export const ProviderRecoveryCircuitSchema = Type.Object(
  {
    phase: StringEnum(['opened', 'reopened', 'waiting', 'probe', 'rejected']),
    statusCode: Type.Optional(Type.Integer({ minimum: 100, maximum: 999 })),
    retryAfterMs: Type.Optional(BoundedDurationSchema),
    nextProbeAt: Type.Optional(TimestampSchema),
    openDurationMs: BoundedDurationSchema,
    sampleCount: Type.Optional(BoundedCounterSchema),
    failureCount: Type.Optional(BoundedCounterSchema),
    recoveryRemainingMs: Type.Optional(BoundedDurationSchema),
  },
  { additionalProperties: false }
);
export type ProviderRecoveryCircuit = Static<typeof ProviderRecoveryCircuitSchema>;

export const ProviderRecoveryStallSchema = Type.Object(
  {
    stallCount: BoundedCounterSchema,
    durationMs: BoundedDurationSchema,
    warningAfterMs: BoundedDurationSchema,
    timeoutMs: BoundedDurationSchema,
    outputStarted: Type.Boolean(),
  },
  { additionalProperties: false }
);
export type ProviderRecoveryStall = Static<typeof ProviderRecoveryStallSchema>;

export const ProviderRecoverySnapshotSchema = Type.Object(
  {
    activity: ProviderRecoveryActivitySchema,
    reason: ProviderRecoveryReasonSchema,
    updatedAt: TimestampSchema,
    nextActionAt: Type.Optional(TimestampSchema),
    retry: Type.Optional(ProviderRecoveryRetrySchema),
    admission: Type.Optional(ProviderRecoveryAdmissionSchema),
    circuit: Type.Optional(ProviderRecoveryCircuitSchema),
    stall: Type.Optional(ProviderRecoveryStallSchema),
    fallback: Type.Optional(ProviderRecoveryFallbackSchema),
  },
  { additionalProperties: false }
);
export type ProviderRecoverySnapshot = Static<typeof ProviderRecoverySnapshotSchema>;

export const ProviderRecoveryProjectionSchema = Runtime(
  Type.Object(
    {
      version: Type.Literal(1),
      generation: Type.String({
        minLength: 1,
        maxLength: PROVIDER_RECOVERY_GENERATION_MAX_CHARS,
        pattern: '^[^\u0000-\u001f\u007f]+$',
      }),
      revision: BoundedCounterSchema,
      snapshot: Type.Union([ProviderRecoverySnapshotSchema, Type.Null()]),
    },
    { additionalProperties: false }
  )
);
export type ProviderRecoveryProjection = Static<
  typeof ProviderRecoveryProjectionSchema
>;

export function normalizeProviderRecoveryIdentity(value: string): string {
  const normalized = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join('')
    .trim()
    .slice(0, PROVIDER_RECOVERY_IDENTITY_MAX_CHARS);
  if (!normalized) throw new Error('Provider recovery identity is empty');
  if (normalized.includes('://')) {
    throw new Error('Provider recovery identity cannot be a URL');
  }
  return normalized;
}

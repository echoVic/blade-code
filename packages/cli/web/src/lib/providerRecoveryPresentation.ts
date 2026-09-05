import type { ProviderRecoveryProjection } from '@api/schemas';
import type { TranslationKey } from '@/i18n';

export interface ProviderRecoveryPresentation {
  titleKey: TranslationKey;
  detailKey: TranslationKey;
  params: Record<string, string | number>;
  compactKey: TranslationKey;
}

function seconds(milliseconds: number | undefined): number {
  return Math.max(0, Math.ceil((milliseconds ?? 0) / 1_000));
}

export function providerRecoveryCountdownSeconds(
  recovery: ProviderRecoveryProjection,
  now = Date.now()
): number | undefined {
  const nextActionAt = recovery.snapshot?.nextActionAt;
  return nextActionAt === undefined ? undefined : seconds(nextActionAt - now);
}

export function presentProviderRecovery(
  recovery: ProviderRecoveryProjection | null,
  now = Date.now()
): ProviderRecoveryPresentation | null {
  const snapshot = recovery?.snapshot;
  if (!snapshot) return null;
  const countdown = providerRecoveryCountdownSeconds(recovery, now) ?? 0;
  const retry = snapshot.retry;
  const admission = snapshot.admission;
  const stall = snapshot.stall;
  const fallback = snapshot.fallback;
  const shared = {
    seconds: countdown,
    attempt: retry?.attempt ?? 0,
    maxRetries: retry?.maxRetries ?? 0,
    budgetSeconds: seconds(retry?.recoveryRemainingMs),
    position: admission?.queuePosition ?? 0,
    depth: admission
      ? Math.max(admission.queueDepth, admission.queuePosition)
      : 0,
    scope: admission?.scope ?? '',
    waitSeconds: seconds(admission?.waitMs),
    stallSeconds: seconds(stall?.durationMs),
    timeoutSeconds: seconds(stall?.timeoutMs),
    from: fallback?.from.model ?? '',
    to: fallback?.to.model ?? '',
    candidate: fallback?.candidate ?? 0,
    candidateCount: fallback?.candidateCount ?? 0,
  };
  switch (snapshot.activity) {
    case 'admission_wait':
      return {
        titleKey: 'chat.providerRecovery.admission',
        detailKey: 'chat.providerRecovery.admissionDetail',
        compactKey: 'chat.providerRecovery.admissionCompact',
        params: shared,
      };
    case 'retry_wait':
      return {
        titleKey:
          snapshot.reason === 'rate_limit'
            ? 'chat.providerRecovery.rateLimit'
            : 'chat.providerRecovery.retryWait',
        detailKey: 'chat.providerRecovery.retryDetail',
        compactKey: 'chat.providerRecovery.retryCompact',
        params: shared,
      };
    case 'retry_attempt':
      return {
        titleKey: 'chat.providerRecovery.retryAttempt',
        detailKey: 'chat.providerRecovery.retryDetail',
        compactKey: 'chat.providerRecovery.retryCompact',
        params: shared,
      };
    case 'circuit_open':
      return {
        titleKey: 'chat.providerRecovery.circuit',
        detailKey: 'chat.providerRecovery.circuitDetail',
        compactKey: 'chat.providerRecovery.circuitCompact',
        params: shared,
      };
    case 'circuit_probe':
      return {
        titleKey: 'chat.providerRecovery.probe',
        detailKey: 'chat.providerRecovery.probeDetail',
        compactKey: 'chat.providerRecovery.probeCompact',
        params: shared,
      };
    case 'stream_stall':
      return {
        titleKey: stall?.outputStarted
          ? 'chat.providerRecovery.stallAfterOutput'
          : 'chat.providerRecovery.stall',
        detailKey: 'chat.providerRecovery.stallDetail',
        compactKey: 'chat.providerRecovery.stallCompact',
        params: shared,
      };
    case 'fallback':
      return {
        titleKey: 'chat.providerRecovery.fallback',
        detailKey: 'chat.providerRecovery.fallbackDetail',
        compactKey: 'chat.providerRecovery.fallbackCompact',
        params: shared,
      };
  }
}

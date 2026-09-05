import type { ProviderRecoveryProjection } from '../../api/providerRecoverySchemas.js';

export interface ProviderRecoveryPresentation {
  primary: string;
  secondary: string;
  compact: string;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}

export function providerRecoveryRemainingMs(
  recovery: ProviderRecoveryProjection,
  now = Date.now()
): number | undefined {
  const nextActionAt = recovery.snapshot?.nextActionAt;
  return nextActionAt === undefined ? undefined : Math.max(0, nextActionAt - now);
}

export function formatProviderRecoveryPresentation(
  recovery: ProviderRecoveryProjection | null,
  now = Date.now()
): ProviderRecoveryPresentation | null {
  const snapshot = recovery?.snapshot;
  if (!snapshot) return null;
  const countdown = providerRecoveryRemainingMs(recovery, now);
  const countdownText = countdown === undefined ? undefined : formatDuration(countdown);

  switch (snapshot.activity) {
    case 'admission_wait': {
      const admission = snapshot.admission;
      return {
        primary: '等待 Provider 容量',
        secondary: admission
          ? `队列 ${admission.queuePosition}/${Math.max(admission.queueDepth, admission.queuePosition)} · ${admission.scope} · 已等待 ${formatDuration(admission.waitMs)}`
          : '等待可用请求容量',
        compact: admission
          ? `Provider 排队 · ${admission.queuePosition}/${Math.max(admission.queueDepth, admission.queuePosition)}`
          : 'Provider 排队',
      };
    }
    case 'retry_wait': {
      const retry = snapshot.retry;
      const primary =
        snapshot.reason === 'rate_limit'
          ? `Provider 请求受限${countdownText ? `，${countdownText} 后重试` : ''}`
          : `Provider 暂时不可用${countdownText ? `，${countdownText} 后重试` : ''}`;
      const details = retry
        ? [
            `尝试 ${retry.attempt}/${retry.maxRetries}`,
            retry.recoveryRemainingMs !== undefined
              ? `剩余预算 ${formatDuration(retry.recoveryRemainingMs)}`
              : undefined,
          ].filter((value): value is string => value !== undefined)
        : [];
      return {
        primary,
        secondary: details.join(' · '),
        compact: `${snapshot.reason === 'rate_limit' ? 'Provider 限流' : 'Provider 恢复'}${countdownText ? ` · ${countdownText}` : ''}${retry ? ` · ${retry.attempt}/${retry.maxRetries}` : ''}`,
      };
    }
    case 'retry_attempt': {
      const retry = snapshot.retry;
      return {
        primary: '正在重试 Provider',
        secondary: retry ? `尝试 ${retry.attempt}/${retry.maxRetries}` : '',
        compact: `Provider 重试${retry ? ` · ${retry.attempt}/${retry.maxRetries}` : ''}`,
      };
    }
    case 'circuit_open':
      return {
        primary: `Provider 故障已隔离，等待恢复探测${countdownText ? `（${countdownText}）` : ''}`,
        secondary:
          snapshot.circuit?.recoveryRemainingMs !== undefined
            ? `剩余预算 ${formatDuration(snapshot.circuit.recoveryRemainingMs)}`
            : '',
        compact: `Provider 熔断${countdownText ? ` · ${countdownText}` : ''}`,
      };
    case 'circuit_probe':
      return {
        primary: 'Provider 正在执行恢复探测',
        secondary: '',
        compact: 'Provider 恢复探测',
      };
    case 'stream_stall': {
      const stall = snapshot.stall;
      return {
        primary: stall?.outputStarted
          ? 'Provider 流暂时停滞'
          : 'Provider 尚未返回流数据',
        secondary: stall
          ? `已等待 ${formatDuration(stall.durationMs)} · 超时上限 ${formatDuration(stall.timeoutMs)}`
          : '',
        compact: stall
          ? `Provider 等待 · ${formatDuration(stall.durationMs)}`
          : 'Provider 等待',
      };
    }
    case 'fallback': {
      const fallback = snapshot.fallback;
      return {
        primary: fallback ? `正在切换到 ${fallback.to.model}` : '正在切换模型',
        secondary: fallback
          ? `候选 ${fallback.candidate}/${fallback.candidateCount} · 来源 ${fallback.from.model}`
          : '',
        compact: fallback ? `Provider 切换 · ${fallback.to.model}` : 'Provider 切换',
      };
    }
  }
}

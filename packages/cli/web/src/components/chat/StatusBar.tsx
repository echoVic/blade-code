import {
  derivePromptCacheMetrics,
  formatPromptCacheHitRate,
} from '@api/promptCacheMetrics';
import { HelpCircle } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { type TranslationKey, useT } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/store/session';

const PHASE_LABEL_KEYS: Record<string, TranslationKey | ''> = {
  running: 'status.phase.running',
  compacting: 'status.phase.compacting',
  recovering_context: 'status.phase.recoveringContext',
  switching_model: 'status.phase.switchingModel',
  waiting_permission: 'status.phase.waitingPermission',
  error: 'status.phase.error',
  idle: '',
} as const;

const CACHE_BREAK_REASON_KEYS: Record<string, TranslationKey> = {
  model_changed: 'status.cacheBreak.model',
  system_prompt_changed: 'status.cacheBreak.system',
  tools_changed: 'status.cacheBreak.tools',
  request_policy_changed: 'status.cacheBreak.policy',
  ttl_expired: 'status.cacheBreak.ttl',
  server_side: 'status.cacheBreak.server',
};

const formatTokens = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
};

const formatDurationMs = (milliseconds: number) => {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
};

export function StatusBar() {
  const t = useT();
  const tokenUsage = useSessionStore((state) => state.tokenUsage);
  const isStreaming = useSessionStore((state) => state.isStreaming);
  const agentPhase = useSessionStore((state) => state.agentPhase);
  const providerAdmission = useSessionStore((state) => state.providerAdmission);
  const providerCircuit = useSessionStore((state) => state.providerCircuit);
  const providerRetry = useSessionStore((state) => state.providerRetry);
  const providerStall = useSessionStore((state) => state.providerStall);
  const actionStationarity = useSessionStore((state) => state.actionStationarity);
  const phaseKey = PHASE_LABEL_KEYS[agentPhase] ?? '';
  const retryDelay =
    providerRetry?.delayMs !== undefined
      ? ` · ${Math.max(0, Math.ceil(providerRetry.delayMs / 1000))}s`
      : '';
  const phaseLabel = actionStationarity
    ? `${t(
        actionStationarity.phase === 'halted'
          ? 'status.phase.actionStationarityStopped'
          : 'status.phase.actionStationarityRecovering'
      )} · ${actionStationarity.toolName} · ${actionStationarity.runLength}/${actionStationarity.haltThreshold}`
    : providerCircuit
      ? providerCircuit.phase === 'probe'
        ? 'Provider · Recovery probe'
        : `Provider · Circuit open${
            providerCircuit.retryAfterMs !== undefined
              ? ` · probe in ${formatDurationMs(providerCircuit.retryAfterMs)}`
              : ''
          }${
            providerCircuit.recoveryRemainingMs !== undefined
              ? ` · ${formatDurationMs(providerCircuit.recoveryRemainingMs)}`
              : ''
          }`
      : providerAdmission
        ? `Provider · Capacity queue ${providerAdmission.queuePosition}/${Math.max(
            providerAdmission.queueDepth,
            providerAdmission.queuePosition
          )} · ${providerAdmission.scope} · ${formatDurationMs(providerAdmission.waitMs)}`
        : providerRetry
          ? providerRetry.mode === 'bounded_foreground'
            ? `Provider · Bounded recovery · ${providerRetry.attempt}/${providerRetry.maxRetries} · ${formatDurationMs(providerRetry.recoveryRemainingMs ?? 0)}`
            : `Provider · ${t('chat.error.action.retryingTask')} · ${providerRetry.attempt}/${providerRetry.maxRetries}${retryDelay}`
          : providerStall
            ? `${t('status.phase.providerStall')} · ${Math.ceil(providerStall.durationMs / 1000)}s / ${Math.ceil(providerStall.timeoutMs / 1000)}s`
            : phaseKey
              ? t(phaseKey)
              : '';

  const usagePercent =
    tokenUsage.maxContextTokens > 0
      ? Math.round((tokenUsage.totalTokens / tokenUsage.maxContextTokens) * 100)
      : 0;
  const promptCache = derivePromptCacheMetrics(tokenUsage);
  const promptCacheHitRate = formatPromptCacheHitRate(promptCache.hitRate);

  const clamped = Math.min(usagePercent, 100);
  // Segmented ticks — 20 cells, each cell = 5%. Feels more like an instrument
  // than a solid bar; still shows a single continuous fill via CSS width.
  const state = usagePercent > 95 ? 'danger' : usagePercent > 80 ? 'warn' : 'safe';

  return (
    <div className="flex items-center gap-2 border-t border-[hsl(var(--deck-hairline))] bg-[hsl(var(--deck-canvas-veil))]/70 px-3 py-2 font-mono text-[11px] text-[hsl(var(--deck-ink-muted))] backdrop-blur-sm sm:gap-4 sm:px-5">
      <div className="flex items-center gap-2 sm:gap-3">
        <span className="deck-eyebrow text-[hsl(var(--deck-ink-faint))]">
          {t('status.context')}
        </span>
        <span className="flex gap-1 items-baseline tabular-nums">
          <span
            className={cn(
              'text-[12px] font-medium',
              state === 'safe' && 'text-[hsl(var(--deck-ink))]',
              state === 'warn' && 'text-amber-600 dark:text-amber-400',
              state === 'danger' && 'text-red-600 dark:text-red-400'
            )}
          >
            {formatTokens(tokenUsage.totalTokens)}
          </span>
          <span className="text-[hsl(var(--deck-ink-faint))]">
            / {formatTokens(tokenUsage.maxContextTokens)}
          </span>
        </span>
        {tokenUsage.isDefaultMaxTokens && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="h-3 w-3 cursor-help text-[hsl(var(--deck-ink-faint))]" />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[220px]">
                <p className="text-xs">{t('status.tokenLimitTooltip')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        {/* Segmented context meter */}
        <div
          className="relative hidden h-2 w-32 overflow-hidden rounded-sm border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] sm:block"
          aria-hidden="true"
        >
          <div
            className={cn(
              'absolute inset-y-0 left-0 transition-[width] duration-300',
              state === 'safe' && 'bg-[hsl(var(--deck-accent))]',
              state === 'warn' && 'bg-amber-500',
              state === 'danger' && 'bg-red-500'
            )}
            style={{ width: `${clamped}%` }}
          />
          {/* Segment ticks — 4 vertical rules at 25/50/75/100 to give an instrument feel */}
          <div className="flex absolute inset-0 pointer-events-none">
            {[25, 50, 75].map((pos) => (
              <span
                key={pos}
                className="absolute inset-y-0 w-px bg-[hsl(var(--deck-canvas-veil))]/60"
                style={{ left: `${pos}%` }}
              />
            ))}
          </div>
        </div>

        <span
          className={cn(
            'w-10 text-right tabular-nums text-[hsl(var(--deck-ink-faint))]',
            state === 'warn' && 'text-amber-600 dark:text-amber-400',
            state === 'danger' && 'text-red-600 dark:text-red-400'
          )}
        >
          {usagePercent}%
        </span>
      </div>

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="flex shrink-0 cursor-help items-baseline gap-2 border-l border-[hsl(var(--deck-hairline))] pl-2 sm:pl-4"
              data-testid="prompt-cache-hit-rate"
              aria-label={`${t('status.cache')} ${promptCacheHitRate}`}
            >
              <span className="deck-eyebrow text-[hsl(var(--deck-ink-faint))]">
                {t('status.cache')}
              </span>
              <span
                className={cn(
                  'tabular-nums',
                  promptCache.hitRate === undefined
                    ? 'text-[hsl(var(--deck-ink-faint))]'
                    : 'font-medium text-[hsl(var(--deck-accent))]'
                )}
              >
                {promptCacheHitRate}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[280px]">
            {promptCache.hitRate === undefined ? (
              <p className="text-xs">{t('status.cacheUnavailable')}</p>
            ) : (
              <div className="space-y-1 text-xs">
                <p>{t('status.cacheTooltip')}</p>
                <p className="font-mono tabular-nums">
                  {t('status.cacheDetails', {
                    read: formatTokens(promptCache.cacheReadTokens),
                    write: formatTokens(promptCache.cacheWriteTokens),
                    uncached: formatTokens(promptCache.uncachedInputTokens),
                  })}
                </p>
                {tokenUsage.cacheBreak && (
                  <p className="text-[hsl(var(--deck-accent))]">
                    {t('status.cacheBreak', {
                      reason: t(
                        CACHE_BREAK_REASON_KEYS[tokenUsage.cacheBreak.reason] ??
                          'status.cacheBreak.server'
                      ),
                      previous: formatTokens(
                        tokenUsage.cacheBreak.previousCacheReadTokens
                      ),
                      current: formatTokens(tokenUsage.cacheBreak.cacheReadTokens),
                    })}
                  </p>
                )}
              </div>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <div className="flex-1" />

      {isStreaming && phaseLabel && (
        <div className="flex gap-2 items-center">
          <span className="deck-pulse-dot" />
          <span className="text-[hsl(var(--deck-accent))]">{phaseLabel}</span>
        </div>
      )}
    </div>
  );
}

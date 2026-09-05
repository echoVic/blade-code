import type { ProviderRecoveryProjection } from '@api/schemas';
import { Loader2, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useT } from '@/i18n';
import { presentProviderRecovery } from '@/lib/providerRecoveryPresentation';

interface ProviderRecoveryBannerProps {
  recovery: ProviderRecoveryProjection | null;
  stopping: boolean;
  onStop: () => void;
}

export function ProviderRecoveryBanner({
  recovery,
  stopping,
  onStop,
}: ProviderRecoveryBannerProps) {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  const nextActionAt = recovery?.snapshot?.nextActionAt;

  useEffect(() => {
    if (nextActionAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [nextActionAt]);

  const presentation = presentProviderRecovery(recovery, now);
  if (!presentation) return null;

  return (
    <section
      role="status"
      aria-live="polite"
      data-provider-recovery-banner
      className="mx-4 mb-2 flex min-h-12 items-center gap-3 rounded-lg border border-amber-300/70 bg-amber-50/80 px-3 py-2 text-amber-950 shadow-sm dark:border-amber-800/60 dark:bg-amber-950/35 dark:text-amber-100 md:mx-6"
    >
      <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold">
          {t(presentation.titleKey, presentation.params)}
        </div>
        <div className="mt-0.5 truncate font-mono text-[10px] opacity-80">
          {t(presentation.detailKey, presentation.params)}
        </div>
      </div>
      <button
        type="button"
        data-provider-recovery-stop
        onClick={onStop}
        disabled={stopping}
        className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md border border-amber-400/70 bg-white/70 px-2.5 text-xs font-medium transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-wait disabled:opacity-60 dark:border-amber-700 dark:bg-amber-950/50 dark:hover:bg-amber-900/50"
      >
        {stopping ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Square className="h-3 w-3 fill-current" aria-hidden />
        )}
        {t(stopping ? 'chat.input.action.stopping' : 'chat.providerRecovery.stop')}
      </button>
    </section>
  );
}

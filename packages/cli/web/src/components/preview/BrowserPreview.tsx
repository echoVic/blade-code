import { FileCode, Loader2 } from 'lucide-react';
import { useLocale } from '@/i18n';

export type BrowserLoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface BrowserPreviewProps {
  url: string | null;
  revision: number;
  loadState: BrowserLoadState;
  onLoad: () => void;
  onError: () => void;
}

const COPY = {
  en: {
    frameTitle: 'Project preview',
    empty: 'No preview open',
    loading: 'Loading preview…',
  },
  zh: {
    frameTitle: '项目预览',
    empty: '未打开项目预览',
    loading: '正在加载预览…',
  },
} as const;

export function BrowserPreview({
  url,
  revision,
  loadState,
  onLoad,
  onError,
}: BrowserPreviewProps) {
  const { locale } = useLocale();
  const copy = COPY[locale];

  return (
    <section
      data-preview-browser
      className="relative h-full min-h-0 overflow-hidden bg-white"
    >
      {url ? (
        <>
          <iframe
            key={`${url}:${revision}`}
            data-preview-browser-frame
            src={url}
            title={copy.frameTitle}
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
            referrerPolicy="no-referrer"
            onLoad={onLoad}
            onError={onError}
            className="block h-full w-full border-0 bg-white"
          />
          {loadState === 'loading' && (
            <div className="pointer-events-none absolute inset-x-0 top-0 flex h-8 items-center justify-center border-b border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-canvas)/0.92)] backdrop-blur-sm">
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin text-[hsl(var(--deck-accent))]" />
              <span className="font-mono text-[10.5px] text-[hsl(var(--deck-ink-muted))]">
                {copy.loading}
              </span>
            </div>
          )}
        </>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-[hsl(var(--deck-canvas-veil))] text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] text-[hsl(var(--deck-ink-faint))]">
            <FileCode className="h-5 w-5" />
          </div>
          <span className="font-mono text-[11px] text-[hsl(var(--deck-ink-muted))]">
            {copy.empty}
          </span>
        </div>
      )}
    </section>
  );
}

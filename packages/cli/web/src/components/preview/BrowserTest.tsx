import type {
  BrowserAction,
  BrowserDiagnosticEntry,
  BrowserObservation,
} from '@api/browserSchemas';
import {
  AlertTriangle,
  AppWindow,
  ArrowDown,
  ArrowUp,
  Braces,
  Loader2,
  MousePointer2,
  RefreshCw,
  RotateCcw,
  Send,
  TerminalSquare,
  Wifi,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/i18n';
import { cn } from '@/lib/utils';
import type { BrowserInspectKind } from '@/services/webBrowserService';

type InspectorTab = 'dom' | BrowserInspectKind;

interface BrowserTestProps {
  sessionAvailable: boolean;
  observation: BrowserObservation | null;
  screenshotUrl: string | null;
  busy: boolean;
  error: string | null;
  diagnostics: Partial<Record<BrowserInspectKind, BrowserDiagnosticEntry[]>>;
  diagnosticsLoading: BrowserInspectKind | null;
  onInteract: (action: BrowserAction, ref?: string) => Promise<void>;
  onInspect: (target: BrowserInspectKind) => Promise<void>;
  onSnapshot: () => Promise<void>;
  onReset: () => Promise<void>;
}

const COPY = {
  en: {
    unavailable: 'No active Session',
    empty: 'No Test page',
    screenshotAlt: 'Chromium page',
    selectedRef: 'Selected ref',
    noRef: 'No ref selected',
    valuePlaceholder: 'Input value',
    click: 'Click selected element',
    fill: 'Fill selected control',
    scrollUp: 'Scroll up',
    scrollDown: 'Scroll down',
    snapshot: 'Refresh snapshot',
    reset: 'Reset Test browser',
    dom: 'DOM',
    console: 'Console',
    network: 'Network',
    errors: 'Errors',
    noEntries: 'No entries',
  },
  zh: {
    unavailable: '没有活动 Session',
    empty: '未打开测试页面',
    screenshotAlt: 'Chromium 页面',
    selectedRef: '已选 ref',
    noRef: '未选择 ref',
    valuePlaceholder: '输入内容',
    click: '点击已选元素',
    fill: '填入已选控件',
    scrollUp: '向上滚动',
    scrollDown: '向下滚动',
    snapshot: '刷新快照',
    reset: '重置测试浏览器',
    dom: 'DOM',
    console: '控制台',
    network: '网络',
    errors: '错误',
    noEntries: '暂无记录',
  },
} as const;

export interface BrowserSnapshotLine {
  text: string;
  ref?: string;
}

export function parseBrowserSnapshot(snapshot: string): BrowserSnapshotLine[] {
  return snapshot.split('\n').map((text) => ({
    text,
    ref: text.match(/\[ref=([a-z][a-z0-9]*)\]/)?.[1],
  }));
}

function diagnosticText(entry: BrowserDiagnosticEntry): string {
  return [entry.kind, entry.level, entry.method, entry.status, entry.url, entry.text]
    .filter((value) => value !== undefined && value !== '')
    .join(' · ');
}

export function BrowserTest({
  sessionAvailable,
  observation,
  screenshotUrl,
  busy,
  error,
  diagnostics,
  diagnosticsLoading,
  onInteract,
  onInspect,
  onSnapshot,
  onReset,
}: BrowserTestProps) {
  const { locale } = useLocale();
  const copy = COPY[locale];
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('dom');
  const snapshotLines = useMemo(
    () => parseBrowserSnapshot(observation?.snapshot ?? ''),
    [observation?.snapshot]
  );
  const activeDiagnostics =
    inspectorTab === 'dom' ? [] : (diagnostics[inspectorTab] ?? []);

  useEffect(() => {
    setSelectedRef(null);
  }, [observation?.snapshotId]);

  const selectInspector = (tab: InspectorTab) => {
    setInspectorTab(tab);
    if (tab !== 'dom') void onInspect(tab);
  };

  return (
    <section
      data-browser-test
      data-browser-snapshot-id={observation?.snapshotId}
      className="flex h-full min-h-0 flex-col bg-[hsl(var(--deck-canvas))]"
    >
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-neutral-950">
        {screenshotUrl ? (
          <img
            data-browser-test-screenshot
            src={screenshotUrl}
            alt={copy.screenshotAlt}
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex flex-col items-center gap-3 text-[hsl(var(--deck-ink-faint))]">
            <AppWindow className="h-7 w-7" />
            <span className="font-mono text-[11px]">
              {sessionAvailable ? copy.empty : copy.unavailable}
            </span>
          </div>
        )}
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/35">
            <Loader2 className="h-5 w-5 animate-spin text-white" />
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="absolute inset-x-0 bottom-0 border-t border-red-500/30 bg-red-950/90 px-3 py-2 font-mono text-[10.5px] text-red-200"
          >
            {error}
          </div>
        )}
      </div>

      <div className="flex h-10 shrink-0 items-center gap-1 border-y border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface-2))] px-2">
        <span
          title={selectedRef ? `${copy.selectedRef}: ${selectedRef}` : copy.noRef}
          className="w-20 shrink-0 truncate font-mono text-[10px] text-[hsl(var(--deck-ink-muted))]"
        >
          {selectedRef ?? 'ref'}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={!selectedRef || busy}
          title={copy.click}
          aria-label={copy.click}
          onClick={() => {
            if (selectedRef) void onInteract({ kind: 'click' }, selectedRef);
          }}
          className="h-7 w-7 rounded-md"
        >
          <MousePointer2 className="h-3.5 w-3.5" />
        </Button>
        <div className="flex h-7 min-w-0 flex-1 items-center border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-canvas))] px-2">
          <input
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            placeholder={copy.valuePlaceholder}
            aria-label={copy.valuePlaceholder}
            className="min-w-0 flex-1 bg-transparent font-mono text-[10.5px] outline-none"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={!selectedRef || !inputValue || busy}
            title={copy.fill}
            aria-label={copy.fill}
            onClick={() => {
              if (selectedRef) {
                void onInteract({ kind: 'fill', value: inputValue }, selectedRef);
              }
            }}
            className="h-6 w-6 rounded-md"
          >
            <Send className="h-3 w-3" />
          </Button>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={!observation || busy}
          title={copy.scrollUp}
          aria-label={copy.scrollUp}
          onClick={() =>
            void onInteract({ kind: 'scroll', direction: 'up', amount: 560 })
          }
          className="h-7 w-7 rounded-md"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={!observation || busy}
          title={copy.scrollDown}
          aria-label={copy.scrollDown}
          onClick={() =>
            void onInteract({ kind: 'scroll', direction: 'down', amount: 560 })
          }
          className="h-7 w-7 rounded-md"
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={!observation || busy}
          title={copy.snapshot}
          aria-label={copy.snapshot}
          onClick={() => void onSnapshot()}
          className="h-7 w-7 rounded-md"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={!sessionAvailable || busy}
          title={copy.reset}
          aria-label={copy.reset}
          onClick={() => {
            setSelectedRef(null);
            void onReset();
          }}
          className="h-7 w-7 rounded-md"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex h-[38%] min-h-32 shrink-0 flex-col overflow-hidden">
        <div
          role="tablist"
          className="grid h-8 shrink-0 grid-cols-4 border-b border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))]"
        >
          {(
            [
              ['dom', copy.dom, Braces],
              ['console', copy.console, TerminalSquare],
              ['network', copy.network, Wifi],
              ['page-errors', copy.errors, AlertTriangle],
            ] as const
          ).map(([tab, label, Icon]) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={inspectorTab === tab}
              onClick={() => selectInspector(tab)}
              className={cn(
                'flex min-w-0 items-center justify-center gap-1 border-r border-[hsl(var(--deck-border))] px-1 font-mono text-[10px] text-[hsl(var(--deck-ink-muted))] last:border-r-0',
                inspectorTab === tab &&
                  'bg-[hsl(var(--deck-canvas-veil))] text-[hsl(var(--deck-ink))]'
              )}
            >
              <Icon className="h-3 w-3 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-[hsl(var(--deck-canvas-veil))] p-2 font-mono text-[10px] leading-5 text-[hsl(var(--deck-ink-muted))]">
          {inspectorTab === 'dom' ? (
            snapshotLines.length > 0 ? (
              snapshotLines.map((line, index) =>
                line.ref ? (
                  <button
                    key={`${line.ref}:${index}`}
                    type="button"
                    data-browser-ref={line.ref}
                    onClick={() => setSelectedRef(line.ref ?? null)}
                    className={cn(
                      'block w-full whitespace-pre-wrap px-1 text-left hover:bg-[hsl(var(--deck-accent)/0.08)]',
                      selectedRef === line.ref &&
                        'bg-[hsl(var(--deck-accent)/0.12)] text-[hsl(var(--deck-ink))]'
                    )}
                  >
                    {line.text}
                  </button>
                ) : (
                  <div
                    key={`${line.text}:${index}`}
                    className="whitespace-pre-wrap px-1"
                  >
                    {line.text}
                  </div>
                )
              )
            ) : (
              <div className="flex h-full items-center justify-center">
                {copy.noEntries}
              </div>
            )
          ) : diagnosticsLoading === inspectorTab ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : activeDiagnostics.length > 0 ? (
            activeDiagnostics.map((entry) => (
              <div
                key={entry.sequence}
                className="border-b border-[hsl(var(--deck-border))] px-1 py-1 last:border-b-0"
              >
                {diagnosticText(entry)}
              </div>
            ))
          ) : (
            <div className="flex h-full items-center justify-center">
              {copy.noEntries}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

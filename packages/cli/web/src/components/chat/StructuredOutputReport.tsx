import { Braces, Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { useT } from '@/i18n';

export interface StructuredOutputReportData {
  output: Record<string, unknown>;
  schemaDigest?: string;
}

export function parseStructuredOutputReport(
  value: unknown
): StructuredOutputReportData | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !record.output ||
    typeof record.output !== 'object' ||
    Array.isArray(record.output)
  ) {
    return undefined;
  }
  return {
    output: record.output as Record<string, unknown>,
    ...(typeof record.schemaDigest === 'string'
      ? { schemaDigest: record.schemaDigest }
      : {}),
  };
}

export function StructuredOutputReport({
  report,
}: {
  report: StructuredOutputReportData;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const content = JSON.stringify(report.output, null, 2);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_400);
    } catch {
      // Clipboard access can be unavailable in insecure browser contexts.
    }
  };

  return (
    <section
      data-structured-output
      className="overflow-hidden rounded-lg border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))]"
    >
      <header className="flex min-h-9 items-center justify-between gap-3 border-b border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface-2))] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Braces className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--deck-accent))]" />
          <span className="font-mono text-[11px] font-semibold text-[hsl(var(--deck-ink))]">
            {t('chat.structuredOutput.title')}
          </span>
          {report.schemaDigest && (
            <span
              title={report.schemaDigest}
              className="truncate font-mono text-[9px] text-[hsl(var(--deck-ink-faint))]"
            >
              sha256:{report.schemaDigest.slice(0, 10)}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={copy}
          aria-label={t('chat.structuredOutput.copy')}
          title={t('chat.structuredOutput.copy')}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[hsl(var(--deck-ink-faint))] hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))]"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-[hsl(var(--deck-accent))]" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </header>
      <pre className="max-h-[440px] overflow-auto whitespace-pre p-3 font-mono text-[11px] leading-5 text-[hsl(var(--deck-ink))]">
        {content}
      </pre>
    </section>
  );
}

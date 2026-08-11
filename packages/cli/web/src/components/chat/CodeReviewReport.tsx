import { type TranslationKey, useT } from '@/i18n';
import { cn } from '@/lib/utils';

type ReviewStatus = 'completed' | 'stale' | 'failed' | 'aborted' | 'interrupted';

interface ReviewFinding {
  title: string;
  body: string;
  priority: 0 | 1 | 2 | 3;
  confidenceScore: number;
  codeLocation: {
    path: string;
    lineStart: number;
    lineEnd: number;
  };
}

export interface CodeReviewReportData {
  status: ReviewStatus;
  target: {
    kind: 'uncommitted' | 'base' | 'commit';
    label: string;
    reference?: string;
  };
  overallExplanation: string;
  findings: ReviewFinding[];
  error?: string;
}

const STATUSES = new Set<ReviewStatus>([
  'completed',
  'stale',
  'failed',
  'aborted',
  'interrupted',
]);

const STATUS_KEYS: Record<ReviewStatus, TranslationKey> = {
  completed: 'chat.review.status.completed',
  stale: 'chat.review.status.stale',
  failed: 'chat.review.status.failed',
  aborted: 'chat.review.status.aborted',
  interrupted: 'chat.review.status.interrupted',
};

const STATUS_STYLES: Record<ReviewStatus, string> = {
  completed:
    'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20',
  stale: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20',
  failed: 'bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/20',
  aborted: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300 border-zinc-500/20',
  interrupted: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20',
};

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseFinding(value: unknown): ReviewFinding | undefined {
  const finding = objectValue(value);
  const location = objectValue(finding?.codeLocation);
  const priority = finding?.priority;
  const confidenceScore = finding?.confidenceScore;
  const lineStart = location?.lineStart;
  const lineEnd = location?.lineEnd;
  if (
    typeof finding?.title !== 'string' ||
    typeof finding.body !== 'string' ||
    (priority !== 0 && priority !== 1 && priority !== 2 && priority !== 3) ||
    typeof confidenceScore !== 'number' ||
    !Number.isFinite(confidenceScore) ||
    typeof location?.path !== 'string' ||
    !Number.isInteger(lineStart) ||
    !Number.isInteger(lineEnd)
  ) {
    return undefined;
  }
  return {
    title: finding.title,
    body: finding.body,
    priority,
    confidenceScore,
    codeLocation: {
      path: location.path,
      lineStart: lineStart as number,
      lineEnd: lineEnd as number,
    },
  };
}

export function parseCodeReviewReport(
  value: unknown
): CodeReviewReportData | undefined {
  const report = objectValue(value);
  const target = objectValue(report?.target);
  if (
    report?.phase !== 'completed' ||
    typeof report.status !== 'string' ||
    !STATUSES.has(report.status as ReviewStatus) ||
    typeof target?.label !== 'string' ||
    (target.kind !== 'uncommitted' &&
      target.kind !== 'base' &&
      target.kind !== 'commit') ||
    typeof report.overallExplanation !== 'string' ||
    !Array.isArray(report.findings)
  ) {
    return undefined;
  }
  const findings = report.findings.map(parseFinding);
  if (findings.some((finding) => finding === undefined)) return undefined;
  return {
    status: report.status as ReviewStatus,
    target: {
      kind: target.kind,
      label: target.label,
      ...(typeof target.reference === 'string' ? { reference: target.reference } : {}),
    },
    overallExplanation: report.overallExplanation,
    findings: findings as ReviewFinding[],
    ...(typeof report.error === 'string' ? { error: report.error } : {}),
  };
}

function locationLabel(finding: ReviewFinding): string {
  const { path, lineStart, lineEnd } = finding.codeLocation;
  return lineStart === lineEnd
    ? `${path}:L${lineStart}`
    : `${path}:L${lineStart}-${lineEnd}`;
}

export function CodeReviewReport({ report }: { report: CodeReviewReportData }) {
  const t = useT();
  const targetLabel =
    report.target.kind === 'uncommitted'
      ? t('chat.review.target.uncommitted')
      : report.target.kind === 'base'
        ? t('chat.review.target.base', {
            ref: report.target.reference ?? report.target.label,
          })
        : t('chat.review.target.commit', {
            ref: report.target.reference ?? report.target.label,
          });
  return (
    <section
      data-code-review-report
      className="overflow-hidden rounded-xl border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))]"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[hsl(var(--deck-hairline))] bg-[hsl(var(--deck-surface-2))]/60 px-4 py-3">
        <div>
          <h3 className="text-[13px] font-semibold text-[hsl(var(--deck-ink))]">
            {t('chat.review.title')}
          </h3>
          <p className="mt-0.5 font-mono text-[10.5px] text-[hsl(var(--deck-ink-faint))]">
            {t('chat.review.target')}: {targetLabel}
          </p>
        </div>
        <span
          className={cn(
            'rounded-full border px-2.5 py-1 font-mono text-[10.5px] font-medium',
            STATUS_STYLES[report.status]
          )}
        >
          {t('chat.review.status')}: {t(STATUS_KEYS[report.status])}
        </span>
      </header>

      <div className="space-y-4 px-4 py-3.5">
        <p className="whitespace-pre-wrap text-[13px] leading-6 text-[hsl(var(--deck-ink-muted))]">
          {report.overallExplanation}
        </p>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="deck-eyebrow text-[hsl(var(--deck-ink-faint))]">
              {t('chat.review.findings')}
            </h4>
            <span className="font-mono text-[10px] text-[hsl(var(--deck-ink-faint))]">
              {report.findings.length}
            </span>
          </div>
          {report.findings.length === 0 ? (
            <div className="rounded-lg bg-[hsl(var(--deck-surface-2))] px-3 py-2.5 text-[12px] text-[hsl(var(--deck-ink-muted))]">
              {t('chat.review.noFindings')}
            </div>
          ) : (
            <ol className="space-y-2">
              {report.findings.map((finding, index) => (
                <li
                  key={`${finding.codeLocation.path}:${finding.codeLocation.lineStart}:${index}`}
                  className="rounded-lg border border-[hsl(var(--deck-hairline))] bg-[hsl(var(--deck-canvas-veil))] px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h5 className="text-[12.5px] font-medium leading-5 text-[hsl(var(--deck-ink))]">
                      {finding.title}
                    </h5>
                    <span className="shrink-0 font-mono text-[10px] text-[hsl(var(--deck-ink-faint))]">
                      {t('chat.review.confidence', {
                        value: finding.confidenceScore.toFixed(2),
                      })}
                    </span>
                  </div>
                  <code className="mt-1 block text-[10.5px] text-[hsl(var(--deck-accent))]">
                    {locationLabel(finding)}
                  </code>
                  <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-5 text-[hsl(var(--deck-ink-muted))]">
                    {finding.body}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>

        {report.error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px] text-red-700 dark:text-red-300">
            <span className="font-medium">{t('chat.review.error')}:</span>{' '}
            {report.error}
          </div>
        )}
      </div>
    </section>
  );
}

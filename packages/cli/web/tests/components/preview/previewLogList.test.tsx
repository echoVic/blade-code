// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewLogList } from '@/components/preview/PreviewLogList';
import type {
  PreviewActivitySegment,
  PreviewLogEntry,
  PreviewRunSummary,
} from '@/components/preview/previewFilters';

vi.mock('@/i18n', () => ({
  useT: () => (key: string) => key,
}));

describe('PreviewLogList', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('shows persisted cost telemetry and a timeline view', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    const logs: PreviewLogEntry[] = [];
    const runs: PreviewRunSummary[] = [
      {
        id: 'turn-1',
        startedAt: 6_000,
        completedAt: 10_000,
        durationMs: 4_000,
        turnsCount: 3,
        toolCallsCount: 5,
        usage: {
          inputTokens: 2_400,
          outputTokens: 300,
          cacheReadTokens: 1_500,
          cacheWriteTokens: 200,
          uncachedInputTokens: 700,
          estimatedCostUsd: 0.0042,
        },
      },
    ];
    const activities: PreviewActivitySegment[] = [
      {
        id: 'model-1',
        kind: 'model',
        label: 'Model call',
        startedAt: 6_000,
        completedAt: 7_500,
      },
      {
        id: 'tool-1',
        kind: 'tool',
        label: 'Read',
        status: 'success',
        startedAt: 7_500,
        completedAt: 8_500,
      },
      {
        id: 'model-2',
        kind: 'model',
        label: 'Model call',
        startedAt: 8_500,
        completedAt: 10_000,
      },
    ];

    await act(async () =>
      root.render(<PreviewLogList logs={logs} runs={runs} activities={activities} />)
    );

    expect(container.textContent).toContain('$0.0042');
    expect(container.textContent).toContain('62.5%');
    expect(container.textContent).toContain('preview.logs.view.timeline');
    expect(
      container.querySelector(
        '[aria-label*="preview.logs.timeline.tooltip.cost"][aria-label*="$0.0042"]'
      )
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[aria-label*="preview.logs.timeline.tooltip.input"][aria-label*="2,400"]'
      )
    ).not.toBeNull();
    expect(container.querySelectorAll('[data-timeline-kind="model"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-timeline-kind="tools"]')).toHaveLength(1);
    const cacheMarker = container.querySelector<HTMLElement>(
      '[data-timeline-kind="cache"]'
    );
    expect(cacheMarker?.style.width).not.toBe('0%');
  });
});

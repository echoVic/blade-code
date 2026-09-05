// @vitest-environment jsdom

import type {
  MemoryConsolidationProjection,
  TurnActivityProjection,
} from '@api/schemas';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnActivityStrip } from '../../../src/components/chat/TurnActivityStrip';
import { setLocale } from '../../../src/i18n';

const activity: TurnActivityProjection = {
  version: 1,
  generation: 'activity-1',
  revision: 3,
  snapshot: {
    phase: 'executing_tools',
    startedAt: 1_000,
    updatedAt: 2_000,
    turn: 2,
    maxTurns: 20,
    outputStarted: true,
    toolCallsStarted: 5,
    toolCallsCompleted: 3,
    activeTools: [
      { name: 'Read', kind: 'readonly', startedAt: 1_500, progress: 1, total: 4 },
      { name: 'Bash', kind: 'execute', startedAt: 1_700 },
    ],
    activeToolOverflow: 2,
  },
};

describe('TurnActivityStrip', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    setLocale('en');
    vi.useFakeTimers({ now: 66_000 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('renders accessible bounded parallel activity and local elapsed time', () => {
    act(() => root.render(<TurnActivityStrip activity={activity} />));

    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toContain('Running 4 tools');
    expect(status?.textContent).toContain('Read 1/4');
    expect(status?.textContent).toContain('Bash');
    expect(status?.textContent).toContain('+2');
    expect(status?.textContent).toContain('3/5 tools');
    expect(status?.textContent).toContain('turn 2/20');
    expect(status?.textContent).toContain('1m 5s');
    expect(status?.textContent).not.toContain('PRIVATE_PROGRESS_TEXT');
  });

  it('updates elapsed time locally and hides after a clear', () => {
    act(() => root.render(<TurnActivityStrip activity={activity} />));
    expect(container.textContent).toContain('1m 5s');

    act(() => vi.advanceTimersByTime(2_000));
    expect(container.textContent).toContain('1m 7s');

    act(() =>
      root.render(
        <TurnActivityStrip activity={{ ...activity, revision: 4, snapshot: null }} />
      )
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders a bounded project-memory completion notice', () => {
    const memory: MemoryConsolidationProjection = {
      outcome: 'written',
      entries: 2,
      topics: ['conventions'],
    };
    act(() => root.render(<TurnActivityStrip activity={null} memory={memory} />));

    const status = container.querySelector('[data-memory-consolidation-notice]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toContain('Saved 2 project memories');
    expect(status?.textContent).not.toContain('conventions');
  });
});

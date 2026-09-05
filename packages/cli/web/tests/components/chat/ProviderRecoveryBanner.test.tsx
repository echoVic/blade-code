// @vitest-environment jsdom

import type { ProviderRecoveryProjection } from '@api/schemas';
import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderRecoveryBanner } from '../../../src/components/chat/ProviderRecoveryBanner';
import { setLocale } from '../../../src/i18n';

const recovery: ProviderRecoveryProjection = {
  version: 1,
  generation: 'generation-1',
  revision: 1,
  snapshot: {
    activity: 'retry_wait',
    reason: 'rate_limit',
    updatedAt: 1_000,
    nextActionAt: 33_000,
    retry: {
      attempt: 4,
      maxRetries: 12,
      delayMs: 32_000,
      recoveryRemainingMs: 585_000,
    },
  },
};

describe('ProviderRecoveryBanner', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    setLocale('en');
    vi.useFakeTimers({ now: 2_000 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('shows an accessible countdown and invokes the existing Stop action once', () => {
    const onStop = vi.fn();
    act(() => {
      root.render(
        <ProviderRecoveryBanner
          recovery={recovery}
          stopping={false}
          onStop={onStop}
        />
      );
    });

    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toContain('rate limited');
    expect(status?.textContent).toContain('31s');
    expect(status?.textContent).toContain('4/12');

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-provider-recovery-stop]')
        ?.click();
    });
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('updates its local countdown without another runtime event', () => {
    act(() => {
      root.render(
        <ProviderRecoveryBanner recovery={recovery} stopping={false} onStop={vi.fn()} />
      );
    });
    expect(container.textContent).toContain('31s');

    act(() => vi.advanceTimersByTime(2_000));
    expect(container.textContent).toContain('29s');
  });

  it('renders fallback identity and hides itself after an authoritative clear', () => {
    const fallback: ProviderRecoveryProjection = {
      version: 1,
      generation: 'generation-2',
      revision: 1,
      snapshot: {
        activity: 'fallback',
        reason: 'server_error',
        updatedAt: 2_000,
        fallback: {
          from: { provider: 'primary', model: 'model-a' },
          to: { provider: 'secondary', model: 'model-b' },
          candidate: 1,
          candidateCount: 1,
          trigger: { source: 'retry', reason: 'server_error', statusCode: 503 },
        },
      },
    };
    act(() => {
      root.render(
        <ProviderRecoveryBanner recovery={fallback} stopping={false} onStop={vi.fn()} />
      );
    });
    expect(container.textContent).toContain('model-b');
    expect(container.textContent).toContain('model-a');

    act(() => {
      root.render(
        <ProviderRecoveryBanner
          recovery={{ ...fallback, revision: 2, snapshot: null }}
          stopping={false}
          onStop={vi.fn()}
        />
      );
    });
    expect(container.innerHTML).toBe('');
  });
});

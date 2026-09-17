// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  tokenUsage: {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    maxContextTokens: 128_000,
    isDefaultMaxTokens: false,
  },
  isStreaming: true,
  agentPhase: 'running',
  providerRecovery: null,
  turnActivity: {
    generation: 1,
    revision: 1,
    snapshot: {
      phase: 'thinking',
    },
  },
  pendingResume: {
    phase: 'retry_scheduled',
    kind: 'pending_input',
    attempt: 2,
    maxAttempts: 4,
    delayMs: 1_000,
  },
  actionStationarity: null,
  turnRecovery: null,
}));

vi.mock('@/store/session', () => ({
  useSessionStore: (selector: (value: typeof state) => unknown) => selector(state),
}));

vi.mock('@/i18n', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('@/lib/providerRecoveryPresentation', () => ({
  presentProviderRecovery: () => null,
}));

import { StatusBar } from '@/components/chat/StatusBar';

describe('StatusBar', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('shows pending resume progress while turn activity has a snapshot', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);

    await act(async () => root.render(<StatusBar />));

    expect(container.textContent).toContain('Recovery attempt 2/4');
  });
});

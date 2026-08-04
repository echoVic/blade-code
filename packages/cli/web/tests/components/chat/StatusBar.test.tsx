// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionState = vi.hoisted(() => ({
  tokenUsage: {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    maxContextTokens: 100,
    isDefaultMaxTokens: false,
  },
  isStreaming: true,
  agentPhase: 'compacting',
  goal: null as null | {
    status: string;
    objective: string;
    tokenBudget?: number;
    tokensUsed: number;
  },
}));

vi.mock('@/store/session', () => ({
  useSessionStore: () => sessionState,
}));

import { StatusBar } from '../../../src/components/chat/StatusBar';

describe('StatusBar', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    sessionState.isStreaming = true;
    sessionState.agentPhase = 'compacting';
    sessionState.goal = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders the active agent lifecycle phase', () => {
    act(() => {
      root.render(<StatusBar />);
    });

    expect(container.textContent).toContain('Compacting context...');
    expect(container.textContent).not.toContain('Generating...');
  });

  it('renders active goal status and budget', () => {
    sessionState.goal = {
      status: 'active',
      objective: 'finish the migration',
      tokenBudget: 1200,
      tokensUsed: 300,
    };
    act(() => {
      root.render(<StatusBar />);
    });

    expect(container.textContent).toContain(
      'Goal: active · finish the migration · 300/1.2K'
    );
  });
});

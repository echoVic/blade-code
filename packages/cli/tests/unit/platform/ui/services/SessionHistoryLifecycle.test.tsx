// @vitest-environment jsdom

import React, { act, StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { SessionSurfaceSummary } from '../../../../../src/api/sessionSurfaceSchemas.js';
import type { SessionHistoryViewState } from '../../../../../src/ui/services/SessionHistoryController.js';
import {
  activateRemoteTaskAttention,
  SessionHistoryLifecycle,
  useSessionHistoryLifecycle,
} from '../../../../../src/ui/services/SessionHistoryLifecycle.js';
import type { TuiTaskAttentionState } from '../../../../../src/ui/services/TuiTaskAttentionController.js';
import {
  TuiTaskAttentionLifecycle,
  useTuiTaskAttentionLifecycle,
} from '../../../../../src/ui/services/TuiTaskAttentionLifecycle.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeHistoryController {
  private state: SessionHistoryViewState = {
    viewGeneration: 0,
    status: 'idle',
    messages: [],
    truncated: false,
  };
  readonly getState = vi.fn((): SessionHistoryViewState => this.state);
  readonly subscribe = vi.fn((_listener: (state: SessionHistoryViewState) => void) =>
    (() => {
      this.listener = _listener;
      return vi.fn();
    })()
  );
  private listener?: (state: SessionHistoryViewState) => void;
  private activeKey?: string;
  readonly activate = vi.fn(
    async (summary: SessionSurfaceSummary, intent: 'resume' | 'fork') => {
      expect(attentionVisibility?.()).toBeUndefined();
      const key = `${intent}:${summary.locator.sessionId}`;
      if (this.activeKey === key) return;
      this.activeKey = key;
      this.state = {
        viewGeneration: this.state.viewGeneration + 1,
        status: intent === 'resume' ? 'loading' : 'forking',
        session: summary,
        messages: [],
        truncated: false,
      };
      this.listener?.(this.state);
      await Promise.resolve();
      this.state = { ...this.state, status: 'ready' };
      this.listener?.(this.state);
      this.activeKey = undefined;
    }
  );
  readonly closeView = vi.fn(async () => undefined);
  readonly loadOlder = vi.fn(async () => undefined);
  readonly fork = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
}

let attentionVisibility:
  | (() => SessionSurfaceSummary['locator'] | undefined)
  | undefined;

class FakeAttentionController {
  readonly getState = vi.fn(
    (): TuiTaskAttentionState => ({ status: 'idle', sessions: [], unreadKeys: [] })
  );
  readonly start = vi.fn(async () => undefined);
  readonly listAll = vi.fn(async (): Promise<SessionSurfaceSummary[]> => []);
  readonly acknowledge = vi.fn(async (_summary: SessionSurfaceSummary) => undefined);
  readonly setVisibleLocator = vi.fn<
    (_locator?: SessionSurfaceSummary['locator']) => Promise<void>
  >(async () => undefined);
  readonly subscribe = vi.fn((_listener: (state: TuiTaskAttentionState) => void) =>
    vi.fn()
  );
  readonly close = vi.fn(async () => undefined);
}

describe('SessionHistoryLifecycle', () => {
  it('keeps the production history hook controller live through StrictMode replay', async () => {
    const controllers: FakeHistoryController[] = [];
    const lifecycle = new SessionHistoryLifecycle(() => {
      const controller = new FakeHistoryController();
      controllers.push(controller);
      return controller;
    });

    function Harness(): null {
      useSessionHistoryLifecycle({
        lifecycle,
        project: () => undefined,
        report: () => undefined,
      });
      return null;
    }

    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>
      );
    });
    expect(controllers).toHaveLength(1);
    expect(controllers[0]?.subscribe).toHaveBeenCalledTimes(2);
    expect(controllers[0]?.close).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    expect(controllers[0]?.close).toHaveBeenCalledOnce();
  });

  it('uses both production hooks and binds remote attention to the actual activation generation', async () => {
    const historyController = new FakeHistoryController();
    const attentionController = new FakeAttentionController();
    const history = new SessionHistoryLifecycle(() => historyController);
    const attention = new TuiTaskAttentionLifecycle(() => attentionController);
    let visibleLocator: SessionSurfaceSummary['locator'] | undefined = {
      version: 2,
      sessionId: 'local-session',
      workspace: { kind: 'local', projectPath: '/workspace' },
    };
    attentionController.setVisibleLocator.mockImplementation(async (locator) => {
      visibleLocator = locator;
    });
    attentionVisibility = () => visibleLocator;
    const remote = {
      locator: {
        version: 2 as const,
        sessionId: 'remote-session',
        workspace: {
          kind: 'acp-remote' as const,
          workspaceRef: `acp-remote-workspace:${'R'.repeat(43)}`,
        },
      },
    } as SessionSurfaceSummary;

    function Harness(): null {
      const [state, setState] = useState(history.getState());
      useTuiTaskAttentionLifecycle({
        ready: true,
        lifecycle: attention,
        initialize: async () => undefined,
        project: () => undefined,
        report: () => undefined,
      });
      useSessionHistoryLifecycle({
        lifecycle: history,
        project: setState,
        report: () => undefined,
      });
      useEffect(() => {
        void activateRemoteTaskAttention(history, attention, {
          intent: 'resume',
          session: remote,
        });
      }, []);
      useEffect(() => {
        void attention.updateRemote({ intent: 'resume', session: remote }, state);
      }, [state]);
      return null;
    }

    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>
      );
    });

    expect(attentionController.setVisibleLocator).toHaveBeenCalledWith(undefined);
    expect(historyController.getState().viewGeneration).toBeGreaterThan(0);
    expect(attentionController.acknowledge).toHaveBeenCalledOnce();
    expect(attentionController.acknowledge).toHaveBeenCalledWith(remote);
    expect(attentionController.setVisibleLocator).toHaveBeenCalledWith(remote.locator);
    expect(historyController.close).not.toHaveBeenCalled();
    expect(attentionController.close).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    expect(historyController.close).toHaveBeenCalledOnce();
    expect(attentionController.close).toHaveBeenCalledOnce();
    attentionVisibility = undefined;
  });

  it('does not activate after a deferred visibility clear is cancelled by close', async () => {
    const historyController = new FakeHistoryController();
    const attentionController = new FakeAttentionController();
    const history = new SessionHistoryLifecycle(() => historyController);
    const attention = new TuiTaskAttentionLifecycle(() => attentionController);
    history.acquire(() => undefined);
    attention.acquire(() => undefined);
    let resolveClear = (): void => undefined;
    attentionController.setVisibleLocator.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveClear = resolve;
        })
    );
    const remote = {
      locator: {
        version: 2 as const,
        sessionId: 'remote-a',
        workspace: {
          kind: 'acp-remote' as const,
          workspaceRef: `acp-remote-workspace:${'A'.repeat(43)}`,
        },
      },
    } as SessionSurfaceSummary;

    const opening = activateRemoteTaskAttention(history, attention, {
      intent: 'resume',
      session: remote,
    });
    history.cancelRemoteRequest();
    await attention.endRemote();
    resolveClear();
    await opening;

    expect(historyController.activate).not.toHaveBeenCalled();
  });

  it('activates only the latest remote when visibility clears resolve in reverse order', async () => {
    const historyController = new FakeHistoryController();
    const attentionController = new FakeAttentionController();
    const history = new SessionHistoryLifecycle(() => historyController);
    const attention = new TuiTaskAttentionLifecycle(() => attentionController);
    history.acquire(() => undefined);
    attention.acquire(() => undefined);
    const clearResolvers: Array<() => void> = [];
    attentionController.setVisibleLocator.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          clearResolvers.push(resolve);
        })
    );
    const first = {
      locator: {
        version: 2 as const,
        sessionId: 'remote-a',
        workspace: {
          kind: 'acp-remote' as const,
          workspaceRef: `acp-remote-workspace:${'A'.repeat(43)}`,
        },
      },
    } as SessionSurfaceSummary;
    const second = {
      ...first,
      locator: {
        ...first.locator,
        sessionId: 'remote-b',
        workspace: {
          kind: 'acp-remote' as const,
          workspaceRef: `acp-remote-workspace:${'B'.repeat(43)}`,
        },
      },
    };

    const openingA = activateRemoteTaskAttention(history, attention, {
      intent: 'resume',
      session: first,
    });
    const openingB = activateRemoteTaskAttention(history, attention, {
      intent: 'resume',
      session: second,
    });
    clearResolvers[1]?.();
    await openingB;
    clearResolvers[0]?.();
    await openingA;

    expect(historyController.activate).toHaveBeenCalledOnce();
    expect(historyController.activate).toHaveBeenCalledWith(second, 'resume');
  });

  it('continues the current remote activation when clearing visibility fails', async () => {
    const historyController = new FakeHistoryController();
    const attentionController = new FakeAttentionController();
    const history = new SessionHistoryLifecycle(() => historyController);
    const attention = new TuiTaskAttentionLifecycle(() => attentionController);
    history.acquire(() => undefined);
    attention.acquire(() => undefined);
    attentionController.setVisibleLocator.mockRejectedValueOnce(
      new Error('clear unavailable')
    );
    const remote = {
      locator: {
        version: 2 as const,
        sessionId: 'remote-current',
        workspace: {
          kind: 'acp-remote' as const,
          workspaceRef: `acp-remote-workspace:${'C'.repeat(43)}`,
        },
      },
    } as SessionSurfaceSummary;

    await activateRemoteTaskAttention(history, attention, {
      intent: 'resume',
      session: remote,
    });

    expect(historyController.activate).toHaveBeenCalledWith(remote, 'resume');
  });
});

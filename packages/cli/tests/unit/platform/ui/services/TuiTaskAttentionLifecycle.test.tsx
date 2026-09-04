// @vitest-environment jsdom

import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { SessionSurfaceSummary } from '../../../../../src/api/sessionSurfaceSchemas.js';
import type { TuiTaskAttentionState } from '../../../../../src/ui/services/TuiTaskAttentionController.js';
import {
  TuiTaskAttentionLifecycle,
  useTuiTaskAttentionLifecycle,
} from '../../../../../src/ui/services/TuiTaskAttentionLifecycle.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeController {
  readonly getState = vi.fn(
    (): TuiTaskAttentionState => ({ status: 'idle', sessions: [], unreadKeys: [] })
  );
  readonly start = vi.fn(async () => undefined);
  readonly listAll = vi.fn(async (): Promise<SessionSurfaceSummary[]> => []);
  readonly acknowledge = vi.fn(async (_summary: SessionSurfaceSummary) => undefined);
  readonly setVisibleLocator = vi.fn(
    async (_locator?: SessionSurfaceSummary['locator']) => undefined
  );
  readonly subscribe = vi.fn((_listener: (state: TuiTaskAttentionState) => void) =>
    vi.fn()
  );
  readonly close = vi.fn(async () => undefined);
}

describe('TuiTaskAttentionLifecycle', () => {
  it('keeps the live controller through a real StrictMode effect replay', async () => {
    const controllers: FakeController[] = [];
    const lifecycle = new TuiTaskAttentionLifecycle(() => {
      const controller = new FakeController();
      controllers.push(controller);
      return controller;
    });

    function Harness(): null {
      useTuiTaskAttentionLifecycle({
        ready: true,
        lifecycle,
        initialize: async (lease) => lease.controller.start(),
        project: () => undefined,
        report: () => undefined,
      });
      return null;
    }

    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>
      );
    });

    expect(controllers).toHaveLength(1);
    expect(controllers[0]?.start).toHaveBeenCalledTimes(2);
    expect(controllers[0]?.close).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    expect(controllers[0]?.close).toHaveBeenCalledOnce();
  });
});

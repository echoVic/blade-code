import { useEffect } from 'react';
import type { SessionSurfaceSummary } from '../../api/sessionSurfaceSchemas.js';
import { TuiTaskAttentionVisibilityCoordinator } from '../components/sessionSelectorModel.js';
import {
  TuiTaskAttentionController,
  type TuiTaskAttentionState,
} from './TuiTaskAttentionController.js';

type AttentionListener = (state: TuiTaskAttentionState) => void;

export interface TuiTaskAttentionLifecycleController {
  start(): Promise<void>;
  getState(): TuiTaskAttentionState;
  listAll(): Promise<SessionSurfaceSummary[]>;
  acknowledge(summary: SessionSurfaceSummary): Promise<void>;
  setVisibleLocator(locator?: SessionSurfaceSummary['locator']): Promise<void>;
  subscribe(listener: AttentionListener): () => void;
  close(): Promise<void>;
}

export interface TuiTaskAttentionLease {
  controller: TuiTaskAttentionLifecycleController;
  visibility: TuiTaskAttentionVisibilityCoordinator;
  release(): Promise<void>;
}

export class TuiTaskAttentionLifecycle {
  private active?: {
    controller: TuiTaskAttentionLifecycleController;
    visibility: TuiTaskAttentionVisibilityCoordinator;
  };
  private generation = 0;

  constructor(
    private readonly factory: () => TuiTaskAttentionLifecycleController = () =>
      new TuiTaskAttentionController()
  ) {}

  acquire(listener: AttentionListener): TuiTaskAttentionLease {
    const generation = ++this.generation;
    if (!this.active) {
      const controller = this.factory();
      this.active = {
        controller,
        visibility: new TuiTaskAttentionVisibilityCoordinator(controller),
      };
    }
    const owned = this.active;
    const { controller, visibility } = owned;
    const unsubscribe = controller.subscribe(listener);
    return {
      controller,
      visibility,
      release: async () => {
        unsubscribe();
        await Promise.resolve();
        if (this.generation !== generation) return;
        if (this.active === owned) this.active = undefined;
        await controller.close();
      },
    };
  }

  listAll(): Promise<SessionSurfaceSummary[]> {
    return this.controller().listAll();
  }

  acknowledge(summary: SessionSurfaceSummary): Promise<void> {
    return this.controller().acknowledge(summary);
  }

  setVisibleLocator(locator?: SessionSurfaceSummary['locator']): Promise<void> {
    return this.controller().setVisibleLocator(locator);
  }

  proveLocal(locator: SessionSurfaceSummary['locator']): Promise<void> {
    return this.visibility().proveLocal(locator);
  }

  beginRemote(
    viewer: Parameters<TuiTaskAttentionVisibilityCoordinator['beginRemote']>[0],
    generation: number
  ): Promise<void> {
    return this.visibility().beginRemote(viewer, generation);
  }

  endRemote(): Promise<void> {
    return this.visibility().endRemote();
  }

  updateRemote(
    viewer: Parameters<TuiTaskAttentionVisibilityCoordinator['updateRemote']>[0],
    history: Parameters<TuiTaskAttentionVisibilityCoordinator['updateRemote']>[1]
  ): Promise<void> {
    return this.visibility().updateRemote(viewer, history);
  }

  controller(): TuiTaskAttentionLifecycleController {
    if (!this.active) throw new Error('TUI task attention lifecycle is not active');
    return this.active.controller;
  }

  visibility(): TuiTaskAttentionVisibilityCoordinator {
    if (!this.active) throw new Error('TUI task attention lifecycle is not active');
    return this.active.visibility;
  }
}

interface TuiTaskAttentionLifecycleHookOptions {
  ready: boolean;
  lifecycle: TuiTaskAttentionLifecycle;
  initialize: (lease: TuiTaskAttentionLease) => Promise<void>;
  project: AttentionListener;
  report: (phase: 'startup' | 'shutdown') => void;
}

export function useTuiTaskAttentionLifecycle({
  ready,
  lifecycle,
  initialize,
  project,
  report,
}: TuiTaskAttentionLifecycleHookOptions): void {
  useEffect(() => {
    if (!ready) return;
    const lease = lifecycle.acquire(project);
    void initialize(lease).catch(() => report('startup'));
    return () => {
      void lease.release().catch(() => report('shutdown'));
    };
  }, [initialize, lifecycle, project, ready, report]);
}

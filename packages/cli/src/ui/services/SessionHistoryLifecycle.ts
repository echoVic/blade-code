import { useEffect } from 'react';
import type { SessionSurfaceSummary } from '../../api/sessionSurfaceSchemas.js';
import type { SessionSelectionIntent } from '../../slash-commands/types.js';
import {
  type SessionHistoryActionTarget,
  SessionHistoryController,
  type SessionHistoryViewState,
} from './SessionHistoryController.js';
import type { TuiTaskAttentionLifecycle } from './TuiTaskAttentionLifecycle.js';

type HistoryListener = (state: SessionHistoryViewState) => void;

export interface SessionHistoryLifecycleController {
  getState(): SessionHistoryViewState;
  subscribe(listener: HistoryListener): () => void;
  activate(summary: SessionSurfaceSummary, intent: 'resume' | 'fork'): Promise<void>;
  closeView(): Promise<void>;
  loadOlder(target: SessionHistoryActionTarget): Promise<void>;
  fork(target: SessionHistoryActionTarget): Promise<void>;
  close(): Promise<void>;
}

export class SessionHistoryLifecycle {
  private active?: SessionHistoryLifecycleController;
  private generation = 0;
  private remoteRequestEpoch = 0;

  constructor(
    private readonly factory: () => SessionHistoryLifecycleController = () =>
      new SessionHistoryController()
  ) {}

  acquire(listener: HistoryListener): () => Promise<void> {
    const generation = ++this.generation;
    this.active ??= this.factory();
    const controller = this.active;
    const unsubscribe = controller.subscribe(listener);
    return async () => {
      unsubscribe();
      await Promise.resolve();
      if (this.generation !== generation) return;
      if (this.active === controller) this.active = undefined;
      await controller.close();
    };
  }

  getState(): SessionHistoryViewState {
    return (
      this.active?.getState() ?? {
        viewGeneration: 0,
        status: 'idle',
        messages: [],
        truncated: false,
      }
    );
  }

  activate(summary: SessionSurfaceSummary, intent: 'resume' | 'fork'): Promise<void> {
    return this.active?.activate(summary, intent) ?? Promise.resolve();
  }

  closeView(): Promise<void> {
    this.cancelRemoteRequest();
    return this.active?.closeView() ?? Promise.resolve();
  }

  loadOlder(target: SessionHistoryActionTarget): Promise<void> {
    return this.active?.loadOlder(target) ?? Promise.resolve();
  }

  fork(target: SessionHistoryActionTarget): Promise<void> {
    return this.active?.fork(target) ?? Promise.resolve();
  }

  beginRemoteRequest(): number {
    return ++this.remoteRequestEpoch;
  }

  cancelRemoteRequest(): void {
    this.remoteRequestEpoch += 1;
  }

  isCurrentRemoteRequest(epoch: number): boolean {
    return this.active !== undefined && this.remoteRequestEpoch === epoch;
  }
}

export async function activateRemoteTaskAttention(
  history: SessionHistoryLifecycle,
  attention: TuiTaskAttentionLifecycle,
  viewer: { intent: SessionSelectionIntent; session: SessionSurfaceSummary }
): Promise<void> {
  const requestEpoch = history.beginRemoteRequest();
  const opening = attention.beginRemoteOpening();
  await opening.cleared.catch(() => undefined);
  if (
    !history.isCurrentRemoteRequest(requestEpoch) ||
    !attention.isRemoteOpeningCurrent(opening.epoch)
  ) {
    return;
  }
  const activation = history.activate(viewer.session, viewer.intent);
  if (
    !history.isCurrentRemoteRequest(requestEpoch) ||
    !attention.bindRemoteOpening(
      opening.epoch,
      viewer,
      history.getState().viewGeneration
    )
  ) {
    await activation;
    return;
  }
  await activation;
}

interface UseSessionHistoryLifecycleOptions {
  lifecycle: SessionHistoryLifecycle;
  project: HistoryListener;
  report: () => void;
}

export function useSessionHistoryLifecycle({
  lifecycle,
  project,
  report,
}: UseSessionHistoryLifecycleOptions): void {
  useEffect(() => {
    const release = lifecycle.acquire(project);
    return () => {
      void release().catch(report);
    };
  }, [lifecycle, project, report]);
}

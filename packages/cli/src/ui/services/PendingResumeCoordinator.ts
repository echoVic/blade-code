export type PendingResumeResult = 'completed' | 'deferred';

export interface PendingResumeCoordinatorOptions {
  canRun: () => boolean;
  run: (signal: AbortSignal) => Promise<PendingResumeResult>;
  schedule?: (callback: () => void) => void;
}

/**
 * Coalesces wakeups from UI, team, and subagent event sources into one recovery run.
 * Durable input remains owned by SessionRuntime; this class only schedules consumption.
 */
export class PendingResumeCoordinator {
  private requested = false;
  private scheduled = false;
  private inFlight = false;
  private disposed = false;
  private generation = 0;
  private activeRunController: AbortController | null = null;
  private readonly scheduleCallback: (callback: () => void) => void;

  constructor(private readonly options: PendingResumeCoordinatorOptions) {
    this.scheduleCallback = options.schedule ?? queueMicrotask;
  }

  request(): void {
    if (this.disposed) return;
    this.requested = true;
    this.scheduleIfRunnable();
  }

  notifyIdle(): void {
    this.scheduleIfRunnable();
  }

  dispose(): void {
    this.disposed = true;
    this.requested = false;
    this.scheduled = false;
    this.generation++;
    this.activeRunController?.abort('pending-resume-coordinator-disposed');
    this.activeRunController = null;
  }

  private scheduleIfRunnable(): void {
    if (
      this.disposed ||
      !this.requested ||
      this.scheduled ||
      this.inFlight ||
      !this.options.canRun()
    ) {
      return;
    }

    this.scheduled = true;
    const generation = this.generation;
    this.scheduleCallback(() => {
      if (this.disposed || generation !== this.generation) return;
      this.scheduled = false;
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (this.disposed || this.inFlight || !this.requested || !this.options.canRun()) {
      return;
    }

    this.requested = false;
    this.inFlight = true;
    const controller = new AbortController();
    this.activeRunController = controller;
    let result: PendingResumeResult = 'completed';
    try {
      result = await this.options.run(controller.signal);
    } finally {
      if (this.activeRunController === controller) {
        this.activeRunController = null;
      }
      this.inFlight = false;
      if (result === 'deferred') {
        this.requested = true;
      }
      this.scheduleIfRunnable();
    }
  }
}

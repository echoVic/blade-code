/**
 * 并发调度器
 *
 * 按 ToolKind 将工具调用分桶,不同桶有不同的并发策略:
 *
 * | Bucket   | 最大并发 | 说明                                       |
 * |----------|---------|--------------------------------------------|
 * | readonly | ∞       | 无副作用工具 (Read/Grep/Glob/WebFetch 等)  |
 * | write    | ∞ *     | 写工具;* 不同文件可并行,同文件由调用方走   |
 * |          |         | FileLockManager 串行                       |
 * | execute  | 3       | Bash/Shell 限并发,避免系统资源争抢         |
 *
 * 对齐 Claude Code 官方 StreamingToolExecutor 的 concurrency-safe 概念。
 *
 * 注意: scheduler 只做"桶配额"管理;工具内部的串行化 (如同文件编辑)
 * 仍由 FileLockManager 负责。两者正交。
 */

import { ToolKind } from '../types/ToolTypes.js';

type PendingTask<T = unknown> = {
  fn: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

interface BucketState {
  inFlight: number;
  maxConcurrent: number;
  queue: PendingTask[];
}

export interface ConcurrencyLimits {
  readonly?: number;
  write?: number;
  execute?: number;
}

const DEFAULT_LIMITS: Required<ConcurrencyLimits> = {
  readonly: Number.POSITIVE_INFINITY,
  write: Number.POSITIVE_INFINITY,
  execute: 3,
};

export class ConcurrencyScheduler {
  private static instance: ConcurrencyScheduler | null = null;

  private readonly buckets: Record<ToolKind, BucketState>;

  constructor(limits: ConcurrencyLimits = {}) {
    const merged = { ...DEFAULT_LIMITS, ...limits };
    this.buckets = {
      [ToolKind.ReadOnly]: {
        inFlight: 0,
        maxConcurrent: merged.readonly,
        queue: [],
      },
      [ToolKind.Write]: {
        inFlight: 0,
        maxConcurrent: merged.write,
        queue: [],
      },
      [ToolKind.Execute]: {
        inFlight: 0,
        maxConcurrent: merged.execute,
        queue: [],
      },
    };
  }

  static getInstance(): ConcurrencyScheduler {
    if (!ConcurrencyScheduler.instance) {
      ConcurrencyScheduler.instance = new ConcurrencyScheduler();
    }
    return ConcurrencyScheduler.instance;
  }

  /** 仅用于测试 */
  static resetInstance(): void {
    ConcurrencyScheduler.instance = null;
  }

  /**
   * 按 kind 调度一次工具调用。
   * 超过桶配额时进入队列,前一个完成后 FIFO 唤醒。
   */
  schedule<T>(kind: ToolKind, fn: () => Promise<T>): Promise<T> {
    const bucket = this.buckets[kind];
    if (!bucket) {
      // 未知 kind 退化为直接执行 (保守默认,不阻塞)
      return fn();
    }

    if (bucket.inFlight < bucket.maxConcurrent) {
      return this.runImmediately(bucket, fn);
    }

    return new Promise<T>((resolve, reject) => {
      bucket.queue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
    });
  }

  private async runImmediately<T>(
    bucket: BucketState,
    fn: () => Promise<T>
  ): Promise<T> {
    bucket.inFlight++;
    try {
      return await fn();
    } finally {
      bucket.inFlight--;
      this.drain(bucket);
    }
  }

  /** 唤醒队列头部任务(若有配额) */
  private drain(bucket: BucketState): void {
    while (bucket.inFlight < bucket.maxConcurrent && bucket.queue.length > 0) {
      const task = bucket.queue.shift()!;
      bucket.inFlight++;
      task
        .fn()
        .then(task.resolve, task.reject)
        .finally(() => {
          bucket.inFlight--;
          this.drain(bucket);
        });
    }
  }

  /** 快照:供测试/监控使用 */
  getStats(): Record<ToolKind, { inFlight: number; queued: number }> {
    return {
      [ToolKind.ReadOnly]: {
        inFlight: this.buckets[ToolKind.ReadOnly].inFlight,
        queued: this.buckets[ToolKind.ReadOnly].queue.length,
      },
      [ToolKind.Write]: {
        inFlight: this.buckets[ToolKind.Write].inFlight,
        queued: this.buckets[ToolKind.Write].queue.length,
      },
      [ToolKind.Execute]: {
        inFlight: this.buckets[ToolKind.Execute].inFlight,
        queued: this.buckets[ToolKind.Execute].queue.length,
      },
    };
  }
}

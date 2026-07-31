import { afterEach, describe, expect, it } from 'vitest';
import { ConcurrencyScheduler } from '../../../../../src/tools/execution/ConcurrencyScheduler.js';
import { ToolKind } from '../../../../../src/tools/types/ToolTypes.js';

/** 创建一个可被外部 resolve/reject 的任务 */
function deferred<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ConcurrencyScheduler', () => {
  afterEach(() => {
    ConcurrencyScheduler.resetInstance();
  });

  describe('单例', () => {
    it('getInstance 返回同一实例', () => {
      const a = ConcurrencyScheduler.getInstance();
      const b = ConcurrencyScheduler.getInstance();
      expect(a).toBe(b);
    });

    it('resetInstance 后返回新实例', () => {
      const a = ConcurrencyScheduler.getInstance();
      ConcurrencyScheduler.resetInstance();
      const b = ConcurrencyScheduler.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('readonly 桶: 无限并发', () => {
    it('100 个 readonly 任务应全部并行启动', async () => {
      const scheduler = new ConcurrencyScheduler();
      const gates = Array.from({ length: 100 }, () => deferred<number>());

      // 派发所有任务
      const results = gates.map((g, i) =>
        scheduler.schedule(ToolKind.ReadOnly, async () => g.promise.then(() => i))
      );

      // 给 microtask 队列机会,让所有任务进入 inFlight
      await new Promise((r) => setTimeout(r, 0));

      expect(scheduler.getStats()[ToolKind.ReadOnly]).toEqual({
        inFlight: 100,
        queued: 0,
      });

      // 释放所有
      gates.forEach((g) => g.resolve(0));
      const values = await Promise.all(results);
      expect(values).toHaveLength(100);
    });
  });

  describe('execute 桶: 限并发 3', () => {
    it('超过 3 个任务时,多余的应排队', async () => {
      const scheduler = new ConcurrencyScheduler({ execute: 3 });
      const gates = Array.from({ length: 5 }, () => deferred<void>());
      const started: number[] = [];

      const promises = gates.map((g, i) =>
        scheduler.schedule(ToolKind.Execute, async () => {
          started.push(i);
          await g.promise;
        })
      );

      await new Promise((r) => setTimeout(r, 0));
      expect(started).toEqual([0, 1, 2]); // 只有前 3 个启动
      expect(scheduler.getStats()[ToolKind.Execute]).toEqual({
        inFlight: 3,
        queued: 2,
      });

      // 完成第一个 → 队列头部(3)应被唤醒
      gates[0].resolve();
      await new Promise((r) => setTimeout(r, 0));
      expect(started).toEqual([0, 1, 2, 3]);

      // 完成剩下的
      gates[1].resolve();
      gates[2].resolve();
      gates[3].resolve();
      gates[4].resolve();
      await Promise.all(promises);
      expect(started).toEqual([0, 1, 2, 3, 4]);
    });

    it('任务抛错时仍应释放配额', async () => {
      const scheduler = new ConcurrencyScheduler({ execute: 1 });

      await expect(
        scheduler.schedule(ToolKind.Execute, async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      expect(scheduler.getStats()[ToolKind.Execute].inFlight).toBe(0);

      // 下一个任务应能立即获得配额
      const result = await scheduler.schedule(ToolKind.Execute, async () => 'ok');
      expect(result).toBe('ok');
    });
  });

  describe('桶隔离', () => {
    it('execute 桶打满不影响 readonly', async () => {
      const scheduler = new ConcurrencyScheduler({ execute: 1 });
      const blockExec = deferred<void>();

      // 占满 execute 桶
      const execPromise = scheduler.schedule(
        ToolKind.Execute,
        async () => blockExec.promise
      );
      await new Promise((r) => setTimeout(r, 0));

      // readonly 仍能立即执行
      const readResult = await scheduler.schedule(
        ToolKind.ReadOnly,
        async () => 'read-ok'
      );
      expect(readResult).toBe('read-ok');

      blockExec.resolve();
      await execPromise;
    });
  });

  describe('自定义限额', () => {
    it('可以覆盖默认 execute 限额', async () => {
      const scheduler = new ConcurrencyScheduler({ execute: 1 });
      const gates = [deferred<void>(), deferred<void>()];
      const started: number[] = [];

      const promises = gates.map((g, i) =>
        scheduler.schedule(ToolKind.Execute, async () => {
          started.push(i);
          await g.promise;
        })
      );

      await new Promise((r) => setTimeout(r, 0));
      expect(started).toEqual([0]); // 只有 1 个能跑

      gates[0].resolve();
      gates[1].resolve();
      await Promise.all(promises);
    });
  });

  describe('FIFO 顺序', () => {
    it('排队任务应按入队顺序唤醒', async () => {
      const scheduler = new ConcurrencyScheduler({ execute: 1 });
      const order: number[] = [];
      const first = deferred<void>();

      // 先占住配额
      const p0 = scheduler.schedule(ToolKind.Execute, async () => {
        order.push(0);
        await first.promise;
      });

      // 依次入队
      const p1 = scheduler.schedule(ToolKind.Execute, async () => {
        order.push(1);
      });
      const p2 = scheduler.schedule(ToolKind.Execute, async () => {
        order.push(2);
      });
      const p3 = scheduler.schedule(ToolKind.Execute, async () => {
        order.push(3);
      });

      await new Promise((r) => setTimeout(r, 0));
      expect(order).toEqual([0]);

      first.resolve();
      await Promise.all([p0, p1, p2, p3]);
      expect(order).toEqual([0, 1, 2, 3]);
    });
  });

  describe('进程级共享 (多 pipeline/多 agent 场景)', () => {
    it('多个独立的 scheduler 实例共用 getInstance() 时,execute 配额全局生效', async () => {
      // 模拟 SessionRuntime/BackgroundAgentManager 各建 pipeline 但共享 scheduler
      const pipelineA = ConcurrencyScheduler.getInstance();
      const pipelineB = ConcurrencyScheduler.getInstance();
      const pipelineC = ConcurrencyScheduler.getInstance();
      expect(pipelineA).toBe(pipelineB);
      expect(pipelineB).toBe(pipelineC);

      // 默认 execute: 3; 三个 pipeline 并发 6 次 Bash 调用应该仍只有 3 个在跑
      const gates = Array.from({ length: 6 }, () => deferred<void>());
      const started: number[] = [];
      const promises = gates.map((g, i) =>
        [pipelineA, pipelineB, pipelineC][i % 3].schedule(
          ToolKind.Execute,
          async () => {
            started.push(i);
            await g.promise;
          }
        )
      );

      await new Promise((r) => setTimeout(r, 0));
      expect(started).toHaveLength(3); // 全局只有 3 个在跑
      expect(pipelineA.getStats()[ToolKind.Execute]).toEqual({
        inFlight: 3,
        queued: 3,
      });

      gates.forEach((g) => g.resolve());
      await Promise.all(promises);
    });
  });
});

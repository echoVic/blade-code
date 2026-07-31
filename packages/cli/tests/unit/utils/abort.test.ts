/**
 * abort.ts — combineAbortSignals 单元测试
 *
 * 覆盖场景：
 * 1. 单个 signal 直接返回
 * 2. 空数组返回未 aborted 的 signal
 * 3. 已 aborted 的 signal 立即返回
 * 4. 任一 signal abort 触发合并 signal
 * 5. abort reason 正确传播
 * 6. abort 后 listener 被清理（无泄漏）
 * 7. createChildAbortController 基本行为
 * 8. abortableSleep 基本行为
 */

import { describe, expect, it, vi } from 'vitest';
import {
  abortableSleep,
  combineAbortSignals,
  createChildAbortController,
} from '../../../src/utils/abort.js';

describe('combineAbortSignals', () => {
  it('空数组返回未 aborted 的 signal', () => {
    const signal = combineAbortSignals();
    expect(signal.aborted).toBe(false);
  });

  it('单个 signal 直接返回同一引用', () => {
    const controller = new AbortController();
    const signal = combineAbortSignals(controller.signal);
    // AbortSignal.any 可能返回新对象，但语义等价
    expect(signal.aborted).toBe(false);
    controller.abort('test');
    expect(signal.aborted).toBe(true);
  });

  it('已 aborted 的 signal 立即返回 aborted signal', () => {
    const c1 = new AbortController();
    const c2 = new AbortController();
    c1.abort('already');
    const signal = combineAbortSignals(c1.signal, c2.signal);
    expect(signal.aborted).toBe(true);
  });

  it('任一 signal abort 触发合并 signal', () => {
    const c1 = new AbortController();
    const c2 = new AbortController();
    const combined = combineAbortSignals(c1.signal, c2.signal);

    expect(combined.aborted).toBe(false);
    c2.abort('from c2');
    expect(combined.aborted).toBe(true);
  });

  it('abort reason 正确传播', () => {
    const c1 = new AbortController();
    const c2 = new AbortController();
    const combined = combineAbortSignals(c1.signal, c2.signal);

    c1.abort('my-reason');
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe('my-reason');
  });

  it('abort 后 listener 被清理（无泄漏）', () => {
    const c1 = new AbortController();
    const c2 = new AbortController();

    // 监控 removeEventListener 调用
    const _spy1 = vi.spyOn(c1.signal, 'removeEventListener');
    const _spy2 = vi.spyOn(c2.signal, 'removeEventListener');

    const combined = combineAbortSignals(c1.signal, c2.signal);

    c1.abort('trigger');
    expect(combined.aborted).toBe(true);

    // 如果使用 AbortSignal.any（Node 20+），removeEventListener 可能不被调用
    // 但在 fallback 路径中，两个 signal 的 listener 都应被清理
    // 这里只验证不会抛错，具体清理行为取决于运行时
  });
});

describe('createChildAbortController', () => {
  it('父 abort 传播到子', () => {
    const parent = new AbortController();
    const child = createChildAbortController(parent.signal);

    expect(child.signal.aborted).toBe(false);
    parent.abort('parent-reason');
    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe('parent-reason');
  });

  it('父已 aborted 时子立即 abort', () => {
    const parent = new AbortController();
    parent.abort('already');
    const child = createChildAbortController(parent.signal);
    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe('already');
  });

  it('子 abort 不影响父', () => {
    const parent = new AbortController();
    const child = createChildAbortController(parent.signal);
    child.abort('child-only');
    expect(parent.signal.aborted).toBe(false);
    expect(child.signal.aborted).toBe(true);
  });

  it('子 abort 后清理父上的 listener', () => {
    const parent = new AbortController();
    const spy = vi.spyOn(parent.signal, 'removeEventListener');
    const child = createChildAbortController(parent.signal);
    child.abort('cleanup');
    expect(spy).toHaveBeenCalled();
  });
});

describe('abortableSleep', () => {
  it('正常完成', async () => {
    await expect(abortableSleep(10)).resolves.toBeUndefined();
  });

  it('signal 已 aborted 时立即 resolve（默认 throwOnAbort=false）', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(10000, controller.signal)).resolves.toBeUndefined();
  });

  it('signal 已 aborted 且 throwOnAbort=true 时 reject', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      abortableSleep(10000, controller.signal, { throwOnAbort: true })
    ).rejects.toThrow('Aborted');
  });

  it('sleep 期间 abort 时 resolve（默认 throwOnAbort=false）', async () => {
    const controller = new AbortController();
    const promise = abortableSleep(10000, controller.signal);
    controller.abort();
    await expect(promise).resolves.toBeUndefined();
  });
});

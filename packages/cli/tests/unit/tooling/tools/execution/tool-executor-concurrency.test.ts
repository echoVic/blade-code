import { describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../../../../src/config/types.js';
import { Type } from '../../../../../src/schema/index.js';
import { createTool } from '../../../../../src/tools/core/createTool.js';
import { ConcurrencyScheduler } from '../../../../../src/tools/execution/ConcurrencyScheduler.js';
import { ToolExecutor } from '../../../../../src/tools/execution/ToolExecutor.js';
import { ToolRegistry } from '../../../../../src/tools/registry/ToolRegistry.js';
import type { Tool } from '../../../../../src/tools/types/ToolTypes.js';
import { ToolErrorType, ToolKind } from '../../../../../src/tools/types/ToolTypes.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeTool(
  name: string,
  concurrencySafe: boolean,
  execute: () => Promise<void>
): Tool {
  return createTool({
    name,
    displayName: name,
    kind: concurrencySafe ? ToolKind.ReadOnly : ToolKind.Execute,
    isConcurrencySafe: concurrencySafe,
    schema: Type.Object({}),
    description: { short: name },
    async execute() {
      await execute();
      return { success: true, llmContent: `${name}:ok` };
    },
  }) as Tool;
}

function makePathTool(
  name: string,
  execute: (filePath: string) => Promise<void>
): Tool {
  return createTool({
    name,
    displayName: name,
    kind: ToolKind.Write,
    isConcurrencySafe: false,
    parallelism: 'shared',
    schema: Type.Object({ file_path: Type.String() }),
    description: { short: name },
    async execute(params) {
      await execute(params.file_path);
      return { success: true, llmContent: `${name}:ok` };
    },
  }) as Tool;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function boundedScheduler(
  options: {
    globalMaxInFlight?: number;
    globalMaxPending?: number;
    sessionMaxInFlight?: number;
    sessionMaxPending?: number;
    waitTimeoutMs?: number;
  } = {}
) {
  const globalMaxInFlight = options.globalMaxInFlight ?? 3;
  const sessionMaxInFlight = options.sessionMaxInFlight ?? 2;
  return new ConcurrencyScheduler({
    globalMaxInFlight,
    globalMaxPending: options.globalMaxPending ?? 8,
    sessionMaxInFlight,
    sessionMaxPending: options.sessionMaxPending ?? 4,
    waitTimeoutMs: options.waitTimeoutMs ?? 5_000,
    globalKindLimits: {
      readonly: globalMaxInFlight,
      write: globalMaxInFlight,
      execute: globalMaxInFlight,
    },
    sessionKindLimits: {
      readonly: sessionMaxInFlight,
      write: sessionMaxInFlight,
      execute: sessionMaxInFlight,
    },
  });
}

describe('ToolExecutor concurrency contract', () => {
  it('shares safe calls and preserves an exclusive FIFO barrier', async () => {
    const first = deferred<void>();
    const exclusive = deferred<void>();
    const later = deferred<void>();
    const started: string[] = [];
    const registry = new ToolRegistry();
    registry.registerAll([
      makeTool('SafeFirst', true, async () => {
        started.push('safe-first');
        return first.promise;
      }),
      makeTool('Exclusive', false, async () => {
        started.push('exclusive');
        return exclusive.promise;
      }),
      makeTool('SafeLater', true, async () => {
        started.push('safe-later');
        return later.promise;
      }),
    ]);
    const executor = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
    });

    const firstResult = executor.execute('SafeFirst', {}, {});
    const exclusiveResult = executor.execute('Exclusive', {}, {});
    const laterResult = executor.execute('SafeLater', {}, {});

    await flushMicrotasks();
    expect(started).toEqual(['safe-first']);

    first.resolve();
    await firstResult;
    await flushMicrotasks();
    expect(started).toEqual(['safe-first', 'exclusive']);

    exclusive.resolve();
    await exclusiveResult;
    await flushMicrotasks();
    expect(started).toEqual(['safe-first', 'exclusive', 'safe-later']);

    later.resolve();
    await expect(laterResult).resolves.toMatchObject({ success: true });
  });

  it('returns a pre-launch cancellation while waiting for the gate', async () => {
    const exclusive = deferred<void>();
    let queuedStarted = false;
    const registry = new ToolRegistry();
    registry.registerAll([
      makeTool('Exclusive', false, () => exclusive.promise),
      makeTool('QueuedSafe', true, async () => {
        queuedStarted = true;
      }),
    ]);
    const executor = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
    });
    const controller = new AbortController();

    const exclusiveResult = executor.execute('Exclusive', {}, {});
    const queuedResult = executor.execute(
      'QueuedSafe',
      {},
      { signal: controller.signal }
    );
    controller.abort();

    await expect(queuedResult).resolves.toMatchObject({
      success: false,
      metadata: { abortedBeforeLaunch: true },
    });
    expect(queuedStarted).toBe(false);

    exclusive.resolve();
    await exclusiveResult;
  });

  it('returns generic cancellation before dispatch when the signal is already aborted', async () => {
    const executeSpy = vi.fn();
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: 'AbortBeforeDispatch',
        displayName: 'AbortBeforeDispatch',
        kind: ToolKind.Write,
        isConcurrencySafe: false,
        parallelism: 'shared',
        schema: Type.Object({}),
        description: { short: 'pre-dispatch abort boundary' },
        async execute() {
          executeSpy();
          return { success: true, llmContent: 'should not execute' };
        },
      }) as never
    );
    const executor = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
    });
    const controller = new AbortController();
    controller.abort();

    const result = await executor.execute(
      'AbortBeforeDispatch',
      {},
      {
        signal: controller.signal,
      }
    );

    expect(result).toMatchObject({
      success: false,
      metadata: { abortedBeforeLaunch: true },
    });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('preserves a classified remote mutation result after post-dispatch cancellation', async () => {
    const release = deferred<void>();
    const events: string[] = [];
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: 'RemoteMutation',
        displayName: 'RemoteMutation',
        kind: ToolKind.Write,
        isConcurrencySafe: false,
        parallelism: 'shared',
        schema: Type.Object({}),
        description: { short: 'remote mutation cancellation boundary' },
        async execute() {
          events.push('write-dispatched');
          await release.promise;
          events.push('readback-verified');
          return {
            success: true,
            llmContent: 'remote mutation verified',
            metadata: {
              sideEffectsUncertain: false,
              write_acknowledged: true,
              write_verified: true,
            },
          };
        },
      }) as never
    );
    const executor = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
    });
    const controller = new AbortController();

    const resultPromise = executor.execute(
      'RemoteMutation',
      {},
      { signal: controller.signal }
    );
    await vi.waitFor(() => {
      expect(events).toEqual(['write-dispatched']);
    });

    controller.abort();
    release.resolve();

    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      metadata: {
        sideEffectsUncertain: false,
        write_acknowledged: true,
        write_verified: true,
      },
    });
    expect(events).toEqual(['write-dispatched', 'readback-verified']);
  });

  it('preserves an uncertain classified result after post-dispatch cancellation', async () => {
    const release = deferred<void>();
    const events: string[] = [];
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: 'RemoteMutationUncertain',
        displayName: 'RemoteMutationUncertain',
        kind: ToolKind.Write,
        isConcurrencySafe: false,
        parallelism: 'shared',
        schema: Type.Object({}),
        description: { short: 'remote mutation uncertain cancellation boundary' },
        async execute() {
          events.push('write-dispatched');
          await release.promise;
          events.push('readback-classified');
          return {
            success: false,
            llmContent: 'remote mutation uncertain',
            error: {
              type: ToolErrorType.EXECUTION_ERROR,
              message: 'side effects uncertain',
            },
            metadata: {
              sideEffectsUncertain: true,
              write_acknowledged: true,
              write_verified: false,
            },
          };
        },
      }) as never
    );
    const executor = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
    });
    const controller = new AbortController();

    const resultPromise = executor.execute(
      'RemoteMutationUncertain',
      {},
      {
        signal: controller.signal,
      }
    );
    await vi.waitFor(() => {
      expect(events).toEqual(['write-dispatched']);
    });

    controller.abort();
    release.resolve();

    await expect(resultPromise).resolves.toMatchObject({
      success: false,
      metadata: {
        sideEffectsUncertain: true,
        write_acknowledged: true,
        write_verified: false,
      },
      error: {
        type: 'execution_error',
        message: 'side effects uncertain',
      },
    });
    expect(events).toEqual(['write-dispatched', 'readback-classified']);
  });

  it('does not treat prototype metadata as a classified side-effect outcome', async () => {
    const release = deferred<void>();
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: 'PrototypeMetadataMutation',
        displayName: 'PrototypeMetadataMutation',
        kind: ToolKind.Write,
        isConcurrencySafe: false,
        parallelism: 'shared',
        schema: Type.Object({}),
        description: { short: 'prototype metadata should not bypass cancellation' },
        async execute() {
          await release.promise;
          const metadata = Object.create({ sideEffectsUncertain: false }) as Record<
            string,
            unknown
          >;
          metadata.write_acknowledged = true;
          metadata.write_verified = true;
          return {
            success: true,
            llmContent: 'prototype metadata result',
            metadata,
          };
        },
      }) as never
    );
    const executor = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
    });
    const controller = new AbortController();

    const resultPromise = executor.execute(
      'PrototypeMetadataMutation',
      {},
      {
        signal: controller.signal,
      }
    );
    await flushMicrotasks();
    controller.abort();
    release.resolve();

    await expect(resultPromise).resolves.toMatchObject({
      success: false,
      metadata: {
        shouldExitLoop: true,
      },
      error: {
        message: '任务已被用户中止',
      },
    });
  });

  it('keeps shared writes parallel across paths and serialized on one path', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const started: string[] = [];
    const registry = new ToolRegistry();
    registry.register(
      makePathTool('PathWrite', async (filePath) => {
        started.push(filePath);
        return filePath === '/a' ? first.promise : second.promise;
      })
    );
    const executor = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
    });

    const differentA = executor.execute('PathWrite', { file_path: '/a' }, {});
    const differentB = executor.execute('PathWrite', { file_path: '/b' }, {});
    await flushMicrotasks();
    expect(started).toEqual(['/a', '/b']);

    first.resolve();
    second.resolve();
    await Promise.all([differentA, differentB]);

    const sameFirst = deferred<void>();
    const sameSecond = deferred<void>();
    started.length = 0;
    let sameInvocation = 0;
    const sameRegistry = new ToolRegistry();
    sameRegistry.register(
      makePathTool('SamePathWrite', async (filePath) => {
        started.push(`${filePath}:${++sameInvocation}`);
        return sameInvocation === 1 ? sameFirst.promise : sameSecond.promise;
      })
    );
    const sameExecutor = new ToolExecutor(sameRegistry, {
      permissionMode: PermissionMode.YOLO,
    });

    const sameA = sameExecutor.execute('SamePathWrite', { file_path: '/same' }, {});
    const sameB = sameExecutor.execute('SamePathWrite', { file_path: '/same' }, {});
    await flushMicrotasks();
    expect(started).toEqual(['/same:1']);

    sameFirst.resolve();
    await sameA;
    await flushMicrotasks();
    expect(started).toEqual(['/same:1', '/same:2']);
    sameSecond.resolve();
    await sameB;
  });

  it('serializes user approval while keeping approved execution shared', async () => {
    const firstApproval = deferred<{
      approved: true;
      scope: 'once';
    }>();
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: 'SharedApproval',
        displayName: 'SharedApproval',
        kind: ToolKind.Execute,
        isConcurrencySafe: false,
        parallelism: 'shared',
        schema: Type.Object({ value: Type.String() }),
        description: { short: 'approval queue test' },
        extractSignatureContent: (params) => params.value,
        async execute(params) {
          return {
            success: true,
            llmContent: `executed:${params.value}`,
          };
        },
      }) as never
    );
    const executor = new ToolExecutor(registry, {
      permissionConfig: {
        allow: [],
        ask: ['SharedApproval'],
        deny: [],
      },
    });
    let markFirstRequested!: () => void;
    const firstRequested = new Promise<void>((resolve) => {
      markFirstRequested = resolve;
    });
    const confirmation = vi
      .fn()
      .mockImplementationOnce(() => {
        markFirstRequested();
        return firstApproval.promise;
      })
      .mockResolvedValue({ approved: true, scope: 'once' });
    const context = {
      confirmationHandler: { requestConfirmation: confirmation },
    };

    const first = executor.execute('SharedApproval', { value: 'first' }, context);
    const second = executor.execute('SharedApproval', { value: 'second' }, context);

    await firstRequested;
    expect(confirmation).toHaveBeenCalledTimes(1);

    firstApproval.resolve({ approved: true, scope: 'once' });
    await Promise.all([first, second]);
    expect(confirmation).toHaveBeenCalledTimes(2);
    expect(confirmation.mock.calls.map(([details]) => details.title)).toEqual([
      'first',
      'second',
    ]);
  });

  it('uses Session identity so a saturated executor cannot block an eligible peer', async () => {
    const gates = Array.from({ length: 4 }, () => deferred<void>());
    const started: string[] = [];
    const registry = new ToolRegistry();
    for (const [index, name] of ['A1', 'A2', 'A3', 'B1'].entries()) {
      registry.register(
        createTool({
          name,
          displayName: name,
          kind: ToolKind.Execute,
          isConcurrencySafe: false,
          parallelism: 'shared',
          schema: Type.Object({}),
          description: { short: name },
          async execute() {
            started.push(name);
            await gates[index].promise;
            return { success: true, llmContent: `${name}:ok` };
          },
        }) as never
      );
    }
    const scheduler = boundedScheduler();
    const executorA = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
      scheduler,
    });
    const executorB = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
      scheduler,
    });

    const a1 = executorA.execute('A1', {}, { sessionId: 'session-a' });
    const a2 = executorA.execute('A2', {}, { sessionId: 'session-a' });
    const a3 = executorA.execute('A3', {}, { sessionId: 'session-a' });
    const b1 = executorB.execute('B1', {}, { sessionId: 'session-b' });
    await vi.waitFor(() => {
      expect(started).toEqual(['A1', 'A2', 'B1']);
    });
    expect(scheduler.getAdmissionStats()).toMatchObject({
      inFlight: 3,
      queued: 1,
      sessions: {
        'session-a': { inFlight: 2, queued: 1 },
        'session-b': { inFlight: 1, queued: 0 },
      },
    });

    gates[0].resolve();
    await a1;
    await vi.waitFor(() => {
      expect(started).toEqual(['A1', 'A2', 'B1', 'A3']);
    });
    gates[1].resolve();
    gates[2].resolve();
    gates[3].resolve();
    await Promise.all([a2, a3, b1]);
  });

  it('dispose removes only its queued owner and rejects future execution', async () => {
    const activeGate = deferred<void>();
    let disposedToolStarted = false;
    const registry = new ToolRegistry();
    registry.registerAll([
      makeTool('Active', false, () => activeGate.promise),
      makeTool('DisposedQueued', false, async () => {
        disposedToolStarted = true;
      }),
    ]);
    const scheduler = boundedScheduler({
      globalMaxInFlight: 1,
      sessionMaxInFlight: 1,
    });
    const activeExecutor = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
      scheduler,
    });
    const disposedExecutor = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
      scheduler,
    });

    const active = activeExecutor.execute('Active', {}, { sessionId: 'active' });
    const queued = disposedExecutor.execute(
      'DisposedQueued',
      {},
      { sessionId: 'disposed' }
    );
    await vi.waitFor(() => {
      expect(scheduler.getAdmissionStats().queued).toBe(1);
    });
    disposedExecutor.dispose();
    activeGate.resolve();
    await active;

    await expect(queued).resolves.toMatchObject({
      success: false,
      metadata: { abortedBeforeLaunch: true },
    });
    expect(disposedToolStarted).toBe(false);
    await expect(
      disposedExecutor.execute('DisposedQueued', {}, { sessionId: 'disposed' })
    ).resolves.toMatchObject({
      success: false,
      metadata: { abortedBeforeLaunch: true, executorDisposed: true },
    });
  });

  it('maps queue overflow to a retryable resource-exhausted tool result', async () => {
    const activeGate = deferred<void>();
    const registry = new ToolRegistry();
    registry.registerAll([
      makeTool('Active', false, () => activeGate.promise),
      makeTool('Queued', false, async () => undefined),
      makeTool('Overflow', false, async () => undefined),
    ]);
    const scheduler = boundedScheduler({
      globalMaxInFlight: 1,
      globalMaxPending: 1,
      sessionMaxInFlight: 1,
      sessionMaxPending: 1,
    });
    const holder = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
      scheduler,
    });
    const queuedExecutor = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
      scheduler,
    });
    const overflowExecutor = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
      scheduler,
    });

    const active = holder.execute('Active', {}, { sessionId: 'active' });
    const queued = queuedExecutor.execute('Queued', {}, { sessionId: 'queued' });
    await vi.waitFor(() => {
      expect(scheduler.getAdmissionStats().queued).toBe(1);
    });
    const overflow = await overflowExecutor.execute(
      'Overflow',
      {},
      { sessionId: 'overflow' }
    );

    expect(overflow).toMatchObject({
      success: false,
      error: { type: 'resource_exhausted' },
      metadata: {
        tool_admission: {
          code: 'tool_busy',
          reason: 'queue_full',
          scope: 'global',
          retryable: true,
          kind: ToolKind.Execute,
          limit: 1,
        },
      },
    });

    activeGate.resolve();
    await Promise.all([active, queued]);
  });

  it('maps admission timeout to a retryable resource-exhausted tool result', async () => {
    vi.useFakeTimers();
    const activeGate = deferred<void>();
    const registry = new ToolRegistry();
    registry.registerAll([
      makeTool('Active', false, () => activeGate.promise),
      makeTool('TimedOut', false, async () => undefined),
    ]);
    const scheduler = boundedScheduler({
      globalMaxInFlight: 1,
      sessionMaxInFlight: 1,
      waitTimeoutMs: 250,
    });
    const holder = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
      scheduler,
    });
    const waitingExecutor = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
      scheduler,
    });
    const active = holder.execute('Active', {}, { sessionId: 'active' });

    try {
      const waiting = waitingExecutor.execute('TimedOut', {}, { sessionId: 'waiting' });
      await flushMicrotasks();
      expect(scheduler.getAdmissionStats().queued).toBe(1);

      await vi.advanceTimersByTimeAsync(250);
      await expect(waiting).resolves.toMatchObject({
        success: false,
        error: {
          type: 'resource_exhausted',
          code: 'tool_busy',
        },
        metadata: {
          tool_admission: {
            code: 'tool_busy',
            reason: 'wait_timeout',
            scope: 'global',
            retryable: true,
            kind: ToolKind.Execute,
            limit: 1,
          },
        },
      });
    } finally {
      activeGate.resolve();
      await active;
      vi.useRealTimers();
    }
  });

  it('projects one structured progress update when execution queues', async () => {
    const activeGate = deferred<void>();
    const registry = new ToolRegistry();
    registry.registerAll([
      makeTool('Active', false, () => activeGate.promise),
      makeTool('Queued', false, async () => undefined),
    ]);
    const scheduler = boundedScheduler({
      globalMaxInFlight: 1,
      sessionMaxInFlight: 1,
    });
    const holder = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
      scheduler,
    });
    const queuedExecutor = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
      scheduler,
    });
    const onProgressUpdate = vi.fn();

    const active = holder.execute('Active', {}, { sessionId: 'active' });
    const queued = queuedExecutor.execute(
      'Queued',
      {},
      { sessionId: 'queued', onProgressUpdate }
    );
    await vi.waitFor(() => {
      expect(onProgressUpdate).toHaveBeenCalledWith({
        message: 'Waiting for tool execution capacity',
        admission: {
          kind: ToolKind.Execute,
          scope: 'global',
          queuePosition: 1,
          inFlight: 1,
          limit: 1,
        },
      });
    });

    activeGate.resolve();
    await Promise.all([active, queued]);
    expect(onProgressUpdate).toHaveBeenCalledOnce();
  });
});

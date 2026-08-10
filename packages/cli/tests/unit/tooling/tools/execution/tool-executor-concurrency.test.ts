import { describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../../../../src/config/types.js';
import { Type } from '../../../../../src/schema/index.js';
import { createTool } from '../../../../../src/tools/core/createTool.js';
import { ToolExecutor } from '../../../../../src/tools/execution/ToolExecutor.js';
import { ToolRegistry } from '../../../../../src/tools/registry/ToolRegistry.js';
import type { Tool } from '../../../../../src/tools/types/ToolTypes.js';
import { ToolKind } from '../../../../../src/tools/types/ToolTypes.js';

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
});

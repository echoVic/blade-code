import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  order: [] as string[],
  abort: vi.fn(() => {
    state.order.push('abort');
  }),
  shutdownLogger: vi.fn(async () => {
    state.order.push('logger');
  }),
}));

vi.mock('../../../src/logging/Logger.js', () => ({
  LogCategory: { SERVICE: 'service' },
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
  shutdownLogger: state.shutdownLogger,
}));

vi.mock('../../../src/hooks/HookManager.js', () => ({
  HookManager: {
    getInstance: vi.fn(() => ({
      isEnabled: vi.fn(() => false),
      executeSessionEndHooks: vi.fn(),
    })),
  },
}));

vi.mock('../../../src/store/vanilla.js', () => ({
  getState: vi.fn(() => ({
    command: {
      actions: {
        abort: state.abort,
      },
    },
  })),
}));

vi.mock('../../../src/utils/cwd.js', () => ({
  getCwd: vi.fn(() => '/tmp/project'),
}));

describe('GracefulShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.order.length = 0;
    state.abort.mockClear();
    state.shutdownLogger.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    const { getGracefulShutdown } = await import(
      '../../../src/services/GracefulShutdown.js'
    );
    getGracefulShutdown().reset();
  });

  it('settles runtime cleanup before logger shutdown and clears the cleanup timer', async () => {
    const { getGracefulShutdown, registerCleanup } = await import(
      '../../../src/services/GracefulShutdown.js'
    );
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    registerCleanup(async () => {
      state.order.push('runtime');
    });

    await getGracefulShutdown().shutdown('SIGTERM', 0);

    expect(state.order).toEqual(['abort', 'runtime', 'logger']);
    expect(state.abort).toHaveBeenCalledWith('process-shutdown');
    expect(vi.getTimerCount()).toBe(1);

    await vi.runAllTimersAsync();
    expect(exit).toHaveBeenCalledWith(0);
    stdout.mockRestore();
  });
});

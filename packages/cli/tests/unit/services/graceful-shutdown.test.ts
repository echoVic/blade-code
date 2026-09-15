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

  it.each([
    { stdinTTY: false, stdoutTTY: false },
    { stdinTTY: false, stdoutTTY: true },
    { stdinTTY: true, stdoutTTY: false },
    { stdinTTY: true, stdoutTTY: true },
  ])(
    'routes SIGINT according to terminal ownership: %j',
    async ({ stdinTTY, stdoutTTY }) => {
      const { getGracefulShutdown } = await import(
        '../../../src/services/GracefulShutdown.js'
      );
      const manager = getGracefulShutdown();
      const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
      const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
      Object.defineProperty(process.stdin, 'isTTY', {
        value: stdinTTY,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: stdoutTTY,
        configurable: true,
      });
      const events = ['SIGINT', 'SIGTERM'] as const;
      const listeners = new Map(
        events.map((event) => [event, process.listeners(event)])
      );
      const exceptionListeners = process.listeners('uncaughtException');
      const rejectionListeners = process.listeners('unhandledRejection');
      const shutdown = vi.spyOn(manager, 'shutdown').mockResolvedValue(undefined);
      const notice = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.setSystemTime(
        new Date(`2026-09-15T0${Number(stdinTTY) * 2 + Number(stdoutTTY)}:00:00Z`)
      );
      try {
        manager.initialize();
        const handler = process
          .listeners('SIGINT')
          .find((listener) => !listeners.get('SIGINT')?.includes(listener));
        if (!handler) throw new Error('SIGINT handler was not registered');
        handler('SIGINT');
        if (stdinTTY && stdoutTTY) {
          expect(shutdown).not.toHaveBeenCalled();
          expect(notice).toHaveBeenCalled();
          handler('SIGINT');
        } else {
          expect(notice).not.toHaveBeenCalled();
        }
        expect(shutdown).toHaveBeenCalledExactlyOnceWith('SIGINT', 0);
      } finally {
        for (const event of events) {
          for (const listener of process.listeners(event)) {
            if (!listeners.get(event)?.includes(listener))
              process.removeListener(event, listener);
          }
        }
        for (const listener of process.listeners('uncaughtException')) {
          if (!exceptionListeners.includes(listener))
            process.removeListener('uncaughtException', listener);
        }
        for (const listener of process.listeners('unhandledRejection')) {
          if (!rejectionListeners.includes(listener))
            process.removeListener('unhandledRejection', listener);
        }
        if (stdinDescriptor)
          Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
        else Reflect.deleteProperty(process.stdin, 'isTTY');
        if (stdoutDescriptor)
          Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
        else Reflect.deleteProperty(process.stdout, 'isTTY');
      }
    }
  );

  it.each(['SIGTERM', 'normal'] as const)(
    'keeps redirected stdout free of terminal sequences on %s',
    async (reason) => {
      const { getGracefulShutdown } = await import(
        '../../../src/services/GracefulShutdown.js'
      );
      const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        configurable: true,
      });
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      try {
        await getGracefulShutdown().shutdown(reason, 0);
        expect(stdout).not.toHaveBeenCalled();
      } finally {
        vi.clearAllTimers();
        if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
        else Reflect.deleteProperty(process.stdout, 'isTTY');
      }
    }
  );

  it('still restores terminal protocols for interactive stdout', async () => {
    const { getGracefulShutdown } = await import(
      '../../../src/services/GracefulShutdown.js'
    );
    const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await getGracefulShutdown().shutdown('SIGTERM', 0);
      expect(stdout.mock.calls.map(([chunk]) => chunk)).toEqual([
        '\u001b[<u',
        '\u001b[>4;0m',
        '\u001b[?2004l',
        '\u001b[?1004l',
        '\u001b[?1l\u001b>',
        '\u001b[?25h',
        '\u001b[0m',
      ]);
    } finally {
      vi.clearAllTimers();
      if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
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

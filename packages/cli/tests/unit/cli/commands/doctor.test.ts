import { realpathSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const accessMock = vi.hoisted(() => vi.fn());

vi.mock('fs/promises', () => ({
  access: (...args: any[]) => accessMock(...args),
}));

vi.mock('fs', () => ({
  constants: { R_OK: 4, W_OK: 2 },
  realpathSync: (p: string) => p,
  existsSync: () => false,
}));

const setupDoctorCommand = async (
  options: {
    configInitSucceeds?: boolean;
    nodeVersion?: string;
    fsAccessSucceeds?: boolean;
    inkAvailable?: boolean;
  } = {}
) => {
  const {
    configInitSucceeds = true,
    nodeVersion = 'v20.0.0',
    fsAccessSucceeds = true,
    inkAvailable = true,
  } = options;

  vi.resetModules();
  vi.doUnmock('../../../../src/config/ConfigManager.js');
  vi.doUnmock('ink');
  accessMock.mockReset();

  if (fsAccessSucceeds) {
    accessMock.mockResolvedValue(undefined);
  } else {
    accessMock.mockRejectedValue(new Error('no access'));
  }

  const configManager = {
    initialize: vi.fn(async () => {
      /* 模拟实现 */
    }),
  };
  if (!configInitSucceeds) {
    configManager.initialize.mockRejectedValue(new Error('config failed'));
  }

  vi.doMock('../../../../src/config/ConfigManager.js', () => ({
    ConfigManager: {
      getInstance: () => configManager,
    },
  }));

  if (inkAvailable) {
    vi.doMock('ink', () => ({}));
  } else {
    vi.doMock('ink', () => {
      throw new Error('missing');
    });
  }

  const exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation(() => undefined as never);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
    /* 模拟实现 */
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
    /* 模拟实现 */
  });
  const versionSpy = vi.spyOn(process, 'version', 'get').mockReturnValue(nodeVersion);

  const { doctorCommands } = await import('../../../../src/commands/doctor.js');

  return {
    doctorCommands,
    configManager,
    exitSpy,
    logSpy,
    errorSpy,
    versionSpy,
  };
};

describe('commands/doctor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('全部检查通过时不应退出', async () => {
    const { doctorCommands, exitSpy, logSpy } = await setupDoctorCommand();

    await doctorCommands.handler({} as any);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('All checks passed! Blade is ready to use.');
  });

  it('检查失败时应记录问题并退出', async () => {
    const { doctorCommands, exitSpy, logSpy } = await setupDoctorCommand({
      configInitSucceeds: false,
      nodeVersion: 'v16.20.0',
      fsAccessSucceeds: false,
      inkAvailable: false,
    });

    await doctorCommands.handler({} as any);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('[FAIL] Configuration: FAILED')
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[WARN] Node.js version'));
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('[FAIL] File system permissions')
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[FAIL] Dependencies'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

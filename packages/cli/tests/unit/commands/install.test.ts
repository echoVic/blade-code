import { describe, expect, it, vi } from 'vitest';

describe('commands/install', () => {
  it('handler 应在成功时输出安装流程', async () => {
    vi.resetModules();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      /* 模拟实现 */
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* 模拟实现 */
    });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    const { installCommands } = await import('../../../src/commands/install.js');
    await installCommands.handler({ target: 'latest', force: true } as any);

    expect(logSpy).toHaveBeenCalledWith('📦 Installing Blade latest...');
    expect(logSpy).toHaveBeenCalledWith('🔄 Force reinstall enabled');
    expect(logSpy).toHaveBeenCalledWith('✅ Installation completed successfully');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('handler 遇到异常时应记录错误并退出', async () => {
    vi.resetModules();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* 模拟实现 */
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation((message?: string) => {
      if (typeof message === 'string' && message.includes('Installing')) {
        return;
      }
      if (typeof message === 'string' && message.includes('Downloading')) {
        throw new Error('network error');
      }
    });

    const { installCommands } = await import('../../../src/commands/install.js');
    await installCommands.handler({ target: 'stable', force: false } as any);

    expect(logSpy).toHaveBeenCalledWith('📦 Installing Blade stable...');
    expect(errorSpy).toHaveBeenCalledWith('❌ Installation failed: network error');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

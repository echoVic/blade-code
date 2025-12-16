import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execSync: execSyncMock,
}));

describe('utils/environment', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    execSyncMock.mockReset();
  });

  it('getEnvironmentInfo 应返回项目根目录和系统信息', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-02T03:04:05Z'));

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/project/app');

    const existing = new Set(['/project/package.json']);
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('test -e')) {
        const match = cmd.match(/"(.+)"$/);
        if (match && existing.has(match[1])) {
          return '';
        }
        throw new Error('not found');
      }
      throw new Error('unexpected command');
    });

    const { getEnvironmentInfo } = await import('../../../src/utils/environment.js');
    const info = getEnvironmentInfo();

    expect(info.workingDirectory).toBe('/project/app');
    expect(info.projectRoot).toBe('/project');
    expect(info.platform).toBe(`${os.platform()} (${os.arch()})`);
    expect(info.homeDirectory).toBe(os.homedir());
    expect(info.currentDate).toBe('2024-01-02');

    cwdSpy.mockRestore();
    vi.useRealTimers();
  });

  it('getEnvironmentContext 应包含目录和指引信息', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/workspace');
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('test -e')) {
        throw new Error('not found');
      }
      throw new Error('unexpected command');
    });

    const { getEnvironmentContext } = await import('../../../src/utils/environment.js');
    const context = getEnvironmentContext();

    expect(context).toContain('## Working Directory');
    expect(context).toContain('/workspace');
    expect(context).toMatch(/\*\*Node\.js\*\*: v\d+\.\d+\.\d+/);

    cwdSpy.mockRestore();
  });

  it('getDirectoryStructure 应格式化 find 输出', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'env-structure-'));
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('find')) {
        return `${tempDir}\n${path.join(tempDir, 'src')}\n${path.join(tempDir, 'src/utils')}\n`;
      }
      if (cmd.startsWith('test -e')) {
        throw new Error('not found');
      }
      throw new Error('unsupported command');
    });

    const { getDirectoryStructure } = await import('../../../src/utils/environment.js');

    const tree = getDirectoryStructure(tempDir, 2);
    expect(tree).toContain('.');
    expect(tree).toContain('./src');
    expect(tree).toContain('./src/utils');

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('getDirectoryStructure 在命令失败时返回默认值', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('command failed');
    });

    const { getDirectoryStructure } = await import('../../../src/utils/environment.js');

    expect(getDirectoryStructure('/missing')).toBe('.');
  });
});

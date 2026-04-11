import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execSync: execSyncMock,
}));

describe('utils/environment', () => {
  let tempProjectRoot: string;
  let tempSubDir: string;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    execSyncMock.mockReset();

    // 创建真实的临时项目结构以测试 findProjectRoot
    tempProjectRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-env-test-'));
    tempSubDir = path.join(tempProjectRoot, 'sub', 'dir');
    mkdirSync(tempSubDir, { recursive: true });
    writeFileSync(path.join(tempProjectRoot, 'package.json'), '{}');
  });

  afterEach(() => {
    rmSync(tempProjectRoot, { recursive: true, force: true });
  });

  it('getEnvironmentInfo 应返回项目根目录和系统信息', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-02T03:04:05Z'));

    // 设置 cwd 为子目录
    const { setCwdState } = await import('../../../../src/bootstrap/state.js');
    setCwdState(tempSubDir);

    const { getEnvironmentInfo } = await import('../../../../src/utils/environment.js');
    const info = getEnvironmentInfo();

    expect(info.workingDirectory).toBe(tempSubDir);
    expect(info.projectRoot).toBe(tempProjectRoot);
    expect(info.platform).toBe(`${os.platform()} (${os.arch()})`);
    expect(info.homeDirectory).toBe(os.homedir());
    expect(info.currentDate).toBe('2024-01-02');

    vi.useRealTimers();
  });

  it('getEnvironmentContext 应包含目录和指引信息', async () => {
    const { setCwdState } = await import('../../../../src/bootstrap/state.js');
    setCwdState(tempSubDir);

    const { getEnvironmentContext } = await import('../../../../src/utils/environment.js');
    const context = getEnvironmentContext();

    expect(context).toContain('## Working Directory');
    expect(context).toContain(tempSubDir);
    expect(context).toMatch(/\*\*Node\.js\*\*: v\d+\.\d+\.\d+/);
  });

  it('getDirectoryStructure 应格式化 find 输出', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'env-structure-'));
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('find')) {
        return `${tempDir}\n${path.join(tempDir, 'src')}\n${path.join(tempDir, 'src/utils')}\n`;
      }
      throw new Error('unsupported command');
    });

    const { getDirectoryStructure } = await import('../../../../src/utils/environment.js');

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

    const { getDirectoryStructure } = await import('../../../../src/utils/environment.js');

    expect(getDirectoryStructure('/missing')).toBe('.');
  });
});

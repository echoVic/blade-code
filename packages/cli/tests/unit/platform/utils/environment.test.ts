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
  let originalShell: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    execSyncMock.mockReset();

    // 创建真实的临时项目结构以测试 findProjectRoot
    tempProjectRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-env-test-'));
    tempSubDir = path.join(tempProjectRoot, 'sub', 'dir');
    mkdirSync(tempSubDir, { recursive: true });
    mkdirSync(path.join(tempProjectRoot, '.git'));
    writeFileSync(path.join(tempProjectRoot, 'package.json'), '{}');
    writeFileSync(path.join(tempProjectRoot, 'tsconfig.json'), '{}');

    originalShell = process.env.SHELL;
    process.env.SHELL = '/bin/zsh';
  });

  afterEach(() => {
    if (originalShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
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

  it('findProjectRoot 在 monorepo 子包内应优先返回 git 根目录', async () => {
    const packageRoot = path.join(tempProjectRoot, 'packages', 'cli');
    const nestedDir = path.join(packageRoot, 'src', 'prompts');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(path.join(packageRoot, 'package.json'), '{}');

    const { findProjectRoot } = await import('../../../../src/utils/environment.js');

    expect(findProjectRoot(nestedDir)).toBe(tempProjectRoot);
  });

  it('getEnvironmentContext 默认应只包含最小环境信息，不包含 git 快照', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'git rev-parse --abbrev-ref HEAD') {
        return 'feat/upgrade-agent\n';
      }
      if (cmd === 'git status --short') {
        return ' M packages/cli/src/prompts/builder.ts\n';
      }
      if (cmd === 'git log --oneline -n 3') {
        return '9e9371c feat(permission): 增强Bash命令权限检查的语义分析和规范化\n';
      }
      throw new Error(`unsupported command: ${cmd}`);
    });

    const { setCwdState } = await import('../../../../src/bootstrap/state.js');
    setCwdState(tempSubDir);

    const { getEnvironmentContext } = await import('../../../../src/utils/environment.js');
    const context = getEnvironmentContext();

    expect(context).toContain('# Environment');
    expect(context).toContain(`Primary working directory: ${tempSubDir}`);
    expect(context).toContain('Is a git repository: true');
    expect(context).toContain('Shell: zsh');
    expect(context).toContain(`- \`${tempProjectRoot}/package.json\``);
    expect(context).toContain(`- \`${tempProjectRoot}/tsconfig.json\``);
    expect(context).toContain(`When using file tools (read, write, edit), provide absolute paths based on: \`${tempSubDir}/\``);
    expect(context).not.toContain('Current branch: feat/upgrade-agent');
    expect(context).not.toContain('Working tree status:');
    expect(context).not.toContain('Recent commits:');
  });

  it('getEnvironmentContext 在显式启用 git snapshot 时应包含 git 快照', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'git rev-parse --abbrev-ref HEAD') {
        return 'feat/upgrade-agent\n';
      }
      if (cmd === 'git status --short') {
        return ' M packages/cli/src/prompts/builder.ts\n?? packages/cli/src/prompts/sections.ts\n';
      }
      if (cmd === 'git log --oneline -n 3') {
        return '9e9371c feat(permission): 增强Bash命令权限检查的语义分析和规范化\n';
      }
      throw new Error(`unsupported command: ${cmd}`);
    });

    const { setCwdState } = await import('../../../../src/bootstrap/state.js');
    setCwdState(tempSubDir);

    const { getEnvironmentContext } = await import('../../../../src/utils/environment.js');
    const context = getEnvironmentContext({ includeGitSnapshot: true });
    expect(context).toContain('Working tree status:');
    expect(context).toContain('M packages/cli/src/prompts/builder.ts');
    expect(context).toContain('Recent commits:');
    expect(context).toContain('9e9371c feat(permission): 增强Bash命令权限检查的语义分析和规范化');
    expect(context).toContain('Shell: zsh');
    expect(context).toContain(`- \`${tempProjectRoot}/package.json\``);
    expect(context).toContain(`- \`${tempProjectRoot}/tsconfig.json\``);
    expect(context).toContain(`When using file tools (read, write, edit), provide absolute paths based on: \`${tempSubDir}/\``);
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

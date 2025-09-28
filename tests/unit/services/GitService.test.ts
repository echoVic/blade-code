import { spawn } from 'child_process';
import { GitService } from '../../../src/services/gitService.js';

// Mock spawn
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

describe('GitService', () => {
  let gitService: GitService;
  let mockConfig: any;

  beforeEach(() => {
    mockConfig = {
      tools: {
        git: {
          autoDetect: true,
        },
        shell: {
          timeout: 30000,
        },
      },
      llm: {
        model: 'test-model',
        provider: 'test-provider',
      },
    };

    gitService = new GitService(mockConfig);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should initialize successfully', async () => {
    await expect(gitService.initialize()).resolves.not.toThrow();
  });

  it('should initialize git repository', async () => {
    const mockChildProcess = {
      on: jest.fn((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
        return mockChildProcess;
      }),
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
    };

    (spawn as jest.Mock).mockReturnValue(mockChildProcess);

    const result = await gitService.init('/test/repo');

    expect(result.command).toContain('git init');
    expect(spawn).toHaveBeenCalledWith('git', ['init'], expect.any(Object));
  });

  it('should clone repository', async () => {
    const mockChildProcess = {
      on: jest.fn((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
        return mockChildProcess;
      }),
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
    };

    (spawn as jest.Mock).mockReturnValue(mockChildProcess);

    const result = await gitService.clone(
      'https://github.com/test/repo.git',
      '/test/local'
    );

    expect(result.command).toContain('git clone');
    expect(spawn).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        'clone',
        'https://github.com/test/repo.git',
        '/test/local',
      ]),
      expect.any(Object)
    );
  });

  it('should get repository status', async () => {
    const mockChildProcess = {
      on: jest.fn((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
        return mockChildProcess;
      }),
      stdout: {
        on: jest.fn((event, callback) => {
          if (event === 'data') {
            callback('M  modified-file.txt\n?? untracked-file.txt\n');
          }
        }),
      },
      stderr: { on: jest.fn() },
    };

    (spawn as jest.Mock).mockReturnValue(mockChildProcess);

    const status = await gitService.status('/test/repo');

    expect(status.isClean).toBe(false);
    expect(status.changedFiles).toHaveLength(1);
    expect(status.untrackedFiles).toHaveLength(1);
  });

  it('should add files to staging', async () => {
    const mockChildProcess = {
      on: jest.fn((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
        return mockChildProcess;
      }),
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
    };

    (spawn as jest.Mock).mockReturnValue(mockChildProcess);

    const result = await gitService.add('/test/repo', ['file1.txt', 'file2.txt']);

    expect(result.command).toContain('git add');
    expect(spawn).toHaveBeenCalledWith(
      'git',
      ['add', 'file1.txt', 'file2.txt'],
      expect.any(Object)
    );
  });

  it('should commit changes', async () => {
    const mockChildProcess = {
      on: jest.fn((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
        return mockChildProcess;
      }),
      stdout: {
        on: jest.fn((event, callback) => {
          if (event === 'data') {
            callback('[main abc1234] Test commit\n 1 file changed\n');
          }
        }),
      },
      stderr: { on: jest.fn() },
    };

    (spawn as jest.Mock).mockReturnValue(mockChildProcess);

    const result = await gitService.commit('/test/repo', '测试提交');

    expect(result.command).toContain('git commit');
    expect(result.commitInfo).toBeDefined();
    expect(spawn).toHaveBeenCalledWith(
      'git',
      ['commit', '-m', '测试提交'],
      expect.any(Object)
    );
  });

  it('should push changes', async () => {
    const mockChildProcess = {
      on: jest.fn((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
        return mockChildProcess;
      }),
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
    };

    (spawn as jest.Mock).mockReturnValue(mockChildProcess);

    const result = await gitService.push('/test/repo');

    expect(result.command).toContain('git push');
    expect(spawn).toHaveBeenCalledWith('git', ['push'], expect.any(Object));
  });

  it('should pull changes', async () => {
    const mockChildProcess = {
      on: jest.fn((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
        return mockChildProcess;
      }),
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
    };

    (spawn as jest.Mock).mockReturnValue(mockChildProcess);

    const result = await gitService.pull('/test/repo');

    expect(result.command).toContain('git pull');
    expect(spawn).toHaveBeenCalledWith('git', ['pull'], expect.any(Object));
  });

  it('should create branch', async () => {
    const mockChildProcess = {
      on: jest.fn((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
        return mockChildProcess;
      }),
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
    };

    (spawn as jest.Mock).mockReturnValue(mockChildProcess);

    const result = await gitService.createBranch('/test/repo', 'feature-branch');

    expect(result.command).toContain('git branch');
    expect(spawn).toHaveBeenCalledWith(
      'git',
      ['branch', 'feature-branch'],
      expect.any(Object)
    );
  });

  it('should checkout branch', async () => {
    const mockChildProcess = {
      on: jest.fn((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
        return mockChildProcess;
      }),
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
    };

    (spawn as jest.Mock).mockReturnValue(mockChildProcess);

    const result = await gitService.checkout('/test/repo', 'feature-branch');

    expect(result.command).toContain('git checkout');
    expect(spawn).toHaveBeenCalledWith(
      'git',
      ['checkout', 'feature-branch'],
      expect.any(Object)
    );
  });

  it('should list branches', async () => {
    const mockChildProcess = {
      on: jest.fn((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
        return mockChildProcess;
      }),
      stdout: {
        on: jest.fn((event, callback) => {
          if (event === 'data') {
            callback('* main\n  feature-branch\n  develop\n');
          }
        }),
      },
      stderr: { on: jest.fn() },
    };

    (spawn as jest.Mock).mockReturnValue(mockChildProcess);

    const branches = await gitService.listBranches('/test/repo');

    expect(branches).toHaveLength(3);
    expect(branches[0].name).toBe('main');
    expect(branches[0].isCurrent).toBe(true);
  });

  it('should get commit log', async () => {
    const mockChildProcess = {
      on: jest.fn((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
        return mockChildProcess;
      }),
      stdout: {
        on: jest.fn((event, callback) => {
          if (event === 'data') {
            callback(
              'abc1234|张三|zhang@example.com|2023-01-01 12:00:00 +0800|首次提交\n' +
                'def5678|李四|li@example.com|2023-01-02 14:30:00 +0800|修复bug\n'
            );
          }
        }),
      },
      stderr: { on: jest.fn() },
    };

    (spawn as jest.Mock).mockReturnValue(mockChildProcess);

    const commits = await gitService.log('/test/repo');

    expect(commits).toHaveLength(2);
    expect(commits[0].hash).toBe('abc1234');
    expect(commits[0].author.name).toBe('张三');
    expect(commits[0].message).toBe('首次提交');
  });

  it('should handle git command errors', async () => {
    const mockChildProcess = {
      on: jest.fn((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(1), 10); // 非零退出码表示错误
        }
        if (event === 'error') {
          setTimeout(() => callback(new Error('Git命令执行失败')), 10);
        }
        return mockChildProcess;
      }),
      stdout: { on: jest.fn() },
      stderr: {
        on: jest.fn((event, callback) => {
          if (event === 'data') {
            callback('fatal: not a git repository\n');
          }
        }),
      },
    };

    (spawn as jest.Mock).mockReturnValue(mockChildProcess);

    await expect(gitService.status('/invalid/path')).rejects.toThrow('Git命令失败');
  });

  it('should check if directory is git repository', async () => {
    const mockChildProcess = {
      on: jest.fn((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
        return mockChildProcess;
      }),
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
    };

    (spawn as jest.Mock).mockReturnValue(mockChildProcess);

    const isRepo = await gitService.isRepository('/test/repo');

    expect(isRepo).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--git-dir'],
      expect.any(Object)
    );
  });

  it('should get current branch', async () => {
    const mockChildProcess = {
      on: jest.fn((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
        return mockChildProcess;
      }),
      stdout: {
        on: jest.fn((event, callback) => {
          if (event === 'data') {
            callback('main\n');
          }
        }),
      },
      stderr: { on: jest.fn() },
    };

    (spawn as jest.Mock).mockReturnValue(mockChildProcess);

    const branch = await gitService.getCurrentBranch('/test/repo');

    expect(branch).toBe('main');
  });
});

import { promises as fs } from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { FileSystemService } from '../../../src/services/fileSystemService';

// Mock fs module
vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    appendFile: vi.fn(),
    copyFile: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
    access: vi.fn(),
    stat: vi.fn(),
    readdir: vi.fn(),
    watch: vi.fn(),
  },
}));

// Mock path module
vi.mock('path', () => ({
  default: {
    join: vi.fn((...args: string[]) => args.join('/')),
    resolve: vi.fn((...args: string[]) => args.join('/')),
    dirname: vi.fn((p: string) => p.split('/').slice(0, -1).join('/')),
    basename: vi.fn((p: string) => p.split('/').pop()),
    extname: vi.fn((p: string) => {
      const parts = p.split('.');
      return parts.length > 1 ? '.' + parts.pop() : '';
    }),
  },
}));

describe('FileSystemService', () => {
  let fileService: FileSystemService;
  let mockConfig: any;

  beforeEach(() => {
    mockConfig = {
      tools: {
        fileSystem: {
          allowedPaths: [],
          blockedPaths: [],
          maxFileSize: 10 * 1024 * 1024,
        },
      },
      advanced: {
        cache: {
          ttl: 3600000,
          maxSize: 100 * 1024 * 1024,
        },
      },
    };

    fileService = new FileSystemService(mockConfig);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize successfully', async () => {
    await expect(fileService.initialize()).resolves.not.toThrow();
  });

  it('should read file content', async () => {
    const mockContent = '文件内容';
    (fs.readFile as Mock).mockResolvedValue(mockContent);
    (fs.stat as Mock).mockResolvedValue({ size: 1024 });

    const content = await fileService.readFile('/test/file.txt');

    expect(content).toBe(mockContent);
    expect(fs.readFile).toHaveBeenCalledWith('/test/file.txt', undefined);
  });

  it('should write file content', async () => {
    (fs.mkdir as Mock).mockResolvedValue(undefined);
    (fs.writeFile as Mock).mockResolvedValue(undefined);
    (fs.stat as Mock).mockResolvedValue({ size: 1024 });

    await fileService.writeFile('/test/file.txt', '新内容');

    expect(fs.mkdir).toHaveBeenCalledWith(path.dirname('/test/file.txt'), {
      recursive: true,
    });
    expect(fs.writeFile).toHaveBeenCalledWith('/test/file.txt', '新内容', undefined);
  });

  it('should append to file', async () => {
    (fs.appendFile as Mock).mockResolvedValue(undefined);
    (fs.stat as Mock).mockResolvedValue({ size: 1024 });

    await fileService.appendFile('/test/file.txt', '追加内容');

    expect(fs.appendFile).toHaveBeenCalledWith('/test/file.txt', '追加内容', undefined);
  });

  it('should copy file', async () => {
    (fs.copyFile as Mock).mockResolvedValue(undefined);
    (fs.stat as Mock).mockResolvedValue({ size: 1024 });

    await fileService.copyFile('/test/source.txt', '/test/dest.txt');

    expect(fs.copyFile).toHaveBeenCalledWith('/test/source.txt', '/test/dest.txt');
  });

  it('should move file', async () => {
    (fs.rename as Mock).mockResolvedValue(undefined);
    (fs.stat as Mock).mockResolvedValue({ size: 1024 });

    await fileService.moveFile('/test/old.txt', '/test/new.txt');

    expect(fs.rename).toHaveBeenCalledWith('/test/old.txt', '/test/new.txt');
  });

  it('should delete file', async () => {
    (fs.unlink as Mock).mockResolvedValue(undefined);
    (fs.stat as Mock).mockResolvedValue({ size: 1024 });

    await fileService.deleteFile('/test/file.txt');

    expect(fs.unlink).toHaveBeenCalledWith('/test/file.txt');
  });

  it('should create directory', async () => {
    (fs.mkdir as Mock).mockResolvedValue(undefined);
    (fs.stat as Mock).mockResolvedValue({ size: 1024 });

    await fileService.createDirectory('/test/dir');

    expect(fs.mkdir).toHaveBeenCalledWith('/test/dir', { recursive: undefined });
  });

  it('should delete directory', async () => {
    (fs.rm as Mock).mockResolvedValue(undefined);
    (fs.stat as Mock).mockResolvedValue({ size: 1024 });

    await fileService.deleteDirectory('/test/dir');

    expect(fs.rm).toHaveBeenCalledWith('/test/dir', {
      recursive: undefined,
      force: undefined,
    });
  });

  it('should handle file permissions', async () => {
    const mockContent = '文件内容';

    // 设置阻止路径
    mockConfig.tools.fileSystem.blockedPaths = ['/blocked'];

    // 正常文件访问
    (fs.readFile as Mock).mockResolvedValue(mockContent);
    (fs.stat as Mock).mockResolvedValue({ size: 1024 });

    const content = await fileService.readFile('/test/file.txt');
    expect(content).toBe(mockContent);

    // 被阻止路径应该在权限检查时抛出错误
    (fs.stat as Mock).mockRejectedValue(new Error('访问被阻止的路径'));

    await expect(fileService.readFile('/blocked/file.txt')).rejects.toThrow(
      '访问被阻止的路径'
    );
  });

  it('should handle file size limits', async () => {
    const mockContent = '文件内容';
    (fs.readFile as Mock).mockResolvedValue(mockContent);
    (fs.stat as Mock).mockResolvedValue({ size: 1024 });

    const content = await fileService.readFile('/test/file.txt');
    expect(content).toBe(mockContent);

    // 测试大文件限制
    (fs.stat as Mock).mockResolvedValue({ size: 20 * 1024 * 1024 }); // 20MB

    await expect(fileService.readFile('/test/large-file.txt')).rejects.toThrow(
      '文件大小超过限制'
    );
  });

  it('should list directory contents', async () => {
    const mockFiles = ['file1.txt', 'file2.txt', 'dir1'];
    (fs.readdir as Mock).mockResolvedValue(mockFiles);
    // 模拟目录stat调用，返回合理的大小以避免文件大小限制错误
    (fs.stat as Mock).mockResolvedValue({ size: 1024 });

    const files = await fileService.readDirectory('/test');

    expect(files).toEqual(mockFiles);
    expect(fs.readdir).toHaveBeenCalledWith('/test', undefined);
  });

  it('should check file existence', async () => {
    (fs.access as Mock).mockResolvedValue(undefined);

    const exists = await fileService.fileExists('/test/file.txt');

    expect(exists).toBe(true);
    expect(fs.access).toHaveBeenCalledWith('/test/file.txt');
  });

  it('should get file info', async () => {
    const mockStats = {
      size: 1024,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      birthtime: new Date(),
      mtime: new Date(),
      atime: new Date(),
      mode: 0o644,
      uid: 1000,
      gid: 1000,
    };
    (fs.stat as Mock).mockResolvedValue(mockStats);

    const fileInfo = await fileService.getFileInfo('/test/file.txt');

    expect(fileInfo.path).toBe('/test/file.txt');
    expect(fileInfo.size).toBe(1024);
    expect(fileInfo.isFile).toBe(true);
    expect(fileInfo.isDirectory).toBe(false);
    expect(fs.stat).toHaveBeenCalledWith('/test/file.txt');
  });

  it('should check if file exists', async () => {
    (fs.access as Mock).mockResolvedValue(undefined);

    const exists = await fileService.fileExists('/test/file.txt');

    expect(exists).toBe(true);
    expect(fs.access).toHaveBeenCalledWith('/test/file.txt');
  });

  it('should cleanup cache', async () => {
    let stats = fileService.getCacheStats();
    expect(stats.size).toBeGreaterThanOrEqual(0);

    await fileService.cleanupCache();

    stats = fileService.getCacheStats();
    expect(stats.size).toBe(0);
  });
});

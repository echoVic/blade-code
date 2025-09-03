import { promises as fs } from 'fs';
import path from 'path';
import { FileSystemService } from '../src/services/fileSystemService.js';

// Mock fs module
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    appendFile: jest.fn(),
    copyFile: jest.fn(),
    rename: jest.fn(),
    unlink: jest.fn(),
    mkdir: jest.fn(),
    rm: jest.fn(),
    access: jest.fn(),
    stat: jest.fn(),
    readdir: jest.fn(),
    watch: jest.fn(),
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
    jest.clearAllMocks();
  });
  
  it('should initialize successfully', async () => {
    await expect(fileService.initialize()).resolves.not.toThrow();
  });
  
  it('should read file content', async () => {
    const mockContent = '文件内容';
    (fs.readFile as jest.Mock).mockResolvedValue(mockContent);
    
    const content = await fileService.readFile('/test/file.txt');
    
    expect(content).toBe(mockContent);
    expect(fs.readFile).toHaveBeenCalledWith('/test/file.txt', undefined);
  });
  
  it('should write file content', async () => {
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    
    await fileService.writeFile('/test/file.txt', '新内容');
    
    expect(fs.mkdir).toHaveBeenCalledWith(path.dirname('/test/file.txt'), { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledWith('/test/file.txt', '新内容', undefined);
  });
  
  it('should append to file', async () => {
    (fs.appendFile as jest.Mock).mockResolvedValue(undefined);
    
    await fileService.appendFile('/test/file.txt', '追加内容');
    
    expect(fs.appendFile).toHaveBeenCalledWith('/test/file.txt', '追加内容', undefined);
  });
  
  it('should copy file', async () => {
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fs.copyFile as jest.Mock).mockResolvedValue(undefined);
    
    await fileService.copyFile('/source/file.txt', '/dest/file.txt');
    
    expect(fs.mkdir).toHaveBeenCalledWith(path.dirname('/dest/file.txt'), { recursive: true });
    expect(fs.copyFile).toHaveBeenCalledWith('/source/file.txt', '/dest/file.txt');
  });
  
  it('should move file', async () => {
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fs.rename as jest.Mock).mockResolvedValue(undefined);
    
    await fileService.moveFile('/source/file.txt', '/dest/file.txt');
    
    expect(fs.mkdir).toHaveBeenCalledWith(path.dirname('/dest/file.txt'), { recursive: true });
    expect(fs.rename).toHaveBeenCalledWith('/source/file.txt', '/dest/file.txt');
  });
  
  it('should delete file', async () => {
    (fs.unlink as jest.Mock).mockResolvedValue(undefined);
    
    await fileService.deleteFile('/test/file.txt');
    
    expect(fs.unlink).toHaveBeenCalledWith('/test/file.txt');
  });
  
  it('should create directory', async () => {
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    
    await fileService.createDirectory('/test/new-directory');
    
    expect(fs.mkdir).toHaveBeenCalledWith('/test/new-directory', { recursive: undefined });
  });
  
  it('should delete directory', async () => {
    (fs.rm as jest.Mock).mockResolvedValue(undefined);
    
    await fileService.deleteDirectory('/test/directory');
    
    expect(fs.rm).toHaveBeenCalledWith('/test/directory', { recursive: undefined, force: undefined });
  });
  
  it('should check if file exists', async () => {
    (fs.access as jest.Mock).mockResolvedValue(undefined);
    
    const exists = await fileService.fileExists('/test/file.txt');
    
    expect(exists).toBe(true);
    expect(fs.access).toHaveBeenCalledWith('/test/file.txt');
  });
  
  it('should get file info', async () => {
    const mockStats = {
      size: 1024,
      isFile: jest.fn().mockReturnValue(true),
      isDirectory: jest.fn().mockReturnValue(false),
      isSymbolicLink: jest.fn().mockReturnValue(false),
      birthtime: new Date(),
      mtime: new Date(),
      atime: new Date(),
      mode: 0o644,
      uid: 1000,
      gid: 1000,
    };
    
    (fs.stat as jest.Mock).mockResolvedValue(mockStats);
    
    const fileInfo = await fileService.getFileInfo('/test/file.txt');
    
    expect(fileInfo).toBeDefined();
    expect(fileInfo.path).toBe('/test/file.txt');
    expect(fileInfo.size).toBe(1024);
    expect(fileInfo.isFile).toBe(true);
  });
  
  it('should read directory', async () => {
    const mockFiles = ['file1.txt', 'file2.txt', 'dir1'];
    (fs.readdir as jest.Mock).mockResolvedValue(mockFiles);
    
    const files = await fileService.readDirectory('/test');
    
    expect(files).toEqual(mockFiles);
    expect(fs.readdir).toHaveBeenCalledWith('/test', undefined);
  });
  
  it('should handle file permissions', async () => {
    mockConfig.tools.fileSystem.blockedPaths = ['/blocked'];
    mockConfig.tools.fileSystem.allowedPaths = ['/allowed'];
    
    fileService = new FileSystemService(mockConfig);
    
    (fs.stat as jest.Mock).mockResolvedValue({
      size: 5 * 1024 * 1024,
      isFile: jest.fn().mockReturnValue(true),
    });
    
    // 应该拒绝访问被阻止的路径
    await expect(fileService.readFile('/blocked/file.txt'))
      .rejects.toThrow('访问被阻止的路径');
    
    // 应该允许访问被允许的路径
    (fs.readFile as jest.Mock).mockResolvedValue('内容');
    await expect(fileService.readFile('/allowed/file.txt')).resolves.toBe('内容');
  });
  
  it('should handle file size limits', async () => {
    mockConfig.tools.fileSystem.maxFileSize = 1024; // 1KB
    
    fileService = new FileSystemService(mockConfig);
    
    (fs.stat as jest.Mock).mockResolvedValue({
      size: 2048, // 2KB
      isFile: jest.fn().mockReturnValue(true),
    });
    
    await expect(fileService.readFile('/test/large-file.txt'))
      .rejects.toThrow('文件大小超过限制');
  });
  
  it('should cache file content', async () => {
    const mockContent = '文件内容';
    (fs.readFile as jest.Mock).mockResolvedValueOnce(mockContent);
    
    // 第一次读取应该调用fs.readFile
    const content1 = await fileService.readFile('/test/file.txt');
    expect(fs.readFile).toHaveBeenCalledTimes(1);
    
    // 第二次读取应该使用缓存
    const content2 = await fileService.readFile('/test/file.txt');
    expect(fs.readFile).toHaveBeenCalledTimes(1); // 调用次数不变
    expect(content1).toBe(content2);
  });
  
  it('should get cache stats', async () => {
    const mockContent = '文件内容';
    (fs.readFile as jest.Mock).mockResolvedValue(mockContent);
    
    await fileService.readFile('/test/file.txt');
    
    const stats = fileService.getCacheStats();
    expect(stats.size).toBe(1);
    expect(stats.totalSize).toBeGreaterThan(0);
  });
  
  it('should cleanup cache', async () => {
    const mockContent = '文件内容';
    (fs.readFile as jest.Mock).mockResolvedValue(mockContent);
    
    await fileService.readFile('/test/file.txt');
    
    let stats = fileService.getCacheStats();
    expect(stats.size).toBe(1);
    
    await fileService.cleanupCache();
    
    stats = fileService.getCacheStats();
    expect(stats.size).toBe(0);
  });
});
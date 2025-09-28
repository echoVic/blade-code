import { promises as fs, Stats, watch } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { BladeConfig } from '../config/types/index.js';

export class FileSystemService {
  private config: BladeConfig;
  private fileCache: Map<string, FileCacheEntry> = new Map();
  private watcher: any = null; // 实际类型应该是fs.FSWatcher
  private watchedPaths: Set<string> = new Set();

  constructor(config: BladeConfig) {
    this.config = config;
  }

  public async initialize(): Promise<void> {
    console.log('文件系统服务初始化完成');
  }

  // 文件读取操作
  public async readFile(filePath: string, options?: ReadFileOptions): Promise<string | Buffer> {
    try {
      // 检查权限
      await this.checkPathPermission(filePath);
      
      // 检查缓存
      if (options?.useCache !== false) {
        const cached = this.getFileFromCache(filePath);
        if (cached) {
          return cached.content;
        }
      }
      
      // 读取文件
      const content = await fs.readFile(filePath, options?.encoding);
      
      // 缓存文件内容
      if (options?.useCache !== false) {
        this.cacheFile(filePath, content);
      }
      
      return content;
    } catch (error) {
      console.error(`读取文件失败: ${filePath}`, error);
      throw error;
    }
  }

  // 文件写入操作
  public async writeFile(filePath: string, content: string | Buffer, options?: WriteFileOptions): Promise<void> {
    try {
      // 检查权限
      await this.checkPathPermission(filePath);
      
      // 创建目录
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      
      // 写入文件
      await fs.writeFile(filePath, content, options?.encoding);
      
      // 更新缓存
      this.cacheFile(filePath, content);
      
      // 触发文件变更事件
      this.emitFileChangeEvent(filePath, 'change');
      
      console.log(`文件写入成功: ${filePath}`);
    } catch (error) {
      console.error(`写入文件失败: ${filePath}`, error);
      throw error;
    }
  }

  // 文件追加操作
  public async appendFile(filePath: string, content: string, options?: AppendFileOptions): Promise<void> {
    try {
      // 检查权限
      await this.checkPathPermission(filePath);
      
      // 追加内容
      await fs.appendFile(filePath, content, options?.encoding);
      
      // 清除缓存
      this.invalidateCache(filePath);
      
      // 触发文件变更事件
      this.emitFileChangeEvent(filePath, 'change');
      
      console.log(`文件追加成功: ${filePath}`);
    } catch (error) {
      console.error(`追加文件失败: ${filePath}`, error);
      throw error;
    }
  }

  // 文件复制操作
  public async copyFile(src: string, dest: string, options?: CopyFileOptions): Promise<void> {
    try {
      // 检查源文件权限
      await this.checkPathPermission(src);
      // 检查目标文件权限
      await this.checkPathPermission(dest);
      
      // 创建目标目录
      const destDir = path.dirname(dest);
      await fs.mkdir(destDir, { recursive: true });
      
      // 复制文件
      await fs.copyFile(src, dest);
      
      // 清除目标文件缓存
      this.invalidateCache(dest);
      
      // 触发文件变更事件
      this.emitFileChangeEvent(dest, 'create');
      
      console.log(`文件复制成功: ${src} -> ${dest}`);
    } catch (error) {
      console.error(`复制文件失败: ${src} -> ${dest}`, error);
      throw error;
    }
  }

  // 文件移动/重命名操作
  public async moveFile(src: string, dest: string, options?: MoveFileOptions): Promise<void> {
    try {
      // 检查源文件权限
      await this.checkPathPermission(src);
      // 检查目标文件权限
      await this.checkPathPermission(dest);
      
      // 创建目标目录
      const destDir = path.dirname(dest);
      await fs.mkdir(destDir, { recursive: true });
      
      // 移动文件
      await fs.rename(src, dest);
      
      // 更新缓存
      const cached = this.getFileFromCache(src);
      if (cached) {
        this.cacheFile(dest, cached.content);
        this.invalidateCache(src);
      }
      
      // 触发文件变更事件
      this.emitFileChangeEvent(src, 'delete');
      this.emitFileChangeEvent(dest, 'create');
      
      console.log(`文件移动成功: ${src} -> ${dest}`);
    } catch (error) {
      console.error(`移动文件失败: ${src} -> ${dest}`, error);
      throw error;
    }
  }

  // 文件删除操作
  public async deleteFile(filePath: string, options?: DeleteFileOptions): Promise<void> {
    try {
      // 检查权限
      await this.checkPathPermission(filePath);
      
      // 删除文件
      await fs.unlink(filePath);
      
      // 清除缓存
      this.invalidateCache(filePath);
      
      // 触发文件变更事件
      this.emitFileChangeEvent(filePath, 'delete');
      
      console.log(`文件删除成功: ${filePath}`);
    } catch (error) {
      console.error(`删除文件失败: ${filePath}`, error);
      throw error;
    }
  }

  // 目录操作
  public async createDirectory(dirPath: string, options?: CreateDirectoryOptions): Promise<void> {
    try {
      // 检查权限
      await this.checkPathPermission(dirPath);
      
      // 创建目录
      await fs.mkdir(dirPath, { recursive: options?.recursive });
      
      console.log(`目录创建成功: ${dirPath}`);
    } catch (error) {
      console.error(`创建目录失败: ${dirPath}`, error);
      throw error;
    }
  }

  public async deleteDirectory(dirPath: string, options?: DeleteDirectoryOptions): Promise<void> {
    try {
      // 检查权限
      await this.checkPathPermission(dirPath);
      
      // 删除目录
      await fs.rm(dirPath, { 
        recursive: options?.recursive, 
        force: options?.force 
      });
      
      // 清除缓存
      this.invalidateDirectoryCache(dirPath);
      
      console.log(`目录删除成功: ${dirPath}`);
    } catch (error) {
      console.error(`删除目录失败: ${dirPath}`, error);
      throw error;
    }
  }

  // 文件状态检查
  public async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  public async getFileInfo(filePath: string): Promise<FileInfo> {
    try {
      const stats = await fs.stat(filePath);
      return {
        path: filePath,
        size: stats.size,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        isSymbolicLink: stats.isSymbolicLink(),
        createdAt: stats.birthtime,
        modifiedAt: stats.mtime,
        accessedAt: stats.atime,
        permissions: stats.mode,
        owner: stats.uid,
        group: stats.gid,
      };
    } catch (error) {
      console.error(`获取文件信息失败: ${filePath}`, error);
      throw error;
    }
  }

  // 目录遍历
  public async readDirectory(dirPath: string, options?: ReadDirectoryOptions): Promise<string[]> {
    try {
      // 检查权限
      await this.checkPathPermission(dirPath);
      
      const files = await fs.readdir(dirPath, options?.encoding);
      
      // 过滤文件
      if (options?.filter) {
        return files.filter(file => options.filter!(file));
      }
      
      return files;
    } catch (error) {
      console.error(`读取目录失败: ${dirPath}`, error);
      throw error;
    }
  }

  public async walkDirectory(
    dirPath: string, 
    options?: WalkDirectoryOptions
  ): Promise<WalkResult[]> {
    try {
      const results: WalkResult[] = [];
      await this.walkDirectoryInternal(dirPath, results, options, 0);
      return results;
    } catch (error) {
      console.error(`遍历目录失败: ${dirPath}`, error);
      throw error;
    }
  }

  private async walkDirectoryInternal(
    dirPath: string,
    results: WalkResult[],
    options: WalkDirectoryOptions | undefined,
    depth: number
  ): Promise<void> {
    // 检查深度限制
    if (options?.maxDepth && depth > options.maxDepth) {
      return;
    }

    const files = await this.readDirectory(dirPath);
    
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      
      try {
        const stats = await fs.stat(filePath);
        const result: WalkResult = {
          path: filePath,
          name: file,
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
          size: stats.size,
          modifiedAt: stats.mtime,
        };
        
        // 应用过滤器
        if (options?.filter && !options.filter(result)) {
          continue;
        }
        
        results.push(result);
        
        // 递归遍历子目录
        if (result.isDirectory && (!options?.maxDepth || depth < options.maxDepth)) {
          await this.walkDirectoryInternal(filePath, results, options, depth + 1);
        }
      } catch (error) {
        if (!options?.ignoreErrors) {
          throw error;
        }
        console.warn(`无法访问文件: ${filePath}`, error);
      }
    }
  }

  // 文件搜索
  public async searchFiles(
    dirPath: string, 
    pattern: string | RegExp, 
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    try {
      const results: SearchResult[] = [];
      await this.searchFilesInternal(dirPath, pattern, results, options, 0);
      return results;
    } catch (error) {
      console.error(`搜索文件失败: ${dirPath}`, error);
      throw error;
    }
  }

  private async searchFilesInternal(
    dirPath: string,
    pattern: string | RegExp,
    results: SearchResult[],
    options: SearchOptions | undefined,
    depth: number
  ): Promise<void> {
    // 检查深度限制
    if (options?.maxDepth && depth > options.maxDepth) {
      return;
    }

    const files = await this.readDirectory(dirPath);
    
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      
      try {
        const stats = await fs.stat(filePath);
        
        // 检查是否匹配模式
        const isMatch = typeof pattern === 'string' 
          ? file.includes(pattern) 
          : pattern.test(file);
        
        if (isMatch) {
          const result: SearchResult = {
            path: filePath,
            name: file,
            isFile: stats.isFile(),
            isDirectory: stats.isDirectory(),
            size: stats.size,
            modifiedAt: stats.mtime,
          };
          
          results.push(result);
        }
        
        // 递归搜索子目录
        if (stats.isDirectory() && (!options?.maxDepth || depth < options.maxDepth)) {
          await this.searchFilesInternal(filePath, pattern, results, options, depth + 1);
        }
      } catch (error) {
        if (!options?.ignoreErrors) {
          throw error;
        }
        console.warn(`无法访问文件: ${filePath}`, error);
      }
    }
  }

  // 文件内容搜索
  public async searchInFiles(
    dirPath: string,
    searchTerm: string | RegExp,
    options?: SearchInFilesOptions
  ): Promise<SearchInFilesResult[]> {
    const results: SearchInFilesResult[] = [];
    const files = await this.walkDirectory(dirPath, {
      filter: (item) => item.isFile && this.shouldIncludeFile(item.path, options),
      maxDepth: options?.maxDepth,
      ignoreErrors: options?.ignoreErrors,
    });
    
    for (const file of files) {
      try {
        const content = await this.readFile(file.path, { encoding: 'utf-8' }) as string;
        const matches = this.findMatches(content, searchTerm, options);
        
        if (matches.length > 0) {
          results.push({
            filePath: file.path,
            fileName: file.name,
            matches,
          });
        }
      } catch (error) {
        if (!options?.ignoreErrors) {
          console.warn(`无法搜索文件: ${file.path}`, error);
        }
      }
    }
    
    return results;
  }

  private findMatches(
    content: string, 
    searchTerm: string | RegExp, 
    options?: SearchInFilesOptions
  ): MatchResult[] {
    const matches: MatchResult[] = [];
    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineIndex = i + 1;
      
      if (typeof searchTerm === 'string') {
        const index = line.indexOf(searchTerm);
        if (index >= 0) {
          matches.push({
            line: lineIndex,
            column: index + 1,
            content: line,
            match: searchTerm,
          });
        }
      } else {
        let match;
        while ((match = searchTerm.exec(line)) !== null) {
          matches.push({
            line: lineIndex,
            column: match.index + 1,
            content: line,
            match: match[0],
          });
          
          // 避免无限循环
          if (!searchTerm.global) {
            break;
          }
        }
      }
    }
    
    // 限制匹配数量
    if (options?.maxMatches) {
      return matches.slice(0, options.maxMatches);
    }
    
    return matches;
  }

  // 缓存管理
  private cacheFile(filePath: string, content: string | Buffer): void {
    const hash = this.calculateHash(content);
    const entry: FileCacheEntry = {
      content,
      hash,
      timestamp: Date.now(),
      size: Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content),
    };
    
    this.fileCache.set(filePath, entry);
  }

  private getFileFromCache(filePath: string): FileCacheEntry | null {
    const entry = this.fileCache.get(filePath);
    
    if (!entry) {
      return null;
    }
    
    // 检查缓存是否过期
    const maxAge = 3600000; // 1小时
    if (Date.now() - entry.timestamp > maxAge) {
      this.fileCache.delete(filePath);
      return null;
    }
    
    return entry;
  }

  private invalidateCache(filePath: string): void {
    this.fileCache.delete(filePath);
  }

  private invalidateDirectoryCache(dirPath: string): void {
    for (const cachedPath of this.fileCache.keys()) {
      if (cachedPath.startsWith(dirPath)) {
        this.fileCache.delete(cachedPath);
      }
    }
  }

  private calculateHash(content: string | Buffer): string {
    return createHash('md5').update(content).digest('hex');
  }

  // 权限检查
  private async checkPathPermission(filePath: string): Promise<void> {
    // 检查是否在允许的路径中
    const allowedPaths: string[] = [];
    const blockedPaths: string[] = [];
    
    const resolvedPath = path.resolve(filePath);
    
    // 检查阻止列表
    for (const blockedPath of blockedPaths) {
      if (resolvedPath.startsWith(path.resolve(blockedPath))) {
        throw new Error(`访问被阻止的路径: ${filePath}`);
      }
    }
    
    // 检查允许列表
    if (allowedPaths.length > 0) {
      let allowed = false;
      for (const allowedPath of allowedPaths) {
        if (resolvedPath.startsWith(path.resolve(allowedPath))) {
          allowed = true;
          break;
        }
      }
      
      if (!allowed) {
        throw new Error(`访问未授权的路径: ${filePath}`);
      }
    }
    
    // 检查文件大小限制
    try {
      const stats = await fs.stat(filePath);
      const maxSize = 10 * 1024 * 1024; // 10MB
      
      if (stats.size > maxSize) {
        throw new Error(`文件大小超过限制: ${filePath} (${stats.size} > ${maxSize})`);
      }
    } catch (error) {
      // 文件不存在，跳过大小检查
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private shouldIncludeFile(filePath: string, options?: SearchInFilesOptions): boolean {
    const ext = path.extname(filePath).toLowerCase();
    
    // 检查排除的扩展名
    if (options?.excludeExtensions) {
      if (options.excludeExtensions.includes(ext)) {
        return false;
      }
    }
    
    // 检查包含的扩展名
    if (options?.includeExtensions) {
      return options.includeExtensions.includes(ext);
    }
    
    // 默认排除二进制文件
    const binaryExtensions = [
      '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
      '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico',
      '.mp3', '.mp4', '.avi', '.mov', '.wav',
      '.zip', '.rar', '.7z', '.tar', '.gz'
    ];
    
    return !binaryExtensions.includes(ext);
  }

  // 文件监听
  public async watchPath(
    filePath: string, 
    callback: FileChangeCallback,
    options?: WatchOptions
  ): Promise<void> {
    try {
      // 检查权限
      await this.checkPathPermission(filePath);
      
      // 使用fs.watch监听文件变化
      const watcher = watch(filePath, { 
        recursive: options?.recursive 
      }, (eventType: string, filename: string | null) => {
        const fullPath = filename ? path.join(filePath, filename) : filePath;
        callback({
          eventType,
          filePath: fullPath,
          timestamp: Date.now(),
        });
      });
      
      // 保存监听器引用
      if (!this.watcher) {
        this.watcher = new Map();
      }
      
      this.watcher.set(filePath, watcher);
      this.watchedPaths.add(filePath);
      
      console.log(`开始监听路径: ${filePath}`);
    } catch (error) {
      console.error(`监听路径失败: ${filePath}`, error);
      throw error;
    }
  }

  public async unwatchPath(filePath: string): Promise<void> {
    if (this.watcher && this.watcher.has(filePath)) {
      const watcher = this.watcher.get(filePath);
      watcher.close();
      this.watcher.delete(filePath);
      this.watchedPaths.delete(filePath);
      console.log(`停止监听路径: ${filePath}`);
    }
  }

  private emitFileChangeEvent(filePath: string, eventType: FileEventType): void {
    // 这里应该触发文件变更事件
    // 暂时留空，后续实现事件系统
    console.log(`文件变更事件: ${eventType} ${filePath}`);
  }

  // 缓存统计
  public getCacheStats(): CacheStats {
    let totalSize = 0;
    for (const entry of this.fileCache.values()) {
      totalSize += entry.size;
    }
    
    return {
      size: this.fileCache.size,
      totalSize,
      maxSize: 100 * 1024 * 1024, // 100MB
      hitRate: 0, // 需要实现命中率统计
    };
  }

  // 清理缓存
  public async cleanupCache(): Promise<void> {
    const maxAge = 3600000; // 1小时
    const maxSize = 100 * 1024 * 1024; // 100MB
    
    // 清理过期缓存
    const now = Date.now();
    for (const [filePath, entry] of this.fileCache.entries()) {
      if (now - entry.timestamp > maxAge) {
        this.fileCache.delete(filePath);
      }
    }
    
    // 清理超出大小限制的缓存
    let totalSize = 0;
    const entries = Array.from(this.fileCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp); // 按时间排序
    
    for (const [filePath, entry] of entries) {
      totalSize += entry.size;
      if (totalSize > maxSize) {
        this.fileCache.delete(filePath);
      }
    }
    
    console.log('文件缓存清理完成');
  }

  public async destroy(): Promise<void> {
    // 停止所有监听器
    if (this.watcher) {
      for (const [filePath, watcher] of this.watcher.entries()) {
        watcher.close();
        console.log(`停止监听路径: ${filePath}`);
      }
      this.watcher.clear();
    }
    
    this.watchedPaths.clear();
    this.fileCache.clear();
    
    console.log('文件系统服务已销毁');
  }
}

// 类型定义
export interface ReadFileOptions {
  encoding?: BufferEncoding;
  flag?: string;
  useCache?: boolean;
}

export interface WriteFileOptions {
  encoding?: BufferEncoding;
  mode?: number;
  flag?: string;
}

interface AppendFileOptions {
  encoding?: BufferEncoding;
  mode?: number;
  flag?: string;
}

interface CopyFileOptions {
  overwrite?: boolean;
}

interface MoveFileOptions {
  overwrite?: boolean;
}

interface DeleteFileOptions {
  force?: boolean;
}

interface CreateDirectoryOptions {
  recursive?: boolean;
  mode?: number;
}

interface DeleteDirectoryOptions {
  recursive?: boolean;
  force?: boolean;
}

interface ReadDirectoryOptions {
  encoding?: BufferEncoding;
  filter?: (filename: string) => boolean;
}

interface WalkDirectoryOptions {
  filter?: (item: WalkResult) => boolean;
  maxDepth?: number;
  ignoreErrors?: boolean;
}

interface WalkResult {
  path: string;
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  modifiedAt: Date;
}

export interface FileInfo {
  path: string;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  createdAt: Date;
  modifiedAt: Date;
  accessedAt: Date;
  permissions: number;
  owner: number;
  group: number;
}

export interface SearchOptions {
  maxDepth?: number;
  ignoreErrors?: boolean;
}

export interface SearchResult extends WalkResult {}

interface SearchInFilesOptions {
  includeExtensions?: string[];
  excludeExtensions?: string[];
  maxDepth?: number;
  maxMatches?: number;
  ignoreErrors?: boolean;
}

interface SearchInFilesResult {
  filePath: string;
  fileName: string;
  matches: MatchResult[];
}

interface MatchResult {
  line: number;
  column: number;
  content: string;
  match: string;
}

interface FileCacheEntry {
  content: string | Buffer;
  hash: string;
  timestamp: number;
  size: number;
}

interface FileChangeCallback {
  (event: FileChangeEvent): void;
}

interface FileChangeEvent {
  eventType: string;
  filePath: string;
  timestamp: number;
}

type FileEventType = 'create' | 'change' | 'delete';

interface WatchOptions {
  recursive?: boolean;
}

interface CacheStats {
  size: number;
  totalSize: number;
  maxSize: number;
  hitRate: number;
}
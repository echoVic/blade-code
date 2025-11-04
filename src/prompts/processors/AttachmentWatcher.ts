/**
 * 附件文件变化监听器
 *
 * 监听 @ 提及的文件变化，在文件修改时提醒用户
 */

import * as fs from 'fs';
import { EventEmitter } from 'events';
import { createLogger, LogCategory } from '../../logging/Logger.js';

const logger = createLogger(LogCategory.PROMPTS);

/**
 * 文件变化事件
 */
export interface FileChangeEvent {
  /** 文件路径 */
  path: string;
  /** 变化类型 */
  type: 'change' | 'rename' | 'delete';
  /** 时间戳 */
  timestamp: number;
}

/**
 * 监听器选项
 */
export interface WatcherOptions {
  /** 是否持久化监听（默认 true） */
  persistent?: boolean;
  /** 是否递归监听目录（默认 false） */
  recursive?: boolean;
  /** 防抖延迟（毫秒），默认 100ms */
  debounceDelay?: number;
}

/**
 * 附件文件变化监听器
 *
 * 用法：
 * ```typescript
 * const watcher = new AttachmentWatcher();
 * watcher.on('change', (event) => {
 *   console.log(`File changed: ${event.path}`);
 * });
 * watcher.watch(['/path/to/file1.ts', '/path/to/file2.ts']);
 * ```
 */
export class AttachmentWatcher extends EventEmitter {
  private watchers = new Map<string, fs.FSWatcher>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private options: Required<WatcherOptions>;

  constructor(options: WatcherOptions = {}) {
    super();
    this.options = {
      persistent: options.persistent ?? true,
      recursive: options.recursive ?? false,
      debounceDelay: options.debounceDelay ?? 100,
    };

    logger.debug('AttachmentWatcher initialized', this.options);
  }

  /**
   * 开始监听文件列表
   *
   * @param paths - 要监听的文件路径数组
   */
  watch(paths: string[]): void {
    for (const path of paths) {
      this.watchFile(path);
    }

    logger.debug(`Watching ${paths.length} files`);
  }

  /**
   * 监听单个文件
   *
   * @param path - 文件路径
   */
  private watchFile(path: string): void {
    // 如果已经在监听，跳过
    if (this.watchers.has(path)) {
      logger.debug(`Already watching: ${path}`);
      return;
    }

    try {
      const watcher = fs.watch(
        path,
        {
          persistent: this.options.persistent,
          recursive: this.options.recursive,
        },
        (eventType, filename) => {
          this.handleFileChange(path, eventType, filename);
        }
      );

      // 监听错误事件
      watcher.on('error', (error) => {
        logger.error(`Watcher error for ${path}:`, error);
        this.emit('error', { path, error });
        this.unwatch(path);
      });

      this.watchers.set(path, watcher);
      logger.debug(`Started watching: ${path}`);
    } catch (error) {
      logger.error(`Failed to watch ${path}:`, error);
      this.emit('error', { path, error });
    }
  }

  /**
   * 处理文件变化事件（带防抖）
   */
  private handleFileChange(
    path: string,
    eventType: string,
    filename: string | null
  ): void {
    // 清除之前的防抖计时器
    const existingTimer = this.debounceTimers.get(path);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // 设置新的防抖计时器
    const timer = setTimeout(() => {
      this.debounceTimers.delete(path);

      const event: FileChangeEvent = {
        path,
        type: this.mapEventType(eventType),
        timestamp: Date.now(),
      };

      logger.debug(`File changed: ${path} (${event.type})`);
      this.emit('change', event);

      // 如果文件被删除或重命名，停止监听
      if (event.type === 'delete' || event.type === 'rename') {
        this.unwatch(path);
      }
    }, this.options.debounceDelay);

    this.debounceTimers.set(path, timer);
  }

  /**
   * 映射事件类型
   */
  private mapEventType(eventType: string): 'change' | 'rename' | 'delete' {
    switch (eventType) {
      case 'change':
        return 'change';
      case 'rename':
        return 'rename';
      default:
        return 'change';
    }
  }

  /**
   * 停止监听指定文件
   *
   * @param path - 文件路径
   */
  unwatch(path: string): void {
    const watcher = this.watchers.get(path);
    if (watcher) {
      watcher.close();
      this.watchers.delete(path);
      logger.debug(`Stopped watching: ${path}`);
    }

    // 清除防抖计时器
    const timer = this.debounceTimers.get(path);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(path);
    }
  }

  /**
   * 停止监听所有文件
   */
  unwatchAll(): void {
    const paths = Array.from(this.watchers.keys());
    for (const path of paths) {
      this.unwatch(path);
    }

    logger.debug(`Stopped watching all ${paths.length} files`);
  }

  /**
   * 获取当前监听的文件列表
   */
  getWatchedFiles(): string[] {
    return Array.from(this.watchers.keys());
  }

  /**
   * 检查是否正在监听某个文件
   *
   * @param path - 文件路径
   */
  isWatching(path: string): boolean {
    return this.watchers.has(path);
  }

  /**
   * 获取监听器数量
   */
  getWatcherCount(): number {
    return this.watchers.size;
  }

  /**
   * 清理资源（停止所有监听并清除事件监听器）
   */
  dispose(): void {
    this.unwatchAll();
    this.removeAllListeners();
    logger.debug('AttachmentWatcher disposed');
  }
}

/**
 * 创建一个简单的文件变化通知器
 *
 * 用于在对话中提醒用户文件已变化
 */
export class FileChangeNotifier {
  private watcher: AttachmentWatcher;
  private notifications = new Map<string, number>();
  private onNotify: (message: string) => void;

  /**
   * @param onNotify - 通知回调函数
   * @param options - 监听器选项
   */
  constructor(
    onNotify: (message: string) => void,
    options: WatcherOptions = {}
  ) {
    this.watcher = new AttachmentWatcher(options);
    this.onNotify = onNotify;

    // 监听文件变化
    this.watcher.on('change', (event: FileChangeEvent) => {
      this.handleChange(event);
    });

    // 监听错误
    this.watcher.on('error', ({ path, error }) => {
      logger.error(`File watch error for ${path}:`, error);
    });
  }

  /**
   * 开始监听文件
   */
  watch(paths: string[]): void {
    this.watcher.watch(paths);
  }

  /**
   * 处理文件变化
   */
  private handleChange(event: FileChangeEvent): void {
    const now = Date.now();
    const lastNotification = this.notifications.get(event.path) || 0;

    // 防止频繁通知（每个文件最多 5 秒通知一次）
    if (now - lastNotification < 5000) {
      return;
    }

    this.notifications.set(event.path, now);

    let message: string;
    switch (event.type) {
      case 'change':
        message = `📝 File changed: ${event.path}. Consider refreshing the context.`;
        break;
      case 'rename':
        message = `📋 File renamed: ${event.path}. The file may no longer be available.`;
        break;
      case 'delete':
        message = `🗑️  File deleted: ${event.path}. The file is no longer available.`;
        break;
    }

    this.onNotify(message);
  }

  /**
   * 停止监听
   */
  dispose(): void {
    this.watcher.dispose();
    this.notifications.clear();
  }

  /**
   * 获取监听的文件列表
   */
  getWatchedFiles(): string[] {
    return this.watcher.getWatchedFiles();
  }
}

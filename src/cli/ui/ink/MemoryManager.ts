/**
 * UI 内存管理器 - 优化组件内存使用
 */
export class MemoryManager {
  private static instance: MemoryManager;
  private memoryThreshold: number;
  private cleanupCallbacks: Set<() => void>;
  private memoryUsage: Map<string, number>;
  private cleanupInterval: NodeJS.Timeout | null;

  private constructor() {
    this.memoryThreshold = 50 * 1024 * 1024; // 50MB
    this.cleanupCallbacks = new Set();
    this.memoryUsage = new Map();
    this.cleanupInterval = null;

    this.startMemoryMonitoring();
  }

  /**
   * 获取单例实例
   */
  public static getInstance(): MemoryManager {
    if (!MemoryManager.instance) {
      MemoryManager.instance = new MemoryManager();
    }
    return MemoryManager.instance;
  }

  /**
   * 设置内存阈值
   */
  public setMemoryThreshold(bytes: number): void {
    this.memoryThreshold = bytes;
  }

  /**
   * 注册清理回调
   */
  public registerCleanupCallback(callback: () => void): void {
    this.cleanupCallbacks.add(callback);
  }

  /**
   * 注销清理回调
   */
  public unregisterCleanupCallback(callback: () => void): void {
    this.cleanupCallbacks.delete(callback);
  }

  /**
   * 记录组件内存使用
   */
  public trackMemoryUsage(componentId: string, bytes: number): void {
    this.memoryUsage.set(componentId, bytes);
  }

  /**
   * 获取当前内存使用情况
   */
  public getMemoryUsage(): { total: number; components: Map<string, number> } {
    const total = Array.from(this.memoryUsage.values()).reduce((sum, bytes) => sum + bytes, 0);
    return {
      total,
      components: new Map(this.memoryUsage),
    };
  }

  /**
   * 强制执行内存清理
   */
  public forceCleanup(): void {
    // 执行所有注册的清理回调
    for (const callback of this.cleanupCallbacks) {
      try {
        callback();
      } catch (error) {
        console.error('内存清理回调执行失败:', error);
      }
    }

    // 清理内存使用记录
    this.memoryUsage.clear();

    // 建议垃圾回收
    if (global.gc) {
      global.gc();
    }
  }

  /**
   * 检查是否需要清理内存
   */
  private checkMemoryUsage(): boolean {
    const memoryUsage = process.memoryUsage();
    return memoryUsage.heapUsed > this.memoryThreshold;
  }

  /**
   * 开始内存监控
   */
  private startMemoryMonitoring(): void {
    this.cleanupInterval = setInterval(() => {
      if (this.checkMemoryUsage()) {
        this.forceCleanup();
      }
    }, 30000); // 每30秒检查一次

    // 确保在程序退出时清理
    process.on('exit', () => {
      this.stopMemoryMonitoring();
    });
  }

  /**
   * 停止内存监控
   */
  private stopMemoryMonitoring(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * 获取内存使用报告
   */
  public getMemoryReport(): string {
    const memoryUsage = process.memoryUsage();
    const componentUsage = this.getMemoryUsage();

    return `
内存使用报告:
  总堆使用: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB
  总堆大小: ${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB
  外部内存: ${(memoryUsage.external / 1024 / 1024).toFixed(2)} MB
  组件内存: ${(componentUsage.total / 1024 / 1024).toFixed(2)} MB
  组件数量: ${componentUsage.components.size}
    `.trim();
  }
}

// 导出单例实例
export const memoryManager = MemoryManager.getInstance();

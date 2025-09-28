/**
 * 内存泄漏检测器
 */
import React from 'react';
export class MemoryLeakDetector {
  private static instance: MemoryLeakDetector;
  private leakDetectionEnabled: boolean;
  private leakThreshold: number;
  private componentRefs: Map<string, WeakRef<object>>;
  private leakCallbacks: Set<(componentId: string) => void>;
  private detectionInterval: NodeJS.Timeout | null;
  private memorySamples: number[];
  private sampleInterval: number;

  private constructor() {
    this.leakDetectionEnabled = false;
    this.leakThreshold = 1000; // 1000字节的增长阈值
    this.componentRefs = new Map();
    this.leakCallbacks = new Set();
    this.detectionInterval = null;
    this.memorySamples = [];
    this.sampleInterval = 5000; // 5秒采样间隔
  }

  /**
   * 获取单例实例
   */
  public static getInstance(): MemoryLeakDetector {
    if (!MemoryLeakDetector.instance) {
      MemoryLeakDetector.instance = new MemoryLeakDetector();
    }
    return MemoryLeakDetector.instance;
  }

  /**
   * 启用内存泄漏检测
   */
  public enableLeakDetection(): void {
    if (this.leakDetectionEnabled) return;

    this.leakDetectionEnabled = true;
    this.startDetectionCycle();
  }

  /**
   * 禁用内存泄漏检测
   */
  public disableLeakDetection(): void {
    this.leakDetectionEnabled = false;
    this.stopDetectionCycle();
  }

  /**
   * 设置泄漏阈值
   */
  public setLeakThreshold(bytes: number): void {
    this.leakThreshold = bytes;
  }

  /**
   * 注册组件引用用于泄漏检测
   */
  public registerComponentRef(componentId: string, ref: object): void {
    if (!this.leakDetectionEnabled) return;

    this.componentRefs.set(componentId, new WeakRef(ref));
  }

  /**
   * 注销组件引用
   */
  public unregisterComponentRef(componentId: string): void {
    this.componentRefs.delete(componentId);
  }

  /**
   * 注册泄漏检测回调
   */
  public registerLeakCallback(callback: (componentId: string) => void): void {
    this.leakCallbacks.add(callback);
  }

  /**
   * 注销泄漏检测回调
   */
  public unregisterLeakCallback(callback: (componentId: string) => void): void {
    this.leakCallbacks.delete(callback);
  }

  /**
   * 开始检测循环
   */
  private startDetectionCycle(): void {
    this.detectionInterval = setInterval(() => {
      this.detectMemoryLeaks();
    }, this.sampleInterval);
  }

  /**
   * 停止检测循环
   */
  private stopDetectionCycle(): void {
    if (this.detectionInterval) {
      clearInterval(this.detectionInterval);
      this.detectionInterval = null;
    }
  }

  /**
   * 检测内存泄漏
   */
  private detectMemoryLeaks(): void {
    if (!this.leakDetectionEnabled) return;

    // 获取当前内存使用情况
    const currentMemory = process.memoryUsage().heapUsed;
    this.memorySamples.push(currentMemory);

    // 保留最近10个样本
    if (this.memorySamples.length > 10) {
      this.memorySamples.shift();
    }

    // 需要至少两个样本才能检测趋势
    if (this.memorySamples.length < 2) return;

    // 计算内存使用趋势
    const recentSample = this.memorySamples[this.memorySamples.length - 1];
    const previousSample = this.memorySamples[this.memorySamples.length - 2];
    const memoryGrowth = recentSample - previousSample;

    // 如果内存增长超过阈值，进行组件引用检查
    if (memoryGrowth > this.leakThreshold) {
      this.checkComponentLeaks();
    }
  }

  /**
   * 检查组件泄漏
   */
  private checkComponentLeaks(): void {
    // 检查已注册的组件引用
    for (const [componentId, weakRef] of this.componentRefs) {
      // 如果WeakRef无法解析为对象，说明对象已被垃圾回收
      // 这是正常情况，不需要处理
      try {
        const ref = weakRef.deref();
        if (ref === undefined) {
          // 组件已被正确清理，移除引用
          this.componentRefs.delete(componentId);
        }
      } catch (error) {
        // WeakRef可能不可用或出错
        console.warn('无法检查组件引用:', componentId, error);
      }
    }

    // 检查是否有应该被清理但未被清理的组件
    // 这里可以添加更复杂的检测逻辑
  }

  /**
   * 强制执行垃圾回收并检查
   */
  public forceGcAndCheck(): void {
    if (global.gc) {
      global.gc();
      setImmediate(() => {
        this.detectMemoryLeaks();
      });
    } else {
      console.warn('未启用 --expose-gc 标志，无法强制垃圾回收');
    }
  }

  /**
   * 获取内存泄漏检测报告
   */
  public getLeakReport(): string {
    const activeRefs = Array.from(this.componentRefs.entries()).filter(([_, weakRef]) => {
      try {
        return weakRef.deref() !== undefined;
      } catch {
        return false;
      }
    });

    return `
内存泄漏检测报告:
  检测状态: ${this.leakDetectionEnabled ? '启用' : '禁用'}
  泄漏阈值: ${this.leakThreshold} 字节
  监控组件数: ${this.componentRefs.size}
  活跃组件数: ${activeRefs.length}
  内存样本数: ${this.memorySamples.length}
    `.trim();
  }

  /**
   * 清理资源
   */
  public destroy(): void {
    this.disableLeakDetection();
    this.componentRefs.clear();
    this.leakCallbacks.clear();
    this.memorySamples = [];
  }
}

// 导出单例实例
export const memoryLeakDetector = MemoryLeakDetector.getInstance();

/**
 * React Hook - 内存泄漏检测
 */
export const useLeakDetection = (componentId: string, deps: React.DependencyList = []) => {
  // 组件挂载时注册引用
  React.useEffect(() => {
    const componentRef = {};
    memoryLeakDetector.registerComponentRef(componentId, componentRef);

    // 组件卸载时注销引用
    return () => {
      memoryLeakDetector.unregisterComponentRef(componentId);
    };
  }, [componentId, ...deps]);
};

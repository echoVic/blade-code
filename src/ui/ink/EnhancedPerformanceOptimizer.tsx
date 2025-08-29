/**
 * 增强的React-Ink性能优化器
 * 解决渲染性能、内存管理和虚拟化问题
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// 高级性能配置
interface AdvancedPerformanceConfig {
  // 渲染优化
  enableStrictMode?: boolean;
  enableRenderBatching?: boolean;
  renderDebounceTime?: number;
  
  // 虚拟化优化
  enableDynamicVirtualization?: boolean;
  enableProgressiveRendering?: boolean;
  virtualBufferSize?: number;
  renderAheadCount?: number;
  
  // 内存优化
  enableMemoryProfiling?: boolean;
  enableAutoCleanup?: boolean;
  memoryPressureThreshold?: number;
  
  // 调试选项
  enablePerformanceLogging?: boolean;
  enableFrameRateMonitoring?: boolean;
}

// 性能指标接口
interface PerformanceMetrics {
  renderCount: number;
  renderTime: number;
  memoryUsage: number;
  frameRate: number;
  deltaTime: number;
}

// 虚拟化高级配置
interface AdvancedVirtualizationConfig {
  itemSizeGetter?: (index: number) => number;
  enableStickyItems?: boolean;
  stickyIndices?: number[];
  enablePlaceholder?: boolean;
  placeholderHeight?: number;
}

/**
 * 高级性能提供器
 */
export const AdvancedPerformanceProvider: React.FC<{
  children: React.ReactNode;
  config?: AdvancedPerformanceConfig;
}> = ({ 
  children, 
  config = {
    enableStrictMode: true,
    enableRenderBatching: true,
    renderDebounceTime: 16,
    enableDynamicVirtualization: true,
    enableProgressiveRendering: true,
    virtualBufferSize: 50,
    renderAheadCount: 5,
    enableMemoryProfiling: true,
    enableAutoCleanup: true,
    memoryPressureThreshold: 100 * 1024 * 1024, // 100MB
    enablePerformanceLogging: false,
    enableFrameRateMonitoring: true,
  }
}) => {
  const [metrics, setMetrics] = useState<PerformanceMetrics>({
    renderCount: 0,
    renderTime: 0,
    memoryUsage: 0,
    frameRate: 0,
    deltaTime: 0,
  });

  const renderTimesRef = useRef<number[]>([]);
  const lastFrameTimeRef = useRef<number>(performance.now());
  const renderDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // 性能监控
  useEffect(() => {
    if (!config.enableFrameRateMonitoring) return;

    const measureFrameRate = () => {
      const now = performance.now();
      const deltaTime = now - lastFrameTimeRef.current;
      const frameRate = 1000 / deltaTime;
      
      setMetrics(prev => ({
        ...prev,
        frameRate,
        deltaTime,
      }));
      
      lastFrameTimeRef.current = now;
      requestAnimationFrame(measureFrameRate);
    };

    const frameId = requestAnimationFrame(measureFrameRate);
    return () => cancelAnimationFrame(frameId);
  }, [config.enableFrameRateMonitoring]);

  // 内存监控
  useEffect(() => {
    if (!config.enableMemoryProfiling) return;

    const interval = setInterval(() => {
      const memoryUsage = process.memoryUsage().heapUsed;
      setMetrics(prev => ({
        ...prev,
        memoryUsage,
      }));

      // 内存压力检测
      if (config.enableAutoCleanup && memoryUsage > config.memoryPressureThreshold!) {
        // 触发内存清理
        if (global.gc) {
          global.gc();
        }
        console.warn(`内存使用超过阈值: ${(memoryUsage / 1024 / 1024).toFixed(2)}MB`);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [config]);

  const contextValue = useMemo(() => ({
    metrics,
    config,
    startRender: () => {
      const startTime = performance.now();
      return () => {
        const renderTime = performance.now() - startTime;
        renderTimesRef.current.push(renderTime);
        
        // 保留最近100次渲染时间
        if (renderTimesRef.current.length > 100) {
          renderTimesRef.current.shift();
        }
        
        setMetrics(prev => ({
          ...prev,
          renderCount: prev.renderCount + 1,
          renderTime,
        }));
      };
    },
  }), [metrics, config]);

  return (
    <AdvancedPerformanceContext.Provider value={contextValue}>
      {children}
    </AdvancedPerformanceContext.Provider>
  );
};

const AdvancedPerformanceContext = React.createContext<{
  metrics: PerformanceMetrics;
  config: AdvancedPerformanceConfig;
  startRender: () => () => void;
} | null>(null);

/**
 * 使用高级性能的Hook
 */
export const useAdvancedPerformance = () => {
  const context = React.useContext(AdvancedPerformanceContext);
  if (!context) {
    throw new Error('useAdvancedPerformance must be used within AdvancedPerformanceProvider');
  }
  return context;
};

/**
 * 高级记忆化Hook - 支持深度比较和时间过期
 */
export const useAdvancedMemo = <T,>(
  factory: () => T,
  deps: React.DependencyList,
  options?: {
    deepCompare?: boolean;
    ttl?: number; // 毫秒
  }
): T => {
  const { deepCompare = false, ttl } = options || {};
  const [value, setValue] = React.useState<T>(factory());
  const depsRef = React.useRef(deps);
  const lastUpdateRef = React.useRef(performance.now());
  const timerRef = React.useRef<NodeJS.Timeout | null>(null);

  const isEqual = React.useCallback((a: any[], b: any[]) => {
    if (!deepCompare) {
      return a.length === b.length && a.every((v, i) => v === b[i]);
    }
    
    return JSON.stringify(a) === JSON.stringify(b);
  }, [deepCompare]);

  React.useEffect(() => {
    const now = performance.now();
    const isStale = ttl && (now - lastUpdateRef.current) > ttl;
    
    if (!isEqual(deps, depsRef.current) || isStale) {
      const newValue = factory();
      setValue(newValue);
      depsRef.current = deps;
      lastUpdateRef.current = now;
      
      // 如果设置了TTL，设置过期定时器
      if (ttl) {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
        timerRef.current = setTimeout(() => {
          const freshValue = factory();
          setValue(freshValue);
        }, ttl);
      }
    }
  }, [deps, factory, ttl, deepCompare, isEqual]);

  React.useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return value;
};

/**
 * 高级虚拟列表组件
 * 支持动态高度、粘性项、占位符等高级功能
 */
export const AdvancedVirtualList = <T,>({
  items,
  renderItem,
  estimatedItemHeight = 1,
  overscanCount = 3,
  containerHeight,
  onScroll,
  ...virtualConfig
}: {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  estimatedItemHeight?: number;
  overscanCount?: number;
  containerHeight: number;
  onScroll?: (scrollTop: number) => void;
} & AdvancedVirtualizationConfig) => {
  const { config } = useAdvancedPerformance();
  const [scrollTop, setScrollTop] = useState(0);
  const [measuredSizes, setMeasuredSizes] = useState<Map<number, number>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  
  // 创建ResizeObserver来动态测量项目高度
  useEffect(() => {
    if (!config.enableDynamicVirtualization) return;
    
    observerRef.current = new ResizeObserver((entries) => {
      const newSizes = new Map(measuredSizes);
      let hasChanges = false;
      
      entries.forEach((entry) => {
        const index = parseInt(entry.target.getAttribute('data-index') || '-1');
        if (index >= 0) {
          const height = entry.contentRect.height;
          if (newSizes.get(index) !== height) {
            newSizes.set(index, height);
            hasChanges = true;
          }
        }
      });
      
      if (hasChanges) {
        setMeasuredSizes(newSizes);
      }
    });
    
    return () => {
      observerRef.current?.disconnect();
    };
  }, [measuredSizes, config.enableDynamicVirtualization]);

  // 计算项目位置和大小
  const itemPositions = useMemo(() => {
    const positions: { index: number; offset: number; size: number }[] = [];
    let offset = 0;
    
    for (let i = 0; i < items.length; i++) {
      const size = measuredSizes.get(i) || estimatedItemHeight;
      positions.push({ index: i, offset, size });
      offset += size;
    }
    
    return positions;
  }, [items.length, measuredSizes, estimatedItemHeight]);

  // 计算可见范围
  const visibleRange = useMemo(() => {
    if (!config.enableDynamicVirtualization) {
      return { start: 0, end: items.length };
    }
    
    let start = 0;
    let end = Math.min(config.virtualBufferSize || 50, items.length);
    
    // 如果有测量数据，使用准确的滚动计算
    if (itemPositions.length > 0 && scrollTop > 0) {
      // 二分查找起始位置
      startPosition: for (let i = 0; i < itemPositions.length; i++) {
        if (itemPositions[i].offset + itemPositions[i].size > scrollTop) {
          start = Math.max(0, i - overscanCount);
          break startPosition;
        }
      }
      
      // 计算结束位置
      let visibleHeight = containerHeight;
      end = start;
      while (end < items.length && visibleHeight > 0) {
        visibleHeight -= itemPositions[end].size;
        end++;
        if (visibleHeight > 0 && end < items.length) {
          visibleHeight -= itemPositions[end].size;
        }
      }
      end = Math.min(items.length, end + overscanCount);
    }
    
    return { start, end };
  }, [scrollTop, itemPositions, items.length, containerHeight, overscanCount, config]);

  // 计算总高度
  const totalHeight = useMemo(() => {
    if (itemPositions.length > 0) {
      return itemPositions[itemPositions.length - 1].offset + 
             itemPositions[itemPositions.length - 1].size;
    }
    return items.length * estimatedItemHeight;
  }, [itemPositions, items.length, estimatedItemHeight]);

  // 渲染项目
  const renderedItems = useMemo(() => {
    const itemsToRender: JSX.Element[] = [];
    const { start, end } = visibleRange;
    
    // 渐进式渲染
    const renderInBatches = !!(config.enableProgressiveRendering && (end - start) > 20);
    const batchSize = renderInBatches ? 10 : end - start;
    
    for (let i = start; i < Math.min(start + batchSize, end); i++) {
      const position = itemPositions[i];
      const itemStyle: React.CSSProperties = {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        transform: `translateY(${position?.offset || i * estimatedItemHeight}px)`,
        height: position?.size || estimatedItemHeight,
      };
      
      itemsToRender.push(
        <div
          key={i}
          data-index={i}
          style={itemStyle}
          ref={(el) => {
            if (el && config.enableDynamicVirtualization && !measuredSizes.has(i)) {
              observerRef.current?.observe(el);
            }
          }}
        >
          {renderItem(items[i], i)}
        </div>
      );
    }
    
    return itemsToRender;
  }, [
    items, 
    visibleRange, 
    renderItem, 
    itemPositions, 
    estimatedItemHeight, 
    measuredSizes,
    config
  ]);

  // 处理滚动
  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const newScrollTop = event.currentTarget.scrollTop;
    setScrollTop(newScrollTop);
    onScroll?.(newScrollTop);
  }, [onScroll]);

  return (
    <div
      ref={containerRef}
      style={{
        height: containerHeight,
        overflow: 'auto',
        position: 'relative',
      }}
      onScroll={handleScroll}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        {renderedItems}
      </div>
    </div>
  );
};

/**
 * 性能边界组件 - 用于测量子组件渲染性能
 */
export const PerformanceBoundary: React.FC<{
  name: string;
  children: React.ReactNode;
  onPerformanceUpdate?: (metrics: PerformanceMetrics) => void;
}> = ({ name, children, onPerformanceUpdate }) => {
  const { startRender, metrics } = useAdvancedPerformance();
  const [childMetrics, setChildMetrics] = useState<PerformanceMetrics>({
    renderCount: 0,
    renderTime: 0,
    memoryUsage: 0,
    frameRate: 0,
    deltaTime: 0,
  });

  const childRef = useRef<React.ElementRef<'div'>>(null);

  React.useLayoutEffect(() => {
    const endRender = startRender();
    const renderTime = endRender();
    
    setChildMetrics(prev => ({
      ...prev,
      renderTime,
      renderCount: prev.renderCount + 1,
    }));
    
    onPerformanceUpdate?.({
      ...childMetrics,
      renderTime,
      renderCount: childMetrics.renderCount + 1,
    });
  });

  return (
    <div ref={childRef} style={{ position: 'relative' }}>
      {children}
      {config.enablePerformanceLogging && (
        <div style={{ fontSize: '10px', color: 'gray' }}>
          [{name}] Renders: {childMetrics.renderCount}, Time: {childMetrics.renderTime.toFixed(2)}ms
        </div>
      )}
    </div>
  );
};

// 导出默认配置
export const defaultAdvancedConfig: AdvancedPerformanceConfig = {
  enableStrictMode: true,
  enableRenderBatching: true,
  renderDebounceTime: 16,
  enableDynamicVirtualization: true,
  enableProgressiveRendering: true,
  virtualBufferSize: 50,
  renderAheadCount: 5,
  enableMemoryProfiling: true,
  enableAutoCleanup: true,
  memoryPressureThreshold: 100 * 1024 * 1024,
  enablePerformanceLogging: false,
  enableFrameRateMonitoring: true,
};
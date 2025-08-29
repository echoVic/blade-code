/**
 * Ink PerformanceOptimizer 组件 - 性能优化器
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { memoryManager } from './MemoryManager.js';

// 性能优化配置接口
interface PerformanceConfig {
  enableVirtualization?: boolean;
  enableLazyLoading?: boolean;
  enableMemoization?: boolean;
  enableThrottling?: boolean;
  throttleDelay?: number;
  maxRenderItems?: number;
}

// 虚拟化配置接口
interface VirtualizationConfig {
  itemHeight: number;
  overscanCount: number;
  containerHeight: number;
}

// 性能优化上下文
interface PerformanceContextType {
  config: PerformanceConfig;
  updateConfig: (newConfig: Partial<PerformanceConfig>) => void;
}

const PerformanceContext = React.createContext<PerformanceContextType | null>(null);

interface PerformanceProviderProps {
  children: React.ReactNode;
  initialConfig?: PerformanceConfig;
}

/**
 * 性能优化提供器组件
 */
export const PerformanceProvider: React.FC<PerformanceProviderProps> = ({
  children,
  initialConfig = {
    enableVirtualization: true,
    enableLazyLoading: true,
    enableMemoization: true,
    enableThrottling: true,
    throttleDelay: 100,
    maxRenderItems: 100,
  },
}) => {
  const [config, setConfig] = React.useState<PerformanceConfig>(initialConfig);

  const updateConfig = useCallback((newConfig: Partial<PerformanceConfig>) => {
    setConfig(prev => ({ ...prev, ...newConfig }));
  }, []);

  const contextValue: PerformanceContextType = {
    config,
    updateConfig,
  };

  return (
    <PerformanceContext.Provider value={contextValue}>
      {children}
    </PerformanceContext.Provider>
  );
};

/**
 * 使用性能配置的 Hook
 */
export const usePerformance = (): PerformanceContextType => {
  const context = React.useContext(PerformanceContext);
  if (!context) {
    throw new Error('usePerformance must be used within a PerformanceProvider');
  }
  return context;
};

/**
 * 记忆化优化 Hook
 */
export const useOptimizedMemo = <T,>(factory: () => T, deps: React.DependencyList): T => {
  const { config } = usePerformance();
  
  if (config.enableMemoization) {
    return useMemo(factory, deps);
  }
  
  return factory();
};

/**
 * 节流优化 Hook
 */
export const useThrottledCallback = <T extends (...args: any[]) => any>(
  callback: T,
  delay?: number
): T => {
  const { config } = usePerformance();
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastCallRef = useRef<{ args: any[]; thisArg: any } | null>(null);

  if (!config.enableThrottling) {
    return callback;
  }

  const throttledCallback = useCallback((...args: any[]) => {
    const effectiveDelay = delay ?? config.throttleDelay ?? 100;
    
    if (timeoutRef.current) {
      // 保存最后一次调用
      lastCallRef.current = { args, thisArg: this };
      return;
    }

    // 立即执行
    callback.apply(this, args);

    // 设置节流定时器
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      
      // 执行最后一次保存的调用
      if (lastCallRef.current) {
        callback.apply(lastCallRef.current.thisArg, lastCallRef.current.args);
        lastCallRef.current = null;
      }
    }, effectiveDelay);
  }, [callback, delay, config.throttleDelay]) as T;

  // 清理定时器
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return throttledCallback;
};

/**
 * 虚拟化列表组件
 */
interface VirtualizedListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  itemHeight: number;
  containerHeight: number;
  overscanCount?: number;
  onScroll?: (offset: number) => void;
}

export const VirtualizedList = <T,>({
  items,
  renderItem,
  itemHeight,
  containerHeight,
  overscanCount = 5,
  onScroll,
}: VirtualizedListProps<T>) => {
  const { config } = usePerformance();
  const [scrollTop, setScrollTop] = React.useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // 计算可见项范围
  const visibleRange = useMemo(() => {
    if (!config.enableVirtualization) {
      return { start: 0, end: items.length };
    }

    const startIndex = Math.floor(scrollTop / itemHeight);
    const visibleCount = Math.ceil(containerHeight / itemHeight);
    
    return {
      start: Math.max(0, startIndex - overscanCount),
      end: Math.min(items.length, startIndex + visibleCount + overscanCount),
    };
  }, [scrollTop, items.length, itemHeight, containerHeight, overscanCount, config.enableVirtualization]);

  // 处理滚动事件
  const handleScroll = useThrottledCallback((event: React.UIEvent<HTMLDivElement>) => {
    const newScrollTop = event.currentTarget.scrollTop;
    setScrollTop(newScrollTop);
    
    if (onScroll) {
      onScroll(newScrollTop);
    }
  }, config.throttleDelay);

  // 渲染可见项
  const visibleItems = useMemo(() => {
    if (!config.enableVirtualization) {
      // 如果未启用虚拟化，但项目数量超过限制，则进行限制
      const maxItems = config.maxRenderItems ?? 100;
      if (items.length > maxItems) {
        return items.slice(0, maxItems).map((item, index) => (
          <React.Fragment key={index}>
            {renderItem(item, index)}
          </React.Fragment>
        ));
      }
      
      return items.map((item, index) => (
        <React.Fragment key={index}>
          {renderItem(item, index)}
        </React.Fragment>
      ));
    }

    return items.slice(visibleRange.start, visibleRange.end).map((item, index) => {
      const actualIndex = visibleRange.start + index;
      return (
        <div
          key={actualIndex}
          style={{
            height: itemHeight,
            width: '100%',
          }}
        >
          {renderItem(item, actualIndex)}
        </div>
      );
    });
  }, [items, visibleRange, renderItem, itemHeight, config]);

  // 计算容器样式
  const containerStyle = useMemo(() => ({
    height: containerHeight,
    overflow: 'auto',
  }), [containerHeight]);

  // 计算内容样式
  const contentStyle = useMemo(() => ({
    height: config.enableVirtualization ? items.length * itemHeight : 'auto',
    paddingTop: config.enableVirtualization ? visibleRange.start * itemHeight : 0,
  }), [items.length, itemHeight, visibleRange.start, config.enableVirtualization]);

  return (
    <div
      ref={containerRef}
      style={containerStyle}
      onScroll={handleScroll}
    >
      <div style={contentStyle}>
        {visibleItems}
      </div>
    </div>
  );
};

/**
 * 懒加载组件
 */
interface LazyLoadProps {
  children: React.ReactNode;
  placeholder?: React.ReactNode;
  threshold?: number;
}

export const LazyLoad: React.FC<LazyLoadProps> = ({
  children,
  placeholder = null,
  threshold = 100,
}) => {
  const { config } = usePerformance();
  const [isVisible, setIsVisible] = React.useState(false);
  const elementRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!config.enableLazyLoading || isVisible) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: `${threshold}px` }
    );

    if (elementRef.current) {
      observer.observe(elementRef.current);
    }

    return () => {
      observer.disconnect();
    };
  }, [isVisible, threshold, config.enableLazyLoading]);

  return (
    <div ref={elementRef}>
      {isVisible || !config.enableLazyLoading ? children : placeholder}
    </div>
  );
};

/**
 * 性能监控 Hook
 */
export const usePerformanceMonitor = () => {
  const startTimeRef = useRef<number>(0);
  const renderCountRef = useRef<number>(0);

  // 开始性能测量
  const startMeasurement = useCallback(() => {
    startTimeRef.current = performance.now();
    renderCountRef.current = 0;
  }, []);

  // 记录渲染次数
  const recordRender = useCallback(() => {
    renderCountRef.current++;
  }, []);

  // 结束性能测量并返回结果
  const endMeasurement = useCallback(() => {
    const endTime = performance.now();
    const duration = endTime - startTimeRef.current;
    
    return {
      duration,
      renderCount: renderCountRef.current,
      memoryUsage: memoryManager.getMemoryUsage().total,
    };
  }, []);

  return {
    startMeasurement,
    recordRender,
    endMeasurement,
  };
};

// 导出默认配置
export const defaultPerformanceConfig: PerformanceConfig = {
  enableVirtualization: true,
  enableLazyLoading: true,
  enableMemoization: true,
  enableThrottling: true,
  throttleDelay: 100,
  maxRenderItems: 100,
};
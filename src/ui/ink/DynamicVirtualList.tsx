/**
 * 动态高度虚拟列表实现
 * 支持动态测量、批量渲染和内存优化
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAdvancedPerformance } from './EnhancedPerformanceOptimizer.js';

// 动态列表项配置
interface DynamicItemConfig<T> {
  id: keyof T | string;
  height?: number;
  minHeight?: number;
  estimatedHeight?: number;
  sticky?: boolean;
}

// 虚拟列表状态
interface VirtualListState {
  scrollTop: number;
  viewportHeight: number;
  scrollHeight: number;
  isScrolling: boolean;
}

// 渲染策略配置
interface RenderStrategy {
  itemsPerBatch: number;
  renderDelay: number;
  enableProgressiveRender: boolean;
  maxConcurrentRenders: number;
}

/**
 * 动态高度虚拟列表组件
 */
export const DynamicVirtualList = <T,>({
  items,
  renderItem,
  config,
  onScroll,
  onVisibleItemsChange,
}: {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  config: {
    itemHeight?: number;
    overscanCount?: number;
    containerHeight: number;
    itemConfig?: DynamicItemConfig<T>;
  };
  onScroll?: (event: VirtualListState) => void;
  onVisibleItemsChange?: (visibleIndices: number[]) => void;
}) => {
  const { metrics } = useAdvancedPerformance();
  const [state, setState] = useState<VirtualListState>({
    scrollTop: 0,
    viewportHeight: config.containerHeight,
    scrollHeight: 0,
    isScrolling: false,
  });

  // 测量项高度的映射
  const sizeMap = useRef<Map<number, number>>(new Map());
  const positionMap = useRef<Map<number, { offset: number; size: number }>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const renderQueueRef = useRef<number[]>([]);
  const isRenderingRef = useRef(false);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 渲染策略配置
  const renderStrategy: RenderStrategy = useMemo(() => ({
    itemsPerBatch: items.length > 1000 ? 30 : 20,
    renderDelay: 16, // 60fps
    enableProgressiveRender: items.length > 500,
    maxConcurrentRenders: 3,
  }), [items.length]);

  // 初始化ResizeObserver
  useEffect(() => {
    resizeObserverRef.current = new ResizeObserver((entries) => {
      let hasUpdates = false;
      
      entries.forEach((entry) => {
        const index = parseInt(entry.target.getAttribute('data-index') || '-1');
        if (index >= 0 && index < items.length) {
          const size = entry.contentRect.height;
          if (sizeMap.current.get(index) !== size) {
            sizeMap.current.set(index, size);
            hasUpdates = true;
          }
        }
      });
      
      if (hasUpdates) {
        // 重新计算位置
        recalculatePositions();
      }
    });

    return () => {
      resizeObserverRef.current?.disconnect();
    };
  }, [items.length]);

  // 重新计算所有项的位置
  const recalculatePositions = useCallback(() => {
    let offset = 0;
    positionMap.current.clear();
    
    for (let i = 0; i < items.length; i++) {
      const size = sizeMap.current.get(i) || config.itemHeight || 40;
      positionMap.current.set(i, { offset, size });
      offset += size;
    }
    
    setState(prev => ({ ...prev, scrollHeight: offset }));
  }, [items.length, config.itemHeight]);

  // 计算可见范围
  const visibleRange = useMemo(() => {
    const { scrollTop, viewportHeight } = state;
    const overscan = config.overscanCount || 3;
    
    if (positionMap.current.size === 0) {
      // 初次渲染，使用estimated高度
      const estimatedHeight = config.itemHeight || 40;
      const startIndex = Math.max(0, Math.floor(scrollTop / estimatedHeight) - overscan);
      const visibleCount = Math.ceil(viewportHeight / estimatedHeight) + overscan * 2;
      return {
        start: startIndex,
        end: Math.min(items.length, startIndex + visibleCount),
      };
    }
    
    // 使用精确的位置信息
    let start = 0;
    let end = items.length;

    // 二分查找起始位置
    let low = 0;
    let high = items.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const position = positionMap.current.get(mid);
      if (position) {
        if (position.offset + position.size > scrollTop) {
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      }
    }
    start = Math.max(0, low - overscan);

    // 计算结束位置
    let visibleHeight = viewportHeight;
    end = start;
    while (end < items.length && visibleHeight > 0) {
      const position = positionMap.current.get(end);
      if (position) {
        visibleHeight -= position.size;
        end++;
      }
    }
    end = Math.min(items.length, end + overscan);

    return { start, end };
  }, [state.scrollTop, state.viewportHeight, items.length, config]);

  // 处理滚动事件
  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const scrollTop = target.scrollTop;
    const viewportHeight = target.clientHeight;
    
    setState(prev => ({
      ...prev,
      scrollTop,
      viewportHeight,
      isScrolling: true,
    }));

    onScroll?.({
      scrollTop,
      viewportHeight,
      scrollHeight: target.scrollHeight,
      isScrolling: true,
    });

    // 清除之前的超时
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }

    // 设置新的超时来标记滚动结束
    scrollTimeoutRef.current = setTimeout(() => {
      setState(prev => ({ ...prev, isScrolling: false }));
      onScroll?.({
        scrollTop,
        viewportHeight,
        scrollHeight: target.scrollHeight,
        isScrolling: false,
      });
    }, 150);
  }, [onScroll]);

  // 批量渲染处理
  const processRenderQueue = useCallback(() => {
    if (isRenderingRef.current || renderQueueRef.current.length === 0) {
      return;
    }

    isRenderingRef.current = true;
    const batchSize = Math.min(renderStrategy.itemsPerBatch, renderQueueRef.current.length);
    const batch = renderQueueRef.current.splice(0, batchSize);

    // 触发重渲染
    setState(prev => ({ ...prev }));

    // 如果还有项目需要渲染，延迟处理
    if (renderQueueRef.current.length > 0) {
      setTimeout(() => {
        isRenderingRef.current = false;
        processRenderQueue();
      }, renderStrategy.renderDelay);
    } else {
      isRenderingRef.current = false;
    }
  }, [renderStrategy]);

  // 当可见范围改变时，更新渲染队列
  useEffect(() => {
    const { start, end } = visibleRange;
    
    // 生成要渲染的索引列表
    const indicesToRender: number[] = [];
    for (let i = start; i < end; i++) {
      indicesToRender.push(i);
    }

    // 如果启用了渐进渲染，分批处理
    if (renderStrategy.enableProgressiveRender && indicesToRender.length > renderStrategy.itemsPerBatch) {
      renderQueueRef.current = indicesToRender;
      processRenderQueue();
    } else {
      renderQueueRef.current = [];
    }

    // 通知可见项变化
    onVisibleItemsChange?.(indicesToRender);
  }, [visibleRange, renderStrategy, onVisibleItemsChange, processRenderQueue]);

  // 渲染可见项
  const renderedItems = useMemo(() => {
    const { start, end } = visibleRange;
    const items: JSX.Element[] = [];

    // 如果有渲染队列，使用渲染队列
    const indices = renderQueueRef.current.length > 0 
      ? renderQueueRef.current 
      : Array.from({ length: end - start }, (_, i) => start + i);

    indices.forEach((index) => {
      if (index >= 0 && index < items.length) {
        const position = positionMap.current.get(index) || {
          offset: index * (config.itemHeight || 40),
          size: config.itemHeight || 40,
        };

        const itemStyle: React.CSSProperties = {
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          transform: `translateY(${position.offset}px)`,
          height: position.size,
          willChange: state.isScrolling ? 'transform' : 'auto',
        };

        items.push(
          <div
            key={index}
            data-index={index}
            style={itemStyle}
            ref={(el) => {
              if (el && !sizeMap.current.has(index)) {
                resizeObserverRef.current?.observe(el);
              }
            }}
          >
            {renderItem(items[index], index)}
          </div>
        );
      }
    });

    return items;
  }, [
    items, 
    visibleRange, 
    renderItem, 
    config.itemHeight, 
    state.isScrolling,
    renderQueueRef.current.length
  ]);

  // 计算总高度
  const totalHeight = useMemo(() => {
    if (positionMap.current.size > 0) {
      const lastPosition = Array.from(positionMap.current.values()).pop();
      return lastPosition ? lastPosition.offset + lastPosition.size : 0;
    }
    return items.length * (config.itemHeight || 40);
  }, [items.length, config.itemHeight]);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        height: config.containerHeight,
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
 * 快速列表组件 - 针对大量简单列表项优化
 */
export const FastList = <T,>({
  items,
  renderItem,
  config,
}: {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  config: {
    itemHeight: number;
    containerHeight: number;
    bufferSize?: number;
  };
}) => {
  const bufferSize = config.bufferSize || 10;
  const [state, setState] = useState({
    scrollTop: 0,
    viewportHeight: config.containerHeight,
  });

  const containerRef = useRef<HTMLDivElement>(null);

  // 计算可见范围
  const { start, end } = useMemo(() => {
    const startIndex = Math.floor(state.scrollTop / config.itemHeight);
    const visibleCount = Math.ceil(state.viewportHeight / config.itemHeight);
    return {
      start: Math.max(0, startIndex - bufferSize),
      end: Math.min(items.length, startIndex + visibleCount + bufferSize),
    };
  }, [state.scrollTop, state.viewportHeight, items.length, config.itemHeight, bufferSize]);

  // 使用内联样式来提高性能
  const itemsStyle = useMemo(() => {
    const items = [];
    for (let i = start; i < end; i++) {
      items.push(
        `<div key="${i}" style="height:${config.itemHeight}px;transform:translateY(${i * config.itemHeight}px);position:absolute;width:100%;">
          ${renderItemToString(renderItem(items[i], i))}
        </div>`
      );
    }
    return items.join('');
  }, [start, end, items, renderItem, config.itemHeight]);

  return (
    <div
      ref={containerRef}
      style={{
        height: config.containerHeight,
        overflow: 'auto',
        position: 'relative',
      }}
      onScroll={(e) => {
        const target = e.currentTarget;
        setState({
          scrollTop: target.scrollTop,
          viewportHeight: target.clientHeight,
        });
      }}
    >
      <div 
        style={{ 
          height: items.length * config.itemHeight, 
          position: 'relative' 
        }}
        dangerouslySetInnerHTML={{ __html: itemsStyle }}
      />
    </div>
  );
};

// 辅助函数：将React节点转换为字符串
function renderItemToString(node: React.ReactNode): string {
  if (typeof node === 'string') {
    return node;
  }
  if (typeof node === 'number') {
    return node.toString();
  }
  return '';
}

/**
 * 无限滚动Hook - 优化版本
 */
export const useOptimizedInfiniteScroll = ({
  onLoadMore,
  hasMore,
  threshold = 200,
  debounceTime = 200,
}: {
  onLoadMore: () => void | Promise<void>;
  hasMore: boolean;
  threshold?: number;
  debounceTime?: number;
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!hasMore || isLoading) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            // 防抖处理
            if (debounceRef.current) {
              clearTimeout(debounceRef.current);
            }
            
            debounceRef.current = setTimeout(async () => {
              if (hasMore && !isLoading) {
                setIsLoading(true);
                try {
                  await onLoadMore();
                } finally {
                  setIsLoading(false);
                }
              }
            }, debounceTime);
          }
        });
      },
      {
        rootMargin: `${threshold}px`,
        threshold: 0.1,
      }
    );

    const sentinel = document.createElement('div');
    sentinel.style.height = '1px';
    sentinel.style.visibility = 'hidden';
   containerRef.current?.appendChild(sentinel);
    
    observer.observe(sentinel);

    return () => {
      observer.disconnect();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      sentinel.remove();
    };
  }, [onLoadMore, hasMore, isLoading, threshold, debounceTime]);

  return { containerRef, isLoading };
};
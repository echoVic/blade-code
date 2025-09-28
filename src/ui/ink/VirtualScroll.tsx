/**
 * Ink VirtualScroll 组件 - 虚拟滚动实现
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useOptimizedMemo, useThrottledCallback } from './PerformanceOptimizer.js';

// 虚拟滚动项接口
interface VirtualItem<T> {
  index: number;
  data: T;
  offset: number;
  height: number;
}

// 虚拟滚动配置接口
interface VirtualScrollConfig {
  itemHeight: number;
  overscanCount: number;
  containerHeight: number;
  stickyIndices?: number[];
}

// 滚动事件接口
interface ScrollEvent {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

interface VirtualScrollProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  config: VirtualScrollConfig;
  onScroll?: (event: ScrollEvent) => void;
  onVisibleItemsChange?: (visibleIndices: number[]) => void;
  style?: React.CSSProperties;
}

/**
 * 虚拟滚动组件
 */
export const VirtualScroll = <T,>({
  items,
  renderItem,
  config,
  onScroll,
  onVisibleItemsChange,
  style,
}: VirtualScrollProps<T>) => {
  const { itemHeight, overscanCount, containerHeight, stickyIndices = [] } = config;
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  // 注意：这里我们直接使用导入的 hooks，而不是从 context 中获取
  // 因为 usePerformance 返回的是配置，而不是 hooks 本身

  // 计算总高度
  const totalHeight = useMemo(() => {
    return items.length * itemHeight;
  }, [items.length, itemHeight]);

  // 计算可见项范围
  const visibleRange = useOptimizedMemo(() => {
    const startIndex = Math.floor(scrollTop / itemHeight);
    const visibleCount = Math.ceil(containerHeight / itemHeight);

    return {
      start: Math.max(0, startIndex - overscanCount),
      end: Math.min(items.length, startIndex + visibleCount + overscanCount),
    };
  }, [scrollTop, itemHeight, containerHeight, overscanCount, items.length]);

  // 生成虚拟项列表
  const virtualItems = useOptimizedMemo(() => {
    const itemsToRender: VirtualItem<T>[] = [];

    // 添加粘性项（如果有的话）
    for (const index of stickyIndices) {
      if (index >= 0 && index < items.length) {
        itemsToRender.push({
          index,
          data: items[index],
          offset: index * itemHeight,
          height: itemHeight,
        });
      }
    }

    // 添加可见项
    for (let i = visibleRange.start; i < visibleRange.end; i++) {
      // 跳过已经添加的粘性项
      if (stickyIndices.includes(i)) continue;

      itemsToRender.push({
        index: i,
        data: items[i],
        offset: i * itemHeight,
        height: itemHeight,
      });
    }

    // 按索引排序
    return itemsToRender.sort((a, b) => a.index - b.index);
  }, [items, visibleRange, stickyIndices, itemHeight]);

  // 处理滚动事件
  const handleScroll = useThrottledCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.target as HTMLDivElement;
    const newScrollTop = target.scrollTop;

    setScrollTop(newScrollTop);

    // 触发滚动回调
    if (onScroll) {
      onScroll({
        scrollTop: newScrollTop,
        scrollHeight: target.scrollHeight,
        clientHeight: target.clientHeight,
      });
    }

    // 触发可见项变化回调
    if (onVisibleItemsChange) {
      const startIndex = Math.floor(newScrollTop / itemHeight);
      const visibleCount = Math.ceil(containerHeight / itemHeight);
      const visibleIndices = Array.from(
        { length: visibleCount },
        (_, i) => startIndex + i
      ).filter((index) => index >= 0 && index < items.length);

      onVisibleItemsChange(visibleIndices);
    }
  }, 16); // 约60fps

  // 计算容器样式
  const containerStyle = useOptimizedMemo(
    () => ({
      height: containerHeight,
      overflow: 'auto',
      ...style,
    }),
    [containerHeight, style]
  );

  // 计算内容容器样式
  const contentStyle = useOptimizedMemo(
    () => ({
      height: totalHeight,
      position: 'relative' as const,
    }),
    [totalHeight]
  );

  // 渲染虚拟项
  const renderVirtualItems = useOptimizedMemo(() => {
    return virtualItems.map((virtualItem: VirtualItem<T>) => {
      const itemStyle: React.CSSProperties = {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        transform: `translateY(${virtualItem.offset}px)`,
        height: virtualItem.height,
      };

      return (
        <div key={virtualItem.index} style={itemStyle} data-index={virtualItem.index}>
          {renderItem(virtualItem.data, virtualItem.index)}
        </div>
      );
    });
  }, [virtualItems, renderItem]);

  return (
    <div ref={containerRef} style={containerStyle} onScroll={handleScroll}>
      <div style={contentStyle}>{renderVirtualItems}</div>
    </div>
  );
};

/**
 * 懒加载容器组件
 */
interface LazyContainerProps {
  children: React.ReactNode;
  placeholder?: React.ReactNode;
  height?: number | string;
  onIntersect?: () => void;
  threshold?: number;
}

export const LazyContainer: React.FC<LazyContainerProps> = ({
  children,
  placeholder = null,
  height = 'auto',
  onIntersect,
  threshold = 100,
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const hasIntersectedRef = useRef(false);

  useEffect(() => {
    if (isVisible && hasIntersectedRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !hasIntersectedRef.current) {
          setIsVisible(true);
          hasIntersectedRef.current = true;

          if (onIntersect) {
            onIntersect();
          }
        }
      },
      { rootMargin: `${threshold}px` }
    );

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      observer.disconnect();
    };
  }, [onIntersect, threshold]);

  const containerStyle: React.CSSProperties = {
    height,
  };

  return (
    <div ref={containerRef} style={containerStyle}>
      {isVisible ? children : placeholder}
    </div>
  );
};

/**
 * 无限滚动 Hook
 */
interface UseInfiniteScrollOptions {
  onLoadMore: () => void;
  hasMore: boolean;
  threshold?: number;
}

export const useInfiniteScroll = <T,>({
  onLoadMore,
  hasMore,
  threshold = 100,
}: UseInfiniteScrollOptions) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const isLoadingRef = useRef(false);

  useEffect(() => {
    if (!hasMore || isLoadingRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && hasMore && !isLoadingRef.current) {
          isLoadingRef.current = true;
          onLoadMore();

          // 重置加载状态（假设在 onLoadMore 中会更新 hasMore）
          setTimeout(() => {
            isLoadingRef.current = false;
          }, 100);
        }
      },
      { rootMargin: `${threshold}px` }
    );

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      observer.disconnect();
    };
  }, [onLoadMore, hasMore, threshold]);

  return { containerRef };
};

// 导出默认配置
export const defaultVirtualScrollConfig: VirtualScrollConfig = {
  itemHeight: 1,
  overscanCount: 5,
  containerHeight: 20,
};

/*
 * 虚拟滚动 Hook
 * 用于优化大列表的渲染性能
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';

export interface VirtualItem {
  index: number;
  start: number;
  end: number;
  size: number;
}

export interface UseVirtualScrollOptions {
  itemCount: number;
  itemHeight: number | ((index: number) => number);
  viewportHeight: number;
  overscan?: number;
  scrollToItem?: number;
  getItemKey?: (index: number) => string | number;
}

export const useVirtualScroll = (options: UseVirtualScrollOptions) => {
  const {
    itemCount,
    itemHeight,
    viewportHeight,
    overscan = 3,
    scrollToItem: initialScrollToItem,
    getItemKey = (index: number) => index
  } = options;

  const [scrollTop, setScrollTop] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollElementRef = useRef<HTMLElement>(null);

  // 计算项目高度
  const getItemHeight = useCallback((index: number) => {
    return typeof itemHeight === 'function' ? itemHeight(index) : itemHeight;
  }, [itemHeight]);

  // 计算总高度
  const totalHeight = useMemo(() => {
    let height = 0;
    for (let i = 0; i < itemCount; i++) {
      height += getItemHeight(i);
    }
    return height;
  }, [itemCount, getItemHeight]);

  // 计算可见项目
  const visibleItems = useMemo(() => {
    const items: VirtualItem[] = [];
    let startIndex = 0;
    let endIndex = itemCount - 1;
    let accumulatedHeight = 0;

    // 找到起始索引
    for (let i = 0; i < itemCount; i++) {
      const height = getItemHeight(i);
      if (accumulatedHeight + height > scrollTop) {
        startIndex = i;
        break;
      }
      accumulatedHeight += height;
    }

    // 找到结束索引
    accumulatedHeight = 0;
    for (let i = 0; i < itemCount; i++) {
      const height = getItemHeight(i);
      accumulatedHeight += height;
      if (accumulatedHeight > scrollTop + viewportHeight) {
        endIndex = i;
        break;
      }
    }

    // 添加过扫描项目
    startIndex = Math.max(0, startIndex - overscan);
    endIndex = Math.min(itemCount - 1, endIndex + overscan);

    // 生成可见项目
    let currentOffset = 0;
    for (let i = 0; i < startIndex; i++) {
      currentOffset += getItemHeight(i);
    }

    for (let i = startIndex; i <= endIndex; i++) {
      const size = getItemHeight(i);
      items.push({
        index: i,
        start: currentOffset,
        end: currentOffset + size,
        size
      });
      currentOffset += size;
    }

    return items;
  }, [itemCount, scrollTop, viewportHeight, overscan, getItemHeight]);

  // 处理滚动事件
  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.target as HTMLDivElement;
    setScrollTop(target.scrollTop);
  }, []);

  // 滚动到指定项目
  const scrollToItem = useCallback((index: number) => {
    if (!viewportRef.current) return;

    let offset = 0;
    for (let i = 0; i < index; i++) {
      offset += getItemHeight(i);
    }

    viewportRef.current.scrollTop = offset;
    setScrollTop(offset);
  }, [getItemHeight]);

  // 滚动到顶部
  const scrollToTop = useCallback(() => {
    if (!viewportRef.current) return;
    viewportRef.current.scrollTop = 0;
    setScrollTop(0);
  }, []);

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    if (!viewportRef.current) return;
    viewportRef.current.scrollTop = totalHeight;
    setScrollTop(totalHeight);
  }, [totalHeight]);

  // 初始化滚动到指定项目
  useEffect(() => {
    if (initialScrollToItem !== undefined && initialScrollToItem >= 0) {
      scrollToItem(initialScrollToItem);
    }
  }, [initialScrollToItem, scrollToItem]);

  return {
    viewportProps: {
      ref: viewportRef,
      style: {
        height: viewportHeight,
        overflow: 'auto',
        position: 'relative'
      },
      onScroll: handleScroll
    },
    innerProps: {
      style: {
        height: totalHeight,
        position: 'relative'
      }
    },
    visibleItems,
    scrollTop,
    scrollToItem,
    scrollToTop,
    scrollToBottom,
    totalHeight,
    viewportHeight,
    viewportRef,
    scrollElementRef
  };
};
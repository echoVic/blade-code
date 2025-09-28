/**
 * Ink ResponsiveAdapter 组件 - 响应式设计适配器
 */
import React, { createContext, useContext, useEffect, useState } from 'react';
import { Box } from './Box.js';

// 终端尺寸信息接口
interface TerminalSize {
  columns: number;
  rows: number;
}

// 响应式断点配置
interface Breakpoints {
  xs: number;  // 超小屏 (0-40 columns)
  sm: number;  // 小屏 (41-60 columns)
  md: number;  // 中屏 (61-80 columns)
  lg: number;  // 大屏 (81-100 columns)
  xl: number;  // 超大屏 (101+ columns)
}

// 响应式上下文
interface ResponsiveContextType {
  size: TerminalSize;
  breakpoint: keyof Breakpoints;
  breakpoints: Breakpoints;
}

const ResponsiveContext = createContext<ResponsiveContextType | null>(null);

// 默认断点配置
const defaultBreakpoints: Breakpoints = {
  xs: 40,
  sm: 60,
  md: 80,
  lg: 100,
  xl: Infinity,
};

interface ResponsiveProviderProps {
  children: React.ReactNode;
  breakpoints?: Breakpoints;
}

/**
 * 响应式提供器组件
 */
export const ResponsiveProvider: React.FC<ResponsiveProviderProps> = ({
  children,
  breakpoints = defaultBreakpoints,
}) => {
  const [terminalSize, setTerminalSize] = useState<TerminalSize>(() => ({
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  }));

  // 确定当前断点
  const getCurrentBreakpoint = (columns: number): keyof Breakpoints => {
    if (columns <= breakpoints.xs) return 'xs';
    if (columns <= breakpoints.sm) return 'sm';
    if (columns <= breakpoints.md) return 'md';
    if (columns <= breakpoints.lg) return 'lg';
    return 'xl';
  };

  // 监听终端尺寸变化
  useEffect(() => {
    const handleResize = () => {
      setTerminalSize({
        columns: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
      });
    };

    // 初始设置
    handleResize();

    // 监听尺寸变化
    process.stdout.on('resize', handleResize);

    // 清理事件监听器
    return () => {
      process.stdout.removeListener('resize', handleResize);
    };
  }, []);

  const contextValue: ResponsiveContextType = {
    size: terminalSize,
    breakpoint: getCurrentBreakpoint(terminalSize.columns),
    breakpoints,
  };

  return (
    <ResponsiveContext.Provider value={contextValue}>
      {children}
    </ResponsiveContext.Provider>
  );
};

/**
 * 使用响应式信息的 Hook
 */
export const useResponsive = (): ResponsiveContextType => {
  const context = useContext(ResponsiveContext);
  if (!context) {
    throw new Error('useResponsive must be used within a ResponsiveProvider');
  }
  return context;
};

/**
 * 响应式属性映射器
 */
interface ResponsivePropsMapper<T> {
  xs?: T;
  sm?: T;
  md?: T;
  lg?: T;
  xl?: T;
}

interface ResponsiveBoxProps {
  children: React.ReactNode;
  width?: number | string | ResponsivePropsMapper<number | string>;
  height?: number | string | ResponsivePropsMapper<number | string>;
  padding?: number | string | ResponsivePropsMapper<number | string>;
  margin?: number | string | ResponsivePropsMapper<number | string>;
  flexDirection?: 'row' | 'row-reverse' | 'column' | 'column-reverse' | ResponsivePropsMapper<'row' | 'row-reverse' | 'column' | 'column-reverse'>;
  justifyContent?: 'flex-start' | 'flex-end' | 'center' | 'space-between' | 'space-around' | ResponsivePropsMapper<'flex-start' | 'flex-end' | 'center' | 'space-between' | 'space-around'>;
  alignItems?: 'flex-start' | 'flex-end' | 'center' | 'baseline' | 'stretch' | ResponsivePropsMapper<'flex-start' | 'flex-end' | 'center' | 'baseline' | 'stretch'>;
  style?: React.CSSProperties;
}

/**
 * 响应式 Box 组件
 */
export const ResponsiveBox: React.FC<ResponsiveBoxProps> = ({
  children,
  width,
  height,
  padding,
  margin,
  flexDirection,
  justifyContent,
  alignItems,
  style,
}) => {
  const { breakpoint } = useResponsive();

  // 解析响应式属性
  const resolveResponsiveProp = <T,>(prop: T | ResponsivePropsMapper<T> | undefined): T | undefined => {
    if (prop === undefined) return undefined;
    
    if (typeof prop === 'object' && prop !== null && breakpoint in prop) {
      return (prop as ResponsivePropsMapper<T>)[breakpoint];
    }
    
    return prop as T;
  };

  const boxProps = {
    width: resolveResponsiveProp(width),
    height: resolveResponsiveProp(height),
    padding: resolveResponsiveProp(padding),
    margin: resolveResponsiveProp(margin),
    flexDirection: resolveResponsiveProp(flexDirection),
    justifyContent: resolveResponsiveProp(justifyContent),
    alignItems: resolveResponsiveProp(alignItems),
    style,
  };

  return (
    <Box {...boxProps}>
      {children}
    </Box>
  );
};

/**
 * 媒体查询 Hook
 */
export const useMediaQuery = (query: keyof Breakpoints): boolean => {
  const { breakpoint, breakpoints } = useResponsive();
  
  const breakpointValues: Record<keyof Breakpoints, number> = {
    xs: 0,
    sm: breakpoints.xs + 1,
    md: breakpoints.sm + 1,
    lg: breakpoints.md + 1,
    xl: breakpoints.lg + 1,
  };
  
  const queryValue = breakpointValues[query];
  const currentValue = breakpointValues[breakpoint];
  
  return currentValue >= queryValue;
};

/**
 * 终端尺寸信息 Hook
 */
export const useTerminalSize = (): TerminalSize => {
  const { size } = useResponsive();
  return size;
};

/**
 * 断点信息 Hook
 */
export const useBreakpoint = (): keyof Breakpoints => {
  const { breakpoint } = useResponsive();
  return breakpoint;
};

// 导出默认断点配置
export { defaultBreakpoints };

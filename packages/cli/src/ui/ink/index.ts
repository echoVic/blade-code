/**
 * Ink UI 组件入口
 */

export { Animation } from './Animation.js';
export { Box } from './Box.js';
export { Button } from './Button.js';
export { Display } from './Display.js';
export { Input } from './Input.js';
export { InputManager } from './InputManager.js';
export { Layout } from './Layout.js';
export { MemoryManager, memoryManager } from './MemoryManager.js';
export { ProgressBar } from './ProgressBar.js';
export { Spinner } from './Spinner.js';
export { StreamingDisplay } from './StreamingDisplay.js';
export { Text } from './Text.js';
export { useMemoryCleanup } from './useMemoryCleanup.js';

// 响应式设计组件
export { 
  ResponsiveProvider, 
  useResponsive, 
  ResponsiveBox, 
  useMediaQuery, 
  useTerminalSize, 
  useBreakpoint,
  defaultBreakpoints 
} from './ResponsiveAdapter.js';

// 性能优化组件
export {
  PerformanceProvider,
  usePerformance,
  useOptimizedMemo,
  useThrottledCallback,
  VirtualizedList,
  LazyLoad,
  usePerformanceMonitor,
  defaultPerformanceConfig
} from './PerformanceOptimizer.js';

// 虚拟滚动组件
export {
  VirtualScroll,
  LazyContainer,
  useInfiniteScroll,
  defaultVirtualScrollConfig
} from './VirtualScroll.js';

// 内存泄漏检测
export { 
  MemoryLeakDetector, 
  memoryLeakDetector,
  useLeakDetection
} from './MemoryLeakDetector.js';

// 测试组件
export { runUITest, default as TestApp } from './UITest.js';
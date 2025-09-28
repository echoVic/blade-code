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
// 内存泄漏检测
export {
  MemoryLeakDetector,
  memoryLeakDetector,
  useLeakDetection,
} from './MemoryLeakDetector.js';
export { MemoryManager, memoryManager } from './MemoryManager.js';
// 性能优化组件
export {
  defaultPerformanceConfig,
  LazyLoad,
  PerformanceProvider,
  useOptimizedMemo,
  usePerformance,
  usePerformanceMonitor,
  useThrottledCallback,
  VirtualizedList,
} from './PerformanceOptimizer.js';
export { ProgressBar } from './ProgressBar.js';
// 响应式设计组件
export {
  defaultBreakpoints,
  ResponsiveBox,
  ResponsiveProvider,
  useBreakpoint,
  useMediaQuery,
  useResponsive,
  useTerminalSize,
} from './ResponsiveAdapter.js';
export { Spinner } from './Spinner.js';
export { StreamingDisplay } from './StreamingDisplay.js';
export { Text } from './Text.js';
// 测试组件
export { default as TestApp, runUITest } from './UITest.js';
export { useMemoryCleanup } from './useMemoryCleanup.js';
// 虚拟滚动组件
export {
  defaultVirtualScrollConfig,
  LazyContainer,
  useInfiniteScroll,
  VirtualScroll,
} from './VirtualScroll.js';

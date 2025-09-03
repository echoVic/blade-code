// CLI包入口文件

// 核心组件
export { BladeApp, runBladeApp } from './App.js';

// UI组件
export { CommandPalette } from './components/CommandPalette.js';
export { MainLayout } from './components/MainLayout.js';
export { NotificationSystem, useNotify } from './components/NotificationSystem.js';
export { PerformanceMonitor, PerformanceMonitorStatic } from './components/PerformanceMonitor.js';
export { SplashScreen } from './components/SplashScreen.js';
export { StatusBar } from './components/StatusBar.js';

// Hooks
export { useAppNavigation } from './hooks/useAppNavigation.js';
export {
  useKeyboardShortcuts,
  useShortcutHelp,
  useShortcutManager,
} from './hooks/useKeyboardShortcuts.js';

// Contexts
export {
  AppProvider,
  useAppConfig,
  useAppError,
  useAppState,
  useNotifications,
  usePerformance,
  useUserPreferences,
} from './contexts/AppContext.js';

// 配置管理
export { ConfigManager } from './config/config-manager.js';
export type { BladeConfig, UserConfigOverride } from './config/types.js';

// 服务层
export { BuiltinCommandLoader, FileCommandLoader } from './services/CommandLoader.js';
export { CommandService } from './services/CommandService.js';
export { McpPromptLoader } from './services/McpPromptLoader.js';

// 主题系统
export { ThemeManager, themeManager, defaultTheme, darkTheme } from './ui/themes/theme-manager.js';
export type { Theme } from './ui/themes/theme-manager.js';

// 工具函数
export { formatShortcut, parseShortcutString } from './hooks/useKeyboardShortcuts.js';

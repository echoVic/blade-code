// CLI包入口文件

// 配置管理
export { ConfigManager } from "./config/config-manager.js";
export type { BladeConfig, UserConfigOverride } from "./config/types.js";
// Contexts
export {
  AppProvider,
  useAppConfig,
  useAppError,
  useAppState,
  useNotifications,
  usePerformance,
  useUserPreferences,
} from "./contexts/AppContext.js";
// Hooks
export { useAppNavigation } from "./hooks/useAppNavigation.js";
// 工具函数
export {
  formatShortcut,
  parseShortcutString,
  useKeyboardShortcuts,
  useShortcutHelp,
  useShortcutManager,
} from "./hooks/useKeyboardShortcuts.js";
// 服务层
export {
  BuiltinCommandLoader,
  FileCommandLoader,
} from "./services/CommandLoader.js";
export { CommandService } from "./services/CommandService.js";
export { McpPromptLoader } from "./services/McpPromptLoader.js";
// 核心组件
export { AppWrapper, BladeApp } from "./ui/App.js";
// UI组件
export { MainLayout } from "./ui/components/MainLayout.js";
export {
  NotificationSystem,
  useNotify,
} from "./ui/components/NotificationSystem.js";
export {
  PerformanceMonitor,
  PerformanceMonitorStatic,
} from "./ui/components/PerformanceMonitor.js";
export { StatusBar } from "./ui/components/StatusBar.js";
export type { Theme } from "./ui/themes/theme-manager.js";
// 主题系统
export {
  darkTheme,
  defaultTheme,
  ThemeManager,
  themeManager,
} from "./ui/themes/theme-manager.js";

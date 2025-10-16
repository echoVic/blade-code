import React, { useEffect } from 'react';
import type { GlobalOptions } from '../cli/types.js';
import { ConfigManager } from '../config/ConfigManager.js';
import { BladeInterface } from './components/BladeInterface.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { NotificationSystem } from './components/NotificationSystem.js';
import { AppProvider } from './contexts/AppContext.js';
import { SessionProvider } from './contexts/SessionContext.js';
import { themeManager } from './themes/ThemeManager.js';

/**
 * UI 入口层的 props 类型
 * 继承所有 CLI 选项，并添加 UI 特有字段
 */
export interface AppProps extends GlobalOptions {
  // UI 特有字段
  initialMessage?: string; // 初始消息
  // TODO: 实现 initialMessage 自动发送功能
  // 允许用户在启动时直接发送消息：blade "帮我创建一个 React 组件"
  // 需要在 BladeInterface 或 useAppInitializer 中处理此字段
}

// 包装器组件 - 提供会话上下文和错误边界
export const AppWrapper: React.FC<AppProps> = (props) => {
  // 直接传递所有 props，保持 debug 字段的原始类型（支持过滤器）
  const processedProps = {
    ...props,
  };

  // 启动时从配置文件加载主题
  useEffect(() => {
    const loadTheme = async () => {
      try {
        const configManager = ConfigManager.getInstance();
        await configManager.initialize();
        const config = configManager.getConfig();
        const savedTheme = config?.theme;

        if (savedTheme && themeManager.hasTheme(savedTheme)) {
          themeManager.setTheme(savedTheme);
          if (props.debug) {
            console.log(`✓ 已加载主题: ${savedTheme}`);
          }
        }
      } catch (error) {
        // 静默失败，使用默认主题
        if (props.debug) {
          console.warn('⚠️ 主题加载失败，使用默认主题:', error);
        }
      }
    };

    loadTheme();
  }, []); // 只在组件挂载时执行一次

  return (
    <ErrorBoundary>
      <AppProvider>
        <SessionProvider>
          <BladeInterface {...processedProps} />
          <NotificationSystem />
        </SessionProvider>
      </AppProvider>
    </ErrorBoundary>
  );
};

export default AppWrapper;

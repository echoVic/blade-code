import React, { useEffect } from 'react';

import { ConfigManager } from '../config/config-manager.js';
import { BladeInterface } from './components/BladeInterface.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { NotificationSystem } from './components/NotificationSystem.js';
import { AppProvider } from './contexts/AppContext.js';
import { SessionProvider } from './contexts/SessionContext.js';
import { themeManager } from './themes/theme-manager.js';

interface AppProps {
  // 基础选项
  debug?: boolean | string;
  testMode?: boolean;
  verbose?: boolean;

  // 输出选项
  print?: boolean;
  outputFormat?: string;
  includePartialMessages?: boolean;
  inputFormat?: string;
  replayUserMessages?: boolean;

  // 权限和安全选项
  dangerouslySkipPermissions?: boolean;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];

  // MCP 选项
  mcpConfig?: string[];
  strictMcpConfig?: boolean;

  // 会话选项
  continue?: boolean;
  resume?: string;
  forkSession?: boolean;
  sessionId?: string;

  // 模型选项
  model?: string;
  fallbackModel?: string;
  appendSystemPrompt?: string;
  agents?: string;

  // 文件系统选项
  settings?: string;
  addDir?: string[];
  settingSources?: string;

  // IDE 集成
  ide?: boolean;

  // 初始消息
  initialMessage?: string;
}

// 包装器组件 - 提供会话上下文和错误边界
export const AppWrapper: React.FC<AppProps> = (props) => {
  // 在这里处理 debug 参数转换，让 BladeInterface 接收纯净的 boolean
  const processedProps = {
    ...props,
    debug: Boolean(props.debug), // 统一转换为 boolean
  };

  // 启动时从配置文件加载主题
  useEffect(() => {
    const loadTheme = async () => {
      try {
        const configManager = new ConfigManager();
        await configManager.initialize();
        const config = configManager.getConfig();
        const savedTheme = config?.ui?.theme;

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

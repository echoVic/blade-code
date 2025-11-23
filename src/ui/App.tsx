import { useMemoizedFn } from 'ahooks';
import React, { useEffect, useState } from 'react';
import { subagentRegistry } from '../agent/subagents/SubagentRegistry.js';
import type { GlobalOptions } from '../cli/types.js';
import { ConfigManager, mergeRuntimeConfig } from '../config/ConfigManager.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import type { RuntimeConfig } from '../config/types.js';
import { HookManager } from '../hooks/HookManager.js';
import { Logger } from '../logging/Logger.js';
import { BladeInterface } from './components/BladeInterface.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { AppProvider } from './contexts/AppContext.js';
import { FocusProvider } from './contexts/FocusContext.js';
import { SessionProvider } from './contexts/SessionContext.js';
import { themeManager } from './themes/ThemeManager.js';
import { formatErrorMessage } from './utils/security.js';

/**
 * UI 入口层的 props 类型
 * 继承所有 CLI 选项，并添加 UI 特有字段
 */
export interface AppProps extends GlobalOptions {
  // UI 特有字段
  initialMessage?: string; // 初始消息
  resume?: string; // 恢复会话：sessionId 或 true (交互式选择)
}

// ResumeHandler 已移除，所有会话恢复逻辑现在在 BladeInterface 中处理

// 包装器组件 - 提供会话上下文和错误边界
export const AppWrapper: React.FC<AppProps> = (props) => {
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  const initialize = useMemoizedFn(async () => {
    try {
      // 1. 加载配置文件
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      const baseConfig = configManager.getConfig();

      // 2. 合并 CLI 参数生成 RuntimeConfig
      const mergedConfig = mergeRuntimeConfig(baseConfig, props);
      setRuntimeConfig(mergedConfig);

      // 3. 设置全局 Logger 配置（让所有新创建的 Logger 都使用 CLI debug 配置）
      if (mergedConfig.debug) {
        Logger.setGlobalDebug(mergedConfig.debug);
        console.error('[Debug] 全局 Logger 已启用 debug 模式');
        console.error('[Debug] 运行时配置:', mergedConfig);
      }

      // 4. 加载主题
      const savedTheme = mergedConfig.theme;
      if (savedTheme && themeManager.hasTheme(savedTheme)) {
        themeManager.setTheme(savedTheme);
        if (props.debug) {
          console.log(`✓ 已加载主题: ${savedTheme}`);
        }
      }

      // 5. 预加载 subagents 配置（确保 AgentsManager 可以立即使用）
      try {
        const loadedCount = subagentRegistry.loadFromStandardLocations();
        if (props.debug && loadedCount > 0) {
          console.log(
            `✓ 已加载 ${loadedCount} 个 subagents: ${subagentRegistry.getAllNames().join(', ')}`
          );
        }
      } catch (error) {
        // 静默失败，不影响应用启动
        if (props.debug) {
          console.warn('⚠️ Subagents 加载失败:', formatErrorMessage(error));
        }
      }

      // 6. 初始化 HookManager
      try {
        const hookManager = HookManager.getInstance();
        hookManager.loadConfig(mergedConfig.hooks || {});
        if (props.debug && mergedConfig.hooks?.enabled) {
          console.log('✓ Hooks 系统已启用');
        }
      } catch (error) {
        // 静默失败，不影响应用启动
        if (props.debug) {
          console.warn('⚠️ Hooks 初始化失败:', formatErrorMessage(error));
        }
      }

      setIsInitialized(true);
    } catch (error) {
      // 静默失败，使用默认配置
      if (props.debug) {
        console.warn('⚠️ 配置初始化失败，使用默认配置:', formatErrorMessage(error));
      }
      // 即使失败也设置为已初始化，使用默认配置 + CLI 参数
      const fallbackConfig = mergeRuntimeConfig(DEFAULT_CONFIG, props);
      setRuntimeConfig(fallbackConfig);

      // 设置全局 Logger 配置（fallback 情况）
      if (fallbackConfig.debug) {
        Logger.setGlobalDebug(fallbackConfig.debug);
        console.error('[Debug] 全局 Logger 已启用 debug 模式（fallback）');
      }

      setIsInitialized(true);
    }
  });

  // 启动时初始化配置和主题
  useEffect(() => {
    initialize();
  }, []); // 只在组件挂载时执行一次

  // 等待配置初始化完成
  if (!isInitialized || !runtimeConfig) {
    return null; // 或者显示一个加载指示器
  }

  return (
    <ErrorBoundary>
      <FocusProvider>
        <AppProvider initialConfig={runtimeConfig}>
          <SessionProvider>
            <BladeInterface {...props} />
          </SessionProvider>
        </AppProvider>
      </FocusProvider>
    </ErrorBoundary>
  );
};

export default AppWrapper;

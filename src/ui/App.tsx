import { useMemoizedFn } from 'ahooks';
import React, { useEffect, useState } from 'react';
import { subagentRegistry } from '../agent/subagents/SubagentRegistry.js';
import type { GlobalOptions } from '../cli/types.js';
import {
  ConfigManager,
  DEFAULT_CONFIG,
  mergeRuntimeConfig,
  type RuntimeConfig,
} from '../config/index.js';
import { HookManager } from '../hooks/HookManager.js';
import { Logger } from '../logging/Logger.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import { registerCleanup } from '../services/GracefulShutdown.js';
import { checkVersionOnStartup } from '../services/VersionChecker.js';
import { appActions, getState } from '../store/vanilla.js';
import { BackgroundShellManager } from '../tools/builtin/shell/BackgroundShellManager.js';
import { BladeInterface } from './components/BladeInterface.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
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

/**
 * 初始化 Zustand store 状态
 * 检查配置并设置初始化状态
 */
function initializeStoreState(config: RuntimeConfig): void {
  // 设置配置（使用 config slice）
  getState().config.actions.setConfig(config);

  // 检查是否有模型配置
  if (!config.models || config.models.length === 0) {
    if (config.debug) {
      console.log('[Debug] 未检测到模型配置，进入设置向导');
    }
    appActions().setInitializationStatus('needsSetup');
    return;
  }

  if (config.debug) {
    console.log('[Debug] 模型配置检查通过，准备就绪');
  }
  appActions().setInitializationStatus('ready');
}

/**
 * App 包装器组件
 *
 * 负责：
 * 1. 加载配置文件
 * 2. 合并 CLI 参数
 * 3. 初始化 Zustand store 状态
 * 4. 加载主题
 * 5. 预加载 subagents
 * 6. 初始化 Hooks 系统
 *
 * 注意：不再需要 Context Providers，状态由 Zustand store 管理
 */
export const AppWrapper: React.FC<AppProps> = (props) => {
  const [isInitialized, setIsInitialized] = useState(false);

  const initialize = useMemoizedFn(async () => {
    try {
      // 1. 加载配置文件
      const configManager = ConfigManager.getInstance();
      const baseConfig = await configManager.initialize();

      // 2. 合并 CLI 参数生成 RuntimeConfig
      const mergedConfig = mergeRuntimeConfig(baseConfig, props);

      // 3. 初始化 Zustand store 状态
      initializeStoreState(mergedConfig);

      // 4. 设置全局 Logger 配置（让所有新创建的 Logger 都使用 CLI debug 配置）
      if (mergedConfig.debug) {
        Logger.setGlobalDebug(mergedConfig.debug);
        console.error('[Debug] 全局 Logger 已启用 debug 模式');
        console.error('[Debug] 运行时配置:', mergedConfig);
      }

      // 5. 加载主题
      const savedTheme = mergedConfig.theme;
      if (savedTheme && themeManager.hasTheme(savedTheme)) {
        themeManager.setTheme(savedTheme);
        if (props.debug) {
          console.log(`✓ 已加载主题: ${savedTheme}`);
        }
      }

      // 6. 预加载 subagents 配置（确保 AgentsManager 可以立即使用）
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

      // 7. 初始化 HookManager
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

      // 8. 后台检查版本更新并自动升级（不阻塞启动）
      checkVersionOnStartup().then((message) => {
        if (message) {
          console.log('');
          console.log(message);
          console.log('');
        }
      });

      // 9. 注册退出清理函数
      registerCleanup(async () => {
        // 终止所有后台 shell 进程
        BackgroundShellManager.getInstance().killAll();

        // 断开所有 MCP 服务器连接
        await McpRegistry.getInstance().disconnectAll();

        // 清理 Hooks
        HookManager.getInstance().cleanup();
      });

      setIsInitialized(true);
    } catch (error) {
      // 静默失败，使用默认配置
      if (props.debug) {
        console.warn('⚠️ 配置初始化失败，使用默认配置:', formatErrorMessage(error));
      }

      // 即使失败也设置为已初始化，使用默认配置 + CLI 参数
      const fallbackConfig = mergeRuntimeConfig(DEFAULT_CONFIG, props);

      // 初始化 Zustand store 状态（fallback）
      initializeStoreState(fallbackConfig);

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

  // 等待初始化完成
  if (!isInitialized) {
    return null; // 或者显示一个加载指示器
  }

  return (
    <ErrorBoundary>
      <BladeInterface {...props} />
    </ErrorBoundary>
  );
};

export default AppWrapper;

import { useMemoizedFn } from 'ahooks';
import React, { useEffect, useState } from 'react';
import { subagentRegistry } from '../agent/subagents/SubagentRegistry.js';
import type { GlobalOptions } from '../cli/types.js';
import {
  DEFAULT_CONFIG,
  mergeRuntimeConfig,
  type RuntimeConfig,
} from '../config/index.js';
import { HookManager } from '../hooks/HookManager.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import { registerCleanup } from '../services/GracefulShutdown.js';
import type { VersionCheckResult } from '../services/VersionChecker.js';
import { appActions, getState } from '../store/vanilla.js';
import { BackgroundShellManager } from '../tools/builtin/shell/BackgroundShellManager.js';
import { BladeInterface } from './components/BladeInterface.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { UpdatePrompt } from './components/UpdatePrompt.js';
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
  versionCheckPromise?: Promise<VersionCheckResult | null>; // 版本检查 Promise（由 blade.tsx 提前启动）
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
 * 负责 UI 特有的初始化：
 * 1. 合并 CLI 参数到配置
 * 2. 加载主题
 * 3. 预加载 subagents
 * 4. 初始化 Hooks 系统
 * 5. 等待版本检查结果（Promise 已在 blade.tsx 启动，与所有初始化并行）
 *
 * 注意：
 * - ConfigManager 和 Store 已由 CLI 中间件初始化
 * - 版本检查在 blade.tsx main() 开头启动，与 yargs/middleware/UI初始化 并行
 */
export const AppWrapper: React.FC<AppProps> = (props) => {
  const [isReady, setIsReady] = useState(false); // 应用初始化完成，可以显示主界面
  const [versionInfo, setVersionInfo] = useState<VersionCheckResult | null>(null);
  const [showUpdatePrompt, setShowUpdatePrompt] = useState(false);

  // 应用初始化（主题、subagents、hooks 等）
  const initializeApp = useMemoizedFn(() => {
    // 1. 从 Store 读取配置（已由中间件初始化）
    const baseConfig = getState().config.config ?? DEFAULT_CONFIG;

    // 2. 合并 CLI 参数生成 RuntimeConfig
    const mergedConfig = mergeRuntimeConfig(baseConfig, props);

    // 3. 更新 Store 状态, 检查模型配置
    initializeStoreState(mergedConfig);

    // 4. Debug 模式日志（Logger 已由 blade.tsx 早期初始化）
    if (mergedConfig.debug) {
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

    // 6. 预加载 subagents 配置
    try {
      const loadedCount = subagentRegistry.loadFromStandardLocations();
      if (props.debug && loadedCount > 0) {
        console.log(
          `✓ 已加载 ${loadedCount} 个 subagents: ${subagentRegistry.getAllNames().join(', ')}`
        );
      }
    } catch (error) {
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
      if (props.debug) {
        console.warn('⚠️ Hooks 初始化失败:', formatErrorMessage(error));
      }
    }

    // 8. 注册退出清理函数
    registerCleanup(async () => {
      BackgroundShellManager.getInstance().killAll();
      await McpRegistry.getInstance().disconnectAll();
      HookManager.getInstance().cleanup();
    });

    setIsReady(true);
  });

  // 启动流程：先检查版本，再决定是否初始化应用
  const initialize = useMemoizedFn(async () => {
    // 1. 等待版本检查完成（Promise 已在 blade.tsx 启动，与 yargs/middleware 并行）
    if (props.versionCheckPromise) {
      const versionResult = await props.versionCheckPromise;
      if (versionResult) {
        // 需要升级，显示更新提示，暂不初始化应用
        setVersionInfo(versionResult);
        setShowUpdatePrompt(true);
        return;
      }
    }

    // 2. 不需要升级，直接初始化应用
    initializeApp();
  });

  // 启动时初始化配置和主题
  useEffect(() => {
    initialize();
  }, []); // 只在组件挂载时执行一次

  // 显示版本更新提示
  if (showUpdatePrompt && versionInfo) {
    return (
      <ErrorBoundary>
        <UpdatePrompt
          versionInfo={versionInfo}
          onComplete={() => {
            setShowUpdatePrompt(false);
            initializeApp(); // 用户跳过更新后，继续初始化应用
          }}
        />
      </ErrorBoundary>
    );
  }

  // 等待应用初始化完成
  if (!isReady) {
    return null;
  }

  return (
    <ErrorBoundary>
      <BladeInterface {...props} />
    </ErrorBoundary>
  );
};

export default AppWrapper;

import { useMemoizedFn } from 'ahooks';
import React, { useEffect, useState } from 'react';
import { resolveWorkspaceAgentResources } from '../agent/resources/WorkspaceAgentResources.js';
import type { GlobalOptions } from '../cli/types.js';
import {
  DEFAULT_CONFIG,
  mergeRuntimeConfig,
  type RuntimeConfig,
} from '../config/index.js';
import { HookManager } from '../hooks/HookManager.js';
import { setLoggerSessionId } from '../logging/Logger.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import { reloadWorkspaceTrustConfiguration } from '../security/reloadWorkspaceTrust.js';
import {
  WorkspaceTrustService,
  type WorkspaceTrustStatus,
} from '../security/WorkspaceTrustService.js';
import { registerCleanup } from '../services/GracefulShutdown.js';
import type { VersionCheckResult } from '../services/VersionChecker.js';
import { appActions, getState, sessionActions } from '../store/vanilla.js';
import { BackgroundShellManager } from '../tools/builtin/shell/BackgroundShellManager.js';
import { getCwd } from '../utils/cwd.js';
import { BladeInterface } from './components/BladeInterface.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { UpdatePrompt } from './components/UpdatePrompt.js';
import { WorkspaceTrustPrompt } from './components/WorkspaceTrustPrompt.js';
import { useTerminalInputModes } from './hooks/useTerminalInputModes.js';
import { TerminalInputRouterProvider } from './input/TerminalInputRouter.js';
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
const AppContent: React.FC<AppProps> = (props) => {
  useTerminalInputModes();
  const [isReady, setIsReady] = useState(false); // 应用初始化完成，可以显示主界面
  const [versionInfo, setVersionInfo] = useState<VersionCheckResult | null>(null);
  const [showUpdatePrompt, setShowUpdatePrompt] = useState(false);
  const [workspaceTrust, setWorkspaceTrust] = useState<WorkspaceTrustStatus | null>(
    null
  );

  const handleInitializationError = useMemoizedFn(
    (error: unknown, debug?: boolean): void => {
      const message = error instanceof Error ? error.message : String(error);
      appActions().setInitializationError(message);
      appActions().setInitializationStatus('error');
      setIsReady(true);
      if (debug) {
        console.error('[FAIL] 应用初始化失败:', message);
      }
    }
  );

  // 应用初始化（主题、subagents、hooks、skills 等）
  const initializeApp = useMemoizedFn(async () => {
    try {
      // 1. 从 Store 读取配置（已由中间件初始化）
      const baseConfig = getState().config.config ?? DEFAULT_CONFIG;

      // 2. 合并 CLI 参数生成 RuntimeConfig
      const mergedConfig = mergeRuntimeConfig(baseConfig, props);

      // 3. 更新 Store 状态, 检查模型配置
      initializeStoreState(mergedConfig);
      // 3.5 如果 --session-id 指定了会话 ID，覆盖 store 中的默认随机 ID
      // 必须在 setLoggerSessionId 之前执行，确保日志也使用正确的 session ID
      if (mergedConfig.resumeSessionId) {
        sessionActions().restoreSession(mergedConfig.resumeSessionId, []);
      }

      // 4. Debug 模式日志（Logger 已由 blade.tsx 早期初始化）
      if (mergedConfig.debug) {
        console.error('[Debug] 运行时配置:', mergedConfig);
      }

      // 5. 加载主题
      const savedTheme = mergedConfig.codeTheme;
      if (savedTheme && themeManager.hasTheme(savedTheme)) {
        themeManager.setTheme(savedTheme);
        if (props.debug) {
          console.log(`[OK] 已加载主题: ${savedTheme}`);
        }
      }

      // 6. 初始化 workspace 资源和 HookManager，并执行 SessionStart hooks
      try {
        const hookManager = HookManager.getInstance();
        hookManager.loadConfig(mergedConfig.hooks || {}, getCwd());
        const resources = await resolveWorkspaceAgentResources(getCwd());
        if (props.debug && mergedConfig.hooks?.enabled) {
          console.log('[OK] Hooks 系统已启用');
        }
        if (props.debug) {
          console.log(
            `[OK] Workspace resources: ${resources.subagents.getAllNames().length} agents, ` +
              `${resources.skills.size} skills, ` +
              `${resources.commands.getCommandCount() + resources.commands.getPluginCommandCount()} commands, ` +
              `${resources.plugins.getAll().length} plugins`
          );
        }

        // 获取当前 session ID 并设置到日志系统（每个 session 使用独立的日志文件）
        const state = getState();
        const sessionId = state.session.sessionId;
        setLoggerSessionId(sessionId);
      } catch (error) {
        if (props.debug) {
          console.warn('Hooks 初始化失败:', formatErrorMessage(error));
        }
      }

      // 7. 注册退出清理函数
      registerCleanup(async () => {
        await BackgroundShellManager.getInstance().killAll();
        await McpRegistry.getInstance().disconnectAll();
        HookManager.getInstance().cleanup();
      });

      setIsReady(true);
    } catch (error) {
      handleInitializationError(error, !!props.debug);
    }
  });

  const resolveWorkspaceTrust = useMemoizedFn(async () => {
    const status = await WorkspaceTrustService.getInstance().getStatus(getCwd());
    if (status.state === 'untrusted' || status.state === 'error') {
      setWorkspaceTrust(status);
      return;
    }
    await initializeApp();
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

    // 2. 不需要升级，先完成 workspace trust 决策
    await resolveWorkspaceTrust();
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
            resolveWorkspaceTrust();
          }}
        />
      </ErrorBoundary>
    );
  }

  if (workspaceTrust) {
    return (
      <ErrorBoundary>
        <WorkspaceTrustPrompt
          status={workspaceTrust}
          onTrust={async () => {
            await WorkspaceTrustService.getInstance().trust(getCwd());
            await reloadWorkspaceTrustConfiguration();
            setWorkspaceTrust(null);
            await initializeApp();
          }}
          onContinueSafely={async () => {
            setWorkspaceTrust(null);
            await initializeApp();
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

export const AppWrapper: React.FC<AppProps> = (props) => (
  <TerminalInputRouterProvider>
    <AppContent {...props} />
  </TerminalInputRouterProvider>
);

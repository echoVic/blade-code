import { useMemoizedFn } from 'ahooks';
import React, { useEffect, useState } from 'react';
import { subagentRegistry } from '../agent/subagents/SubagentRegistry.js';
import type { GlobalOptions } from '../cli/types.js';
import { getAllBuiltinModels, getBuiltinModelId } from '../config/builtinModels.js';
import {
  DEFAULT_CONFIG,
  mergeRuntimeConfig,
  PermissionMode,
  type RuntimeConfig,
} from '../config/index.js';
import { HookManager } from '../hooks/HookManager.js';
import { setLoggerSessionId } from '../logging/Logger.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import { getPluginRegistry, integrateAllPlugins } from '../plugins/index.js';
import { registerCleanup } from '../services/GracefulShutdown.js';
import type { VersionCheckResult } from '../services/VersionChecker.js';
import { discoverSkills } from '../skills/index.js';
import { initializeCustomCommands } from '../slash-commands/index.js';
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
 * 确保内置免费模型始终存在于模型列表中
 */
function initializeStoreState(config: RuntimeConfig): void {
  const builtinModels = getAllBuiltinModels();

  if (!config.models) {
    config.models = [];
  }

  // 添加或更新所有内置模型
  for (const builtinModel of builtinModels) {
    const existingIndex = config.models.findIndex((m) => m.id === builtinModel.id);

    if (existingIndex >= 0) {
      // 更新已存在的内置模型配置
      config.models[existingIndex] = builtinModel;

      if (config.debug) {
        console.log(`[Debug] 已更新内置模型: ${builtinModel.name}`);
      }
    } else {
      // 将内置模型添加到列表开头
      config.models.unshift(builtinModel);

      if (config.debug) {
        console.log(`[Debug] 已添加内置模型: ${builtinModel.name}`);
      }
    }
  }

  // 如果没有设置当前模型，使用第一个内置模型（GLM）
  if (!config.currentModelId) {
    config.currentModelId = getBuiltinModelId();
  }

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
export const AppWrapper: React.FC<AppProps> = (props) => {
  const [isReady, setIsReady] = useState(false); // 应用初始化完成，可以显示主界面
  const [versionInfo, setVersionInfo] = useState<VersionCheckResult | null>(null);
  const [showUpdatePrompt, setShowUpdatePrompt] = useState(false);

  // 应用初始化（主题、subagents、hooks、skills 等）
  const initializeApp = useMemoizedFn(async () => {
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

    // 7. 初始化 HookManager 并执行 SessionStart hooks
    try {
      const hookManager = HookManager.getInstance();
      hookManager.loadConfig(mergedConfig.hooks || {});
      if (props.debug && mergedConfig.hooks?.enabled) {
        console.log('✓ Hooks 系统已启用');
      }

      // 获取当前 session ID 并设置到日志系统（每个 session 使用独立的日志文件）
      const state = getState();
      const sessionId = state.session.sessionId;
      setLoggerSessionId(sessionId);

      // 执行 SessionStart hooks
      if (hookManager.isEnabled()) {
        const permissionMode =
          state.config.config?.permissionMode || PermissionMode.DEFAULT;
        const isResume = !!props.resume;

        const sessionStartResult = await hookManager.executeSessionStartHooks({
          projectDir: process.cwd(),
          sessionId,
          permissionMode,
          isResume,
          resumeSessionId: typeof props.resume === 'string' ? props.resume : undefined,
        });

        // 应用环境变量
        if (sessionStartResult.env) {
          for (const [key, value] of Object.entries(sessionStartResult.env)) {
            process.env[key] = value;
          }
          if (props.debug) {
            console.log(
              '✓ SessionStart hooks 注入环境变量:',
              Object.keys(sessionStartResult.env).join(', ')
            );
          }
        }

        if (sessionStartResult.warning && props.debug) {
          console.warn('⚠️ SessionStart hooks 警告:', sessionStartResult.warning);
        }
      }
    } catch (error) {
      if (props.debug) {
        console.warn('⚠️ Hooks 初始化失败:', formatErrorMessage(error));
      }
    }

    // 8. 初始化 Skills（发现并加载所有可用的 Skills）
    try {
      const skillsResult = await discoverSkills();
      if (props.debug && skillsResult.skills.length > 0) {
        console.log(
          `✓ 已加载 ${skillsResult.skills.length} 个 skills: ${skillsResult.skills.map((s) => s.name).join(', ')}`
        );
      }
      if (skillsResult.errors.length > 0 && props.debug) {
        for (const error of skillsResult.errors) {
          console.warn(`⚠️ Skill 加载错误 (${error.path}): ${error.error}`);
        }
      }
    } catch (error) {
      if (props.debug) {
        console.warn('⚠️ Skills 初始化失败:', formatErrorMessage(error));
      }
    }

    // 9. 初始化自定义命令（发现并加载所有 .blade/commands/ 和 .claude/commands/ 下的命令）
    try {
      const customCommandsResult = await initializeCustomCommands(process.cwd());
      if (props.debug && customCommandsResult.commands.length > 0) {
        console.log(
          `✓ 已加载 ${customCommandsResult.commands.length} 个自定义命令: ${customCommandsResult.commands.map((c) => c.name).join(', ')}`
        );
      }
      if (customCommandsResult.errors.length > 0 && props.debug) {
        for (const error of customCommandsResult.errors) {
          console.warn(`⚠️ 自定义命令加载错误 (${error.path}): ${error.error}`);
        }
      }
    } catch (error) {
      if (props.debug) {
        console.warn('⚠️ 自定义命令初始化失败:', formatErrorMessage(error));
      }
    }

    // 10. 初始化插件系统（加载 --plugin-dir 指定的插件和默认目录插件）
    try {
      const pluginRegistry = getPluginRegistry();
      const pluginResult = await pluginRegistry.initialize(
        process.cwd(),
        props.pluginDir || []
      );

      if (props.debug && pluginResult.plugins.length > 0) {
        console.log(
          `✓ 已加载 ${pluginResult.plugins.length} 个插件: ${pluginResult.plugins.map((p) => p.manifest.name).join(', ')}`
        );
      }

      // 将插件集成到各子系统
      if (pluginResult.plugins.length > 0) {
        const integrationResult = await integrateAllPlugins();
        if (props.debug) {
          const { totalCommands, totalSkills, totalAgents, totalMcpServers } =
            integrationResult;
          console.log(
            `  ✓ 已集成: ${totalCommands} 命令, ${totalSkills} 技能, ${totalAgents} 代理, ${totalMcpServers} MCP 服务器`
          );
        }
      }

      if (pluginResult.errors.length > 0 && props.debug) {
        for (const error of pluginResult.errors) {
          console.warn(`⚠️ 插件加载错误 (${error.path}): ${error.error}`);
        }
      }
    } catch (error) {
      if (props.debug) {
        console.warn('⚠️ 插件系统初始化失败:', formatErrorMessage(error));
      }
    }

    // 11. 注册退出清理函数
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
    await initializeApp();
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

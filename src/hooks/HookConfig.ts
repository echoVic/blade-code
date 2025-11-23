/**
 * Hook Configuration
 *
 * 默认配置和配置加载逻辑
 */

import type { HookConfig } from './types/HookTypes.js';

/**
 * 默认 Hook 配置
 */
export const DEFAULT_HOOK_CONFIG: Required<HookConfig> = {
  enabled: false, // 默认禁用,需要显式启用
  defaultTimeout: 60, // 60 秒
  timeoutBehavior: 'ignore', // 超时时忽略,继续执行
  failureBehavior: 'ignore', // 失败时忽略,继续执行
  maxConcurrentHooks: 5, // 最多 5 个并发 hook
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};

/**
 * 合并配置
 */
export function mergeHookConfig(
  base: HookConfig,
  override: Partial<HookConfig>
): HookConfig {
  return {
    ...base,
    ...override,
    PreToolUse: override.PreToolUse ?? base.PreToolUse,
    PostToolUse: override.PostToolUse ?? base.PostToolUse,
    Stop: override.Stop ?? base.Stop,
  };
}

/**
 * 从环境变量解析配置
 */
export function parseEnvConfig(): Partial<HookConfig> {
  const config: Partial<HookConfig> = {};

  // BLADE_DISABLE_HOOKS
  if (process.env.BLADE_DISABLE_HOOKS === 'true') {
    config.enabled = false;
  }

  // BLADE_HOOK_TIMEOUT
  if (process.env.BLADE_HOOK_TIMEOUT) {
    const timeout = parseInt(process.env.BLADE_HOOK_TIMEOUT, 10);
    if (!isNaN(timeout) && timeout > 0) {
      config.defaultTimeout = timeout;
    }
  }

  return config;
}

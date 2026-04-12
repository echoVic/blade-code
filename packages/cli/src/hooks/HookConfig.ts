/**
 * Hook Configuration
 *
 * 默认配置和配置加载逻辑
 */

import { HookType, type HookConfig } from './types/HookTypes.js';

/**
 * 默认 Hook 配置
 * 与 Claude Code 对齐的完整配置
 */
export const DEFAULT_HOOK_CONFIG: Required<HookConfig> = {
  enabled: false, // 默认禁用,需要显式启用
  defaultTimeout: 60, // 60 秒
  timeoutBehavior: 'ignore', // 超时时忽略,继续执行
  failureBehavior: 'ignore', // 失败时忽略,继续执行
  maxConcurrentHooks: 5, // 最多 5 个并发 hook
  // 工具执行类
  PreToolUse: [],
  PostToolUse: [
    {
      name: 'builtin:code-review-sensor',
      matcher: { tools: 'Edit|Write' },
      hooks: [
        {
          type: HookType.Prompt,
          prompt:
            '审查此代码变更，重点检查：' +
            '1) 安全漏洞（命令注入、XSS、SQL 注入、硬编码密钥/密码）' +
            '2) 明显的逻辑错误（无限循环、off-by-one、空引用）' +
            '3) 类型安全问题。' +
            '如果发现严重问题，将问题描述放在 hookSpecificOutput.additionalContext 中。' +
            '如果没有严重问题，返回 approve。',
          model: undefined,
          timeout: 15,
        },
      ],
    },
  ],
  PostToolUseFailure: [],
  PermissionRequest: [],
  // 会话生命周期类
  UserPromptSubmit: [],
  SessionStart: [],
  SessionEnd: [],
  // 控制流类
  Stop: [],
  SubagentStop: [],
  // 其他
  Notification: [],
  Compaction: [],
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
    // 工具执行类
    PreToolUse: override.PreToolUse ?? base.PreToolUse,
    PostToolUse: override.PostToolUse ?? base.PostToolUse,
    PostToolUseFailure: override.PostToolUseFailure ?? base.PostToolUseFailure,
    PermissionRequest: override.PermissionRequest ?? base.PermissionRequest,
    // 会话生命周期类
    UserPromptSubmit: override.UserPromptSubmit ?? base.UserPromptSubmit,
    SessionStart: override.SessionStart ?? base.SessionStart,
    SessionEnd: override.SessionEnd ?? base.SessionEnd,
    // 控制流类
    Stop: override.Stop ?? base.Stop,
    SubagentStop: override.SubagentStop ?? base.SubagentStop,
    // 其他
    Notification: override.Notification ?? base.Notification,
    Compaction: override.Compaction ?? base.Compaction,
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

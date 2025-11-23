/**
 * Blade 默认配置
 */

import { BladeConfig, PermissionMode } from './types.js';

export const DEFAULT_CONFIG: BladeConfig = {
  // =====================================
  // 基础配置 (config.json)
  // =====================================

  // 多模型配置
  currentModelId: '',
  models: [],

  // 全局默认参数
  temperature: 0.0,
  maxTokens: 200000, // 200k - 主流 Agent 模型的标准窗口大小
  stream: true,
  topP: 0.9,
  topK: 50,
  timeout: 30000, // 30秒超时

  // UI
  theme: 'GitHub',
  language: 'zh-CN',
  fontSize: 14,

  // 核心
  debug: false,
  telemetry: true,

  // MCP
  mcpEnabled: false,

  // =====================================
  // 行为配置 (settings.json)
  // =====================================

  // 权限
  permissions: {
    allow: [
      // 🔍 安全的系统信息命令（无需确认）
      'Bash(pwd)',
      'Bash(which *)',
      'Bash(whoami)',
      'Bash(hostname)',
      'Bash(uname *)',
      'Bash(date)',
      'Bash(echo *)',

      // 📁 目录列表（推荐使用 Glob 工具，但允许 ls 作为降级）
      'Bash(ls *)',
      'Bash(tree *)',

      // 🔀 Git 只读命令（无需确认）
      'Bash(git status)',
      'Bash(git log *)',
      'Bash(git diff *)',
      'Bash(git branch *)',
      'Bash(git show *)',
      'Bash(git remote *)',

      // 📦 包管理器只读命令（无需确认）
      'Bash(npm list *)',
      'Bash(npm view *)',
      'Bash(npm outdated *)',
      'Bash(pnpm list *)',
      'Bash(yarn list *)',
      'Bash(pip list *)',
      'Bash(pip show *)',

      // ⚠️ 注意：以下命令已从 allow 列表移除，因为有专用工具：
      // - cat/head/tail → 使用 Read 工具
      // - grep → 使用 Grep 工具
      // - find → 使用 Glob 工具
      // LLM 调用这些命令时会触发权限确认，提示使用专用工具

      // 🏗️ 常见的构建/测试命令（默认需要确认）
      // 用户可以在本地配置中添加到 allow 列表以信任特定项目
      // 'Bash(npm install *)',
      // 'Bash(npm test *)',
      // 'Bash(npm run build *)',
      // 'Bash(npm run lint *)',
    ],
    ask: [],
    deny: [
      // 🔒 敏感文件读取
      'Read(./.env)',
      'Read(./.env.*)',

      // ⚠️ 危险命令（明确拒绝）
      'Bash(rm -rf /)',
      'Bash(rm -rf /*)',
      'Bash(sudo *)',
      'Bash(chmod 777 *)',
    ],
  },
  permissionMode: PermissionMode.DEFAULT,

  // Hooks (默认禁用)
  hooks: {
    enabled: false,
    defaultTimeout: 60,
    timeoutBehavior: 'ignore',
    failureBehavior: 'ignore',
    maxConcurrentHooks: 5,
    PreToolUse: [],
    PostToolUse: [],
    Stop: [],
  },

  // 环境变量
  env: {},

  // 其他
  disableAllHooks: false,

  // Agentic Loop 配置
  maxTurns: -1, // 默认无限制（受安全上限 100 保护）
};

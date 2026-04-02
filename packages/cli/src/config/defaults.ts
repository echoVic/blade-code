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
  maxContextTokens: 128000, // 128K - 主流大模型的标准上下文窗口
  maxOutputTokens: undefined, // 不设置默认值，让各 API 使用自己的默认限制
  stream: true,
  topP: 0.9,
  topK: 50,
  timeout: 180000, // 180秒超时（长上下文 agentic 场景需要更长时间）

  // UI
  theme: 'dracula',
  uiTheme: 'system',
  language: 'zh-CN',
  fontSize: 14,

  // General Settings
  autoSaveSessions: true,
  notifyBuild: true,
  notifyErrors: false,
  notifySounds: false,
  privacyTelemetry: false,
  privacyCrash: true,

  // 核心
  debug: false,

  // MCP
  mcpEnabled: false,
  mcpServers: {}, // 空对象表示没有配置 MCP 服务器

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
      'Bash(bun pm ls *)',
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
    ask: [
      // ⚠️ 高风险命令（需要用户确认）

      // 🌐 网络下载工具（可能下载并执行恶意代码）
      'Bash(curl *)',
      'Bash(wget *)',
      'Bash(aria2c *)',
      'Bash(axel *)',

      // 🗑️ 危险删除操作
      'Bash(rm -rf *)',
      'Bash(rm -r *)',
      'Bash(rm --recursive *)',

      // 🔌 网络连接工具
      'Bash(nc *)',
      'Bash(netcat *)',
      'Bash(telnet *)',
      'Bash(ncat *)',
    ],
    deny: [
      // 🔒 敏感文件读取
      'Read(./.env)',
      'Read(./.env.*)',

      // ⚠️ 危险命令（明确拒绝）
      'Bash(rm -rf /)',
      'Bash(rm -rf /*)',
      'Bash(sudo *)',
      'Bash(chmod 777 *)',

      // 🐚 Shell 嵌套（可绕过安全检测）
      'Bash(bash *)',
      'Bash(sh *)',
      'Bash(zsh *)',
      'Bash(fish *)',
      'Bash(dash *)',

      // 💉 代码注入风险
      'Bash(eval *)',
      'Bash(source *)',

      // 💽 危险系统操作
      'Bash(mkfs *)',
      'Bash(fdisk *)',
      'Bash(dd *)',
      'Bash(format *)',
      'Bash(parted *)',

      // 🌐 浏览器（可打开恶意链接）
      'Bash(open http*)',
      'Bash(open https*)',
      'Bash(xdg-open http*)',
      'Bash(xdg-open https*)',
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
    // 工具执行类
    PreToolUse: [],
    PostToolUse: [],
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
  },

  // 环境变量
  env: {},

  // 其他
  disableAllHooks: false,

  // Agentic Loop 配置
  maxTurns: -1, // 默认无限制（受安全上限 100 保护）
};

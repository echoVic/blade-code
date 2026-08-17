/**
 * Blade 默认配置
 */

import { DEFAULT_FOREGROUND_COMMAND_HANDOFF_MS } from './foregroundCommandHandoff.js';
import { DEFAULT_FOREGROUND_PROVIDER_RECOVERY_MS } from './foregroundProviderRecovery.js';
import { DEFAULT_PROVIDER_CIRCUIT_OPEN_MS } from './providerCircuitBreaker.js';
import {
  DEFAULT_PROVIDER_REQUEST_ADMISSION_MS,
  DEFAULT_PROVIDER_REQUEST_CONCURRENCY,
  DEFAULT_PROVIDER_REQUEST_PENDING_BYTES,
} from './providerRequestAdmission.js';
import {
  DEFAULT_MAX_RESIDENT_SESSION_RUNTIMES,
  DEFAULT_SESSION_RUNTIME_IDLE_MS,
} from './sessionRuntimeResidency.js';
import { DEFAULT_MAX_QUEUED_TASK_BYTES } from './taskConcurrency.js';
import { BladeConfig, PermissionMode } from './types.js';

export const DEFAULT_CONFIG: BladeConfig = {
  // =====================================
  // 基础配置 (config.json)
  // =====================================

  // 多模型配置
  currentModelId: '',
  models: [],
  modelProviders: {},

  // 全局默认参数
  temperature: 0.0,
  maxOutputTokens: undefined, // 不设置默认值，让各 API 使用自己的默认限制
  stream: true,
  topP: 0.9,
  topK: 50,
  timeout: 180000, // 单次 Provider attempt 的 180 秒 hard total timeout
  bashForegroundHandoffMs: DEFAULT_FOREGROUND_COMMAND_HANDOFF_MS,
  providerForegroundRecoveryMs: DEFAULT_FOREGROUND_PROVIDER_RECOVERY_MS,
  providerCircuitBreakerOpenMs: DEFAULT_PROVIDER_CIRCUIT_OPEN_MS,
  providerRequestConcurrency: DEFAULT_PROVIDER_REQUEST_CONCURRENCY,
  providerRequestAdmissionMs: DEFAULT_PROVIDER_REQUEST_ADMISSION_MS,
  providerRequestPendingBytes: DEFAULT_PROVIDER_REQUEST_PENDING_BYTES,

  // UI
  codeTheme: 'dracula',
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

  // LSP
  lspServers: {},

  // =====================================
  // 行为配置 (settings.json)
  // =====================================

  // 权限
  permissions: {
    allow: [
      // 安全的系统信息命令（无需确认）
      'Bash(pwd)',
      'Bash(which *)',
      'Bash(whoami)',
      'Bash(hostname)',
      'Bash(uname *)',
      'Bash(date)',
      'Bash(echo *)',

      // 目录列表（推荐使用 Glob 工具，但允许 ls 作为降级）
      'Bash(ls *)',
      'Bash(tree *)',

      // Git 只读命令（无需确认）
      // 注意：静态 allow 规则对原始命令串做 glob，不按 shell 语义拆分。
      // 因此只能放行简单前缀（command + space + *），
      // 复杂场景（env vars, -C, compound commands）由语义层兜底。
      'Bash(git status)',
      'Bash(git status -*)',
      'Bash(git log *)',
      'Bash(git diff *)',
      'Bash(git show *)',
      'Bash(git branch -* *)',
      'Bash(git branch)',
      'Bash(git tag -l *)',
      'Bash(git tag --list *)',
      'Bash(git stash list *)',
      'Bash(git stash show *)',
      'Bash(git rev-parse *)',
      'Bash(git describe *)',
      'Bash(git blame *)',
      'Bash(git ls-files *)',
      'Bash(git config --get *)',
      'Bash(git config --list *)',
      'Bash(git shortlog *)',
      'Bash(git merge-base *)',
      'Bash(git cat-file *)',
      'Bash(git for-each-ref *)',
      'Bash(git grep *)',
      'Bash(git worktree list *)',
      'Bash(git reflog show *)',
      'Bash(git reflog)',
      'Bash(git rev-list *)',
      'Bash(git ls-remote *)',
      'Bash(git remote -v)',
      'Bash(git remote --verbose)',
      'Bash(git remote)',

      // gh CLI 只读命令（无需确认）
      'Bash(gh pr view *)',
      'Bash(gh pr list *)',
      'Bash(gh pr diff *)',
      'Bash(gh pr checks *)',
      'Bash(gh pr status *)',
      'Bash(gh issue view *)',
      'Bash(gh issue list *)',
      'Bash(gh issue status *)',
      'Bash(gh run list *)',
      'Bash(gh run view *)',
      'Bash(gh repo view *)',
      // gh auth status 不带 * — --show-token/-t 会泄露凭据
      'Bash(gh auth status)',

      // 包管理器只读命令（无需确认）
      'Bash(npm list *)',
      'Bash(bun pm ls *)',
      'Bash(npm view *)',
      'Bash(npm outdated *)',
      'Bash(pnpm list *)',
      'Bash(yarn list *)',
      'Bash(pip list *)',
      'Bash(pip show *)',

      // 注意：以下命令已从 allow 列表移除，因为有专用工具：
      // - cat/head/tail -> 使用 Read 工具
      // - grep -> 使用 Grep 工具
      // - find -> 使用 Glob 工具
      // LLM 调用这些命令时会触发权限确认，提示使用专用工具

      // 常见的构建/测试命令（默认需要确认）
      // 用户可以在本地配置中添加到 allow 列表以信任特定项目
      // 'Bash(npm install *)',
      // 'Bash(npm test *)',
      // 'Bash(npm run build *)',
      // 'Bash(npm run lint *)',
    ],
    ask: [
      // 高风险命令（需要用户确认）

      // 网络下载工具（可能下载并执行恶意代码）
      'Bash(curl *)',
      'Bash(wget *)',
      'Bash(aria2c *)',
      'Bash(axel *)',

      // 危险删除操作
      'Bash(rm -rf *)',
      'Bash(rm -r *)',
      'Bash(rm --recursive *)',

      // 网络连接工具
      'Bash(nc *)',
      'Bash(netcat *)',
      'Bash(telnet *)',
      'Bash(ncat *)',
    ],
    deny: [
      // 敏感文件读取
      'Read(./.env)',
      'Read(./.env.*)',

      // 危险命令（明确拒绝）
      'Bash(rm -rf /)',
      'Bash(rm -rf /*)',
      'Bash(sudo *)',
      'Bash(chmod 777 *)',

      // Shell 嵌套（可绕过安全检测）
      'Bash(bash *)',
      'Bash(sh *)',
      'Bash(zsh *)',
      'Bash(fish *)',
      'Bash(dash *)',

      // 代码注入风险
      'Bash(eval *)',
      'Bash(source *)',

      // 危险系统操作
      'Bash(mkfs *)',
      'Bash(fdisk *)',
      'Bash(dd *)',
      'Bash(format *)',
      'Bash(parted *)',

      // 浏览器（可打开恶意链接）
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
    Elicitation: [],
    ElicitationResult: [],
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

  // Plugins
  enabledPlugins: {},
  pluginSourcePolicy: {
    restrictToAllowedSources: false,
    requireGitCommitSha: false,
    allowedGitHosts: [],
    allowedMarketplaces: [],
    allowedLocalRoots: [],
  },

  // 环境变量
  env: {},

  // 其他
  disableAllHooks: false,

  // Agentic Loop 配置
  maxTurns: -1, // 默认无限制
  maxConcurrentTasks: 3,
  maxQueuedTasks: 100,
  maxQueuedTaskBytes: DEFAULT_MAX_QUEUED_TASK_BYTES,
  maxResidentSessionRuntimes: DEFAULT_MAX_RESIDENT_SESSION_RUNTIMES,
  sessionRuntimeIdleMs: DEFAULT_SESSION_RUNTIME_IDLE_MS,
};

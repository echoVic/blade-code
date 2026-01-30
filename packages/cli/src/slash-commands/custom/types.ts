/**
 * 自定义 Slash Commands 类型定义
 *
 * 与 Claude Code 完全对齐的自定义命令系统
 * 支持 .blade/commands/ 和 .claude/commands/ 目录
 */

/**
 * 自定义命令 Frontmatter 配置
 */
export interface CustomCommandConfig {
  /**
   * 命令描述
   * - SlashCommand 工具必需此字段才能被 AI 调用
   * - 用于 /help 显示
   */
  description?: string;

  /**
   * 工具访问限制
   * 格式: ["Bash(git add:*)", "Read", "Write"]
   */
  allowedTools?: string[];

  /**
   * 参数提示（自动补全时显示）
   * 例如: "[message]" 或 "[pr-number] [priority]"
   */
  argumentHint?: string;

  /**
   * 指定执行模型
   * 例如: "claude-3-5-haiku-20241022"
   */
  model?: string;

  /**
   * 禁止 AI 调用（默认 false）
   * 设置为 true 时，SlashCommand 工具无法调用此命令
   */
  disableModelInvocation?: boolean;
}

/**
 * 自定义命令
 */
export interface CustomCommand {
  /**
   * 命令名（不含 /）
   * 从文件名提取，例如 "commit", "review"
   */
  name: string;

  /**
   * 命名空间（子目录名）
   * 例如 frontend/component.md → namespace: "frontend"
   */
  namespace?: string;

  /**
   * Frontmatter 配置
   */
  config: CustomCommandConfig;

  /**
   * Markdown 正文内容
   * 包含命令的实际指令，支持参数插值、Bash 嵌入、文件引用
   */
  content: string;

  /**
   * 文件完整路径
   */
  path: string;

  /**
   * 来源类型
   * - 'project': 项目级命令（.blade/commands/ 或 .claude/commands/）
   * - 'user': 用户级命令（~/.blade/commands/ 或 ~/.claude/commands/）
   */
  source: 'user' | 'project';

  /**
   * 来源目录类型
   * - 'blade': .blade/commands/
   * - 'claude': .claude/commands/（Claude Code 兼容）
   */
  sourceDir: 'claude' | 'blade';
}

/**
 * 命令执行上下文
 */
export interface CustomCommandExecutionContext {
  /**
   * 用户传入的参数
   * 例如 "/commit fix bug" → ["fix", "bug"]
   */
  args: string[];

  /**
   * 工作目录
   */
  workspaceRoot: string;

  /**
   * 中止信号
   */
  signal?: AbortSignal;
}

/**
 * 命令发现结果
 */
export interface CustomCommandDiscoveryResult {
  /**
   * 发现的命令列表
   */
  commands: CustomCommand[];

  /**
   * 扫描的目录
   */
  scannedDirs: string[];

  /**
   * 解析错误
   */
  errors: Array<{
    path: string;
    error: string;
  }>;
}

/**
 * 命令搜索目录配置
 */
export interface CommandSearchDir {
  /**
   * 目录路径
   */
  path: string;

  /**
   * 来源类型
   */
  source: 'user' | 'project';

  /**
   * 目录类型
   */
  sourceDir: 'claude' | 'blade';
}

# Blade

**Blade** 是一个面向真实工程任务的 AI 编程助手。CLI、Web、Headless 和 ACP
共享同一套 Session Runtime、工具、权限与持久化语义。

[查看更新日志](changelog.md)

## 核心特性

### 🌐 多种运行入口

- **CLI 模式**: 在终端中使用，支持 Markdown 渲染和语法高亮
- **Web UI 模式**: 在浏览器中使用，完整的图形界面体验
- **Headless 模式**: 为脚本、CI 和自动化提供稳定 JSONL 事件
- **ACP 模式**: 接入支持 Agent Client Protocol 的编辑器和宿主

```bash
blade                                      # CLI 模式
blade web                                  # Web UI 模式
blade serve                                # 无头 HTTP 服务器
blade --headless --output-format jsonl "分析项目"  # Headless Agent
```

### 📡 Provider Catalog

Provider、模型能力、上下文窗口和价格均从内置目录动态读取，不在文档中维护容易过期的
静态模型表。官方 Provider、云平台和自定义兼容渠道使用同一配置流程。

3 步配置向导：选择 Provider → 输入 API Key → 选择模型

### 🛡️ 安全权限控制

- 敏感操作前请求确认
- 支持 glob 模式的权限规则
- 四种权限模式（default、autoEdit、plan、yolo）

### 🔧 强大的工具集

- **文件操作**: 读取、写入、编辑、搜索
- **代码分析**: 语法检查、类型检查、测试运行
- **终端执行**: 安全的命令执行环境
- **Git 集成**: 版本控制操作
- **网络搜索**: 多提供商自动故障转移

### 📝 灵活的工作模式

- **Plan 模式**: 先规划后执行
- **Subagents**: 并行任务处理

### 🔌 MCP 扩展

支持 Model Context Protocol，可连接外部工具和服务。

## 快速开始

```bash
# 安装
npm install -g blade-code

# CLI 模式
blade

# Web UI 模式
blade web

# 从 Provider Catalog 添加模型
# 在 Blade 中输入: /model add
```

## 文档目录

### 入门指南

- [安装说明](getting-started/installation.md)
- [快速开始](getting-started/quick-start.md)

### 配置

- [配置系统](configuration/config-system.md) - 模型与凭证配置
- [权限控制](configuration/permissions.md)
- [Workspace Trust](guides/workspace-trust.md)
- [主题配置](configuration/themes.md)

### 使用指南

- [@ 文件引用](guides/at-file-mentions.md)
- [Slash 命令](guides/slash-commands.md)
- [Plan 模式](guides/plan-mode.md)
- [Subagents](guides/subagents.md)
- [Hooks](guides/hooks.md)
- [Skills](guides/skills.md)
- [Markdown 支持](guides/markdown-support.md)

### 参考

- [CLI 命令](reference/cli-commands.md)
- [工具列表](reference/tool-list.md)
- [Atomic ApplyPatch](reference/atomic-apply-patch.md)
- [Native Read-Only Code Review](reference/native-code-review.md)
- [Schema-Constrained Structured Output](reference/schema-constrained-output.md)
- [Durable Session Archive](reference/session-archive.md)
- [Portable Session Markdown Export](reference/session-markdown-export.md)
- [Durable Pending Interactions](reference/durable-pending-interactions.md)
- [Session Reasoning Effort](reference/session-reasoning-effort.md)
- [Session Permission Mode](reference/session-permission-mode.md)
- [Session Service Tier](reference/session-service-tier.md)
- [Session Response Verbosity](reference/session-response-verbosity.md)
- [Session Communication Style](reference/session-communication-style.md)
- [Trusted Custom Output Styles](reference/trusted-output-styles.md)
- [Trusted Contextual Project Rules](reference/trusted-contextual-project-rules.md)
- [Session User Shell Command](reference/session-user-shell-command.md)
- [TUI Terminal Input](reference/tui-terminal-input.md)
- [Fresh Independent Verification](reference/fresh-independent-verification.md)
- [Host-Authoritative Goal Completion Verification](reference/goal-completion-verification.md)
- [工具并发模型](reference/tool-concurrency.md)
- [Session-scoped LSP](reference/lsp-session-intelligence.md)
- [MCP Elicitation](reference/mcp-elicitation.md)
- [MCP Roots 与 Sampling](reference/mcp-roots-sampling.md)
- [MCP Tool Call 生命周期](reference/mcp-call-lifecycle.md)
- [MCP Tool Result 安全边界](reference/mcp-tool-result-safety.md)
- [MCP Logging 与诊断](reference/mcp-logging.md)
- [MCP Server Instructions](reference/mcp-server-instructions.md)
- [MCP Completion](reference/mcp-completion.md)
- [MCP Async Tasks](reference/mcp-tasks.md)
- [MCP OAuth 生命周期](reference/mcp-oauth-lifecycle.md)
- [MCP 动态工具目录](reference/mcp-dynamic-catalog.md)
- [MCP Resources、Prompts 与订阅](reference/mcp-resources-prompts.md)
- [MCP 故障恢复](reference/mcp-fault-recovery.md)
- [MCP Session 隔离](reference/mcp-session-isolation.md)
- [Workspace Agent 资源隔离](reference/workspace-agent-resources.md)
- [Workspace Plugin 生命周期](reference/workspace-plugin-lifecycle.md)
- [Workspace 模型与 Provider 隔离](reference/workspace-model-resources.md)
- [Workspace Runtime 设置与环境隔离](reference/workspace-runtime-environment.md)
- [模型传输恢复](reference/model-transport-recovery.md)
- [Surface 输出背压与排序](reference/surface-egress.md)
- [Runtime 协调关闭](reference/runtime-shutdown.md)

### 其他

- [更新日志](changelog.md)
- [常见问题](faq.md)

## 支持的 Provider

运行 `/model add` 可查看当前安装版本支持的 Provider 和模型。自定义 OpenAI 或
Anthropic 兼容 endpoint 可配置为独立渠道，凭证与其他渠道隔离存储。

## 许可证

MIT License

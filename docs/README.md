# Blade

**Blade** 是一个强大的 AI 编程助手，支持 CLI 终端、Web UI 和 Headless 三种模式，帮助你高效完成编码任务。

> **当前版本**: 0.8.0 | [更新日志](changelog.md)

## 核心特性

### 🌐 三种运行模式

- **CLI 模式**: 在终端中使用，支持 Markdown 渲染和语法高亮
- **Web UI 模式**: 在浏览器中使用，完整的图形界面体验

```bash
blade           # CLI 模式
blade web       # Web UI 模式
blade serve     # 无头服务器模式
```

### 📡 pi-ai Provider Catalog

集成 [pi-ai](https://github.com/earendil-works/pi) catalog，统一管理 LLM Provider、模型元数据和凭证：

| 分类 | Provider |
|------|----------|
| **热门** | Anthropic, OpenAI, DeepSeek, Google, Groq, OpenRouter |
| **云服务** | Azure, AWS Bedrock, Google Vertex, Cloudflare |
| **开源友好** | Together AI, Fireworks, Cerebras, Novita AI |
| **本地部署** | Ollama, LM Studio |

3 步配置向导：选择 Provider → 输入 API Key → 选择模型

### 🛡️ 安全权限控制

- 敏感操作前请求确认
- 支持 glob 模式的权限规则
- 多级权限模式（default、autoEdit、plan、yolo、spec）

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

# 从 pi-ai catalog 添加模型
# 在 Blade 中输入: /model add
```

## 文档目录

### 入门指南

- [安装说明](getting-started/installation.md)
- [快速开始](getting-started/quick-start.md)

### 配置

- [配置系统](configuration/config-system.md) - pi-ai 模型与凭证配置
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
- [Durable Session Archive](reference/session-archive.md)
- [Portable Session Markdown Export](reference/session-markdown-export.md)
- [Session Reasoning Effort](reference/session-reasoning-effort.md)
- [Session Service Tier](reference/session-service-tier.md)
- [Session Response Verbosity](reference/session-response-verbosity.md)
- [Session Communication Style](reference/session-communication-style.md)
- [Trusted Custom Output Styles](reference/trusted-output-styles.md)
- [Trusted Contextual Project Rules](reference/trusted-contextual-project-rules.md)
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

### 其他

- [更新日志](changelog.md)
- [常见问题](faq.md)

## 支持的 Provider

Blade 通过 pi-ai catalog 提供内置 Provider 和模型目录：

**热门 Provider**:
- Anthropic (Claude)
- OpenAI (GPT-4, o1)
- DeepSeek (R1, V3)
- Google (Gemini)
- Groq (超快推理)
- OpenRouter (多模型聚合)

**云服务**:
- Azure OpenAI
- AWS Bedrock
- Google Vertex AI
- Cloudflare Workers AI

**开源友好**:
- Together AI
- Fireworks AI
- Cerebras
- Novita AI
- NVIDIA NIM

**本地部署**:
- Ollama
- LM Studio

**其他**:
- Mistral AI
- Cohere
- Perplexity
- xAI (Grok)
- 更多...

## 许可证

MIT License

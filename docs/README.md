# Blade

**Blade** 是一个强大的 AI 编程助手，支持 CLI 终端和 Web UI 双模式，帮助你高效完成编码任务。

> **当前版本**: 0.2.0 | [更新日志](changelog.md)

## 核心特性

### 🌐 双模式界面（0.2.0 新增）

- **CLI 模式**: 在终端中使用，支持 Markdown 渲染和语法高亮
- **Web UI 模式**: 在浏览器中使用，完整的图形界面体验

```bash
blade           # CLI 模式
blade web       # Web UI 模式
blade serve     # 无头服务器模式
```

### 📡 80+ Provider 支持

集成 [models.dev](https://models.dev) API，支持 80+ LLM Provider：

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

# Web UI 模式（0.2.0 新增）
blade web

# 添加自定义模型（80+ Provider 可选）
# 在 Blade 中输入: /model add
```

## 文档目录

### 入门指南

- [安装说明](getting-started/installation.md)
- [快速开始](getting-started/quick-start.md)

### 配置

- [配置系统](configuration/config-system.md) - 80+ Provider 配置
- [权限控制](configuration/permissions.md)
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
- [模型传输恢复](reference/model-transport-recovery.md)

### 其他

- [更新日志](changelog.md)
- [常见问题](faq.md)

## 支持的 Provider

Blade 通过 [models.dev](https://models.dev) 集成支持 80+ LLM Provider：

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

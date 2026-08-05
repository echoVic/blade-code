<div align="center">

# 🗡️ Blade Code

**新一代 AI 编程助手 — CLI + Web + Headless**

[![npm version](https://img.shields.io/npm/v/blade-code.svg?style=flat-square)](https://www.npmjs.com/package/blade-code)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Node.js Version](https://img.shields.io/node/v/blade-code.svg?style=flat-square)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)

[English](README.en.md) | 简体中文

</div>

---

## ✨ 核心特性

- 🤖 **多模型统一运行时** — 基于 [pi-ai](https://github.com/nicepkg/pi-ai) 统一 38+ Provider（OpenAI/Anthropic/DeepSeek/Google/Bedrock…），模型元数据动态获取
- 🧠 **自动记忆** — 跨会话持久化项目知识，自动学习构建命令、代码模式、调试洞察
- 🌐 **三种运行模式** — CLI 终端 / Web UI / Headless JSONL，场景灵活切换
- 🛠️ **20+ 内置工具** — 文件编辑、代码搜索、Shell 执行、Git 操作、Web 抓取等
- 📋 **结构化工作流** — Task 委托、Goal 模式、Spec/Plan、Subagent 编排
- 🔗 **开放扩展** — MCP 协议、插件系统、Skills、Hooks
- 🔒 **安全可控** — 四级权限模式（default/autoEdit/plan/yolo）+ 工具白/黑名单
- 💰 **精确费用追踪** — 多轮累计 token 消耗与缓存价格，支持 `/cost` 实时查看
- 🎨 **现代 UI** — React + Ink 终端 / React + Vite Web，支持 Thinking 模式

---

## 🚀 快速开始

```bash
# 快速体验（需要 Node.js >= 22.19.0）
npx blade-code

# 全局安装
npm install -g blade-code

# 启动 CLI
blade

# 启动 Web UI
blade web

# Headless 模式（CI / sandbox）
blade --headless --output-format jsonl "分析这个仓库"
```

首次启动会自动进入模型配置向导：**选择 Provider → 选择模型 → 输入 API Key**。

---

## ⚙️ 配置

配置文件：`~/.blade/config.json`（全局）或 `.blade/config.json`（项目级）。

```json
{
  "currentModelId": "primary",
  "models": [
    {
      "id": "primary",
      "provider": "deepseek",
      "model": "deepseek-v4-pro"
    }
  ]
}
```

- **凭证独立存储**：`~/.blade/auth.json`（权限 `0600`），不进入版本控制
- **模型元数据**（contextWindow、maxTokens、pricing）自动从 pi-ai catalog 获取，无需手动填写
- Provider 的 Base URL 仅在使用自定义代理时才需在 `overrides.baseUrl` 中指定

---

## 🧰 命令速览

| 命令 | 说明 |
|------|------|
| `blade` | 交互式 CLI |
| `blade web` | Web UI（浏览器） |
| `blade serve` | 无头 HTTP 服务器 |
| `blade mcp` | 管理 MCP 服务器 |
| `blade doctor` | 环境诊断 |
| `blade --headless "..."` | 完整 agent loop（非交互） |
| `blade --print "..."` | 单轮打印模式 |

**交互式命令（会话内）**

| 命令 | 说明 |
|------|------|
| `/model add` | 添加新模型 |
| `/model switch` | 切换当前模型 |
| `/cost` | 查看当前会话费用 |
| `/compact` | 手动压缩上下文 |
| `/memory list` | 列出记忆文件 |
| `/tasks` | 查看任务列表 |
| `/goal "..."` | 启动 Goal 模式 |

---

## 🏗️ 架构概览

```
Blade/
├── packages/cli/          # blade-code 核心（npm 包）
│   ├── src/
│   │   ├── agent/         # 无状态 Agent 核心 + 执行循环
│   │   ├── services/pi/   # pi-ai 运行时适配层
│   │   ├── tools/         # 工具系统（TypeBox schema）
│   │   ├── server/        # Web 服务器（Hono）
│   │   ├── context/       # 上下文压缩与 token 管理
│   │   ├── config/        # 配置系统
│   │   ├── store/         # 状态管理（Zustand）
│   │   ├── ui/            # 终端 UI（React + Ink）
│   │   └── schema/        # TypeBox runtime 封装
│   └── web/               # Web UI（React + Vite）
└── docs/                  # 用户文档（Docsify）
```

---

## 📖 文档

- **[在线文档](https://echovic.github.io/blade-doc/#/)**
- **[配置指南](docs/configuration/config-system.md)**
- **[快速入门](docs/getting-started/quick-start.md)**
- **[贡献指南](CONTRIBUTING.md)**

---

## 🤝 贡献

```bash
git clone https://github.com/echoVic/blade-code.git
cd blade-code && bun install && bun run dev
```

---

## 💬 交流

- 微信群：添加 **VIc-Forever**，备注「Blade」
- [Discord](https://discord.gg/utXDVcv6)
- [Issues](https://github.com/echoVic/blade-code/issues)

---

## ⭐ Star History

<a href="https://star-history.com/#echoVic/blade-code&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=echoVic/blade-code&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=echoVic/blade-code&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=echoVic/blade-code&type=Date" />
 </picture>
</a>

---

## 📄 许可证

[MIT](LICENSE) — Made with ❤️ by [echoVic](https://github.com/echoVic)

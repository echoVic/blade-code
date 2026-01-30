<div align="center">

# 🗡️ Blade Code

**新一代 AI 编程助手（CLI）**

[![npm version](https://img.shields.io/npm/v/blade-code.svg?style=flat-square)](https://www.npmjs.com/package/blade-code)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Node.js Version](https://img.shields.io/node/v/blade-code.svg?style=flat-square)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)

[English](README.en.md) | 简体中文

</div>

---

## 📸 启动界面

<div align="center">
  <img src="./assets/screenshots/startup.png" alt="Blade Code 启动界面" width="800" />
</div>

---

## ✨ 核心特性

- 🤖 **智能对话** - 上下文理解、多轮协作、可继续会话
- 🆓 **开箱即用** - 内置免费 GLM-4.7 模型，可选自定义模型
- 🛠️ **丰富工具** - 20+ 内置工具：文件/搜索/Shell/Git/Web 等
- 🔗 **扩展能力** - MCP、插件与 Skills 系统
- 📋 **结构化工作流** - Spec / Plan / Subagents
- 🔒 **安全可控** - default/autoEdit/plan/yolo 权限模式与工具白/黑名单
- 🎨 **现代 UI** - React + Ink 终端 UI，支持 Markdown 与高亮

---

## 🚀 快速开始

```bash
npx blade-code

npm install -g blade-code
# 或
pnpm add -g blade-code

blade
blade "帮我分析这个项目"
blade --print "写一个快排算法"
```

> 默认使用内置免费模型；要使用自有模型，可运行 `blade` 按提示配置。

---

## ⚙️ 可选配置

配置文件支持全局和项目级：`~/.blade/config.json` 或 `.blade/config.json`。
更多配置项见文档。

```json
{
  "provider": "openai-compatible",
  "apiKey": "${BLADE_API_KEY}",
  "baseUrl": "https://api.openai.com/v1",
  "model": "gpt-4o-mini"
}
```

---

## 🧰 命令速览

**常用命令**

- `blade` 启动交互式界面
- `blade mcp` 管理 MCP 服务器
- `blade doctor` 环境自检
- `blade update` 检查更新
- `blade install` 安装指定版本（实验）

**常用选项**

- `--print/-p` 打印模式（适合管道）
- `--output-format` 输出格式（text/json/stream-json）
- `--permission-mode` 权限模式
- `--resume/-r` 恢复会话 / `--session-id` 指定会话

---

## 📖 文档

- **[用户文档](https://echovic.github.io/blade-doc/#/)**
- **[本仓库文档入口](docs/README.md)**
- **[贡献指南](CONTRIBUTING.md)**

---

## 🤝 贡献

```bash
git clone https://github.com/echoVic/blade-code.git
cd blade-code && pnpm install && pnpm dev
```

---

## 💬 交流群

添加小助手微信 **VIc-Forever**，备注「Blade」拉你进群。

---

## 🔗 相关资源

- [NPM 包](https://www.npmjs.com/package/blade-code)
- [Discord 社区](https://discord.gg/utXDVcv6) - 加入我们的 Discord 服务器
- [问题反馈](https://github.com/echoVic/blade-code/issues)

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

[MIT](LICENSE) - Made with ❤️ by [echoVic](https://github.com/echoVic)

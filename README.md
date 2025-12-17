<div align="center">

# 🗡️ Blade Code

**新一代智能 AI 编程助手**

[![npm version](https://img.shields.io/npm/v/blade-code.svg?style=flat-square)](https://www.npmjs.com/package/blade-code)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Node.js Version](https://img.shields.io/node/v/blade-code.svg?style=flat-square)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)

[English](README.en.md) | 简体中文

</div>

---

## ✨ 核心特性

- 🤖 **智能对话** - 基于大语言模型，支持上下文理解和多轮对话
- 🛠️ **丰富工具** - 内置 18+ 工具：文件读写、代码搜索、Shell 执行、Git 操作等
- 🔗 **MCP 协议** - 支持 Model Context Protocol，轻松扩展外部工具
- 🎨 **现代 UI** - 基于 React + Ink，支持 Markdown 渲染和语法高亮
- 💾 **会话管理** - 多会话、继续对话、会话恢复、会话 Fork
- 🔒 **安全可控** - 三级权限系统（allow/ask/deny）、工具白名单、操作确认

---

## 🚀 快速开始

### 零安装试用

```bash
npx blade-code
npx blade-code --print "解释什么是 TypeScript"
```

### 全局安装

```bash
npm install -g blade-code
# 或
pnpm add -g blade-code
```

### 基本使用

```bash
blade                              # 交互式模式
blade "帮我分析这个项目"            # 带首条消息进入
blade --print "写一个快排算法"      # 打印模式（适合管道）
blade --continue                   # 继续上次对话
```

> 首次运行若未配置 API 密钥，会自动弹出设置向导。

---

## 🔐 配置

### 配置文件

```bash
mkdir -p ~/.blade
cat > ~/.blade/config.json << 'EOF'
{
  "provider": "openai-compatible",
  "apiKey": "your-api-key",
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "model": "qwen-max"
}
EOF
```

支持环境变量插值：`"apiKey": "${BLADE_API_KEY}"`

### 获取 API 密钥

- **千问**: [DashScope 控制台](https://dashscope.console.aliyun.com/apiKey)
- **火山引擎**: [火山方舟控制台](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey)
- **OpenAI**: [OpenAI Platform](https://platform.openai.com/api-keys)

---

## 💬 使用示例

```bash
# 智能工具调用
blade "列出所有 TypeScript 文件"
blade "查找包含 TODO 的代码"
blade "审查 src/utils 目录的代码"

# 会话管理
blade --session-id "my-project" "开始新项目"
blade --resume <id>                # 恢复会话
blade --resume <id> --fork-session # Fork 会话

# 安全控制
blade --allowed-tools "Read,Grep" "只读操作"
blade --permission-mode plan "只规划不执行"
blade --yolo "自动批准所有操作"
```

---

## 📚 命令参考

### 主要命令

| 命令 | 说明 |
|------|------|
| `blade` | 启动交互式助手 |
| `blade config` | 配置管理 |
| `blade mcp` | MCP 服务器管理 |
| `blade doctor` | 系统健康检查 |
| `blade update` | 检查更新 |

### 常用选项

| 选项 | 简写 | 说明 |
|------|------|------|
| `--print` | `-p` | 打印响应并退出 |
| `--continue` | `-c` | 继续最近会话 |
| `--resume <id>` | `-r` | 恢复指定会话 |
| `--model <name>` | | 指定模型 |
| `--yolo` | | 自动批准所有操作 |

### Slash 命令

在交互模式中使用：`/init` `/help` `/clear` `/compact` `/agents` `/permissions` `/mcp` `/resume` `/config` `/theme` `/model`

---

## 📖 文档

- **[用户文档](docs/public/README.md)** - 安装、配置、使用指南
- **[开发者文档](docs/development/README.md)** - 架构设计、技术实现
- **[贡献指南](CONTRIBUTING.md)** - 参与开源贡献

---

## 🤝 贡献

欢迎贡献！详见 [贡献指南](CONTRIBUTING.md)。

```bash
git clone https://github.com/echoVic/blade-code.git
cd blade-code && pnpm install && pnpm dev
```

---

## 📄 许可证

[MIT](LICENSE) - Made with ❤️ by [echoVic](https://github.com/echoVic)

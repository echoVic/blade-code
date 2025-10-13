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

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>🤖 智能对话</h3>
      <p>基于大语言模型的自然语言交互，支持上下文理解和多轮对话</p>
    </td>
    <td width="50%" valign="top">
      <h3>🛠️ 丰富工具</h3>
      <p>内置文件操作、Git 管理、网络请求、代码分析等实用工具</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>🔗 MCP 协议</h3>
      <p>支持 Model Context Protocol，轻松扩展外部资源和工具</p>
    </td>
    <td width="50%" valign="top">
      <h3>🎨 现代 UI</h3>
      <p>基于 Ink 的美观终端界面，提供流畅的交互体验</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>💾 会话管理</h3>
      <p>支持多会话、继续对话、会话恢复等功能</p>
    </td>
    <td width="50%" valign="top">
      <h3>🔒 安全可控</h3>
      <p>权限管理、工具白名单、操作确认等安全机制</p>
    </td>
  </tr>
</table>

---

## 📖 文档

- **[完整文档](docs/index.md)** - 文档中心导航
- **[用户文档](docs/public/README.md)** - 安装、配置、使用指南
- **[开发者文档](docs/development/README.md)** - 架构设计、技术实现
- **[贡献指南](docs/contributing/README.md)** - 参与开源贡献

---

## 🚀 快速开始

### ⚡ 零安装试用

无需安装，直接体验 Blade Code：

```bash
# 交互式模式
npx blade-code

# 快速问答（非交互式）
npx blade-code --print "解释什么是 TypeScript"

# 代码生成（非交互式）
npx blade-code --print "用 Python 写一个快速排序算法"
```

### 📦 全局安装（推荐）

```bash
# 使用 npm 安装
npm install -g blade-code

# 使用 pnpm 安装
pnpm add -g blade-code

# 使用 yarn 安装
yarn global add blade-code
```

安装后即可使用 `blade` 命令：

```bash
# 交互式模式（默认）
blade

# 快速问答（非交互式）
blade --print "你好，介绍一下自己"
```

---

## 🔐 配置 API 密钥

Blade Code 支持多种 LLM 提供商，您需要配置相应的 API 密钥：

### 方式一：环境变量（推荐）

```bash
# 千问（阿里云）
export QWEN_API_KEY="your-qwen-api-key"
export BLADE_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"

# 火山引擎
export VOLCENGINE_API_KEY="your-volcengine-api-key"
export BLADE_BASE_URL="https://ark.cn-beijing.volces.com/api/v3"
```

### 方式二：命令行参数

```bash
blade --api-key your-api-key --base-url https://api.example.com "你好"
```

### 方式三：配置文件

```bash
# 复制示例配置文件
cp config.env.example .env

# 编辑 .env 文件，填入您的配置
nano .env
```

### 获取 API 密钥

- **千问（Qwen）**: [DashScope 控制台](https://dashscope.console.aliyun.com/apiKey)
- **火山引擎**: [火山方舟控制台](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey)

---

## 💬 使用示例

### 基础对话

```bash
# 交互式模式（默认）
blade

# 直接发送消息
blade "什么是人工智能？"

# 代码生成
blade "用 JavaScript 写一个防抖函数"
```

### 智能工具调用

Blade Code 会根据您的需求自动选择合适的工具：

```bash
# 文件操作
blade "列出当前目录的所有 TypeScript 文件"

# Git 操作
blade "查看最近的 5 次提交记录"

# 代码审查
blade "审查 src/utils 目录的代码质量"
```

### 会话管理

```bash
# 创建或使用命名会话
blade --sessionId "project-alpha" "开始新项目"

# 继续最近的会话
blade --continue

# 恢复特定会话
blade --resume <conversation-id>

# Fork 会话（从现有会话创建新会话）
blade --resume <id> --forkSession
```

### 打印模式

适合管道操作和脚本使用：

```bash
# 打印模式（非交互式，直接输出结果）
blade --print "生成一个 README 模板" > README.md

# 指定输出格式
blade --print --outputFormat json "获取项目信息"

# 流式 JSON 输出
blade --print --outputFormat stream-json "分析代码"
```

### 输入/输出选项

```bash
# 从标准输入读取（流式 JSON 格式）
cat input.json | blade --inputFormat stream-json --print

# 包含部分消息块
blade --print --includePartialMessages "长文本生成"

# 重新发送用户消息
blade --replayUserMessages < input.txt
```

---

## 🔧 高级功能

### MCP 服务器集成

Model Context Protocol 允许集成外部工具和资源：

```bash
# 配置和管理 MCP 服务器
blade mcp

# 从 JSON 文件加载 MCP 配置
blade --mcpConfig config.json "使用外部工具"

# 仅使用指定的 MCP 配置（严格模式）
blade --mcpConfig config.json --strictMcpConfig "查询"
```

### 配置管理

```bash
# 配置管理
blade config

# 系统健康检查
blade doctor

# 检查更新
blade update

# 设置认证令牌
blade setup-token
```

### AI 模型选项

```bash
# 指定模型
blade --model qwen-max "复杂的问题"

# 设置回退模型
blade --fallbackModel qwen-turbo "问题"

# 自定义系统提示
blade --appendSystemPrompt "你是一位资深架构师" "设计微服务架构"

# 自定义 Agent 配置
blade --agents '{"reviewer": {"model": "qwen-max"}}' "审查代码"
```

### 安全与权限

Blade 提供强大的三级权限控制系统（allow/ask/deny）：

```bash
# 跳过权限检查（危险）
blade --dangerouslySkipPermissions "执行命令"

# 仅允许特定工具
blade --allowedTools "read,write" "处理文件"

# 禁止特定工具
blade --disallowedTools "bash,execute" "安全操作"

# 权限模式
blade --permissionMode plan "规划任务"  # 仅规划不执行
blade --permissionMode acceptEdits "修改代码"  # 自动接受编辑

# 添加允许访问的目录
blade --addDir /path/to/dir "访问目录"
```

**权限配置示例** (`.blade/settings.json`):
```json
{
  "permissions": {
    "allow": [
      "Read(file_path:**/*.ts)",
      "Grep",
      "Glob"
    ],
    "ask": [
      "Write",
      "Edit",
      "Bash(command:npm *)"
    ],
    "deny": [
      "Read(file_path:.env)",
      "Bash(command:rm -rf *)"
    ]
  }
}
```

详见 [权限系统指南](docs/public/configuration/permissions.md)

### IDE 集成

```bash
# 启动时自动连接 IDE
blade --ide
```

### 配置文件

```bash
# 使用设置文件
blade --settings settings.json

# 指定配置源
blade --settingSources "global,user,local"
```

---

## 📚 命令参考

### 主要命令

| 命令 | 说明 | 示例 |
|------|------|------|
| `blade [message..]` | 发送消息或启动交互式界面（默认） | `blade "你好"` |
| `blade config` | 配置管理 | `blade config` |
| `blade mcp` | 配置和管理 MCP 服务器 | `blade mcp` |
| `blade doctor` | 系统健康检查 | `blade doctor` |
| `blade update` | 检查更新并安装 | `blade update` |
| `blade install [target]` | 安装指定版本（stable/latest/版本号） | `blade install latest` |
| `blade setup-token` | 设置认证令牌 | `blade setup-token` |
| `blade completion` | 生成 shell 补全脚本 | `blade completion` |

### 调试选项

| 选项 | 简写 | 说明 |
|------|------|------|
| `--debug [category]` | `-d` | 启用调试模式，可选分类过滤 |
| `--verbose` | | 启用详细输出模式 |

### 输出选项

| 选项 | 简写 | 说明 |
|------|------|------|
| `--print` | `-p` | 打印响应并退出（适合管道） |
| `--outputFormat <format>` | | 输出格式：text/json/stream-json（仅与 --print 配合） |
| `--includePartialMessages` | | 包含部分消息块 |

### 输入选项

| 选项 | 说明 |
|------|------|
| `--inputFormat <format>` | 输入格式：text/stream-json |
| `--replayUserMessages` | 重新发送来自 stdin 的用户消息 |

### 安全选项

| 选项 | 说明 |
|------|------|
| `--dangerouslySkipPermissions` | 跳过所有权限检查（危险） |
| `--allowedTools <tools>` | 允许的工具列表（逗号或空格分隔） |
| `--disallowedTools <tools>` | 禁止的工具列表（逗号或空格分隔） |
| `--permissionMode <mode>` | 权限模式：acceptEdits/bypassPermissions/default/plan |
| `--addDir <dirs>` | 允许工具访问的额外目录 |

### MCP 选项

| 选项 | 说明 |
|------|------|
| `--mcpConfig <files>` | 从 JSON 文件或字符串加载 MCP 服务器 |
| `--strictMcpConfig` | 仅使用 --mcpConfig 指定的服务器 |

### AI 选项

| 选项 | 说明 |
|------|------|
| `--appendSystemPrompt <text>` | 追加系统提示到默认提示 |
| `--model <name>` | 当前会话使用的模型 |
| `--fallbackModel <name>` | 启用自动回退到指定模型 |
| `--agents <json>` | 自定义 Agent 的 JSON 对象 |

### 会话选项

| 选项 | 简写 | 说明 |
|------|------|------|
| `--continue` | `-c` | 继续最近的会话 |
| `--resume <id>` | `-r` | 恢复指定会话 |
| `--forkSession` | | 恢复会话时创建新会话 ID |
| `--sessionId <id>` | | 使用特定会话 ID |

### 配置选项

| 选项 | 说明 |
|------|------|
| `--settings <path>` | | 设置 JSON 文件路径或 JSON 字符串 |
| `--settingSources <sources>` | | 要加载的设置源（逗号分隔） |

### 集成选项

| 选项 | 说明 |
|------|------|
| `--ide` | | 启动时自动连接到 IDE |

### 其他选项

| 选项 | 简写 | 说明 |
|------|------|------|
| `--help` | `-h` | 显示帮助 |
| `--version` | `-V` | 显示版本号 |

---

## 🏗️ 技术架构

Blade Code 采用现代化的扁平化架构设计：

```
src/
├── agent/          # Agent 核心逻辑和控制器
├── cli/            # CLI 配置和中间件
├── commands/       # CLI 命令定义和处理
├── config/         # 统一配置管理（双文件系统）
├── tools/          # 工具系统（含执行管道）
│   ├── builtin/    # 内置工具
│   ├── execution/  # 6阶段执行管道
│   ├── registry/   # 工具注册中心
│   └── validation/ # 参数验证
├── ui/             # UI 组件和界面（基于 Ink）
├── services/       # 共享服务层
├── prompts/        # 提示模板管理
├── mcp/            # MCP 协议实现
└── utils/          # 工具函数
```

### 核心特性

- 🚀 **极速构建**：使用 Bun 构建，性能卓越
- 📦 **单文件部署**：构建产物仅 ~1MB
- 🎨 **React for CLI**：基于 Ink 的现代化 UI
- 🔧 **TypeScript**：完整类型支持
- ✅ **全面测试**：单元、集成、E2E 测试覆盖
- 🔒 **6阶段执行管道**：Discovery → Validation → Permission → Confirmation → Execution → Formatting
- 🛡️ **三级权限控制**：allow/ask/deny 精细化权限管理
- 🎯 **双配置文件系统**：config.json（基础配置） + settings.json（行为配置）

---

## 🔨 开发指南

### 环境要求

- Node.js >= 16.0.0
- pnpm（推荐）或 npm

### 克隆项目

```bash
git clone https://github.com/echoVic/blade-code.git
cd blade-code
pnpm install
```

### 开发命令

```bash
# 开发模式（热重载）
pnpm dev

# 构建
pnpm build

# 运行测试
pnpm test

# 测试覆盖率
pnpm test:coverage

# 代码检查
pnpm check:fix

# 类型检查
pnpm type-check
```

### 项目结构

```
blade-code/
├── src/              # 源代码
├── tests/            # 测试文件
├── dist/             # 构建产物
├── scripts/          # 构建脚本
└── docs/             # 文档
```

---

## 🤝 贡献指南

我们欢迎所有形式的贡献！

- 🐛 [报告 Bug](https://github.com/echoVic/blade-code/issues/new?template=bug_report.md)
- 💡 [功能建议](https://github.com/echoVic/blade-code/issues/new?template=feature_request.md)
- 📖 [改进文档](https://github.com/echoVic/blade-code/pulls)
- 🔧 [提交代码](CONTRIBUTING.md)

### 贡献流程

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

详细信息请查看 [贡献指南](CONTRIBUTING.md)。

---

## 📄 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](LICENSE) 文件。

---

## 🙏 致谢

Blade Code 的开发离不开以下优秀的开源项目：

- [Ink](https://github.com/vadimdemedes/ink) - React for CLI
- [OpenAI](https://github.com/openai/openai-node) - OpenAI API 客户端
- [Biome](https://github.com/biomejs/biome) - 代码格式化和检查
- [Vitest](https://github.com/vitest-dev/vitest) - 测试框架
- [Bun](https://github.com/oven-sh/bun) - 快速构建工具

---

## 📞 联系方式

- **作者**: echoVic
- **主页**: [https://github.com/echoVic/blade-code](https://github.com/echoVic/blade-code)
- **问题反馈**: [GitHub Issues](https://github.com/echoVic/blade-code/issues)

---

## 🌟 Star History

如果觉得 Blade Code 对您有帮助，请给我们一个 ⭐️ Star！

[![Star History Chart](https://api.star-history.com/svg?repos=echoVic/blade-code&type=Date)](https://star-history.com/#echoVic/blade-code&Date)

---

<div align="center">

**🗡️ Blade Code - 让 AI 成为您的命令行伙伴！**

Made with ❤️ by [echoVic](https://github.com/echoVic)

</div>

# 🗡️ Blade Code

专注于 LLM 的智能代码助手工具，提供便捷的命令行代码开发体验和强大的工具生态。

[![npm version](https://badge.fury.io/js/blade-code.svg)](https://www.npmjs.com/package/blade-code)
[![Node.js Version](https://img.shields.io/node/v/blade-code.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## ✨ 核心特性

- 🎯 **智能对话**：统一的聊天界面，自动选择合适工具协助回答
- 🧠 **会话管理**：支持多会话、继续对话、会话恢复功能
- 🔧 **丰富工具**：内置文件、Git、网络、分析等实用工具
- 🤖 **智能助手**：基于 LLM 的自然语言交互和任务处理
- 🔗 **MCP 支持**：支持 Model Context Protocol，可扩展外部资源和工具
- 🛡️ **安全可控**：支持权限管理、工具白名单等安全特性
- 🌟 **多模型支持**：千问(Qwen)、豆包(VolcEngine)、回退机制
- 🚀 **开箱即用**：零配置快速开始，支持环境变量配置
- 🏗️ **现代化架构**：基于 TypeScript 的扁平化设计，使用 Bun 构建

## 🏗️ 架构概览

Blade 采用现代化的 **扁平化单包架构** 设计：

```
src/
├── agent/          # Agent 核心逻辑和控制器
├── cli/            # CLI 配置和中间件
├── commands/       # CLI 命令定义和处理
├── config/         # 统一配置管理
├── context/        # 上下文管理和压缩
├── error/          # 错误处理和恢复
├── ide/            # IDE 集成和扩展
├── logging/        # 日志系统
├── mcp/            # MCP 协议实现
├── prompts/        # 提示模板管理
├── security/       # 安全管理
├── services/       # 共享服务层
├── slash-commands/ # 内置斜杠命令
├── telemetry/      # 遥测和监控
├── tools/          # 工具系统
├── ui/             # UI 组件和界面
├── utils/          # 工具函数
└── blade.tsx       # CLI 应用入口
```

**设计特点：**
- **扁平化结构**：减少嵌套层级，简化模块导入
- **领域划分**：按功能领域组织，职责清晰
- **模块化设计**：每个目录独立负责特定功能
- **类型安全**：全面的 TypeScript 覆盖
- **高性能构建**：使用 Bun 原生构建，支持 minification

## 🚀 快速开始

### ⚡ 零安装试用

```bash
# 无需安装，直接试用
npx blade-code "你好，介绍一下自己"

# 启动交互式界面
npx blade-code

# 使用特定选项
npx blade-code --print "解释什么是TypeScript"
```

### 📦 安装

```bash
# 全局安装（推荐）
npm install -g blade-code

# 然后就可以使用了
blade "你好"

# 或者启动交互式界面
blade
```

### 🔐 配置 API 密钥

**选择一种方式配置 API 密钥：**

```bash
# 方式1: 环境变量（推荐）
export QWEN_API_KEY="your-qwen-api-key"

# 方式2: 命令行参数
blade --api-key your-api-key "你好"

# 方式3: .env 文件
cp config.env.example .env
# 编辑 .env 文件填入密钥
```

**获取 API 密钥：**
- 千问: https://dashscope.console.aliyun.com/apiKey
- 火山引擎: https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey

## 💬 基础使用

### 直接问答

```bash
# 基础聊天
blade "什么是人工智能？"

# 代码生成
blade "用Python写一个快速排序"

# 智能工具调用（自动识别需求）
blade "现在几点了？"
blade "查看当前git状态"
blade "帮我审查代码质量"
```

### 交互式聊天

```bash
# 启动交互式界面
blade

# 打印模式（适合管道操作）
blade --print "解释什么是TypeScript"

# 继续最近的对话
blade --continue

# 使用 MCP 配置文件
blade --mcpConfig path/to/config.json "分析项目数据"
```

### 会话管理

```bash
# 指定会话ID创建会话
blade --session-id "work" "我叫张三，是前端工程师"

# 继续指定会话
blade --session-id "work" "你还记得我的职业吗？"

# 继续最近的对话
blade --continue "昨天我们聊了什么？"

# 恢复特定对话
blade --resume conversation-id "继续之前的讨论"
```

## 🔧 工具生态

Blade 内置多种实用工具，通过自然语言即可调用：

### 🤖 智能处理

| 功能 | 使用示例 |
|------|----------|
| 代码分析 | `"审查我的 app.js 代码"` |
| 文档生成 | `"为项目生成 README"` |
| 自动化任务 | `"分析 Git 变更并提交"` |

### 📂 内置工具

| 类别 | 主要功能 |
|------|----------|
| 文件操作 | 读写文件、多文件编辑、文件系统操作 |
| 搜索工具 | 文件搜索、全文检索、模式匹配 |
| Shell 工具 | 命令执行、脚本运行、后台任务 |
| 网络工具 | HTTP 请求、API 调用、Web 抓取 |
| 任务管理 | 任务调度、并发执行、结果处理 |

### 🛡️ 安全确认机制

所有写入操作都提供智能确认：

```bash
blade "删除临时文件"
# 📋 建议执行以下命令:
#   rm temp.txt
#   风险级别: 中等
# ✔ 是否执行？ Yes
```

**风险级别：**
- 🟢 **安全** - 只读操作，自动执行
- 🟡 **中等** - 普通写入，需要确认
- 🟠 **高风险** - 覆盖文件，重点确认
- 🔴 **极高风险** - 危险操作，严格确认

## 🎭 使用场景

### 智能助手

```bash
# 知识问答
blade "解释微服务架构"

# 代码相关
blade "审查我的代码并优化"
blade "生成项目文档"
blade "帮我重构这个函数"

# 调试模式
blade --debug "分析性能问题"
```

**特点：** 通用问答、代码生成、智能工具调用、上下文理解

## 🌟 高级功能

### 配置管理

```bash
# 配置管理
blade config

# 设置配置项（具体用法需查看帮助）
blade config --help
```

### MCP 服务器

```bash
# 管理 MCP 服务器
blade mcp

# 加载 MCP 配置
blade --mcp-config config.json "使用外部工具"

# 严格模式（仅使用指定配置）
blade --strict-mcp-config --mcp-config config.json "查询"
```

### 模型和会话

```bash
# 指定模型
blade --model qwen-max "复杂问题"

# 设置回退模型
blade --fallback-model qwen-turbo "问题"

# 自定义系统提示
blade --append-system-prompt "你是专家" "请解答"
```

## 📋 命令参考

| 命令 | 功能 | 示例 |
|------|------|------|
| `[message]` | 智能对话 | `blade "你好"` |
| `(无参数)` | 交互式界面 | `blade` |
| `config` | 配置管理 | `blade config set theme dark` |
| `mcp` | MCP服务器管理 | `blade mcp list` |
| `doctor` | 健康检查 | `blade doctor` |
| `update` | 检查更新 | `blade update` |
| `install` | 安装指定版本 | `blade install latest` |
| `setup-token` | 设置认证令牌 | `blade setup-token` |

### 常用参数

- `-p, --print` - 打印模式（适合管道操作）
- `-c, --continue` - 继续最近的对话
- `-r, --resume <id>` - 恢复指定对话
- `-d, --debug` - 启用调试模式
- `--model <name>` - 指定使用的模型
- `--session-id <id>` - 指定会话ID

## 🔧 开发

### 项目结构

```
src/
├── agent/          # Agent 核心逻辑和控制器
├── cli/            # CLI 配置和中间件
├── commands/       # CLI 命令定义和处理
├── config/         # 统一配置管理
├── context/        # 上下文管理和压缩
├── error/          # 错误处理和恢复
├── ide/            # IDE 集成和扩展
├── logging/        # 日志系统
├── mcp/            # MCP 协议实现
├── prompts/        # 提示模板管理
├── security/       # 安全管理
├── services/       # 共享服务层
├── slash-commands/ # 内置斜杠命令
├── telemetry/      # 遥测和监控
├── tools/          # 工具系统
├── ui/             # UI 组件和界面
├── utils/          # 工具函数
└── blade.tsx       # CLI 应用入口
```

### 开发命令

```bash
# 开发模式 (Bun watch)
npm run dev

# 构建 (使用 Bun，minified)
npm run build              # 完整构建 (CLI + Core)
npm run build:cli          # 仅构建 CLI (972KB)
npm run build:core         # 仅构建 Core (389KB)

# 运行构建后的 CLI
npm run start

# 类型检查
npm run type-check

# 代码格式化 (Biome)
npm run format

# 代码检查 (Biome lint + format)
npm run check

# 运行测试
npm test
npm run test:coverage
```

### 构建系统

项目使用 **Bun** 作为构建工具，具有以下特点：

- **极速构建**：Bun 原生 TypeScript 支持，构建速度显著提升
- **代码压缩**：生产环境自动 minification
- **分离构建**：CLI 和 Core 可独立构建
- **依赖优化**：智能 external 依赖处理

## 🧪 测试架构

Blade 拥有完整的测试覆盖：

```
tests/
├── unit/           # 单元测试
├── integration/    # 集成测试
├── e2e/           # 端到端测试
└── security/      # 安全测试
```

## 🤝 贡献

我们欢迎各种形式的贡献！请查看 [贡献指南](CONTRIBUTING.md) 了解详细信息。

- 🐛 [报告 Bug](https://github.com/echoVic/blade-code/issues)
- 💡 [功能建议](https://github.com/echoVic/blade-code/issues)
- 🔧 [代码贡献](CONTRIBUTING.md)

## 📄 许可证

MIT License

---

## 💡 使用技巧

### 选择合适的模式

- **快速问答**: `blade "问题"` - 一次性问题
- **持续对话**: `blade -i` - 复杂任务讨论
- **流式输出**: `添加 --stream` - 更好的交互体验
- **记忆对话**: `添加 --context` - AI 记住历史

### 智能工具最佳实践

- 用自然语言描述需求，让 AI 自动选择工具
- 说"请审查代码"而不是记忆具体工具名
- 让 AI 分析 Git 变更，生成更好的提交信息
- 使用场景模式获得专业的回复风格

### 常见问题

**Q: API 密钥错误？**
```bash
# 检查配置
echo $QWEN_API_KEY

# 或直接指定
blade --api-key your-key "测试"
```

**Q: 如何更换模型？**
```bash
blade --provider volcengine "你好"
blade --model qwen-max-latest "复杂问题"
```

**Q: 工具调用失败？**
- 确保在正确的目录（Git 工具需要 Git 仓库）
- 检查文件权限（文件工具需要读写权限）
- 使用 `blade tools list` 查看可用工具

---

**🗡️ Blade - 让 AI 成为你的命令行伙伴！**
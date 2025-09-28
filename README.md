# 🗡️ Blade

专注于 LLM 的智能 CLI Agent 工具，提供便捷的命令行 AI 交互体验和强大的工具生态。

[![npm version](https://badge.fury.io/js/blade-ai.svg)](https://www.npmjs.com/package/blade-ai)
[![Node.js Version](https://img.shields.io/node/v/blade-ai.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## ✨ 核心特性

- 🎯 **智能对话**：支持多种聊天模式，自动选择合适工具协助回答
- 🧠 **上下文记忆**：AI 记住对话历史，支持多会话管理
- 🔧 **25+ 工具**：涵盖 Git、文件、网络、智能分析等场景
- 🤖 **智能工具**：LLM 驱动的代码审查、文档生成、智能提交
- 🔗 **MCP 支持**：支持 Model Context Protocol，可扩展外部资源和工具
- 🛡️ **安全确认**：统一的命令确认机制，智能风险评估
- 🌟 **多模型支持**：千问(Qwen)、豆包(VolcEngine)
- 🚀 **开箱即用**：零配置快速开始
- 🏗️ **现代化架构**：基于 TypeScript 的分层设计，使用 Bun 构建，支持扩展

## 🏗️ 架构概览

Blade 采用现代化的 **单包分层架构** 设计：

```
src/
├── cli/             # 用户界面层 (CLI 入口)
│   ├── ui/          # 终端 UI 组件和 Hooks
│   ├── services/    # CLI 业务服务层
│   ├── config/      # CLI 配置管理
│   └── blade.tsx    # CLI 主入口
├── core/            # 核心业务层
│   ├── agent/       # Agent 核心组件
│   ├── tools/       # 工具系统
│   ├── services/    # 核心服务
│   ├── ide/         # IDE 集成
│   ├── mcp/         # MCP 协议支持
│   ├── telemetry/   # 遥测系统
│   └── index.ts     # Core 主入口
```

**设计特点：**
- **关注点分离**：CLI 层专注 UI，Core 层专注业务逻辑
- **模块化组织**：功能按领域分组，服务独立
- **可扩展性**：支持插件机制和外部集成
- **类型安全**：全面的 TypeScript 覆盖
- **高性能构建**：使用 Bun 原生构建，支持 minification

## 🚀 快速开始

### ⚡ 零安装试用

```bash
# 无需安装，直接试用
npx blade-ai chat "你好，介绍一下自己"

# 智能工具调用
npx blade-ai chat "现在几点了？"

# 流式输出
npx blade-ai chat --stream "详细解释机器学习原理"
```

### 📦 安装

```bash
# 全局安装（推荐）
npm install -g blade-ai

# 然后就可以使用了
blade chat "你好"
```

### 🔐 配置 API 密钥

**选择一种方式配置 API 密钥：**

```bash
# 方式1: 环境变量（推荐）
export QWEN_API_KEY="your-qwen-api-key"

# 方式2: 命令行参数
blade chat --api-key your-api-key "你好"

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
blade chat "什么是人工智能？"

# 代码生成
blade chat "用Python写一个快速排序"

# 智能工具调用（自动识别需求）
blade chat "现在几点了？"
blade chat "查看当前git状态"
blade chat "帮我审查代码质量"
```

### 交互式聊天

```bash
# 启动持续对话
blade chat -i

# 流式输出交互
blade chat -i --stream

# 带记忆的对话
blade chat -i --context

# 使用 MCP 外部资源
blade chat --mcp my-server "分析项目数据"
```

### 上下文记忆

```bash
# 创建记忆会话
blade chat --context "我叫张三，是前端工程师"

# 在同一会话中继续
blade chat --context "你还记得我的职业吗？"

# 指定会话ID
blade chat --context --context-session "work" "今天学了React"
blade chat --context --context-session "work" "昨天我们聊了什么？"
```

## 🔧 工具生态

Blade 内置 25+ 实用工具，通过自然语言即可调用：

### 🤖 智能工具

| 工具 | 功能 | 使用示例 |
|------|------|----------|
| 智能代码审查 | LLM 分析代码质量、安全性 | `"审查我的 app.js 代码"` |
| 智能文档生成 | 基于代码生成 API 文档 | `"为项目生成 README"` |
| Git 智能提交 | 分析变更生成提交信息 | `"智能分析并提交代码"` |

### 📂 文件与 Git

| 类别 | 工具数 | 主要功能 |
|------|--------|----------|
| 文件系统 | 4个 | 读写文件、目录操作 |
| Git 工具 | 7个 | 状态查看、提交、分支管理 |
| 文本处理 | 4个 | 搜索、替换、格式化 |
| 网络工具 | 4个 | HTTP 请求、URL 处理 |
| 实用工具 | 6个 | 时间戳、UUID、Base64 等 |

### 🛡️ 安全确认机制

所有写入操作都提供智能确认：

```bash
blade chat "删除临时文件"
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

### 智能助手（默认）

```bash
blade chat "解释微服务架构"
blade chat "审查我的代码并优化"
blade chat "生成项目文档"
```

**特点：** 通用问答、代码生成、智能工具调用

### 客服助手

```bash
blade chat --scenario customer "我想要退货"
blade chat --scenario customer "产品有质量问题"
```

**特点：** 专业客服回复、情绪分析、标准化用语

### 代码助手

```bash
blade chat --scenario code "优化这个算法"
blade chat --scenario code "审查安全性问题"
blade chat --scenario code "生成单元测试"
```

**特点：** 代码分析、性能优化、Git 操作、文档生成

## 🌟 高级功能

### 工具管理

```bash
# 查看所有工具
blade tools list

# 按类别查看
blade tools list --category git

# 查看工具详情
blade tools info smart_code_review

# 直接调用工具
blade tools call uuid
```

### 模型切换

```bash
# 使用不同模型
blade chat --provider volcengine "你好"
blade chat --model qwen-max-latest "复杂问题"

# 查看可用模型
blade models --provider qwen
```

### 流式输出

```bash
# 实时显示回答
blade chat --stream "详细解释区块链技术"

# 交互式流式聊天
blade chat -i --stream
```

## 📋 命令参考

| 命令 | 功能 | 示例 |
|------|------|------|
| `chat [question]` | 智能对话 | `blade chat "你好"` |
| `chat -i` | 交互式聊天 | `blade chat -i --stream` |
| `tools list` | 查看工具 | `blade tools list --category git` |
| `tools call <tool>` | 调用工具 | `blade tools call uuid` |
| `models` | 查看模型 | `blade models --provider qwen` |

### 常用参数

- `-i, --interactive` - 交互式模式
- `--stream` - 流式输出
- `--context` - 启用记忆
- `--scenario <type>` - 场景模式 (assistant/customer/code)
- `--provider <name>` - 指定提供商 (qwen/volcengine)
- `--api-key <key>` - 指定 API 密钥

## 💻 编程接口

### Agent 使用

```typescript
import { Agent } from './src/core/agent/Agent';

const agent = new Agent({
  llm: { provider: 'qwen', apiKey: 'your-key' },
  tools: { enabled: true }
});

await agent.init();

// 智能对话
const response = await agent.smartChat('审查代码');

// 调用工具
const result = await agent.callTool('uuid');

await agent.destroy();
```

### 工具管理

```typescript
import { createToolManager } from './src/core/tools/ToolManager';

const toolManager = await createToolManager();
const result = await toolManager.callTool({
  toolName: 'smart_code_review',
  parameters: { path: 'app.js' }
});
```

### 核心服务

```typescript
import { FileSystemService, GitService } from './src/core/services';

// 文件系统服务
const fileService = new FileSystemService(config);
await fileService.writeFile('/path/file.txt', '内容');

// Git 服务
const gitService = new GitService(config);
await gitService.commit('/repo', '提交信息');

// 遥测服务
import { TelemetrySDK } from './src/core/telemetry';
const telemetry = new TelemetrySDK(config);
telemetry.trackEvent('user_action', { action: 'click' });
```

## 🔧 开发

### 项目结构

```
src/
├── cli/             # 用户界面层 (CLI 入口)
│   ├── ui/          # 终端 UI 组件和 Hooks
│   ├── services/    # CLI 业务服务层
│   ├── config/      # CLI 配置管理
│   └── blade.tsx    # CLI 主入口
└── core/            # 核心业务层
    ├── agent/       # Agent 核心组件
    ├── tools/       # 工具系统
    ├── services/    # 核心服务
    ├── ide/         # IDE 集成
    ├── mcp/         # MCP 协议支持
    ├── telemetry/   # 遥测系统
    └── index.ts     # Core 主入口
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

欢迎提交 Issue 和 Pull Request！

1. Fork 项目
2. 创建特性分支
3. 提交更改
4. 推送到分支
5. 打开 Pull Request

## 📄 许可证

MIT License

---

## 💡 使用技巧

### 选择合适的模式

- **快速问答**: `blade chat "问题"` - 一次性问题
- **持续对话**: `blade chat -i` - 复杂任务讨论
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
blade chat --api-key your-key "测试"
```

**Q: 如何更换模型？**
```bash
blade chat --provider volcengine "你好"
blade chat --model qwen-max-latest "复杂问题"
```

**Q: 工具调用失败？**
- 确保在正确的目录（Git 工具需要 Git 仓库）
- 检查文件权限（文件工具需要读写权限）
- 使用 `blade tools list` 查看可用工具

---

**🗡️ Blade - 让 AI 成为你的命令行伙伴！**
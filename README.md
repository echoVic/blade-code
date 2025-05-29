# 🤖 LLM CLI Agent

一个专注于 LLM 的智能 CLI Agent 工具，提供便捷的命令行 AI 交互体验。

## ✨ 特性

- 🎯 **专注 LLM**：纯粹的 LLM CLI Agent，无其他干扰功能
- 💬 **多种聊天模式**：直接问答、交互式聊天、场景演示
- 🎭 **智能场景**：智能助手、客服、代码助手等专业场景
- 🔄 **流式聊天**：支持实时流式输出
- 🌟 **多提供商**：支持千问(Qwen)和豆包(VolcEngine)
- 🚀 **开箱即用**：无需复杂配置，快速开始

## 🛠 安装与配置

### 安装依赖

```bash
npm install
npm run build
```

### 配置 API 密钥

创建 `.env` 文件：

```bash
# 千问 API 密钥
QWEN_API_KEY=your_qwen_api_key

# 豆包 API 密钥  
VOLCENGINE_API_KEY=your_volcengine_api_key
```

## 🎯 使用指南

### 💬 直接问答（推荐）

最简单的使用方式，直接提问获得答案：

```bash
# 基础问答
bin/agent.js chat 什么是人工智能
bin/agent.js chat 解释一下微服务架构
bin/agent.js chat 如何学习编程

# 场景化问答
bin/agent.js chat --scenario customer 我想要退货
bin/agent.js chat --scenario code 如何优化这个函数
bin/agent.js chat --scenario assistant 什么是区块链

# 指定提供商和模型
bin/agent.js chat --provider volcengine --model ep-20250417144747-rgffm 你好
```

### 🔄 交互式聊天

进入持续对话模式：

```bash
# 启动交互式聊天（默认智能助手）
bin/agent.js chat
bin/agent.js chat --interactive

# 场景化交互式聊天
bin/agent.js chat -i --scenario customer
bin/agent.js chat -i --scenario code
bin/agent.js chat -i --scenario assistant

# 指定提供商的交互式聊天
bin/agent.js chat -i --provider volcengine
```

### 🎭 场景演示

查看预设场景的完整演示：

```bash
# 智能助手演示
bin/agent.js chat --demo --scenario assistant

# 客服助手演示
bin/agent.js chat --demo --scenario customer

# 代码助手演示
bin/agent.js chat --demo --scenario code
```

### 🤖 纯 LLM 聊天

不使用 Agent 功能，直接与 LLM 对话：

```bash
# 启动纯 LLM 聊天
bin/agent.js llm

# 流式输出聊天
bin/agent.js llm --stream

# 指定提供商
bin/agent.js llm --provider volcengine
```

### 📋 模型管理

查看和管理可用模型：

```bash
# 查看千问模型
bin/agent.js models --provider qwen

# 查看豆包模型  
bin/agent.js models --provider volcengine
```

## 📋 命令参考

| 命令 | 描述 | 主要参数 | 示例 |
|------|------|----------|------|
| `chat [question...]` | 智能 Agent 聊天 | `--scenario`, `--interactive`, `--demo` | `chat 你好` |
| `llm` | 纯 LLM 聊天模式 | `--provider`, `--stream` | `llm --stream` |
| `models` | 查看可用模型 | `--provider` | `models -p qwen` |

### Chat 命令详细参数

```bash
bin/agent.js chat [question...] [options]

参数:
  question                   要问的问题（可选）

选项:
  -p, --provider <provider>  选择 LLM 提供商 (volcengine|qwen) (默认: "qwen")
  -k, --api-key <key>        API 密钥
  -m, --model <model>        指定模型
  -s, --scenario <scenario>  选择场景 (customer|code|assistant) (默认: "assistant")
  -i, --interactive          启动交互式聊天模式
  --demo                     运行场景演示
  -h, --help                 显示帮助信息
```

## 🎭 场景介绍

### 🤖 智能助手 (assistant) - 默认
- **智能问答**：回答各种问题，提供详细解释
- **代码生成**：生成各种编程语言代码
- **流式回答**：实时显示回答过程，提升体验
- **适用场景**：通用问答、学习助手、技术咨询

```bash
# 示例
bin/agent.js chat 什么是机器学习
bin/agent.js chat --scenario assistant 解释量子计算
```

### 🎧 智能客服 (customer)
- **客户咨询处理**：专业的客服回复风格
- **情绪分析**：分析客户情绪并适当回应
- **标准化回复**：提供规范的客服用语
- **适用场景**：客户服务、投诉处理、咨询回复

```bash
# 示例  
bin/agent.js chat --scenario customer 我想要退货
bin/agent.js chat --scenario customer 产品质量有问题
```

### 💻 代码助手 (code)
- **代码审查**：从质量、性能、安全性等维度分析代码
- **代码优化**：提供具体的改进建议
- **测试生成**：自动生成测试用例
- **适用场景**：代码 review、性能优化、学习编程

```bash
# 示例
bin/agent.js chat --scenario code 如何优化这个函数
bin/agent.js chat --scenario code 审查我的JavaScript代码
```

## 🌐 支持的模型

### 千问 (Qwen) - 14个模型
- `qwen3-235b-a22b` (默认) - 最新旗舰模型
- `qwen-plus-latest` - Plus版本
- `qwen-turbo-latest` - 快速版本
- `qwen-max-latest` - 最大版本
- `qwen-long` - 长文本版本
- 等更多模型...

### 豆包 (VolcEngine) - 1个模型
- `ep-20250417144747-rgffm` (默认)

## 🚀 快速开始

### 1. 环境准备
```bash
# 克隆项目
git clone <repository>
cd agent-cli

# 安装依赖
npm install

# 构建项目
npm run build
```

### 2. 配置密钥
```bash
# 创建配置文件
echo "QWEN_API_KEY=your_qwen_api_key" > .env
```

### 3. 开始使用

```bash
# 最简单的用法 - 直接问答
bin/agent.js chat 你好

# 查看帮助
bin/agent.js --help

# 查看具体命令帮助
bin/agent.js chat --help
```

## 💡 使用技巧

### 🎯 选择合适的使用方式

- **直接问答**：`chat 你的问题` - 适合快速获得答案
- **交互式聊天**：`chat -i` - 适合持续对话
- **场景演示**：`chat --demo` - 了解功能特性

### 🎭 选择合适的场景

- **通用问答**：使用默认 `assistant` 场景
- **客服相关**：使用 `customer` 场景，获得专业客服回复
- **编程相关**：使用 `code` 场景，获得专业代码分析

### ⚡ 提升体验

- 使用 `--stream` 参数（在 llm 命令中）获得实时输出
- 在交互模式中输入 `quit` 或 `exit` 优雅退出
- 使用简短别名：`l` 代替 `llm`，`m` 代替 `models`

## 🔧 开发

### 项目结构

```
src/
├── agent/           # Agent 核心框架
│   ├── Agent.ts     # 主要 Agent 类
│   └── BaseComponent.ts
├── llm/             # LLM 实现
│   ├── BaseLLM.ts   # LLM 基类
│   ├── QwenLLM.ts   # 千问实现
│   └── VolcEngineLLM.ts # 豆包实现
├── config/          # 配置管理
├── commands/        # CLI 命令实现
│   ├── agent-llm.ts # chat 命令
│   └── llm.ts       # llm 和 models 命令
└── index.ts         # 主入口
```

### 构建与开发

```bash
# 构建
npm run build

# 开发模式
npm run dev

# 类型检查
npm run type-check

# 代码格式化
npm run format
```

## 💻 编程接口

### Agent 使用示例

```typescript
import { Agent, AgentConfig } from 'agent-cli';

// 创建 Agent 配置
const config: AgentConfig = {
  debug: false,
  llm: {
    provider: 'qwen',
    apiKey: process.env.QWEN_API_KEY,
    model: 'qwen3-235b-a22b'
  }
};

// 创建并初始化 Agent
const agent = new Agent(config);
await agent.init();

// 使用各种 Agent 功能
const answer = await agent.ask('什么是人工智能？');
const code = await agent.generateCode('快速排序算法', 'python');
const review = await agent.reviewCode(sourceCode, 'javascript');

// 清理资源
await agent.destroy();
```

### 纯 LLM 使用示例

```typescript
import { QwenLLM, getProviderConfig } from 'agent-cli';

const config = getProviderConfig('qwen');
const llm = new QwenLLM(config.apiKey, config.defaultModel);

await llm.init();

// 单次对话
const response = await llm.chat([
  { role: 'user', content: '你好！' }
]);

// 流式对话
await llm.streamChat([
  { role: 'user', content: '讲个故事' }
], (chunk) => {
  process.stdout.write(chunk);
});

await llm.destroy();
```

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## �� 许可证

MIT License 
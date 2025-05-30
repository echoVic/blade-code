# 🤖 LLM CLI Agent

一个专注于 LLM 的智能 CLI Agent 工具，提供便捷的命令行 AI 交互体验和强大的工具生态。

## ✨ 特性

- 🎯 **专注 LLM**：纯粹的 LLM CLI Agent，无其他干扰功能
- 💬 **多种聊天模式**：直接问答、交互式聊天、场景演示
- 🎭 **智能场景**：智能助手、客服、代码助手等专业场景
- 🔄 **流式聊天**：支持实时流式输出
- 🌟 **多提供商**：支持千问(Qwen)和豆包(VolcEngine)
- 🔧 **工具生态**：内置25个实用工具，涵盖Git、文件、网络、智能分析等
- 🤖 **智能工具**：基于LLM增强的智能代码审查和文档生成
- 🚀 **开箱即用**：无需复杂配置，快速开始

## 🛠 工具生态 (25个工具)

### 🤖 智能工具 (2个) - ⭐ 新增
- **智能代码审查** (`smart_code_review`): 使用LLM分析代码质量、安全性和性能
- **智能文档生成** (`smart_doc_generator`): 基于代码自动生成API文档和README

### 📂 文件系统工具 (4个)
- `file_read`: 读取文件内容
- `file_write`: 写入文件内容  
- `directory_list`: 列出目录内容
- `file_info`: 获取文件详细信息

### 🌐 网络工具 (2个)
- `http_request`: 发送HTTP请求
- `ping`: 网络连通性测试

### 📝 文本处理工具 (4个)
- `text_length`: 计算文本长度和统计
- `text_hash`: 文本哈希计算
- `text_encode`: 文本编码转换
- `text_search`: 文本搜索和替换

### 🔧 实用工具 (6个)
- `timestamp`: 时间戳处理
- `uuid`: UUID生成
- `json_format`: JSON格式化
- `base64`: Base64编码解码
- `random_string`: 随机字符串生成
- `url_parse`: URL解析

### 📊 Git工具 (7个)
- `git_status`: 查看仓库状态
- `git_log`: 查看提交历史
- `git_diff`: 查看文件差异
- `git_branch`: 管理分支
- `git_add`: 添加文件到暂存区
- `git_commit`: 提交变更
- `git_smart_commit`: **🤖 智能提交** - 使用LLM分析变更并生成提交信息

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
node dist/index.js chat 什么是人工智能
node dist/index.js chat 解释一下微服务架构
node dist/index.js chat 如何学习编程

# 智能代码审查
node dist/index.js chat "请审查我的JavaScript代码文件 app.js"
node dist/index.js chat "检查这个文件的安全性问题: user.js"

# 智能文档生成
node dist/index.js chat "为我的项目生成README文档"
node dist/index.js chat "分析src目录并生成API文档"

# Git智能操作
node dist/index.js chat "查看当前的代码变更并智能提交"
node dist/index.js chat "分析代码差异生成合适的commit信息"

# 场景化问答
node dist/index.js chat --scenario customer 我想要退货
node dist/index.js chat --scenario code 如何优化这个函数
node dist/index.js chat --scenario assistant 什么是区块链

# 指定提供商和模型
node dist/index.js chat --provider volcengine --model ep-20250417144747-rgffm 你好
```

### 🔧 工具管理

查看和使用各种内置工具：

```bash
# 查看所有工具
node dist/index.js tools list

# 按分类查看工具
node dist/index.js tools list --category smart
node dist/index.js tools list --category git
node dist/index.js tools list --category filesystem

# 查看工具详情
node dist/index.js tools info smart_code_review
node dist/index.js tools info git_smart_commit

# 直接调用工具（注意：智能工具需要通过Agent调用）
node dist/index.js tools call uuid
node dist/index.js tools call timestamp --params '{"operation": "now"}'
```

### 🔄 交互式聊天

进入持续对话模式：

```bash
# 启动交互式聊天（默认智能助手）
node dist/index.js chat
node dist/index.js chat --interactive

# 场景化交互式聊天
node dist/index.js chat -i --scenario customer
node dist/index.js chat -i --scenario code
node dist/index.js chat -i --scenario assistant

# 指定提供商的交互式聊天
node dist/index.js chat -i --provider volcengine
```

### 🎭 场景演示

查看预设场景的完整演示：

```bash
# 智能助手演示
node dist/index.js chat --demo --scenario assistant

# 客服助手演示
node dist/index.js chat --demo --scenario customer

# 代码助手演示
node dist/index.js chat --demo --scenario code
```

### 🤖 纯 LLM 聊天

不使用 Agent 功能，直接与 LLM 对话：

```bash
# 启动纯 LLM 聊天
node dist/index.js llm

# 流式输出聊天
node dist/index.js llm --stream

# 指定提供商
node dist/index.js llm --provider volcengine
```

### 📋 模型管理

查看和管理可用模型：

```bash
# 查看千问模型
node dist/index.js models --provider qwen

# 查看豆包模型  
node dist/index.js models --provider volcengine
```

## 📋 命令参考

| 命令 | 描述 | 主要参数 | 示例 |
|------|------|----------|------|
| `chat [question...]` | 智能 Agent 聊天 | `--scenario`, `--interactive`, `--demo` | `chat 你好` |
| `llm` | 纯 LLM 聊天模式 | `--provider`, `--stream` | `llm --stream` |
| `models` | 查看可用模型 | `--provider` | `models -p qwen` |
| `tools` | 工具管理和操作 | `list`, `info`, `call` | `tools list --category smart` |

### Chat 命令详细参数

```bash
node dist/index.js chat [question...] [options]

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

### Tools 命令详细参数

```bash
node dist/index.js tools <command> [options]

命令:
  list [options]             📋 列出可用工具
  info <toolName>           🔍 查看工具详细信息  
  call <toolName> [options] ⚡ 调用指定工具
  docs                      📖 打开工具文档
```

## 🎭 场景介绍

### 🤖 智能助手 (assistant) - 默认
- **智能问答**：回答各种问题，提供详细解释
- **代码生成**：生成各种编程语言代码
- **工具集成**：自动调用合适的工具协助回答
- **智能分析**：使用智能工具进行代码审查和文档生成
- **适用场景**：通用问答、学习助手、技术咨询、开发辅助

```bash
# 示例
node dist/index.js chat 什么是机器学习
node dist/index.js chat 审查我的代码文件并给出建议
node dist/index.js chat 为这个项目生成文档
```

### 🎧 智能客服 (customer)
- **客户咨询处理**：专业的客服回复风格
- **情绪分析**：分析客户情绪并适当回应
- **标准化回复**：提供规范的客服用语
- **适用场景**：客户服务、投诉处理、咨询回复

```bash
# 示例  
node dist/index.js chat --scenario customer 我想要退货
node dist/index.js chat --scenario customer 产品质量有问题
```

### 💻 代码助手 (code)
- **代码审查**：从质量、性能、安全性等维度分析代码
- **代码优化**：提供具体的改进建议
- **智能Git操作**：分析变更并生成合适的提交信息
- **文档生成**：自动生成API文档和技术说明
- **适用场景**：代码 review、性能优化、学习编程、项目维护

```bash
# 示例
node dist/index.js chat --scenario code 如何优化这个函数
node dist/index.js chat --scenario code 审查我的JavaScript代码
node dist/index.js chat --scenario code 帮我提交当前的代码变更
```

## 🤖 智能工具详解

### 智能代码审查 (`smart_code_review`)

使用LLM深度分析代码质量，提供专业的审查报告：

```bash
# 通过Agent智能聊天使用（推荐）
node dist/index.js chat "请审查 src/utils.js 的代码质量"
node dist/index.js chat "检查 app.ts 的安全性问题"
node dist/index.js chat "分析 components/User.jsx 的性能问题"
```

**功能特点：**
- 🔍 **多维度分析**：代码质量、安全性、性能、可维护性
- 🎯 **专项检查**：可选择特定审查类型（security/performance/style等）
- 📊 **详细报告**：问题分类、严重程度、具体建议
- 🌐 **多语言支持**：支持20+编程语言自动检测

### 智能文档生成 (`smart_doc_generator`)

基于代码结构智能生成项目文档：

```bash
# 通过Agent智能聊天使用（推荐）
node dist/index.js chat "为 src/ 目录生成API文档"
node dist/index.js chat "分析整个项目并生成README"
node dist/index.js chat "为这个库生成用户指南"
```

**功能特点：**
- 📝 **多种文档类型**：API文档、README、用户指南、技术文档
- 🔄 **自动分析**：扫描代码结构，提取函数、类、导出信息
- 💡 **智能生成**：基于实际代码生成准确的使用示例
- 📋 **标准化格式**：遵循Markdown规范，结构清晰

### Git智能提交 (`git_smart_commit`)

分析代码变更并使用LLM生成规范的提交信息：

```bash
# 通过Agent智能聊天使用（推荐）
node dist/index.js chat "查看当前变更并智能提交"
node dist/index.js chat "分析diff生成commit信息"

# 也可以直接使用Git工具
node dist/index.js tools call git_smart_commit
```

**功能特点：**
- 🧠 **智能分析**：LLM深度理解代码变更内容
- 📏 **规范格式**：生成符合Conventional Commits规范的提交信息
- 🔄 **完整流程**：自动添加文件、分析、生成信息、执行提交
- 👁️ **预览模式**：支持干运行，预览提交信息而不实际提交

## 🌐 支持的模型

### 千问 (Qwen) - 14个模型
- `qwen3-235b-a22b` (默认) - 最新旗舰模型，智能工具优化
- `qwen-plus-latest` - Plus版本
- `qwen-turbo-latest` - 快速版本
- `qwen-max-latest` - 最大版本
- `qwen-long` - 长文本版本
- 等更多模型...

### 豆包 (VolcEngine) - 3个模型
- `ep-20250417144747-rgffm` (默认) - 豆包原生模型
- `ep-20250530171307-rrcc5` - DeepSeek R1 250528，推理能力强
- `ep-20250530171222-q42h8` - DeepSeek V3，综合性能优秀

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
node dist/index.js chat 你好

# 智能代码审查
node dist/index.js chat "审查我的代码文件"

# 查看所有工具
node dist/index.js tools list

# 查看帮助
node dist/index.js --help
```

## 💡 使用技巧

### 🎯 选择合适的使用方式

- **直接问答**：`chat 你的问题` - 适合快速获得答案，自动调用工具
- **交互式聊天**：`chat -i` - 适合持续对话和复杂任务
- **工具直调**：`tools call tool_name` - 适合简单工具的快速调用
- **场景演示**：`chat --demo` - 了解功能特性

### 🎭 选择合适的场景

- **通用问答**：使用默认 `assistant` 场景，支持智能工具调用
- **客服相关**：使用 `customer` 场景，获得专业客服回复
- **编程相关**：使用 `code` 场景，自动优化代码分析工具调用

### 🤖 智能工具最佳实践

- **代码审查**：通过自然语言描述需求，Agent自动选择合适的审查类型
- **文档生成**：描述文档需求和目标用户，获得更精准的文档
- **Git操作**：让Agent分析变更上下文，生成更有意义的提交信息

### ⚡ 提升体验

- 使用 `--stream` 参数（在 llm 命令中）获得实时输出
- 在交互模式中输入 `quit` 或 `exit` 优雅退出
- 使用简短别名：`l` 代替 `llm`，`m` 代替 `models`
- 善用工具分类查看：`tools list --category smart`

## 🔧 开发

### 项目结构

```
src/
├── agent/           # Agent 核心框架
│   ├── Agent.ts     # 主要 Agent 类（智能工具集成）
│   ├── BaseComponent.ts
│   └── ToolComponent.ts
├── tools/           # 工具系统
│   ├── builtin/     # 内置工具
│   │   ├── smart/   # 🤖 智能工具
│   │   ├── git/     # Git工具
│   │   ├── file-system.ts
│   │   ├── network.ts
│   │   └── utility.ts
│   ├── ToolManager.ts
│   └── types.ts
├── llm/             # LLM 实现
│   ├── BaseLLM.ts   # LLM 基类
│   ├── QwenLLM.ts   # 千问实现
│   └── VolcEngineLLM.ts # 豆包实现
├── config/          # 配置管理
├── commands/        # CLI 命令实现
│   ├── agent-llm.ts # chat 命令
│   ├── llm.ts       # llm 和 models 命令
│   └── tools.ts     # tools 命令
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
  },
  tools: {
    enabled: true,
    includeBuiltinTools: true,
    includeCategories: ['smart', 'git', 'filesystem']
  }
};

// 创建并初始化 Agent
const agent = new Agent(config);
await agent.init();

// 使用智能聊天（自动调用工具）
const response = await agent.smartChat('请审查我的代码文件 app.js');

// 使用各种 Agent 功能
const answer = await agent.ask('什么是人工智能？');
const code = await agent.generateCode('快速排序算法', 'python');
const review = await agent.reviewCode(sourceCode, 'javascript');

// 直接调用工具
const reviewResult = await agent.callTool('smart_code_review', {
  path: 'src/utils.js',
  reviewType: 'security'
});

// 获取可用工具
const tools = agent.getAvailableTools();
const smartTools = agent.searchTools('smart');

// 清理资源
await agent.destroy();
```

### 工具管理器使用示例

```typescript
import { createToolManager } from 'agent-cli';

// 创建工具管理器
const toolManager = await createToolManager();

// 调用智能工具（需要LLM支持）
const result = await toolManager.callTool({
  toolName: 'smart_code_review',
  parameters: { path: 'app.js' }
});

// 调用普通工具
const uuid = await toolManager.callTool({
  toolName: 'uuid',
  parameters: {}
});

// 获取工具信息
const tools = toolManager.getTools();
const smartTools = toolManager.getToolsByCategory('smart');
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

## 📖 文档

- [Git 工具文档](docs/git-tools.md) - 详细的Git工具使用指南
- [工具开发文档](docs/tool-development.md) - 如何开发自定义工具
- [智能工具文档](docs/smart-tools.md) - 智能工具的详细使用说明

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

### 贡献指南
1. Fork 项目
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 打开 Pull Request

## 📄 许可证

MIT License 

## Git 工具支持

Agent CLI 现在包含了完整的 Git 工具集合，支持：

- 📊 `git_status` - 查看仓库状态
- 📜 `git_log` - 查看提交历史  
- 🔍 `git_diff` - 查看文件差异
- 🌿 `git_branch` - 管理分支
- ➕ `git_add` - 添加文件到暂存区
- 💾 `git_commit` - 提交变更

更多详细信息请查看 [Git 工具文档](docs/git-tools.md)。 
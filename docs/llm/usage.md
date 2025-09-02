# LLM 使用指南

本 Agent CLI 工具集成了多个 LLM 服务提供商，支持千问（Qwen）和豆包（VolcEngine）等。

## 🎯 默认配置

基于测试验证，以下为推荐的默认配置：

### 千问（Qwen）
- **默认模型**: `qwen3-235b-a22b`
- **API 端点**: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- **特点**: 响应快速，适合日常问答

### 豆包（VolcEngine）
- **默认模型**: `ep-20250417144747-rgffm`
- **API 端点**: `https://ark.cn-beijing.volces.com/api/v3`
- **特点**: 回复详细，适合深度对话

## 🔧 快速开始

### 1. 环境配置

创建 `.env` 文件或设置环境变量：

```bash
# 千问配置
export QWEN_API_KEY="your-qwen-api-key"
export QWEN_DEFAULT_MODEL="qwen3-235b-a22b"

# 豆包配置
export VOLCENGINE_API_KEY="your-volcengine-api-key"
export VOLCENGINE_DEFAULT_MODEL="ep-20250417144747-rgffm"
```

或者复制配置示例文件：

```bash
cp config.env.example .env
# 然后编辑 .env 文件填入你的 API 密钥
```

### 2. 基础使用

使用默认配置（千问）：
```bash
bin/agent.js llm
```

指定提供商：
```bash
bin/agent.js llm --provider volcengine
```

### 3. 高级选项

```bash
# 指定模型
bin/agent.js llm --provider qwen --model qwen-plus-latest

# 启用流式输出
bin/agent.js llm --provider volcengine --stream

# 手动指定 API 密钥
bin/agent.js llm --provider qwen --api-key sk-xxx
```

## 📋 命令参考

### 聊天命令

```bash
bin/agent.js llm [options]
```

**选项：**
- `-p, --provider <provider>`: 选择提供商 (qwen|volcengine)，默认: qwen
- `-k, --api-key <key>`: 手动指定 API 密钥
- `-m, --model <model>`: 指定使用的模型
- `-s, --stream`: 启用流式输出

### 模型列表

```bash
bin/agent.js llm:models [options]
```

**选项：**
- `-p, --provider <provider>`: 选择提供商 (qwen|volcengine)，默认: qwen
- `-k, --api-key <key>`: 手动指定 API 密钥

## 🔌 API 使用

### 基础用法

```typescript
import { Agent, QwenLLM, VolcEngineLLM, getProviderConfig } from 'agent-cli';

// 使用默认配置
const config = getProviderConfig('qwen');
const llm = new QwenLLM({ apiKey: config.apiKey }, config.defaultModel);

// 初始化
await llm.init();

// 发送消息
const response = await llm.sendMessage('你好，请介绍一下自己');
console.log(response);
```

### 流式聊天

```typescript
// 流式输出
await llm.streamChat(
  {
    messages: [{ role: 'user', content: '讲个故事' }]
  },
  (chunk) => {
    process.stdout.write(chunk);
  }
);
```

### 多轮对话

```typescript
const messages = [
  { role: 'system', content: '你是一个专业的编程助手' },
  { role: 'user', content: '如何优化 JavaScript 性能？' }
];

const response = await llm.conversation(messages);
```

## 🎯 支持的模型

### 千问（Qwen）

#### 动态更新版本（Latest）
- `qwen-plus-latest` (通义千问-Plus-Latest，Qwen3)
- `qwen-turbo-latest` (通义千问-Turbo-Latest，Qwen3)

#### 快照版本（Snapshot）- Qwen3 系列
- `qwen3-235b-a22b` ⭐ (默认，测试验证)
- `qwen3-30b-a3b` (30B 参数版本)
- `qwen3-32b` (32B 参数版本)
- `qwen3-14b` (14B 参数版本)
- `qwen3-8b` (8B 参数版本)
- `qwen3-4b` (4B 参数版本)
- `qwen3-1.7b` (1.7B 参数版本)
- `qwen3-0.6b` (0.6B 参数版本)

#### 时间快照版本（Qwen3）
- `qwen-turbo-2025-04-28` (通义千问-Turbo 时间快照)
- `qwen-plus-2025-04-28` (通义千问-Plus 时间快照)

#### 兼容性别名
- `qwen-turbo` (指向 qwen-turbo-latest)
- `qwen-plus` (指向 qwen-plus-latest)

> **思考模式说明**: 所有 Qwen3 模型都支持 `enable_thinking` 参数：
> - 商业版模型默认值为 False
> - 开源版模型默认值为 True  
> - 工具会自动处理不同模型的参数要求
> - 所有模型都"实现思考模式和非思考模式的有效融合"

### 豆包（VolcEngine）
- `ep-20250417144747-rgffm` ⭐ (默认，测试验证)
- 其他自定义端点...

## ⚙️ 配置管理

### 环境变量优先级

1. 命令行参数 (`--api-key`, `--model`)
2. 环境变量 (`QWEN_API_KEY`, `VOLCENGINE_API_KEY`)
3. 默认配置（已配置测试成功的密钥）
4. 交互式输入

### 自定义配置

```typescript
import { DEFAULT_CONFIG, loadConfigFromEnv } from 'agent-cli';

// 查看默认配置
console.log(DEFAULT_CONFIG.llm.qwen);

// 从环境变量加载
const config = loadConfigFromEnv();
```

## 🔧 错误处理

工具内置了重试机制和错误处理：

- **自动重试**: 网络错误、超时等临时问题
- **指数退避**: 避免频繁请求
- **错误分类**: 区分可重试和不可重试的错误

## 💡 最佳实践

1. **生产环境**: 使用环境变量存储 API 密钥
2. **开发调试**: 启用 `--stream` 查看实时输出
3. **模型选择**: 
   - 默认使用 `qwen3-235b-a22b` (稳定版本，测试验证)
   - 最新功能使用 `qwen-turbo-latest` 或 `qwen-plus-latest`
   - 小型任务使用 `qwen3-8b` 或 `qwen3-4b` (节省成本)
   - 深度对话使用豆包
   - 需要特定时间点版本使用时间快照模型
4. **模型兼容性**: 工具会自动处理不同模型的 API 参数差异，无需手动配置

## 🚀 示例项目

查看 `examples/` 目录获取更多使用示例：

- `basic-chat.ts` - 基础聊天示例
- `stream-chat.ts` - 流式输出示例
- `multi-provider.ts` - 多提供商切换
- `agent-integration.ts` - Agent 框架集成

## 🐛 故障排除

### 常见问题

**Q: API 密钥无效？**
A: 检查密钥格式，千问以 `sk-` 开头，豆包为 UUID 格式

**Q: 连接超时？**
A: 检查网络连接，工具会自动重试

**Q: 模型不存在？**
A: 使用 `llm:models` 命令查看可用模型

**Q: 千问出现 "enable_thinking must be set to false" 错误？**
A: 已自动修复。Qwen3 模型支持思考模式，工具会根据模型类型自动设置 `enable_thinking` 参数。商业版默认 False，开源版默认 True，但某些场景需要强制设置为 False

**Q: 流式输出异常？**
A: 某些模型可能不支持流式输出，去掉 `--stream` 参数

需要更多帮助？查看项目的 GitHub Issues 或提交新的问题。 
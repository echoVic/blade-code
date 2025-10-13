# 🚀 Blade Code 快速开始指南

## 🎯 三步开始使用

### 步骤1：设置配置（任选其一）

#### 方式A：环境变量（推荐）
```bash
export QWEN_API_KEY="your-qwen-api-key"
export VOLCENGINE_API_KEY="your-volcengine-api-key"
```

#### 方式B：配置文件
```bash
cp config.env.example .env
# 编辑 .env 文件填入密钥
```

#### 方式C：命令行参数
```bash
blade --api-key your-api-key "你好"
```

### 步骤2：开始对话

```bash
# 单次问答
blade "你好，世界！"

# 交互式对话
blade

# 打印模式（适合管道操作）
blade --print "解释什么是TypeScript"

# 继续最近的对话
blade --continue

# 使用特定模型
blade --model qwen-max "复杂问题"
```

### 步骤3：安装（可选）

```bash
# 全局安装（推荐）
npm install -g blade-code

# 然后就可以使用了
blade "你好"

# 或者启动交互式界面
blade
```

## 📋 常用命令示例

```bash
# 基础使用
blade "什么是人工智能？"
blade "用Python写一个快速排序"

# 交互模式
blade

# 会话管理
blade --session-id "work" "我叫张三，是前端工程师"
blade --session-id "work" "你还记得我的职业吗？"

# 配置管理
blade config

# MCP相关命令
blade mcp
```

## 🛠️ API 密钥配置

**获取 API 密钥：**
- 千问: https://dashscope.console.aliyun.com/apiKey
- 火山引擎: https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey

**配置方式：**
```bash
# 方式1: 环境变量（推荐）
export QWEN_API_KEY="your-qwen-api-key"

# 方式2: 命令行参数
blade --api-key your-api-key "你好"

# 方式3: .env 文件
cp config.env.example .env
# 编辑 .env 文件填入密钥
```

## ✅ 验证安装

```bash
# 检查版本
blade --version

# 显示帮助
blade --help

# 快速测试
blade "请告诉我现在几点了？"

# 启动交互式模式
blade
```

## 🔄 智能工具调用

Blade 内置多种实用工具，通过自然语言即可调用：

```bash
# 智能处理示例
blade "审查我的 app.js 代码"
blade "查看当前git状态"
blade "现在几点了？"
blade "帮我分析项目结构"
```

## 🛡️ 安全确认机制

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

现在你已经准备好使用 Blade 了！
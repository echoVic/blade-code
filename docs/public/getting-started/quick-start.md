# 🚀 Blade Code 快速开始指南

## 🎯 三步开始使用

### 步骤1：启动 Blade

```bash
# 直接进入交互式界面
blade

# 零安装体验
npx blade-code
```

> **提示：** 如果未检测到 API Key，Blade 会自动弹出交互式设置向导，引导完成 provider、Base URL、API Key、模型配置。完成后即可立即继续对话。

### 步骤2：发送你的第一个问题

```bash
# 传入消息并自动发送（首条消息无需手动敲回车）
blade "帮我创建一个 React 组件"

# 打印模式（适合脚本和管道）
blade --print "解释什么是 TypeScript"

# 继续最近的对话会话
blade --continue

# 指定模型或其他选项
blade --model qwen-max --permission-mode autoEdit "帮我修复 lint 错误"
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
# 基础对话
blade "什么是人工智能？"
blade "用 Python 写一个快速排序"

# 交互模式（无参数启动）
blade

# 会话管理
blade --session-id "work" "我叫张三，是前端工程师"
blade --session-id "work" "你还记得我的职业吗？"

# 配置/诊断工具
blade config list
blade doctor

# MCP 相关命令
blade mcp list
```

## 🛠️ API 密钥配置

**获取 API 密钥：**
- 千问: https://dashscope.console.aliyun.com/apiKey
- 火山引擎: https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey

**配置方式：**
```bash
# 方式1: 环境变量（推荐）
export QWEN_API_KEY="your-qwen-api-key"

# 方式2: 首次启动设置向导（交互填写）
blade

# 方式3: 配置命令
blade config

# 方式4: 配置文件
mkdir -p ~/.blade
vim ~/.blade/config.json
# 或在项目中创建 .blade/config.json
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

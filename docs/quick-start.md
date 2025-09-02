# 🚀 Blade 快速开始指南

## 🎯 三步开始使用

### 步骤1：设置配置（任选其一）

#### 方式A：环境变量（推荐）
```bash
export BLADE_API_KEY="sk-你的API密钥"
export BLADE_BASE_URL="https://apis.iflow.cn/v1"
export BLADE_MODEL="Qwen3-Coder"
```

#### 方式B：用户配置文件
```bash
mkdir -p ~/.blade
echo '{
  "auth": {
    "apiKey": "sk-你的API密钥",
    "baseUrl": "https://apis.iflow.cn/v1",
    "modelName": "Qwen3-Coder"
  }
}' > ~/.blade/config.json
```

#### 方式C：命令行参数
```bash
blade chat -k "sk-你的API密钥" "你好"
```

### 步骤2：开始对话

```bash
# 单次问答
blade chat "你好，世界！"

# 交互式对话 (REPL模式)
blade chat -i
# 或者直接运行
blade

# 系统提示词
blade chat -s "你是一个代码助手" "帮我写一个Python冒泡排序"

# 流式输出
blade chat --stream "详细解释量子计算原理"
```

### 步骤3：项目配置（可选）

```bash
# 创建项目配置文件
echo '{
  "auth": {
    "modelName": "Qwen3-Coder-Project"
  },
  "ui": {
    "theme": "dark"
  },
  "security": {
    "sandbox": "none"
  }
}' > .blade.json
```

## 📋 常用命令示例

```bash
# 基础使用
blade chat "什么是人工智能？"
blade chat "用Python写一个快速排序"

# 交互模式
blade chat -i
# 或
blade

# 查看配置
blade config show

# 设置配置
blade config set auth.modelName "new-model"

# 列出可用工具
blade tools list

# 执行工具
blade tools exec git.status

# MCP相关命令
blade mcp list
```

## 🛠️ 配置文件结构

### 用户配置（私有）
```json
~/.blade/config.json
{
  "auth": {
    "apiKey": "sk-xxx",           # API密钥
    "baseUrl": "https://api.com", # 基础URL
    "modelName": "model-name"     # 模型名称
  }
}
```

### 项目配置（可共享）
```json
./.blade.json
{
  "auth": {
    "modelName": "Qwen3-Coder-Project"
  },
  "ui": {
    "theme": "dark"
  },
  "security": {
    "sandbox": "none"
  },
  "usage": {
    "usageStatisticsEnabled": true
  }
}
```

## ✅ 验证安装

```bash
# 检查版本
blade --version

# 显示帮助
blade --help

# 快速测试
blade chat "请告诉我现在几点了？"

# 启动交互式模式
blade
```

## 🔄 交互式 REPL 模式

Blade 的交互式模式提供了一个功能丰富的对话环境：

```bash
# 启动 REPL
blade
# 或
blade chat -i

# REPL 中的内置命令:
# /help - 显示帮助
# /clear - 清除会话历史
# /config - 显示当前配置
# /tools - 列出可用工具
# /exit 或 /quit - 退出

# 快捷键:
# ↑/↓ - 命令历史导航
# Ctrl+C - 退出
# Ctrl+L - 清屏
```

## 🔧 工具系统使用

```bash
# 在 REPL 中使用工具
> /tools git.status
> /tools git.diff --file src/index.ts
> /tools fs.readFile --path package.json
```

## 🎨 主题和外观

```bash
# 设置主题
blade config set ui.theme dark

# 可用主题:
# - dark (默认)
# - light
# - GitHub
# - auto (自动)
```

## 🔒 安全配置

```bash
# 启用沙箱模式 (需要 Docker)
blade config set security.sandbox docker

# 禁用沙箱
blade config set security.sandbox none
```

现在你已经准备好使用 Blade 了！
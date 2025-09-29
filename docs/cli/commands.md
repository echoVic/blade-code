# 📋 Blade 命令参考

## 🎯 核心命令

### `blade chat` - 智能对话
```bash
# 基础对话
blade chat "你好"

# 使用系统提示词
blade chat -s "你是一个代码助手" "写个Python排序"

# 交互式对话 (REPL 模式)
blade chat -i

# 流式输出
blade chat --stream "详细解释AI原理"
```

**参数**:
- `-k, --api-key <key>` - API密钥
- `-u, --base-url <url>` - 基础URL
- `-m, --model <name>` - 模型名称
- `-s, --system <prompt>` - 系统提示词
- `-i, --interactive` - 交互式模式 (REPL)
- `--stream` - 流式输出

### `blade config` - 配置管理
```bash
# 查看配置
blade config show

# 设置配置项
blade config set apiKey "sk-xxx"

# 验证配置
blade config validate
```

### `blade tools` - 工具管理
```bash
# 列出所有可用工具
blade tools list

# 执行特定工具
blade tools exec git.status

# 搜索工具
blade tools search "git"
```

### `blade mcp` - MCP 协议管理
```bash
# 启动 MCP 服务器
blade mcp start

# 连接 MCP 服务器
blade mcp connect --name server1

# 列出已连接的 MCP 服务器
blade mcp list
```

## 🔄 交互式 REPL 模式

Blade 的交互式模式提供了一个功能丰富的 REPL 环境：

```bash
# 启动 REPL 模式
blade chat -i
# 或
blade

# 在 REPL 中可用的命令:
# /help - 显示帮助信息
# /clear - 清除会话历史
# /config - 显示当前配置
# /tools - 列出可用工具
# /exit - 退出 REPL
# /quit - 退出 REPL
```

### REPL 快捷键
- `↑`/`↓` - 命令历史导航
- `Ctrl+C` - 退出 REPL
- `Ctrl+L` - 清屏
- `Tab` - 自动补全（未来支持）

## ⚙️ 配置方式

### 1. 环境变量
```bash
export BLADE_API_KEY="sk-xxx"
export BLADE_BASE_URL="https://api.example.com"
export BLADE_MODEL="qwen3-coder"
```

### 2. 配置文件

**用户配置文件** (`~/.blade/config.json`):
```json
{
  "auth": {
    "apiKey": "sk-xxx",
    "baseUrl": "https://api.example.com",
    "modelName": "qwen3-coder"
  },
  "ui": {
    "theme": "dark",
    "hideTips": false
  },
  "security": {
    "sandbox": "none"
  }
}
```

**项目配置文件** (`./.blade.json`):
```json
{
  "auth": {
    "modelName": "qwen3-coder-specific"
  },
  "ui": {
    "theme": "light"
  }
}
```

### 3. CLI参数
```bash
blade chat -k "sk-xxx" -u "https://api.example.com" -m "qwen3-coder" "你好"
```

## 📊 配置优先级

Blade 使用分层配置系统，配置项按以下优先级从高到低应用：

```
CLI参数 > 环境变量 > 项目配置文件 > 用户配置文件 > 默认值
```

## 🚀 快速验证

```bash
# 检查版本
blade --version

# 显示帮助
blade --help

# 快速测试
blade chat "现在几点了？"

# 启动交互式模式
blade
```

## 🛠️ 工具使用示例

### Git 工具
```bash
# 在 REPL 中使用 Git 工具
> /tools git.status
> /tools git.diff --file src/index.ts
```

### 文件系统工具
```bash
# 读取文件内容
> /tools fs.readFile --path package.json

# 写入文件
> /tools fs.writeFile --path output.txt --content "Hello World"
```

## 🔧 MCP 集成示例

### 配置 MCP 服务器
在配置文件中添加 MCP 服务器配置：

```json
{
  "mcp": {
    "mcpServers": {
      "local-server": {
        "command": "node",
        "args": ["server.js"],
        "env": {
          "PORT": "3000"
        }
      }
    }
  }
}
```

### 使用 MCP 服务器
```bash
# 启动 MCP 服务器
blade mcp start --name local-server

# 连接 MCP 服务器
blade mcp connect --name local-server

# 列出已连接的服务器
blade mcp list
```

## 📊 遥测和监控

### 启用遥测
```bash
# 通过配置启用遥测
blade config set telemetry.enabled true
blade config set telemetry.target local
```

### 查看遥测数据
```bash
# 查看使用统计
blade telemetry stats

# 查看性能指标
blade telemetry perf

# 导出遥测数据
blade telemetry export --format json --output telemetry.json
```

## 🎨 主题和外观

### 内置主题
- `dark` - 深色主题（默认）
- `light` - 浅色主题
- `GitHub` - GitHub 风格主题
- `auto` - 自动根据系统设置切换

### 配置主题
```bash
# 通过 CLI 设置主题
blade config set ui.theme light

# 通过环境变量设置主题
export BLADE_THEME=dark

# 在 REPL 中临时更改主题
> /config set ui.theme GitHub
```

## 🔒 安全配置

### 沙箱模式
```bash
# 启用 Docker 沙箱
blade config set security.sandbox docker

# 禁用沙箱
blade config set security.sandbox none
```

### 安全确认
某些危险操作需要用户确认：
```bash
# 删除文件操作会提示确认
> /tools fs.delete --path important-file.txt
⚠️  确认删除文件 important-file.txt? (y/N)
```

## 📈 使用统计

### 启用使用统计
```bash
blade config set usage.usageStatisticsEnabled true
blade config set usage.maxSessionTurns 100
```

### 查看使用情况
```bash
# 查看会话统计
blade usage sessions

# 查看工具使用情况
blade usage tools

# 查看模型使用情况
blade usage models
```
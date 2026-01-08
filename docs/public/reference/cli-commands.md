# 📋 CLI 命令参考

本文档详细说明 Blade Code 的所有命令行选项和子命令。

## 默认入口

```bash
# 启动交互式界面
blade

# 启动时发送初始消息
blade "帮我创建一个 README"
```

无子命令时启动 Ink 界面。若未配置模型，会自动进入模型配置向导。

## 全局选项

### 调试选项

| 选项 | 别名 | 说明 |
|------|------|------|
| `--debug [filters]` | `-d` | 启用调试日志，支持分类过滤 |

调试分类过滤示例：
```bash
# 只显示 agent 和 ui 日志
blade --debug "agent,ui"

# 排除 chat 和 loop 日志
blade --debug "!chat,!loop"
```

支持的分类：`agent`, `ui`, `tool`, `service`, `config`, `context`, `execution`, `loop`, `chat`, `general`

### 输出选项

| 选项 | 别名 | 说明 |
|------|------|------|
| `--print` | `-p` | 打印模式，输出结果后退出 |
| `--output-format <format>` | | 输出格式：`text` / `json` / `stream-json` |
| `--include-partial-messages` | | 包含流式消息片段 |

### 输入选项

| 选项 | 说明 |
|------|------|
| `--input-format <format>` | 输入格式：`text` / `stream-json` |
| `--replay-user-messages` | 从 stdin 重放用户消息 |

### 安全选项

| 选项 | 说明 |
|------|------|
| `--permission-mode <mode>` | 权限模式：`default` / `autoEdit` / `yolo` / `plan` |
| `--yolo` | 等同于 `--permission-mode=yolo` |
| `--allowed-tools <tools>` | 允许的工具列表（逗号或空格分隔） |
| `--disallowed-tools <tools>` | 禁用的工具列表 |
| `--add-dir <dirs>` | 额外允许访问的目录 |

### 会话选项

| 选项 | 别名 | 说明 |
|------|------|------|
| `--continue` | `-c` | 继续最近的会话 |
| `--resume [id]` | `-r` | 恢复指定会话（无参数时交互选择） |
| `--fork-session` | | 恢复时创建新会话 ID |
| `--session-id <id>` | | 指定会话 ID |

### AI 选项

| 选项 | 说明 |
|------|------|
| `--system-prompt <prompt>` | 替换系统提示词 |
| `--append-system-prompt <prompt>` | 追加系统提示词 |
| `--max-turns <n>` | 对话轮次限制（-1: 无限, 0: 禁用, N: 限制） |

### MCP 选项

| 选项 | 说明 |
|------|------|
| `--mcp-config <config>` | 从 JSON 文件或字符串加载 MCP 服务器 |
| `--strict-mcp-config` | 仅使用 --mcp-config 指定的服务器 |

### 集成选项

| 选项 | 说明 |
|------|------|
| `--ide` | 启动时自动连接 IDE |
| `--acp` | 以 ACP (Agent Client Protocol) 模式运行 |

## 打印模式

使用 `-p` 或 `--print` 进入打印模式，不启动 UI：

```bash
# 直接输出结果
blade --print "解释什么是 TypeScript"

# 管道输入
echo "请总结这段文字" | blade -p

# JSON 输出
blade -p --output-format json "生成一个函数"

# 流式 JSON 输出
blade -p --output-format stream-json "写一段代码"
```

## 子命令

### blade doctor

环境自检，检查配置加载、Node 版本、目录权限等。

```bash
blade doctor
```

返回码：成功返回 0，失败返回 1。

### blade update

检查并显示当前版本信息。

```bash
blade update
```

### blade install

安装指定版本（占位实现）。

```bash
blade install [stable|latest] [--force]
```

### blade mcp

管理 MCP 服务器。

#### mcp list / mcp ls

列出已注册的 MCP 服务器。

```bash
blade mcp list
```

#### mcp add

添加 MCP 服务器。

```bash
blade mcp add <name> <cmdOrUrl> [args...]
```

选项：
- `--transport <type>`: 传输类型（stdio / http / sse）
- `--env KEY=VAL`: 环境变量
- `--header "K: V"`: HTTP 头
- `--timeout <ms>`: 超时时间

示例：
```bash
# 添加 GitHub MCP 服务器
blade mcp add github -- npx -y @modelcontextprotocol/server-github

# 添加带环境变量的服务器
blade mcp add myserver --env API_KEY=xxx -- node server.js

# 添加 HTTP 服务器
blade mcp add api --transport http https://api.example.com/mcp
```

#### mcp add-json

直接传入 JSON 配置。

```bash
blade mcp add-json <name> '<json>'
```

示例：
```bash
blade mcp add-json api '{"type":"http","url":"https://api.example.com"}'
```

#### mcp remove / mcp rm

移除 MCP 服务器。

```bash
blade mcp remove <name>
```

#### mcp get

获取单个服务器配置。

```bash
blade mcp get <name>
```

#### mcp reset-project-choices

清除项目级 MCP 批准/拒绝记录。

```bash
blade mcp reset-project-choices
```

## 交互界面

### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+C` | 中断当前任务 |
| `Ctrl+D` | 退出程序 |
| `Ctrl+L` | 清屏 |
| `Ctrl+T` | 展开/折叠思维链 |
| `Esc` | 关闭建议/中断执行 |
| `Shift+Tab` | 循环切换权限模式 |
| `↑` / `↓` | 历史命令导航 |
| `Tab` | 自动补全 |

### 输入触发

- `/` 开头：触发 Slash 命令补全
- `@` 开头：触发文件路径补全

## 使用示例

```bash
# 基本使用
blade "帮我重构这个函数"

# 打印模式（脚本集成）
git diff | blade --print --append-system-prompt "请给出代码审查建议"

# Plan 模式启动
blade --permission-mode plan

# 恢复历史会话
blade --resume

# 指定会话 ID 恢复
blade --resume 2024-12-foo-session

# 调试模式
blade --debug agent "分析这段代码"

# 完全自动模式
blade --yolo "修复所有 TypeScript 错误"
```

## 环境变量

Blade Code 支持通过环境变量配置：

| 变量 | 说明 |
|------|------|
| `BLADE_DEBUG` | 启用调试模式 |
| `BLADE_CONFIG_DIR` | 自定义配置目录 |
| `NO_COLOR` | 禁用颜色输出 |

## 退出码

| 退出码 | 说明 |
|--------|------|
| 0 | 成功 |
| 1 | 一般错误 |
| 130 | 用户中断 (Ctrl+C) |

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
| `--fork-session` | | 与 `--resume`/`--continue` 配合，将历史复制到独立子会话，父会话保持不变 |
| `--session-id <id>` | | 指定新会话 ID；与恢复参数同时使用时必须启用 `--fork-session` |

### AI 选项

| 选项 | 说明 |
|------|------|
| `--settings <file-or-json>` | 为当前进程加载临时设置；显式 CLI 参数优先 |
| `--system-prompt <prompt>` | 替换系统提示词 |
| `--append-system-prompt <prompt>` | 追加系统提示词 |
| `--max-turns <n>` | 对话轮次限制（-1: 无限, 0: 禁用, N: 限制） |
| `--agents <json>` | 为本次运行注入自定义 Subagents，CLI 定义优先级最高 |

`--settings` 支持文件路径和内联 JSON。文件路径相对于启动 Blade 时的工作目录解析；无效 JSON、未知字段和类型错误会导致启动失败。该选项适用于 CLI/TUI、print 和 headless，不会持久化配置。

`--agents` 接受以 agent 名称为键的内联 JSON，适用于 CLI/TUI、print 和 headless，不会写入用户或项目配置：

```bash
blade --agents '{"reviewer":{"description":"Review code changes","prompt":"Find correctness risks and run tests.","tools":["Read","Grep","Bash"],"maxTurns":6}}'
```

定义必须包含 `description` 和 `prompt`；未知字段、无效类型或格式错误会导致启动失败。完整字段说明见 [Subagents 指南](../guides/subagents.md)。

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

### blade web（0.2.0 新增）

启动 Web UI 服务器并自动打开浏览器。

```bash
blade web [options]
```

**选项**：

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--port <port>` | 监听端口（0 为自动选择） | `0` |
| `--hostname <host>` | 监听主机名 | `127.0.0.1` |
| `--cors <domains>` | 额外允许的 CORS 域名 | `[]` |

**示例**：

```bash
# 默认启动（自动选择端口，打开浏览器）
blade web

# 指定端口
blade web --port 3000

# 允许局域网访问
blade web --hostname 0.0.0.0 --port 3000
```

**安全提示**：设置 `BLADE_SERVER_PASSWORD` 环境变量可启用 Basic Auth 认证。

### blade serve（0.2.0 新增）

启动无头 Web 服务器（不打开浏览器），适合远程访问或集成场景。

```bash
blade serve [options]
```

**选项**：与 `blade web` 相同。

**示例**：

```bash
# 启动无头服务器
blade serve --port 3000 --hostname 0.0.0.0

# 带认证启动
BLADE_SERVER_PASSWORD=secret blade serve --port 3000
```

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

### 会话 Slash 命令

#### `/resume [sessionId]`

恢复历史会话。不带 ID 时打开会话选择器。

```bash
# 交互选择历史会话
/resume

# 恢复已知会话
/resume parent-session-id
```

#### `/fork [sessionId]`

从当前工作区的 durable session 创建独立子会话。不带 ID 时打开会话选择器；
选择器不会显示 subagent session。已知 ID 必须属于当前工作区且不能是 subagent
session。Agent 正在处理当前回合时，`/fork` 会被拒绝，不会转向或中止活动回合。

```bash
# Pick a source interactively
/fork

# Fork a known durable session
/fork parent-session-id
```

fork 只复制源会话在边界前已提交的 conversation history：父会话保持不变，子会话
沿用源 workspace，并等待下一条 user prompt。它不会倒回或复制 workspace 文件，也不会
创建 Git branch；需要文件隔离时应另外使用 Git worktree 或 branch。

#### `/branch`

将当前活动会话的已提交历史复制到独立子会话，并立即切换过去。它不接受源
session ID；需要从历史会话选择源时使用 `/fork [sessionId]`。ACP 调用 `/branch`
后会返回可由标准 `session/load` 加载的子会话 ID。

### Web Sidebar Fork

Web Sidebar 的 session 行提供 **Fork** 操作。服务器创建 child 后，Web 会先准备该 child
的 SSE 订阅，再以 `sessionId + projectPath` 的 compound workspace identity 原子激活
child，避免同名 session 或迟到事件切换错误。新 child 已继承已提交历史并等待
下一条 prompt；Fork 不会创建或复制 task dashboard。

### ACP session discovery and fork

ACP SDK 0.12 将 `session/list` 和 `session/fork` 暴露为 unstable wire capabilities；
TypeScript agent 实现对应的 `unstable_listSessions` 和 `unstable_forkSession` 方法。
`session/fork` 返回的 child 已初始化并可立即接收 prompt，无需再调用 `session/load`。
fork 响应不会 replay history；只有显式 `session/load` 使用历史回放协议。

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

# 从历史创建独立子会话（TUI、print、headless 均支持）
blade --resume 2024-12-foo-session --fork-session --session-id experiment-1

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

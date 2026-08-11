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

# 直接在 Session workspace 执行，不调用模型
blade -p '! pwd'
blade -p --output-format stream-json '! npm test'
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

OAuth server 使用标准 discovery，不在配置中写 token、client secret 或 endpoint：

```bash
blade mcp add-json remote \
  '{"type":"http","url":"https://mcp.example.com/rpc","oauth":{"enabled":true,"scopes":["mcp:tools"]}}'
blade mcp login remote
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

#### mcp login / logout

显式启动 OAuth browser flow，或清除该 endpoint/client/scopes 身份的凭证。普通
`mcp list`、连接和 Session 启动不会隐式打开浏览器。

```bash
blade mcp login <name>
blade mcp logout <name>
```

TUI 对应 `/mcp login <name>` 和 `/mcp logout <name>`；headless 与 ACP 会拒绝宿主
OAuth 交互。完整安全契约见 [MCP OAuth 生命周期](mcp-oauth-lifecycle.md)。

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
- `!` 开头：在当前 Session workspace 执行用户 shell command，不调用模型

`! <command>` 使用 Session 冻结的 cwd/env，结果进入 durable history。活动 Agent
回合期间会作为 persisted auxiliary steering 注入下一次安全 provider boundary。
TUI 显示黄色 `$` prompt；Web 显示结构化 command card；ACP 使用 IDE terminal 且
不可用时不会回退宿主 shell。详见
[Session-owned User Shell Command](session-user-shell-command.md)。

TUI 支持标准 bracketed paste、IME/batched multi-character input 和 CRLF 规范化；
启动和退出时会成对启用/恢复 terminal paste mode，并过滤独立 focus CSI。详见
[TUI Terminal Input](tui-terminal-input.md)。

### 会话 Slash 命令

#### `/effort [level]`

查看或切换当前 Session 的推理强度：

```bash
/effort
/effort auto
/effort off
/effort minimal
/effort low
/effort medium
/effort high
/effort xhigh
/effort max
```

显式级别必须由当前模型支持；`auto` 保持为 durable 策略并在 Provider 创建时解析
effective level。活动回合期间拒绝切换，Runtime 替换或 metadata 写入失败时保持或
恢复原 model/effort/tier/verbosity/style 五元设置。详见
[Session Reasoning Effort](session-reasoning-effort.md)。

#### `/speed [tier]` 与 `/fast [on|off]`

查看或切换当前 Session 的 Provider 服务等级：

```bash
/speed
/speed auto
/speed standard
/speed fast
/speed flex
/fast
/fast on
/fast off
```

`auto` 不覆盖 Provider 默认值；`standard`、`fast` 与 `flex` 是显式价格/延迟
语义，模型不支持时 fail closed。`/fast on` 选择 `fast`，`/fast off` 选择
`standard`。活动回合期间拒绝切换，Runtime 替换或 metadata 写入失败时保持或恢复
原 model/effort/tier/verbosity/style 五元设置。详见
[Session Service Tier](session-service-tier.md)。

#### `/verbosity [level]` 与 `/detail [level]`

查看或切换当前 Session 的 Provider 原生响应详略：

```bash
/verbosity
/verbosity auto
/verbosity low
/verbosity medium
/verbosity high
/detail high
```

`auto` 不覆盖 Provider 默认值；显式 `low`、`medium` 与 `high` 必须由当前模型支持。
`/detail` 是完整别名。活动回合期间拒绝切换，Runtime 替换或 metadata 写入失败时保持
或恢复原 model/effort/tier/verbosity/style 五元设置。详见
[Session Response Verbosity](session-response-verbosity.md)。

#### `/style [name]` 与 `/personality [name]`

查看或切换当前 Session 的沟通风格：

```bash
/style
/style auto
/style pragmatic
/style friendly
/style explanatory
/style project:review:strict
/personality friendly
```

风格只控制语气和解释框架，与 Provider 原生 `responseVerbosity` 正交。
`/personality` 是完整别名。活动回合期间拒绝切换；metadata 写入失败时恢复之前的
五元 Session 设置。详见
[Session Communication Style](session-communication-style.md) 和
[Trusted Custom Output Styles](trusted-output-styles.md)。

#### `/review [target]`

启动独立只读 reviewer：

```bash
/review
/review uncommitted
/review base main
/review commit HEAD
```

`/git review` 等同 `/review uncommitted`。reviewer 使用独立 Session、diff digest、
结构化 P0-P3 findings 与 workspace-read-only sandbox；不会修复或修改被审查代码。
详见 [Native Read-Only Code Review](native-code-review.md)。

#### `/resume [sessionId]`

恢复历史会话。不带 ID 时打开会话选择器。

若 Session 在权限确认、`AskUserQuestion` 或 MCP 输入期间退出，TUI resume 会先恢复
原交互再继续 durable inbox。print/headless 无法收集交互输入，会 fail closed 地拒绝
请求并让模型基于恢复结果继续。完整契约见
[Durable Pending Interactions](durable-pending-interactions.md)。

```bash
# 交互选择历史会话
/resume

# 恢复已知会话
/resume parent-session-id
```

#### `/archive [sessionId]` 与 `/unarchive <sessionId>`

无参 `/archive` 释放当前 TUI 的 idle Runtime、归档当前 Session 并退出。指定 ID 时
归档另一个未被 CLI/Web/ACP owner 占用的 Session tree。恢复必须指向直接归档根：

```bash
/archive
/archive parent-session-id
/unarchive parent-session-id
```

归档保留 transcript 和所有任务/lineage 证据，并使该 Session 及其后代退出默认
catalog。queued/running 后代、活动 turn 或任一 Session lease 会使整次操作 fail
closed。详见 [Durable Session Archive](session-archive.md)。

#### `/export [path] [--reasoning]`

从当前 Session 的稳定 JSONL 快照导出 materialized Markdown：

```bash
/export
/export reports/conversation.md
/export --reasoning
```

默认包含 user/assistant、图片标签、summary 和清理后的 activity；reasoning 需要显式
opt-in。输出使用 `0600` exclusive create，不覆盖已有文件。ACP `/export` 返回 bounded
inline Markdown，不接受宿主 path。详见
[Portable Session Markdown Export](session-markdown-export.md)。

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
模型配置和权限模式也按 fork 边界继承；显式 `--permission-mode` 仍高于继承值。详见
[Session Permission Mode](session-permission-mode.md)。

#### `/branch`

将当前活动会话的已提交历史复制到独立子会话，并立即切换过去。它不接受源
session ID；需要从历史会话选择源时使用 `/fork [sessionId]`。ACP 调用 `/branch`
后会返回可由标准 `session/load` 加载的子会话 ID。

#### `/rewind [checkpointId]`

不带参数时列出当前 session 的 durable user-turn checkpoints。指定 checkpoint
后默认只回退 conversation；加 `--code` 同时恢复该回合及之后的文件修改，
加 `--code-only` 只恢复文件并保留 conversation。

```bash
# 列出可回退的用户回合
/rewind

# 只回退 conversation
/rewind <checkpointId>

# 同时回退 conversation 和代码
/rewind <checkpointId> --code

# 只恢复代码
/rewind <checkpointId> --code-only

# 兼容旧的单文件最近一次编辑回退
/rewind file src/example.ts
```

rewind 只允许在 session idle 且 durable input 队列为空时执行；存在运行中的
后台 shell 或后台 agent 时也会拒绝。文件在 Blade 编辑后被外部修改时，代码恢复
整组 fail closed，不覆盖用户的新改动。

#### `/tasks [clean | resume <agentId> <prompt>]`

列出当前 `sessionId + projectPath` 拥有的后台 Shell 与 Subagents，并显示 agent
lineage。`resume` 从已结束的 agent 创建新的 durable child run：

```bash
/tasks
/tasks resume agent-source-id 检查修复并运行相关测试
/tasks clean
```

恢复不会修改源运行。child 继承源 transcript、模型、权限、工具、系统提示和隔离
配置，并记录新的 agent ID、`resumedFrom`、`rootAgentId` 和 `resumeDepth`。
活动 parent turn 或 durable pending input 存在时，恢复会 fail closed。

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

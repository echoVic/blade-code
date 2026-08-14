# 🧰 工具列表

本文档列出 Blade Code 所有内置工具及其参数说明。工具通过 `ToolKind` 分类（ReadOnly / Write / Execute），影响权限模式的判定。

## 文件操作

### Read

读取文件内容，支持文本、图片、PDF、Jupyter Notebook。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file_path` | string | ✅ | 文件绝对路径 |
| `offset` | number | | 起始行号（从 1 开始） |
| `limit` | number | | 读取行数（默认 2000） |
| `encoding` | string | | 文件编码（默认 utf-8） |

**类型**: ReadOnly
**返回**: 带行号的文件内容

### Write

写入或创建文件。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file_path` | string | ✅ | 文件绝对路径 |
| `content` | string | ✅ | 文件内容 |
| `encoding` | string | | 文件编码（默认 utf-8） |
| `mode` | string | | 写入模式：overwrite / append |
| `mkdirs` | boolean | | 是否自动创建目录 |

**类型**: Write
**特性**: 支持备份、权限检查、目录自动创建

### Edit

执行精确字符串替换。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file_path` | string | ✅ | 文件绝对路径 |
| `old_string` | string | ✅ | 要替换的字符串（不能为空） |
| `new_string` | string | ✅ | 替换后的字符串（可以为空） |
| `replace_all` | boolean | | 是否替换所有匹配（默认仅替换第一个） |

**类型**: Write  
**特性**: 支持回滚、预览、并发文件锁  
**注意**: 使用前必须先用 Read 工具读取文件

### ApplyPatch

使用严格的 Codex-style patch grammar 原子修改多个 UTF-8 文本文件。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `patch` | string | ✅ | 完整的 `*** Begin Patch` / `*** End Patch` 文档 |

支持 `Add File`、`Update File`、`Delete File`、`Move to`、多 hunk、semantic locator
和 `End of File`。路径必须相对 workspace。

**类型**: Write
**特性**: 完整 preflight、canonical containment、多路径锁、staging/backup、
fsync、失败全量 rollback、Session Snapshot、LSP/Hook/AutoVerify 多文件集成
**ACP**: 远端 filesystem 仅支持带 read-back 和补偿回滚的多文件 Update；协议没有
delete/rename 时 Add/Delete/Move fail closed
**详情**: [Atomic ApplyPatch](atomic-apply-patch.md)

### NotebookEdit

编辑 Jupyter Notebook 文件。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file_path` | string | ✅ | .ipynb 文件路径 |
| `content` | string | ✅ | Notebook 内容 |

**类型**: Write  
**特性**: 保持 JSON 结构完整性

## 搜索工具

### Glob

使用 glob 模式查找文件。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `pattern` | string | ✅ | glob 匹配模式 |
| `cwd` | string | | 搜索目录（默认当前目录） |
| `ignore` | string[] | | 忽略的模式列表 |
| `limit` | number | | 结果数量限制 |

**类型**: ReadOnly  
**特性**: 基于 fast-glob，内置忽略 node_modules 等常见目录

### Grep

基于 ripgrep 的内容搜索。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `pattern` | string | ✅ | 搜索正则表达式 |
| `path` | string | | 搜索路径 |
| `glob` | string | | 文件过滤模式 |
| `context` | number | | 上下文行数 |
| `ignore_case` | boolean | | 忽略大小写 |
| `max_count` | number | | 最大匹配数 |

**类型**: ReadOnly  
**特性**: 四级智能降级（ripgrep → git grep → system grep → JS fallback）

## Shell 命令

### Bash

执行 Shell 命令。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | string | ✅ | 要执行的命令 |
| `cwd` | string | | 工作目录 |
| `env` | object | | 环境变量 |
| `run_in_background` | boolean | | 后台运行（适用于长时间运行的命令） |
| `timeout` | number | | 超时时间（毫秒，默认 30000） |

**类型**: Execute
**返回**: 后台运行时返回 `bash_id` 和 `shell_id`，可用于 WriteStdin、KillShell 或 TaskOutput
**前台输出边界**: 本地 stdout/stderr 各保留最近 1 MiB 原始字节；ACP remote terminal
按 merged stdout 保留最近 1 MiB，且不会在 terminal 不可用时回退宿主执行。模型可见
结果继续按命令类型截断，并返回：

- `output_truncated`：capture 或模型投影任一层发生截断；
- `stdout_total_bytes` / `stderr_total_bytes`：完整累计字节，accounting 不完整时为下界；
- `stdout_omitted_bytes` / `stderr_omitted_bytes`：capture 丢弃的最早字节；
- `output_accounting_complete`：累计统计是否完整；
- `terminal_output_merged`：ACP terminal 合并 stdout/stderr 时为 `true`；
- `truncation_info`：明确说明省略最早输出并展示 retained tail。

Tool metadata 另包含每流 retained bytes、projection flags 和
`terminal_transport=local|acp|local_fallback`。TUI、Headless、Web 与 ACP 使用同一
有界展示；原始 command output 不作为 progress 事件发送。

### WriteStdin

向当前 session 拥有的后台 Bash 进程写入标准输入。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `shell_id` | string | ✅ | Bash 返回的后台 Shell ID |
| `data` | string | ✅ | 原样写入的文本；行式程序需要显式包含换行符 |
| `close_stdin` | boolean | | 写入后关闭 stdin，让等待 EOF 的进程继续退出 |

**类型**: Execute  
**安全边界**: 仅能操作当前 session 的 Shell；单次输入最多 64 KiB；跨 session 与已清理 ID 统一按未找到处理

### KillShell

终止后台运行的命令。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `shell_id` | string | ✅ | Bash 返回的后台会话 ID |
| `signal` | string | | 终止信号（默认 SIGTERM） |

**类型**: Execute

## 网络工具

### WebFetch

获取网页或 API 内容，支持 Jina Reader 内容提取。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | ✅ | 请求 URL |
| `method` | string | | HTTP 方法（默认 GET） |
| `headers` | object | | 请求头 |
| `body` | string | | 请求体 |
| `trim` | boolean | | 是否裁剪响应 |
| `extract_content` | boolean | | 使用 Jina Reader 提取干净内容 |

**类型**: ReadOnly  
**特性**: 支持 Jina Reader 提取网页内容为干净的 Markdown 格式

### WebSearch

网络搜索，支持多提供商自动故障转移（Exa → DuckDuckGo → SearXNG）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | ✅ | 搜索关键词 |
| `site` | string | | 限定站点 |
| `language` | string | | 语言偏好 |
| `region` | string | | 地区偏好 |

**类型**: ReadOnly  
**返回**: 搜索结果摘要  
**特性**: 使用 Exa MCP 公开端点，无需 API key，自动故障转移

## Code Intelligence

### LSP

通过当前 Session 私有的 Language Server 查询语义代码信息。该工具默认 deferred，
先使用 `ToolSearch` 加载 schema。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `operation` | string | ✅ | definition、references、hover、symbols、implementation、call hierarchy 或 diagnostics |
| `filePath` | string | ✅ | 当前 Session workspace 内的绝对文件路径 |
| `line` | number | | 1-based 行号 |
| `character` | number | | 1-based 字符位置 |
| `query` | string | | `workspaceSymbol` 搜索文本 |

**类型**: ReadOnly
**安全边界**: 只访问 Session workspace；服务器按 Workspace Trust 配置并由 Session
独占；ACP remote session 不启动本地 LSP。

## 任务管理

### Task

启动子代理执行任务。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `subagent_type` | string | 新任务必填 | 子代理类型；resume 时省略或与源类型一致 |
| `description` | string | ✅ | 3-100 字符的简短描述 |
| `prompt` | string | ✅ | 至少 10 字符的详细任务指令 |
| `run_in_background` | boolean | | 后台运行；默认 `false` |
| `isolation` | string | | `none` 或 `worktree` |
| `resume_from` | string | | 要继续的已结束 agent ID |
| `resume` | string | | `resume_from` 的 deprecated alias |

**类型**: ReadOnly  
**特性**: 使用 `.blade/agents` 或 `~/.blade/agents` 中的配置。foreground 与
background 运行都会持久化；每次 resume 创建新的不可变 child ID，并冻结继承源运行的
模型、权限、工具、系统提示、workspace 和隔离配置。结果中的
`resume_from_hint` 可直接用于下一次 follow-up。

**Lineage**: 返回和持久化 `resumed_from`、`root_agent_id`、`resume_depth`。
读取和恢复按 `parent sessionId + projectPath` 隔离，跨 workspace ID 按不存在处理。

**后台完成通知**: `run_in_background=true` 返回 running 结果后，parent 可以继续独立
工作。child 进入终态时 Blade 会持久化 hidden completion receipt 并自动恢复 parent；
不需要重复轮询 `TaskOutput`。通知结果最多 32,000 字符、error 最多 8,000 字符；
通知明确标记截断时，可用 `TaskOutput` 读取完整 durable result。

### TaskOutput

获取后台任务的输出。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task_id` | string | ✅ | 任务 ID |

**类型**: ReadOnly
**输出边界**: 后台 Shell 的 stdout/stderr 各保留最近 1 MiB；模型和 TUI/Web/ACP 事件中的文本会继续按命令类型截断并保留头尾。返回值通过 `output_truncated`、`stdout_omitted_bytes`、`stderr_omitted_bytes` 和 `truncation_info` 明确报告截断，不会静默丢失边界信息。
**Agent 输出**: 包含 `resumed_from`、`root_agent_id`、`resume_depth` 和
`resume_from_hint`，可在进程重启后继续同一 lineage。hard restart 后还会返回
`restart_recovery.outcome`（`completed`、`interrupted` 或 `failed`）和
`recoveredAt`；`failed` 表示 durable history 无法验证，禁止 resume。

### TaskCreate

创建会话内任务。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `subject` | string | ✅ | 任务标题 |
| `description` | string | ✅ | 任务描述 |
| `activeForm` | string | | 进行中展示文案 |
| `owner` | string | | 任务负责人 |
| `priority` | string | | 优先级 |

**类型**: ReadOnly  
**存储**: `~/.blade/tasks/<session>-agent-<session>.json`

### TaskGet

读取单个任务。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `taskId` | string | ✅ | 任务 ID |

**类型**: ReadOnly

### TaskUpdate

更新任务状态、内容或依赖。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `taskId` | string | ✅ | 任务 ID |
| `status` | string | | `pending` / `in_progress` / `completed` / `deleted` |
| `subject` | string | | 新标题 |
| `description` | string | | 新描述 |
| `activeForm` | string | | 进行中展示文案 |
| `owner` | string | | 任务负责人 |
| `addBlocks` | array | | 当前任务阻塞的任务 ID |
| `addBlockedBy` | array | | 阻塞当前任务的任务 ID |

**类型**: ReadOnly

### TaskList

列出当前会话任务。

**类型**: ReadOnly

### TeamCreate

创建 Agent Team，并可一次性启动多个后台 teammate subagents。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `team_name` | string | ✅ | 团队名称，会被规范化为安全目录名 |
| `description` | string | | 团队目标说明 |
| `agent_type` | string | | team lead 的角色标签 |
| `members` | array | | 初始 teammate 列表 |

`members` 项字段：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | teammate 名称 |
| `subagent_type` | string | ✅ | 已注册的 subagent 类型 |
| `description` | string | | 简短任务说明 |
| `prompt` | string | ✅ | 详细任务指令 |

**类型**: ReadOnly  
**存储**: `~/.blade/teams/<team-name>/config.json`  
**特性**: 基于后台 Task agent 启动 teammate，成员共享 team name 作用域的任务列表，可通过 `TaskOutput` 读取成员输出

### TeamStatus

列出 Agent Teams，或查看指定团队的成员状态。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `team_name` | string | | 团队名称；省略时列出全部团队 |

**类型**: ReadOnly

### TeamDelete

标记团队结束，并可取消运行中的 teammate agents。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `team_name` | string | ✅ | 团队名称 |
| `kill_running` | boolean | | 是否取消运行中的成员（默认 true） |

**类型**: ReadOnly

## Plan 模式工具

### EnterPlanMode

进入 Plan 模式（只读调研模式）。

**类型**: ReadOnly

### ExitPlanMode

退出 Plan 模式并提交方案。

该工具只在当前权限模式为 Plan 时有效。若压缩后的上下文或旧消息在其他模式中再次请求退出，运行时会返回 `validation_error`，不会触发确认或结束当前工具循环；模型应继续执行已经批准的实现。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `title` | string | ✅ | 方案标题 |
| `plan` | string | ✅ | 方案内容（Markdown） |

**类型**: ReadOnly

## 系统工具

### MemoryRead

读取项目记忆文件。Agent 自动记录的项目知识跨会话持久化。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `topic` | string | ✅ | 主题名（如 "debugging"）或 "_list" 列出所有文件，"MEMORY" 读取索引 |

**类型**: ReadOnly  
**返回**: 记忆文件内容或文件列表

### MemoryWrite

保存项目记忆。支持敏感数据过滤（password/token/secret/api_key/private_key）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `topic` | string | ✅ | 主题名（如 "patterns"），"MEMORY" 写入索引 |
| `content` | string | ✅ | 要保存的内容 |
| `mode` | string | | 写入模式：overwrite / append（默认 append） |

**类型**: Write  
**特性**: 自动过滤敏感数据，防止路径遍历

### AskUserQuestion

向用户提问并等待回复。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `question` | string | ✅ | 问题内容 |

**类型**: ReadOnly

### Skill

调用已注册的 Skill。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `skill_name` | string | ✅ | Skill 名称 |
| `input` | string | | 输入参数 |

**类型**: Execute

### SlashCommand

执行 Slash 命令。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | string | ✅ | 命令内容 |

**类型**: Execute  
**说明**: 供系统调用，用户通常无需直接使用

## MCP 工具

通过 `blade mcp add` 注册的 MCP 服务器会在运行时加载，其工具按
`mcp__<server>__<tool>` 稳定名称加入工具列表。
MCP tools 默认 deferred，需要先通过 `ToolSearch` 激活 schema。工具执行期间的
Form/URL `elicitation/create` 会投影到 TUI、Web 和 ACP；无交互面或客户端无法表达
请求字段时 fail closed。MCP server 可读取当前 Session 执行 workspace roots；
`sampling/createMessage` 默认关闭，显式启用后每次仍要求 one-shot 用户批准。详情见
[MCP Elicitation](mcp-elicitation.md)和
[MCP Roots 与 Sampling](mcp-roots-sampling.md)。MCP tools 继承 Session cancel，
支持 idle/hard timeout 和实时 progress，详见
[MCP Tool Call 生命周期](mcp-call-lifecycle.md)。普通 `tools/call` 结果在进入模型前
执行 text/structured/binary 预算、0600 Session artifact 和 metadata allowlist，详见
[MCP Tool Result 安全边界](mcp-tool-result-safety.md)。远程 OAuth server 只消费显式
登录后的 endpoint/client/scopes 凭证，Session 不会自行打开浏览器；详见
[MCP OAuth 生命周期](mcp-oauth-lifecycle.md)。server 可通过 `list_changed` 原子更新
目录，详见 [MCP 动态工具目录](mcp-dynamic-catalog.md)。Resources、Resource
Templates、Prompts 和显式 Subscription 通过 `ListMcpResources`、
`ListMcpResourceTemplates`、`ReadMcpResource`、`ListMcpPrompts`、
`CompleteMcpArgument`、`GetMcpPrompt`、`ManageMcpResourceSubscription` 暴露，
完整约束见 [MCP Resources、Prompts 与订阅](mcp-resources-prompts.md) 和
[MCP Completion](mcp-completion.md)。Completion 只接受当前 Session catalog 中声明的
参数，并执行候选 Unicode、bytes、并发、超时和 provenance 边界。transport 异常会先撤销
旧目录，再执行 Session 私有的可取消有界恢复并重建订阅；详见
[MCP 故障恢复](mcp-fault-recovery.md)。标准 `notifications/message` 日志按 Session
协商级别、脱敏和限流，只投影给用户而不进入模型；详见
[MCP Logging 与诊断](mcp-logging.md)。InitializeResult instructions 经过隐藏 Unicode、
单 server/Session 累计预算和 provenance 包装后，作为对应 server 的外部不可信工具
文档进入本地模型上下文；详见
[MCP Server Instructions](mcp-server-instructions.md)。
实验性 task-capable tools 只有在 server 的 `tasks.enabled` 显式开启后可用：
`required` 工具自动返回 opaque `mcp_task_*`，`optional` 工具可通过
`StartMcpTask` 后台化，并统一用 `TaskOutput`、`ListMcpTasks` 和
`CancelMcpTask` 管理。完整 ownership、恢复与结果安全边界见
[MCP Async Tasks](mcp-tasks.md)。

```bash
# 添加 MCP 服务器
blade mcp add local -- node ./path/to/mcp-server.mjs

# 查看已注册的服务器
blade mcp list
```

## 权限与工具类型

| 工具类型 | default | autoEdit | plan | yolo |
|----------|---------|----------|------|------|
| ReadOnly | ✅ 自动 | ✅ 自动 | ✅ 自动 | ✅ 自动 |
| Write | ⚠️ 确认 | ✅ 自动 | ❌ 拒绝 | ✅ 自动 |
| Execute | ⚠️ 确认 | ⚠️ 确认 | ❌ 拒绝 | ✅ 自动 |

详见 [权限系统](../configuration/permissions.md) 章节。

## 工具总览

| 分类 | 工具 | 类型 | 说明 |
|------|------|------|------|
| 文件操作 | Read | ReadOnly | 读取文件内容 |
| 文件操作 | Write | Write | 写入或创建文件 |
| 文件操作 | Edit | Write | 按字符串/正则替换文件内容 |
| 文件操作 | NotebookEdit | Write | 编辑 Jupyter Notebook |
| 搜索 | Glob | ReadOnly | glob 模式查找文件 |
| 搜索 | Grep | ReadOnly | 基于 ripgrep 的内容搜索 |
| Shell | Bash | Execute | 执行 Shell 命令 |
| Shell | KillShell | Execute | 终止后台命令 |
| 网络 | WebFetch | ReadOnly | 获取网页/API 内容（支持 Jina Reader） |
| 网络 | WebSearch | ReadOnly | 网络搜索（Exa/DuckDuckGo/SearXNG） |
| 任务 | Task | ReadOnly | 启动子代理执行任务 |
| 任务 | TaskOutput | ReadOnly | 获取后台任务输出 |
| 任务 | TaskCreate | ReadOnly | 创建会话任务 |
| 任务 | TaskGet | ReadOnly | 读取单个任务 |
| 任务 | TaskUpdate | ReadOnly | 更新任务状态或内容 |
| 任务 | TaskList | ReadOnly | 列出当前任务 |
| Plan | EnterPlanMode | ReadOnly | 进入只读调研模式 |
| Plan | ExitPlanMode | ReadOnly | 退出并提交方案 |
| 系统 | MemoryRead | ReadOnly | 读取项目记忆文件 |
| 系统 | MemoryWrite | Write | 保存项目记忆 |
| 系统 | AskUserQuestion | ReadOnly | 向用户提问 |
| 系统 | Skill | Execute | 调用已注册的 Skill |
| 系统 | SlashCommand | Execute | 执行 Slash 命令 |

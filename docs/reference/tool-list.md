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
**返回**: 后台运行时返回 `bash_id` 和 `shell_id`，可用于 KillShell 或 TaskOutput 查询

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

## 任务管理

### Task

启动子代理执行任务。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `subagent_type` | string | ✅ | 子代理类型 |
| `query` | string | ✅ | 任务描述 |
| `description` | string | | 简短描述 |

**类型**: ReadOnly  
**特性**: 使用 `.blade/agents` 或 `~/.blade/agents` 中的配置

### TaskOutput

获取后台任务的输出。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task_id` | string | ✅ | 任务 ID |

**类型**: ReadOnly

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

## Plan 模式工具

### EnterPlanMode

进入 Plan 模式（只读调研模式）。

**类型**: ReadOnly

### ExitPlanMode

退出 Plan 模式并提交方案。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `title` | string | ✅ | 方案标题 |
| `plan` | string | ✅ | 方案内容（Markdown） |

**类型**: ReadOnly

## Spec 模式工具

### EnterSpecMode

进入 Spec 驱动开发模式。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `spec_path` | string | | Spec 文件路径 |

**类型**: Write

### UpdateSpec

更新 Spec 文件内容。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `content` | string | ✅ | 更新后的 Spec 内容 |

**类型**: Write

### GetSpecContext

获取当前 Spec 上下文信息。

**类型**: ReadOnly

### TransitionSpecPhase

转换 Spec 工作流阶段。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `phase` | string | ✅ | 目标阶段 |

**类型**: Write

### AddTask

向 Spec 添加任务。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task` | object | ✅ | 任务定义 |

**类型**: Write

### UpdateTaskStatus

更新 Spec 中的任务状态。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task_id` | string | ✅ | 任务 ID |
| `status` | string | ✅ | 新状态 |

**类型**: Write

### ValidateSpec

验证 Spec 文件完整性。

**类型**: ReadOnly

### ExitSpecMode

退出 Spec 模式。

**类型**: Write

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

通过 `blade mcp add` 注册的 MCP 服务器会在运行时加载，其工具按原始名称加入工具列表。

```bash
# 添加 MCP 服务器
blade mcp add github -- npx -y @modelcontextprotocol/server-github

# 查看已注册的服务器
blade mcp list
```

## 权限与工具类型

| 工具类型 | default | autoEdit | plan | yolo | spec |
|----------|---------|----------|------|------|------|
| ReadOnly | ✅ 自动 | ✅ 自动 | ✅ 自动 | ✅ 自动 | ✅ 自动 |
| Write | ⚠️ 确认 | ✅ 自动 | ❌ 拒绝 | ✅ 自动 | ✅ 自动 |
| Execute | ⚠️ 确认 | ⚠️ 确认 | ❌ 拒绝 | ✅ 自动 | ⚠️ 确认 |

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
| Spec | EnterSpecMode | Write | 进入 Spec 驱动开发模式 |
| Spec | UpdateSpec | Write | 更新 Spec 文件 |
| Spec | GetSpecContext | ReadOnly | 获取 Spec 上下文 |
| Spec | TransitionSpecPhase | Write | 转换工作流阶段 |
| Spec | AddTask | Write | 添加任务 |
| Spec | UpdateTaskStatus | Write | 更新任务状态 |
| Spec | ValidateSpec | ReadOnly | 验证 Spec 完整性 |
| Spec | ExitSpecMode | Write | 退出 Spec 模式 |
| 系统 | MemoryRead | ReadOnly | 读取项目记忆文件 |
| 系统 | MemoryWrite | Write | 保存项目记忆 |
| 系统 | AskUserQuestion | ReadOnly | 向用户提问 |
| 系统 | Skill | Execute | 调用已注册的 Skill |
| 系统 | SlashCommand | Execute | 执行 Slash 命令 |

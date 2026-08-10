# Session-owned User Shell Command

Blade 支持在输入框中使用 `! <command>` 显式执行用户 shell 命令。该路径属于
Session Runtime，不创建 Agent，也不发起模型请求。

```text
! pwd
! npm test
! git status --short
```

TUI、Web、print、headless 与 ACP 共用同一持久化和输出边界。

## 执行语义

- 命令在当前 Session 的 execution workspace 中运行；
- 普通 Session 使用项目 workspace，Task Session 使用冻结的 worktree；
- Task worktree 不会回退 source checkout；
- 环境来自 SessionStart 冻结环境，并增加 `BLADE_CLI=1` 与
  `BLADE_USER_SHELL=1`；
- shell 命令不经过 `UserPromptSubmit` Hook，不调用模型，也不创建模型工具调用；
- 同一 Session 同时只运行一条 user shell command；
- Web Task Home 输入 `!` 时创建普通 Session，不创建独立 worktree Task。

`!` 是用户直接授权执行的命令，不经过 Agent 的 Bash permission 流程。TUI 与 Web
会切换到黄色 `$` shell mode，避免把它误认为普通模型消息。

## 持久化与模型上下文

执行结果先写入 Session JSONL，再返回给调用端。模型侧使用显式边界：

```xml
<user_shell_command>
<command>pwd</command>
<result>
Status: completed
Exit code: 0
Duration: 0.004 seconds
Output:
/workspace
</result>
</user_shell_command>
```

XML 会进行转义，只进入模型历史。TUI/Web/ACP、Session resume 和 Markdown export
读取 `metadata.userShellCommand`，显示结构化 command card 或 console block，不暴露
内部 XML。

活动 Agent 回合期间执行 `!` 时，结果先持久化，再作为 auxiliary steering 注入当前
回合的下一个安全 provider boundary；若回合已封口则进入下一回合。durable inbox
只保存引用，不重复写入同一 shell message。

## 输出与取消

命令长度上限为 32 KiB。stdout 与 stderr 使用独立 UTF-8 decoder，并具备：

- ANSI escape 清理；
- split code point 安全的流式输出；
- stdout/stderr 各 512 KiB capture 预算；
- stdout/stderr 各 64 KiB live stream 预算；
- 首 4 KiB NUL sniff，binary stream 只保留字节数摘要；
- head/tail 截断与省略字节数；
- async output callback drain，`completed` 不会早于最后一个 output event。

终态为：

```text
completed
failed
aborted
timed_out
spawn_error
```

本地执行使用 owned process group。Session abort、TUI cancel、Web
`POST /sessions/:id/abort` 和 ACP cancel 会终止完整进程树，而不是只终止直接子进程。

## 跨端协议

Web 使用：

```text
POST /sessions/:sessionId/shell
```

请求包含 `command` 与精确 `projectPath`。SSE 事件为：

```text
user.shell.started
user.shell.output
user.shell.completed
```

headless `--output-format jsonl` 使用稳定 snake_case wire contract：

```text
user_shell_started
user_shell_output
user_shell_completed
```

print 示例：

```bash
blade --print '! pwd'
blade --print --output-format stream-json '! npm test'
```

ACP 将生命周期投影为一个 `kind: execute` tool call，并通过 IDE terminal 执行。IDE
terminal 不可用时 fail closed，禁止在 Blade host shell 上回退执行远程命令。

## 限制

- user shell command 不接受图片附件；
- `!` 不能与 headless `--task-isolation` 组合；
- 当前 Runtime 初始化仍要求存在可用模型配置，但执行 `!` 本身不会使用 credential
  或访问 provider；
- binary output 不进入模型或 UI；
- 用户仍需审查命令内容，Blade 不把显式 `!` 当作 Agent 生成的安全命令。

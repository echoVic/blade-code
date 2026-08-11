# Native Read-Only Code Review

Blade 提供 Session-native 的独立代码审查，不再把 staged diff 拼进主 Agent prompt。
reviewer 使用独立子会话、结构化 finding 协议和不可绕过的只读执行边界。

## 入口

```text
/review
/review uncommitted
/review base main
/review commit <sha>
```

`/git review` 是 `/review uncommitted` 的兼容别名。

- CLI/TUI：直接执行 `/review`；
- Web：Task Home 的“评审”模板填入并执行 `/review uncommitted`；
- ACP：通过标准 slash command 执行同一 reviewer；
- HTTP：`POST /sessions/:sessionId/review`，请求必须携带 exact
  `projectPath` 和 target。

## Target

| 类型 | 范围 |
| --- | --- |
| `uncommitted` | 当前 workspace 相对 `HEAD` 的 staged、unstaged 和 untracked 内容 |
| `base <ref>` | merge-base 到当前 `HEAD` 的提交变化 |
| `commit <sha>` | 指定单个 commit 的变化 |

宿主在启动前计算包含 resolved commit identity 的 SHA-256 target digest、changed
files 和精确新增/删除行范围。最多 500 个文件，diff 与 untracked 内容合计最多
8 MiB。reviewer 运行期间 target 发生变化时，结果标记为 `stale`，不能伪装成当前
工作区结论。

## 只读安全边界

内置 `review` 与 `verification` 共用 read-only audit authority：

1. 工具白名单只有 `Read`、`Glob`、`Grep`、`Bash`；
2. PermissionResolver 只允许只读命令和项目已有的 verification command；
3. 本地 Bash 进入 `workspace-read-only` sandbox，workspace 禁写、网络关闭；
4. user HOME、Blade storage 和 provider credentials 禁止读取；
5. Git 使用空 global/system config 且关闭 optional locks，不需要读取用户
   `~/.gitconfig`；
6. 后台命令、环境覆盖、跨 workspace cwd 和任意写工具全部拒绝。

review turn 不使用 Plan mode。Plan mode 包含“退出计划并执行修改”的产品语义，会和
只读审查冲突；review 的安全性由上述 rule 与 OS sandbox 强制。

## Durable 生命周期

父 Session JSONL 记录：

```text
review_started
→ user /review message
→ review_completed
→ rendered assistant report
```

`review_started` 在 Web/TUI/ACP 展示运行状态前落盘。结果包含 status、总体说明和最多
50 条 finding。进程在 reviewer 完成前退出时，下一 owner 写入 `interrupted` 终态，不会
自动重放模型调用。若进程在 `review_completed` 与 rendered message 之间退出，fresh
Session 会直接从完成事件恢复报告和任务终态。

Web 会实时投影 reviewer 的只读工具进度；收到 `review.completed` 后按 exact Session
identity 重载权威消息，无需手动刷新。报告的结构化标题、target、status、finding 和
confidence chrome 支持中英文切换。

Fork 不复制 live review lifecycle；已完成报告作为普通 conversation history 继承。
Conversation rewind 会移除 checkpoint 后的 review 事件与报告。

## Finding 协议

每条 finding 包含：

- `title`：`[P0]` 至 `[P3]` 开头的命令式标题；
- `body`：触发场景、影响和可执行修复方向；
- `priority`：0-3；
- `confidenceScore`：0-1；
- `codeLocation`：workspace-relative path 和不超过 10 行的范围。

宿主验证 path 属于 target，并且 line range 与真实 diff changed lines 重叠。模型输出
无法解析、越界或引用未改动代码时，整个 review fail closed。

## 准出

- 确定性测试覆盖三类 target、tracked/untracked digest、大小预算、stale、abort、
  interrupted、fork/rewind、结构化 hunk 校验和 read-only sandbox；
- 真实 GPT 分别从 Web route、ACP `/review` 和 TUI runtime hook 找出同一授权绕过，
  同时证明文件字节与 Git status 不变；
- Production DeepSeek Web GUI 从 Task Home“评审”模板启动，fresh tab 恢复 P0、
  `authorization.ts:L8`、confidence 和 completed 状态，console 无 application error。

# Durable Follow-up Queue

Blade 在长任务运行期间收到的新输入会进入当前 Session 的 durable follow-up queue。
队列以落盘 inbox 为唯一事实源；TUI 和 Web 只显示 Runtime 返回的版本化快照，不维护
第二份可写队列。

## 哪些输入可以调整

只有同时满足以下条件的条目可以删除或移动：

- 来源是用户；
- 内容仍以内联形式保存；
- 尚未被当前回合保留、claim 或写入 transcript；
- 不带结构化输出 schema；
- 不属于崩溃恢复保护范围。

后台 subagent 完成通知、team message、interaction recovery、user shell 引用、
artifact-backed prompt 和其他内部输入会显示为不可变 barrier。它们不能被删除，用户条目
也不能跨过 barrier 重排。这样可以在不泄漏内部内容的前提下展示真实顺序。

## TUI

活动回合中可以输入 `/queue` 打开面板。状态栏在有待处理输入时显示
`Queued N · /queue`。

| 按键 | 操作 |
| --- | --- |
| `j` / `↓` | 选择下一条 |
| `k` / `↑` | 选择上一条 |
| `d` | 删除可变条目 |
| `J` / `K` | 在当前可变区段内下移 / 上移 |
| `g` / `G` | 移到当前可变区段开头 / 结尾 |
| `r` | 重新读取 authoritative snapshot |
| `Esc` / `q` | 关闭面板 |

面板在 Agent 仍运行时可用，并在终端 resize 后保持当前状态。

## Web UI

Composer 上方的 **后续指令队列** 面板显示当前顺序、投递阶段、锁定状态和附件数量。
可变条目提供上移、下移、删除按钮，也支持同一可变区段内的 drag reorder。页面 reload
和 SSE reconnect 会重新读取 authoritative snapshot。

每次 mutation 必须携带当前 64 位 SHA-256 version。若其他 owner 已先提交变更，服务端
返回 `revision_conflict` 和最新 snapshot；Web 会安装最新状态并提示用户重新确认，不会自动
重放旧操作。

## 持久化与投递

- enqueue、reorder、remove、reservation、claim、acknowledgement 和恢复保护状态改变后，
  都会生成新 version。
- 成功 mutation 先原子写入 durable inbox，再发布新 snapshot。
- crash/restart 后保持未消费条目的顺序；旧 Runtime owner 的 version 不再有效。
- 队列输入只有在 `steering_applied` 后才进入 canonical transcript；删除待处理条目不会留下
  ghost user message。
- `session/cancel` 只取消活动回合，不等价于删除队列。

## ACP

ACP 1.3 没有标准队列 mutation 方法，因此 Blade 不声明自定义 mutation capability。
ACP client 通过标准 `session_info_update` 接收只读摘要：

```json
{
  "_meta": {
    "blade/followUpQueue": {
      "version": "opaque-sha256-token",
      "pending": 3,
      "mutable": 2,
      "locked": 1,
      "internal": 0
    }
  }
}
```

摘要会在 Session 创建或加载后，以及 enqueue、claim、acknowledgement 和 recovery reload
之后更新。它不包含条目数组、preview、message ID、图片 data URL、artifact/path、output
schema、请求 header 或 credential。

## 限制

- 本版本不支持编辑排队内容。
- Web/TUI 不能写入 ACP-remote history-only Session。
- 控制操作不会中断正在进行的 Provider 请求；新顺序在下一安全边界生效。
- 队列最多 160 条，并受 durable inbox 的现有条目、字符和文件大小预算约束。

生产资格验证过程见 [Durable Follow-up Queue 资格验证证据](../testing/durable-follow-up-queue-evidence.md)。

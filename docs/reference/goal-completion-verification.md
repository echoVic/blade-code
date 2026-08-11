# Host-Authoritative Goal Completion Verification

Goal 模式用于跨多个模型回合持续推进一个长期目标。Blade 不再允许执行 Agent 直接把
Goal 写成 `complete`：`UpdateGoal({ status: "complete" })` 只提交完成候选，最终状态由
宿主控制的独立验证流程决定。

## 状态机

```text
active
  -> verifying        UpdateGoal complete
  -> paused/blocked   用户操作或真实阻塞

verifying
  -> complete         fresh goal-verification PASS
  -> verifying        FAIL/PARTIAL、验证格式错误、后续 mutation/steering
  -> paused/blocked   用户操作或真实阻塞
```

`verifying` 是 durable 状态。它和 objective、attempt、verdict、verifier Session ID、
安全摘要及 SHA-256 证据摘要一起写入 Goal state 文件。只有同时存在：

- `status === "verifying"`；
- `completionVerification.status === "pass"`；
- 非空 verifier child Session ID；
- 64 字符十六进制 SHA-256 evidence digest；

宿主才允许原子切换为 `complete`。

## 独立 verifier

Blade 使用保留的内置 `goal-verification` subagent。用户、项目、插件和命令行 override
都不能替换该定义。

验证器具有以下边界：

- 仅允许 Read、Glob、Grep 与只读 Bash；
- workspace 通过 read-only sandbox 暴露；
- 禁止写工具、Task 二次委派、网络和 provider credential；
- prompt 由宿主重写为完整 persisted objective 和当前 changed-file scope；
- verdict 使用 turn-scoped JSON Schema：

```json
{
  "verdict": "pass | fail | partial",
  "summary": "requirement-by-requirement conclusion",
  "findings": ["concrete gap with locator"]
}
```

模型传入的 `subagent_type`、background、resume 或 worktree 参数不具有控制权。Goal
completion gate 会把下一次 Task 强制规范为 fresh、foreground、
`goal-verification`、`isolation="none"`。

## 失败与继续

- `PASS`：宿主先持久化 verifier evidence，再 finalize Goal。
- `FAIL`：Goal 保持 `verifying`，执行 Agent 收到 finding 并继续修复。
- `PARTIAL`：缺失或间接证据不算完成；执行 Agent继续补齐。
- 缺少 verdict / schema 不合法：有界纠正后仍失败则拒绝完成。
- verifier 运行失败：不会伪造 PASS；Goal 保持未完成。
- 模型改为 `blocked`：completion candidate 被取消，不再尝试 finalize。

Goal verifier 不受用户 prompt 中“不要委派”或“一次 Task”约束影响，因为它是宿主安全
控制面，不是用户请求的工作委派。

## 证据失效

completion candidate 之后发生以下事件时，旧 verdict 立即失效：

- Edit、Write、ApplyPatch、NotebookEdit 或会改变 workspace 的 Bash；
- Stop hook 要求继续；
- 用户 steering 到达；
- process restart 恢复一个仍处于 `verifying` 的 Goal。

重启时即使磁盘上已有旧 PASS，宿主也会重新运行 fresh verifier。这样可以覆盖
“verdict 已落盘但 complete 尚未落盘”和外部 workspace 变化窗口。

## 跨端投影

### CLI / TUI

状态栏显示 `goal:verifying`。Headless JSONL 使用稳定 `goal` 事件：

```json
{
  "event_version": 1,
  "type": "goal",
  "state": "updated",
  "goal_id": "goal_...",
  "status": "verifying",
  "verification_attempt": 1,
  "verification_status": "pass",
  "verifier_session_id": "agent_...",
  "verification_evidence_sha256": "..."
}
```

文本输出把 lifecycle 写入 stderr，不污染最终 stdout。

### Web

Goal control bar 显示 `Verifying completion / 正在验证完成声明`。展开后展示 attempt、
稳定 verdict、opaque verifier Session ID、安全摘要与 SHA-256 前缀。fresh tab 从
GoalSnapshot 恢复相同证据。

### ACP

Goal lifecycle 和 verifier Task 使用标准 session update。同步 prompt 完成时还可返回：

```json
{
  "_meta": {
    "goalCompletion": {
      "verified": true,
      "verdict": "pass",
      "verifierSessionId": "agent_...",
      "evidenceSha256": "..."
    }
  }
}
```

ACP projection 不包含 verifier 原文、宿主路径或 credential。

## 准出

确定性测试覆盖：

- candidate 不能直接完成；
- 只有 fresh PASS 可以 finalize；
- FAIL/PARTIAL、缺少 Task、错误 schema 与 retry exhaustion fail closed；
- mutation、steering、restart 和 Stop continuation 使证据失效；
- reserved agent、只读 sandbox、权限边界和 structured verdict；
- GoalStore `0600` 原子持久化；
- CLI JSONL、TUI、Web bilingual/fresh-tab 与 ACP `_meta`。

真实 API 资格使用 DeepSeek Flash 分别经过 Runtime、Web REST/SSE 和 ACP slash：
执行 Agent 完成目标后，必须出现独立 `goal-verification` child Session、宿主验证的
PASS payload、持久化 evidence digest，随后才允许 `complete`。Production Web GUI
还需验证 live `verifying` 状态、完成证据、fresh-tab 恢复与零 application console
error。

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
- process restart 恢复一个仍处于 `verifying`、但没有 exact host finalization receipt
  的 Goal。

重启时即使磁盘上已有旧 PASS，宿主也会重新运行 fresh verifier。这样可以覆盖
“verdict 已落盘但最终响应尚未提交”和外部 workspace 变化窗口。

唯一例外是最终 assistant 已经携带 host-owned `turnFinalization.goalFinalization`
receipt durable commit。Runtime 只在 receipt 的 goal ID、attempt、verifier Session ID、
evidence SHA-256 与 Goal `updatedAt` 全部匹配当前 `verifying/pass` sidecar 时，幂等
finalize 为 `complete`。receipt 缺失、损坏或不匹配时不会信任旧 PASS。

## Premature Stop 恢复

当 Goal 仍为 `active` 或 `verifying` 时，宿主会检查成功回合最后一个非空段落是否以
保守的自我延期或交接语句结束，例如等待内部 worker、自行稍后重试、停止在此或声明
ready for review。命中后：

- Goal sidecar 只持久化稳定 pattern、连续次数和检测时间，不保存模型原文；
- 下一次 continuation 会明确要求读取 durable task 状态、接收已完成工作并立即执行
  下一步；
- 第二次连续命中后提示必须改变策略，检查或重启停滞 worker，并验证当前假设；
- 同一 pattern 连续第三次命中后，宿主把 Goal 原子切换为 `blocked`，阻止无界 token
  消耗；
- 普通进展、用户显式 resume、编辑 Goal 或提交完成候选会清空连续计数。

该机制没有全局 continuation 上限。只有同一可审计 pattern 连续三次命中才触发
liveness breaker；pattern 改变会从 1 重新计数。用户可以在检查证据后显式 resume。
真实外部阻塞仍应由执行 Agent 通过 `UpdateGoal blocked` 和具体证据表达；完整完成
仍走独立 verifier。

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
  "verification_evidence_sha256": "...",
  "premature_stop_pattern": "internal_wait",
  "premature_stop_count": 2
}
```

文本输出把 lifecycle 写入 stderr，不污染最终 stdout。TUI 状态栏在恢复期间显示
`recovery:N`。

### Web

Goal control bar 显示 `Verifying completion / 正在验证完成声明`。展开后展示 attempt、
稳定 verdict、opaque verifier Session ID、安全摘要与 SHA-256 前缀。fresh tab 从
GoalSnapshot 恢复相同证据。自动化可通过 `data-blade-goal-recovery` 和
`data-blade-goal-recovery-pattern` 检查 durable recovery 状态。

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
每次 continuation 还会通过 `blade/goalContinuation` metadata 投影 continuation、
premature-stop pattern 和连续次数。

## 准出

确定性测试覆盖：

- candidate 不能直接完成；
- 只有 fresh PASS 可以 finalize；
- FAIL/PARTIAL、缺少 Task、错误 schema 与 retry exhaustion fail closed；
- mutation、steering、restart 和 Stop continuation 使证据失效；
- reserved agent、只读 sandbox、权限边界和 structured verdict；
- GoalStore `0600` 原子持久化；
- premature-stop 保守匹配、误报对照组、连续计数重置和分级恢复提示；
- final assistant 与 Goal sidecar 之间的 crash handoff、幂等重试和 stale receipt 拒绝；
- CLI JSONL、TUI、Web bilingual/fresh-tab 与 ACP `_meta`。

真实 API 资格使用 DeepSeek Flash 分别经过 Runtime、Web REST/SSE 和 ACP slash：
执行 Agent 完成目标后，必须出现独立 `goal-verification` child Session、宿主验证的
PASS payload、持久化 evidence digest，随后才允许 `complete`。Production Web GUI
还需验证 live `verifying` 状态、完成证据、fresh-tab 恢复与零 application console
error。独立 crash 矩阵还使用 Flash/Pro 覆盖 Headless、raw PTY、Web GUI 与 ACP：
恢复阶段不得发起 Provider 请求，原终答只回放一次，随后同一 surface 必须完成新的
真实 API follow-up。

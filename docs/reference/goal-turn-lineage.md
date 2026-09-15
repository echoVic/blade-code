# Durable Goal 回合链

Blade Code 为活动 Goal 持久记录由宿主生成的回合因果链，使长任务在自动 continuation、
用户 follow-up 和进程重启后仍能回答“Goal 从哪个回合开始”以及“当前回合直接承接哪个
回合”。客户端只展示权威快照，不按时间或消息文本推断关系。

## 数据契约

Goal snapshot 可以包含：

```ts
interface GoalTurnLineage {
  rootTurnId?: string;
  currentTurnId: string;
  parentTurnId?: string;
}
```

- `rootTurnId`：仍可证明时，指向创建该 Goal 的用户回合；
- `currentTurnId`：最近一次绑定到该 Goal 的顶层回合；
- `parentTurnId`：`currentTurnId` 的直接 Goal-chain parent。

每个 ID 都是不透明的宿主标识，长度限制为 1..128 个字符。旧 Goal 文件或旧
`turn_started` 事件没有 lineage 时仍可读取；Blade 不会为它们猜测或补造 root。

## 建立与推进

模型在活动用户回合中调用 `CreateGoal` 时，工具只能从 host-only execution context
取得当前 turn ID，初始 `rootTurnId` 与 `currentTurnId` 都指向该回合。通过 `/goal`、Web
或 ACP 在回合外创建 Goal 时没有可信 origin，因此保持 rootless。

每次自动 continuation 都把旧 `currentTurnId` 移到 `parentTurnId`，再写入新的
`currentTurnId`。已有 Goal 下的 direct user turn 或 durable pending turn 也会进入同一条链，
但不会增加 continuation count；下一次 continuation 因此直接承接刚处理的用户输入。

`SessionRuntime` 按固定顺序协调双写：

1. 取得 mailbox turn owner；
2. 持久写入带候选 lineage 的 `turn_started`；
3. 通过 Goal ID、objective、`updatedAt` 和 turn ID fence 提交 Goal binding；
4. 只有提交成功后才允许请求 Provider。

durable start 失败会释放 owner；Goal commit 失败会把已开始的 turn 记录为 failed abort。
进程若在 start 与 commit 之间崩溃，startup recovery 会关闭 orphan turn，Goal sidecar 仍
保留上一个已提交的 current。

## Root 失效规则

Blade 只在能证明 origin 时保留 root：

- Goal objective 被 edit 时清除整条 lineage；
- pause/resume 不改变 objective，因此保留 lineage；
- 同一 active turn 收到额外 steering、background completion、team message、interaction
  recovery 或 user-shell delivery 时，清除无法继续证明的 root，但保留 current/parent；
- stale turn、旧 Goal ID 或旧 objective 的迟到 progress 不能覆盖新 Goal 或重建已清除的
  root；
- clear Goal 会随 sidecar 一起删除 lineage。

这些规则是审计边界，不是权限语义。root 缺失表示“当前宿主无法证明”，不表示 Goal
无效，也不会阻止用户显式 resume。

## 暂停与在途用量

暂停 Goal 会阻止后续自动 continuation，但不会取消已经执行的回合。该回合返回用量后，
只有 Goal ID、objective 和 current turn ID 全部匹配时才补记 tokens 与耗时；暂停状态、
原因和恢复证据保持不变。缺少身份、旧回合，以及 edit 或 clear/recreate 前的结果不会被
计入当前暂停的 Goal。

若补记后达到 token budget，Goal 仍保持暂停；用户显式 resume 时会转为 `budget_limited`，
不会启动新的模型请求。预算内的 resume 仍恢复为原有 active 或 verifying 路径。

## 用户界面与协议

- TUI 状态栏显示有界 `lineage:<root-or-?>:<current>`，每个 ID 最多显示前 8 个字符；
  `/goal status` 输出完整 Origin、Current 与 Parent；
- Web Goal 控制条展开区显示本地化的起点、当前和上一步，并通过
  `data-blade-goal-*-turn` 属性暴露相同值；reload 从权威 Goal snapshot 恢复；
- ACP 的 `blade/goal` 与 `blade/goalContinuation` metadata 使用 camelCase
  `turnLineage`；
- Headless `goal` JSONL 事件使用 `root_turn_id`、`current_turn_id` 和
  `parent_turn_id`。

四个表面都投影同一个 `GoalSnapshot`。缺失字段保持缺失，不发送伪造的 `null` ID，也不
维护客户端本地 parent counter。

## 隐私与非目标

Lineage 不进入 Provider prompt 或请求 metadata，也不包含消息正文、工具参数、命令、路径、
输出、错误或 credential。它不参与授权、权限继承或 Goal completion verification，也不
包含定价或费用信息；current turn ID 仅用于核对迟到用量的归属。
当前契约只覆盖顶层 Goal 回合，不是 subagent、fork、MCP task、hook 或 compaction 的通用
provenance DAG。

发布资格证据见
[Durable Goal 回合链资格验证证据](../testing/goal-turn-lineage-evidence.md)。

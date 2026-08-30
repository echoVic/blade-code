# Background Subagent Completion Dispatcher 发布证据

## 2026-08-30 资格验证（`blade-code@0.10.124`）

- 设计提交：`2f2fad23`
- 实施计划提交：`13a0964b`
- owner-scoped dispatcher 提交：`0418bf8c`、`9ac9b1ee`、`a6834e72`
- `SessionRuntime` handoff 提交：`1ac82541`、`3cbafde5`、`9cde4218`
- Task/Team 兼容性测试提交：`1a94970b`、`8aef024d`
- 真实 Runtime replacement 资格测试提交：`bd8a72b5`、`d5e8c64e`、`23bcf44d`
- 目标：后台 child 在 parent `SessionRuntime` 被同进程替换后才完成时，旧
  completion callback 必须把 durable completion 路由到当前 Runtime，而不能丢失
  parent wake、复活旧 Runtime 或重复写入 receipt。

## 发布边界

- process-wide dispatcher 仅保存 `{projectPath, sessionId}` 到当前 Runtime sink 的
  易失路由，不持有 completion payload，也不替代 `SessionLease` 或 durable sidecar。
- 同 owner 的 attach、初始 full reconcile、dispatch 与 detach 串行；不同 owner 可并行。
- Runtime attach 在 `SessionRuntime.create()` 返回前完成 full reconcile。没有 live sink
  时 dispatch 返回 `deferred`，下一个 Runtime 从 terminal child sidecar 修复。
- detach 是 token-checked、幂等并等待既有 dispatch；Runtime dispose 使用 single-flight，
  先 detach/join，再清 mailbox、engine、child sets 并释放 Session lease。
- 同 owner 的直接、间接与 fire-and-forget sink 重入由 async-context guard fail closed；
  不同 owner 的嵌套 dispatch 不受影响。
- Runtime sink 保留既有顺序：校验 child/owner/committed Task provenance，写 transcript
  receipt 与 terminal `subtask_ref`，写 durable inbox，标记本地 settled，发布 Bus wake，
  最后释放 waiter。ACK 仍是 exactly-once 权威。

## 确定性 RED/GREEN 证据

实现遵循测试先行。最初 RED 复现：Runtime A 退出、Runtime B 完成 startup scan 后，
child 才终态；调用 A 捕获的 callback 时，B mailbox 仍为空。GREEN 后 stale callback
通过 owner dispatcher 命中 B。审查驱动的回归还覆盖：

- 无 sink deferred、attach 初始 reconcile、dispatch/attach 竞态、detach join、duplicate
  attach、旧 token detach、不同 owner 并行、无遗留 owner operation；
- 同 owner reentrancy fail closed，不同 owner nested dispatch 可完成；
- stale callback 与当前 full scan 并发时 receipt/inbox/Bus 仍唯一；
- 无 live Runtime 后由下一次 attach 修复；rewind 删除 Task 后不再注入；
- failed、cancelled、resumed child 的 typed admission 与 lineage；
- successor waiter 被 late completion 唤醒，disposed Runtime waiter 返回 false；
- attach 失败回滚并释放 lease；并发 dispose 在 in-flight dispatch 后只清理一次；
- `BackgroundAgentManager` 的 finalized worktree/terminal sidecar 写入先于 completion
  observer；Task stable notification 先于 UI progress 与 `subagent.complete`；
- Team 的 task unblock/member/team completion events 先于 parent notification；没有匹配
  committed background `Task` 的 terminal Team member不能产生 receipt、inbox 或 Bus wake。

最终 focused 结果：

- dispatcher：17/17 通过；
- SessionRuntime、BackgroundAgentManager、Task bridge、Team tools：134/134 通过；
- 跨 surface 确定性门禁：6 files、384/384 通过。TUI hook 仍输出已有的 React
  `act(...)` 环境警告，无 assertion failure。

## 独立审查

- dispatcher 与 Runtime integration 均先完成规格审查，再完成代码质量/并发审查；
  所有 Critical/Important finding 均经新的 RED/GREEN 修复并复审为 `APPROVED`。
- Task 3 规格审查要求直接证明 Runtime B startup 看见 running child；真实轨迹现已
  通过 `runtimeB.listSubagents()` 锁定 exact child、parent Session、canonical workspace、
  `background=true` 与 `status=running`，并验证 attach 前后 sidecar bytes 不变。
- Task 3 质量审查发现 terminal sidecar 顺序测试无法区分 prepare 与 finalize 两次
  `updateSession`。修复后的 fixture 使用不同合法 payload，严格断言
  `persistFinalizedWorktree -> markCompleted -> onCompleted`；复审为 `APPROVED`。

## 真实 DeepSeek Runtime replacement 资格验证

测试对 child Provider 请求设置 Promise gate，并允许 parent 与 child 两条请求并行。
parent A 通过真实模型启动唯一 background `Task`、收到 running result、执行独立 `Read`，
并输出 `WAITING_FOR_BACKGROUND_COMPLETION`。测试仅在 A 的 production waiter seam 挂起，
确认 child sidecar 仍为 running 后让 A 正常写入 `turn_completed`，再销毁 Agent A、dispose
Runtime A 并创建同 owner 的 Runtime B。B startup 直接列出同一 running child；释放 child
后，旧 callback 触发 B 的唯一 `subagent.completion.queued`，B live mailbox 出现唯一 hidden
completion。最后 Agent B 以 `pendingInputOnly` 消费它，输出唯一
`BACKGROUND_PARENT_FINAL:<child-marker>`。

模型、框架与命令级 retry 全部关闭：model `maxRetries=0`、
`providerForegroundRecoveryMs=0`、Vitest case `retry=0`、命令 `--retry=0`、
`--maxWorkers=1 --no-file-parallelism`。

| 模型 | Surface | 结果 | 时长 | Framework retry |
| --- | --- | --- | ---: | ---: |
| `deepseek-v4-flash` | production Runtime A→B | 通过 | 8.129s | 0 |
| `deepseek-v4-pro` | production Runtime A→B | 通过 | 10.969s | 0 |

每格还验证：parent `Task` call 恰好一次、`TaskOutput` 为零、hidden receipt 恰好一次、
completion ACK 恰好一次、UI-safe messages 不含伪 user message、inbox 最终删除、child
sidecar 在 B attach 时 byte-stable，并且 child 只有一次两请求工具协议（发起 `Read`，再以
结果生成终态），没有重跑。

现有 Flash/Pro × Headless/ACP/raw PTY/Web 正常 completion 轨迹保持不变。raw PTY、Web
reload 与 ACP close 都不能精确表达“同进程 Runtime A 被 B 替换且 child 继续运行”，因此
本补丁不复制脆弱的 replacement 用例到这些 transport。

### 真实测试 harness 失败披露

- 首版用 body 文本匹配 child request，但 parent prompt 也包含该文本，导致错误地 hold
  parent request；随后改用只存在于 child system prompt 的 marker。
- 直接 Runtime 初次运行未置于 workspace cwd，`ConfigManager` 走外部 workspace 合并路径，
  在隔离 credential store 中于请求前报 `Provider is not configured: deepseek`。改为在既有
  `runWithCwdOverride(workspace)` 边界创建 Runtime 后通过。该失败没有发出 Provider 请求。
- child 的正常工具协议包含两次 Provider 请求：第一次发起唯一 `Read`，第二次使用结果
  生成终态。首版最终断言误把两次请求当成 child 重跑；改为 replacement 前恰好一次、
  最终恰好两次，并继续断言唯一 child sidecar 与唯一 Task call。

这些都是测试编排/证据口径问题，不是产品间歇失败；最终 Flash/Pro 在同一提交上以零
重试通过。诊断只记录 bounded lifecycle、计数、事件 kind 与脱敏错误摘要，不记录 headers、
API key 或原始 Provider 请求内容。

## 发布级门禁

- `bun run type-check`：通过。
- focused 与跨 surface 结果见上；最终全量 lint、build、test 数量在 release commit 前补录。
- 变更文件 Biome 与 `git diff --check`：通过。

资格验证源码哈希：

```text
4dcfa6be5cb0fc8b50680cd51773fb2f3b6bc80af12abd2d03e9d711662ff48a  BackgroundSubagentCompletionDispatcher.ts
7dd1cdea8cea5bbccd25a87a40e0c3f61d098963e31307ca360115426a7470de  SessionRuntime.ts
86aaa5b2e9a9f90838c3fce961f3c1880fef6a839e7097a845af300e8b22a8de  background-subagent-completion-dispatcher.test.ts
8de3ef4ac4d098e42a88a1a21c7ba7decf2d82a2edcfef45b02b4737b2b1cf1c  session-runtime.test.ts
0c70f8b77cf36d28b5501a135429aebfb9e968dad638dc4bc1095b40d2497f69  background-agent-manager.test.ts
81eafe90f673e4f6eb9a374ebe235865e244fd80709947f2a119d26208ffafef  subagent-event-forwarding.test.ts
50dee90f0adb0cbd6120718bcf4cbafbafcb6fff226e9e0cf45ac21b12baf342  team-tools.test.ts
9eed75ab125c78d1c06eafe3541d8e71c1f7c28fd5a4917a07fd44d027fff43f  background-subagent-completion-trajectory.test.ts
```

## 未包含范围

`0.10.124` 只修复同进程 parent Runtime replacement 后的 background completion
dispatch，并补齐 Task/Team 与既有 surface 兼容证据。跨进程消息总线、Web Session
projection residency、ACP remote filesystem 语义与长任务 false-progress detection 仍是后续
独立 P1。

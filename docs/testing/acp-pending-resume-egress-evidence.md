# ACP Pending-Resume Egress Convergence Release Evidence

## 2026-08-29 资格验证（`blade-code@0.10.117`）

- Runner commit：`1e752a2f5c891d3a642937a8086c4195996d8213`
- Runtime commit：`d8002c572471006a727dfc3e5f7be47f75794ab1`
- 目标：消除 durable completion 已可见而 ACP `recovered` metadata 尚未送达时
  产生的间歇性 `pending_resume_invalid`。

### 修复后的同步合约

- ACP runner 将精确的单条
  `retry_scheduled(attempt=2,maxAttempts=4,kind=pending_input)` 视为未完成前缀，
  在既有 absolute deadline 内继续轮询。
- 只有精确的 `retry_scheduled(2) -> recovered(2)` 序列完成验收；empty、畸形、
  顺序错误、字段错误、重复、`failed` 与 `exhausted` 仍立即 fail closed。
- 每次异步 inspection 都受 absolute deadline 的剩余预算约束，单个悬挂的
  inspect 不能绕过 runner timeout。
- Runtime 使用现有 exact-offer completion 等待 terminal `recovered` metadata，
  并在投递成功且 generation 仍匹配后才清理恢复状态。metadata egress 失败不会
  进入 Provider retry，也不会重跑已完成的 durable turn。
- Session 明确拥有 pending-resume completion；residency 和 destroy 都观察该
  owner。destroy 先使 generation 失效并关闭 egress，再 join completion，避免
  late coroutine 越过 Session 生命周期。
- Retry 保留原 backoff；busy prompt/shell/side-conversation 在创建 completion 前
  退回，由其既有 `finally` 唤醒，避免零延迟 microtask 自旋与丢 wake。
- Cancel 使当前 generation 失效并取消旧 wake，但不虚构撤销已 offer 的 ACP
  notification；该写入继续受既有 30 秒 egress timeout 约束，并在 settle 前
  保持 Session non-idle。

### TDD 与审查披露

- Runner tri-state RED：最初 99 项中 2 项失败；新增 exact prefix 与 polling
  用例均被旧 inspector 错误判为 invalid。
- 第一轮 runner 质量审查发现两个 Important：present-but-malformed metadata 会
  被静默过滤，以及永不 resolve 的 inspect 可绕过 deadline。分别补充 RED 后，
  三种 malformed 值产生 3 个预期失败，悬挂 inspect 产生 1 个预期失败；修复后
  runner 文件 103/103 通过，复审无发现。
- Runtime RED 捕获三种错误状态：deferred `recovered` 期间错误 idle、destroy 未
  join、writer rejection 后新 wake 启动第三次 prompt。
- Runtime 审查继续发现并关闭两个调度问题：completion guard 一度吞掉原 retry
  delay，以及 busy early-return 一度可能形成 microtask 自旋或丢 wake。最终用
  可控 `queueMicrotask` 顺序测试覆盖 `R -> F` 与 `F -> R` 所需行为。
- 最终 focused unit：2 个文件、243/243 通过。
- 最终独立规格复审与独立代码质量复审均无发现。
- TypeScript type check、Biome、`git diff --check` 与 production build 全部退出
  0；build 仅输出既有 Browserslist 数据和 bundle-size 警告。
- 最终 release tree 的 `bun run build && bun run test:all`：非性能 446 个
  文件通过、91 个文件跳过，4,590 个测试通过、85 个跳过；性能 4 个文件
  通过、1 个跳过，9 个测试通过、1 个跳过；0 失败。

### 真实 Provider ACP 结果

命令：

```bash
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 bun x vitest run \
  --config vitest.config.ts --project=real-api \
  tests/integration/real-api/durable-interaction-recovery-trajectory.test.ts \
  --retry=0 --maxWorkers=1 --no-file-parallelism \
  -t 'recovers a one-shot DeepSeek failure through a production ACP subprocess'
```

结果：目标 cell 首次执行通过，1/1，41.238s；34 个非目标测试由测试名过滤
跳过，退出码 0。该 cell 使用真实 DeepSeek 请求和一次注入的上游 `503`，随后
验证第二次 pending resume、精确 `retry_scheduled -> recovered` metadata、唯一
`Write`、durable terminal、inbox 清理、ACP close 与 child process 退出。未使用
framework retry，证据中未记录 Provider credential。

### 发布边界

`0.10.117` tag 仅在上述 runner/runtime commits 之后加入本 evidence、英文
evidence、双语 changelog 和 package version；不得混入其他 runtime 修复。

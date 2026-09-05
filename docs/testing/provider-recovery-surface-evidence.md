# Provider 恢复状态资格验证证据

- 日期：2026-09-05
- 目标版本：`blade-code@0.10.137`
- 设计起点：`09286d1b72eec3cef1795f487668df8dc6bf1afc`
- 已验证实现 HEAD：发布前最终门禁填写
- 完整本地门禁：发布前最终门禁填写
- 真实 API 命令：
  `REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=0 bunx vitest run --config vitest.config.ts --project=real-api tests/integration/real-api/foreground-provider-recovery-trajectory.test.ts`
- 跨 Provider fallback 命令：
  `REAL_API_TEST=1 bunx vitest run --config vitest.config.ts --project=real-api tests/integration/real-api/cross-provider-fallback-trajectory.test.ts`

## 结果

统一恢复状态的实现、确定性测试和生产表面真实 API 轨迹已完成。最终 release HEAD 的
`build`、`type-check`、`lint` 和 `test:all` 结果将在版本元数据就绪后写入本文件；在这些
命令实际通过前，本文件不宣称 release qualification 完成。

当前已取得的真实 Provider 结果：

| 模型 | 表面 | 耗时 | 结果 |
| --- | --- | ---: | --- |
| DeepSeek V4 Flash | Headless JSONL | 10.253s | passed |
| DeepSeek V4 Flash | ACP stdio + child-backed terminal | 11.578s | passed |
| DeepSeek V4 Flash | raw PTY TUI | 10.345s | passed |
| DeepSeek V4 Flash | production Chromium Web | 18.631s | passed |
| DeepSeek V4 Pro | Headless JSONL | 12.725s | passed |
| DeepSeek V4 Pro | ACP stdio + child-backed terminal | 16.080s | passed |
| DeepSeek V4 Pro | raw PTY TUI | 13.720s | passed |
| DeepSeek V4 Pro | production Chromium Web | 22.894s | passed |

八格矩阵共 `8/8` passed，117.45s。另一个真实 Claude 到 GPT 的 pre-output
fallback 轨迹 `1/1` passed，约 12.01s；它验证 typed source/target identity、独立
credential channel 和 secret isolation。以上结果来自本功能实现 HEAD 的显式运行，
不代表尚未运行的最终全仓门禁。

## Runtime 与协议契约

确定性验证锁定以下行为：

- `SessionRuntime` 是 Session-scoped、内存态 Provider 恢复投影的唯一 authority；
- 每个 top-level run 从 revision `0` 的新 generation 开始，旧 generation 和旧 revision
  不能覆盖新状态；
- 清理会使 generation 失效；即使该 run 从未产生可见 snapshot，dispose 和终态也不会
  保留可被迟到事件复活的 generation；
- reducer 合并 admission、retry、circuit、stall 和 fallback，并按
  stall > circuit > retry > admission > fallback 选择主 activity；
- retry heartbeat 保留 waiting phase，倒计时直接使用 Runtime 的绝对 `nextActionAt`，
  不从客户端接收时间重新计算 deadline；
- 非空内容、thinking、tool start、structured output 和 stream end 清除可见状态，但
  per-turn `stream_end` 不使整个多轮 Agent run 的 generation 过早失效；
- 正常完成、失败、取消、consumer 提前关闭、Session 切换、rewind、abort 和 Runtime
  dispose 都清理状态；包装 generator 会向底层传播 `return()`；
- schema 校验失败 fail closed，只能留下 `snapshot: null`，不会向表面转发未校验对象。

## 表面证据

### TUI

- `LoadingIndicator` 显示当前恢复原因、绝对 deadline 倒计时、尝试/预算/队列细节和
  `Esc` 停止提示；`ChatStatusBar` 显示紧凑摘要。
- raw PTY runner 必须从真实终端 capture 看到恢复状态，而不是只检查内部 store。
- typed `model_fallback` 只负责丢弃失败候选的旧流缓冲；它不清空 Runtime 权威恢复
  snapshot。

### Web GUI

- composer 上方的 `ProviderRecoveryBanner` 使用 `role=status` 和
  `aria-live=polite`，Stop 复用现有 abort API；StatusBar 使用同一 projection。
- `connected.providerRecovery` 在 subscription readiness 前作为权威
  `provider.recovery` 事件投影。生产 Chromium 轨迹在恢复进行中 reload，随后验证 banner
  重新出现、run 完成后清除且最终 assistant 结果保留。
- live 更新只接受已由 revision `0` 锚定的新 generation 及同 generation 的更大 revision；
  terminal clear 后，未锚定的迟到 revision 被拒绝。旧 `model.fallback` 事件不会覆盖
  统一 snapshot。

### ACP 与 Headless

- ACP 初始和 live `session_info_update` 使用
  `_meta['blade/providerRecovery']`，fallback 使用 `_meta['blade/modelFallback']`；
- Headless JSONL 使用封闭 schema 的 `provider_recovery` 和 `model_fallback`，clear 显式为
  `snapshot: null`；
- Runtime 已通过 Session Bus 发布统一事件，因此 Web/ACP direct stream adapter 不重复
  投影同一恢复事件。

## 隐私与重放边界

- projection 和 fallback 只含有界数值、封闭枚举与净化后的 catalog provider/model
  identity；未知字段、控制字符、URL 和过长 identity 被拒绝；
- API key、base URL、headers、request/response body、原始错误、credential HMAC、Session
  ID 和内部 owner identity 不进入 JSONL、SSE、ACP、DOM、PTY、transcript 或证据；
- fallback 仍只允许发生在零真实输出边界。text、reasoning、tool call、usage 或 finish
  之后不能自动重放或切换模型；
- UI 只提供既有 Stop/Esc，不能从 recovery payload 接收 URL、命令、购买动作或强制
  replay。

## 测试范围

本功能的 focused deterministic 验证覆盖 TypeBox schema/privacy、reducer 状态机、
SessionRuntime Bus 生命周期、Agent 终态与提前关闭、PiAI typed fallback、TUI 文案与
loading 投影、Web banner/StatusBar/store/SSE hydration、ACP metadata、Headless JSONL 以及
production source-search gate。实现阶段最近一次相关 CLI 组合为 17 files、724 tests
passed；Web 组合为 5 files、220 tests passed，随后核心 Web 回归为 4 files、101 tests
passed。

开发期间真实矩阵先暴露了三项测试假设错误：零延迟前三次重试是 `retry_attempt` 而非
`retry_wait`；等待期间 circuit 的优先级高于 retry；Web 汇总最初没有包含 reconnect
probe。修正断言与证据收集后，八格矩阵一次性 `8/8` 通过。最终审计还通过 RED/GREEN
测试修复了空 snapshot clear 后的 generation 引用，以及 Web 接纳未锚定迟到 live
revision 的问题。

## Release 边界

发布前必须把本文件顶部的最终实现 HEAD 和全仓门禁结果替换为实际值，然后只允许再
修改版本、双语 changelog 和本证据元数据。tag 必须是 annotated `v0.10.137`，由
`publish.yml` 发布；不得手工 `npm publish`，不得移动或重写既有 tag。

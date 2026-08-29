# TUI Durable Pending-Resume Retry 发布证据

## 2026-08-30 资格验证（`blade-code@0.10.123`）

- 设计提交：`9c4a82ff1559b1be1ba81e72568f5c4c7df12f27`
- 实施计划提交：`bb447d199d2bcef1e58b57996966307881e17fef`
- replay-boundary 证据提交：`cf20912575415ccca70599ca64c1733c112f5b29`
- coordinator 提交：`fa824d49b147980d64e121437fd90257d47852f6`
- TUI hook 集成提交：`f1db9474a3f8dbc58084dd788179e76c089840b8`
- 公共行为文档提交：`75cf0137dd343d7727680daa84f01cf29f19f19a`
- 真实模型 hook 资格测试提交：`747bf52d55ad1493be0ba0b5b7a465747ca37e58`
- raw PTY fault-injection 资格测试提交：
  `cf0cd6c7f61af3f6593609f88508d1cc7e22228a`
- 目标：当 TUI 自动恢复唯一一条 durable pending input 时，允许一次可重试、
  零输出、零工具副作用的 Provider 失败进入共享的有界 outer retry，而不丢失 wake、
  重放副作用或扩大普通命令与 Goal 的重试范围。

## 发布边界

- 只有 durable pending input 可以进入 outer retry。普通用户命令、Goal-only
  continuation、preflight exception 和取消不会重试。
- TUI 直接复用共享 `decidePendingResumeRetry()`；最多 4 次 attempt，共享绝对预算
  120,000ms，退避为 1s/2s/4s 并使用稳定的 ±20% jitter。
- retry 要求 canonical retryable failure、durable inbox 仍 pending、
  `outputStarted === false`、`toolExecutionStarted === false` 且
  `toolCallsCount === 0`。证据缺失、畸形或互相冲突时 fail closed。
- `PendingResumeCoordinator` 持有 episode、attempt、deadline、timer、generation、
  cancellation 和 idle edge；`deferred` 不消耗 attempt，也不会自旋。
- 中间可重试失败不会写入可见 assistant 消息；最终 failed/exhausted 只投影一次
  canonical failure。TUI 不新增 SSE 或 ACP public retry payload。

## 确定性 RED/GREEN 证据

实现遵循测试先行。观察到的 RED 分别证明原实现缺少 replay-boundary 统计、
coordinator retry ownership、hook 结构化失败结果，以及 raw PTY 两次 attempt 的
证据解析。审查驱动的后续 RED 还覆盖：

- `run()` rejection、scheduler/timer 同步异常和 terminal callback 异常；
- absolute deadline、backoff 期间重复 wake、busy 后 idle edge、dispose 和 late result；
- outer failure 与 evidence failure 不一致、缺失或非法 tool count；
- Session/workspace replacement、discarded render、旧 foreground/shell completion；
- content、hidden thinking、structured output 与全部 tool lifecycle 的单调证据；
- raw PTY 的合法轮询前缀、同 turn 双终态、无关 terminal、第三 attempt、重复 ack、
  非 failed abort、错误 inbox、成功或中断工具，以及 `part_updated` 工具活动；
- durable completion inspection 异常必须第一次即失败，不能被轮询吞掉后伪装为 timeout。

最终 focused 结果：

- `useCommandHandler.test.tsx`：38/38 通过；
- `PendingResumeCoordinator.test.ts`：23/23 通过；
- `loopEventHandler.test.ts`：53/53 通过；
- raw PTY driver：41/41 通过；
- raw PTY marker-latching：63/63 通过。

## 独立审查

- event evidence、coordinator 与 hook integration 均先通过独立规格审查，再通过代码
  质量/并发审查。所有 Critical/Important finding 都通过新的 RED/GREEN 修复并复审；
  最终结论均为 APPROVED。
- raw PTY 审查发现旧 parser 会拒绝合法第二次 `turn_started`，同时可能接受同一
  turn 的 abort+complete 双终态。新 parser 现在只接受
  `start1 -> abort1 -> start2 -> Write -> result -> ack -> complete2`，并对额外终态、
  非 replay-safe 首次失败和证据读取异常 fail closed。规格与质量最终均 APPROVED。
- 真实 hook 测试的 cleanup 修复另行完成规格与质量复审，最终均 APPROVED。

## 真实 DeepSeek 与 raw PTY 资格验证

两类测试均对第一次 `/v1/chat/completions` 注入一次 pre-stream `503`，设置 model
`maxRetries=0`、`providerForegroundRecoveryMs=0`、Vitest case `retry=0`，命令也显式
传入 `--retry=0`。因此第二次 HTTP 请求只能来自 TUI pending-resume coordinator 的
outer retry。

| 模型 | Surface | 结果 | 时长 | Framework retry |
| --- | --- | --- | ---: | ---: |
| `deepseek-v4-flash` | production `useCommandHandler` | 通过 | 3.028s | 0 |
| `deepseek-v4-pro` | production `useCommandHandler` | 通过 | 3.502s | 0 |
| `deepseek-v4-flash` | production CLI raw PTY | 通过 | 10.609s | 0 |

hook 轨迹对两个模型均证明：request 1 为注入失败，request 2 是唯一真实转发且完成
2xx；durable transcript 包含 2 个 `turn_started`、1 个 `turn_aborted`、1 个
`turn_completed` 和 1 个 `inbox_acknowledged`；最终 inbox 为空；UI 只保留 exact
final marker。

raw PTY 使用真实 `dist/blade.js`、`bun-pty` 和真实键盘选择/确认，证明首次失败为
failed、未确认、零工具与零持久化输出，第二次 attempt 才执行唯一一组 `Write`
call/result、确认 inbox 并完成。request 2 具有真实上游 2xx headers、完整 body 和
downstream end 证据。当前环境没有 computer-use 工具，因此 raw PTY 是权威 CLI UI
验证面。

凭证只通过受限环境注入。workspace 配置不包含 API key；证据仅扫描 transcript、
PTY 的固定摘要、request path 和结构化 lifecycle，不记录请求体、header 或密钥值。

### 真实测试 harness 失败披露

- 第一次命令使用了错误的 package-local test path；Vitest 报 `No test files found`，
  没有执行测试或 Provider 请求。
- 第一版隔离 workspace 未提供可解析的模型配置，报“模型配置未找到”，没有发出
  Provider 请求。
- 修正配置后，workspace 尚未信任的一次运行等待约 111 秒后人工中止；proxy 没有
  请求，transcript 也没有 `turn_started`。加入 credential-free workspace config、
  workspace trust 与 identity reset 后通过。
- 最终 commit 后首次 hook-level 复跑中，React 19 `act()` 返回不带 `.catch()` 的
  thenable，`finally` 抛出 `act(...).catch is not a function`，覆盖了测试主体结果；
  第一个 case 的后续清理未完成也污染了第二个 case。cleanup 改为
  `try { await act(...) } catch {}` 后，同一零重试命令 Flash/Pro 2/2 通过。

这些均为测试 harness 的路径、配置、信任或清理缺陷，不记为产品间歇失败，也没有
使用框架重试掩盖。测试仍会输出 React 外部 Zustand 更新未包裹 `act(...)` 的已知
警告；未通过关闭 `IS_REACT_ACT_ENVIRONMENT` 隐藏，且没有 assertion failure。

## 发布级门禁

- `bun run type-check`：CLI、VSCode、Web 全部退出 0。
- `bun run lint`：CLI、VSCode、Web 全部退出 0。
- `bun run build`：CLI/Web 与 VSCode build 全部退出 0；只保留既有 Browserslist
  数据过期和一个 Web chunk 大于 500 kB 的非阻断警告。
- `bun run test:all` 首轮通过：
  - 非性能：448 files 通过、91 skipped；4,709 tests 通过、84 skipped；
  - performance：4 files 通过、1 skipped；9 tests 通过、1 skipped；
  - 总命令退出码 0，0 failed。
- 变更文件 Biome 与 `git diff --check` 均退出 0。

资格验证源码哈希：

```text
ff4a3894ae49502d6280db3dbd1767b7f5bc9cc5bd6538e422ab1c8e1d358707  loopEventHandler.ts
dc23d4160d7c1a26aac669d645575884250df7b5fa4f8322ac8f897cb6932464  PendingResumeCoordinator.ts
a9dd05dc1e6488b2701cec19f3f4180930547e553b50369d1604b519c32bb5b4  useCommandHandler.ts
496ba62c727159db61b7a7001697afa929ed1278032070ab53bd74338751b788  loopEventHandler.test.ts
7f31678d518a2eaa09b40426d59e391d6fae3adc8afe8a4441ccf4d237831a1f  PendingResumeCoordinator.test.ts
b8c0724736f1397dceefd5389eef90ed183f8dad0be56fdaeda5ea28f80b638e  useCommandHandler.test.tsx
2547b1d6fc79d46b9607a0a52ccabe1724b0e5e138e87873420bea2c59feea2e  tui-durable-interaction-recovery-trajectory.test.tsx
b430c4e078e80354d3b813b2cd9bbfd77983e01fc936e00e08496267bd43fc1f  durable-interaction-recovery-trajectory.test.ts
5a1b79833413b71d9efa2efce7801d89e9e9d180b26d95c80fff4362cc5fd28c  durableInteractionRecoveryPtyDriver.ts
b430dddc1d91d4c13ba60e41f4f3e0845e4950d3e148f2a2f319adff96722d72  durableInteractionRecoveryPtyRunner.ts
d6c05f7f8c3bcf4ac9a18b768ebe6eef867deb1ab793c2556be271cd1aae4a9b  durable-interaction-recovery-pty-driver.test.ts
```

## 未包含范围

`0.10.123` 只包含 TUI durable pending-input 的共享有界 outer retry、公开行为文档、
确定性回归和真实 DeepSeek/raw PTY 资格验证。background child completion dispatcher、
Web Session projection residency、ACP remote filesystem 语义和长任务 false-progress
检测仍是后续独立 P1，不在本补丁的完成声明内。

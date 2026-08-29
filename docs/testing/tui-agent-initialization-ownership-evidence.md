# TUI Agent 初始化所有权发布证据

## 2026-08-30 资格验证（`blade-code@0.10.122`）

- 设计提交：`b57511874b8c73ee42c02d7ed28082ecbaaf78be`
- 实施计划提交：`32cbb3f0254e75f48eaed4fd730f904ea9223f83`
- RED 提交：`c721ca9d66f1c829b2d21f86a35185eb480471a2`
- 实现提交：`f4aae2e2c3e0384beda952c5cae8dd4b891fd9ee`
- 真实模型测试提交：`2dddc3dee5515350bdbd39cb3335437555b29b96`
- 目标：让 TUI hook 完整拥有异步 Runtime/Agent 初始化，在 unmount、graceful
  shutdown、Session/workspace 切换和并发 turn 之间阻止迟到提交与资源泄漏。

## 修复前的可达竞态

- `SessionRuntime.create()` 尚未返回时，cleanup 看不到候选 Runtime；旧调用可以在
  owner 已关闭后写入 ref，并继续创建 Agent。
- `Agent.createWithRuntime()` 或 standalone `Agent.create()` 尚未返回时，迟到 Agent
  可以覆盖新 Session/新目标的状态。
- 相同目标没有 single-flight；并发调用可以重复创建 Runtime/Agent。
- 后续 turn 会覆盖已提交 Agent，而不先等待旧 Agent 的异步销毁。
- 生命周期 `AbortError` 会被命令层显示为普通 assistant 错误。

## 确定性 RED/GREEN 证据

初始 RED 使用 Promise gate，不使用 sleep 或 Provider，复现七条 `useAgent()` 生命周期
失败和一条命令层取消失败：

- Runtime 创建期间 unmount；
- Runtime 创建期间 graceful cleanup；
- Agent 创建期间 unmount；
- pending Runtime 的 Session/workspace replacement；
- 第二轮未先销毁旧 Agent；
- exact-target 并发未合并；
- different-target 错误合并/迟到提交；
- lifecycle `AbortError` 被渲染成 assistant failure。

审查驱动的后续 RED 又覆盖：旧 Agent handoff 所有权空窗、stale candidate cleanup
错误传播、external cleanup 穿越、同 owner cleanup 后合法重建、cleanup 等待期间使用最新
workspace、真实 cleanup `AbortError` 的首错优先级、首次 Runtime await 前的 different-target
失效，以及已有 Session Runtime 时 standalone exact-target single-flight。

最终 focused 结果：

- `useAgent.test.tsx`：30/30 通过；
- `useCommandHandler.test.tsx`：18/18 通过；
- 合计：48/48 通过；
- 仅保留测试环境既有的 React `act(...)` 提示，无 assertion failure。

实现后的所有权边界：

- Runtime 以 `{sessionId, workspaceRoot}` 做 current-generation single-flight，并在每个
  异步边界及最终 commit 前校验 generation、record identity 与 accepting state。
- Agent 以 factory path、Session/workspace、Runtime identity、prompt、model、inference、
  permission、turn limit 和 invocation-agent identity 做 exact-target single-flight。
- different target 在首次 Runtime await 前同步失效旧初始化；late Runtime/Agent 候选由
  原 initializer 清理，不能写入新 generation。
- cleanup 同步清 refs，join Agent initialization/disposal 后再 join Runtime
  initialization/disposal；所有资源都会尝试清理，并向等待者返回第一个真实 cleanup 错误。
- public cleanup 仍可复用；在途调用等待 barrier 后通过稳定 hook 入口重新读取最新
  render options。terminal unmount/shutdown 则先关闭 accepting，禁止重建。
- 只有本模块创建并品牌化的 lifecycle cancellation 会被 cleanup 忽略；transport 或资源
  cleanup 抛出的普通 `AbortError` 仍会传播。
- 命令层把 lifecycle cancellation 转换为既有 `aborted` 结果，不写 assistant 错误消息。

## 独立审查

- 规格审查逐项核对 exact target、single-flight、generation fencing、candidate ownership、
  cleanup join/order/error precedence、Session/workspace replacement、Strict Mode 和
  lifecycle cancellation。审查发现的问题均补充 RED 并修复；最终结论为 APPROVED。
- 代码质量/并发审查验证 cleanup 穿越、旧 Agent handoff、stale cleanup failure、
  different-target pre-await fencing 与 standalone target identity。最终未发现确定的
  deadlock、double cleanup 或资源漏 join，结论为 APPROVED。
- 真实 API 测试审查要求证明异步 `destroy()` 已完成后第二个 factory 才进入，并避免把
  API key 作为 matcher 参数。两项均修复，最终结论为 APPROVED。

## 真实 DeepSeek 与 raw PTY 资格验证

新增 TUI hook 轨迹固定 `providerForegroundRecoveryMs=0`、model `maxRetries=0`、Vitest
case `retry=0`，命令也显式使用 `--retry=0`。每个模型在同一 mounted hook、同一
Session 和同一 Runtime 中完成两轮 exact-marker 响应；测试证明第一 Agent 的异步销毁
已经完成后第二个 Agent factory 才进入，并在 cleanup 后以相同 Session/workspace 重新
获取 Runtime lease。

| 模型 | Surface | 结果 | 时长 | Framework retry |
| --- | --- | --- | ---: | ---: |
| `deepseek-v4-flash` | TUI hook，两轮真实响应 | 通过 | 3.073s | 0 |
| `deepseek-v4-pro` | TUI hook，两轮真实响应 | 通过 | 3.710s | 0 |
| `deepseek-v4-flash` | production CLI raw PTY follow-up | 通过 | 11.447s | 0 |

raw PTY 控制使用真实 `dist/blade.js`、`bun-pty`、nonce-bound composer readiness 与
bracketed paste，完成 durable Goal 恢复后的正常 Provider follow-up。当前环境没有
computer-use 工具，因此 raw PTY 是权威 CLI UI 验证面。结构化结果只断言
`credentialLeakDetected === false`，不会在 matcher 或证据中携带密钥值。

### 真实测试 harness 失败披露

- 第一次命令从仓库根目录向 package-local Vitest config 传入了错误的文件相对路径；
  Vitest 报 `No test files found`，没有运行测试或 Provider 请求。
- 第一版测试把 `BLADE_STORAGE_ROOT` 指向空目录，两个模型都在 Runtime 初始化时以
  `模型配置未找到` fail-fast，没有发出 Provider 请求。
- 修正存储隔离后，两模型的四次真实响应与 Agent replacement 已完成，但 cleanup 后的
  probe Runtime 重新解析可变配置而报 `模型配置未找到`。最终 probe 改为复用首次 Runtime
  已解析的 model-resource snapshot；随后同一零重试命令 2/2 通过。

以上均是测试 harness 配置问题，不记为产品 flaky，也没有使用框架重试掩盖。

## 发布级门禁

- `bun run type-check`：CLI、VSCode、Web 全部退出 0。
- `bun run lint`：CLI、VSCode、Web 全部退出 0。
- `bun run build`：CLI/Web 与 VSCode build 全部退出 0；只保留既有 Browserslist
  数据过期和 Web chunk 大于 500 kB 的非阻断警告。
- `bun run test:all` 首轮通过：
  - 非性能：448 files 通过、91 skipped；4,631 tests 通过、85 skipped；
  - performance：4 files 通过、1 skipped；9 tests 通过、1 skipped；
  - 总命令退出码 0，0 failed。
- 变更文件 Biome 与 `git diff --check` 均退出 0。

资格验证源码哈希：

```text
7b410e1640c39d8a10a26e972dee3a9e658bf077d5d89b3d7f269281d987b7fc  useAgent.ts
d5401f945c8b87747dbb115d2eb18734484293d3643fa17cd626cc8385d92ca6  useCommandHandler.ts
989397c53e5948fd01f6ea599938c803c54450babd67fd1eb5636aee44fd82e1  useAgent.test.tsx
39b3cf0d3ca6b2c02826ea0b8c2b8054afad86a94f3ff0e1071091d1fa6bfa46  useCommandHandler.test.tsx
07cf1a892d1d55a0b9491ab59382afb3a586d581e2b6c0b0cb9d032a7a38bb90  tui-runtime-lifecycle.test.tsx
```

## 发布边界

`0.10.122` 只包含 TUI Runtime/Agent 初始化所有权、确定性回归、真实模型与 raw
PTY non-interference 资格验证、设计/计划、本证据、双语 changelog 和 package version。
TUI pending-resume retry、background child completion dispatcher、Web projection
residency、ACP filesystem 语义和长任务假进展检测仍属于后续独立 patch。

# Session Hydration Fencing 发布证据

## 2026-08-29 资格验证（`blade-code@0.10.121`）

- 设计与计划提交：`52932d60`
- RED 提交：`d6f97885`
- 实现提交：`4fdcacc4`
- 目标：防止过期的异步 Web Session hydration 在 delete、archive、controller
  replacement 或 shutdown 后重新写入 live projection，同时保留 same-key
  single-flight 行为与 durable permission response。

### 修复前的可达竞态

- 在途 hydration 的 registry entry 被删除后，裸 Promise 仍然存活；metadata 与
  task-worktree 读取稍后完成时，它仍会执行 `sessions.set(...)`，复活已经删除或
  归档的 Session。
- controller replacement 会清空模块级 projection map，却无法撤销旧 controller
  已脱离 registry 的 hydration Promise；旧 controller 因此能向 replacement 可见的
  state 写入。
- shutdown 会关闭 SSE owner，但不会失效或等待在途 hydration；handoff 前的请求可在
  shutdown 已启动后仍返回 HTTP 200，而不是有界的 service-unavailable 响应。
- durable permission recovery 在 active controller 的 single-flight hydrator 之外
  构造第二个 Session projection；没有 active controller 时，它仍会加载 task
  worktree 并插入无 owner 的 live state。

### RED 与控制证据

九条确定性的 Promise-gated 用例直接执行 production route，不使用 sleep 或
Provider。实现前有七条 causal case 失败：

- delete：期望 `404 NOT_FOUND`、零 subscriber 且无 live projection；实际收到
  HTTP 200、`connected`、一个 subscriber 与复活的 projection；
- controller replacement：期望 `503 SERVICE_UNAVAILABLE` 且 replacement state
  为空；实际收到 HTTP 200，旧 controller projection 写入 replacement state；
- shutdown：期望 `503 SERVICE_UNAVAILABLE`；实际收到 HTTP 200，随后 stream 关闭；
- archive 成功：期望 `409 CONFLICT`、零 subscriber 且无 live projection；实际收到
  HTTP 200、`connected` 与复活的 projection；
- active-controller permission recovery 在 controller-owned hydration 仍被阻塞时
  启动了第二次 task-worktree hydration；
- no-controller permission recovery 的 durable 提交成功，但仍加载一次 task
  worktree 并留下可解析的 live projection；
- 旧 generation 已失效且新 same-key generation 在途时，旧请求仍返回 HTTP 200，
  并在新 generation 提交前插入旧 projection。

修复前两个控制组保持 GREEN：durable archive 失败时原 hydration 继续有效；两个
普通 same-key caller 共享一次 metadata/worktree hydration。实现后九条用例全部通过。

### 修复后的所有权边界

- 每个在途 hydration 都有带身份的 state 和显式 invalidation reason。metadata 完成、
  task-worktree 完成与最终 live-map commit 都会校验 state 有效性及 registry 精确身份。
- Promise cleanup 只在 registry entry 仍由同一 state 拥有时删除，因此旧 generation
  无法释放或覆盖新 generation。
- archive 与 delete 仅在 durable mutation 成功后失效。archive 失败时保留有效
  hydration。delete 将过期 caller 映射为 `404 NOT_FOUND`，archive 映射为
  `409 CONFLICT`。
- controller replacement 使用 `route-reset` 失效旧 controller；shutdown 使用
  `server-shutdown` 失效、快照并等待全部 owned hydration Promise，使过期 caller
  返回 `503 SERVICE_UNAVAILABLE`。精确 owner 校验确保旧 controller shutdown 不会
  清理 replacement state。
- durable permission recovery 先发布已提交的 resolved 事件，再把 live projection
  hydration 与自动 resume 委托给精确的 active controller owner。没有 active owner
  时，durable response 仍成功，但不执行 metadata/worktree hydration、live insert、
  Runtime 创建、Agent 创建或自动 resume。

### 审查结果

- 规格审查逐项核对设计要求，包括 Promise microtask 初始化以及 reset 到 owner 安装
  的间隙；无 Critical、Important 或 Minor finding，结论为 APPROVED。
- 代码质量审查核对并发、owner identity、Promise cleanup、错误处理、类型安全与测试
  因果性；无 Critical、Important 或 Minor finding，结论为 APPROVED。

### 验证结果

- hydration 聚焦矩阵：9 个测试通过，138 个非目标测试跳过。
- 完整 `session-routes.test.ts`：147 个测试通过。
- TypeScript 门禁：CLI type-check、VSCode lint 与 Web type-check 均退出 0。
- 变更实现/测试文件的 Biome 检查与 `git diff --check` 均退出 0。
- 仓库 lint：CLI、VSCode 与 Web lint 均退出 0。
- production build：CLI/Web 与 VSCode build 均退出 0；保留既有的 Browserslist
  数据过期和 Web chunk 大于 500 kB 非阻断警告。
- 最终 `bun run build && bun run test:all`：
  - 非性能：448 个文件通过、91 个跳过；4,615 个测试通过、85 个跳过；
  - performance：4 个文件通过、1 个跳过；9 个测试通过、1 个跳过；
  - 总命令退出码 0，0 failed。
- 首次 release-content 重跑在大量测试通过且没有 assertion failure 后，以 Vitest
  进程 `SIGSEGV`（exit 139）结束。实现与测试源码保持不变（`9a856517...` 与
  `f66dc37c...`），原样重跑上述 build-and-test 命令后得到所列计数并以 0 退出。
  该结果记录为 unchanged sources 上的间歇性 runner failure，没有被静默丢弃。

### Provider 资格边界

本 patch 未运行真实 Provider 请求。缺陷与修复发生在 metadata/task-worktree
hydration 和 controller ownership 阶段，早于 Runtime 或 Agent 创建。确定性测试已直接
执行 production Session 与 permission routes；真实模型请求不会增加该竞态的相关证据。

### 发布边界

`0.10.121` 只包含 Session hydration identity fencing、确定性回归、设计与计划、
本 evidence、英文 evidence、双语 changelog 与 package version。projection entry-count/
TTL residency、message pagination 与 transient request-memory 限制仍属于独立后续工作。

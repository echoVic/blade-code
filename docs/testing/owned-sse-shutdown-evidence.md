# Owned SSE Shutdown 发布证据

## 2026-08-29 资格验证（`blade-code@0.10.119`）

- 设计提交：`ca6d21d4`、`29a59a63`
- 计划提交：`9fba9d1a`
- RED 提交：`3fc1ed68`、`5f0fa26f`
- route ownership 实现提交：`863801e5`
- Node transport 实现提交：`75579367`
- 目标：让 global 与 Session SSE 成为可取消、可等待、由 controller/server
  明确持有的资源，使客户端断开与 graceful shutdown 都能关闭 listener、timer、
  egress 和 callback-owned work，且 Session Runtime 只在这些工作结束后销毁。

### 修复前的可达故障

- 第一次 Node probe 使用 `node --import tsx`，在进入 server 前因仓库未安装 `tsx`
  报 `ERR_MODULE_NOT_FOUND`；这不是功能 RED。改用仓库已有 `vite-node` 后，真实
  Node transport 输出 `stopSettledBeforeAbort:false`，客户端 abort 后才变成
  `stopSettledAfterAbort:true`。随后进程仍被泄漏的 SSE timer 保持，需人工终止。
- controller RED 分别证明 global route 缺少可 shutdown controller、Session route
  缺少 connection stats；真实 Node RED 以
  `Timed out waiting for server.stop() to finish while SSE clients remain connected`
  失败。
- route 实现中间版本的完整 Session suite 为 129 passed、5 timeout。三个
  pending-resume 用例的业务断言实际已完成，但 cleanup 卡在 SSE drain：Hono
  `writer.close()` 在 response body 已 cancel 时可能保持 pending。另两条
  `0.10.118` 测试依赖 shutdown 后 SSE subscriber 仍能启动 Runtime 的旧非法窗口。
- Session 和 global 的 pre-handoff 测试都先得到有效 RED：lease signal 已在
  stream callback 绑定 listener 前 abort 时，监听器不会重放，reader 仍收到
  `done:false`。
- cleanup 可重试测试先得到有效 RED：注入 workspace-resource cleanup failure 后，
  `BladeServer.isRunning()` 错误地变为 false，说明失败路径丢失了 server owner。

### 修复后的所有权合约

- global 与 Session route 各自持有专用 `ActiveOperationGate`。route 在验证和
  hydration 前获取 lease；关闭 gate 后新连接以既有脱敏 503 返回。handoff 前失败
  由 handler 释放，handoff 后由 stream callback 唯一释放。
- callback 绑定 abort listener 后立即检查 `signal.aborted`，覆盖事件不重放窗口。
  `terminate()` 同步停止订阅、heartbeat 和 bounded egress，并发起 transport close；
  route-owned barrier 不等待 Hono 可能悬挂的 writer close。
- 每个 Session stream 使用独立 operation Set，跟踪 background completion、team
  message delivery 与 post-init pending resume。最终顺序为 terminate、等待本 stream
  operations、移除 abort listener、释放 lease。一个 stream 的关闭不会等待另一个
  stream 的 callback。
- Session shutdown 同步关闭 admission 与 SSE gate，等待 active work 和 SSE drain，
  再重新读取 Runtime initialization 集合并执行 `disposeAll()`。subscriber callback
  不能越过 Runtime teardown。
- Node adapter 将 `req.aborted` 和未正常结束的 `res.close` 合并为固定
  `client-disconnected` AbortSignal，并在请求处理完成后移除监听器。
- `BladeServer.stop()` 同步启动 Session/global route shutdown，然后并发等待 route
  cleanup 与 transport stop；所有 cleanup 都会尝试，错误按固定优先级选择。任一
  cleanup 失败时保留 exact handle/controller 并清除本次 stop promise，允许重试；
  全部成功后才清理全局 owner 指针。

### TDD 与审查披露

- global RED 在初版中只证明了 controller 形状；质量审查要求包装真实
  `Bus.subscribe()` 返回值并断言 unsubscribe 恰好一次，补强后复审通过。
- 初版把 Session `sseOperations` 放在 controller scope，会使不同 stream 互相等待；
  已改为 per-stream Set。随后强化测试让 A/B 两条 stream 各自持有一个阻塞 callback，
  只释放 B 后 active 从 2 降到 1，而 A 仍保持阻塞。
- 初版 Session callback 的正常路径误调用 `terminate()`，连接会建立后立即结束；
  已恢复为等待 termination，仅在 abort、egress failure 或 finally 中终止。
- 两条旧 pre-commit cleanup 测试不再借助已修复的 shutdown-late-SSE 窗口，改为
  在真实 reservation 后精确注入 `commit()` failure，继续证明未转交 Runtime 会
  dispose，且 cleanup rejection 不会遮蔽原错误。
- Task 2 最终规格审查与质量审查均为 0 Critical、0 Important，Ready: Yes。
- Task 3 首轮质量审查要求固定并发 cleanup 错误优先级、限制测试 cleanup 等待并
  严格校验 disconnect reader 终态；复审又要求失败后保留 owner 以便重试。对应
  RED/GREEN 完成后，最终规格审查与质量审查均无剩余 finding，Ready: Yes。

### 聚焦验证结果

- `events-routes.test.ts`：5/5 通过。
- `session-routes.test.ts`：135/135 通过。
- `task-routes.test.ts`：11/11 通过。
- `server-sse-shutdown.test.ts`：3/3 通过，覆盖真实 Node 双 SSE shutdown、无需
  server stop 的 client disconnect 回收、cleanup failure 后重试。
- `session-fork-routes.test.ts` 与 `static-assets.test.ts`：9/9 通过。
- TypeScript：CLI type-check、VSCode lint 与 Web type-check 均退出 0。
- Biome 针对变更文件退出 0；`git diff --check` 退出 0。
- 最终 `bun run build && bun run test:all`：
  - 非性能：447 个文件通过、91 个跳过；4,601 个测试通过、85 个跳过。
  - 性能：4 个文件通过、1 个跳过；9 个测试通过、1 个跳过。
  - 退出码 0，0 failed。build 保留既有 Browserslist 数据过期与 Web chunk 大于
    500 kB 的非阻断警告。

### Provider 资格边界

本 patch 未运行真实 Provider 请求。缺陷和修复位于 HTTP transport、Hono SSE、
Bus subscription、route lifecycle 与 Runtime teardown 的所有权边界；测试在 Agent
创建和 Provider 选择前完成，并直接执行真实 Node server 与 production route。外部
模型请求不会增加相关行为覆盖。

### 发布边界

`0.10.119` 只包含 owned SSE shutdown、Node disconnect propagation、确定性回归、
设计/计划、本 evidence、英文 evidence、双语 changelog 与 package version。hydrated
Session projection reclamation、browser router admission scope、poisoned residency
recovery 等继续作为独立 patch 候选。

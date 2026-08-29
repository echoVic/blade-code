# Web Runtime Pre-Commit Cleanup Release Evidence

## 2026-08-29 资格验证（`blade-code@0.10.118`）

- 设计提交：`d80e7ad4`
- 计划提交：`8d937c60`
- 初始 RED 提交：`a8203034`
- RED 加固提交：`b2b2c2c3`
- Runtime 修复提交：`1b8e750e`
- 目标：确保 Web `SessionRuntime.create()` 成功、但 residency 接管前失败时，
  新建 Runtime 不会遗留 Session lease、MCP、LSP 或其他 Runtime 资源。

### 已证明的可达路径

1. `GET /:sessionId/events` 在 shutdown 前建立 SSE，并在 `connected` 可消费后
   保持 Bus subscriber 存活。
2. shutdown 关闭 admission，并完成当时 `runtimeInitializations` 的一次性快照。
3. 已建立的 SSE 收到合法 `team.message.received`，其后台 callback 在不重新进入
   admission gate 的情况下 reserve residency 并启动 cold Runtime creation。
4. 测试用 Promise gate 将 creation 卡在 Runtime 已创建、尚未返回给
   `acquireRuntime()` 的位置，同时让真实 `disposeAll()` 关闭 residency 并清空
   reservation。
5. creation 返回后，`reservation.commit()` 因 residency 已关闭而失败。修复前该
   Runtime 不在 residency 或 router map 中，后续 shutdown/sweep 均无法清理它。

### 修复后的所有权合约

- `acquireRuntime()` 从 `SessionRuntime.create()` resolve 起局部拥有
  `uncommittedRuntime`。
- `reservation.commit()` 成功后立即把所有权转交 residency，并同步清空局部
  owner；已提交 Runtime 不会被失败处理直接 dispose。
- commit 前任意异常都会先取消 reservation，再直接等待
  `uncommittedRuntime.dispose()`。未安装的 Runtime 不经过 router map 或全局 MCP
  清理路径。
- cleanup rejection 只记录 warning，不覆盖原始初始化/commit 错误；既有
  `WorktreeUnavailableError` 公共错误映射保持不变。

### TDD 与审查披露

- 第一次精准运行是无效 RED：测试装配漏导入
  `createSessionRouteController`，报 `ReferenceError`。只修测试装配后重新运行。
- 有效 RED：目标测试唯一失败，`runtimeDispose` 期望调用 1 次、实际 0 次。
- RED 规格审查通过。首次 RED 质量审查要求加强 callback 在途与 finally drain
  证据；随后增加 `messageSubmissions={keys:1,operations:1}`、
  `shutdownSettled=false` 和 restore 前 `{0,0}` drain，复审无 Critical/Important。
- GREEN 后新增 cleanup-rejection 用例；其首次运行因测试期望的错误字符串写错而
  失败，实际规范消息为 `Session runtime residency is closed`。修正期望后通过。
- 实现规格审查通过。质量审查最初担心共享 logger mock 污染；核对该文件只有一个
  `describe` 且统一 `beforeEach` 重置四个 logger mock 后，reviewer 撤回该
  Important，最终 0 Critical、0 Important，Ready: Yes。

### 验证结果

- 两个目标测试：2/2 通过，130 个非目标测试跳过。
- 完整 `session-routes.test.ts`：132/132 通过。运行中仍出现两条既有
  `BoundedSerialEgressError: Egress was closed` stderr，分别来自 active-turn SSE
  cancel 与 connected-write abort 场景；未静默删除或归因给本修复。
- TypeScript：CLI type-check、VSCode lint 与 Web type-check 均退出 0。
- Biome lint：CLI、VSCode 与 Web 均退出 0。
- Production build：CLI/Web/VSCode 均退出 0。仍有既有 Browserslist 数据过期与
  Web chunk 大于 500 kB 的非阻断警告。
- 最终 `bun run build && bun run test:all`：
  - 非性能：446 个文件通过、91 个跳过；4,592 个测试通过、85 个跳过。
  - 性能：4 个文件通过、1 个跳过；9 个测试通过、1 个跳过。
  - 退出码 0，0 failed。
- `git diff --check` 退出 0。

### Provider 资格边界

本 patch 未运行真实 Provider 请求。缺陷与修复都发生在 Agent 创建和 Provider
调用之前，生产 controller、SSE subscriber、residency 与 Runtime cleanup 已由
确定性测试直接执行；增加外部模型请求不会覆盖更多相关所有权语义。

### 发布边界

`0.10.118` 仅包含 Web Runtime pre-commit cleanup、确定性回归、设计/计划、
本 evidence、英文 evidence、双语 changelog 与 package version。streaming callback
shutdown ownership、browser router 的全局 admission scope、pinned reader 强制销毁、
poisoned residency recovery 与 hydrated Session 回收仍是独立审计候选。

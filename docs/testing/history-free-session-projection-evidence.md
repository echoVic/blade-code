# History-Free Session Projection 发布证据

## 2026-08-29 资格验证（`blade-code@0.10.120`）

- 设计提交：`0b30548a`
- 计划提交：`afe9ecbd`
- RED 提交：`1779d10c`
- 实现提交：`4a484cd4`
- 目标：让 Web server 的 live Session projection 不再长期持有完整 transcript，
  同时保持 catalog count、消息读取与 cold Agent context 语义。

### 修复前的可达问题

- 模块级 `sessions` Map 的 `SessionInfo` 包含完整 `messages: Message[]`。
- `getOrHydrateSession()` 会并行读取 metadata、完整 history 与 task worktree，之后
  无期限缓存整个 `SessionInfo`。
- 打开 idle Session SSE 或解析 Browser route 就会触发 hydration，即使没有创建
  `SessionRuntime`，也会让 transcript-sized 数据常驻；Runtime residency 的 count/TTL
  因此无法治理这类 retained history。
- active session 的 `messageCount` 由 `session.messages.length` 推导，可能把 internal
  system/tool 消息计入；cold catalog 则使用 durable user/assistant count，导致相同
  Session 的 warm/cold 结果不一致。

### RED 证据

- AST source gate 首次运行 2/2 失败：`SessionInfo` 缺少 `messageCount` 且仍包含
  `messages: Message[]`；`getOrHydrateSession()` 仍调用
  `SessionService.loadSession()`。
- 两条 route RED 首次运行 2/2 失败：idle SSE hydration 实际加载完整 history 一次；
  已存在 SSE projection 后，`GET /message` 未重新读取 durable history，而是返回缓存。
- 完成最小 production 改造后，完整 `session-routes.test.ts` 首轮为 136 passed、
  2 failed。两条失败均是旧测试断言：rewind fixture 未提供新的 durable history，
  shell fixture仍期待 completion 后加载全文。按新契约更新后转绿。
- 质量审查发现 rewind 仍用 `new Date()` 更新 live timestamp。新增断言后得到有效
  RED：预期 durable `2026-08-05T00:00:01.000Z`，实际为当前墙钟时间；改为读取
  authoritative metadata 后转绿。

### 修复后的边界

- `SessionInfo` 只保留 `messageCount` 与 live metadata，不再保存 `Message[]`。
- hydration 只读取 authoritative metadata 与小型 task-worktree descriptor，不读取
  full history。Session SSE 与 Browser ref-only 路径因此不会因访问而常驻 transcript。
- `GET /sessions/:sessionId/message` 始终按请求读取 durable history，并立即执行
  client-safe projection；它不复用、也不写入 live projection。
- cold Agent execution 继续通过 `SessionService.loadSessionModelContext()` 获取完整
  模型上下文，与 `SessionRuntime.loadModelContext()` 的 durable-context 边界一致；
  `sessionStart.isResume` 改由 durable `messageCount > 0` 决定。
- create、task、fork 与 permission recovery 都只插入 history-free projection。run、
  review、recovered review、shell 与 rewind 完成后刷新 authoritative metadata；rewind
  不再用本地墙钟伪造 `lastMessageTime`。
- active 与 cold catalog 的 `messageCount` 统一为 durable user/assistant
  `message_created` 计数，internal system/tool entries 不再使计数随 hydration 状态漂移。

### 审查结果

- RED 审查指出 source gate 使用字符串边界过于脆弱，以及 fresh durable load 测试
  混合了调用与结果断言。source gate 改为 TypeScript AST，route test 将精确调用
  参数与过滤结果分别固定后，RED 仍以生产缺口失败。
- 实现规格审查无 Critical、Important 或 Minor finding，spec compliant。
- 实现质量审查仅发现 rewind timestamp 非 durable；对应 RED/GREEN 修复后复审无
  剩余 finding，Ready: Yes。

### 聚焦验证结果

- `session-projection-history-boundary.test.ts` 与完整
  `session-routes.test.ts`：2 个文件、140 个测试全部通过。
- TypeScript：CLI type-check、VSCode lint 与 Web type-check 均退出 0。
- 变更文件 Biome 检查与 `git diff --check` 均退出 0。
- 最终 `bun run lint && bun run build && bun run test:all`：
  - 非性能：448 个文件通过、91 个跳过；4,606 个测试通过、85 个跳过。
  - 性能：4 个文件通过、1 个跳过；9 个测试通过、1 个跳过。
  - 退出码 0，0 failed。build 保留既有 Browserslist 数据过期与 Web chunk 大于
    500 kB 的非阻断警告。

### Provider 资格边界

本 patch 未运行真实 Provider 请求。缺陷和修复只涉及 durable history 读取位置、
live projection shape 与 Runtime context 装配；确定性测试已经验证 production route
和 Runtime seam。真实模型请求不会增加 retained-history ownership 的相关覆盖。

### 发布边界

`0.10.120` 只包含 history-free live Session projection、确定性回归、设计/计划、
本 evidence、英文 evidence、双语 changelog 与 package version。轻量 live overlay 的
entry count/TTL、generation fencing、message pagination 和 transient request-memory
上限仍是后续独立 patch。

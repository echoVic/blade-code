# TUI 长任务 Durable Attention 资格验证证据

- 日期：2026-09-04
- 目标版本：blade-code@0.10.133
- 基线：v0.10.132 / `3daf2f93ddcb89bfcdfc17a4f79c7fbb6fbda188`
- 已验证实现：`4c5ace5a`
- Framework retry：0
- Provider model retry：0

## 结果

Blade TUI 现在为已知后台任务维护独立、私有且有界的 durable attention ledger。
已知 running Session 在 TUI 缺席期间进入 `completed`、`failed` 或 `interrupted` 后，
`/resume` 会显示 `[NEW]`，状态栏会显示 `New tasks N · /resume`。只有成功打开对应
exact Session 才会确认该终态；取消选择、打开其他同 ID Session 或 fork source 都不会
误清提醒。

首次看到的历史终态只建立静默基线；`cancelled` 不产生提醒。TUI 与 Web 使用各自的
已读状态。TUI ledger 只保存 canonical terminal signature、确认位和 SHA-256 locator
摘要，不保存 prompt、模型输出、失败文本、远程路径或原始 workspace reference。

## 确定性覆盖

### 投影、持久化与协调

- 共享 Session surface 投影只接受 canonical UTC `taskCompletedAt`。
- SQLite、JSONL fallback 与 local compatibility adapter 使用同一规范化边界。
- 私有 v1 ledger 以跨进程锁和原子替换写入；失败 mutation 进入最多 256 项的有序
  journal，恢复后从最新磁盘状态重放。
- 已读终态按完整 newest-first catalog 有界保留；非终态和 unread 项不会被普通容量
  裁剪。锁 compromise、读写失败及写后 chmod 失败均保持明确 commit-point 语义。
- Controller 只在完整 catalog 后 reconcile；refresh、acknowledge 和 visibility mutation
  串行，支持 dirty follow-up、事件/轮询刷新、关闭排空及 listener 异常隔离。

### TUI 生命周期

- React/Ink lifecycle 在 StrictMode 重放下维持单一 controller ownership。
- startup、普通新会话、continue fallback、local resume、remote history 和 fork 使用
  明确的 proven-visible / exact-acknowledgement 边界。
- Session selector 只为当前页构造 label，并用 memoized unread set 显示 `[NEW]`。
- 状态栏显示 unread 数量；同步失败显示 `Task sync unavailable`，不清除已有状态。

~~~text
Task 1 focused projection/schema tests: 80 passed
Task 2 store tests:                     36 passed
Task 3 controller + store tests:        58 passed
Task 4 focused TUI tests:              148 passed
Task 4 CLI integration tests:           15 passed
~~~

## Production raw PTY

确定性测试使用真实 `bun-pty` 和 production `dist/blade.js`：

1. 首次启动观察 running Session 并持久化 `signature=null, unread=false`；
2. TUI 退出后将同一 Session 写为 terminal，并持久化 exact assistant marker；
3. 第二次 `--resume` 观察 `[NEW] [DONE]`，选择精确 Session，再用真实 `Ctrl+O`
   打开 transcript 并验证终态内容；
4. 第三次 `--resume` 证明 Session 仍在但 `[NEW]` 已清除。

测试同时覆盖 completion callback 拒绝、永不 settle 与 outer runner deadline。每条失败
路径都使用有界 `TERM → KILL` 清理并验证 runner PID 已回收。完整 stdout/stderr 在
JSON 解析前检查，stream latch 可检测跨 chunk 或已滚出保留尾部的 credential；runner
环境会移除 API key、token、secret、password 和 credential 类变量。

~~~text
deterministic raw PTY: 4 passed
qualification contracts: 27 passed
CLI integration through unified prebuild entry: 15 passed
~~~

## 真实 API 资格验证

~~~bash
cd packages/cli
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 \
DEEPSEEK_MODELS=deepseek-v4-flash,deepseek-v4-pro \
bunx vitest run --config vitest.config.ts --project=real-api --retry=0 \
  tests/integration/real-api/tui-task-attention-trajectory.test.ts
~~~

~~~text
Tests  2 passed | 1 skipped gate placeholder
Flash  15.033s
Pro    16.712s
Total  33.26s
~~~

两个模型均经 production `dist/blade.js serve` 创建任务，recording proxy 只延迟并透传
唯一的真实 Provider 请求，不生成或替换响应。每条轨迹断言 framework retry 为 0、
model `maxRetries=0`、forwarded request 为 `[1]`、无注入，并观察
`upstream_started → headers_received → body_completed`。任务随后持久化为 completed，
包含 `taskCompletedAt` 与精确 assistant marker，再由三次 production TUI 启动验证
attention 生命周期。

Health、task dispatch 与 terminal polling 均有独立 HTTP deadline；terminal 180 秒、
completion 190 秒、driver 300 秒、test 360 秒，为 teardown 保留明确余量。

## 构建与测试隔离

依赖 production `dist` 的测试由 `scripts/test.js` 在启动任何 Vitest child 前统一 fresh
build。`test:all` 非 coverage 顺序为 `build → !performance → performance`；coverage 为
`build → !performance`。测试 worker 不写共享 `dist`，避免多 project 并行时读取半成品。

## 全仓门禁

~~~text
format:check  PASS — 1,568 files
lint          PASS — CLI 1,366 files, Web 200 files, VSCode PASS
type-check    PASS — CLI, Web, VSCode
build         PASS
test:all main 480 files passed, 96 skipped
              5,587 tests passed, 86 skipped, 304.24s
performance   4 files passed, 1 skipped
              9 tests passed, 1 skipped, 5.31s
coverage      480 files passed, 96 skipped
              5,587 tests passed, 86 skipped, 331.06s
              statements 73.49%, branches 66.91%
              functions 75.37%, lines 74.83%
git diff      PASS
~~~

第一次完整 `test:all` 暴露出新 raw-PTY runner 未登记在全局 marker-latching
inventory。补齐 inventory 及 `[NEW]` latch 契约后，focused 测试 65/65 通过，随后
从头执行的完整 `test:all` 全绿。Build 仅输出既有 Browserslist 数据过期与大于
500 KiB chunk warning。

## 最终审查

- 规格终审：PASS，Critical 0 / Important 0。
- 质量、安全与真实性终审：APPROVED，Critical 0 / Important 0。
- 审查确认 production server、production TUI、透传 Provider、zero-retry、bounded
  diagnostics、credential isolation 和 fail-closed process cleanup 均成立。

## 最终源码哈希

~~~text
sessionSurfaceSchemas.ts                 c4b85e02884ae251ae0818b8dbad1dfef2ccb31f162ec1b7b3e7985cdecbfa78
TuiTaskAttentionStore.ts                 a241f9cbeccea068f99f162f4436ef58359b70ac90fb5863bd80db10473ed9f9
TuiTaskAttentionController.ts            ad35d78d310956db490b499d8453b528b3fc883db2a22ccbe159951c7b7c6d5d
TuiTaskAttentionLifecycle.ts             d71d7a4546ed38a052d53ae2f7e5d7f6c215e9cc6e7c69765e2823cebca2451c
SessionHistoryLifecycle.ts               2aebe0b8dd562e82de8e444a9267439693b4dd56172a853360b36e85c3fbec4b
BladeInterface.tsx                       1b9daefaa2b7012535ccf4e55079a4e8e786666271f95664a75e0216dbb45b2c
sessionSelectorModel.ts                  d0c4310a58c06882aa84d243f9de7129cf010f7ca545281251675f75a9944b88
tuiTaskAttentionPtyDriver.ts             c296b8de72eb94e0a8b7c1f4abe06c0f83bc5a1ea489582ea50744036a0fac88
tuiTaskAttentionPtyRunner.ts             537400cb6abfc7833b5ca9f1434385cc0a83ccd3ea1b15dfc2f0928440ca15e6
tui-task-attention-trajectory.test.ts    c7b1f458950737a74f3909469a620b4dc8861bc91717ba671f60abd1a581b282
~~~

## 边界

- 该提醒属于 TUI，不与 Web unread ledger 共享确认状态。
- raw PTY 资格测试在 Windows 明确跳过；Windows 仍由既有跨平台 smoke 覆盖。
- 截图不是成功依据；selector marker、精确 Session activation、transcript 内容、ledger
  状态、Provider request lifecycle 与进程回收共同构成证据。
- 未输出、保存或提交 Provider credential 与真实模型原始响应。
